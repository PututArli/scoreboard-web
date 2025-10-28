import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs'; // Key baru untuk menampung input wasit
const INPUT_WINDOW_MS = 700; // Jendela waktu untuk input wasit (ms)
const REQUIRED_INPUTS = 4; // Jumlah input wasit yang dibutuhkan
const INITIAL_TIME_MS = 180 * 1000; // 3 menit dalam milidetik

// Fungsi untuk mengecek pemenang (tetap sama)
function cekPemenang(state) {
  if (state.winnerName) return state.winnerName;
  const selisih = Math.abs(state.skorKiri - state.skorKanan);
  if (state.skorKiri >= 10) return state.namaKiri;
  if (state.skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (state.skorKiri > 0 || state.skorKanan > 0)) {
    return state.skorKiri > state.skorKanan ? state.namaKiri : state.namaKanan;
  }
  return null;
}

// Fungsi untuk memproses input wasit
async function processRefereeInputs(newInput) {
    const now = Date.now();
    let recentInputs = await kv.get(INPUT_KEY) || [];

    // Tambahkan input baru
    recentInputs.push({ input: newInput, timestamp: now });

    // Filter input yang masih dalam jendela waktu
    recentInputs = recentInputs.filter(item => now - item.timestamp < INPUT_WINDOW_MS);

    // Jika belum cukup input, simpan dan keluar
    if (recentInputs.length < REQUIRED_INPUTS) {
        await kv.set(INPUT_KEY, recentInputs);
        return null; // Belum ada keputusan
    }

    // Ambil N input terakhir (sesuai REQUIRED_INPUTS)
    const lastInputs = recentInputs.slice(-REQUIRED_INPUTS);

    // Hitung frekuensi masing-masing input
    const counts = {};
    lastInputs.forEach(item => {
        counts[item.input] = (counts[item.input] || 0) + 1;
    });

    let decision = null;
    let maxCount = 0;
    let decisionsFound = 0;

    // Cari input dengan frekuensi >= 2
    for (const input in counts) {
        if (counts[input] >= 2) {
            if (counts[input] > maxCount) {
                 maxCount = counts[input];
                 decision = input; // Ini keputusan sementara
                 decisionsFound = 1;
            } else if (counts[input] === maxCount) {
                 decisionsFound++; // Ada keputusan lain dengan count yang sama
            }
        }
    }

    // Bersihkan buffer input setelah diproses
    await kv.del(INPUT_KEY); 
    // await kv.set(INPUT_KEY, []); // Alternatif: Kosongkan array

    // Logika keputusan:
    // - Jika ada > 1 keputusan dengan count sama (termasuk kasus 2+2), anggap ambigu
    // - Jika hanya ada 1 keputusan (count >= 2), gunakan itu
    // - Jika tidak ada (semua beda), null
    if (decisionsFound === 1) {
        console.log("Keputusan Wasit:", decision);
        return decision; // Keputusan valid
    } else {
        console.log("Keputusan Wasit: Ambigu atau Semua Beda");
        return null; // Ambigu (termasuk 2+2) atau semua beda
    }
}


