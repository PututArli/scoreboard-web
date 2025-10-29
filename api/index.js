import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state'; // Kembali ke key Vercel
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state, currentRemainingTime) {
  // Pastikan state ada
  if (!state) return null;
  if (state.winnerName) return state.winnerName;

  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  const remaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime) && currentRemainingTime >= 0) ? currentRemainingTime : 0;

  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }
  // Cek waktu habis hanya jika timer TIDAK jalan & waktu <= 0
  // Gunakan state.remainingTime (waktu tersimpan)
  if (!state.timerRunning && state.remainingTime <= 0) {
      console.log("[CEK PEMENANG V6] Waktu habis terdeteksi (timer stop, remaining <= 0).");
      if (skorKiri > skorKanan) return state.namaKiri;
      else if (skorKanan > skorKiri) return state.namaKanan;
      else return "SERI";
  }
   // Cek juga jika currentRemainingTime habis saat timer JALAN
   if (remaining <= 0 && state.remainingTime > 0 && state.timerRunning) {
        console.log("[CEK PEMENANG V6] Waktu habis terdeteksi (currentRemaining <= 0 saat running).");
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
    remainingTime: INITIAL_TIME_MS, // Waktu tersimpan saat pause/reset
    lastStartTime: 0, // Kapan terakhir start/resume
    winnerName: null
});


