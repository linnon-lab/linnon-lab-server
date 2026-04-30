require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "server is running" });
});

const ndietNotionRouter = require("./routes/ndiet/notion");
const ndietAiRouter = require("./routes/ndiet/ai");
const ndietOptionsRouter = require("./routes/ndiet/options");
const oauthRouter = require("./routes/oauth");
const cloudinaryRouter = require("./routes/cloudinary");
const weatherRouter = require("./routes/weather");
const doujinNotionRouter = require("./routes/doujin/notion");

app.use("/api/notion", ndietNotionRouter);
app.use("/api/ai", ndietAiRouter.router);
app.use("/api/oauth", oauthRouter);
app.use("/api/cloudinary", cloudinaryRouter);
app.use("/api/weather", weatherRouter);
app.use("/api/doujin/notion", doujinNotionRouter);
app.use("/api", ndietOptionsRouter);

app.listen(PORT, () => {
  console.log(`server started: http://localhost:${PORT}`);
});
