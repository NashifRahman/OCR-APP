const sharp = require("sharp");
const { cv } = require("opencv-wasm");
const fuzz = require("fuzzball");

// Gunakan Logika Horizontal Projection Profile dengan pendekatan berbasis Varians Maksimum.
async function detectSkewAngle(imagePath) {
  // 1. Baca gambar menggunakan Sharp (sebagai jembatan ke OpenCV)
  // Menurunkan resolusi sangat disarankan agar operasi matriks jauh lebih cepat
  const { data, info } = await sharp(imagePath)
    .resize({ width: 600, withoutEnlargement: true }) // Sesuaikan ukuran optimal Anda
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Buat matriks OpenCV dari raw buffer Sharp (1 channel, Grayscale)
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC1, data);

  // 3. Thresholding untuk mengisolasi teks dokumen
  // Teks yang gelap (< 128) diubah menjadi putih (255), background menjadi hitam (0)
  const binary = new cv.Mat();
  cv.threshold(src, binary, 128, 255, cv.THRESH_BINARY_INV);

  const center = new cv.Point(info.width / 2, info.height / 2);
  const size = new cv.Size(info.width, info.height);
  const scalarBlack = new cv.Scalar(0, 0, 0, 0);

  let bestAngle = 0;
  let maxVariance = 0;

  // Alokasi memori Mat di luar loop untuk menghindari overhead
  const rotated = new cv.Mat();
  const projection = new cv.Mat();
  const meanObj = new cv.Mat();
  const stddevObj = new cv.Mat();

  // 4. Menguji rentang sudut -5 hingga +5 derajat
  for (let angle = -5; angle <= 5; angle += 0.5) {
    // Buat matriks rotasi
    const M = cv.getRotationMatrix2D(center, angle, 1.0);

    // Lakukan rotasi pada citra biner
    // INTER_NEAREST lebih ringan dan cukup presisi untuk piksel hitam-putih
    cv.warpAffine(
      binary,
      rotated,
      M,
      size,
      cv.INTER_NEAREST,
      cv.BORDER_CONSTANT,
      scalarBlack,
    );

    // 5. Proyeksi Horizontal: Jumlahkan nilai piksel tiap baris
    // parameter '1' berarti reduce matriks menjadi 1 kolom (menjumlahkan sumbu X)
    cv.reduce(rotated, projection, 1, cv.REDUCE_SUM, cv.CV_32F);

    // 6. Hitung Varians (Standar Deviasi dikuadratkan)
    cv.meanStdDev(projection, meanObj, stddevObj);
    const stddev = stddevObj.doubleAt(0, 0);
    const variance = stddev * stddev;

    if (variance > maxVariance) {
      maxVariance = variance;
      bestAngle = angle; // Catatan: Anda mungkin butuh mengembalikan -bestAngle tergantung orientasi akhir rotasi Anda
    }

    M.delete(); // Wajib dihapus dalam loop agar memori WASM tidak bocor
  }

  // 7. Bersihkan sisa memori OpenCV
  src.delete();
  binary.delete();
  rotated.delete();
  projection.delete();
  meanObj.delete();
  stddevObj.delete();

  return bestAngle;
}

// Fungsi untuk mencari kata terdekat dari korpus
function cariKataBaku(kataOCR, korpus, maxDistance) {
  let kataTerbaik = kataOCR;
  let jarakTerkecil = Infinity;

  for (const kataBaku of korpus) {
    const jarak = fuzz.distance(kataOCR, kataBaku);

    // Jika jaraknya 0, kata sudah baku, langsung kembalikan
    if (jarak === 0) return kataBaku;

    // Cari jarak terkecil yang masih di bawah threshold maxDistance
    if (jarak < jarakTerkecil && jarak <= maxDistance) {
      jarakTerkecil = jarak;
      kataTerbaik = kataBaku;
    }
  }

  return kataTerbaik;
}

/**
 * Mengoreksi salah baca OCR pada seluruh kata dalam satu baris
 * @param {Object} lineObj - Object line dari Tesseract
 * @returns {Object} lineObj yang sudah dikoreksi
 */
