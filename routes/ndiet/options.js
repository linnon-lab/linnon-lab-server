const express = require("express");
const router = express.Router();
const {
  getDatabase, getMasterList, queryAllPages, extractPropertyOptions,
  getTitleText, getMultiSelectText, getSelectText, getStatusText,
  getRelationIds, getRichTextPlainText,
} = require("../../lib/notionHelpers");

router.get("/options", async (req, res) => {
  try {
    const notionToken = req.headers["x-notion-token"] || process.env.NOTION_TOKEN;
    const detailLogDbId = req.headers["x-detail-log-db-id"] || null;
    const mealMasterDbId = req.headers["x-meal-master-db-id"] || null;
    const exerciseMasterDbId = req.headers["x-exercise-master-db-id"] || null;
    if (!notionToken || !detailLogDbId || !mealMasterDbId || !exerciseMasterDbId) {
      return res.status(400).json({ ok: false, message: "必要なパラメータが不足しています" });
    }
    const detailProps = (await getDatabase(detailLogDbId, notionToken)).properties || {};
    const mealMasters = await getMasterList(mealMasterDbId, "タイトル", notionToken);
    const exerciseMasters = await getMasterList(exerciseMasterDbId, "名前", notionToken);
    return res.json({
      ok: true,
      options: {
        conditionStatus: extractPropertyOptions(detailProps, "体調状態"),
        bowelStatus: extractPropertyOptions(detailProps, "便状態"),
        weather: extractPropertyOptions(detailProps, "天気"),
        source: extractPropertyOptions(detailProps, "取得元"),
        mealCategory: extractPropertyOptions(detailProps, "食事区分"),
        mealMasters,
        exerciseMasters,
      },
    });
  } catch (error) {
    console.error("options error:", error);
    return res.status(500).json({ ok: false, message: `オプション取得失敗: ${error.message}` });
  }
});

router.get("/logs", async (req, res) => {
  try {
    const notionToken = req.headers["x-notion-token"] || process.env.NOTION_TOKEN;
    const detailLogDbId = req.headers["x-detail-log-db-id"] || null;
    if (!notionToken || !detailLogDbId) {
      return res.status(400).json({ ok: false, message: "必要なパラメータが不足しています" });
    }
    const data = await queryAllPages(
      detailLogDbId,
      { sorts: [{ property: "記録日", direction: "descending" }] },
      notionToken,
    );
    const rawResults = Array.isArray(data.results) ? data.results : [];
    const logs = rawResults.map((page) => {
      const props = page.properties || {};
      return {
        id: page.id,
        title: getTitleText(props["名前"]),
        recordDate: props["記録日"]?.date?.start || null,
        recordType: getMultiSelectText(props["記録種別"]) || null,
        source: getSelectText(props["取得元"]) || null,
        confirmed: getSelectText(props["確定状態"]) || getStatusText(props["確定状態"]) || null,
        weight: props["体重"]?.number ?? null,
        mealCategory: getSelectText(props["食事区分"]) || null,
        mealMasterIds: getRelationIds(props["食事マスタ"]),
        quantity: props["数量"]?.number ?? null,
        intakeCalories: props["摂取カロリー"]?.number ?? null,
        exerciseMasterIds: getRelationIds(props["運動マスタ"]),
        exerciseMinutes: props["運動時間(分)"]?.number ?? null,
        exerciseCount: props["運動回数"]?.number ?? null,
        distanceKm: props["運動距離"]?.number ?? null,
        burnCalories: props["消費カロリー"]?.number ?? null,
        conditionStatus: getMultiSelectText(props["体調状態"]) || getSelectText(props["体調状態"]) || null,
        bodyTemperature: props["体温"]?.number ?? null,
        weather: getMultiSelectText(props["天気"]) || getSelectText(props["天気"]) || null,
        temperature: props["気温"]?.number ?? null,
        humidity: props["湿度"]?.number ?? null,
        pressure: props["気圧"]?.number ?? null,
        photoUrls: Array.isArray(props["写真"]?.files)
          ? props["写真"].files.map((f) => f?.external?.url || f?.file?.url).filter(Boolean)
          : [],
        bedTime: props["就寝時間"]?.date?.start || null,
        wakeTime: props["起床時間"]?.date?.start || null,
        memo: getRichTextPlainText(props["入力メモ"]),
        aiSummary: getRichTextPlainText(props["AI整理"]),
        aiMemo: getRichTextPlainText(props["AI一言メモ"]),
        displayText: props["表示用テキスト"]?.formula?.string ?? "",
      };
    });
    return res.json({ ok: true, count: logs.length, logs });
  } catch (error) {
    console.error("logs error:", error);
    return res.status(500).json({ ok: false, message: `取得失敗: ${error.message}` });
  }
});

module.exports = router;
