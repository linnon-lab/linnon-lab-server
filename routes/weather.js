const express = require("express");
const router = express.Router();
const {
  getMultiSelectText, setTitle, setDate, setNumber, setSelect, setMultiSelect,
  queryAllPages, createPage,
} = require("../lib/notionHelpers");

router.post("/auto-fill", async (req, res) => {
  const { notionToken, detailLogDbId, region } = req.body;
  if (!notionToken || !detailLogDbId || !region) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const geoRes = await fetch(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(region)}`
    );
    const geoData = await geoRes.json();
    if (!geoData || geoData.length === 0) {
      return res.status(400).json({ ok: false, message: "地域が見つかりませんでした" });
    }
    const [longitude, latitude] = geoData[0].geometry.coordinates;
    const today = new Date();
    today.setDate(today.getDate() - 1);
    const yesterday = today.toISOString().split("T")[0];
    const logsData = await queryAllPages(
      detailLogDbId,
      { sorts: [{ property: "記録日", direction: "descending" }] },
      notionToken,
    );
    const allLogs = logsData.results || [];
    const datesWithLogs = new Set();
    const weatherFilledDates = new Set();
    for (const page of allLogs) {
      const props = page.properties || {};
      const date = props["記録日"]?.date?.start;
      if (!date || date > yesterday) continue;
      const recordType = getMultiSelectText(props["記録種別"]);
      if (recordType.includes("天気")) {
        weatherFilledDates.add(date);
      } else {
        datesWithLogs.add(date);
      }
    }
    const targetDates = [...datesWithLogs].filter((d) => !weatherFilledDates.has(d)).sort();
    if (targetDates.length === 0) {
      return res.json({ ok: true, filledCount: 0, message: "補完対象の日付がありません" });
    }
    const startDate = targetDates[0];
    const endDate = targetDates[targetDates.length - 1];
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,pressure_msl_mean,relative_humidity_2m_mean&timezone=Asia%2FTokyo&start_date=${startDate}&end_date=${endDate}`
    );
    const weatherData = await weatherRes.json();
    const weatherCodeToText = (code) => {
      if (code === 0) return "晴れ";
      if (code <= 3) return "曇り";
      if (code <= 67) return "雨";
      if (code <= 77) return "雪";
      if (code <= 99) return "雨";
      return "曇り";
    };
    const dailyDates = weatherData.daily?.time || [];
    const weatherCodes = weatherData.daily?.weathercode || [];
    const tempMax = weatherData.daily?.temperature_2m_max || [];
    const tempMin = weatherData.daily?.temperature_2m_min || [];
    const pressures = weatherData.daily?.pressure_msl_mean || [];
    const humidities = weatherData.daily?.relative_humidity_2m_mean || [];
    let filledCount = 0;
    for (let i = 0; i < dailyDates.length; i++) {
      const date = dailyDates[i];
      if (!targetDates.includes(date)) continue;
      const weatherText = weatherCodeToText(weatherCodes[i]);
      const temperature = Math.round((tempMax[i] + tempMin[i]) / 2);
      const pressure = pressures[i] ? Math.round(pressures[i]) : null;
      const properties = {};
      setTitle(properties, "名前", `${date} | 天気`);
      setDate(properties, "記録日", date);
      setMultiSelect(properties, "記録種別", "天気");
      setMultiSelect(properties, "天気", weatherText);
      setNumber(properties, "気温", temperature);
      setNumber(properties, "湿度", humidities[i] ? Math.round(humidities[i]) : null);
      setNumber(properties, "気圧", pressure);
      setSelect(properties, "取得元", "自動");
      setSelect(properties, "確定状態", "確定");
      await createPage(detailLogDbId, properties, notionToken);
      filledCount++;
    }
    return res.json({ ok: true, filledCount, message: `${filledCount}日分の天気を補完しました` });
  } catch (e) {
    console.error("[天気補完] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
