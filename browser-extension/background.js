"use strict";

const TARGET_URL = "http://www.esjson.com/jsonviewer.html";
const STORAGE_PREFIX = "visualization:";
const STATUS_PREFIX = "visualization-status:";
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_AGE = 10 * 60 * 1000;

function storageKey(token) {
  return `${STORAGE_PREFIX}${token}`;
}

function statusKey(requestId) {
  return `${STATUS_PREFIX}${requestId}`;
}

function isAllowedLocalPage(urlText) {
  try {
    const url = new URL(urlText);
    return (
      url.protocol === "file:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function isEsjsonPage(urlText) {
  try {
    const url = new URL(urlText);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname === "www.esjson.com" &&
      url.pathname === "/jsonviewer.html"
    );
  } catch {
    return false;
  }
}

async function cleanupExpiredRecords() {
  const records = await chrome.storage.session.get(null);
  const expiredKeys = Object.entries(records)
    .filter(
      ([key, value]) =>
        (key.startsWith(STORAGE_PREFIX) || key.startsWith(STATUS_PREFIX)) &&
        (!value?.createdAt || Date.now() - value.createdAt > MAX_RECORD_AGE),
    )
    .map(([key]) => key);

  if (expiredKeys.length) await chrome.storage.session.remove(expiredKeys);
}

async function openVisualizer(message, sender) {
  if (!isAllowedLocalPage(sender.url) || typeof sender.tab?.id !== "number") {
    throw new Error("请求来源不受支持");
  }
  if (typeof message.json !== "string" || typeof message.requestId !== "string") {
    throw new Error("转换结果无效");
  }

  JSON.parse(message.json);
  if (new TextEncoder().encode(message.json).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("JSON 超过 8 MB，请使用复制结果方式");
  }

  await cleanupExpiredRecords();

  const token = crypto.randomUUID();
  const key = storageKey(token);
  const record = {
    json: message.json,
    requestId: message.requestId,
    sourceTabId: sender.tab.id,
    targetTabId: null,
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [key]: record });

  try {
    const targetTab = await chrome.tabs.create({ url: "about:blank", active: true });
    record.targetTabId = targetTab.id;
    await chrome.storage.session.set({ [key]: record });
    await chrome.tabs.update(targetTab.id, {
      url: `${TARGET_URL}#transverter=${encodeURIComponent(token)}`,
    });
    return { ok: true };
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
}

async function getPayload(message, sender) {
  if (!isEsjsonPage(sender.url) || typeof sender.tab?.id !== "number") {
    throw new Error("目标页面不受支持");
  }

  const key = storageKey(message.token);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record || record.targetTabId !== sender.tab.id) {
    throw new Error("未找到待处理的 JSON 数据");
  }

  return { ok: true, json: record.json };
}

async function finishVisualization(message, sender) {
  if (!isEsjsonPage(sender.url) || typeof sender.tab?.id !== "number") {
    throw new Error("目标页面不受支持");
  }

  const key = storageKey(message.token);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record || record.targetTabId !== sender.tab.id) {
    return { ok: true };
  }

  await chrome.storage.session.set({
    [statusKey(record.requestId)]: {
      sourceTabId: record.sourceTabId,
      success: Boolean(message.success),
      error: message.error,
      createdAt: Date.now(),
    },
  });
  await chrome.storage.session.remove(key);

  return { ok: true };
}

async function getVisualizationStatus(message, sender) {
  if (!isAllowedLocalPage(sender.url) || typeof sender.tab?.id !== "number") {
    throw new Error("请求来源不受支持");
  }

  const key = statusKey(message.requestId);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record) return { ok: true, complete: false };
  if (record.sourceTabId !== sender.tab.id) throw new Error("状态请求来源不匹配");

  await chrome.storage.session.remove(key);
  return {
    ok: true,
    complete: true,
    success: Boolean(record.success),
    error: record.error,
  };
}

async function routeMessage(message, sender) {
  if (message?.type === "OPEN_ESJSON_VISUALIZER") return openVisualizer(message, sender);
  if (message?.type === "GET_VISUALIZATION_PAYLOAD") return getPayload(message, sender);
  if (message?.type === "FINISH_VISUALIZATION") return finishVisualization(message, sender);
  if (message?.type === "GET_VISUALIZATION_STATUS") {
    return getVisualizationStatus(message, sender);
  }
  throw new Error("未知的扩展请求");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  routeMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "扩展处理失败" }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const records = await chrome.storage.session.get(null);
    const abandonedRecords = Object.entries(records).filter(
      ([key, value]) => key.startsWith(STORAGE_PREFIX) && value?.targetTabId === tabId,
    );
    const abandonedKeys = abandonedRecords.map(([key]) => key);
    const failureStatuses = Object.fromEntries(
      abandonedRecords.map(([, value]) => [
        statusKey(value.requestId),
        {
          sourceTabId: value.sourceTabId,
          success: false,
          error: "ESJSON 标签页已关闭，结果已复制",
          createdAt: Date.now(),
        },
      ]),
    );
    if (Object.keys(failureStatuses).length) {
      await chrome.storage.session.set(failureStatuses);
    }
    if (abandonedKeys.length) await chrome.storage.session.remove(abandonedKeys);
  } catch {
    // Session storage is cleared automatically when the browser session ends.
  }
});
