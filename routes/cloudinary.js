const express = require("express");
const router = express.Router();
const crypto = require("crypto");

router.post("/upload", async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64) {
    return res.status(400).json({ ok: false, message: "画像データがありません" });
  }
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "ndiet";
    const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash("sha1").update(signStr).digest("hex");
    const formData = new URLSearchParams();
    formData.append("file", `data:${mimeType || "image/jpeg"};base64,${base64}`);
    formData.append("api_key", apiKey);
    formData.append("timestamp", timestamp);
    formData.append("signature", signature);
    formData.append("folder", folder);
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: "POST", body: formData }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "アップロード失敗");
    return res.json({ ok: true, url: data.secure_url });
  } catch (e) {
    console.error("[Cloudinary] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
