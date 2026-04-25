import express, { Request, Response } from "express";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2 } from "../r2";

const router = express.Router();

router.post("/get-upload-url", async (req: Request, res: Response) => {
  try {
    const { type } = req.body;

    const extension = type === "video" ? "mp4" : "jpg";

    const fileName = `uploads/${Date.now()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: fileName,
      ContentType: type === "video" ? "video/mp4" : "image/jpeg",
    });

    const uploadUrl = await getSignedUrl(r2, command, {
      expiresIn: 60,
    });

    const fileUrl = `https://pub-${process.env.CF_ACCOUNT_ID}.r2.dev/${fileName}`;

    res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed to generate URL" });
  }
});

export default router;