import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const WAKTU_PERTANDINGAN_DETIK = 180;

export default async function handler(request, response) {
  try {
    // 1. AMBIL DATA SAAT INI
    let data = await kv.get('scoreboard-state');
    if (!data) {
      data = {
        skorKiri: 0,
        skorKanan: 0,
        sisaWaktu: WAKTU_PERTANDINGAN_DETIK,
        timerRunning: false,
        lastStartedAt: 0,
        waktuSaatPause: WAKTU_PERTANDINGAN_DETIK,
      };
    }

    // --- PERBAIKAN BUG 1: LOGIKA TIMER DIPINDAH KE ATAS ---
    // Logika ini sekarang berjalan SETIAP request (dari web atau remote)
    
    let selisih = Math.abs(data.skorKiri - data.skorKanan);
    let gameIsOver = (selisih >= 8) || (data.sisaWaktu <= 0);

    // Hitung ulang sisa waktu JIKA timer sedang berjalan
    if (data.timerRunning && !gameIsOver) {
      const waktuBerjalanDetik = Math.floor((Date.now() - data.lastStartedAt) / 1000);
      data.sisaWaktu = data.waktuSaatPause - waktuBerjalanDetik;

      // Cek ulang kondisi menang setelah waktu dihitung
      selisih = Math.abs(data.skorKiri - data.skorKanan);
      
      if (selisih >= 8) { // Menang selisih 8
        data.timerRunning = false; 
        gameIsOver = true;
      } else if (data.sisaWaktu <= 0) { // Waktu habis
        data.sisaWaktu = 0;
        data.timerRunning = false; 
        gameIsOver = true;
      }
    } else if (gameIsOver && data.timerRunning) {
      // Jika game berakhir (misal selisih 8) tapi timer masih 'true', matikan.
      data.timerRunning = false;
    }
    // --- AKHIR PERBAIKAN BUG 1 ---


    // 2. PROSES PERINTAH DARI REMOTE (JIKA ADA)
    const { score_kiri, score_kanan, reset_kiri, timer } = request.query;

    // A. Perintah RESET (Tombol 7 Tahan)
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
    
    // B. Perintah TIMER (Tombol 7 Klik)
    else if (timer && timer === 'toggle') {
      // Cek ulang 'gameIsOver' terbaru SEBELUM toggle
      selisih = Math.abs(data.skorKiri - data.skorKanan);
      gameIsOver = (selisih >= 8) || (data.sisaWaktu <= 0);

      if (!data.timerRunning && data.sisaWaktu > 0 && !gameIsOver) {
        // --- START TIMER ---
        data.timerRunning = true;
        data.lastStartedAt = Date.now(); 
      } else if (data.timerRunning) {
        // --- PAUSE TIMER ---
        data.timerRunning = false;
        const waktuBerjalanDetik = Math.floor((Date.now() - data.lastStartedAt) / 1000);
        const sisaWaktuBaru = data.waktuSaatPause - waktuBerjalanDetik;
        
        data.sisaWaktu = Math.max(0, sisaWaktuBaru);
        data.waktuSaatPause = data.sisaWaktu; 
      }
    }
    
    // C. Perintah SKOR (Tombol 1-6)
    // Fitur 2: Hanya menambah skor jika timer berjalan DAN game belum berakhir
    else if (data.timerRunning && !gameIsOver) {
      if (score_kiri) {
        data.skorKiri += parseInt(score_kiri, 10);
      }
      if (score_kanan) {
        data.skorKanan += parseInt(score_kanan, 10);
      }

      // Cek selisih 8 SETELAH menambah skor
      const selisihBaru = Math.abs(data.skorKiri - data.skorKanan);
      if (selisihBaru >= 8) {
          data.timerRunning = false;
          gameIsOver = true; 
      }
    }

    // 3. SIMPAN DATA BARU
    await kv.set('scoreboard-state', data);

    // 4. KIRIM BALASAN
    response.status(200).json(data);

  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Gagal memproses permintaan' });
  }
}