export default async function handler(req, res) {
  try {
    let state = await kv.get(STATE_KEY);
    if (!state) {
      state = {
        skorKiri: 0,
        skorKanan: 0,
        namaKiri: "PEMAIN 1",
        namaKanan: "PEMAIN 2",
        timerRunning: false,
        remainingTime: INITIAL_TIME_MS, // Waktu Mundur
        lastPauseTime: 0, // Kapan terakhir di-pause
        winnerName: null
      };
    }

    const q = req.query;
    let stateChanged = false;
    let validRefereeDecision = null; // Hasil keputusan wasit

    // --- Pemrosesan Input Skor (Logika Wasit) ---
    const scoreInput = q.score_kiri ? `score_kiri=${q.score_kiri}`
                     : q.score_kanan ? `score_kanan=${q.score_kanan}`
                     : null;

    // 1. Cek apakah input skor & timer berjalan
    if (scoreInput && state.timerRunning && !state.winnerName) {
        // Proses melalui logika wasit
        validRefereeDecision = await processRefereeInputs(scoreInput);

        if (validRefereeDecision) {
            // Jika ada keputusan valid, parse dan tambahkan skor
            const [key, value] = validRefereeDecision.split('=');
            if (key === 'score_kiri') {
                state.skorKiri += parseInt(value);
                stateChanged = true;
            } else if (key === 'score_kanan') {
                state.skorKanan += parseInt(value);
                stateChanged = true;
            }
        }
    // 2. Jika bukan input skor, cek input lain (nama, timer, reset)
    } else {
        // Input Nama (hanya jika timer tidak jalan atau belum ada pemenang)
        if (!state.timerRunning || !state.winnerName) {
            if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
            if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
        }

        // --- Logika Timer Mundur ---
        if (q.start_timer || q.toggle_timer && !state.timerRunning) {
            // START / RESUME
            if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
                state.timerRunning = true;
                // Hitung waktu mulai berdasarkan sisa waktu terakhir
                state.lastPauseTime = Date.now(); // Catat waktu start/resume
                stateChanged = true;
            }
        }
        if (q.stop_timer || q.toggle_timer && state.timerRunning) {
            // PAUSE
            if (state.timerRunning && !state.winnerName) {
                state.timerRunning = false;
                const elapsedSincePause = Date.now() - state.lastPauseTime;
                state.remainingTime = Math.max(0, state.remainingTime - elapsedSincePause); // Kurangi sisa waktu
                stateChanged = true;
            }
        }
    }


    // --- Logika Reset (bisa kapan saja) ---
    if (q.reset_skor) {
      state.skorKiri = 0;
      state.skorKanan = 0;
      state.remainingTime = INITIAL_TIME_MS; // Reset waktu ke 3 menit
      state.timerRunning = false;
      state.lastPauseTime = 0;
      state.winnerName = null;
      stateChanged = true;
      await kv.del(INPUT_KEY); // Hapus juga buffer input wasit
    }

    // --- Cek Pemenang (setelah skor diupdate) ---
    // (Pemenang juga bisa terjadi karena waktu habis)
    const pemenang = cekPemenang(state);
    if (!pemenang && state.remainingTime <= 0 && !state.winnerName) {
        // Waktu habis, tentukan pemenang berdasarkan skor
        if (state.skorKiri > state.skorKanan) state.winnerName = state.namaKiri;
        else if (state.skorKanan > state.skorKiri) state.winnerName = state.namaKanan;
        else state.winnerName = "SERI"; // Jika skor sama saat waktu habis
        state.timerRunning = false; // Pastikan timer berhenti
        stateChanged = true;
    } else if (pemenang && !state.winnerName) {
        // Menang karena skor atau selisih
        state.winnerName = pemenang;
        if (state.timerRunning) { // Otomatis pause timer
             state.timerRunning = false;
             const elapsedSincePause = Date.now() - state.lastPauseTime;
             state.remainingTime = Math.max(0, state.remainingTime - elapsedSincePause);
        }
        stateChanged = true;
    }

    // --- Update Sisa Waktu jika Timer Berjalan (untuk sinkronisasi polling) ---
    // Ini agar tampilan polling lebih akurat, meskipun client juga menghitung
    if (state.timerRunning && !state.winnerName) {
         const elapsedSincePause = Date.now() - state.lastPauseTime;
         const currentRemaining = Math.max(0, state.remainingTime - elapsedSincePause);
         // Hanya update state jika ada perubahan signifikan (misal > 100ms)
         // untuk mengurangi write ke KV, tapi ini bisa diskip jika akurasi realtime penting
         // if (Math.abs(currentRemaining - state.remainingTime_last_sent) > 100) {
              state.remainingTime_calculated = currentRemaining; // Kirim sisa waktu kalkulasi
         // }
    } else {
         state.remainingTime_calculated = state.remainingTime; // Kirim sisa waktu tersimpan
    }


    // Simpan state utama jika ada perubahan
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
    }

    // Kirim state terbaru (termasuk remainingTime_calculated)
    return res.status(200).json(state);

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
