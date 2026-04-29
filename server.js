// SERVER: APP_SERVER
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000; // ← Render対応でprocess.env.PORTを追加

// ↓ TEST_NOTION_CONFIGを削除
const NOTION_VERSION = "2022-06-28";
const TITLE_PROPERTY_NAME = "名前";

const AI_CONFIG = {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-2.5-flash",
};
console.log(
  "[起動] AI_CONFIG.apiKey設定済み:",
  !!AI_CONFIG.apiKey,
  "isPremiumTest確認用",
);

const OAUTH_CONFIG = {
  clientId: process.env.NOTION_CLIENT_ID || process.env.NOTION_OAUTH_CLIENT_ID,
  clientSecret:
    process.env.NOTION_CLIENT_SECRET || process.env.NOTION_OAUTH_CLIENT_SECRET,
  authUrl: process.env.NOTION_OAUTH_AUTH_URL,
  redirectUri:
    process.env.NOTION_REDIRECT_URI || process.env.NOTION_OAUTH_REDIRECT_URI, // ← 環境変数に変更
};

app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "server is running" });
});

function sanitizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getTitleText(titleProperty) {
  if (!titleProperty || !Array.isArray(titleProperty.title)) return "";
  return titleProperty.title.map((item) => item.plain_text || "").join("");
}

function getRichTextPlainText(richTextProperty) {
  if (!richTextProperty || !Array.isArray(richTextProperty.rich_text))
    return "";
  return richTextProperty.rich_text
    .map((item) => item.plain_text || "")
    .join("");
}

function getMultiSelectText(multiSelectProperty) {
  if (!multiSelectProperty || !Array.isArray(multiSelectProperty.multi_select))
    return "";
  return multiSelectProperty.multi_select
    .map((item) => item.name || "")
    .filter(Boolean)
    .join(" / ");
}

function getSelectText(selectProperty) {
  if (!selectProperty || !selectProperty.select) return "";
  return selectProperty.select.name || "";
}

function getStatusText(statusProperty) {
  if (!statusProperty || !statusProperty.status) return "";
  return statusProperty.status.name || "";
}

function getRelationIds(relationProperty) {
  if (!relationProperty || !Array.isArray(relationProperty.relation)) return [];
  return relationProperty.relation.map((item) => item.id).filter(Boolean);
}

function toRichText(value) {
  const text = sanitizeText(value);
  if (!text) return [];
  return [{ text: { content: text } }];
}

function setTitle(properties, propertyName, value) {
  const text = sanitizeText(value);
  if (!text) return;
  properties[propertyName] = { title: [{ text: { content: text } }] };
}

function setRichText(properties, propertyName, value) {
  const richText = toRichText(value);
  if (!richText.length) return;
  properties[propertyName] = { rich_text: richText };
}

function setDate(properties, propertyName, value) {
  const text = sanitizeText(value);
  if (!text) return;
  properties[propertyName] = { date: { start: text } };
}

function setNumber(properties, propertyName, value) {
  if (value === null || value === undefined || value === "") return;
  const num = Number(value);
  if (Number.isNaN(num)) return;
  properties[propertyName] = { number: num };
}

function setSelect(properties, propertyName, value) {
  const text = sanitizeText(value);
  if (!text) return;
  properties[propertyName] = { select: { name: text } };
}

function setMultiSelect(properties, propertyName, value) {
  if (value === null || value === undefined || value === "") return;
  const values = Array.isArray(value)
    ? value.map((item) => sanitizeText(item)).filter(Boolean)
    : String(value)
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean);
  if (!values.length) return;
  properties[propertyName] = { multi_select: values.map((name) => ({ name })) };
}

function setRelation(properties, propertyName, value) {
  if (!value) return;
  const ids = Array.isArray(value)
    ? value.map((item) => sanitizeText(item)).filter(Boolean)
    : [sanitizeText(value)].filter(Boolean);
  if (!ids.length) return;
  properties[propertyName] = { relation: ids.map((id) => ({ id })) };
}

