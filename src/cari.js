const fuzz = require('fuzzball');
const { performance } = require('perf_hooks');
const { baca, tulis, flat } = require('./json_read_write');


class TwoStageRetriever {
    /**
     * @param {Array<Object>} dataArray - Array of objects (berfungsi seperti DataFrame)
     * @param {String} textColumn - Nama key untuk teks yang akan dicari
     * @param {String} idColumn - Nama key untuk ID (default: 'globalId')
     */
    constructor(dataArray, textColumn, idColumn = 'globalId') {
        this.dataArray = dataArray;
        this.textColumn = textColumn;
        this.idColumn = idColumn;

        // Mengekstrak array teks (corpus)
        this.corpus = dataArray.map(row => row[textColumn]);
        
        // Properti untuk menyimpan model TF-IDF
        this.dfDocs = []; // Simpan frekuensi n-gram tiap dokumen
        this.idf = {};    // Simpan nilai Inverse Document Frequency
        this.tfidfDocs = []; // Simpan vektor TF-IDF tiap dokumen (Sparse Object)

        console.log("[Retriever] Membangun indeks TF-IDF (char_wb, n-gram 3-5)...");
        this.buildIndex();
        console.log(`[Retriever] Indeks selesai dibuat untuk ${this.corpus.length} dokumen.`);
    }

    /**
     * Meniru parameter analyzer='char_wb', ngram_range=(3,5) dari scikit-learn
     */
    getCharNgrams(text, minN = 3, maxN = 5) {
        // Hapus tanda baca berlebih dan pisahkan berdasarkan spasi
        const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
        const ngrams = {};

        for (const word of words) {
            if (!word) continue;
            // Pad kata dengan spasi (aturan char_wb)
            const padded = ` ${word} `;
            for (let n = minN; n <= maxN; n++) {
                for (let i = 0; i <= padded.length - n; i++) {
                    const gram = padded.slice(i, i + n);
                    ngrams[gram] = (ngrams[gram] || 0) + 1;
                }
            }
        }
        return ngrams;
    }

    /**
     * FASE PRE-COMPUTING
     */
    buildIndex() {
        const N = this.corpus.length;
        const dfCount = {}; // Menyimpan Document Frequency

        // 1. Hitung Term Frequency (TF) dan Document Frequency (DF)
        for (let i = 0; i < N; i++) {
            const ngrams = this.getCharNgrams(this.corpus[i]);
            this.dfDocs.push(ngrams);
            
            // Catat kemunculan gram unik di dokumen ini
            for (const gram of Object.keys(ngrams)) {
                dfCount[gram] = (dfCount[gram] || 0) + 1;
            }
        }

        // 2. Hitung IDF (Formula standar scikit-learn: log((1+N)/(1+df)) + 1)
        for (const gram in dfCount) {
            this.idf[gram] = Math.log((1 + N) / (1 + dfCount[gram])) + 1;
        }

        // 3. Hitung Vektor TF-IDF dan Normalisasi L2 (Cosine Normalization)
        for (let i = 0; i < N; i++) {
            const tfidf = {};
            let sumSq = 0;
            for (const gram in this.dfDocs[i]) {
                const weight = this.dfDocs[i][gram] * this.idf[gram];
                tfidf[gram] = weight;
                sumSq += weight * weight;
            }
            // Normalisasi vektor agar perhitungan Cosine Similarity jadi lebih cepat
            const norm = Math.sqrt(sumSq) || 1;
            for (const gram in tfidf) {
                tfidf[gram] = tfidf[gram] / norm;
            }
            this.tfidfDocs.push(tfidf);
        }
    }

    /**
     * Mengubah teks query menjadi Vektor TF-IDF
     */
    transformQuery(queryText) {
        const ngrams = this.getCharNgrams(queryText);
        const tfidf = {};
        let sumSq = 0;
        
        for (const gram in ngrams) {
            if (this.idf[gram]) { // Hanya hitung n-gram yang ada di vocabulary
                const weight = ngrams[gram] * this.idf[gram];
                tfidf[gram] = weight;
                sumSq += weight * weight;
            }
        }
        
        const norm = Math.sqrt(sumSq) || 1;
        for (const gram in tfidf) {
            tfidf[gram] = tfidf[gram] / norm;
        }
        return tfidf;
    }

    /**
     * Perkalian titik (Dot Product) dari 2 vektor yang sudah di-L2 norm = Cosine Similarity
     */
    cosineSimilarity(vec1, vec2) {
        let dotProduct = 0;
        // Iterasi pada vektor yang kuncinya lebih sedikit untuk performa ekstra
        for (const k in vec1) {
            if (vec2[k]) {
                dotProduct += vec1[k] * vec2[k];
            }
        }
        return dotProduct;
    }

