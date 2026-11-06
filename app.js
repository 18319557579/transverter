(() => {
  "use strict";

  const sourceInput = document.querySelector("#sourceInput");
  const resultOutput = document.querySelector("#resultOutput");
  const sourceCount = document.querySelector("#sourceCount");
  const resultCount = document.querySelector("#resultCount");
  const statusMessage = document.querySelector("#statusMessage");
  const statusText = document.querySelector("#statusText");
  const pasteButton = document.querySelector("#pasteButton");
  const clearButton = document.querySelector("#clearButton");
  const copyButton = document.querySelector("#copyButton");
  const convertButton = document.querySelector("#convertButton");
  const visualizeButton = document.querySelector("#visualizeButton");

  const VIEWER_MESSAGE_SOURCE = "transverter-viewer";
  const PAGE_MESSAGE_SOURCE = "transverter-converter";

  let convertTimer = null;
  let copyResetTimer = null;
  let visualizationTimer = null;
  let visualizationCloseTimer = null;
  let activeVisualizationRequest = null;
  let lastConversionOk = false;

  function setStatus(message, tone = "idle") {
    statusText.textContent = message;
    statusMessage.dataset.tone = tone;
  }

  function updateCounts() {
    sourceCount.textContent = `${sourceInput.value.length.toLocaleString("zh-CN")} 字符`;
    resultCount.textContent = `${resultOutput.value.length.toLocaleString("zh-CN")} 字符`;
  }

  function findJsonEnd(text, startIndex) {
    const stack = [];
    let inString = false;
    let escaped = false;

    // Track nested JSON while ignoring brackets that occur inside string values.
    for (let index = startIndex; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }

      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }

      if (character === "}" || character === "]") {
        const expectedOpening = character === "}" ? "{" : "[";
        if (stack.pop() !== expectedOpening) {
          return { endIndex: index + 1, complete: false, reason: "JSON 括号不匹配" };
        }
        if (stack.length === 0) {
          return { endIndex: index + 1, complete: true };
        }
      }
    }

    return {
      endIndex: text.length,
      complete: false,
      reason: inString ? "JSON 字符串未闭合" : "JSON 内容不完整",
    };
  }

  function extractJson(rawText) {
    if (!rawText.trim()) {
      return { value: "", ok: false, empty: true, message: "等待输入", tone: "idle" };
    }

    const normalizedText = rawText
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n");
    const marker = /\bJson\s*:/i.exec(normalizedText);
    const payloadStart = marker ? marker.index + marker[0].length : 0;
    const payload = normalizedText
      .slice(payloadStart)
      .replace(/\n[\t \f\v\u00a0]*/g, "")
      .replace(/^\uFEFF/, "");
    const openingIndex = payload.search(/[\[{]/);

    if (openingIndex === -1) {
      return {
        value: "",
        ok: false,
        message: marker ? "Json: 后未找到 JSON 对象或数组" : "未找到 JSON 对象或数组",
        tone: "error",
      };
    }

    const boundary = findJsonEnd(payload, openingIndex);
    const value = payload.slice(openingIndex, boundary.endIndex).trim();

    if (!boundary.complete) {
      return { value, ok: false, message: boundary.reason, tone: "error" };
    }

    try {
      JSON.parse(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "语法错误";
      return { value, ok: false, message: `JSON 校验失败：${detail}`, tone: "error" };
    }

    return {
      value,
      ok: true,
      message: marker ? "提取完成，JSON 校验通过" : "未检测到 Json: 标记，已直接转换 JSON",
      tone: marker ? "success" : "warning",
    };
  }

  function convert() {
    window.clearTimeout(convertTimer);
    const result = extractJson(sourceInput.value);
    resultOutput.value = result.value;
    lastConversionOk = result.ok;
    copyButton.disabled = !result.ok;
    visualizeButton.disabled = !result.ok || Boolean(activeVisualizationRequest);
    setStatus(result.message, result.tone);
    updateCounts();
    return result;
  }

  function resetCopyButton() {
    window.clearTimeout(copyResetTimer);
    copyButton.querySelector("span").textContent = "复制结果";
  }

  async function writeResultToClipboard(text = resultOutput.value) {
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      const previousFocus = document.activeElement;
      const temporary = document.createElement("textarea");
      temporary.value = text;
      temporary.setAttribute("readonly", "");
      temporary.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(temporary);
      temporary.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      temporary.remove();
      previousFocus?.focus();
    }

    return copied;
  }

  async function copyResult() {
    if (!resultOutput.value) return;

    const copied = await writeResultToClipboard();

    if (copied) {
      copyButton.querySelector("span").textContent = "已复制";
      setStatus("结果已复制到剪贴板", "success");
      copyResetTimer = window.setTimeout(resetCopyButton, 1600);
    } else {
      setStatus("复制失败，请选中结果后使用系统复制", "error");
    }
  }

  function createRequestId() {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function finishVisualization(message, tone) {
    window.clearTimeout(visualizationTimer);
    window.clearInterval(visualizationCloseTimer);
    activeVisualizationRequest = null;
    visualizeButton.disabled = !lastConversionOk;
    setStatus(message, tone);
  }

  function visualizeResult() {
    const result = convert();
    if (!result.ok) return;
    if (activeVisualizationRequest) return;
    const requestId = createRequestId();
    const url = new URL("jsonviewer.html", window.location.href);
    url.hash = new URLSearchParams({ request: requestId }).toString();

    // 必须在点击事件内同步打开窗口，避免等待剪贴板权限后被浏览器拦截。
    const targetWindow = window.open(url.href, "_blank");
    void writeResultToClipboard(result.value).catch(() => false);
    if (!targetWindow) {
      setStatus("新窗口被浏览器阻止，请允许弹窗，或打开 JSON 可视化页后粘贴结果", "warning");
      return;
    }
    activeVisualizationRequest = { requestId, targetWindow, json: result.value, sent: false };
    visualizeButton.disabled = true;
    setStatus("正在打开本地 JSON 可视化页…", "success");
    visualizationTimer = window.setTimeout(() => {
      if (activeVisualizationRequest?.requestId === requestId) {
        finishVisualization("传入结果超时，请在可视化页手动粘贴，或重试跳转", "error");
      }
    }, 15000);
    visualizationCloseTimer = window.setInterval(() => {
      if (targetWindow.closed) finishVisualization("可视化页已关闭，转换结果仍可复制", "warning");
    }, 300);
  }

  function handleViewerMessage(event) {
    const request = activeVisualizationRequest;
    if (!request || event.source !== request.targetWindow || event.data?.source !== VIEWER_MESSAGE_SOURCE) return;
    const expectedOrigin = window.location.protocol === "file:" ? "null" : window.location.origin;
    if (event.origin !== expectedOrigin || event.data.requestId !== request.requestId) return;
    const message = event.data;
    if (message.type === "READY" && !request.sent) {
      request.sent = true;
      // file:// 的 origin 为 null，用窗口引用和一次性标识验证，正文不进入 URL。
      request.targetWindow.postMessage({
        source: PAGE_MESSAGE_SOURCE,
        type: "PAYLOAD",
        requestId: request.requestId,
        json: request.json,
      }, expectedOrigin === "null" ? "*" : expectedOrigin);
      setStatus("已打开本地页面，正在生成可视化…", "success");
      return;
    }
    if (message.type === "COMPLETE") {
      finishVisualization(message.ok ? "JSON 可视化已生成" : (message.error || "可视化失败，请手动粘贴或重试"), message.ok ? "success" : "error");
    }
  }

  async function pasteSource() {
    if (!navigator.clipboard?.readText || !window.isSecureContext) {
      sourceInput.focus();
      setStatus("请使用系统粘贴到原始文本框", "warning");
      return;
    }

    try {
      sourceInput.value = await navigator.clipboard.readText();
      convert();
      sourceInput.focus();
    } catch {
      sourceInput.focus();
      setStatus("无法读取剪贴板，请使用系统粘贴", "warning");
    }
  }

  function clearAll() {
    window.clearTimeout(convertTimer);
    resetCopyButton();
    sourceInput.value = "";
    resultOutput.value = "";
    lastConversionOk = false;
    copyButton.disabled = true;
    visualizeButton.disabled = true;
    activeVisualizationRequest = null;
    window.clearTimeout(visualizationTimer);
    window.clearInterval(visualizationCloseTimer);
    setStatus("等待输入", "idle");
    updateCounts();
    sourceInput.focus();
  }

  sourceInput.addEventListener("input", () => {
    updateCounts();
    window.clearTimeout(convertTimer);
    convertTimer = window.setTimeout(convert, 140);
  });
  convertButton.addEventListener("click", convert);
  copyButton.addEventListener("click", copyResult);
  visualizeButton.addEventListener("click", visualizeResult);
  pasteButton.addEventListener("click", pasteSource);
  clearButton.addEventListener("click", clearAll);
  window.addEventListener("message", handleViewerMessage);

  updateCounts();
  sourceInput.focus();
})();
