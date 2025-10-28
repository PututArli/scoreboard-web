import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
// HAPUS: INPUT_KEY dan variabel wasit lainnya tidak diperlukan lagi
// const INPUT_KEY = 'referee_inputs';
// const INPUT_WINDOW_MS = 700;
// const REQUIRED_INPUTS = 4;
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

// HAPUS: Fungsi processRefereeInputs dihapus

// Inisialisasi state default (tetap sama)
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
  console.log(`[API] Request diterima: ${req.url}`);
  const q = req.query;

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
    // console.log("[API] State Awal:", JSON.stringify(state)); // Kurangi logging


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


    // --- Pemrosesan Input Skor (LANGSUNG, TANPA WASIT) ---
    const skorKiriInput = parseInt(q.score_kiri);
    const skorKananInput = parseInt(q.score_kanan);

    // Proses skor HANYA jika timer jalan, belum menang, waktu > 0
    if (state.timerRunning && !state.winnerName && currentRemainingTime > 0) {
        if (!isNaN(skorKiriInput)) {
             console.log("[SKOR] Input skor kiri:", skorKiriInput);
             state.skorKiri += skorKiriInput;
             stateChanged = true;
             console.log(`[SKOR] Skor diupdate: Kiri=${state.skorKiri}`);
        } else if (!isNaN(skorKananInput)) {
             console.log("[SKOR] Input skor kanan:", skorKananInput);
             state.skorKanan += skorKananInput;
             stateChanged = true;
             console.log(`[SKOR] Skor diupdate: Kanan=${state.skorKanan}`);
        }
    } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
         console.log("[SKOR] Input skor diabaikan:", { skorInput: q.score_kiri || q.score_kanan, timerRunning: state.timerRunning, winnerName: state.winnerName, currentRemainingTime });
    }
    // --- Akhir Pemrosesan Skor ---


    // --- Pemrosesan Input Nama ---
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { console.log("[NAMA] Update nama kiri:", q.nama_kiri); state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { console.log("[NAMA] Update nama kanan:", q.nama_kanan); state.namaKanan = q.nama_kanan; stateChanged = true; }
    } else if (q.nama_kiri || q.nama_kanan) {
         console.log("[NAMA] Input nama diabaikan.");
    }

    // --- Logika Timer Control (tetap sama) ---
    if (q.start_timer) {
        console.log("[TIMER] Perintah START diterima (web).");
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
        console.log("[TIMER] Perintah PAUSE diterima (web).");
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
    else if (q.toggle_timer) {
         console.log("[TIMER] Perintah TOGGLE diterima (ESP32).");
        if (!state.winnerName) {
            if (state.timerRunning) { // -> PAUSE
                 state.timerRunning = false;
                 const elapsedSinceStart = now - state.lastStartTime;
                 const newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
                 state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
                 state.lastStartTime = 0;
                 stateChanged = true;
                 console.log("[TIMER] Action: PAUSE (toggle). Sisa:", state.remainingTime);
            } else if (state.remainingTime > 0) { // -> START/RESUME
                 state.timerRunning = true;
                 state.lastStartTime = now;
                 stateChanged = true;
                 console.log("[TIMER] Action: START/RESUME (toggle). Sisa:", state.remainingTime);
            } else {
                 console.log("[TIMER] Action: TOGGLE START diabaikan (waktu habis).");
            }
        } else {
             console.log("[TIMER] Action: TOGGLE diabaikan (sudah ada pemenang).");
        }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET] Perintah RESET diterima.");
      state = getDefaultState();
      stateChanged = true;
      // HAPUS: Tidak perlu hapus INPUT_KEY lagi
      // await kv.del(INPUT_KEY);
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
