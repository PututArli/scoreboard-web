import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state) {
  if (state.winnerName) return state.winnerName;
  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  const remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : 0;

  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }
  if (!state.timerRunning && remainingTime <= 0) {
      if (skorKiri > skorKanan) return state.namaKiri;
      else if (skorKanan > skorKiri) return state.namaKanan;
      else return "SERI";
  }
  return null;
}

// State default
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
  console.log(`[API] Request: ${req.url}`);
  const q = req.query;

  try {
    let state = await kv.get(STATE_KEY);
    // Validasi state awal
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API] State awal tidak valid/kosong -> Reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    } else {
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.namaKiri = state.namaKiri || "PEMAIN 1";
      state.namaKanan = state.namaKanan || "PEMAIN 2";
      state.timerRunning = state.timerRunning === true;
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : INITIAL_TIME_MS;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    // console.log("[API] State AWAL:", JSON.stringify(state));

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
             state.lastStartTime = 0;
             stateChanged = true;
             currentRemainingTime = 0;
         }
    }
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    // console.log(`[TIMER] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input Skor (LANGSUNG) ---
    const skorKiriInput = parseInt(q.score_kiri);
    const skorKananInput = parseInt(q.score_kanan);
    // PENYEDERHANAAN KONDISI: Cukup cek timerRunning & !winnerName
    if (state.timerRunning && !state.winnerName) {
        if (!isNaN(skorKiriInput) && skorKiriInput > 0) {
             state.skorKiri += skorKiriInput; stateChanged = true;
             console.log(`[SKOR] Kiri +${skorKiriInput} -> ${state.skorKiri}`);
        } else if (!isNaN(skorKananInput) && skorKananInput > 0) {
             state.skorKanan += skorKananInput; stateChanged = true;
             console.log(`[SKOR] Kanan +${skorKananInput} -> ${state.skorKanan}`);
        }
    } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
         console.log("[SKOR] Input skor diabaikan (timer off / ada pemenang).");
    }

    // --- Pemrosesan Input Nama ---
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
    }

    // --- Logika Timer Control ---
    // START / RESUME
    if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
        console.log("[TIMER] Input: START/TOGGLE-ON");
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastStartTime = now;
            stateChanged = true;
            console.log("  -> Action: START/RESUME. Sisa sebelum start:", state.remainingTime);
        } else { console.log("  -> Action: START/TOGGLE-ON diabaikan."); }
    }
    // PAUSE / TOGGLE OFF
    else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
        console.log("[TIMER] Input: PAUSE/TOGGLE-OFF");
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            const elapsedSinceStart = now - state.lastStartTime;
            let newRemaining = state.remainingTime;
            if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            } else { console.error("[TIMER] Gagal hitung elapsed saat PAUSE"); }
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0;
            stateChanged = true;
            console.log("  -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
            currentRemainingTime = state.remainingTime;
        } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET] Input: reset_skor");
      state = getDefaultState();
      stateChanged = true;
      await kv.del('referee_inputs').catch(err => console.warn("Gagal hapus INPUT_KEY saat reset:", err));
      currentRemainingTime = state.remainingTime;
      console.log("  -> Action: State direset.");
    }

    // --- Cek Pemenang ---
     if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
        if(state.remainingTime > 0) state.remainingTime = 0;
     }
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG] Ditemukan:", pemenang);
        state.winnerName = pemenang;
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             let finalRemaining = state.remainingTime;
              if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                 finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             }
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime;
             console.log("  -> Timer dihentikan. Sisa waktu:", state.remainingTime);
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.min(INITIAL_TIME_MS, state.remainingTime) : 0;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;

      await kv.set(STATE_KEY, state);
      // console.log("[API] State disimpan:", JSON.stringify(state));
    }

    // --- Kirim Respons ---
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    const responseState = { ...state, currentRemainingTime: finalCurrentRemaining };
    const handlerEndTime = Date.now();
    // console.log(`[API] Mengirim respons (${handlerEndTime - handlerStartTime}ms):`, JSON.stringify(responseState));
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
