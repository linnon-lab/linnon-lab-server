const express = require("express");
const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, message: "doujin router is ready" });
});

module.exports = router;
