const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const AdmZip = require("adm-zip");

const { hasilAkhir } = require("./ocr_backend");
const { jalankanApp } = require("./banding");
const { Gambar } = require("./gambar");
const { convertPdfToImages, extractZipToImages } = require("./image_extract");

const app = express();
const cleanupTasks = new Map(); // Map untuk menyimpan daftar berkas sementara per clientId
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("downloads")) fs.mkdirSync("downloads");

// --- PENYIMPANAN KONEKSI SSE ---
const sseClients = new Map();

// Fungsi pembantu untuk mengirim progress ke frontend
function sendProgress(clientId, message, percentage) {
  if (!clientId) return;
  const clientRes = sseClients.get(clientId);
  if (clientRes) {
    clientRes.write(`data: ${JSON.stringify({ message, percentage })}\n\n`);
  }
}

// --- ENDPOINT BARU: TRACK KONEKSI SSE ---
app.get("/api/ocr/progress/:clientId", (req, res) => {
  const { clientId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Simpan respon objek ke dalam Map berdasarkan clientId
  sseClients.set(clientId, res);
  console.log(`[SSE] Client tersambung: ${clientId}`);

  // Hapus dari map jika client menutup halaman atau memutuskan koneksi
  req.on("close", () => {
    sseClients.delete(clientId);
    console.log(`[SSE] Client terputus: ${clientId}`);
  });
});

// --- ENDPOINT UTAMA: PROSES OCR (DENGAN PEMBARUAN PROGRESS) ---
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  const clientId = req.query.clientId; // Ambil clientId dari query string

  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "File tidak ditemukan." });
  }

  sendProgress(clientId, "Mengunggah dan menyiapkan berkas...", 10);

  const tempPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const inputFilePath = tempPath + ext;
  fs.renameSync(tempPath, inputFilePath);

  let filesToProcess = [];
  let tempDirsToDelete = [];
  let tempFilesToDelete = [];

  try {
    if (ext === ".pdf") {
      sendProgress(clientId, "Mengekstrak halaman dari berkas PDF...", 20);
      const { outputDir, files } = await convertPdfToImages(inputFilePath);
      filesToProcess.push(...files);
      tempDirsToDelete.push(outputDir);
      tempFilesToDelete.push(...files);
    } else if (ext === ".zip") {
      sendProgress(clientId, "Mengekstrak gambar dari berkas ZIP...", 20);
      const { outputDir, files } = await extractZipToImages(inputFilePath);
      filesToProcess.push(...files);
      tempDirsToDelete.push(outputDir);
      tempFilesToDelete.push(...files);
    } else {
      filesToProcess.push(inputFilePath);
    }

    if (filesToProcess.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Tidak ada berkas gambar valid." });
    }

    sendProgress(clientId, "Menjalankan proses OCR mendeteksi teks...", 40);
    const dataHasil = await hasilAkhir(filesToProcess, "ind");

    let annotatedFiles = [];
    let firstPageBase64 = "";

    // Loop proses pencocokan dan anotasi gambar
    for (let i = 0; i < dataHasil.length; i++) {
      const totalPage = dataHasil.length;
      sendProgress(
        clientId,
        `Mencocokkan teks & membuat anotasi halaman (${i + 1}/${totalPage})...`,
        Math.round(50 + (i / totalPage) * 30),
      );

      const dokumenSistem = dataHasil[i];
      const gambarAsli = dokumenSistem.file;
      const textOCR = dokumenSistem.Data_OCR;
      const textMaster = dokumenSistem.Data_Master;

      const LogAndCompare = await jalankanApp(textOCR, textMaster);
      const koordinatSalah = LogAndCompare.semuaBboxSalah;

      const fileExtension = path.extname(gambarAsli);
      const fileBaseName = path.basename(gambarAsli, fileExtension);

      const gambarOutput = path.join(
        __dirname,
        "downloads",
        `${fileBaseName}_annotated${fileExtension}`,
      );
      await Gambar(gambarAsli, koordinatSalah, gambarOutput);

      annotatedFiles.push(gambarOutput);

      if (i === 0) {
        const imageBuffer = fs.readFileSync(gambarOutput);
        firstPageBase64 = `data:image/${fileExtension.replace(".", "")};base64,${imageBuffer.toString("base64")}`;
      }

      if (
        gambarAsli !== dokumenSistem.originalFile &&
        fs.existsSync(gambarAsli)
      ) {
        try {
          fs.unlinkSync(gambarAsli);
          console.log(`[Cleanup] Menghapus preprocessed file: ${gambarAsli}`);
        } catch (e) {
          console.error(
            `[Cleanup Error] Gagal hapus preprocessed file: ${e.message}`,
          );
        }
      }
    }

    let downloadFileName = "";
    const isMultiPage =
      annotatedFiles.length > 1 || ext === ".pdf" || ext === ".zip";

    if (isMultiPage) {
      sendProgress(
        clientId,
        "Mengompres hasil koreksi menjadi berkas ZIP...",
        85,
      );
      const zip = new AdmZip();
      annotatedFiles.forEach((filePath) => {
        zip.addLocalFile(filePath);
      });

      downloadFileName = `Hasil_Koreksi_${Date.now()}.zip`;
      cleanupTasks.set(downloadFileName, {
        tempFiles: [...tempFilesToDelete],
        tempDirs: [...tempDirsToDelete],
      }); // Simpan daftar berkas untuk dihapus nanti
      zip.writeZip(path.join(__dirname, "downloads", downloadFileName));

      annotatedFiles.forEach((file) => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
    } else {
      downloadFileName = path.basename(annotatedFiles[0]);
    }

    sendProgress(clientId, "Membersihkan berkas sementara backend...", 95);
    if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    tempFilesToDelete.forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    tempDirsToDelete.forEach((d) => {
      if (fs.existsSync(d)) fs.rmdirSync(d);
    });

    sendProgress(clientId, "Proses selesai!", 100);

    res.json({
      success: true,
      annotatedImage: firstPageBase64,
      downloadUrl: `http://localhost:5000/api/download/${downloadFileName}`,
      isZip: isMultiPage,
    });
  } catch (error) {
    console.error("[Server Error]:", error);
    sendProgress(clientId, `Terjadi kegagalan: ${error.message}`, 0);
    res.status(500).json({ success: false, message: error.message });
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
});

// --- ENDPOINT BARU: DOWNLOAD & AUTO-DELETE ---
app.get("/api/download/:filename", (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.join(__dirname, "downloads", fileName);
  // const cleanupSisa = path.join(__dirname,"preprocessed", fileName);

  if (!fs.existsSync(filePath)) {
    return res
      .status(404)
      .send("File tidak ditemukan atau sudah pernah diunduh sebelumnya.");
  }

  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error(
        `[Download Error] Gagal mengunduh file ${fileName}:`,
        err.message,
      );
    } else {
      console.log(
        `[Server] Unduhan selesai untuk berkas: ${fileName}. Menjalankan auto-delete...`,
      );
      try {
        fs.unlinkSync(filePath);
        // fs.unlinkSync(path.join(__dirname, "downloads", fileName));
        console.log(
          `[Server] Berkas ${fileName} berhasil dihapus dari backend.`,
        );
      } catch (deleteError) {
        console.error(
          `[Cleanup Error] Gagal menghapus file ${fileName}:`,
          deleteError.message,
        );
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend Active on port ${PORT}`));
