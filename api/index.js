import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs';
const INPUT_WINDOW_MS = 700;
const REQUIRED_INPUTS = 4;
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state) {
  // Langsung return jika sudah ada pemenang
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

// Fungsi proses input wasit
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
    // Inisialisasi atau validasi state
    if (!state || typeof state.remainingTime !== 'number') {
      console.log("State tidak valid/kosong, reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    } else {
      // Pastikan field penting ada dan bertipe benar
      state.remainingTime = state.remainingTime ?? INITIAL_TIME_MS;
      state.lastStartTime = state.lastStartTime ?? 0;
      state.timerRunning = state.timerRunning ?? false;
      state.winnerName = state.winnerName ?? null; // Pastikan winnerName ada
    }

    const q = req.query;
    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini ---
    let currentRemainingTime = state.remainingTime;
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         // Jika waktu habis saat timer jalan, update state
         if (currentRemainingTime <= 0 && state.remainingTime > 0) { // Hanya update jika baru habis
             console.log("Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0;
             // lastStartTime tidak diubah agar perhitungan akhir benar
             stateChanged = true;
         }
    }
    // Pastikan currentRemainingTime valid
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);


    // --- Pemrosesan Input Skor (Hanya jika timer jalan, belum menang, waktu > 0) ---
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

    // --- Pemrosesan Input Nama (Hanya jika timer TIDAK jalan & belum menang) ---
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
    }

    // --- Logika Timer Control ---
    // Pisahkan logika untuk start, stop, dan toggle agar lebih jelas

    // START (dari tombol web)
    if (q.start_timer) {
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastStartTime = now;
            stateChanged = true;
            console.log("Timer START (web). Sisa:", state.remainingTime);
        }
    }
    // PAUSE (dari tombol web)
    else if (q.stop_timer) {
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            const elapsedSinceStart = now - state.lastStartTime;
            const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            // Validasi sebelum menyimpan
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0;
            stateChanged = true;
            console.log("Timer PAUSE (web). Sisa:", state.remainingTime);
        }
    }
    // TOGGLE (dari ESP32)
    else if (q.toggle_timer) {
        if (!state.winnerName) { // Hanya toggle jika belum ada pemenang
            if (state.timerRunning) { // Jika sedang jalan -> PAUSE
                 state.timerRunning = false;
                 const elapsedSinceStart = now - state.lastStartTime;
                 const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
                 state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
                 state.lastStartTime = 0;
                 stateChanged = true;
                 console.log("Timer PAUSE (toggle). Sisa:", state.remainingTime);
            } else if (state.remainingTime > 0) { // Jika sedang pause & waktu > 0 -> START/RESUME
                 state.timerRunning = true;
                 state.lastStartTime = now;
                 stateChanged = true;
                 console.log("Timer START/RESUME (toggle). Sisa:", state.remainingTime);
            }
        }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("RESET diterima.");
      state = getDefaultState();
      stateChanged = true;
      await kv.del(INPUT_KEY);
      currentRemainingTime = state.remainingTime; // Update current time setelah reset
    }

    // --- Cek Pemenang ---
    // Update state.remainingTime jika waktu habis saat timer jalan
    if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
        state.remainingTime = 0;
    }
    // Cek pemenang SETELAH semua state diupdate
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("Pemenang ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             const finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time juga
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
      // Log state yang disimpan (tanpa currentRemainingTime karena itu temporary)
      console.log("State disimpan:", state);
    }

    // --- Kirim Respons ---
    // Kirim state LENGKAP termasuk currentRemainingTime yang sudah divalidasi
    return res.status(200).json({ ...state, currentRemainingTime });

  } catch (error) {
    console.error("API Error:", error);
     try {
         const defaultState = getDefaultState();
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         return res.status(500).send('Internal Server Error');
     }
  }
}
