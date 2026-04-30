const express = require("express");
const router = express.Router();
const { sanitizeText, getMasterList } = require("../../lib/notionHelpers");

const AI_CONFIG = {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-2.5-flash",
};

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanupAiText(value) {
  return sanitizeText(value).replace(/\r/g, "");
}

function mergeInputMemo(originalMemo, aiMemoDetail) {
  const original = sanitizeText(originalMemo);
  const detail = sanitizeText(aiMemoDetail);
  if (!detail) return original;
  if (!original) return detail;
  return `${original}\n${detail}`;
}

function fallbackAiResult(log) {
  const inputMemo = sanitizeText(log.inputMemo);
  const recordType = sanitizeText(log.recordType);
  if (recordType === "食事") {
    const summaryLines = [];
    if (log.mealCategory) summaryLines.push(`・食事区分: ${log.mealCategory}`);
    if (inputMemo) summaryLines.push(`・${inputMemo}`);
    return {
      aiSummary: summaryLines.join("\n"),
      aiOneLineMemo: "",
      aiMemoDetail: "",
      intakeCalories: log.intakeCalories ?? null,
      burnCalories: log.burnCalories ?? null,
      minutes: log.minutes ?? null,
    };
  }
  if (recordType === "運動") {
    const summaryLines = [];
    if (inputMemo) summaryLines.push(`・${inputMemo}`);
    return {
      aiSummary: summaryLines.join("\n"),
      aiOneLineMemo: "",
      aiMemoDetail: "",
      intakeCalories: log.intakeCalories ?? null,
      burnCalories: log.burnCalories ?? null,
      minutes: log.minutes ?? null,
    };
  }
  return {
    aiSummary: inputMemo ? `・${inputMemo}` : "",
    aiOneLineMemo: "",
    aiMemoDetail: "",
    intakeCalories: log.intakeCalories ?? null,
    burnCalories: log.burnCalories ?? null,
    minutes: log.minutes ?? null,
  };
}

function buildAnalysisPrompt(log) {
  const inputMemo = sanitizeText(log.inputMemo);
  const recordType = sanitizeText(log.recordType);
  const mealCategory = sanitizeText(log.mealCategory);
  const mealMasterLabel = sanitizeText(log.mealMasterLabel);
  const exerciseMasterLabel = sanitizeText(log.exerciseMasterLabel);
  const sourceHints = Array.isArray(log.imageFileNames)
    ? log.imageFileNames.join(", ")
    : "";
  const mealInfo = [mealCategory, mealMasterLabel].filter(Boolean).join(" / ");
  const exerciseInfo = [exerciseMasterLabel, inputMemo]
    .filter(Boolean)
    .join(" / ");

  const bedTime = sanitizeText(log.bedTime);
  const wakeTime = sanitizeText(log.wakeTime);

  return `あなたはダイエット記録アプリ用の画像解析アシスタントです。
出力は必ずJSONのみで返してください。前置きや説明は不要です。

【出力ルール】
- aiSummary: 画像や入力メモから読み取った内容を「・」から始まる箇条書きで出力。1料理1行でシンプルに。
  - 食事なら: 「・料理名 個数」の形式で1行。例「・元祖トマトラーメン 1杯」金額は不要
  - 運動なら: 「・種目 時間 回数 距離」の形式で1行
  - 睡眠なら: 就寝時間と起床時間から睡眠時間を計算して「・睡眠時間 XX時間XX分」の形式で1行
- aiOneLineMemo: ダイエット視点での箇条書きアドバイス。2〜4行。「・」から始める。
- aiMemoDetail: 読み取った内容をテキストで。複数行でもOK。
- intakeCalories: 推定摂取カロリー（数値のみ、不明ならnull）
- burnCalories: 推定消費カロリー（数値のみ、不明ならnull）
- minutes: 運動時間または睡眠時間（数値のみ、不明ならnull）

【入力情報】
記録種別: ${recordType || "未設定"}
食事区分・食事名: ${mealInfo || inputMemo || "未設定"}
運動内容: ${exerciseInfo || "未設定"}
就寝時間: ${bedTime || "なし"}
起床時間: ${wakeTime || "なし"}
入力メモ: ${inputMemo || "なし"}
画像ファイル名: ${sourceHints || "なし"}

JSONの形式:
{
  "aiSummary": "・内容",
  "aiOneLineMemo": "・アドバイス1\\n・アドバイス2",
  "aiMemoDetail": "読み取り内容",
  "intakeCalories": 数値またはnull,
  "burnCalories": 数値またはnull,
  "minutes": 数値またはnull
}`;
}