    cariAyat(queryTeks, topKStage1 = 10, thresholdFuzz = 80.0) {
        // ==========================================
        // STAGE 1: Penyaringan Cepat (TF-IDF Cosine)
        // ==========================================
        const queryVec = this.transformQuery(queryTeks);
        const similarities = [];

        for (let i = 0; i < this.tfidfDocs.length; i++) {
            const score = this.cosineSimilarity(queryVec, this.tfidfDocs[i]);
            similarities.push({ index: i, score: score });
        }

        // Urutkan menurun dan ambil Top K
        similarities.sort((a, b) => b.score - a.score);
        const topKIndices = similarities.slice(0, topKStage1);

        // ==========================================
        // STAGE 2: Penilaian Akurat (Fuzzball/Levenshtein)
        // ==========================================
        let skorTertinggi = 0;
        let idTerpilih = null;
        let teksTerpilih = null;

        for (const item of topKIndices) {
            const idx = item.index;
            const kandidatTeks = this.corpus[idx];

            // fuzzball.ratio mengembalikan 0-100 (mirip rapidfuzz)
            const skorFuzz = fuzz.ratio(queryTeks.toLowerCase(), kandidatTeks.toLowerCase());

            if (skorFuzz > skorTertinggi) {
                skorTertinggi = skorFuzz;
                idTerpilih = this.dataArray[idx][this.idColumn];
                teksTerpilih = kandidatTeks;
            }
        }

        if (skorTertinggi >= thresholdFuzz) {
            return {
                global_id: idTerpilih,
                skor_kemiripan: skorTertinggi,
                teks_ditemukan: teksTerpilih
            };
        }

        return null;
    }
}


// Ekspor kelas agar bisa di-require di file lain
module.exports = { TwoStageRetriever };

// =====================================================================
// CONTOH PENGGUNAAN PADA DATA ANDA
// =====================================================================
// if (require.main === module) {
//     // Bungkus dengan fungsi async anonim yang langsung dieksekusi
//     (async () => {
//         try {
//             // Sekarang await bisa digunakan tanpa error
//             const indexedDataRaw = await flat('coba.json');
//             const indexedData = Object.entries(indexedDataRaw).map(([globalId, terjemahan]) => ({ globalId, terjemahan }));

//             console.log(indexedData.slice(0, 5)); // Tampilkan 5 data pertama untuk verifikasi

//             // 1. Inisialisasi
//             const retriever = new TwoStageRetriever(indexedData, 'terjemahan', 'globalId');

//             // Query hasil OCR kotor
//             const queryStart = "Tentang apakah mereka saling bertanya?";
//             const queryEnd = "dan kebun-kebun yang rindang.";

//             // Fungsi utilitas untuk mengukur waktu eksekusi
//             function timeIt(fn) {
//                 const start = performance.now();
//                 const result = fn();
//                 const end = performance.now();
//                 return { result, timeMs: (end - start).toFixed(2) };
//             }

//             // 3. Eksekusi Pencarian
//             const startData = timeIt(() => retriever.cariAyat(queryStart));
//             console.log(`\nWaktu eksekusi (Start): ${startData.timeMs} ms`);

//             const endData = timeIt(() => retriever.cariAyat(queryEnd));
//             console.log(`Waktu eksekusi (End): ${endData.timeMs} ms`);

//             // Output Hasil
//             console.log("\n--- HASIL PENCARIAN ---");
//             if (startData.result) {
//                 console.log(`Start ID : ${startData.result.global_id} (Skor: ${startData.result.skor_kemiripan}%)`);
//                 console.log(`Teks Asli: ${startData.result.teks_ditemukan}`);
//             } else {
//                 console.log("Start ID tidak ditemukan.");
//             }

//             if (endData.result) {
//                 console.log(`\nEnd ID   : ${endData.result.global_id} (Skor: ${endData.result.skor_kemiripan}%)`);
//                 console.log(`Teks Asli: ${endData.result.teks_ditemukan}`);
//             } else {
//                 console.log("\nEnd ID tidak ditemukan.");
//             }

//             if (!startData.result || !endData.result) {
//                 console.log("\nTidak ada hasil yang ditemukan untuk salah satu/kedua query.");
//             } else {
//                 const startIndex = indexedData.findIndex(item => item.globalId === startData.result.global_id);
//                 const endIndex = indexedData.findIndex(item => item.globalId === endData.result.global_id);

//                 // Validasi tambahan
//                 if (startIndex !== -1 && endIndex !== -1) {
//                     const minIdx = Math.min(startIndex, endIndex);
//                     const maxIdx = Math.max(startIndex, endIndex);
                    
//                     const df_hasil = indexedData.slice(minIdx, maxIdx + 1);
                    
//                     const hasil_akhir = df_hasil.map(item => item.terjemahan).join('\n');
//                     console.log("\n--- HASIL AKHIR ---");
//                     console.log(hasil_akhir);
//                 } else {
//                     console.log("Error: global_id ditemukan tetapi tidak ada di dalam array.");
//                 }
//             }
//         } catch (error) {
//             console.error("Terjadi kesalahan saat memproses data:", error);
//         }
//     })();
// }