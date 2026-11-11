const fs = require("fs");
const path = require("path");
const extract = require("extract-zip");
const pdf = require("pdf-poppler");

/**
 * Fungsi untuk mengekstrak file ZIP berisi gambar ke folder temporary
 * @param {string} zipPath - path ke file zip (misal: ../public/dokumen.zip)
 * @returns {Promise<{outputDir: string, files: string[]}>} path folder temp dan list file gambar
 */
async function extractZipToImages(zipPath) {
  // Buat nama folder temporary yang unik menggunakan timestamp
  const outputDir = path.join(__dirname, `temp_zip_${Date.now()}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`[ZIP] Mengekstrak ${zipPath} ke folder temporary...`);

  // Ekstraksi ZIP menggunakan extract-zip ke folder target absolute path
  await extract(path.resolve(zipPath), {
    dir: path.resolve(outputDir),
  });

  // Filter hanya file dengan ekstensi gambar yang didukung
  const ekstensiValid = [".png", ".jpg", ".jpeg", ".bmp"];
  let files = fs
    .readdirSync(outputDir)
    .filter((file) => ekstensiValid.includes(path.extname(file).toLowerCase()))
    .map((file) => path.join(outputDir, file));

  // Urutkan nama file secara natural/alfabetis agar urutan pemrosesan runtut
  files.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );

  return { outputDir, files };
}

async function convertPdfToImages(pdfPath) {
  const fileBaseName = path.basename(pdfPath, path.extname(pdfPath));
  const outputDir = path.join(__dirname, `temp_pdf_${Date.now()}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const options = {
    format: "png",
    out_dir: outputDir,
    out_prefix: fileBaseName,
    page: null,
  };

  console.log(`[PDF] Mengonversi ${pdfPath} ke format gambar...`);
  await pdf.convert(pdfPath, options);

  // Ambil semua file gambar hasil konversi di folder temporary
  let files = fs
    .readdirSync(outputDir)
    .filter((file) => file.startsWith(fileBaseName) && file.endsWith(".png"))
    .map((file) => path.join(outputDir, file));

  // Urutkan file berdasarkan nomor halaman secara natural (page-1, page-2, dst)
  files.sort((a, b) => {
    const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || 0);
    const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || 0);
    return numA - numB;
  });

  return { outputDir, files };
}



module.exports = { extractZipToImages, convertPdfToImages};
