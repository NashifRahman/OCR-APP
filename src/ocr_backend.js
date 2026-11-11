/**
 * Backend OCR Service menggunakan Tesseract.js
 * --------------------------------------------
 * Install dependency terlebih dahulu:
 *   npm install tesseract.js
 *
 * Jalankan:
 *   node ocr-backend.js ./contoh-gambar.png
 */

const { createWorker } = require("tesseract.js");
const { flat, getKorpusKata } = require("./json_read_write");
const { TwoStageRetriever } = require("./cari");
const { performance } = require("perf_hooks");
const { jalankanApp } = require("./banding");
const { convertPdfToImages, extractZipToImages } = require("./image_extract");
const { Gambar } = require("./gambar");
const {
  detectSkewAngle,
  koreksiOCRLine,
  AdaptiveThreshold,
} = require("./preprocessing");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");

/**
 * Fungsi utama untuk menjalankan OCR pada satu gambar
 * @param {string} imagePath - path ke file gambar (jpg/png/bmp/pdf halaman tunggal, dll)
 * @param {string} lang - bahasa OCR, default 'eng'. Bisa 'ind' untuk Bahasa Indonesia
 * @returns {Promise<object>} hasil OCR terstruktur
 */

async function hasilAkhir(imagePath, lang = "ind") {
  const indexedDataRaw = await flat("./data/coba.json");
  const korpusKata = await getKorpusKata("./data/coba.json");
  const indexedData = Object.entries(indexedDataRaw).map(
    ([globalId, terjemahan]) => ({ globalId, terjemahan }),
  );
  const retriever = new TwoStageRetriever(
    indexedData,
    "terjemahan",
    "globalId",
  );

  const results = await runOCRBatch(imagePath, "ind");
  const semuaHasilBatch = [];
  // console.log("isi?",results.map((res) => res.text));
  const GroundTruthJSON = {};
  const IsiOCR = {};
  const IsiOCR_Fixed = {};

  results.forEach((res, idx) => {
    console.log(`\n--- File ${idx + 1}: ${res.file} ---`);
    console.log(`Confidence rata-rata: ${res.confidence}`);
    // console.log(JSON.stringify(res.lines[21], null, 2));

    let adaSambungan = false;

    let array_mapped = res.lines.map((lineObj) => {
      let currentLine = {
        ...lineObj,
        raw: lineObj.text.toLowerCase(),
      };

      // Jika baris sebelumnya berakhiran '-', lindungi kata pertama baris ini
      if (adaSambungan && currentLine.words.length > 0) {
        currentLine.words[0].isPotongan = true;
      }

      // Cek apakah kata terakhir di baris ini berakhiran '-'
      let kataTerakhir = currentLine.words[currentLine.words.length - 1];
      if (kataTerakhir && kataTerakhir.text.endsWith("-")) {
        adaSambungan = true;
      } else {
        adaSambungan = false;
      }

      return currentLine;
    });

    // 2. PROSES FILTERING: Membuang objek baris yang bukan ayat/terjemahan
    let array_bersih = array_mapped.filter((lineObj) => {
      koreksiOCRLine(lineObj, korpusKata);
      let teks = lineObj.text.trim();

      if (!teks) return false;
      if (/^\d+$/.test(teks)) return false;

      if (/^[^a-zA-Z0-9]+$/.test(teks)) return false;

      return true;
    });

    // Tempat menampung hasil penggabungan ayat terstruktur
    const array_terakhir = [];
    // console.log(array_bersih.map((item) => item.text));

    for (const lineObj of array_bersih) {
      // ITERASI PER-KATA
      for (let i = 0; i < lineObj.words.length; i++) {
        let wordObj = lineObj.words[i];
        let teksKata = wordObj.text; // Ambil teks KATA INI SAJA (bukan teks satu baris)

        // ============================================================
        // LOGIKA BARU: INTERCEPTOR SALAH BACA NOMOR AYAT
        // Jika teks adalah "al-.", "ai-.", atau "a1-.", paksa menjadi "4."
        // ============================================================
        const matchSalahBaca = teksKata
          .toLowerCase()
          .match(/^(?!11)[ali1]{2}-?([\.,]+)$/);
        if (matchSalahBaca) {
          teksKata = "4" + matchSalahBaca[1];
          wordObj.text = teksKata; // Perbarui juga data asli di dalam objek
        }

        // Cek apakah KATA INI diawali angka dan titik (misal "2." atau "12. atau")
        if (/^\d+[.,]/.test(teksKata)) {
          // JIKA YA: BIKIN AYAT BARU
          array_terakhir.push({
            text: teksKata,
            raw: teksKata.toLowerCase(),
            words: [wordObj], // Bawa koordinat kotak (bbox) HANYA untuk kata ini
          });
        } else {
          // JIKA BUKAN ANGKA: GABUNGKAN KE AYAT SEBELUMNYA
          if (array_terakhir.length > 0) {
            let ayatSebelumnya = array_terakhir[array_terakhir.length - 1];

            // Cek jika teks ayat sebelumnya menggantung karena strip (-)
            if (ayatSebelumnya.text.endsWith("-")) {
              // Hapus stripnya (slice(0, -1)), lalu tempel kata ini tanpa spasi
              ayatSebelumnya.text = ayatSebelumnya.text.slice(0, -1) + teksKata;
              ayatSebelumnya.raw =
                ayatSebelumnya.raw.slice(0, -1) + teksKata.toLowerCase();
            } else {
              // Jika tidak ada strip, tempel dengan spasi normal
              ayatSebelumnya.text += " " + teksKata;
              ayatSebelumnya.raw += " " + teksKata.toLowerCase();
            }

            // Tambahkan koordinat kata ini ke array words ayat sebelumnya
            ayatSebelumnya.words.push(wordObj);
          } else {
            // Jaga-jaga jika kata pertama di dokumen OCR bukan nomor ayat
            array_terakhir.push({
              text: teksKata,
              raw: teksKata.toLowerCase(),
              words: [wordObj],
            });
          }
        }
      }
    }

    const array_terakhir_koreksi = array_terakhir.map((item) => ({
      ...item,
      text: item.text,
      raw: item.raw,
      words: item.words.map((word) => ({
        ...word,
        text: word.text,
      })),
    }));

    // Teks murni untuk kebutuhan pencetakan log terminal & query matching database
    const teksMurniPencarian = array_terakhir_koreksi.map((item) => item.text);
    // console.log("Array hasil OCR:", teksMurniPencarian);

    const teksRawPencarian = array_terakhir_koreksi.map((item) => item.raw);
    // console.log("Array hasil OCR (Raw):", teksRawPencarian);

    if (array_terakhir_koreksi.length === 0) {
      console.log("tidak ada data yang masuk");
    }

    if (array_terakhir_koreksi.length > 0) {
      // Fungsi bantuan untuk menghapus angka dan titik di awal teks (misal "10. " -> "")
      const bersihkanQuery = (teks) => teks.replace(/^\d+[.,]\s*/, "").trim();

      let hasilAwal = null;
      let offsetAwal = 0; // Melacak seberapa jauh kita bergeser

      // FALLBACK AWAL: Cari dari index 0, jika gagal coba index 1, batas maks coba 3 ayat awal
      while (
        !hasilAwal &&
        offsetAwal < Math.min(4, array_terakhir_koreksi.length)
      ) {
        let queryBersih = bersihkanQuery(
          array_terakhir_koreksi[offsetAwal].text,
        );
        hasilAwal = retriever.cariAyat(queryBersih);
        if (!hasilAwal) offsetAwal++;
      }

      let hasilAkhir = null;
      let offsetAkhir = 0;
      let indexCariAkhir = array_terakhir_koreksi.length - 1;

      // FALLBACK AKHIR: Cari dari ujung belakang, jika gagal mundur 1 ayat, batas maks coba 3 ayat akhir
      while (
        !hasilAkhir &&
        offsetAkhir < Math.min(4, array_terakhir_koreksi.length)
      ) {
        let queryBersih = bersihkanQuery(
          array_terakhir_koreksi[indexCariAkhir - offsetAkhir].text,
        );
        hasilAkhir = retriever.cariAyat(queryBersih);
        if (!hasilAkhir) offsetAkhir++;
      }

      // Lanjutkan jika setidaknya ujung-ujungnya berhasil ditemukan (bisa jadi dengan fallback)
      if (hasilAwal && hasilAkhir) {
        let startIndex = indexedData.findIndex(
          (item) => item.globalId === hasilAwal.global_id,
        );
        let endIndex = indexedData.findIndex(
          (item) => item.globalId === hasilAkhir.global_id,
        );

        if (startIndex !== -1 && endIndex !== -1) {
          // KOMPENSASI INDEX:
          // Jika tadi kita pakai fallback (menggeser pencarian),
          // kembalikan index databasenya agar ayat yang terpotong di OCR tetap ditarik utuh dari master.
          startIndex = Math.max(0, startIndex - offsetAwal);
          endIndex = Math.min(indexedData.length - 1, endIndex + offsetAkhir);

          const minIdx = Math.min(startIndex, endIndex);
          const maxIdx = Math.max(startIndex, endIndex);

          const df_hasil = indexedData.slice(minIdx, maxIdx + 1);
          const hasil_akhir = df_hasil.map((item) => item.terjemahan);

          semuaHasilBatch.push({
            file: res.file,
            originalFile: res.originalFile,
            Data_OCR: array_terakhir_koreksi,
            Data_Master: hasil_akhir,
          });

          console.log("\n--- ISI TEKS RANGE DATABASE (HASIL AKHIR) ---");
          const namaFile = path.basename(res.originalFile);

          const IsiOCRText = res.text.toLowerCase().replace(/\s+/g, " ");
          const IsiMasterText = hasil_akhir
          const IsiOCRFix = array_terakhir_koreksi
            .map((item) => item.text)
            .join(" ")
            .replace(/\(\s+/g, "(") // Menghapus spasi setelah kurung buka
            .replace(/\s+\)/g, ")") // Menghapus spasi sebelum kurung tutup
            .replace(/"\s*([!?])/g, "$1") // Membersihkan spasi di antara kutip dan tanda baca
            .replace(/\s{2,}/g, " ") // Memastikan tidak ada spasi ganda
            .trim();
          IsiOCR[namaFile] = IsiOCRText;
          IsiOCR_Fixed[namaFile] = IsiOCRFix;
          GroundTruthJSON[namaFile]= IsiMasterText;
        } else {
          console.log(
            "[WARNING] Global ID ditemukan, tetapi tidak ada di indexedData",
          );
        }
      } else {
        console.log(
          `[WARNING] Pencarian ujung gagal. Awal: ${!!hasilAwal}, Akhir: ${!!hasilAkhir}`,
        );
      }
    }
  });

  // --- KODE TAMBAHAN DILETAKKAN DI SINI (Sebelum return, di luar loop results.forEach) ---
  const outputPath = path.join(__dirname,"data", "master_data.json");
  const isiOCRRaw = path.join(__dirname, "data", "isi_ocr_raw.json");
  const isiOCRPath = path.join(__dirname, "data", "isi_ocr_fixed.json");

  fs.writeFileSync(
    outputPath,
    JSON.stringify(GroundTruthJSON, null, 2),
    "utf8",
  );
  fs.writeFileSync(isiOCRRaw, JSON.stringify(IsiOCR, null, 2), "utf8");
  fs.writeFileSync(isiOCRPath, JSON.stringify(IsiOCR_Fixed, null, 2), "utf8");

  console.log(`Ground truth berhasil disimpan ke ${outputPath}`);
  console.log(`Isi OCR raw berhasil disimpan ke ${isiOCRRaw}`);
  console.log(`Isi OCR Fixed berhasil disimpan ke ${isiOCRPath}`);

  return semuaHasilBatch;
}

async function preprocessing(imagePath) {
  const tempPath = path.join(
    __dirname,
    "preprocessed",
    `temp_${Date.now()}_processed.png`,
  );

  fs.mkdirSync(path.dirname(tempPath), { recursive: true });

  const skewAngle = await detectSkewAngle(imagePath);
  const correctionAngle = -skewAngle;

  // Preprocessing menggunakan Sharp
  const { data, info } = await sharp(imagePath)
    .removeAlpha() // Mencegah crash ukuran buffer, pastikan murni tanpa transparansi
    .grayscale()
    .rotate(correctionAngle, { background: "#ffffff" })
    .resize({
      width: 1200, // Coba naikkan ke 2000 jika OCR masih belum maksimal
      withoutEnlargement: false,
    })
    .normalise()
    .sharpen()
    .raw()
    .toBuffer({ resolveWithObject: true });

  await AdaptiveThreshold(data, info, tempPath);

  return tempPath;
}

async function runOCR(imagePath, lang = "ind") {
  console.log(`[OCR] Memulai proses untuk file: ${imagePath}`);
  console.time("[OCR] Durasi proses");

  let processedImagePath = imagePath;
  let isTempCreated = false;

  try {
    // 1. Jalankan preprocessing terlebih dahulu
    processedImagePath = await preprocessing(imagePath);
    isTempCreated = true;
  } catch (err) {
    console.error(`[OCR] Error preprocessing: ${err.message}`);
  }

  const worker = await createWorker(lang);
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist:
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZāīū0123456789.,!?-()\"' ",
  });

  try {
    // 2. Jalankan OCR di atas gambar yang sudah bersih (preprocessed)
    const { data } = await worker.recognize(
      processedImagePath,
      {},
      { tsv: true },
    );

    const rows = data.tsv.split("\n").filter(Boolean);
    const linesMap = {};

    rows
      .map((row) => row.split("\t"))
      .filter((cols) => cols[0] === "5")
      .forEach((cols) => {
        const keyBaris = `${cols[2]}_${cols[3]}_${cols[4]}`;
        const left = Number(cols[6]);
        const top = Number(cols[7]);
        const width = Number(cols[8]);
        const height = Number(cols[9]);
        const textValue = cols[11] ? cols[11].trim().normalize("NFC") : "";

        if (!textValue) return;

        if (height < 8) return;

        // Opsional: Filter jika kata hanya berisi simbol aneh tanpa huruf/angka
        if (/^[^\w\s]+$/.test(textValue) && textValue.length === 1) return;

        const wordObj = {
          text: textValue,
          confidence: Number(cols[10]),
          bbox: {
            x0: left,
            y0: top,
            x1: left + width,
            y1: top + height,
          },
        };

        if (!linesMap[keyBaris]) {
          linesMap[keyBaris] = [];
        }
        linesMap[keyBaris].push(wordObj);
      });

    const structuredLines = Object.values(linesMap).map((wordsInLine) => {
      return {
        text: wordsInLine.map((w) => w.text).join(" "),
        words: wordsInLine,
      };
    });

    // KUNCI 1: Tukar referensi berkas utama ke berkas hasil preprocessing
    const result = {
      file: processedImagePath, // Menjadi gambarAsli untuk proses berikutnya
      originalFile: imagePath, // Disimpan hanya untuk referensi nama output & folder
      text: data.text.trim().normalize("NFC"),
      confidence: data.confidence,
      lines: structuredLines,
    };

    return result;
  } finally {
    await worker.terminate();
    // KUNCI 2: Hapus perintah unlinkSync di sini agar file bersih tidak hilang sebelum dianotasi
    console.timeEnd("[OCR] Durasi proses");
  }
}