async function callGeminiVisionAnalysis({ apiKey, model, log }) {
  const images = normalizeImages(log.images);
  const promptText = buildAnalysisPrompt(log);
  console.log("[Gemini] 画像件数:", images.length);
  const parts = [{ text: promptText }];
  for (const image of images) {
    parts.push({
      inline_data: { mime_type: image.mimeType, data: image.base64 },
    });
  }
  const geminiModel = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { response_mime_type: "application/json" },
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError.name === "AbortError")
      throw new Error("Gemini APIがタイムアウトしました（60秒）");
    throw fetchError;
  }
  clearTimeout(timeoutId);
  const data = await response.json();
  console.log("[AI] Gemini生レスポンス:", JSON.stringify(data).slice(0, 500));
  if (!response.ok) throw new Error(data?.error?.message || "Gemini API error");
  const outputText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!outputText) throw new Error("Gemini response is empty");
  const cleanedText = outputText.replace(/```json|```/g, "").trim();
  const parsed = safeJsonParse(cleanedText);
  console.log("[AI] Gemini解析結果:", JSON.stringify(parsed));
  if (!parsed) throw new Error("Gemini response JSON parse failed");
  return {
    aiSummary: cleanupAiText(parsed.aiSummary),
    aiOneLineMemo: cleanupAiText(parsed.aiOneLineMemo),
    aiMemoDetail: cleanupAiText(parsed.aiMemoDetail),
    intakeCalories:
      parsed.intakeCalories == null || parsed.intakeCalories === ""
        ? null
        : Number(parsed.intakeCalories),
    burnCalories:
      parsed.burnCalories == null || parsed.burnCalories === ""
        ? null
        : Number(parsed.burnCalories),
    minutes:
      parsed.minutes == null || parsed.minutes === ""
        ? null
        : Number(parsed.minutes),
  };
}

async function callClaudeVisionAnalysis({ apiKey, model, log }) {
  const images = normalizeImages(log.images);
  const promptText = buildAnalysisPrompt(log);
  const contentParts = [];
  for (const image of images) {
    contentParts.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.base64,
      },
    });
  }
  contentParts.push({ type: "text", text: promptText });
  const body = {
    model: model || "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: contentParts }],
  };
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Claude API error");
  const outputText = data?.content?.[0]?.text || "";
  if (!outputText) throw new Error("Claude response is empty");
  const cleanedText = outputText.replace(/```json|```/g, "").trim();
  const parsed = safeJsonParse(cleanedText);
  if (!parsed) throw new Error("Claude response JSON parse failed");
  return {
    aiSummary: cleanupAiText(parsed.aiSummary),
    aiOneLineMemo: cleanupAiText(parsed.aiOneLineMemo),
    aiMemoDetail: cleanupAiText(parsed.aiMemoDetail),
    intakeCalories:
      parsed.intakeCalories == null || parsed.intakeCalories === ""
        ? null
        : Number(parsed.intakeCalories),
    burnCalories:
      parsed.burnCalories == null || parsed.burnCalories === ""
        ? null
        : Number(parsed.burnCalories),
    minutes:
      parsed.minutes == null || parsed.minutes === ""
        ? null
        : Number(parsed.minutes),
  };
}