// ↓ tokenを引数で受け取れるように変更
async function notionFetch(url, options = {}, token = null) {
  const useToken = (token || process.env.NOTION_TOKEN || "").trim();
  const headers = {
    Authorization: `Bearer ${useToken}`,
    "Notion-Version": NOTION_VERSION,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message || data?.error || response.statusText;
    throw new Error(message);
  }
  return data;
}

// ↓ tokenを引数追加
async function queryDatabase(databaseId, body = {}, token = null) {
  return notionFetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    { method: "POST", body: JSON.stringify(body) },
    token,
  );
}

// 全件取得（ページネーション対応）
// ↓ tokenを引数追加
async function queryAllPages(databaseId, body = {}, token = null) {
  let allResults = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const reqBody = { ...body, page_size: 100 };
    if (startCursor) reqBody.start_cursor = startCursor;

    const data = await notionFetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      { method: "POST", body: JSON.stringify(reqBody) },
      token,
    );

    const results = Array.isArray(data.results) ? data.results : [];
    allResults = allResults.concat(results);
    hasMore = data.has_more === true;
    startCursor = data.next_cursor;
  }

  return { results: allResults };
}

// ↓ tokenを引数追加
async function getDatabase(databaseId, token = null) {
  return notionFetch(
    `https://api.notion.com/v1/databases/${databaseId}`,
    {
      method: "GET",
    },
    token,
  );
}

// ↓ tokenを引数追加
async function createPage(databaseId, properties, token = null) {
  return notionFetch(
    "https://api.notion.com/v1/pages",
    {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
    },
    token,
  );
}

function extractPropertyOptions(props, propName) {
  const prop = props[propName];
  if (!prop) return [];
  if (prop.type === "select" && prop.select?.options)
    return prop.select.options.map((item) => item.name).filter(Boolean);
  if (prop.type === "multi_select" && prop.multi_select?.options)
    return prop.multi_select.options.map((item) => item.name).filter(Boolean);
  return [];
}

// ↓ tokenを引数追加
async function getMasterList(databaseId, titlePropertyName, token = null) {
  const data = await queryDatabase(databaseId, { page_size: 100 }, token);
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((page) => {
    const props = page.properties || {};
    const isMeal = titlePropertyName === "タイトル";
    const base = {
      id: page.id,
      label: getTitleText(props[titlePropertyName]) || "(名称未設定)",
      icon:
        page.icon?.type === "emoji"
          ? page.icon.emoji
          : page.icon?.type === "external"
            ? page.icon.external?.url
            : page.icon?.type === "file"
              ? page.icon.file?.url
              : null,
      cover:
        page.cover?.type === "external"
          ? page.cover.external?.url
          : page.cover?.type === "file"
            ? page.cover.file?.url
            : null,
    };
    if (isMeal) {
      return {
        ...base,
        tags: Array.isArray(props["タグ"]?.multi_select)
          ? props["タグ"].multi_select.map((t) => t.name).filter(Boolean)
          : [],
        calories: props["摂取カロリー"]?.number ?? null,
        memo: getRichTextPlainText(props["メモ"]) || null,
        ingredients: getRichTextPlainText(props["材料"]) || null,
        recipe: getRichTextPlainText(props["レシピ"]) || null,
        url: props["URL"]?.url ?? null,
      };
    } else {
      return {
        ...base,
        type: getSelectText(props["種類"]) || null,
        difficulty: getSelectText(props["きつさ"]) || null,
        unit: getSelectText(props["基準単位"]) || null,
        calorieRate: props["消費カロリー係数"]?.number ?? null,
        memo: getRichTextPlainText(props["メモ"]) || null,
        enabled: props["有効"]?.checkbox ?? true,
      };
    }
  });
}

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

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((item) => ({
      base64: sanitizeText(item?.base64),
      mimeType: sanitizeText(item?.mimeType) || "image/jpeg",
      fileName: sanitizeText(item?.fileName || item?.filename),
    }))
    .filter((item) => item.base64);
}

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
- 食事は食事区分（朝食・昼食・夕食・間食・飲み物・そのほか）ごとに分ける
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

