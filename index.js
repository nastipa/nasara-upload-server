const express = require("express");
const multer = require("multer");
const cors = require("cors");
const AWS = require("aws-sdk");
require("dotenv").config();

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

/* ================= R2 CONFIG ================= */
const s3 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: "v4",
  region: "auto",
});

/* ================= UPLOAD ROUTE ================= */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileName = Date.now() + "-" + file.originalname;

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    const result = await s3.upload(params).promise();

   const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

return res.json({
  success: true,
  url: publicUrl, // ✅ CORRECT
});
  } catch (err) {
    console.log("Upload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ================= START SERVER ================= */
app.listen(3000, "0.0.0.0", () => {
  console.log("🚀 Server running on all interfaces");
});