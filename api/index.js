import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INPUT_KEY = 'referee_inputs'; // Tetap ada jika ingin dikembalikan
const INPUT_WINDOW_MS = 700;
const REQUIRED_INPUTS = 4;
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state) {
  if (state.winnerName) return state.winnerName;
  // Pastikan skor adalah angka sebelum membandingkan
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

// Fungsi proses input wasit (Sementara tidak dipakai, tapi biarkan ada)
async function processRefereeInputs(newInput) {
    // ... (kode processRefereeInputs tetap sama seperti sebelumnya) ...
    // Untuk sekarang, kita bypass logika wasit
     console.log("[WASIT] Bypassed, input diterima:", newInput);
     return newInput; // Langsung kembalikan input
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
  console.log(`[API] Request diterima: ${req.url}`);
  const q = req.query;

  try {
    let state = await kv.get(STATE_KEY);
    // Inisialisasi atau validasi state yang LEBIH KETAT
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API] State tidak valid/kosong/NaN, reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    } else {
      // Pastikan semua field penting ada dan valid
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.namaKiri = state.namaKiri || "PEMAIN 1";
      state.namaKanan = state.namaKanan || "PEMAIN 2";
      state.timerRunning = state.timerRunning === true; // Pastikan boolean
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : INITIAL_TIME_MS;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    console.log("[API] State Awal Valid:", JSON.stringify(state));


    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini ---
    let currentRemainingTime = state.remainingTime;
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         // Pastikan elapsed valid
         if (typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
             currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
             if (currentRemainingTime <= 0 && state.remainingTime > 0) {
                 console.log("[TIMER] Waktu habis saat timer berjalan.");
                 state.timerRunning = false;
                 state.remainingTime = 0; // Set sisa waktu jadi 0
                 stateChanged = true;
             }
         } else {
              console.error("[TIMER] Perhitungan elapsedSinceStart tidak valid:", elapsedSinceStart);
              // Jika perhitungan gagal, mungkin lebih aman pause timer?
              state.timerRunning = false;
              stateChanged = true;
              currentRemainingTime = state.remainingTime; // Gunakan waktu tersimpan
         }
    }
    // Final check untuk currentRemainingTime
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0;
    // console.log(`[TIMER] currentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input Skor (LANGSUNG) ---
    const skorKiriInput = parseInt(q.score_kiri);
    const skorKananInput = parseInt(q.score_kanan);

    if (state.timerRunning && !state.winnerName && currentRemainingTime > 0) {
        if (!isNaN(skorKiriInput)) {
             console.log("[SKOR] Input skor kiri:", skorKiriInput);
             state.skorKiri += skorKiriInput;
             stateChanged = true;
        } else if (!isNaN(skorKananInput)) {
             console.log("[SKOR] Input skor kanan:", skorKananInput);
             state.skorKanan += skorKananInput;
             stateChanged = true;
        }
        if (stateChanged) console.log(`[SKOR] Skor diupdate: Kiri=${state.skorKiri}, Kanan=${state.skorKanan}`);
    } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
         console.log("[SKOR] Input skor diabaikan:", { timerRunning: state.timerRunning, winnerName: state.winnerName, currentRemainingTime });
    }

    // --- Pemrosesan Input Nama ---
    if (!state.timerRunning && !state.winnerName) {
        if (q.nama_kiri) { console.log("[NAMA] Update nama kiri:", q.nama_kiri); state.namaKiri = q.nama_kiri; stateChanged = true; }
        if (q.nama_kanan) { console.log("[NAMA] Update nama kanan:", q.nama_kanan); state.namaKanan = q.nama_kanan; stateChanged = true; }
    } else if (q.nama_kiri || q.nama_kanan) {
         console.log("[NAMA] Input nama diabaikan.");
    }

    // --- Logika Timer Control ---
    // START / RESUME
    if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
        console.log("[TIMER] Perintah START/TOGGLE-ON diterima.");
        if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
            state.timerRunning = true;
            state.lastStartTime = now;
            // remainingTime TIDAK diubah saat start/resume
            stateChanged = true;
            console.log("[TIMER] Action: START/RESUME. Sisa sebelum start:", state.remainingTime);
        } else {
             console.log("[TIMER] Action: START/TOGGLE-ON diabaikan.");
        }
    }
    // PAUSE / TOGGLE OFF
    else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
        console.log("[TIMER] Perintah PAUSE/TOGGLE-OFF diterima.");
        if (state.timerRunning && !state.winnerName) {
            state.timerRunning = false;
            // Hitung sisa waktu saat ini dan SIMPAN
            const elapsedSinceStart = now - state.lastStartTime;
            let newRemaining = state.remainingTime; // Default ke nilai lama jika perhitungan gagal
            if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                newRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
            } else {
                 console.error("[TIMER] Gagal menghitung elapsed saat PAUSE:", {now, lastStart: state.lastStartTime, elapsed: elapsedSinceStart});
            }
            state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
            state.lastStartTime = 0; // Reset lastStartTime
            stateChanged = true;
            console.log("[TIMER] Action: PAUSE. Sisa waktu disimpan:", state.remainingTime);
            // Update currentRemainingTime juga setelah pause
            currentRemainingTime = state.remainingTime;
        } else {
            console.log("[TIMER] Action: PAUSE/TOGGLE-OFF diabaikan.");
        }
    }

    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET] Perintah RESET diterima.");
      state = getDefaultState();
      stateChanged = true;
      await kv.del(INPUT_KEY); // Tetap hapus key wasit jika ada sisa
      currentRemainingTime = state.remainingTime;
      console.log("[RESET] State direset ke default.");
    }

    // --- Cek Pemenang ---
    // Update state.remainingTime jika waktu habis saat timer jalan
     if (!state.timerRunning && stateChanged && currentRemainingTime <= 0) {
        if(state.remainingTime > 0) { // Hanya set ke 0 jika sebelumnya belum 0
             state.remainingTime = 0;
             console.log("[TIMER] state.remainingTime diset ke 0 karena waktu habis.");
        }
     }
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG] Pemenang ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             state.timerRunning = false;
             const elapsedSinceStart = now - state.lastStartTime;
             let finalRemaining = state.remainingTime; // Default
              if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                 finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             }
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime;
             console.log("[PEMENANG] Timer dihentikan. Sisa waktu:", state.remainingTime);
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      // Validasi terakhir sebelum simpan
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? state.remainingTime : 0;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
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