async function callOpenAIVisionAnalysis({ apiKey, model, log }) {
  const images = normalizeImages(log.images);
  const promptText = buildAnalysisPrompt(log);
  const body = {
    model: model || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: promptText },
          ...images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.base64}`,
          })),
        ],
      },
    ],
    text: { format: { type: "json_object" } },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenAI API error");
  const outputText =
    data?.output_text ||
    data?.output
      ?.map((item) => {
        if (!Array.isArray(item?.content)) return "";
        return item.content.map((c) => c?.text || "").join("");
      })
      .join("\n") ||
    "";
  const parsed = safeJsonParse(outputText);
  if (!parsed) throw new Error("OpenAI response JSON parse failed");
  return {
    aiSummary: cleanupAiText(parsed.aiSummary),
    aiOneLineMemo: cleanupAiText(parsed.aiOneLineMemo),
    aiMemoDetail: cleanupAiText(parsed.aiMemoDetail),
    intakeCalories:
      parsed.intakeCalories == null || parsed.intakeCalories === ""
        ? null
        : Number(parsed.intakeCalories),
    burnCalories:
      parsed.burnCalories == null || parsed.burnCalories === ""
        ? null
        : Number(parsed.burnCalories),
    minutes:
      parsed.minutes == null || parsed.minutes === ""
        ? null
        : Number(parsed.minutes),
  };
}

async function analyzeLogWithAi(log, aiSettings) {
  const images = normalizeImages(log.images);
  const hasImage = images.length > 0;
  const hasMemo = sanitizeText(log.inputMemo) !== "";
  const hasMasterLabel =
    sanitizeText(log.mealMasterLabel) !== "" ||
    sanitizeText(log.exerciseMasterLabel) !== "";

  if (!hasImage && !hasMemo && !hasMasterLabel) {
    return {
      ...log,
      aiSummary: log.aiSummary || null,
      aiOneLineMemo: log.aiOneLineMemo || null,
    };
  }

  console.log(
    "[AI] aiSettings受信:",
    JSON.stringify({
      provider: aiSettings?.aiProvider,
      hasKey: !!aiSettings?.aiApiKey,
      model: aiSettings?.aiModelName,
    }),
  );

  const provider = sanitizeText(
    aiSettings?.aiProvider || "gemini",
  ).toLowerCase();
  const apiKey = sanitizeText(aiSettings?.aiApiKey);
  const model = sanitizeText(aiSettings?.aiModelName || "");

  if (!apiKey) {
    const fallback = fallbackAiResult(log);
    return {
      ...log,
      aiSummary: log.aiSummary || fallback.aiSummary || null,
      aiOneLineMemo: log.aiOneLineMemo || fallback.aiOneLineMemo || null,
      intakeCalories: log.intakeCalories ?? fallback.intakeCalories ?? null,
      burnCalories: log.burnCalories ?? fallback.burnCalories ?? null,
      minutes: log.minutes ?? fallback.minutes ?? null,
    };
  }

  try {
    let analyzed;
    if (provider === "claude") {
      console.log("[AI] Claudeで画像解析を実行します");
      analyzed = await callClaudeVisionAnalysis({
        apiKey,
        model: model || "claude-haiku-4-5-20251001",
        log,
      });
    } else if (provider === "gemini") {
      console.log("[AI] Geminiで画像解析を実行します");
      analyzed = await callGeminiVisionAnalysis({
        apiKey,
        model: model || "gemini-2.5-flash",
        log,
      });
    } else if (provider === "openai") {
      console.log("[AI] OpenAIで画像解析を実行します");
      analyzed = await callOpenAIVisionAnalysis({
        apiKey,
        model: model || "gpt-4.1-mini",
        log,
      });
    } else {
      const fallback = fallbackAiResult(log);
      return {
        ...log,
        aiSummary: log.aiSummary || fallback.aiSummary || null,
        aiOneLineMemo: log.aiOneLineMemo || fallback.aiOneLineMemo || null,
        intakeCalories: log.intakeCalories ?? fallback.intakeCalories ?? null,
        burnCalories: log.burnCalories ?? fallback.burnCalories ?? null,
        minutes: log.minutes ?? fallback.minutes ?? null,
      };
    }
    return {
      ...log,
      inputMemo: log.inputMemo || null,
      aiSummary: analyzed.aiSummary || log.aiSummary || null,
      aiOneLineMemo: analyzed.aiOneLineMemo || log.aiOneLineMemo || null,
      intakeCalories: log.intakeCalories ?? analyzed.intakeCalories ?? null,
      burnCalories: log.burnCalories ?? analyzed.burnCalories ?? null,
      minutes:
        log.minutes !== null && log.minutes !== undefined
          ? log.minutes
          : (analyzed.minutes ?? null),
    };
  } catch (error) {
    console.error("analyzeLogWithAi error:", error);
    const fallback = fallbackAiResult(log);
    return {
      ...log,
      aiSummary: log.aiSummary || fallback.aiSummary || null,
      aiOneLineMemo: log.aiOneLineMemo || fallback.aiOneLineMemo || null,
      intakeCalories: log.intakeCalories ?? fallback.intakeCalories ?? null,
      burnCalories: log.burnCalories ?? fallback.burnCalories ?? null,
      minutes: log.minutes ?? fallback.minutes ?? null,
    };
  }
}

// ↓ tokenとdbIdを引数で受け取るように変更

async function splitBulkLogWithAi(
  bulkLog,
  aiSettings,
  mealMasterDbId,
  exerciseMasterDbId,
  token,
) {
  const inputMemo = sanitizeText(bulkLog.inputMemo);
  const date = bulkLog.date;
  const apiKey = aiSettings.aiApiKey;
  const model = aiSettings.aiModelName || "gemini-2.5-flash";

  // ↓ tokenを渡す
  const mealMasters = mealMasterDbId
    ? await getMasterList(mealMasterDbId, "タイトル", token)
    : [];
  const exerciseMasters = exerciseMasterDbId
    ? await getMasterList(exerciseMasterDbId, "名前", token)
    : [];

  const prompt = `あなたはダイエット記録アプリのAIアシスタントです。
