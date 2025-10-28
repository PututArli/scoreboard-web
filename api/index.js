import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs';
const INPUT_WINDOW_MS = 700;
const REQUIRED_INPUTS = 4;
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state) {
  if (state.winnerName) return state.winnerName;
  const selisih = Math.abs(state.skorKiri - state.skorKanan);
  if (state.skorKiri >= 10) return state.namaKiri;
  if (state.skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (state.skorKiri > 0 || state.skorKanan > 0)) {
    return state.skorKiri > state.skorKanan ? state.namaKiri : state.namaKanan;
  }
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
    if (!state || typeof state.remainingTime !== 'number') { // Validasi tipe data remainingTime
      console.log("State tidak valid atau kosong, reset ke default.");
      state = getDefaultState();
      // Pastikan semua field ada
      state = { ...getDefaultState(), ...state, remainingTime: INITIAL_TIME_MS };
      await kv.set(STATE_KEY, state);
    }

    // Pastikan field penting selalu ada dan bertipe benar
    state.remainingTime = state.remainingTime ?? INITIAL_TIME_MS;
    state.lastStartTime = state.lastStartTime ?? 0;
    state.timerRunning = state.timerRunning ?? false;


    const q = req.query;
    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini ---
    let currentRemainingTime = state.remainingTime; // Default ke waktu tersimpan
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) { // Tambah cek lastStartTime > 0
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         if (currentRemainingTime <= 0) {
             console.log("Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0; // Set sisa waktu jadi 0
             // lastStartTime biarkan agar perhitungan akhir benar jika ada jeda network
             stateChanged = true;
         }
    }
    // Pastikan currentRemainingTime SELALU angka
    if (typeof currentRemainingTime !== 'number' || isNaN(currentRemainingTime)) {
        console.warn("currentRemainingTime tidak valid, direset ke state.remainingTime:", currentRemainingTime);
        currentRemainingTime = state.remainingTime ?? INITIAL_TIME_MS; // Fallback
        if (isNaN(currentRemainingTime)) currentRemainingTime = 0; // Fallback terakhir
    }


    // --- Pemrosesan Input ---
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
            // remainingTime tidak diubah saat start, nilainya adalah sisa waktu terakhir
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
            // Pastikan hasil perhitungan valid sebelum disimpan
            const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            if(typeof newRemaining === 'number' && !isNaN(newRemaining)) {
                 state.remainingTime = newRemaining;
            } else {
                 console.error("Perhitungan remainingTime saat PAUSE tidak valid!");
                 // Fallback: gunakan currentRemainingTime jika valid
                 state.remainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0;
            }
            state.lastStartTime = 0; // Reset lastStartTime saat pause
            stateChanged = true;
            console.log("Timer PAUSED. Sisa:", state.remainingTime);
        }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("RESET diterima.");
      state = getDefaultState();
      stateChanged = true;
      await kv.del(INPUT_KEY);
      // Hitung ulang currentRemainingTime setelah reset
      currentRemainingTime = state.remainingTime;
    }

    // --- Cek Pemenang ---
    // Update state.remainingTime JIKA timer baru saja berhenti karena waktu habis
     if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
         state.remainingTime = 0; // Pastikan tersimpan 0
     }
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("Pemenang ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             const finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             if(typeof finalRemaining === 'number' && !isNaN(finalRemaining)) {
                 state.remainingTime = finalRemaining;
             } else {
                 state.remainingTime = 0; // Fallback
             }
             state.lastStartTime = 0;
             // Update currentRemainingTime juga
             currentRemainingTime = state.remainingTime;
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
      console.log("State disimpan:", { ...state, currentRemainingTime });
    }

    // --- Kirim Respons ---
    // Pastikan currentRemainingTime yang dikirim adalah angka valid
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : state.remainingTime;

    return res.status(200).json({ ...state, currentRemainingTime: finalCurrentRemaining });

  } catch (error) {
    console.error("API Error:", error);
    // Coba kirim state default jika ada error parah
     try {
         const defaultState = getDefaultState();
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         return res.status(500).send('Internal Server Error'); // Fallback terakhir
     }
  }
}
