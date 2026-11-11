const { flat, getKorpusKata } = require("./json_read_write");
const { TwoStageRetriever } = require("./cari");
const fs = require("fs");

// masterDataGenerator.js

function generateMasterData(groundTruthJSON, indexedData, retriever) {
  const DataMasterJSON = {};
  const regexPemisahAyat = /(?=\b\d+\.\s)/g;

  for (const [namaFile, isiTeks] of Object.entries(groundTruthJSON)) {
    // Memecah teks dari Ground Truth menjadi array per baris
    const array_koreksi_halaman = isiTeks
      .split(regexPemisahAyat)
      .map((teks) => teks.trim())
      .filter((teks) => teks.length > 0)
      .map((teks) => ({ text: teks }));

    if (array_koreksi_halaman.length > 0) {
      const bersihkanQuery = (teks) => teks.replace(/^\d+[.,]\s*/, "").trim();

      let hasilAwal = null;
      let offsetAwal = 0;

      // Fallback pencarian awal
      while (
        !hasilAwal &&
        offsetAwal < Math.min(4, array_koreksi_halaman.length)
      ) {
        let queryBersih = bersihkanQuery(
          array_koreksi_halaman[offsetAwal].text,
        );
        hasilAwal = retriever.cariAyat(queryBersih);
        if (!hasilAwal) offsetAwal++;
      }

      let hasilAkhir = null;
      let offsetAkhir = 0;
      let indexCariAkhir = array_koreksi_halaman.length - 1;

      // Fallback pencarian akhir
      while (
        !hasilAkhir &&
        offsetAkhir < Math.min(4, array_koreksi_halaman.length)
      ) {
        let queryBersih = bersihkanQuery(
          array_koreksi_halaman[indexCariAkhir - offsetAkhir].text,
        );
        hasilAkhir = retriever.cariAyat(queryBersih);
        if (!hasilAkhir) offsetAkhir++;
      }

      // Kompensasi indeks dan eksekusi
      if (hasilAwal && hasilAkhir) {
        let startIndex = indexedData.findIndex(
          (item) => item.globalId === hasilAwal.global_id,
        );
        let endIndex = indexedData.findIndex(
          (item) => item.globalId === hasilAkhir.global_id,
        );

        if (startIndex !== -1 && endIndex !== -1) {
          startIndex = Math.max(0, startIndex - offsetAwal);
          endIndex = Math.min(indexedData.length - 1, endIndex + offsetAkhir);

          const minIdx = Math.min(startIndex, endIndex);
          const maxIdx = Math.max(startIndex, endIndex);

          const df_hasil = indexedData.slice(minIdx, maxIdx + 1);
          const hasil_akhir = df_hasil.map((item) => item.terjemahan);

          DataMasterJSON[namaFile] = hasil_akhir.join(" ");
        } else {
          console.log(
            `[WARNING] Global ID tidak ada di indexedData untuk ${namaFile}`,
          );
        }
      } else {
        console.log(`[WARNING] Pencarian gagal pada ${namaFile}`);
      }
    }
  }

  // Mengembalikan objek Data Master yang sudah utuh
  return DataMasterJSON;
}

(async () => {
  const indexedDataRaw = await flat("./data/coba.json");
  const indexedData = Object.entries(indexedDataRaw).map(
    ([globalId, terjemahan]) => ({ globalId, terjemahan }),
  );
  const ground_truth = require("./data/draft_1_ground_truth.json");
  const retriever = new TwoStageRetriever(
    indexedData,
    "terjemahan",
    "globalId",
  );
  const dataMasterKemenag = generateMasterData(
    ground_truth,
    indexedData,
    retriever,
  );
  const pathtruth = `./data/master_data.json`;
  fs.writeFileSync(
    pathtruth,
    JSON.stringify(dataMasterKemenag, null, 2),
    "utf8",
  );

  // Cek outputnya
  console.log("--- HASIL EKSTRAKSI MASTER DATA ---");
  console.log(dataMasterKemenag);
})();

// Mengekspor fungsi agar bisa digunakan di file lain (CommonJS)
module.exports = { generateMasterData };

// Catatan: Jika proyek Anda menggunakan ES Modules ("type": "module" di package.json),
// gunakan: export { generateMasterData };
