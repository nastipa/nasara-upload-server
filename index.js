const express = require("express");
const multer = require("multer");
const cors = require("cors");
const AWS = require("aws-sdk");
const PDFDocument = require("pdfkit");
require("dotenv").config();


const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");


const app = express();
app.use(cors());
app.use(express.json());

/* ================= LIMIT FILE SIZE (20MB) ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
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
/* ================= NOTIFICATION HELPER ================= */
async function notifyUser(userId, title, body) {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("push_token")
    .eq("id", userId)
    .single();
  if (!data?.push_token) return;

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: data.push_token,
      sound: "default",
      title,
      body,
    }),
  });
}
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
/* ================= CREATE ADMIN ================= */
app.post("/create-admin", async (req, res) => {
  try {
    const { email, password, full_name, system } = req.body;
    // system = "nasara" OR "coalition" OR "utilities"

    if (!email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1. Create Auth user
    const { data, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = data.user.id;

    // 2. Insert into correct table
    if (system === "nasara") {
      const { error } = await supabaseAdmin
        .from("admins")
        .insert({
          user_id: userId,
          role: "admin",
        });

      if (error) return res.status(400).json({ error: error.message });
    }

    if (system === "coalition") {
      const { error } = await supabaseAdmin
        .from("coalition_admins")
        .insert({
          user_id: userId,
          full_name,
          role: "admin",
        });

      if (error) return res.status(400).json({ error: error.message });
    }
    
    if (system === "utilities") {
  const { error } = await supabaseAdmin
    .from("utilities_admins")
    .insert({
      user_id: userId,
      full_name,
      role: "admin",
    });

  if (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
}

    return res.json({
      success: true,
      user_id: userId,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= CREATE CONSTITUENCY ADMIN ================= */
app.post("/create-constituency-admin", async (req, res) => {
  try {
    const { email, password, full_name, constituency } = req.body;

    if (!email || !password || !constituency) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1. active election
    const { data: election, error: electionError } = await supabaseAdmin
      .from("election")
      .select("id")
      .eq("status", "active")
      .single();

    if (electionError || !election) {
      return res.status(400).json({ error: "No active election" });
    }

    let constituencyRow;

    // 2. check if constituency exists
    const { data: existing } = await supabaseAdmin
      .from("constituencies")
      .select("id, name")
      .ilike("name", constituency.trim())
      .maybeSingle();

    // 3. IF EXISTS → use it
    if (existing) {
      constituencyRow = existing;
    } 
    // 4. IF NOT EXISTS → CREATE NEW
    else {
      const { data: newConstituency, error: createError } =
        await supabaseAdmin
          .from("constituencies")
          .insert({
            name: constituency.trim(),
          })
          .select("id, name")
          .single();

      if (createError) {
        return res.status(400).json({ error: createError.message });
      }

      constituencyRow = newConstituency;
    }

    // 5. create auth user
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // 6. insert constituency admin
    const { error: insertError } = await supabaseAdmin
      .from("constituency_admins")
      .insert({
        user_id: userId,
        full_name,
        email,
        constituency: constituencyRow.name,
        constituency_id: constituencyRow.id,
        election_id: election.id,
        active: true,
      });

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    return res.json({
      success: true,
      user_id: userId,
      constituency_id: constituencyRow.id,
      election_id: election.id,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= REMOVE ADMIN ================= */
app.post("/remove-admin", async (req, res) => {
  try {
    const { userId, system } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    // remove from correct table
    if (system === "nasara") {
      const { error } = await supabaseAdmin
        .from("admins")
        .delete()
        .eq("user_id", userId);

      if (error) return res.status(400).json({ error: error.message });
    }

    if (system === "coalition") {
      const { error } = await supabaseAdmin
        .from("coalition_admins")
        .delete()
        .eq("user_id", userId);

      if (error) return res.status(400).json({ error: error.message });
    }
    if (system === "utilities") {
  const { error } = await supabaseAdmin
    .from("utilities_admins")
    .delete()
    .eq("user_id", userId);

  if (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
}

    return res.json({
      success: true,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= REMOVE CONSTITUENCY ADMIN ================= */
app.post("/remove-constituency-admin", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    // 1. remove from constituency_admins
    const { error: dbError } = await supabaseAdmin
      .from("constituency_admins")
      .delete()
      .eq("user_id", userId);

    if (dbError) {
      return res.status(400).json({ error: dbError.message });
    }

    // 2. delete auth user (important cleanup)
    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    return res.json({
      success: true,
      message: "Constituency admin removed",
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= SECURE DELETE ACCOUNT ================= */
app.post("/delete-account", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const { data, error: userError } =
      await supabaseAdmin.auth.getUser(token);

    if (userError || !data?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user_id = data.user.id;

    const { error } =
      await supabaseAdmin.auth.admin.deleteUser(user_id);

    if (error) {
      console.log("DELETE ERROR:", error);
      return res.status(500).json({
        error: error.message,
      });
    }

    return res.json({ success: true });

  } catch (err) {
    console.log("Delete error:", err);
    return res.status(500).json({
      error: "Delete failed",
    });
  }
});
/* ================= SEND PUSH ================= */

async function sendPush(
  tokens,
  title,
  body,
  data = {}
) {
  const messages =
    tokens.map((token) => ({
      to: token,

      sound: "default",

      title,

      body,

      data,

      priority: "high",

      channelId:
        "default",
    }));

  await fetch(
    "https://exp.host/--/api/v2/push/send",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(
        messages
      ),
    }
  );
}
/* ================= QUOTATION PDF ================= */


app.get("/quotation-pdf/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data } = await supabaseAdmin
      .from("utility_quotations")
      .select(", utility_applications()")
      .eq("id", id)
      .single();

    if (!data) {
      return res.status(404).json({ error: "Not found" });
    }

    const doc = new PDFDocument();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=quotation-${id}.pdf`
    );

    doc.pipe(res);

    doc.fontSize(16).text(
      "NATIONAL ELECTRICITY DISTRIBUTION COMPANY (NEDCo)",
      { align: "center" }
    );

    doc.moveDown();

    doc.fontSize(14).text(
      "QUOTATION FOR ELECTRICITY SUPPLY",
      { align: "center" }
    );

    doc.moveDown();

    doc.fontSize(12).text(`Reference ID: ${data.application_id}`);
    doc.text(`Applicant: ${data.utility_applications.full_name}`);
    doc.text(`Address: ${data.utility_applications.address}`);
    doc.text(`Amount: GH₵${data.amount}`);

    doc.moveDown();

    doc.text(data.letter_text || "");

    doc.moveDown(2);

    doc.text("__________");
    doc.text("NEDCo Utility Administrator");

    doc.end();
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

/* ================= PUSH ROUTE ================= */
app.post("/send-push", async (req, res) => {
  try {
    const { title, body, type, ref_id } = req.body;

    const { data: users } = await supabaseAdmin
      .from("profiles")
      .select("push_token");

    const tokens = users
      ?.map((u) => u.push_token)
      .filter(Boolean);

    if (!tokens || tokens.length === 0) {
      return res.json({ success: true });
    }

    // 🔥 use helper
   await sendPush(
  tokens,
  title,
  body,
  {
    type,
    ref_id,
  }
);

    res.json({ success: true });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Push failed" });
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