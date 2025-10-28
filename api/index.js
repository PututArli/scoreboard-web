import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs';
const INPUT_WINDOW_MS = 700;
const REQUIRED_INPUTS = 4;
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang (tetap sama, tapi disederhanakan)
function cekPemenang(state) {
  if (state.winnerName) return state.winnerName;
  const selisih = Math.abs(state.skorKiri - state.skorKanan);
  if (state.skorKiri >= 10) return state.namaKiri;
  if (state.skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (state.skorKiri > 0 || state.skorKanan > 0)) {
    return state.skorKiri > state.skorKanan ? state.namaKiri : state.namaKanan;
  }
  // Cek waktu habis hanya jika timer TIDAK jalan & waktu <= 0
  if (!state.timerRunning && state.remainingTime <= 0) {
      if (state.skorKiri > state.skorKanan) return state.namaKiri;
      else if (state.skorKanan > state.skorKiri) return state.namaKanan;
      else return "SERI";
  }
  return null;
}

// Fungsi proses input wasit (tetap sama)
async function processRefereeInputs(newInput) {
    const now = Date.now();
    let recentInputs = await kv.get(INPUT_KEY) || [];
    recentInputs.push({ input: newInput, timestamp: now });
    recentInputs = recentInputs.filter(item => now - item.timestamp < INPUT_WINDOW_MS);

    if (recentInputs.length < REQUIRED_INPUTS) {
        await kv.set(INPUT_KEY, recentInputs);
        console.log(`Input wasit (${recentInputs.length}/${REQUIRED_INPUTS}): ${newInput}`);
        return null;
    }

    const lastInputs = recentInputs.slice(-REQUIRED_INPUTS);
    console.log("Memproses:", lastInputs.map(i => i.input));
    const counts = {};
    lastInputs.forEach(item => { counts[item.input] = (counts[item.input] || 0) + 1; });

    let decision = null;
    let maxCount = 0;
    let decisionsFound = 0;
    for (const input in counts) {
        if (counts[input] >= 2) {
            if (counts[input] > maxCount) {
                 maxCount = counts[input];
                 decision = input;
                 decisionsFound = 1;
            } else if (counts[input] === maxCount) {
                 decisionsFound++;
            }
        }
    }
    await kv.del(INPUT_KEY);
    if (decisionsFound === 1 && maxCount >= 2) {
        console.log("Keputusan Valid:", decision);
        return decision;
    } else {
        console.log(`Keputusan Tidak Valid/Ambigu (${decisionsFound}, ${maxCount})`);
        return null;
    }
}

// Inisialisasi state default
const getDefaultState = () => ({
    skorKiri: 0,
    skorKanan: 0,
    namaKiri: "PEMAIN 1",
    namaKanan: "PEMAIN 2",
    timerRunning: false,
    remainingTime: INITIAL_TIME_MS, // Sisa waktu saat terakhir di PAUSE/RESET
    lastStartTime: 0, // Kapan terakhir kali timer di START/RESUME
    winnerName: null
});


export default async function handler(req, res) {
  try {
    let state = await kv.get(STATE_KEY);
    // Jika state tidak ada atau korup, reset ke default
    if (!state || typeof state.remainingTime === 'undefined') {
      console.log("State tidak valid atau kosong, reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    }

    const q = req.query;
    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini (jika timer jalan) ---
    let currentRemainingTime = state.remainingTime; // Default ke waktu tersimpan (saat pause)
    if (state.timerRunning && !state.winnerName) {
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         // Jika waktu habis saat timer jalan, update state
         if (currentRemainingTime <= 0) {
             console.log("Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0; // Set sisa waktu jadi 0
             // lastStartTime tidak diubah agar perhitungan akhir benar
             stateChanged = true; // Tandai state berubah
             // Pemenang akan dicek di bawah
         }
    }

    // --- Pemrosesan Input ---
    // Skor (HANYA JIKA TIMER JALAN & BELUM MENANG & WAKTU MASIH ADA)
    const scoreInput = q.score_kiri ? `score_kiri=${q.score_kiri}`
                     : q.score_kanan ? `score_kanan=${q.score_kanan}`
                     : null;
    if (scoreInput && state.timerRunning && !state.winnerName && currentRemainingTime > 0) {
        const validRefereeDecision = await processRefereeInputs(scoreInput);
        if (validRefereeDecision) {
            const [key, value] = validRefereeDecision.split('=');
            if (key === 'score_kiri') state.skorKiri += parseInt(value);
            if (key === 'score_kanan') state.skorKanan += parseInt(value);
            stateChanged = true;
        }
    }
    // Nama (Hanya jika timer TIDAK jalan & belum menang)
    else if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
    }

    // --- Logika Timer Control ---
    // START / RESUME
    if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastStartTime = now; // Catat waktu mulai/lanjut
            // remainingTime tetap (tidak diubah saat start)
            stateChanged = true;
            console.log("Timer STARTED/RESUMED. Sisa:", state.remainingTime);
        }
    }
    // PAUSE
    else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            // Hitung sisa waktu saat ini dan SIMPAN
            const elapsedSinceStart = now - state.lastStartTime;
            state.remainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
            state.lastStartTime = 0; // Reset lastStartTime saat pause
            stateChanged = true;
            console.log("Timer PAUSED. Sisa:", state.remainingTime);
        }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("RESET diterima.");
      state = getDefaultState(); // Langsung reset ke state awal
      stateChanged = true;
      await kv.del(INPUT_KEY);
    }

    // --- Cek Pemenang (setelah semua update state) ---
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) { // Hanya set jika belum ada pemenang
        console.log("Pemenang ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang (karena skor/selisih), hentikan & simpan waktu sisa
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             state.remainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
             state.lastStartTime = 0;
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
      console.log("State disimpan:", { ...state, currentRemainingTime }); // Log state yg akan dikirim
    }

    // --- Kirim Respons ---
    // Selalu kirim sisa waktu TERKINI (currentRemainingTime) ke client
    return res.status(200).json({ ...state, currentRemainingTime });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
