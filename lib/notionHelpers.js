const NOTION_VERSION = "2022-06-28";

function sanitizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getTitleText(titleProperty) {
  if (!titleProperty || !Array.isArray(titleProperty.title)) return "";
  return titleProperty.title.map((item) => item.plain_text || "").join("");
}

function getRichTextPlainText(richTextProperty) {
  if (!richTextProperty || !Array.isArray(richTextProperty.rich_text)) return "";
  return richTextProperty.rich_text.map((item) => item.plain_text || "").join("");
}

function getMultiSelectText(multiSelectProperty) {
  if (!multiSelectProperty || !Array.isArray(multiSelectProperty.multi_select)) return "";
  return multiSelectProperty.multi_select.map((item) => item.name || "").filter(Boolean).join(" / ");
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
    : String(value).split("/").map((item) => item.trim()).filter(Boolean);
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

function extractPropertyOptions(props, propName) {
  const prop = props[propName];
  if (!prop) return [];
  if (prop.type === "select" && prop.select?.options)
    return prop.select.options.map((item) => item.name).filter(Boolean);
  if (prop.type === "multi_select" && prop.multi_select?.options)
    return prop.multi_select.options.map((item) => item.name).filter(Boolean);
  return [];
}

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
    const message = typeof data === "string" ? data : data?.message || data?.error || response.statusText;
    throw new Error(message);
  }
  return data;
}

async function queryDatabase(databaseId, body = {}, token = null) {
  return notionFetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    { method: "POST", body: JSON.stringify(body) },
    token,
  );
}

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

async function getDatabase(databaseId, token = null) {
  return notionFetch(`https://api.notion.com/v1/databases/${databaseId}`, { method: "GET" }, token);
}

async function createPage(databaseId, properties, token = null) {
  return notionFetch(
    "https://api.notion.com/v1/pages",
    { method: "POST", body: JSON.stringify({ parent: { database_id: databaseId }, properties }) },
    token,
  );
}

async function getMasterList(databaseId, titlePropertyName, token = null) {
  const data = await queryDatabase(databaseId, { page_size: 100 }, token);
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((page) => {
    const props = page.properties || {};
    const isMeal = titlePropertyName === "タイトル";
    const base = {
      id: page.id,
      label: isMeal ? getTitleText(props["タイトル"]) : getTitleText(props["名前"]),
      icon: getRichTextPlainText(props["アイコン"]) || getSelectText(props["アイコン"]) || null,
      cover: page.cover?.external?.url || page.cover?.file?.url || null,
    };
    if (isMeal) {
      return { ...base, calories: props["カロリー"]?.number ?? null, tags: getMultiSelectText(props["タグ"]) };
    } else {
      return {
        ...base,
        type: getSelectText(props["種類"]) || null,
        difficulty: getSelectText(props["きつさ"]) || null,
        unit: getSelectText(props["基準単位"]) || null,
        calorieRate: props["消費カロリー係数"]?.number ?? null,
      };
    }
  });
}

module.exports = {
  NOTION_VERSION,
  sanitizeText, getTitleText, getRichTextPlainText, getMultiSelectText,
  getSelectText, getStatusText, getRelationIds, toRichText,
  setTitle, setRichText, setDate, setNumber, setSelect, setMultiSelect, setRelation,
  extractPropertyOptions, notionFetch, queryDatabase, queryAllPages,
  getDatabase, createPage, getMasterList,
};
