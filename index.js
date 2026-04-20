const express = require("express");
const multer = require("multer");
const cors = require("cors");
const AWS = require("aws-sdk");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= LIMIT FILE SIZE (20MB) ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/* ================= R2 CONFIG ================= */
const s3 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: "v4",
  region: "auto",
});

/* ================= SUPABASE ADMIN ================= */
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    await s3.upload(params).promise();

    const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

    return res.json({
      success: true,
      url: publicUrl,
      key: fileName,
    });
  } catch (err) {
    console.log("Upload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ================= SECURE DELETE ACCOUNT ================= */
app.post("/delete-account", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    // 🔥 VERIFY USER
    const { data, error: userError } =
      await supabaseAdmin.auth.getUser(token);

    if (userError || !data?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user_id = data.user.id;

    /* ================= DELETE USER DATA SAFELY ================= */

    const { error: postErr } = await supabaseAdmin
      .from("posts")
      .delete()
      .eq("user_id", user_id);

    if (postErr) throw postErr;

    const { error: likeErr } = await supabaseAdmin
      .from("likes")
      .delete()
      .eq("user_id", user_id);

    if (likeErr) throw likeErr;

    const { error: commentErr } = await supabaseAdmin
      .from("comments")
      .delete()
      .eq("user_id", user_id);

    if (commentErr) throw commentErr;

    /* ================= DELETE AUTH USER ================= */
    const { error: authErr } =
      await supabaseAdmin.auth.admin.deleteUser(user_id);

    if (authErr) throw authErr;

    return res.json({ success: true });

  } catch (err) {
    console.log("Delete error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Delete failed",
    });
  }
});

/* ================= HEALTH CHECK (OPTIONAL BUT USEFUL) ================= */
app.get("/", (req, res) => {
  res.send("Nasara upload server running 🚀");
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});