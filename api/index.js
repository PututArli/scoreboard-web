import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang (Disederhanakan untuk fokus ke waktu habis)
function cekPemenang(state, now) {
  // Pastikan state ada
  if (!state) return null;
  // 1. Langsung return jika sudah ada pemenang
  if (state.winnerName) return state.winnerName;

  // 2. Hitung waktu sisa TERKINI
  let currentRemainingTime = state.remainingTime;
  if (state.timerRunning && state.endTime > 0) {
      currentRemainingTime = Math.max(0, state.endTime - now);
  } else if (!state.timerRunning) {
      // Jika tidak running, waktu sisa adalah yg tersimpan
      currentRemainingTime = Math.max(0, state.remainingTime);
  } else {
      currentRemainingTime = 0; // Fallback jika state aneh
  }


  // 3. Cek kondisi menang normal (Skor/Selisih)
  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }

  // 4. Cek Menang/Seri karena Waktu Habis (currentRemainingTime <= 0)
  // Ini dipanggil SETELAH state.timerRunning mungkin di-set false jika waktu habis
  if (currentRemainingTime <= 0 && state.remainingTime <= 0) { // Cek keduanya untuk safety
      console.log("[CEK PEMENANG V9] Waktu habis terdeteksi.");
      if (skorKiri > skorKanan) return state.namaKiri;
      else if (skorKanan > skorKiri) return state.namaKanan;
      else return "SERI";
  }

  // 5. Belum ada pemenang
  return null;
}

// State default (tambah endTime)
const getDefaultState = () => ({
    skorKiri: 0,
    skorKanan: 0,
    namaKiri: "PEMAIN 1",
    namaKanan: "PEMAIN 2",
    timerRunning: false,
    remainingTime: INITIAL_TIME_MS, // Waktu tersimpan saat pause/reset
    endTime: 0, // Timestamp kapan timer akan berakhir JIKA running
    winnerName: null
});


