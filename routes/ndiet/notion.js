const express = require("express");
const router = express.Router();
const {
  setTitle, setRichText, setDate, setNumber, setSelect, setMultiSelect, setRelation,
  notionFetch, createPage, getMasterList, getMultiSelectText, getSelectText, getRichTextPlainText,
  queryDatabase,
} = require("../../lib/notionHelpers");
const { analyzeLogWithAi, splitBulkLogWithAi } = require("./ai");

const TITLE_PROPERTY_NAME = "名前";
const AI_CONFIG = {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-2.5-flash",
};

function buildNotionPageProperties(log, titlePropertyName) {
  const properties = {};
  setTitle(
    properties,
    titlePropertyName,
    log.title || `${log.date || "未設定日"} | ${log.recordType || "未分類"}`,
  );
  setDate(properties, "記録日", log.date || null);
  setMultiSelect(properties, "記録種別", log.recordType || null);
  setRichText(properties, "入力メモ", log.inputMemo || null);
  setSelect(properties, "食事区分", log.mealCategory || null);
  setRelation(properties, "食事マスタ", log.mealMasterId || null);
  setNumber(properties, "数量", log.quantity ?? (log.mealMasterId ? 1 : null));
  setNumber(properties, "摂取カロリー", log.intakeCalories ?? null);
  setRelation(properties, "運動マスタ", log.exerciseMasterId || null);
  setNumber(properties, "運動時間(分)", log.minutes ?? null);
  setNumber(properties, "運動回数", log.count ?? null);
  setNumber(properties, "運動距離", log.distanceKm ?? null);
  setNumber(properties, "消費カロリー", log.burnCalories ?? null);
  setNumber(properties, "体重", log.weight ?? null);
  setMultiSelect(properties, "体調状態", log.conditionStatus || null);
  setNumber(properties, "体温", log.bodyTemperature ?? null);
  setMultiSelect(properties, "天気", log.weather || null);
  setNumber(properties, "気温", log.temperature ?? null);
  setNumber(properties, "湿度", log.humidity ?? null);
  setDate(properties, "就寝時間", log.bedTime || null);
  setDate(properties, "起床時間", log.wakeTime || null);
  setSelect(properties, "取得元", log.source || null);
  setSelect(properties, "確定状態", log.status || null);
  setRichText(properties, "AI整理", log.aiSummary || null);
  setRichText(properties, "AI一言メモ", log.aiOneLineMemo || null);
  if (log.photoUrls && log.photoUrls.length > 0) {
    properties["写真"] = {
      files: log.photoUrls.map((url) => ({
        type: "external",
        name: "photo",
        external: { url },
      })),
    };
  }
  return properties;
}


