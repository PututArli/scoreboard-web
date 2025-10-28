import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs'; // Key baru untuk menampung input wasit
const INPUT_WINDOW_MS = 700; // Jendela waktu untuk input wasit (ms)
const REQUIRED_INPUTS = 4; // Jumlah input wasit yang dibutuhkan
const INITIAL_TIME_MS = 180 * 1000; // 3 menit dalam milidetik

// Fungsi untuk mengecek pemenang
function cekPemenang(state) {
  // Jika sudah ada pemenang sebelumnya, langsung return
  if (state.winnerName) return state.winnerName;

  // Cek kondisi menang normal
  const selisih = Math.abs(state.skorKiri - state.skorKanan);
  if (state.skorKiri >= 10) return state.namaKiri;
  if (state.skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (state.skorKiri > 0 || state.skorKanan > 0)) {
    return state.skorKiri > state.skorKanan ? state.namaKiri : state.namaKanan;
  }

  // Cek kondisi menang karena waktu habis (HANYA jika timer TIDAK jalan)
  if (state.remainingTime <= 0 && !state.timerRunning) {
      if (state.skorKiri > state.skorKanan) return state.namaKiri;
      else if (state.skorKanan > state.skorKiri) return state.namaKanan;
      else return "SERI"; // Skor sama saat waktu habis
  }

  return null; // Belum ada pemenang
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
        console.log(`Input wasit diterima (${recentInputs.length}/${REQUIRED_INPUTS}): ${newInput}`);
        return null; // Belum ada keputusan
    }

    // Ambil N input terakhir (sesuai REQUIRED_INPUTS)
    const lastInputs = recentInputs.slice(-REQUIRED_INPUTS);
    console.log("Memproses input wasit:", lastInputs.map(i => i.input));

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
            // Cek apakah ini count tertinggi sejauh ini
            if (counts[input] > maxCount) {
                 maxCount = counts[input];
                 decision = input; // Ini keputusan sementara
                 decisionsFound = 1; // Reset jumlah keputusan
            } else if (counts[input] === maxCount) {
                 decisionsFound++; // Ada keputusan lain dengan count yang sama (ambigu)
            }
        }
    }

    // Bersihkan buffer input setelah diproses
    await kv.del(INPUT_KEY);

    // Logika keputusan:
    if (decisionsFound === 1 && maxCount >= 2) {
        console.log("Keputusan Wasit Valid:", decision);
        return decision; // Keputusan valid
    } else {
        // Jika decisionsFound > 1 (ambigu 2+2) ATAU maxCount < 2 (semua beda/tidak ada mayoritas)
        console.log(`Keputusan Wasit Tidak Valid/Ambigu (decisionsFound: ${decisionsFound}, maxCount: ${maxCount})`);
        return null; // Ambigu atau tidak ada konsensus
    }
}


export default async function handler(req, res) {
  try {
    let state = await kv.get(STATE_KEY);
    // Inisialisasi state jika belum ada
    if (!state) {
      state = {
        skorKiri: 0,
        skorKanan: 0,
        namaKiri: "PEMAIN 1",
        namaKanan: "PEMAIN 2",
        timerRunning: false,
        remainingTime: INITIAL_TIME_MS, // Waktu Mundur Awal
        lastPauseTime: 0, // Kapan terakhir di-pause/start
        winnerName: null
      };
      await kv.set(STATE_KEY, state); // Simpan state awal
    }

    const q = req.query;
    let stateChanged = false;
    let validRefereeDecision = null; // Hasil keputusan wasit

    // --- Pemrosesan Input Skor (HANYA JIKA TIMER JALAN & BELUM MENANG) ---
    const scoreInput = q.score_kiri ? `score_kiri=${q.score_kiri}`
                     : q.score_kanan ? `score_kanan=${q.score_kanan}`
                     : null;

    if (scoreInput && state.timerRunning && !state.winnerName) {
        validRefereeDecision = await processRefereeInputs(scoreInput);
        if (validRefereeDecision) {
            const [key, value] = validRefereeDecision.split('=');
            if (key === 'score_kiri') state.skorKiri += parseInt(value);
            if (key === 'score_kanan') state.skorKanan += parseInt(value);
            stateChanged = true;
        }
    }
    // --- Akhir Pemrosesan Skor ---

    // --- Pemrosesan Input Lain (Nama, Timer, Reset) ---
    // Input Nama (hanya jika timer TIDAK jalan dan belum ada pemenang)
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
    }

    // --- Logika Timer Mundur ---
    const now = Date.now();
    // START / RESUME
    if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastPauseTime = now; // Catat waktu start/resume
            stateChanged = true;
            console.log("Timer STARTED/RESUMED at:", now, "Remaining:", state.remainingTime);
        }
    }
    // PAUSE
    else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            // Hitung waktu berlalu sejak pause/start terakhir & kurangi sisa waktu
            const elapsedSincePause = now - state.lastPauseTime;
            state.remainingTime = Math.max(0, state.remainingTime - elapsedSincePause);
            state.lastPauseTime = now; // Catat waktu pause
            stateChanged = true;
            console.log("Timer PAUSED at:", now, "Elapsed since last:", elapsedSincePause, "New Remaining:", state.remainingTime);
        }
    }
    // --- Akhir Logika Timer ---


    // --- Logika Reset (bisa kapan saja) ---
    if (q.reset_skor) {
      console.log("RESET requested");
      state.skorKiri = 0;
      state.skorKanan = 0;
      state.remainingTime = INITIAL_TIME_MS; // Reset waktu ke 3 menit
      state.timerRunning = false;
      state.lastPauseTime = 0;
      state.winnerName = null;
      stateChanged = true;
      await kv.del(INPUT_KEY); // Hapus juga buffer input wasit
    }


    // --- Update Sisa Waktu jika Timer Berjalan (untuk sinkronisasi polling) ---
    let currentRemainingTime = state.remainingTime; // Default ke waktu tersimpan
    if (state.timerRunning && !state.winnerName) {
         const elapsedSincePause = now - state.lastPauseTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSincePause);
         // Jika waktu habis saat timer jalan, langsung set state
         if (currentRemainingTime <= 0) {
             console.log("Time ran out while running");
             state.timerRunning = false; // Stop timer
             state.remainingTime = 0; // Set sisa waktu jadi 0
             state.lastPauseTime = now; // Catat waktu berhenti
             stateChanged = true;
             // Cek pemenang berdasarkan waktu habis akan dilakukan di bawah
         }
    }
    // Tambahkan field sementara untuk dikirim ke client
    state.currentRemainingTime = currentRemainingTime;


    // --- Cek Pemenang (setelah semua update state) ---
    // PERBAIKAN: Panggil cekPemenang SETELAH remainingTime diupdate
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) { // Hanya set jika belum ada pemenang
        console.log("Winner found:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat pemenang ditemukan (karena skor/selisih), hentikan
        if (state.timerRunning) {
             state.timerRunning = false;
             // Hitung sisa waktu terakhir sebelum berhenti
             const elapsedSincePause = now - state.lastPauseTime;
             state.remainingTime = Math.max(0, state.remainingTime - elapsedSincePause);
             state.lastPauseTime = now;
        }
        stateChanged = true;
    }


    // Simpan state utama jika ada perubahan
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
      console.log("State saved:", state);
    } else {
      // console.log("No state change detected");
    }

    // Kirim state terbaru (termasuk currentRemainingTime)
    return res.status(200).json(state);

  } catch (error) {
    console.error("API Error:", error);
    // Kirim detail error ke client untuk debugging jika perlu
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
