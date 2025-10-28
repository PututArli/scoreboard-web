import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INITIAL_TIME_MS = 180 * 1000; // 3 menit (180 detik * 1000 ms)

// Fungsi cek pemenang
function cekPemenang(state) {
  // Langsung return jika sudah ada pemenang
  if (state.winnerName) return state.winnerName;

  // Validasi skor sebelum cek
  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  // Validasi waktu sisa
  const remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : 0;

  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }
  // Cek waktu habis hanya jika timer TIDAK jalan & waktu <= 0
  if (!state.timerRunning && remainingTime <= 0) {
      if (skorKiri > skorKanan) return state.namaKiri;
      else if (skorKanan > skorKiri) return state.namaKanan;
      else return "SERI";
  }
  return null; // Belum ada pemenang
}

// State default
const getDefaultState = () => ({
    skorKiri: 0,
    skorKanan: 0,
    namaKiri: "PEMAIN 1",
    namaKanan: "PEMAIN 2",
    timerRunning: false,
    remainingTime: INITIAL_TIME_MS, // Sisa waktu saat terakhir PAUSE/RESET
    lastStartTime: 0, // Kapan terakhir kali timer di START/RESUME
    winnerName: null
});

export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`[API] Request: ${req.url}`);
  const q = req.query;

  try {
    let state = await kv.get(STATE_KEY);
    // Inisialisasi atau validasi state
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API] State awal tidak valid/kosong -> Reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state); // Simpan state default
    } else {
      // Pastikan semua field ada & valid
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.namaKiri = state.namaKiri || "PEMAIN 1";
      state.namaKanan = state.namaKanan || "PEMAIN 2";
      state.timerRunning = state.timerRunning === true; // Pastikan boolean
      // Pastikan remainingTime tidak melebihi waktu awal saat load (kecuali sedang jalan)
      if (!state.timerRunning) {
          state.remainingTime = Math.min(INITIAL_TIME_MS, (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : INITIAL_TIME_MS);
      } else {
           state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : INITIAL_TIME_MS;
      }
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    // console.log("[API] State AWAL Valid:", JSON.stringify(state));

    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini ---
    let currentRemainingTime = state.remainingTime; // Ambil waktu tersimpan
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         // Hitung sisa waktu TERKINI
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         // Jika waktu habis saat timer jalan, update state
         if (currentRemainingTime <= 0 && state.remainingTime > 0) {
             console.log("[TIMER] Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0; // Simpan sisa waktu 0
             state.lastStartTime = 0; // Reset last start time
             stateChanged = true;
             currentRemainingTime = 0; // Pastikan current juga 0
         }
    }
    // Final check agar tidak NaN dan tidak lebih dari waktu awal
    currentRemainingTime = Math.min(INITIAL_TIME_MS, (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0);
    // console.log(`[TIMER] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input Skor (LANGSUNG) ---
    const skorKiriInput = parseInt(q.score_kiri);
    const skorKananInput = parseInt(q.score_kanan);
    // Proses skor HANYA jika timer jalan, belum menang, waktu > 0
    if (state.timerRunning && !state.winnerName && currentRemainingTime > 0) {
        if (!isNaN(skorKiriInput) && skorKiriInput > 0) { // Pastikan > 0
             state.skorKiri += skorKiriInput; stateChanged = true;
             console.log(`[SKOR] Kiri +${skorKiriInput} -> ${state.skorKiri}`);
        } else if (!isNaN(skorKananInput) && skorKananInput > 0) { // Pastikan > 0
             state.skorKanan += skorKananInput; stateChanged = true;
             console.log(`[SKOR] Kanan +${skorKananInput} -> ${state.skorKanan}`);
        }
    } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
         console.log("[SKOR] Input skor diabaikan.");
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
            state.lastStartTime = now; // Catat waktu mulai/lanjut
            // remainingTime TIDAK diubah saat start/resume
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
            let newRemaining = state.remainingTime; // Default
            if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            } else { console.error("[TIMER] Gagal hitung elapsed saat PAUSE"); }
            // Simpan sisa waktu yang valid
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0; // Reset lastStartTime
            stateChanged = true;
            console.log("  -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
            currentRemainingTime = state.remainingTime; // Update current time juga
        } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET] Input: reset_skor");
      state = getDefaultState();
      stateChanged = true;
      // Hapus key wasit jika masih ada
      await kv.del('referee_inputs').catch(err => console.warn("Gagal hapus INPUT_KEY saat reset:", err));
      currentRemainingTime = state.remainingTime;
      console.log("  -> Action: State direset.");
    }

    // --- Cek Pemenang ---
    // Update state.remainingTime jika waktu habis saat timer jalan
     if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
        if(state.remainingTime > 0) state.remainingTime = 0;
     }
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG] Ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             let finalRemaining = state.remainingTime;
              if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                 finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             }
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time
             console.log("  -> Timer dihentikan. Sisa waktu:", state.remainingTime);
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      // Validasi terakhir sebelum simpan
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
    // Kurangi logging di akhir
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