function koreksiOCRLine(lineObj, korpus) {
  // 1. Ambil data kata asli yang tidak kosong
  let words = lineObj.words.filter((w) => w.text.trim() !== "");
  let mergedWords = [];

  // ==========================================================
  // TAHAP 1: Sinkronisasi Level Baris & Peleburan Token Terpisah
  // (Lakukan ini DULUAN sebelum normalisasiKata)
  // ==========================================================
  for (let i = 0; i < words.length; i++) {
    let currentWord = words[i];

    // Cek gabung Al- Qur
    if (
      i < words.length - 2 &&
      /Al-$/i.test(currentWord.text) &&
      /^[a-zA-Z]$/.test(words[i + 1].text) &&
      /^Qur/i.test(words[i + 2].text)
    ) {
      let w1 = currentWord;
      let w2 = words[i + 1];
      let w3 = words[i + 2];

      currentWord = {
        text: w1.text + w3.text,
        confidence: Math.min(w1.confidence, w3.confidence),
        bbox: {
          x0: Math.min(w1.bbox.x0, w2.bbox.x0, w3.bbox.x0),
          y0: Math.min(w1.bbox.y0, w2.bbox.y0, w3.bbox.y0),
          x1: Math.max(w1.bbox.x1, w2.bbox.x1, w3.bbox.x1),
          y1: Math.max(w1.bbox.y1, w2.bbox.y1, w3.bbox.y1),
        },
      };
      i += 2;
    }

    // Cek gabung tanda seru/tanya setelah kutip
    if (
      i < words.length - 1 &&
      currentWord.text.endsWith('"') &&
      /^([!?])/.test(words[i + 1].text)
    ) {
      let nextW = words[i + 1];
      currentWord.text = currentWord.text.slice(0, -1) + nextW.text;
      currentWord.bbox.x1 = Math.max(currentWord.bbox.x1, nextW.bbox.x1);
      currentWord.bbox.y1 = Math.max(currentWord.bbox.y1, nextW.bbox.y1);
      i++;
    }

    // Cek gabung kurung tutup
    if (i < words.length - 1 && words[i + 1].text.startsWith(")")) {
      let nextW = words[i + 1];
      currentWord.text += nextW.text;
      currentWord.bbox.x1 = Math.max(currentWord.bbox.x1, nextW.bbox.x1);
      currentWord.bbox.y1 = Math.max(currentWord.bbox.y1, nextW.bbox.y1);
      i++;
    }

    // Cek strip di awal kata berikutnya
    if (
      i < words.length - 1 &&
      words[i + 1].text.startsWith("-") &&
      words[i + 1].text.length > 1
    ) {
      let nextW = words[i + 1];

      currentWord.text += nextW.text;
      currentWord.confidence = Math.min(
        currentWord.confidence,
        nextW.confidence,
      );

      currentWord.bbox.x1 = Math.max(currentWord.bbox.x1, nextW.bbox.x1);
      currentWord.bbox.y1 = Math.max(currentWord.bbox.y1, nextW.bbox.y1);

      i++;
    }

    // Cek strip di akhir kata saat ini
    if (i < words.length - 1 && currentWord.text.endsWith("-")) {
      let nextW = words[i + 1];
      currentWord.text += nextW.text;
      currentWord.bbox.x1 = Math.max(currentWord.bbox.x1, nextW.bbox.x1);
      currentWord.bbox.y1 = Math.max(currentWord.bbox.y1, nextW.bbox.y1);
      i++;
    }

    // ==== TAMBAHKAN KODE INI ====
    // Cek gabung tanda baca titik/koma yang terlepas dari nomor ayat atau kata
    if (i < words.length - 1 && /^[\.,\)\!\?"]+$/.test(words[i + 1].text)) {
      let nextW = words[i + 1];
      currentWord.text += nextW.text;
      currentWord.bbox.x1 = Math.max(currentWord.bbox.x1, nextW.bbox.x1);
      currentWord.bbox.y1 = Math.max(currentWord.bbox.y1, nextW.bbox.y1);
      i++;
    }

    if (currentWord.text.trim() !== "") {
      mergedWords.push(currentWord);
    }
  }

  // Simpan array kata yang SUDAH DIGABUNG kembali ke lineObj.words
  lineObj.words = mergedWords;

  // ==========================================================
  // TAHAP 2: Normalisasi Kata
  // ==========================================================
  lineObj.words.forEach((wordObj) => {
    normalisasiKata(wordObj, korpus);
  });

  // ==========================================================
  // TAHAP 3: Render Teks Akhir & Regex Pembersih Terakhir
  // ==========================================================

  // PENAMBAHAN LOGIKA 1: Bersihkan spasi di dalam masing-masing kata (word level)
  // Ini menjaga agar teks bersih, tapi koordinat (bbox) miliknya tidak hilang/berubah.
  lineObj.words.forEach((w) => {
    w.text = w.text.replace(/\s{2,}/g, " ").trim();
  });

  // Filter ulang untuk membuang token yang mungkin jadi kosong setelah di-trim
  lineObj.words = lineObj.words.filter((w) => w.text !== "");

  // Gabungkan kata-kata menjadi satu kalimat baris
  lineObj.text = lineObj.words.map((w) => w.text).join(" ");

  // Terapkan regex khusus bawaan Anda
  lineObj.text = lineObj.text.replace(/\s+\)/g, " ");
  lineObj.text = lineObj.text.replace(/"\s*([!?])/g, "$1");
  lineObj.text = lineObj.text.replace(/(Al-)\s*[a-zA-Z]\s*(Qur)/gi, "$1$2");

  // PENAMBAHAN LOGIKA 2: Pembersihan spasi final (line level)
  // Menghapus jika regex di atas secara tak sengaja menyisakan spasi ganda,
  // dan .trim() memastikan tidak ada spasi di awal maupun di akhir string penuh.
  lineObj.text = lineObj.text.replace(/\s{2,}/g, " ").trim();

  return lineObj;
}

