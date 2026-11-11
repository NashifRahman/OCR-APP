const sharp = require("sharp");
const fs = require("fs");

/**
 * Fungsi untuk menggambar kotak merah pada koordinat kata yang salah
 * @param {string} inputImagePath - Path gambar asli yang di-scan
 * @param {Array} listBboxSalah - Array objek bbox [{x0, y0, x1, y1}, ...]
 * @param {string} outputImagePath - Path untuk menyimpan gambar hasil anotasi
 */

async function Gambar(inputImagePath, listBboxSalah, outputImagePath) {
 try {
    if (!listBboxSalah || listBboxSalah.length === 0) {
      console.log("[Anotasi] Tidak ada kata salah. Menyalin gambar asli...");
      fs.copyFileSync(inputImagePath, outputImagePath);
      return;
    }

    // 1. Ambil metadata ukuran asli gambar
    const metadata = await sharp(inputImagePath).metadata();
    const widthAsli = metadata.width;
    const heightAsli = metadata.height;

    // 2. KUNCI UTAMA: Hitung rasio skala (Lebar Asli dibagi Lebar Preprocessing)
    const rasioSkala = widthAsli / 1200;

    let svgElements = "";
    listBboxSalah.forEach((bbox) => {
      // 3. Kalikan koordinat Tesseract dengan rasio skala gambar asli
      const x0_scaled = bbox.x0 * rasioSkala;
      const y0_scaled = bbox.y0 * rasioSkala;
      const x1_scaled = bbox.x1 * rasioSkala;
      const y1_scaled = bbox.y1 * rasioSkala;

      const rectWidth = x1_scaled - x0_scaled;
      const rectHeight = y1_scaled - y0_scaled;

      // Ketebalan stroke disesuaikan agar proporsional dengan resolusi gambar asli
      const strokeWidth = Math.max(2, Math.round(3 * rasioSkala));

      svgElements += `
        <rect 
          x="${x0_scaled}" 
          y="${y0_scaled}" 
          width="${rectWidth}" 
          height="${rectHeight}" 
          fill="rgba(255, 0, 0, 0.18)" 
          stroke="red" 
          stroke-width="${strokeWidth}"
        />`;
    });

    // 4. Buat template SVG menggunakan dimensi asli
    const svgOverlay = `
      <svg width="${widthAsli}" height="${heightAsli}" xmlns="http://www.w3.org/2000/svg">
        ${svgElements}
      </svg>
    `;

    // 5. Satukan overlay ke gambar asli
    await sharp(inputImagePath)
      .composite([
        {
          input: Buffer.from(svgOverlay),
          top: 0,
          left: 0,
        },
      ])
      .toFile(outputImagePath);

    console.log(`[Anotasi] Sukses presisi! Gambar disimpan di: ${outputImagePath}`);
  } catch (error) {
    console.error(`[Anotasi] Gagal membuat anotasi: ${error.message}`);
    throw error;
  }
}

module.exports = {Gambar};