ユーザーがまとめて入力した記録を、種別ごとに分割してJSONで返してください。
出力はJSONのみ。前置き不要。

【入力メモ】
${inputMemo}

【食事マスタ一覧】
${mealMasters.map((m) => m.label).join("\n")}

【運動マスタ一覧】
${exerciseMasters.map((m) => m.label).join("\n")}

【出力ルール】
- logs配列に分割した記録を入れてください
- recordTypeは「体重」「食事」「運動」「体調」「天気」「睡眠」のいずれか
- 食事は食事区分（朝食・昼食・夕食・間食・飲み物・そのほか）ごとに1つにまとめる。同じ食事区分の品目は絶対に分割しない
- 運動は種目ごとに分ける
- 体重・体調・天気は1つにまとめる
- 就寝・起床情報がある場合は必ずrecordType「睡眠」として分割する
- 各ログのinputMemoはその記録に関係する内容だけ入れる
- mealCategoryは食事区分（朝食・昼食・夕食・間食・飲み物・そのほか）
- weight、intakeCalories、burnCalories、minutesは数値のみ（不明はnull）
- intakeCaloriesは各食事ごとの個別のカロリーを入れる。合計カロリーを各ログに重複して入れてはいけない
- 食事の合計カロリーが書かれている場合は、各食事に均等に分割するか、特定できない場合はnullにする
- conditionStatusは体調の状態テキスト（不明はnull）
- weatherは天気テキスト（不明はnull）
- temperatureは気温数値（不明はnull）
- humidityは湿度数値（不明はnull）
- countは運動回数数値（不明はnull）
- distanceKmは運動距離数値（不明はnull）
- mealMasterNameは食事マスタの正式名称（マスタに存在しない場合はnull）
- exerciseMasterNameは運動マスタの正式名称（マスタに存在しない場合はnull）
- 睡眠記録の場合：bedTimeは就寝時間（「YYYY-MM-DD HH:MM」形式）、wakeTimeは起床時間（同形式）
- dateは記録日（YYYY-MM-DD形式）。入力メモに日付がある場合はその日付、ない場合は睡眠は起床日を使用