const kamusKoreksiKhusus = {
  raih: "rūḥ",
  ruh: "rūḥ",
  rah:"rūḥ",
  lailatulgadar: "lailatulqadar",
  safir: "sa'ir",
  "al-gari'ah": "al-qāri'ah",
  "al-gur'an": "al-qur'an",
  guraisy: "quraisy",
  sijjin: "sijjīn",
  iiyyin: "illiyyīn", // atau 'illiyyīn sesuai standar Anda
  tasnim: "tasnīm",
  gasyiyah: "gāsyiyah",
  alah: "allah",
  la: "ia", // "Ia" dibaca "la" oleh OCR (huruf i besar terbaca L kecil)
  // Tambahkan kata-kata lain yang sering salah di sini...
};

function normalisasiKata(wordObj, korpus) {
  // Lewati jika ini adalah potongan kata dari baris sebelumnya
  if (wordObj.isPotongan) return wordObj;

  let teksMurni = wordObj.text.toLowerCase();
  let prefixAngka = "";

  // ====================================================================
  // PERBAIKAN 1: Izinkan tanda baca () ! ? " agar tidak dihapus
  // ====================================================================
  teksMurni = teksMurni.replace(/[^\p{L}\p{N}.,()!?"'-]/gu, "");

  // teksMurni = teksMurni.replace(/^['"]?[l1i]([\.,])/i, "4$1");
  teksMurni = teksMurni.replace(/^[^a-z0-9.,("]+/g, "");

  // ====================================================================
  // FITUR BARU: KOREKSI OCR NOMOR AYAT (HURUF JADI ANGKA)
  // ====================================================================
  const matchOcrNomor = teksMurni.match(/^([a-z0-9]{1,2})([\.,])(.*)$/);
  if (matchOcrNomor) {
    const mapAngka = {
      o: "0",
      l: "1",
      i: "1",
      z: "2",
      q: "2",
      e: "3",
      a: "4",
      "'l":"4",
      s: "5",
      g: "6",
      t: "7",
      b: "8",
    };
    let kandidat = matchOcrNomor[1];
    let tanda = matchOcrNomor[2];
    let sisa = matchOcrNomor[3];

    let hasilAngka = "";
    let validAngka = true;

    for (let char of kandidat) {
      if (/\d/.test(char)) hasilAngka += char;
      else if (mapAngka[char]) hasilAngka += mapAngka[char];
      else {
        validAngka = false;
        break;
      }
    }
    if (validAngka) teksMurni = hasilAngka + tanda + sisa;
  }

  // ====================================================================
  // DETEKSI NOMOR AYAT YANG MENEMPEL TANPA/DENGAN SPASI
  // ====================================================================
  const matchNempel = teksMurni.match(/^(\d+[\.,]+)\s*([^\d\.,\s].*)$/);
  if (matchNempel) {
    prefixAngka = matchNempel[1];
    teksMurni = matchNempel[2];
  }

  const isAngka = /^[\d\.,]+$/.test(teksMurni);
  if (!isAngka) {
    teksMurni = teksMurni
      .replace(/4/g, "a")
      .replace(/3/g, "e")
      .replace(/1/g, "i")
      .replace(/0/g, "o")
      .replace(/2/g, "q")
      .replace(/5/g, "s")
      .replace(/6/g, "g")
      .replace(/7/g, "t")
      .replace(/8/g, "b")
      .replace(/9/g, "q");
  }

  // ====================================================================
  // PERBAIKAN 2: Tangkap tanda baca di awal dan di akhir
  // ====================================================================
  const tandaBacaAkhir = teksMurni.match(/[\.,\)\!\?"]+$/);
  const tandaBacaAwal = teksMurni.match(/^[\(\"]+/);

  let kataTanpaTandaBaca = teksMurni;
  if (tandaBacaAkhir)
    kataTanpaTandaBaca = kataTanpaTandaBaca.replace(/[\.,\)\!\?"]+$/, "");
  if (tandaBacaAwal)
    kataTanpaTandaBaca = kataTanpaTandaBaca.replace(/^[\(\"]+/, "");

  let hasilKoreksi = kataTanpaTandaBaca; // Default hasil koreksi

  // ====================================================================
  // TAHAP 1: CEK KAMUS KHUSUS
  // ====================================================================
  if (kamusKoreksiKhusus[kataTanpaTandaBaca]) {
    let kataKamus = kamusKoreksiKhusus[kataTanpaTandaBaca];
    if (kataTanpaTandaBaca === "la") kataKamus = "Ia";
    hasilKoreksi = kataKamus;
  }
  // ====================================================================
  // TAHAP 2: PROSES LEVENSHTEIN
  // ====================================================================
  else {
    const isAkhiran = teksMurni.endsWith("-");
    if (
      wordObj.confidence < 50 &&
      kataTanpaTandaBaca.length > 2 &&
      !isAngka &&
      !isAkhiran
    ) {
      hasilKoreksi = cariKataBaku(kataTanpaTandaBaca, korpus, 2);
    }
  }

  // ====================================================================
  // TAHAP TERAKHIR: KEMBALIKAN TANDA BACA DAN ANGKA
  // ====================================================================
  // Rangkai kembali: (Tanda Awal) + (Kata Koreksi) + (Tanda Akhir)
  hasilKoreksi =
    (tandaBacaAwal ? tandaBacaAwal[0] : "") +
    hasilKoreksi +
    (tandaBacaAkhir ? tandaBacaAkhir[0] : "");

  if (prefixAngka !== "") {
    wordObj.text = prefixAngka + " " + hasilKoreksi;
  } else {
    wordObj.text = hasilKoreksi;
  }

  return wordObj;
}

async function AdaptiveThreshold(data, info, tempPath) {
  let src = cv.matFromArray(info.height, info.width, cv.CV_8UC1, data);
  const dst = new cv.Mat();

  // Adaptive Threshold
  // cv.medianBlur(src, src, 5); // Median Blur untuk mengurangi noise

  cv.adaptiveThreshold(
    src,
    dst,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY,
    31, // blockSize (ganjil)
    20, // C
  );

  // Simpan hasil
  const outputBuffer = Buffer.from(dst.data);

  await sharp(outputBuffer, {
    raw: {
      width: dst.cols,
      height: dst.rows,
      channels: 1, // Output adaptive threshold grayscale murni
    },
  })
    .png()
    .toFile(tempPath);

  // Bersihkan memori C++
  src.delete();
  dst.delete();
}

module.exports = { detectSkewAngle, koreksiOCRLine, AdaptiveThreshold };
