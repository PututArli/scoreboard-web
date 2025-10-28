import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs';
const INPUT_WINDOW_MS = 700;
const REQUIRED_INPUTS = 4;
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang (tetap sama)
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

// Fungsi proses input wasit (tetap sama)
async function processRefereeInputs(newInput) {
    const now = Date.now();
    let recentInputs = await kv.get(INPUT_KEY) || [];
    recentInputs.push({ input: newInput, timestamp: now });
    recentInputs = recentInputs.filter(item => now - item.timestamp < INPUT_WINDOW_MS);

    if (recentInputs.length < REQUIRED_INPUTS) {
        await kv.set(INPUT_KEY, recentInputs);
        console.log(`[WASIT] Input (${recentInputs.length}/${REQUIRED_INPUTS}): ${newInput}`);
        return null;
    }

    const lastInputs = recentInputs.slice(-REQUIRED_INPUTS);
    console.log("[WASIT] Memproses:", lastInputs.map(i => i.input));
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
        console.log("[WASIT] Keputusan Valid:", decision);
        return decision;
    } else {
        console.log(`[WASIT] Keputusan Tidak Valid/Ambigu (${decisionsFound}, ${maxCount})`);
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
    remainingTime: INITIAL_TIME_MS,
    lastStartTime: 0,
    winnerName: null
});


export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  // Log URL lengkap termasuk query
  console.log(`[API] Request diterima: ${req.url}`);
  const q = req.query; // Ambil query di awal

  try {
    let state = await kv.get(STATE_KEY);
    if (!state || typeof state.remainingTime !== 'number') {
      console.log("[API] State tidak valid/kosong, reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    } else {
      state.remainingTime = state.remainingTime ?? INITIAL_TIME_MS;
      state.lastStartTime = state.lastStartTime ?? 0;
      state.timerRunning = state.timerRunning ?? false;
      state.winnerName = state.winnerName ?? null;
    }
    console.log("[API] State Awal:", JSON.stringify(state));


    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini ---
    let currentRemainingTime = state.remainingTime;
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         if (currentRemainingTime <= 0 && state.remainingTime > 0) {
             console.log("[TIMER] Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0;
             stateChanged = true;
         }
    }
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    // console.log(`[TIMER] currentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input Skor ---
    const scoreInput = q.score_kiri ? `score_kiri=${q.score_kiri}`
                     : q.score_kanan ? `score_kanan=${q.score_kanan}`
                     : null;
    if (scoreInput && state.timerRunning && !state.winnerName && currentRemainingTime > 0) {
        console.log("[SKOR] Memproses input skor:", scoreInput);
        const validRefereeDecision = await processRefereeInputs(scoreInput);
        if (validRefereeDecision) {
            const [key, value] = validRefereeDecision.split('=');
            if (key === 'score_kiri') state.skorKiri += parseInt(value);
            if (key === 'score_kanan') state.skorKanan += parseInt(value);
            stateChanged = true;
            console.log(`[SKOR] Skor diupdate: Kiri=${state.skorKiri}, Kanan=${state.skorKanan}`);
        }
    } else if (scoreInput) {
         console.log("[SKOR] Input skor diabaikan:", { scoreInput, timerRunning: state.timerRunning, winnerName: state.winnerName, currentRemainingTime });
    }

    // --- Pemrosesan Input Nama ---
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { console.log("[NAMA] Update nama kiri:", q.nama_kiri); state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { console.log("[NAMA] Update nama kanan:", q.nama_kanan); state.namaKanan = q.nama_kanan; stateChanged = true; }
    } else if (q.nama_kiri || q.nama_kanan) {
         console.log("[NAMA] Input nama diabaikan.");
    }

    // --- Logika Timer Control ---
    if (q.start_timer) {
        console.log("[TIMER] Perintah START diterima (web). State saat ini:", JSON.stringify(state));
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastStartTime = now;
            stateChanged = true;
            console.log("[TIMER] Action: START. Sisa:", state.remainingTime);
        } else {
             console.log("[TIMER] Action: START diabaikan.");
        }
    }
    else if (q.stop_timer) {
        console.log("[TIMER] Perintah PAUSE diterima (web). State saat ini:", JSON.stringify(state));
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            const elapsedSinceStart = now - state.lastStartTime;
            const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0;
            stateChanged = true;
            console.log("[TIMER] Action: PAUSE. Sisa:", state.remainingTime);
        } else {
            console.log("[TIMER] Action: PAUSE diabaikan.");
        }
    }
    // ------ LOGGING SUPER DETAIL UNTUK TOGGLE ------
    else if (q.toggle_timer) {
         console.log("-----------------------------------------");
         console.log("[TIMER] Perintah TOGGLE diterima (ESP32).");
         console.log("[TIMER] State SEBELUM toggle:", JSON.stringify(state));
         console.log(`[TIMER] Kondisi Cek: !state.winnerName (${!state.winnerName})`);

        if (!state.winnerName) {
            if (state.timerRunning) { // -> PAUSE
                 console.log("[TIMER]   Kondisi: timerRunning == true -> Akan PAUSE");
                 state.timerRunning = false;
                 const elapsedSinceStart = now - state.lastStartTime;
                 const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
                 state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
                 state.lastStartTime = 0;
                 stateChanged = true;
                 console.log("[TIMER]   Action: PAUSE (toggle). Sisa:", state.remainingTime);
            } else { // -> START/RESUME
                 console.log("[TIMER]   Kondisi: timerRunning == false");
                 console.log(`[TIMER]   Kondisi Cek Tambahan: state.remainingTime > 0 (${state.remainingTime > 0})`);
                 if (state.remainingTime > 0) {
                     state.timerRunning = true;
                     state.lastStartTime = now;
                     stateChanged = true;
                     console.log("[TIMER]   Action: START/RESUME (toggle). Sisa:", state.remainingTime);
                 } else {
                     console.log("[TIMER]   Action: TOGGLE START diabaikan (waktu habis).");
                 }
            }
        } else {
             console.log("[TIMER] Action: TOGGLE diabaikan (sudah ada pemenang).");
        }
        console.log("-----------------------------------------");
    }
    // ------ AKHIR LOGGING TOGGLE ------


    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET] Perintah RESET diterima.");
      state = getDefaultState();
      stateChanged = true;
      await kv.del(INPUT_KEY);
      currentRemainingTime = state.remainingTime;
      console.log("[RESET] State direset ke default.");
    }

    // --- Cek Pemenang ---
    if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
        state.remainingTime = 0;
    }
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG] Pemenang ditemukan:", pemenang);
        state.winnerName = pemenang;
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             const finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime;
             console.log("[PEMENANG] Timer dihentikan. Sisa waktu:", state.remainingTime);
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      await kv.set(STATE_KEY, state);
      console.log("[API] State disimpan:", JSON.stringify(state));
    }

    // --- Kirim Respons ---
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : state.remainingTime;
    const responseState = { ...state, currentRemainingTime: finalCurrentRemaining };
    const handlerEndTime = Date.now();
    console.log(`[API] Mengirim respons (${handlerEndTime - handlerStartTime}ms):`, JSON.stringify(responseState));
    return res.status(200).json(responseState);

  } catch (error) {
    console.error("[API] Error Handler:", error);
     try {
         const defaultState = getDefaultState();
         console.log("[API] Mengirim fallback state karena error.");
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         console.error("[API] Error saat mengirim fallback state:", fallbackError);
         return res.status(500).send('Internal Server Error');
     }
  }
}