export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`[API V6 RESUME] Request: ${req.url}`);
  const q = req.query;

  try {
    let state = await kv.get(STATE_KEY);
    // Validasi state awal
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API V6] State awal tidak valid/kosong -> Reset ke default.");
      state = getDefaultState();
      await kv.set(STATE_KEY, state);
    } else {
      // Pastikan semua field ada & valid
      state = { ...getDefaultState(), ...state };
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true;
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.max(0, state.remainingTime) : INITIAL_TIME_MS;
      if (!state.timerRunning) state.remainingTime = Math.min(INITIAL_TIME_MS, state.remainingTime);
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    // console.log("[API V6] State AWAL Valid:", JSON.stringify(state));

    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini (currentRemainingTime) ---
    let currentRemainingTime = state.remainingTime; // Ambil waktu tersimpan
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart); // Hitung sisa waktu TERKINI
         // Jika waktu habis saat timer jalan, update state di bawah (di cek pemenang)
    }
    // Final check agar tidak NaN / negatif
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? Math.max(0, currentRemainingTime) : 0;
    // console.log(`[TIMER V6] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input (Hanya jika belum ada pemenang) ---
    if (!state.winnerName) {
        // Skor (HANYA jika timer jalan & waktu > 0)
        const skorKiriInput = parseInt(q.score_kiri);
        const skorKananInput = parseInt(q.score_kanan);
        if (state.timerRunning && currentRemainingTime > 0) {
            if (!isNaN(skorKiriInput) && skorKiriInput > 0) {
                 state.skorKiri += skorKiriInput; stateChanged = true;
                 console.log(`[SKOR V6] Kiri +${skorKiriInput} -> ${state.skorKiri}`);
            } else if (!isNaN(skorKananInput) && skorKananInput > 0) {
                 state.skorKanan += skorKananInput; stateChanged = true;
                 console.log(`[SKOR V6] Kanan +${skorKananInput} -> ${state.skorKanan}`);
            }
        } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
             console.log("[SKOR V6] Input skor diabaikan.");
        }

        // Nama (Hanya jika timer TIDAK jalan)
        if (!state.timerRunning) {
            if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
            if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
        }

        // --- Logika Timer Control (KEMBALIKAN RESUME) ---
        // START / RESUME (Toggle ON)
        if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
            console.log("[TIMER V6] Input: START/TOGGLE-ON");
            // Cek kondisi BUKAN sedang jalan & waktu > 0 & BELUM menang
            if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
                 state.timerRunning = true;
                 state.lastStartTime = now; // Catat waktu mulai/lanjut
                 // state.remainingTime TIDAK diubah saat start/resume
                 stateChanged = true;
                 console.log("  -> Action: START/RESUME. Sisa waktu:", state.remainingTime);
                 currentRemainingTime = state.remainingTime; // Update current agar konsisten
            } else { console.log("  -> Action: START/TOGGLE-ON diabaikan."); }
        }
        // PAUSE / TOGGLE OFF
        else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
            console.log("[TIMER V6] Input: PAUSE/TOGGLE-OFF");
            if (state.timerRunning && !state.winnerName) { // Hanya pause jika sedang jalan
                state.timerRunning = false;
                // Hitung sisa waktu saat ini MENGGUNAKAN currentRemainingTime dan SIMPAN
                state.remainingTime = currentRemainingTime;
                state.lastStartTime = 0; // Reset lastStartTime
                stateChanged = true;
                console.log("  -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
                // currentRemainingTime sudah benar
            } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
        }
    } // Akhir blok if (!state.winnerName)


    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET V6] Input: reset_skor");
      state = getDefaultState();
      stateChanged = true;
      await kv.del('referee_inputs').catch(err => console.warn("Gagal hapus INPUT_KEY:", err));
      currentRemainingTime = state.remainingTime;
      console.log("  -> Action: State direset.");
    }

    // --- Cek Pemenang (FINAL CHECK) ---
     // Update state jika waktu habis saat timer jalan
     if (state.timerRunning && !state.winnerName && currentRemainingTime <= 0 && state.remainingTime > 0) {
         console.log("[TIMER V6] Waktu terdeteksi habis saat cek akhir.");
         state.timerRunning = false;
         state.remainingTime = 0;
         state.lastStartTime = 0;
         stateChanged = true; // Tandai perubahan
         currentRemainingTime = 0; // Pastikan current juga 0
     }
    // Panggil cekPemenang dengan state TERBARU dan currentRemainingTime
    const pemenang = cekPemenang(state, currentRemainingTime);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG V6] Ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             console.log("  -> Timer sedang jalan -> Hentikan.");
             state.timerRunning = false;
             // Gunakan currentRemainingTime yang sudah dihitung
             state.remainingTime = currentRemainingTime > 0 ? currentRemainingTime : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time
             console.log("  -> Sisa waktu:", state.remainingTime);
        } else if (currentRemainingTime <= 0 && state.remainingTime >= 0) { // >= 0 agar kondisi reset tercakup
             // Pastikan remainingTime 0 jika menang karena waktu habis
             if (state.remainingTime !== 0) {
                 console.log("  -> Menang karena waktu habis, pastikan remainingTime = 0.");
                 state.remainingTime = 0;
             }
        }
        stateChanged = true;
    }

    // --- Simpan State jika Berubah ---
    if (stateChanged) {
      // Validasi terakhir sebelum simpan
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.max(0, Math.min(INITIAL_TIME_MS, state.remainingTime)) : 0;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true;
      state.winnerName = state.winnerName || null;

      try {
          await kv.set(STATE_KEY, state);
          // console.log("[API V6] State disimpan:", JSON.stringify(state));
      } catch (kvError) {
           console.error("[API V6] Gagal menyimpan state ke KV:", kvError);
           return res.status(500).json({ error: 'KV Set Error', details: kvError.message });
      }
    }

    // --- Kirim Respons ---
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    const responseState = {
        skorKiri: state.skorKiri,
        skorKanan: state.skorKanan,
        namaKiri: state.namaKiri,
        namaKanan: state.namaKanan,
        timerRunning: state.timerRunning,
        remainingTime: state.remainingTime, // Waktu tersimpan (saat pause/reset)
        lastStartTime: state.lastStartTime, // Kapan terakhir start/resume (PENTING untuk client)
        winnerName: state.winnerName,
        currentRemainingTime: finalCurrentRemaining // Waktu sisa TERKINI
     };
    const handlerEndTime = Date.now();
    // console.log(`[API V6] Mengirim respons (${handlerEndTime - handlerStartTime}ms):`, JSON.stringify(responseState));
    return res.status(200).json(responseState);

  } catch (error) {
    console.error("[API V6] Error Handler:", error);
     try {
         const defaultState = getDefaultState();
         console.log("[API V6] Mengirim fallback state karena error.");
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         console.error("[API V6] Error saat mengirim fallback state:", fallbackError);
         return res.status(500).send('Internal Server Error');
     }
  }
}
