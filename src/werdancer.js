const fs = require('fs');
const fuzz = require('fuzzball');
const calculateWER = require('word-error-rate');

// 1. Ambil argumen dari command line (mulai dari index ke-2)
const args = process.argv.slice(2);

// Validasi: pastikan pengguna memasukkan argumen draft
if (args.length === 0) {
  console.error("❌ Argumen draft tidak ditemukan!");
  console.error("👉 Gunakan format: node werdancer.js <nama_draft>");
  console.error("📝 Contoh: node werdancer.js draft_1");
  process.exit(1); // Hentikan program
}

// Ambil kata "draft_1" (atau apa pun yang diketik user)
const namaDraft = args[0]; 

// 2. Susun path file secara dinamis menggunakan Template Literals (Backtick `)
const pathOcrRaw = `./data/isi_ocr_fixed_${namaDraft}.json`;
const pathGroundTruth = `./data/${namaDraft}_ground_truth.json`; // Asumsi file ini namanya tetap

console.log(`\n🔍 Membaca file OCR: ${pathOcrRaw}...`);

let isiOcrRaw;
let groundTruth;

// 3. Gunakan try-catch agar program tidak langsung crash dan 
// memberi pesan error yang jelas jika file tidak ditemukan
try {
  isiOcrRaw = JSON.parse(fs.readFileSync(pathOcrRaw, 'utf8'));
  groundTruth = JSON.parse(fs.readFileSync(pathGroundTruth, 'utf8'));
} catch (error) {
  console.error(`\n❌ Gagal membaca file! Pastikan file ${pathOcrRaw} dan ${pathGroundTruth} ada di folder /data.`);
  console.error(`Detail error: ${error.message}`);
  process.exit(1);
}

let totalCER = 0;
let totalWER = 0;
let jumlahFile = 0;

// 4. Proses Evaluasi
for (const namaFile in groundTruth) {
  if (isiOcrRaw[namaFile]) {
    const teksAsli = groundTruth[namaFile];
    const teksOcr = isiOcrRaw[namaFile];

    // --- Hitung CER menggunakan Fuzzball ---
    const jarakKarakter = fuzz.distance(teksOcr, teksAsli); 
    const cer = jarakKarakter / teksAsli.length;

    // --- Hitung WER ---
    const wer = calculateWER.wordErrorRate(teksOcr, teksAsli); 

    console.log(`\n--- Evaluasi: ${namaFile} ---`);
    console.log(`CER: ${(cer * 100).toFixed(2)}%`);
    console.log(`WER: ${(wer * 100).toFixed(2)}%`);

    totalCER += cer;
    totalWER += wer;
    jumlahFile++;
  } else {
      console.log(`\n⚠️ Peringatan: File ${namaFile} ada di ground_truth tapi tidak ditemukan di hasil OCR.`);
  }
}

// 5. Tampilkan rata-rata keseluruhan
if (jumlahFile > 0) {
  console.log(`\n========================================`);
  console.log(`📊 RATA-RATA KESELURUHAN DARI ${jumlahFile} FILE (${namaDraft})`);
  console.log(`========================================`);
  console.log(`Rata-rata CER: ${((totalCER / jumlahFile) * 100).toFixed(2)}%`);
  console.log(`Rata-rata WER: ${((totalWER / jumlahFile) * 100).toFixed(2)}%`);
  console.log(`========================================\n`);
}