export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`[API V9 ENDTIME] Request: ${req.url}`); // Tambah V9 ENDTIME
  const q = req.query;

  try {
    let state = await kv.get(STATE_KEY);
    // Validasi state awal
    if (!state || typeof state.remainingTime !== 'number' || isNaN(state.remainingTime)) {
      console.log("[API V9] State awal tidak valid/kosong -> Reset ke default.");
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
      state.endTime = parseInt(state.endTime) || 0; // Pastikan endTime ada
      state.winnerName = state.winnerName || null;
    }
    // console.log("[API V9] State AWAL Valid:", JSON.stringify(state));

    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini (currentRemainingTime) berdasarkan endTime ---
    let currentRemainingTime = state.remainingTime; // Default ke waktu tersimpan
    if (state.timerRunning && !state.winnerName && state.endTime > 0) {
         currentRemainingTime = Math.max(0, state.endTime - now); // Hitung sisa waktu TERKINI
         // Jika waktu habis saat timer jalan, update state
         if (currentRemainingTime <= 0 && state.remainingTime > 0) {
             console.log("[TIMER V9] Waktu habis saat timer berjalan.");
             state.timerRunning = false;
             state.remainingTime = 0; // Simpan sisa waktu 0
             state.endTime = 0; // Reset end time
             stateChanged = true;
             currentRemainingTime = 0; // Pastikan current juga 0
         }
    } else if (!state.timerRunning) {
        // Jika tidak running, current sama dengan yg tersimpan
        currentRemainingTime = state.remainingTime;
    }
    // Final check agar tidak NaN / negatif
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? Math.max(0, currentRemainingTime) : 0;
    // console.log(`[TIMER V9] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input (Hanya jika belum ada pemenang) ---
    if (!state.winnerName) {
        // Skor (HANYA jika timer jalan & waktu > 0)
        const skorKiriInput = parseInt(q.score_kiri);
        const skorKananInput = parseInt(q.score_kanan);
        if (state.timerRunning && currentRemainingTime > 0) {
            if (!isNaN(skorKiriInput) && skorKiriInput > 0) {
                 state.skorKiri += skorKiriInput; stateChanged = true;
                 console.log(`[SKOR V9] Kiri +${skorKiriInput} -> ${state.skorKiri}`);
            } else if (!isNaN(skorKananInput) && skorKananInput > 0) {
                 state.skorKanan += skorKananInput; stateChanged = true;
                 console.log(`[SKOR V9] Kanan +${skorKananInput} -> ${state.skorKanan}`);
            }
        } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
             console.log("[SKOR V9] Input skor diabaikan.");
        }

        // Nama (Hanya jika timer TIDAK jalan)
        if (!state.timerRunning) {
            if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
            if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
        }

        // --- Logika Timer Control ---
        // START / RESUME
        if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
            console.log("[TIMER V9] Input: START/TOGGLE-ON");
            // Cek kondisi BUKAN sedang jalan & waktu > 0 & BELUM menang
            if (!state.timerRunning && state.remainingTime > 0 && !state.winnerName) {
                 state.timerRunning = true;
                 // HITUNG endTime BARU berdasarkan sisa waktu terakhir
                 state.endTime = now + state.remainingTime;
                 // state.lastStartTime tidak dipakai lagi
                 stateChanged = true;
                 console.log("  -> Action: START/RESUME. Sisa waktu:", state.remainingTime, "Target End:", new Date(state.endTime));
                 currentRemainingTime = state.remainingTime; // Update current
            } else { console.log("  -> Action: START/TOGGLE-ON diabaikan."); }
        }
        // PAUSE / TOGGLE OFF
        else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
            console.log("[TIMER V9] Input: PAUSE/TOGGLE-OFF");
            if (state.timerRunning && !state.winnerName) { // Hanya pause jika sedang jalan
                state.timerRunning = false;
                // Hitung sisa waktu saat ini MENGGUNAKAN endTime dan SIMPAN ke state.remainingTime
                const newRemaining = state.endTime > 0 ? Math.max(0, state.endTime - now) : state.remainingTime;
                state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0;
                state.endTime = 0; // Reset endTime saat pause
                stateChanged = true;
                console.log("  -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
                currentRemainingTime = state.remainingTime; // Update current time juga
            } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
        }
    } // Akhir blok if (!state.winnerName)


    // --- Logika Reset ---
    if (q.reset_skor) {
      console.log("[RESET V9] Input: reset_skor");
      state = getDefaultState();
      stateChanged = true;
      await kv.del('referee_inputs').catch(err => console.warn("Gagal hapus INPUT_KEY:", err));
      currentRemainingTime = state.remainingTime;
      console.log("  -> Action: State direset.");
    }

    // --- Cek Pemenang (FINAL CHECK) ---
     // Update state jika waktu habis saat timer jalan
     if (state.timerRunning && !state.winnerName && currentRemainingTime <= 0 && state.remainingTime > 0) {
         console.log("[TIMER V9] Waktu terdeteksi habis saat cek akhir.");
         state.timerRunning = false;
         state.remainingTime = 0;
         state.endTime = 0;
         stateChanged = true;
         currentRemainingTime = 0;
     }
    // Panggil cekPemenang dengan state TERBARU dan currentRemainingTime
    const pemenang = cekPemenang(state, currentRemainingTime);
    if (pemenang && !state.winnerName) {
        console.log("[PEMENANG V9] Ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang, hentikan & simpan waktu sisa
        if (state.timerRunning) {
             console.log("  -> Timer sedang jalan -> Hentikan.");
             state.timerRunning = false;
             // Gunakan currentRemainingTime yang sudah dihitung
             state.remainingTime = currentRemainingTime > 0 ? currentRemainingTime : 0;
             state.endTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time
             console.log("  -> Sisa waktu:", state.remainingTime);
        } else if (currentRemainingTime <= 0 && state.remainingTime >= 0) {
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
      state.endTime = parseInt(state.endTime) || 0; // Simpan endTime
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true;
      state.winnerName = state.winnerName || null;
      // Hapus lastStartTime karena tidak dipakai lagi
      delete state.lastStartTime; 

      try {
          await kv.set(STATE_KEY, state);
          console.log("[API V9] State disimpan:", JSON.stringify(state));
      } catch (kvError) {
           console.error("[API V9] Gagal menyimpan state ke KV:", kvError);
           return res.status(500).json({ error: 'KV Set Error', details: kvError.message });
      }
    }

    // --- Kirim Respons ---
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    // Kirim state TANPA lastStartTime, TAPI DENGAN endTime JIKA running
    const responseState = {
        skorKiri: state.skorKiri,
        skorKanan: state.skorKanan,
        namaKiri: state.namaKiri,
        namaKanan: state.namaKanan,
        timerRunning: state.timerRunning,
        remainingTime: state.remainingTime, // Waktu tersimpan saat pause/reset
        endTime: state.timerRunning ? state.endTime : 0, // Kirim endTime hanya jika running
        winnerName: state.winnerName,
        currentRemainingTime: finalCurrentRemaining // Waktu sisa TERKINI (untuk fallback)
     };
    const handlerEndTime = Date.now();
    // console.log(`[API V9] Mengirim respons (${handlerEndTime - handlerStartTime}ms):`, JSON.stringify(responseState));
    return res.status(200).json(responseState);

  } catch (error) {
    console.error("[API V9] Error Handler:", error);
     try {
         const defaultState = getDefaultState();
         console.log("[API V9] Mengirim fallback state karena error.");
         return res.status(500).json({ ...defaultState, currentRemainingTime: defaultState.remainingTime, error: 'Internal Server Error (fallback)', details: error.message });
     } catch (fallbackError) {
         console.error("[API V9] Error saat mengirim fallback state:", fallbackError);
         return res.status(500).send('Internal Server Error');
     }
  }
}