/**
 * Fungsi untuk menjalankan OCR pada banyak file sekaligus
 * @param {string[]} imagePaths
 * @param {string} lang
 */
async function runOCRBatch(imagePaths, lang = "ind") {
  const results = [];
  for (const path of imagePaths) {
    const result = await runOCR(path, lang);
    results.push(result);
  }
  return results;
}

// async function

// ---------------------------------------------------
// Eksekusi langsung dari command line
// Contoh: node ocr-backend.js gambar1.png gambar2.png
// ---------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Penggunaan: node ocr-backend.js <path-gambar1> [path-gambar2] ...",
    );
    process.exit(1);
  }

  (async () => {
    let filesToProcess = [];
    let tempDirsToDelete = [];
    let tempFilesToDelete = [];
    const fileOriginMap = new Map(); // Melacak direktori asal berkas untuk penempatan output _annotated

    try {
      const t1 = performance.now();
      const semuaLog = [];

      // Alur Deteksi Input: Gambar, PDF, atau ZIP
      for (const arg of args) {
        const ext = path.extname(arg).toLowerCase();
        const originalDir = path.dirname(arg);

        if (ext === ".pdf") {
          // Proses PDF
          const { outputDir, files } = await convertPdfToImages(arg);
          filesToProcess.push(...files);
          tempDirsToDelete.push(outputDir);
          tempFilesToDelete.push(...files);

          files.forEach((f) => fileOriginMap.set(f, { originalDir }));
        } else if (ext === ".zip") {
          // Proses ZIP menggunakan modul terpisah
          const { outputDir, files } = await extractZipToImages(arg);
          filesToProcess.push(...files);
          tempDirsToDelete.push(outputDir);
          tempFilesToDelete.push(...files);

          // Petakan lokasi asal agar file hasil _annotated disimpan sejajar dengan file .zip asli
          files.forEach((f) => fileOriginMap.set(f, { originalDir }));
        } else {
          // Jika input langsung berupa gambar mentah
          filesToProcess.push(arg);
        }
      }

      if (filesToProcess.length === 0) {
        console.error("Tidak ada berkas valid yang dapat diproses.");
        process.exit(1);
      }

      // Jalankan proses OCR Batch
      const dataHasil = await hasilAkhir(filesToProcess, "ind");

      // Anotasi kotak evaluasi gambar

      for (let indexDoc = 0; indexDoc < dataHasil.length; indexDoc++) {
        const dokumenSistem = dataHasil[indexDoc];
        const gambarAsli = dokumenSistem.file;
        const gambarNoisyAwal = dokumenSistem.originalFile; // Gambar noisy input awal

        console.log(
          `\n=== Cek Banding: ${dokumenSistem.Data_OCR[0]?.text?.slice(0, 30)}... ===`,
        );

        const textOCR = dokumenSistem.Data_OCR;
        const textMaster = dokumenSistem.Data_Master;

        const LogAndCompare = await jalankanApp(textOCR, textMaster);
        const koordinatSalah = LogAndCompare.semuaBboxSalah;
        const LogIsi = LogAndCompare.logOutput;
        semuaLog.push(...LogIsi);

        const fileExtension = path.extname(gambarNoisyAwal);
        const fileBaseName = path.basename(gambarNoisyAwal, fileExtension);

        let outputDir;
        let gambarOutput;

        // Jika file diekstrak dari PDF/ZIP, taruh hasil anotasi di folder berkas asal
        if (fileOriginMap.has(gambarNoisyAwal)) {
          const origin = fileOriginMap.get(gambarNoisyAwal);
          outputDir = path.join(origin.originalDir, "annotated");
        } else {
          const dirName = path.dirname(gambarNoisyAwal);
          outputDir = path.join(dirName, "annotated");
        }

        // Buat folder jika belum ada
        fs.mkdirSync(outputDir, { recursive: true });

        gambarOutput = path.join(
          outputDir,
          `${fileBaseName}_annotated${fileExtension}`,
        );

        await Gambar(gambarAsli, koordinatSalah, gambarOutput);
        if (gambarAsli !== gambarNoisyAwal && fs.existsSync(gambarAsli)) {
          fs.unlinkSync(gambarAsli);
          console.log(
            `[Cleanup] Sukses menghapus file temp biner: ${gambarAsli}`,
          );
        }
      }
      const outputFolder = path.join(__dirname, "hasil", "hasil_deteksi.txt");
      fs.writeFileSync(outputFolder, semuaLog.join("\n") + "\n", "utf8");
      console.log(`Log hasil deteksi telah disimpan di: ${outputFolder}`);

      const t3 = performance.now();
      console.log(`\n[WAKTU] Total waktu eksekusi: ${(t3 - t1).toFixed(2)} ms`);
    } catch (err) {
      console.error("[OCR] Terjadi error saat pemrosesan:", err.message);
    } finally {
      // Blok Pembersihan Otomatis (Cleanup) setelah seluruh OCR selesai
      if (tempFilesToDelete.length > 0) {
        console.log(
          "\n[Cleanup] Menghapus gambar mentah hasil konversi/ekstraksi...",
        );

        // Hapus file gambarnya terlebih dahulu
        for (const file of tempFilesToDelete) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        }
        // Hapus folder temporary yang sekarang sudah kosong
        for (const dir of tempDirsToDelete) {
          if (fs.existsSync(dir)) {
            fs.rmdirSync(dir);
          }
        }
        console.log("[Cleanup] Folder temporary berhasil dibersihkan.");
      }
    }
  })();
}

module.exports = { runOCR, runOCRBatch, hasilAkhir };