async function getOrCreateDailyLog(dateStr, dailyLogDbId, token) {
  const [year, month, day] = dateStr.split("-");
  const titleStr = `${parseInt(year)}年${parseInt(month)}月${parseInt(day)}日`;

  const searchResult = await notionFetch(
    `https://api.notion.com/v1/databases/${dailyLogDbId}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "日付", date: { equals: dateStr } },
      }),
    },
    token,
  );

  if (searchResult.results && searchResult.results.length > 0) {
    return { page: searchResult.results[0], isNew: false };
  }

  const newPage = await notionFetch(
    "https://api.notion.com/v1/pages",
    {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dailyLogDbId },
        template: { type: "default" },
        properties: {
          タイトル: { title: [{ text: { content: titleStr } }] },
          日付: { date: { start: dateStr } },
        },
      }),
    },
    token,
  );

  return { page: newPage, isNew: true };
}

// ↓ tokenを引数で受け取るように変更

async function addRelationToDailyLog(dailyPageId, detailPageId, token) {
  const existing = await notionFetch(
    `https://api.notion.com/v1/pages/${dailyPageId}`,
    { method: "GET" },
    token,
  );
  const existingRelations = existing.properties?.["詳細ログ"]?.relation || [];
  const alreadyLinked = existingRelations.some((r) => r.id === detailPageId);
  if (alreadyLinked) return;
  await notionFetch(
    `https://api.notion.com/v1/pages/${dailyPageId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          詳細ログ: { relation: [...existingRelations, { id: detailPageId }] },
        },
      }),
    },
    token,
  );
}

// ↓ detailLogDbIdとtokenを引数で受け取るように変更

async function analyzeTrendAndSaveToDailyLog(
  dailyPageId,
  dateStr,
  aiSettings,
  detailLogDbId,
  token,
) {
  if (!aiSettings) return;

  const past14 = new Date(dateStr);
  past14.setDate(past14.getDate() - 14);
  const past14Str = past14.toISOString().split("T")[0];

  // ↓ tokenとdbIdを渡す
  const logsData = await queryDatabase(
    detailLogDbId,
    {
      page_size: 100,
      filter: {
        and: [
          { property: "記録日", date: { on_or_after: past14Str } },
          { property: "記録日", date: { on_or_before: dateStr } },
        ],
      },
      sorts: [{ property: "記録日", direction: "descending" }],
    },
    token,
  );

  const logs = (logsData.results || []).map((page) => {
    const props = page.properties || {};
    return {
      date: props["記録日"]?.date?.start || null,
      recordType: getMultiSelectText(props["記録種別"]) || null,
      weight: props["体重"]?.number ?? null,
      intakeCalories: props["摂取カロリー"]?.number ?? null,
      burnCalories: props["消費カロリー"]?.number ?? null,
      conditionStatus:
        getMultiSelectText(props["体調状態"]) ||
        getSelectText(props["体調状態"]) ||
        null,
      exerciseMinutes: props["運動時間(分)"]?.number ?? null,
      memo: getRichTextPlainText(props["入力メモ"]) || null,
    };
  });

  if (logs.length === 0) return;

  const logSummary = logs
    .map(
      (l) =>
        `${l.date} [${l.recordType}] 体重:${l.weight ?? "-"}kg 摂取:${l.intakeCalories ?? "-"}kcal 消費:${l.burnCalories ?? "-"}kcal 体調:${l.conditionStatus ?? "-"} 運動:${l.exerciseMinutes ?? "-"}分 メモ:${l.memo ?? "-"}`,
    )
    .join("\n");

  const prompt = `あなたはダイエットサポートAIです。過去14日間の記録を分析して傾向とアドバイスをください。
出力は必ずJSONのみ。前置き不要。

【過去14日の記録】
${logSummary}

【出力ルール】
- trendMemo: 体重・食事・運動・体調それぞれの傾向を「・」から始まる箇条書きで。合計4〜8行。

JSONの形式:
{
  "trendMemo": "・傾向1\\n・傾向2\\n・傾向3\\n・傾向4"
}`;

  try {
    const provider = (aiSettings.aiProvider || "gemini").toLowerCase();
    const apiKey = aiSettings.aiApiKey;
    const model = aiSettings.aiModelName || "gemini-2.5-flash";
    let trendMemo = null;

    if (provider === "gemini") {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        },
      );
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      trendMemo = parsed.trendMemo;
    }

    if (trendMemo) {
      // ↓ tokenを渡す
      await notionFetch(
        `https://api.notion.com/v1/pages/${dailyPageId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            properties: {
              AI傾向メモ: { rich_text: [{ text: { content: trendMemo } }] },
            },
          }),
        },
        token,
      );
      console.log("[AI傾向] 日次記録に傾向メモを保存しました");
    }
  } catch (e) {
    console.error("[AI傾向] 傾向分析エラー:", e.message);
  }
}


