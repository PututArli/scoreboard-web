// Menggunakan Vercel KV (database) untuk menyimpan state
import { kv } from '@vercel/kv';

// Nama key untuk database
const DB_KEY = 'scoreboard_state';

// Handler utama untuk semua request API
export default async function handler(req, res) {
  try {
    // 1. Ambil state terakhir dari database, atau buat state baru jika kosong
    let state = await kv.get(DB_KEY);
    if (!state) {
      state = {
        skorKiri: 0,
        skorKanan: 0,
        namaKiri: "PEMAIN 1",
        namaKanan: "PEMAIN 2",
        timerRunning: false,  // Apakah timer sedang berjalan?
        elapsedTime: 0,     // Total waktu berjalan (dalam md)
        lastStartTime: 0    // Waktu kapan terakhir di-play
      };
    }

    const q = req.query;
    let stateChanged = false; // Tandai jika ada perubahan

    // 2. Logika untuk memproses perintah dari ESP32 atau Web
    
    // Skor Kiri
    if (q.score_kiri) {
      state.skorKiri += parseInt(q.score_kiri);
      stateChanged = true;
    }
    // Skor Kanan
    if (q.score_kanan) {
      state.skorKanan += parseInt(q.score_kanan);
      stateChanged = true;
    }
    // Reset
    if (q.reset_kiri || q.reset_skor) {
      state.skorKiri = 0;
      state.skorKanan = 0;
      state.elapsedTime = 0;
      state.timerRunning = false;
      state.lastStartTime = 0;
      stateChanged = true;
    }
    // Start Timer
    if (q.start_timer) {
      if (!state.timerRunning) { // Hanya start jika sedang tidak jalan
        state.timerRunning = true;
        state.lastStartTime = Date.now();
        stateChanged = true;
      }
    }
    // Stop Timer
    if (q.stop_timer) {
      if (state.timerRunning) { // Hanya stop jika sedang jalan
        state.timerRunning = false;
        // Simpan sisa waktu
        state.elapsedTime += (Date.now() - state.lastStartTime);
        stateChanged = true;
      }
    }
    // Update Nama
    if (q.nama_kiri)  { state.namaKiri = q.nama_kiri; stateChanged = true; }
    if (q.nama_kanan) { state.namaKanan = q.nama_kanan; stateChanged = true; }


    // 3. Simpan state baru ke database jika ada perubahan
    if (stateChanged) {
      await kv.set(DB_KEY, state);
    }

    // 4. Kirim state terbaru sebagai balasan
    // Ini penting agar frontend bisa update
    return res.status(200).json(state);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}