JSONの形式:
{
  "logs": [
    {
      "date": "2026-04-12",
      "recordType": "食事",
      "mealCategory": "朝食",
      "mealMasterName": null,
      "exerciseMasterName": null,
      "inputMemo": "トースト、目玉焼き",
      "intakeCalories": 350,
      "weight": null,
      "burnCalories": null,
      "minutes": null,
      "count": null,
      "distanceKm": null,
      "conditionStatus": null,
      "weather": null,
      "temperature": null,
      "humidity": null,
      "bedTime": null,
      "wakeTime": null
    }
  ]
}`;

  try {
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
    const result = JSON.parse(clean);

    if (!result?.logs || !Array.isArray(result.logs)) return null;

    console.log(`[まとめて] ${result.logs.length}件に分割しました`);

    return result.logs.map((log) => {
      let mealMasterId = null;
      if (log.recordType === "食事" && log.mealMasterName) {
        const found = mealMasters.find((m) => m.label === log.mealMasterName);
        if (found) mealMasterId = found.id;
      }

      let exerciseMasterId = null;
      if (log.recordType === "運動" && log.exerciseMasterName) {
        const found = exerciseMasters.find(
          (m) => m.label === log.exerciseMasterName,
        );
        if (found) exerciseMasterId = found.id;
      }

      const logDate = log.date || date;

      const title = (() => {
        const type = log.recordType || "食事";
        if (type === "食事")
          return `${logDate} | 食事 | ${log.mealCategory || "未分類"}`;
        if (type === "運動")
          return `${logDate} | 運動 | ${log.exerciseMasterName || log.inputMemo?.slice(0, 10) || "運動"}`;
        if (type === "体重") return `${logDate} | 体重`;
        if (type === "体調") return `${logDate} | 体調`;
        if (type === "天気") return `${logDate} | 天気`;
        if (type === "睡眠") return `${logDate} | 睡眠`;
        return `${logDate} | ${type}`;
      })();

      return {
        date: logDate,
        recordType: log.recordType || "食事",
        title,
        mealCategory: log.mealCategory || null,
        mealMasterId: mealMasterId || null,
        intakeCalories: log.intakeCalories ?? null,
        burnCalories: log.burnCalories ?? null,
        minutes: log.minutes ?? null,
        count: log.count ?? null,
        distanceKm: log.distanceKm ?? null,
        weight: log.weight ?? null,
        conditionStatus: log.conditionStatus || null,
        weather: log.weather || null,
        temperature: log.temperature ?? null,
        humidity: log.humidity ?? null,
        inputMemo: log.inputMemo || null,
        exerciseMasterId: exerciseMasterId || null,
        bedTime: log.bedTime
          ? log.bedTime.replace(" ", "T") + ":00+09:00"
          : null,
        wakeTime: log.wakeTime
          ? log.wakeTime.replace(" ", "T") + ":00+09:00"
          : null,
        source: "AI",
        status: "確定",
      };
    });
  } catch (e) {
    console.error("[まとめて] AI分割エラー:", e.message);
    return null;
  }
}


router.post("/api/ai/analyze-log", async (req, res) => {
  try {
    const log = req.body?.log || null;
    const aiSettings = req.body?.aiSettings || null;
    if (!log)
      return res.status(400).json({ ok: false, message: "log がありません。" });
    const analyzedLog = await analyzeLogWithAi(log, aiSettings);
    return res.json({ ok: true, analyzedLog });
  } catch (error) {
    console.error("analyze-log error:", error);
    return res
      .status(500)
      .json({ ok: false, message: `AI解析失敗: ${error.message}` });
  }
});


router.post("/api/ai/master-assist", async (req, res) => {
  const { type, data, images } = req.body;
  if (!type || !data) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }
  try {
    const apiKey = AI_CONFIG.apiKey;
    if (!apiKey) {
      return res
        .status(400)
        .json({ ok: false, message: "AIのAPIキーが設定されていません" });
    }

    let prompt = "";
    if (type === "meal") {
      prompt = `あなたは栄養士アシスタントです。以下の情報から食事マスタの各項目を推定してください。
