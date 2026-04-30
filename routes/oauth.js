const express = require("express");
const router = express.Router();

const OAUTH_CONFIG = {
  clientId: process.env.NOTION_CLIENT_ID || process.env.NOTION_OAUTH_CLIENT_ID,
  clientSecret:
    process.env.NOTION_CLIENT_SECRET || process.env.NOTION_OAUTH_CLIENT_SECRET,
  authUrl: process.env.NOTION_OAUTH_AUTH_URL,
  redirectUri:
    process.env.NOTION_REDIRECT_URI || process.env.NOTION_OAUTH_REDIRECT_URI,
};

router.get("/url", (req, res) => {
  res.json({ ok: true, url: OAUTH_CONFIG.authUrl });
});

router.post("/token", async (req, res) => {
  const { code } = req.body;
  if (!code)
    return res.status(400).json({ ok: false, message: "codeが必要です" });
  try {
    const credentials = Buffer.from(
      `${OAUTH_CONFIG.clientId}:${OAUTH_CONFIG.clientSecret}`,
    ).toString("base64");
    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: OAUTH_CONFIG.redirectUri,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "token交換失敗");
    return res.json({
      ok: true,
      access_token: data.access_token,
      workspace_name: data.workspace_name,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("codeがありません");
  res.redirect(`ndiet://oauth/callback?code=${code}`);
});

module.exports = router;
