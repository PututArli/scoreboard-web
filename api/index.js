import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang
function cekPemenang(state, currentRemainingTime) {
  if (state.winnerName) return state.winnerName;
  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  const remaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0;
  
  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }
  // Cek waktu habis HANYA jika timer TIDAK jalan & waktu <= 0
  if (!state.timerRunning && remaining <= 0) {
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
    remainingTime: INITIAL_TIME_MS, // Selalu mulai dari 3 menit
    lastStartTime: 0, 
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
      // Simpan state default SEGERA jika tidak valid
      await kv.set(STATE_KEY, state); 
    } else {
      // Pastikan semua field ada & valid (gabungkan dengan default)
      state = { ...getDefaultState(), ...state }; 
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true; 
      // Pastikan remainingTime valid dan tidak negatif
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.max(0, state.remainingTime) : INITIAL_TIME_MS;
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    console.log("[API] State AWAL Valid:", JSON.stringify(state));

    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini (currentRemainingTime) ---
    let currentRemainingTime = state.remainingTime; 
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         // Hitung sisa waktu TERKINI berdasarkan waktu tersimpan DIKURANGI waktu berlalu
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart);
         // Jika waktu habis saat timer jalan, update state di bawah (di cek pemenang)
    }
    // Final check agar tidak NaN / negatif
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? Math.max(0, currentRemainingTime) : 0;
    // console.log(`[TIMER] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input (Hanya jika belum ada pemenang) ---
    if (!state.winnerName) {
        // Skor (HANYA jika timer jalan & waktu > 0)
        const skorKiriInput = parseInt(q.score_kiri);
        const skorKananInput = parseInt(q.score_kanan);
        // PERBAIKAN: Gunakan currentRemainingTime untuk cek kondisi skor
        if (state.timerRunning && currentRemainingTime > 0) { 
            if (!isNaN(skorKiriInput) && skorKiriInput > 0) {
                 state.skorKiri += skorKiriInput; stateChanged = true;
                 console.log(`[SKOR] Kiri +${skorKiriInput} -> ${state.skorKiri}`);
            } else if (!isNaN(skorKananInput) && skorKananInput > 0) {
                 state.skorKanan += skorKananInput; stateChanged = true;
                 console.log(`[SKOR] Kanan +${skorKananInput} -> ${state.skorKanan}`);
            }
        } else if (!isNaN(skorKiriInput) || !isNaN(skorKananInput)) {
             console.log("[SKOR] Input skor diabaikan (timer off / waktu habis).");
        }

        // Nama (Hanya jika timer TIDAK jalan)
        if (!state.timerRunning) {
            if (q.nama_kiri) { state.namaKiri = q.nama_kiri; stateChanged = true; }
            if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }
        }

        // --- Logika Timer Control ---
        // START / RESUME
        if (q.start_timer || (q.toggle_timer && !state.timerRunning)) {
            console.log("[TIMER] Input: START/TOGGLE-ON");
            // Cek lagi kondisi waktu tersisa > 0
            // PERBAIKAN: Gunakan state.remainingTime (waktu tersimpan) untuk cek kondisi > 0
            if (!state.timerRunning && state.remainingTime > 0) { 
                state.timerRunning = true;
                state.lastStartTime = now; // Catat waktu mulai/lanjut
                // state.remainingTime TIDAK diubah saat start/resume
                stateChanged = true;
                console.log("  -> Action: START/RESUME. Sisa sebelum:", state.remainingTime);
            } else { console.log("  -> Action: START/TOGGLE-ON diabaikan."); }
        }
        // PAUSE / TOGGLE OFF
        else if (q.stop_timer || (q.toggle_timer && state.timerRunning)) {
            console.log("[TIMER] Input: PAUSE/TOGGLE-OFF");
            if (state.timerRunning) {
                state.timerRunning = false;
                // Hitung sisa waktu saat ini MENGGUNAKAN currentRemainingTime yang sudah dihitung di awal
                const newRemaining = currentRemainingTime; 
                state.remainingTime = (typeof newRemaining === 'number' && !isNaN(newRemaining)) ? newRemaining : 0; // Simpan sisa waktu
                state.lastStartTime = 0; // Reset lastStartTime
                stateChanged = true;
                console.log("  -> Action: PAUSE. Sisa disimpan:", state.remainingTime);
                // currentRemainingTime sudah benar, tidak perlu diupdate lagi di sini
            } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
        }
    } // Akhir blok if (!state.winnerName)


    // --- Logika Reset (bisa kapan saja) ---
    if (q.reset_skor) {
      console.log("[RESET] Input: reset_skor");
      state = getDefaultState(); // Reset state total
      stateChanged = true;
      await kv.del('referee_inputs').catch(err => console.warn("Gagal hapus INPUT_KEY:", err)); 
      currentRemainingTime = state.remainingTime; // Update current time
      console.log("  -> Action: State direset.");
    }

    // --- Cek Pemenang (FINAL CHECK setelah semua input diproses) ---
    // Gunakan currentRemainingTime TERBARU untuk cek pemenang
    const pemenang = cekPemenang(state, currentRemainingTime); 
    if (pemenang && !state.winnerName) { // Hanya set jika BELUM ADA pemenang sebelumnya
        console.log("[PEMENANG] Final Check Ditemukan:", pemenang);
        state.winnerName = pemenang;
        // Jika timer masih jalan saat menang (skor/selisih), hentikan & simpan waktu sisa
        if (state.timerRunning) {
             console.log("  -> Timer sedang jalan saat pemenang ditemukan, menghentikan...");
             state.timerRunning = false;
             // Hitung sisa waktu terakhir MENGGUNAKAN currentRemainingTime
             state.remainingTime = currentRemainingTime > 0 ? currentRemainingTime : 0; 
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time juga
             console.log("  -> Timer dihentikan. Sisa waktu:", state.remainingTime);
        } else if (currentRemainingTime <= 0) { // Jika menang karena waktu habis
             // Pastikan state.remainingTime juga 0
             if (state.remainingTime !== 0) {
                  console.log("  -> Menang karena waktu habis, pastikan remainingTime = 0.");
                  state.remainingTime = 0;
             }
        }
        stateChanged = true; // Tandai ada perubahan state pemenang
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
          console.log("[API] State disimpan:", JSON.stringify(state));
      } catch (kvError) {
           console.error("[API] Gagal menyimpan state ke KV:", kvError);
           return res.status(500).json({ error: 'KV Set Error', details: kvError.message });
      }
    }

    // --- Kirim Respons ---
    // Pastikan currentRemainingTime yang dikirim valid
    const finalCurrentRemaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : (state.remainingTime ?? 0);
    // Buat objek respons baru
    const responseState = { 
        skorKiri: state.skorKiri,
        skorKanan: state.skorKanan,
        namaKiri: state.namaKiri,
        namaKanan: state.namaKanan,
        timerRunning: state.timerRunning,
        remainingTime: state.remainingTime, // Waktu tersimpan (saat pause/reset)
        lastStartTime: state.lastStartTime, // Kapan terakhir start/resume
        winnerName: state.winnerName,
        currentRemainingTime: finalCurrentRemaining // Waktu sisa TERKINI
     };
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