router.post("/api/notion/save-detail-log", async (req, res) => {
  try {
    const detailLogs = Array.isArray(req.body?.detailLogs)
      ? req.body.detailLogs
      : [];
    const isPremium = req.body?.isPremium || false;

    // ↓ リクエストからトークンとDBIDを取得
    const notionToken = req.body?.notionApiKey || process.env.NOTION_TOKEN;
    const detailLogDbId = req.body?.detailLogDbId || null;
    const mealMasterDbId = req.body?.mealMasterDbId || null;
    const exerciseMasterDbId = req.body?.exerciseMasterDbId || null;
    const dailyLogDbId = req.body?.dailyLogDbId || null;

    if (!notionToken || !detailLogDbId) {
      return res.status(400).json({
        ok: false,
        message: "notionApiKeyまたはdetailLogDbIdがありません",
      });
    }

    console.log(
      "[保存] isPremium:",
      isPremium,
      "hasApiKey:",
      !!AI_CONFIG.apiKey,
    );

    const useAi = isPremium && !!AI_CONFIG.apiKey;
    console.log("[保存] useAi:", useAi);
    const aiSettings = useAi
      ? {
          useAi: true,
          aiProvider: AI_CONFIG.provider,
          aiApiKey: AI_CONFIG.apiKey,
          aiModelName: AI_CONFIG.model,
        }
      : null;

    if (!detailLogs.length) {
      return res
        .status(400)
        .json({ ok: false, message: "保存する detailLogs がありません。" });
    }

    let processedLogs = [...detailLogs];
    if (detailLogs.length === 1 && detailLogs[0].isBulk && useAi) {
      try {
        const originalImages = detailLogs[0].images || [];
        // ↓ tokenとdbIdを渡す
        const splitLogs = await splitBulkLogWithAi(
          detailLogs[0],
          aiSettings,
          mealMasterDbId,
          exerciseMasterDbId,
          notionToken,
        );
        if (splitLogs && splitLogs.length > 0) {
          const originalPhotoUrls = detailLogs[0].photoUrls || [];
          processedLogs = splitLogs.map((log) => ({
            ...log,
            images: originalImages,
            imageFileNames: detailLogs[0].imageFileNames || [],
            photoUrls: originalPhotoUrls,
          }));
          console.log(`[まとめて] ${splitLogs.length}件に分割しました`);
          console.log(`[まとめて] 画像引き継ぎ: ${originalImages.length}件`);
        }
      } catch (e) {
        console.error("[まとめて] 分割エラー:", e.message);
      }
    }

    const finalLogs = [];
    for (const rawLog of processedLogs) {
      let log = { ...rawLog };

      if (log.mealMasterId && mealMasterDbId) {
        try {
          // ↓ tokenを渡す
          const mealMasters = await getMasterList(
            mealMasterDbId,
            "タイトル",
            notionToken,
          );
          const mealMaster = mealMasters.find((m) => m.id === log.mealMasterId);
          console.log(
            "[MASTER] mealMasterId:",
            log.mealMasterId,
            "found:",
            mealMaster?.label,
          );
          if (mealMaster) log.mealMasterLabel = mealMaster.label;
        } catch (e) {
          console.log("[MASTER] mealMaster取得エラー:", e.message);
        }
      }

      if (log.exerciseMasterId && exerciseMasterDbId) {
        try {
          // ↓ tokenを渡す
          const exerciseMasters = await getMasterList(
            exerciseMasterDbId,
            "名前",
            notionToken,
          );
          const exerciseMaster = exerciseMasters.find(
            (m) => m.id === log.exerciseMasterId,
          );
          if (exerciseMaster) log.exerciseMasterLabel = exerciseMaster.label;
        } catch (e) {}
      }

      if (useAi) {
        log = await analyzeLogWithAi(log, aiSettings);
      }
      finalLogs.push(log);
    }

    const results = [];
    let dailyPageId = null;
    let isFirstSave = false;

    const saveDate =
      finalLogs[0]?.date || new Date().toISOString().split("T")[0];

    if (dailyLogDbId) {
      try {
        // ↓ tokenとdbIdを渡す
        const { page: dailyPage, isNew } = await getOrCreateDailyLog(
          saveDate,
          dailyLogDbId,
          notionToken,
        );
        dailyPageId = dailyPage.id;
        isFirstSave = isNew;
        console.log(
          `[日次記録] ${isNew ? "新規作成" : "既存取得"}: ${dailyPageId}`,
        );
      } catch (e) {
        console.error("[日次記録] 取得/作成エラー:", e.message);
      }
    }

    for (const log of finalLogs) {
      // ↓ tokenを渡す
      const page = await createPage(
        detailLogDbId,
        buildNotionPageProperties(log, TITLE_PROPERTY_NAME),
        notionToken,
      );
      results.push({ id: page.id, title: log.title || "" });

      if (dailyPageId) {
        try {
          await addRelationToDailyLog(dailyPageId, page.id, notionToken);
        } catch (e) {
          console.error("[日次記録] リレーションエラー:", e.message);
        }
      }
    }

    if (dailyPageId) {
      for (const result of results) {
        try {
          // ↓ tokenを渡す
          await notionFetch(
            `https://api.notion.com/v1/pages/${result.id}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                properties: { 日次記録: { relation: [{ id: dailyPageId }] } },
              }),
            },
            notionToken,
          );
        } catch (e) {
          console.error(
            "[日次記録] 詳細ログへのリレーションエラー:",
            e.message,
          );
        }
      }
    }

    if (isFirstSave && useAi && dailyPageId && dailyLogDbId) {
      // ↓ tokenとdbIdを渡す
      analyzeTrendAndSaveToDailyLog(
        dailyPageId,
        saveDate,
        aiSettings,
        detailLogDbId,
        notionToken,
      ).catch((e) => console.error("[AI傾向] エラー:", e.message));
    }

    return res.json({
      ok: true,
      savedCount: results.length,
      message: `Notionへ ${results.length} 件保存しました。`,
      savedLogs: results,
    });
  } catch (error) {
    console.error("save-detail-log error:", error);
    return res.status(500).json({
      ok: false,
      message: `保存中にエラーが発生しました: ${error.message}`,
    });
  }
});


router.get("/api/notion/databases", async (req, res) => {
  const notionToken = req.headers["x-notion-token"];
  if (!notionToken) {
    return res
      .status(400)
      .json({ ok: false, message: "Notionトークンがありません" });
  }

  try {
    const response = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { value: "database", property: "object" },
        page_size: 100,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "DB取得失敗");

    const databases = data.results.map((db) => ({
      id: db.id,
      name: db.title?.[0]?.plain_text || "(名称未設定)",
    }));

    return res.json({ ok: true, databases });
  } catch (e) {
    console.error("[DB一覧] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.post("/api/notion/profile", async (req, res) => {
  const { notionToken, profileDbId } = req.body;
  if (!notionToken || !profileDbId) {
    return res
      .status(400)
      .json({ ok: false, message: "notionTokenまたはprofileDbIdがありません" });
  }

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${profileDbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 1 }),
      },
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "プロフィール取得失敗");

    const page = data.results?.[0];
    if (!page) return res.json({ ok: true, profile: null });

    const props = page.properties || {};
    const profile = {
      height: props["身長"]?.number?.toString() || "",
      sex: props["性別"]?.select?.name || "",
      targetWeight: props["目標体重"]?.number?.toString() || "",
      birthDate: props["生年月日"]?.date?.start || null,
      targetDate: props["目標期日"]?.date?.start || null,
      region: props["住んでいる地域"]?.rich_text?.[0]?.plain_text || "",
    };

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error("[プロフィール] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.post("/api/notion/profile/save", async (req, res) => {
  const { notionToken, profileDbId, profile } = req.body;
  if (!notionToken || !profileDbId || !profile) {
    return res
      .status(400)
      .json({ ok: false, message: "パラメータが不足しています" });
  }

  try {
    const queryRes = await fetch(
      `https://api.notion.com/v1/databases/${profileDbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 1 }),
      },
    );
    const queryData = await queryRes.json();
    const pageId = queryData.results?.[0]?.id;
    if (!pageId)
      return res
        .status(404)
        .json({ ok: false, message: "プロフィールページが見つかりません" });

    const properties = {};
    if (profile.height)
      properties["身長"] = { number: parseFloat(profile.height) };
    if (profile.sex) properties["性別"] = { select: { name: profile.sex } };
    if (profile.targetWeight)
      properties["目標体重"] = { number: parseFloat(profile.targetWeight) };
    if (profile.birthDate)
      properties["生年月日"] = { date: { start: profile.birthDate } };
    if (profile.targetDate)
      properties["目標期日"] = { date: { start: profile.targetDate } };
    if (profile.region)
      properties["住んでいる地域"] = {
        rich_text: [{ text: { content: profile.region } }],
      };

    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[プロフィール保存] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.post("/api/notion/meal-master", async (req, res) => {
  const { notionToken, dbId, data } = req.body;
  if (!notionToken || !dbId || !data) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const properties = {};
    setTitle(properties, "タイトル", data.name);
    if (data.tags) setMultiSelect(properties, "タグ", data.tags);
    if (data.calories) setNumber(properties, "摂取カロリー", data.calories);
    if (data.ingredients) setRichText(properties, "材料", data.ingredients);
    if (data.recipe) setRichText(properties, "レシピ", data.recipe);
    if (data.memo) setRichText(properties, "メモ", data.memo);

    const pageBody = { parent: { database_id: dbId }, properties };
    if (data.icon && data.icon.trim()) {
      pageBody.icon = { type: "emoji", emoji: data.icon.trim() };
    }

    const page = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pageBody),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true, id: result.id });
  } catch (e) {
    console.error("[食事マスタ登録] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.post("/api/notion/exercise-master", async (req, res) => {
  const { notionToken, dbId, data } = req.body;
  if (!notionToken || !dbId || !data) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const properties = {};
    setTitle(properties, "名前", data.name);
    if (data.type) setSelect(properties, "種類", data.type);
    if (data.difficulty) setSelect(properties, "きつさ", data.difficulty);
    if (data.unit) setSelect(properties, "基準単位", data.unit);
    if (data.calorieRate)
      setNumber(properties, "消費カロリー係数", data.calorieRate);
    if (data.memo) setRichText(properties, "メモ", data.memo);
    properties["有効"] = { checkbox: true };

    const pageBody = { parent: { database_id: dbId }, properties };
    if (data.coverImageUrl) {
      pageBody.cover = {
        type: "external",
        external: { url: data.coverImageUrl },
      };
    }

    const page = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pageBody),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true, id: result.id });
  } catch (e) {
    console.error("[運動マスタ登録] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.patch("/api/notion/meal-master/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken, data } = req.body;
  if (!notionToken || !data) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const properties = {};
    if (data.name) setTitle(properties, "タイトル", data.name);
    if (data.tags) setMultiSelect(properties, "タグ", data.tags);
    if (data.calories != null)
      setNumber(properties, "摂取カロリー", data.calories);
    if (data.ingredients != null)
      setRichText(properties, "材料", data.ingredients);
    if (data.recipe != null) setRichText(properties, "レシピ", data.recipe);
    if (data.memo != null) setRichText(properties, "メモ", data.memo);

    const pageBody = { properties };
    if (data.icon && data.icon.trim()) {
      pageBody.icon = { type: "emoji", emoji: data.icon.trim() };
    } else if (data.icon === "") {
      pageBody.icon = null;
    }

    const page = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pageBody),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[食事マスタ更新] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.patch("/api/notion/exercise-master/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken, data } = req.body;
  if (!notionToken || !data) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const properties = {};
    if (data.name) setTitle(properties, "名前", data.name);
    if (data.type) setSelect(properties, "種類", data.type);
    if (data.difficulty) setSelect(properties, "きつさ", data.difficulty);
    if (data.unit) setSelect(properties, "基準単位", data.unit);
    if (data.calorieRate != null)
      setNumber(properties, "消費カロリー係数", data.calorieRate);
    if (data.memo != null) setRichText(properties, "メモ", data.memo);

    const pageBody = { properties };
    if (data.coverImageUrl) {
      pageBody.cover = {
        type: "external",
        external: { url: data.coverImageUrl },
      };
    } else if (data.coverImageUrl === null) {
      pageBody.cover = null;
    }

    const page = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pageBody),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[運動マスタ更新] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.patch("/api/notion/update-log/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken, log } = req.body;
  if (!notionToken || !log) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const properties = buildNotionPageProperties(log, TITLE_PROPERTY_NAME);
    await notionFetch(
      `https://api.notion.com/v1/pages/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      },
      notionToken,
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[ログ更新] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.delete("/api/notion/delete-log/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken } = req.body;
  if (!notionToken) {
    return res
      .status(400)
      .json({ ok: false, message: "notionTokenがありません" });
  }
  try {
    await notionFetch(
      `https://api.notion.com/v1/pages/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      },
      notionToken,
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[ログ削除] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


router.delete("/api/notion/meal-master/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken } = req.body;
  try {
    await notionFetch(
      `https://api.notion.com/v1/pages/${id}`,
      { method: "PATCH", body: JSON.stringify({ archived: true }) },
      notionToken,
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});


router.delete("/api/notion/exercise-master/:id", async (req, res) => {
  const { id } = req.params;
  const { notionToken } = req.body;
  try {
    await notionFetch(
      `https://api.notion.com/v1/pages/${id}`,
      { method: "PATCH", body: JSON.stringify({ archived: true }) },
      notionToken,
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});


module.exports = router;
