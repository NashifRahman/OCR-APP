const fs = require("fs");

async function baca(isi) {
  try {
    const data = await fs.promises.readFile(isi, "utf8");
    const dataJson = JSON.parse(data);

    return dataJson;
  } catch (err) {
    console.error("Error reading or parsing file:", err);
    throw err;
  }
}

async function tulis(isi) {
  const dataJson = await baca(isi);
  if (!dataJson) return;
  const data_nama = dataJson.map((item) => item.name.transliteration);
  console.log("data_nama:", data_nama);
}

async function flat(isi) {
  const dataJson = await baca(isi);

  const flatData = Array.isArray(dataJson)
    ? dataJson.flatMap((item) => item.verses)
    : [];
  const df_flat = flatData.map((item) => ({
    globalId: item.globalId,
    terjemahan: `${item.id}. ${item.terjemahan}`,
  }));

  const indexedData = df_flat.reduce((acc, curr) => {
    acc[curr.globalId] = curr.terjemahan;
    return acc;
  }, {});

  return indexedData;
}

// FUNGSI BARU: Mengekstrak semua terjemahan menjadi list kata baku yang unik
async function getKorpusKata(isi) {
  const dataJson = await baca(isi);
  const korpusSet = new Set();

  if (!Array.isArray(dataJson)) return [];

  dataJson.forEach((surah) => {
    surah.verses.forEach((ayat) => {
      // 1. Ambil terjemahan dan ubah ke huruf kecil
      let teks = ayat.terjemahan.toLowerCase().normalize("NFC");
      teks = teks.replace(/[‘’`]/g, "'");

      // 2. Hapus karakter selain huruf (\p{L}), angka (\p{N}), strip (-), dan petik (')
      // Hapus nomor ayat di awal jika ada (opsional, tergantung kebutuhan Levenshtein per kata)
      teks = teks.replace(/[^\p{L}\p{N}\-']/gu, " ");

      // 3. Pecah berdasarkan spasi
      const kataKata = teks.split(/\s+/);

      // 4. Masukkan ke Set untuk memastikan keunikan
      kataKata.forEach((kata) => {
        // Hanya masukkan kata yang memiliki panjang > 1 (abaikan karakter tunggal tak bermakna)
        if (kata.length <= 1) return;
        // Kata asli
        korpusSet.add(kata);

        // Jika mengandung tanda hubung di tengah
        const idx = kata.indexOf("-");
        if (idx > 0 && idx < kata.length - 1) {
          const kiri = kata.slice(0, idx) + "-";
          const kanan = kata.slice(idx + 1);

          if (kiri.length > 1) {
            korpusSet.add(kiri);
          }

          if (kanan.length > 1) {
            korpusSet.add(kanan);
          }
        }
      });
    });
  });

  // Kembalikan dalam bentuk Array
  return Array.from(korpusSet);
}

// tulis('coba.json');
module.exports = {
  baca,
  tulis,
  flat,
  getKorpusKata,
};
