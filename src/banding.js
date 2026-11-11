const fs = require("fs");
const path = require("path");
const fuzz = require("fuzzball");

function tulisLog(logOutput, text) {
  console.log(text);
  logOutput.push(text);
}

// Helper untuk menyamakan semua jenis tanda kutip ganda sebelum dibandingkan
function normalizeQuotes(str) {
  return (
    str
      .toLowerCase()
      .normalize("NFKC")

      // Samakan semua jenis apostrof menjadi '
      .replace(/[’‘ʻʼʹʽ`´"“”']/g, "")

      // Pertahankan titik setelah nomor ayat di awal kalimat
      .replace(/^(\d+)\.(?=\s)/, "__AYAT__$1__DOT__")

      // Hapus semua tanda baca kecuali ' dan -
      .replace(/[.,!?;:()[\]{}]/g, "")

      // Kembalikan nomor ayat
      .replace(/__AYAT__(\d+)__DOT__/g, "$1.")

      // Rapikan spasi
      .replace(/\s+/g, " ")
      .replace(/-/g, "")
      .trim()
  );
}

async function jalankanApp(dataOcr, dataMaster) {
  const cleanMaster = dataMaster.map((kalimat) =>
    normalizeQuotes(kalimat.trim().toLowerCase()),
  );

  const semuaBboxSalah = [];
  const logOutput = [];

  // 1. PEMETAAN MENGGUNAKAN ARRAY
  const masterList = cleanMaster.map((baris) => {
    const match = baris.match(/^(\d+)\./);
    return { nomor: match ? match[1] : null, text: baris };
  });

  const ocrList = dataOcr.map((obj) => {
    const match = obj.text.match(/^(\d+)[\.,]/);
    return { nomor: match ? match[1] : null, obj: obj };
  });

  // 2. PROSES PERBANDINGAN
  let masterPointer = 0;

  for (const ocrItem of ocrList) {
    if (!ocrItem.nomor) continue; 

    let foundIdx = -1;
    let candidates = [];

    // TAHAP 1: Hitung kemiripan dengan semua sisa Master
    for (let k = masterPointer; k < masterList.length; k++) {
      const kemiripan = fuzz.ratio(ocrItem.obj.text, masterList[k].text);
      candidates.push({ index: k, score: kemiripan });
    }

    if (candidates.length > 0) {
      // Urutkan berdasarkan skor kemiripan (dari tertinggi ke terendah)
      candidates.sort((a, b) => b.score - a.score);
      
      const highestScore = candidates[0].score;

      // TAHAP 2: Logika Pemilihan Prioritas Kemiripan Teks
      // Ambil semua kandidat yang memiliki skor tertinggi (antisipasi jika ada seri)
      const topCandidates = candidates.filter(c => c.score === highestScore);

      if (topCandidates.length === 1) {
        // Jika hanya ada 1 pilihan dengan skor tertinggi, mutlak gunakan ini
        foundIdx = topCandidates[0].index;
      } else {
        // Jika ada lebih dari 1 pilihan dengan kemiripan yang sama tingginya,
        // jadikan nomor ayat sebagai penentu (tie-breaker)
        const matchByNomor = topCandidates.find(
          (c) => masterList[c.index].nomor === ocrItem.nomor,
        );
        if (matchByNomor) {
          foundIdx = matchByNomor.index;
        } else {
          // Jika nomor ayat tetap tidak ada yang cocok, ambil yang pertama
          foundIdx = topCandidates[0].index;
        }
      }
    }

    // JIKA KETEMU PASANGANNYA, LAKUKAN KOREKSI
    if (foundIdx !== -1) {
      const barisMaster = masterList[foundIdx].text;
      const barisOcrObj = ocrItem.obj;

      const nomorAyat = masterList[foundIdx].nomor;

      // --- LOGIKA SPLIT & LEVENSHTEIN ---
      const kataMaster = barisMaster.split(/\s+/);
      const kataOcrSistem = [];
      const rawWords = barisOcrObj.words;

      for (let j = 0; j < rawWords.length; j++) {
        let currentWord = { ...rawWords[j] };
        while (currentWord.text.endsWith("-") && j + 1 < rawWords.length) {
          const nextWord = rawWords[j + 1];
          currentWord.text += nextWord.text;
          if (currentWord.bbox && nextWord.bbox) {
            currentWord.bbox = {
              x0: Math.min(currentWord.bbox.x0, nextWord.bbox.x0),
              y0: Math.min(currentWord.bbox.y0, nextWord.bbox.y0),
              x1: Math.max(currentWord.bbox.x1, nextWord.bbox.x1),
              y1: Math.max(currentWord.bbox.y1, nextWord.bbox.y1),
            };
          }
          j++;
        }
        kataOcrSistem.push(currentWord);
      }

      const kataOcrBaru = splitMergedWords(kataOcrSistem, kataMaster);
      const teksKataOcr = kataOcrBaru.map((w) => w.text);
      const kataSalah = diffIndices(kataMaster, teksKataOcr);

      if (kataSalah.size > 0) {
        const tempLogs = [];
        let adaTypo = false;

        kataSalah.forEach((idxKata) => {
          const objekKataOcr = kataOcrBaru[idxKata];

          if (objekKataOcr) {
            const confScore = Number(objekKataOcr.confidence) || 0;
            const batasConfidence =50;

            if (confScore >= batasConfidence) {
              adaTypo = true;
              tempLogs.push(
                `  -> [TYPO DETECTED] Kata OCR ke-${idxKata + 1} salah: "${objekKataOcr.text}" (Conf: ${confScore.toFixed(2)})`,
              );
              semuaBboxSalah.push(objekKataOcr.bbox);
            }
          } else {
            adaTypo = true;
            tempLogs.push(
              `  -> Ada kata dari Master yang hilang pada posisi ke-${idxKata + 1}`,
            );
          }
        });

        if (adaTypo) {
          tulisLog(
            logOutput,
            `\n[Ayat ${nomorAyat}] Ditemukan Ketidakcocokan:`,
          );
          tulisLog(logOutput, `  Master : "${barisMaster}"`);
          tulisLog(logOutput, `  OCR    : "${barisOcrObj.text}"`);

          tempLogs.forEach((log) => tulisLog(logOutput, log));
        }
      }

      // Geser pointer master agar iterasi berikutnya tidak mundur
      masterPointer = foundIdx + 1;
    } else {
      tulisLog(
        logOutput,
        `\n[Ayat ${ocrItem.nomor}] Peringatan: Ayat dari OCR tidak ditemukan di sisa Master.`,
      );
    }
  }

  if (!semuaBboxSalah || semuaBboxSalah.length === 0) {
    tulisLog(logOutput, "[Deteksi] gambar bersih dari error");
  }

  return {
    semuaBboxSalah,
    logOutput,
  };
}

function splitMergedWords(ocrWords, masterWords) {
  const result = [];
  let masterIndex = 0;

  for (const word of ocrWords) {
    if (masterIndex >= masterWords.length) {
      result.push(word);
      continue;
    }

    // Ubah perbandingan awal agar kebal terhadap spasi
    const normWord = normalizeQuotes(word.text).replace(/\s+/g, "");
    const normMaster = normalizeQuotes(masterWords[masterIndex]).replace(
      /\s+/g,
      "",
    );

    if (normWord === normMaster) {
      result.push(word);
      masterIndex++;
      continue;
    }

    let merged = "";
    let end = masterIndex;
    let foundMerge = false;

    // Tambahkan sedikit margin toleransi panjang agar loop tidak berhenti prematur
    while (end < masterWords.length && merged.length < word.text.length + 5) {
      // PERBAIKAN 1: Gunakan spasi saat menggabungkan masterWords
      merged += (merged === "" ? "" : " ") + masterWords[end];

      // PERBAIKAN 2: Bandingkan dengan mengabaikan seluruh spasi
      const normMerged = normalizeQuotes(merged).replace(/\s+/g, "");

      if (normMerged === normWord) {
        for (let i = masterIndex; i <= end; i++) {
          result.push({
            text: masterWords[i],
            bbox: word.bbox,
            confidence: word.confidence, // KUNCI: Pastikan confidence ditransfer
          });
        }
        masterIndex = end + 1;
        foundMerge = true;
        break;
      }
      end++;
    }

    if (!foundMerge) {
      result.push(word);
      masterIndex++;
    }
  }

  return result;
}

function levenshteinMatrix(correctList, ocrList) {
  const n = correctList.length;
  const m = ocrList.length;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Perbandingan karakter/kata dengan toleransi tanda kutip
      const cost =
        normalizeQuotes(correctList[i - 1]) === normalizeQuotes(ocrList[j - 1])
          ? 0
          : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp;
}

function diffIndices(correctList, ocrList) {
  const dp = levenshteinMatrix(correctList, ocrList);
  let i = correctList.length;
  let j = ocrList.length;
  const wrongIndices = new Set();

  while (i > 0 || j > 0) {
    if (i === 0) {
      wrongIndices.add(j - 1);
      j--;
      continue;
    }
    if (j === 0) {
      i--;
      continue;
    }

    // Perbandingan saat backtracking dengan toleransi tanda kutip
    const cost =
      normalizeQuotes(correctList[i - 1]) === normalizeQuotes(ocrList[j - 1])
        ? 0
        : 1;

    if (dp[i][j] === dp[i - 1][j - 1] + cost) {
      if (cost === 1) {
        wrongIndices.add(j - 1);
      }
      i--;
      j--;
    } else if (dp[i][j] === dp[i][j - 1] + 1) {
      wrongIndices.add(j - 1);
      j--;
    } else {
      i--;
    }
  }
  return wrongIndices;
}

module.exports = { jalankanApp };