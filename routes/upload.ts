import express from "express";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2 } from "../r2";

const router = express.Router();

router.post("/get-upload-url", async (req, res) => {
  try {
    const { type } = req.body;

    const ext = type === "video" ? "mp4" : "jpg";

    const key = `uploads/${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      ContentType: type === "video" ? "video/mp4" : "image/jpeg",
    });

    const uploadUrl = await getSignedUrl(r2, command, {
      expiresIn: 60,
    });

    const fileUrl = `https://pub-${process.env.CF_ACCOUNT_ID}.r2.dev/${key}`;

    res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed to generate URL" });
  }
});

export default router;