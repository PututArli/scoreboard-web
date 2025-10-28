import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state_minimal'; // Gunakan key baru untuk tes
const INITIAL_TIME_MS = 180 * 1000;

// State default minimal
const getDefaultState = () => ({
    skorKiri: 0,
    skorKanan: 0, // Tetap ada meski tidak diubah
    timerRunning: false,
    remainingTime: INITIAL_TIME_MS,
    lastStartTime: 0,
    winnerName: null
});

export default async function handler(req, res) {
  const q = req.query;
  const now = Date.now();
  console.log(`[API MINIMAL] Request: ${req.url}`); // Logging Awal

  try {
    let state = await kv.get(STATE_KEY);

    // Inisialisasi atau validasi state
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API MINIMAL] State KV tidak valid/kosong, reset.");
      state = getDefaultState();
      // Jangan langsung simpan, biarkan perubahan di bawah yg simpan
    } else {
        // Pastikan field penting ada
        state = { ...getDefaultState(), ...state };
        state.skorKiri = parseInt(state.skorKiri) || 0;
        state.timerRunning = state.timerRunning === true;
        state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : INITIAL_TIME_MS;
        state.lastStartTime = parseInt(state.lastStartTime) || 0;
    }
    console.log("[API MINIMAL] State AWAL:", JSON.stringify(state));

    let stateChanged = false;
    let currentRemainingTime = state.remainingTime; // Hitung waktu terkini

    // Hitung waktu sisa JIKA timer jalan
    if (state.timerRunning && state.lastStartTime > 0) {
        const elapsed = now - state.lastStartTime;
        currentRemainingTime = Math.max(0, state.remainingTime - elapsed);
        if (currentRemainingTime <= 0 && state.remainingTime > 0) {
             console.log("[API MINIMAL] Waktu habis terdeteksi.");
             state.timerRunning = false;
             state.remainingTime = 0;
             state.lastStartTime = 0;
             stateChanged = true;
             currentRemainingTime = 0;
        }
    } else {
        // Jika timer tidak jalan, waktu terkini = waktu tersimpan
        currentRemainingTime = state.remainingTime;
    }
    // Pastikan tidak NaN
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0;


    // --- Proses Input (SUPER SEDERHANA) ---
    // 1. Toggle Timer (dari remote atau web)
    if (q.toggle_timer || q.start_timer || q.stop_timer) {
        console.log("[API MINIMAL] Input Timer Diterima.");
        if (state.timerRunning) { // Jika JALAN -> PAUSE
            console.log("  -> Kondisi: Jalan -> PAUSE");
            state.timerRunning = false;
            const elapsed = now - state.lastStartTime;
            const newRemaining = (state.lastStartTime > 0 && !isNaN(elapsed)) ? Math.max(0, state.remainingTime - elapsed) : state.remainingTime;
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0;
            stateChanged = true;
            console.log("    -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
            currentRemainingTime = state.remainingTime; // Update current
        } else if (state.remainingTime > 0) { // Jika PAUSE & Waktu > 0 -> START
            console.log("  -> Kondisi: Pause & Waktu > 0 -> START");
            state.timerRunning = true;
            state.lastStartTime = now; // Catat waktu mulai
            // remainingTime tidak diubah saat start
            stateChanged = true;
            console.log("    -> Action: START. Sisa sebelum:", state.remainingTime);
        } else {
            console.log("  -> Action: Timer diabaikan (waktu habis?).");
        }
    }
    // 2. Skor Kiri +1 (dari remote atau web)
    else if (q.score_kiri === '1') { // Hanya proses +1 kiri
        console.log("[API MINIMAL] Input Skor Kiri +1 Diterima.");
        if (state.timerRunning && currentRemainingTime > 0) { // Cek timer jalan
            state.skorKiri += 1;
            stateChanged = true;
            console.log("  -> Action: Skor Kiri +1. Skor baru:", state.skorKiri);
        } else {
            console.log("  -> Action: Skor Kiri diabaikan (timer off / waktu habis).");
        }
    }
    // 3. Reset
    else if (q.reset_skor) {
        console.log("[API MINIMAL] Input RESET Diterima.");
        state = getDefaultState();
        stateChanged = true;
        currentRemainingTime = state.remainingTime;
        console.log("  -> Action: State direset.");
    }
    // Abaikan input lain
    else {
        console.log("[API MINIMAL] Request tanpa aksi valid (mungkin polling).");
    }


    // --- Simpan State JIKA Berubah ---
    if (stateChanged) {
      // Validasi akhir sebelum simpan
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.max(0, Math.min(INITIAL_TIME_MS, state.remainingTime)) : 0;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true;
      state.winnerName = null; // Reset pemenang saat state berubah (kecuali reset)

      try {
          await kv.set(STATE_KEY, state);
          console.log("[API MINIMAL] State disimpan:", JSON.stringify(state));
      } catch (kvError) {
           console.error("[API MINIMAL] Gagal menyimpan state ke KV:", kvError);
           return res.status(500).json({ error: 'KV Set Error', details: kvError.message });
      }
    }

    // --- Kirim Respons ---
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    const responseState = { ...state, currentRemainingTime: finalCurrentRemaining };
    const handlerEndTime = Date.now();
    // console.log(`[API MINIMAL] Mengirim respons (${handlerEndTime - handlerStartTime}ms):`, JSON.stringify(responseState));
    return res.status(200).json(responseState);

  } catch (error) {
    console.error("[API MINIMAL] Error Handler:", error);
     try {
         const defaultState = getDefaultState();
         console.log("[API MINIMAL] Mengirim fallback state karena error.");
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         console.error("[API MINIMAL] Error saat mengirim fallback state:", fallbackError);
         return res.status(500).send('Internal Server Error');
     }
  }
}
