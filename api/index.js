import { kv } from '@vercel/kv';

const STATE_KEY = 'scoreboard_state';
const INITIAL_TIME_MS = 180 * 1000; // 3 menit

// Fungsi cek pemenang (FINAL - termasuk cek waktu habis yg lebih eksplisit)
function cekPemenang(state, currentRemainingTime) {
  // 0. Validasi Input (ekstra paranoid)
  const skorKiri = parseInt(state.skorKiri) || 0;
  const skorKanan = parseInt(state.skorKanan) || 0;
  const remaining = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? currentRemainingTime : 0;
  
  // 1. Return jika sudah ada pemenang
  if (state.winnerName) return state.winnerName; 

  // 2. Cek Menang Skor / Selisih
  const selisih = Math.abs(skorKiri - skorKanan);
  if (skorKiri >= 10) return state.namaKiri;
  if (skorKanan >= 10) return state.namaKanan;
  if (selisih >= 8 && (skorKiri > 0 || skorKanan > 0)) {
    return skorKiri > skorKanan ? state.namaKiri : state.namaKanan;
  }

  // 3. Cek Menang/Seri karena Waktu Habis (remaining <= 0)
  // Ini hanya relevan jika belum ada pemenang dari skor/selisih
  if (remaining <= 0) {
      console.log("[CEK PEMENANG] Waktu habis terdeteksi.");
      if (skorKiri > skorKanan) return state.namaKiri;
      else if (skorKanan > skorKiri) return state.namaKanan;
      else return "SERI"; // Skor sama saat waktu habis
  }

  // 4. Jika semua kondisi tidak terpenuhi
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
      // Pastikan semua field ada & valid (gabungkan dengan default)
      state = { ...getDefaultState(), ...state }; 
      state.skorKiri = parseInt(state.skorKiri) || 0;
      state.skorKanan = parseInt(state.skorKanan) || 0;
      state.timerRunning = state.timerRunning === true;
      state.remainingTime = (typeof state.remainingTime === 'number' && !isNaN(state.remainingTime)) ? Math.max(0, state.remainingTime) : INITIAL_TIME_MS; // Pastikan >= 0
      state.lastStartTime = parseInt(state.lastStartTime) || 0;
      state.winnerName = state.winnerName || null;
    }
    // console.log("[API] State AWAL:", JSON.stringify(state));

    let stateChanged = false;
    const now = Date.now();

    // --- Hitung Sisa Waktu Saat Ini (currentRemainingTime) ---
    // Variabel ini HANYA untuk perhitungan & dikirim ke client, TIDAK disimpan permanen di state KV
    let currentRemainingTime = state.remainingTime; // Ambil waktu tersimpan (saat pause/reset)
    if (state.timerRunning && !state.winnerName && state.lastStartTime > 0) {
         const elapsedSinceStart = now - state.lastStartTime;
         currentRemainingTime = Math.max(0, state.remainingTime - elapsedSinceStart); // Hitung sisa waktu TERKINI
         // PENTING: Jangan ubah state.remainingTime di sini, biarkan PAUSE/STOP/RESET yg mengubahnya
         // Cek jika waktu habis saat sedang berjalan
         if (currentRemainingTime <= 0 && state.remainingTime > 0) { 
             console.log("[TIMER] Waktu habis saat timer berjalan (terdeteksi saat hitung current).");
             // Langsung set timerRunning = false agar cek pemenang bisa mendeteksi kondisi waktu habis
             state.timerRunning = false; 
             state.remainingTime = 0; // Simpan sisa waktu 0
             state.lastStartTime = 0; // Reset last start time
             stateChanged = true; 
             currentRemainingTime = 0; // Pastikan current juga 0
         }
    }
    // Final check agar tidak NaN / negatif
    currentRemainingTime = (typeof currentRemainingTime === 'number' && !isNaN(currentRemainingTime)) ? Math.max(0, currentRemainingTime) : 0;
    // console.log(`[TIMER] CurrentRemainingTime dihitung: ${currentRemainingTime}`);


    // --- Pemrosesan Input (Hanya jika belum ada pemenang) ---
    if (!state.winnerName) {
        // Skor (HANYA jika timer jalan & waktu > 0)
        const skorKiriInput = parseInt(q.score_kiri);
        const skorKananInput = parseInt(q.score_kanan);
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
            if (!state.timerRunning && state.remainingTime > 0) { 
                state.timerRunning = true;
                state.lastStartTime = now;
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
                currentRemainingTime = state.remainingTime; // Update current time agar konsisten
            } else { console.log("  -> Action: PAUSE/TOGGLE-OFF diabaikan."); }
        }
    } // Akhir blok if (!state.winnerName)


    // --- Logika Reset (bisa kapan saja) ---
    if (q.reset_skor) {
      console.log("[RESET] Input: reset_skor");
      state = getDefaultState(); // Reset state total
      stateChanged = true;
      // Hapus key wasit lama jika ada
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
             const elapsedSinceStart = now - state.lastStartTime;
             let finalRemaining = state.remainingTime;
              if (state.lastStartTime > 0 && typeof elapsedSinceStart === 'number' && !isNaN(elapsedSinceStart)) {
                 finalRemaining = Math.max(0, state.remainingTime - elapsedSinceStart);
             }
             state.remainingTime = (typeof finalRemaining === 'number' && !isNaN(finalRemaining)) ? finalRemaining : 0;
             state.lastStartTime = 0;
             currentRemainingTime = state.remainingTime; // Update current time
             console.log("  -> Timer dihentikan. Sisa waktu:", state.remainingTime);
        } else if (currentRemainingTime <= 0 && state.remainingTime > 0) {
             // Jika menang karena waktu habis (current <= 0), pastikan state.remainingTime juga 0
             console.log("  -> Menang karena waktu habis, pastikan remainingTime = 0.");
             state.remainingTime = 0;
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
      state.winnerName = state.winnerName || null; // Pastikan null jika tidak ada

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
    // Buat objek respons baru agar tidak mengirim state internal
    const responseState = { 
        skorKiri: state.skorKiri,
        skorKanan: state.skorKanan,
        namaKiri: state.namaKiri,
        namaKanan: state.namaKanan,
        timerRunning: state.timerRunning,
        remainingTime: state.remainingTime, // Waktu tersimpan (saat pause)
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
