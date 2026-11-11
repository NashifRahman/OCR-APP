const fs = require("fs");

const args = process.argv.slice(2);
const namaDraft = args[0];
const pathtruth = `./data/isi_ocr_raw_${namaDraft}.json`;

// Baca file JSON
const groundTruth = JSON.parse(
  fs.readFileSync(pathtruth, "utf8")
);

let totalChars = 0;

console.log("Total karakter dalam", namaDraft);

for (const [filename, text] of Object.entries(groundTruth)) {
  // Hapus semua whitespace (spasi, tab, newline, dll.)
  const chars = text.replace(/\s/g, "");

  console.log(`${filename} : ${chars.length} karakter`);

  totalChars += chars.length;
}

// let totalWords = 0;

// console.log("Total kata dalam", namaDraft);

// for (const [filename, text] of Object.entries(groundTruth)) {
//   // Hitung jumlah kata
//   const words = text.trim().split(/\s+/).filter(Boolean);

//   console.log(`${filename} : ${words.length} kata`);

//   totalWords += words.length;
// }

console.log("-------------------------");
console.log(`Total karakter: ${totalChars}`);
// console.log(`Total karakter: ${totalWords}`);
