import { kv } from '@vercel/kv';

const DB_KEY = 'scoreboard_state';

// Fungsi untuk mengecek pemenang
function cekPemenang(state) {
  // Jika sudah ada pemenang, tidak perlu dicek lagi
  if (state.winnerName) return state.winnerName;

  const selisih = Math.abs(state.skorKiri - state.skorKanan);

  // Aturan 1: Menang poin 10
  if (state.skorKiri >= 10) return state.namaKiri;
  if (state.skorKanan >= 10) return state.namaKanan;

  // Aturan 2: Menang selisih 8
  if (selisih >= 8) {
    return state.skorKiri > state.skorKanan ? state.namaKiri : state.namaKanan;
  }

  return null; // Tidak ada pemenang
}

export default async function handler(req, res) {
  try {
    let state = await kv.get(DB_KEY);
    if (!state) {
      state = {
        skorKiri: 0,
        skorKanan: 0,
        namaKiri: "PEMAIN 1",
        namaKanan: "PEMAIN 2",
        timerRunning: false,
        elapsedTime: 0,
        lastStartTime: 0,
        winnerName: null // Status pemenang baru
      };
    }

    const q = req.query;
    let stateChanged = false;

    // --- Logika Input ---
    // Hanya proses jika tidak ada pemenang
    if (!state.winnerName) {
      if (q.score_kiri) {
        state.skorKiri += parseInt(q.score_kiri);
        stateChanged = true;
      }
      if (q.score_kanan) {
        state.skorKanan += parseInt(q.score_kanan);
        stateChanged = true;
      }
      if (q.nama_kiri) {
        state.namaKiri = q.nama_kiri;
        stateChanged = true;
      }
      if (q.nama_kanan) {
        state.namaKanan = q.nama_kanan;
        stateChanged = true;
      }

      // --- Logika Timer ---
      // PERUBAHAN: Tombol Start
      if (q.start_timer) {
        if (!state.timerRunning) {
          state.timerRunning = true;
          state.lastStartTime = Date.now();
          stateChanged = true;
        }
      }
      // PERUBAHAN: Tombol Stop
      if (q.stop_timer) {
        if (state.timerRunning) {
          state.timerRunning = false;
          state.elapsedTime += (Date.now() - state.lastStartTime);
          stateChanged = true;
        }
      }
      // BARU: Logika Toggle Timer (untuk ESP32)
      if (q.toggle_timer) {
        if (state.timerRunning) {
          // Jika sedang jalan -> STOP
          state.timerRunning = false;
          state.elapsedTime += (Date.now() - state.lastStartTime);
        } else {
          // Jika sedang mati -> START
          state.timerRunning = true;
          state.lastStartTime = Date.now();
        }
        stateChanged = true;
      }
    }

    // --- Logika Reset ---
    // Reset bisa dilakukan kapan saja
    if (q.reset_skor) {
      state.skorKiri = 0;
      state.skorKanan = 0;
      state.elapsedTime = 0;
      state.timerRunning = false;
      state.lastStartTime = 0;
      state.winnerName = null; // Reset pemenang
      stateChanged = true;
    }

    // --- Cek Pemenang (Setelah update skor) ---
    const pemenang = cekPemenang(state);
    if (pemenang && !state.winnerName) {
      state.winnerName = pemenang;
      // Otomatis stop timer jika ada pemenang
      if (state.timerRunning) {
        state.timerRunning = false;
        state.elapsedTime += (Date.now() - state.lastStartTime);
      }
      stateChanged = true;
    }

    if (stateChanged) {
      await kv.set(DB_KEY, state);
    }

    return res.status(200).json(state);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
