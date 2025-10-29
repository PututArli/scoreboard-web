// Import library Vercel KV (Penyimpanan)
import { createClient } from '@vercel/kv';

// Buat koneksi ke Vercel KV
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Waktu tanding default (3 menit)
const WAKTU_PERTANDINGAN_DETIK = 180;

// Ini adalah fungsi utama server Anda
export default async function handler(request, response) {
  try {
    // 1. AMBIL DATA SAAT INI DARI PENYIMPANAN
    // ------------------------------------------------
    let data = await kv.get('scoreboard-state');

    // Jika data tidak ada (pertama kali dijalankan), buat data baru
    if (!data) {
      data = {
        skorKiri: 0,
        skorKanan: 0,
        sisaWaktu: WAKTU_PERTANDINGAN_DETIK,
        timerRunning: false, // Timer tidak berjalan
        lastStartedAt: 0,    // Kapan terakhir timer dinyalakan
        waktuSaatPause: WAKTU_PERTANDINGAN_DETIK, // Untuk menyimpan sisa waktu saat di-pause
      };
    }

    // 2. PROSES PERINTAH DARI REMOTE (Query Parameters)
    // ------------------------------------------------
    // Perhatikan: 'timer' sekarang menangani 'toggle'
    const { score_kiri, score_kanan, reset_kiri, timer } = request.query;

    let gameIsOver = false;

    // Cek dulu apakah game sudah berakhir (karena selisih 8 atau waktu habis)
    const selisih = Math.abs(data.skorKiri - data.skorKanan);
    if (selisih >= 8 || data.sisaWaktu <= 0) {
      gameIsOver = true;
    }

    // A. Perintah RESET (Tombol ke-7 di remote, TAHAN 3 DETIK)
    if (reset_kiri && reset_kiri === '1') {
      data = {
        skorKiri: 0,
        skorKanan: 0,
        sisaWaktu: WAKTU_PERTANDINGAN_DETIK,
        timerRunning: false,
        lastStartedAt: 0,
        waktuSaatPause: WAKTU_PERTANDINGAN_DETIK,
      };
      gameIsOver = false;
    }

    // B. Perintah TIMER (Tombol ke-7 di remote, KLIK CEPAT)
    else if (timer && timer === 'toggle') {
      if (!data.timerRunning && data.sisaWaktu > 0 && !gameIsOver) {
        // --- START TIMER ---
        data.timerRunning = true;
        data.lastStartedAt = Date.now(); // Catat waktu 'sekarang'
      } else if (data.timerRunning) {
        // --- PAUSE TIMER ---
        data.timerRunning = false;
        const waktuBerjalanDetik = Math.floor((Date.now() - data.lastStartedAt) / 1000);
        const sisaWaktuBaru = data.waktuSaatPause - waktuBerjalanDetik;
        
        data.sisaWaktu = Math.max(0, sisaWaktuBaru);
        data.waktuSaatPause = data.sisaWaktu; // Simpan sisa waktu saat ini
      }
    }

    // C. Perintah SKOR (Tombol 1-6 di remote)
    // Fitur 2: Hanya menambah skor jika timer berjalan DAN game belum berakhir
    else if (data.timerRunning && !gameIsOver) {
      if (score_kiri) {
        data.skorKiri += parseInt(score_kiri, 10);
      }
      if (score_kanan) {
        data.skorKanan += parseInt(score_kanan, 10);
      }
    }

    // 3. HITUNG ULANG STATUS SETELAH PERINTAH
    // ------------------------------------------------
    
    // Hitung ulang sisa waktu jika timer sedang berjalan
    if (data.timerRunning) {
      const waktuBerjalanDetik = Math.floor((Date.now() - data.lastStartedAt) / 1000);
      data.sisaWaktu = data.waktuSaatPause - waktuBerjalanDetik;

      // Fitur 3 & 4: Cek kondisi menang saat timer berjalan
      const selisihBaru = Math.abs(data.skorKiri - data.skorKanan);
      
      if (selisihBaru >= 8) { // Menang selisih 8
        data.timerRunning = false; // Hentikan timer
        gameIsOver = true;
      } else if (data.sisaWaktu <= 0) { // Waktu habis
        data.sisaWaktu = 0;
        data.timerRunning = false; // Hentikan timer
        gameIsOver = true;
      }
    }

    // 4. SIMPAN DATA BARU KE PENYIMPANAN
    // ------------------------------------------------
    await kv.set('scoreboard-state', data);

    // 5. KIRIM BALASAN KE BROWSER (atau remote)
    // ------------------------------------------------
    response.status(200).json(data);

  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Gagal memproses permintaan' });
  }
}