出力は必ずJSONのみで返してください。

【入力情報】
料理名: ${data.name || "未設定"}
補足メモ: ${data.aiHint || "なし"}
材料: ${data.ingredients || "なし"}
レシピ: ${data.recipe || "なし"}
メモ: ${data.memo || "なし"}
${images && images.length > 0 ? "※画像あり（成分表示・料理写真）" : ""}

【出力ルール】
- title: 料理名を簡潔に（例：「鶏むねサラダチキン」）
- icon: 料理に合う絵文字1文字（例：「🍗」）
- tags: 以下のタグから当てはまるものを配列で（複数可）
  ["主菜","副菜","汁物","朝向け","夜向け","間食","お菓子","弁当","作り置き","レンジ","高たんぱく","軽め","炭水化物控えめ"]
- calories: 推定摂取カロリー（数値のみ、不明ならnull）
- ingredients: 推定材料（改行区切り、不明ならnull）
- memo: 補足コメント1行（なければnull）

JSONの形式:
{
  "title": "料理名またはnull",
  "icon": "絵文字1文字またはnull",
  "tags": ["タグ1", "タグ2"],
  "calories": 数値またはnull,
  "ingredients": "材料1\\n材料2またはnull",
  "memo": "補足またはnull"
}`;
    } else {
      prompt = `あなたはフィットネスアシスタントです。以下の運動情報から各項目を推定してください。
出力は必ずJSONのみで返してください。

【入力情報】
運動名: ${data.name || "未設定"}
補足メモ: ${data.aiHint || "なし"}
種類: ${data.type || "未設定"}
きつさ: ${data.difficulty || "未設定"}
基準単位: ${data.unit || "未設定"}
メモ: ${data.memo || "なし"}

【出力ルール】
- type: 「有酸素」「筋トレ」「ストレッチ」のいずれか（不明ならnull）
- difficulty: 「軽め」「普通」「しっかり」のいずれか（不明ならnull）
- unit: 「km」「分」「回」のいずれか（不明ならnull）
- calorieRate: 1回または1分または1kmあたりの消費カロリー係数（数値のみ、不明ならnull）
- memo: 補足コメント1行（なければnull）

JSONの形式:
{
  "title": "正式な運動名またはnull",
  "type": "有酸素またはnull",
  "difficulty": "普通またはnull",
  "unit": "分またはnull",
  "calorieRate": 数値またはnull,
  "memo": "補足またはnull"
}`;
    }

    const parts = [{ text: prompt }];
    if (images && images.length > 0) {
      for (const img of images) {
        if (img.base64) {
          parts.push({
            inline_data: {
              mime_type: img.mimeType || "image/jpeg",
              data: img.base64,
            },
          });
        }
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { response_mime_type: "application/json" },
        }),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === "AbortError")
        throw new Error("タイムアウトしました");
      throw fetchError;
    }
    clearTimeout(timeoutId);

    const result = await response.json();
    if (!response.ok)
      throw new Error(result?.error?.message || "Gemini API error");

    const outputText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = outputText.replace(/```json|```/g, "").trim();
    const parsed = safeJsonParse(cleaned);
    if (!parsed) throw new Error("レスポンスのパースに失敗しました");

    return res.json({ ok: true, result: parsed });
  } catch (e) {
    console.error("[マスタAI補助] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});


module.exports = { router, analyzeLogWithAi, splitBulkLogWithAi };