app.post("/api/ai/analyze-log", async (req, res) => {
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

app.post("/api/notion/save-detail-log", async (req, res) => {
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

app.get("/api/options", async (req, res) => {
  try {
    // ↓ ヘッダーからトークンとDBIDを取得
    const notionToken =
      req.headers["x-notion-token"] || process.env.NOTION_TOKEN;
    const detailLogDbId = req.headers["x-detail-log-db-id"] || null;
    const mealMasterDbId = req.headers["x-meal-master-db-id"] || null;
    const exerciseMasterDbId = req.headers["x-exercise-master-db-id"] || null;

    if (
      !notionToken ||
      !detailLogDbId ||
      !mealMasterDbId ||
      !exerciseMasterDbId
    ) {
      return res
        .status(400)
        .json({ ok: false, message: "必要なパラメータが不足しています" });
    }

    // ↓ tokenを渡す
    const detailProps =
      (await getDatabase(detailLogDbId, notionToken)).properties || {};
    const mealMasters = await getMasterList(
      mealMasterDbId,
      "タイトル",
      notionToken,
    );
    const exerciseMasters = await getMasterList(
      exerciseMasterDbId,
      "名前",
      notionToken,
    );

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
    return res
      .status(500)
      .json({ ok: false, message: `オプション取得失敗: ${error.message}` });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    // ↓ ヘッダーからトークンとDBIDを取得
    const notionToken =
      req.headers["x-notion-token"] || process.env.NOTION_TOKEN;
    const detailLogDbId = req.headers["x-detail-log-db-id"] || null;

    if (!notionToken || !detailLogDbId) {
      return res
        .status(400)
        .json({ ok: false, message: "必要なパラメータが不足しています" });
    }

    // ↓ tokenとdbIdを渡す
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
        confirmed:
          getSelectText(props["確定状態"]) ||
          getStatusText(props["確定状態"]) ||
          null,
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
        conditionStatus:
          getMultiSelectText(props["体調状態"]) ||
          getSelectText(props["体調状態"]) ||
          null,
        bodyTemperature: props["体温"]?.number ?? null,
        weather:
          getMultiSelectText(props["天気"]) ||
          getSelectText(props["天気"]) ||
          null,
        temperature: props["気温"]?.number ?? null,
        humidity: props["湿度"]?.number ?? null,
        pressure: props["気圧"]?.number ?? null,
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
    return res
      .status(500)
      .json({ ok: false, message: `取得失敗: ${error.message}` });
  }
});

// ↓ dailyLogDbIdとtokenを引数で受け取るように変更
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

// OAuth: 認証URL取得
app.get("/api/oauth/url", (req, res) => {
  return res.json({ ok: true, url: OAUTH_CONFIG.authUrl });
});

// OAuth: コードをトークンに交換
app.post("/api/oauth/token", async (req, res) => {
  const { code } = req.body;
  if (!code)
    return res.status(400).json({ ok: false, message: "codeがありません" });

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
    if (!response.ok)
      throw new Error(data.error_description || "トークン取得失敗");

    return res.json({
      ok: true,
      accessToken: data.access_token,
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name,
      botId: data.bot_id,
    });
  } catch (e) {
    console.error("[OAuth] トークン交換エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("エラー：codeがありません");
  res.redirect(`ndiet://oauth/callback?code=${code}`);
});

// Notionのデータベース一覧を取得
app.get("/api/notion/databases", async (req, res) => {
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

// プロフィールをNotionから読み込む
app.post("/api/notion/profile", async (req, res) => {
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

// プロフィールをNotionに保存
app.post("/api/notion/profile/save", async (req, res) => {
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

// マスタ登録AI補助
app.post("/api/ai/master-assist", async (req, res) => {
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

// 食事マスタ登録
app.post("/api/notion/meal-master", async (req, res) => {
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

// 運動マスタ登録
app.post("/api/notion/exercise-master", async (req, res) => {
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

    const page = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true, id: result.id });
  } catch (e) {
    console.error("[運動マスタ登録] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 食事マスタ更新
app.patch("/api/notion/meal-master/:id", async (req, res) => {
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

// 運動マスタ更新
app.patch("/api/notion/exercise-master/:id", async (req, res) => {
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

    const page = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
    const result = await page.json();
    if (!page.ok) throw new Error(result.message);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[運動マスタ更新] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 詳細ログ更新
app.patch("/api/notion/update-log/:id", async (req, res) => {
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

// 詳細ログ削除（アーカイブ）
app.delete("/api/notion/delete-log/:id", async (req, res) => {
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

// 食事マスタ削除
app.delete("/api/notion/meal-master/:id", async (req, res) => {
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

// 運動マスタ削除
app.delete("/api/notion/exercise-master/:id", async (req, res) => {
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

// 天気自動補完
app.post("/api/weather/auto-fill", async (req, res) => {
  const { notionToken, detailLogDbId, region } = req.body;
  if (!notionToken || !detailLogDbId || !region) {
    return res.status(400).json({ ok: false, message: "パラメータ不足" });
  }

  try {
    // 地域名から緯度経度を取得（国土地理院API）
    const geoRes = await fetch(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(region)}`,
    );
    const geoData = await geoRes.json();
    if (!geoData || geoData.length === 0) {
      return res
        .status(400)
        .json({ ok: false, message: "地域が見つかりませんでした" });
    }
    const [longitude, latitude] = geoData[0].geometry.coordinates;

    // 前日までの日付を取得
    const today = new Date();
    today.setDate(today.getDate() - 1);
    const yesterday = today.toISOString().split("T")[0];

    // 詳細ログから天気未入力の日付を取得
    const logsData = await queryAllPages(
      detailLogDbId,
      {
        sorts: [{ property: "記録日", direction: "descending" }],
      },
      notionToken,
    );

    const allLogs = logsData.results || [];

    // 記録がある日付を集計（天気レコード除く）
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

    // 天気未入力の日付のみ対象
    const targetDates = [...datesWithLogs]
      .filter((d) => !weatherFilledDates.has(d))
      .sort();

    if (targetDates.length === 0) {
      return res.json({
        ok: true,
        filledCount: 0,
        message: "補完対象の日付がありません",
      });
    }

    // 日付範囲でOpen-Meteo APIから天気取得
    const startDate = targetDates[0];
    const endDate = targetDates[targetDates.length - 1];

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,pressure_msl_mean,relative_humidity_2m_mean&timezone=Asia%2FTokyo&start_date=${startDate}&end_date=${endDate}`,
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
      const title = `${date} | 天気`;

      const properties = {};
      setTitle(properties, "名前", title);
      setDate(properties, "記録日", date);
      setMultiSelect(properties, "記録種別", "天気");
      setMultiSelect(properties, "天気", weatherText);
      setNumber(properties, "気温", temperature);
      setNumber(
        properties,
        "湿度",
        humidities[i] ? Math.round(humidities[i]) : null,
      );
      setNumber(properties, "気圧", pressure);
      setSelect(properties, "取得元", "自動");
      setSelect(properties, "確定状態", "確定");

      await createPage(detailLogDbId, properties, notionToken);
      filledCount++;
    }

    return res.json({
      ok: true,
      filledCount,
      message: `${filledCount}日分の天気を補完しました`,
    });
  } catch (e) {
    console.error("[天気補完] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Cloudinary画像アップロード
app.post("/api/cloudinary/upload", async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64) {
    return res
      .status(400)
      .json({ ok: false, message: "画像データがありません" });
  }
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    const timestamp = Math.round(Date.now() / 1000);
    const folder = "ndiet";

    const crypto = require("crypto");
    const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash("sha1").update(signStr).digest("hex");

    const formData = new URLSearchParams();
    formData.append(
      "file",
      `data:${mimeType || "image/jpeg"};base64,${base64}`,
    );
    formData.append("api_key", apiKey);
    formData.append("timestamp", timestamp);
    formData.append("signature", signature);
    formData.append("folder", folder);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      {
        method: "POST",
        body: formData,
      },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "アップロード失敗");
    }
    return res.json({ ok: true, url: data.secure_url });
  } catch (e) {
    console.error("[Cloudinary] エラー:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`server started: http://localhost:${PORT}`);
});
