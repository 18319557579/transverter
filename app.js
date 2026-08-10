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

  let convertTimer = null;
  let copyResetTimer = null;

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
    copyButton.disabled = !result.ok;
    setStatus(result.message, result.tone);
    updateCounts();
  }

  function resetCopyButton() {
    window.clearTimeout(copyResetTimer);
    copyButton.querySelector("span").textContent = "复制结果";
  }

  async function copyResult() {
    if (!resultOutput.value) return;

    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(resultOutput.value);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      resultOutput.focus();
      resultOutput.select();
      copied = document.execCommand("copy");
      resultOutput.setSelectionRange(0, 0);
    }

    if (copied) {
      copyButton.querySelector("span").textContent = "已复制";
      setStatus("结果已复制到剪贴板", "success");
      copyResetTimer = window.setTimeout(resetCopyButton, 1600);
    } else {
      setStatus("复制失败，请选中结果后使用系统复制", "error");
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
    copyButton.disabled = true;
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
  pasteButton.addEventListener("click", pasteSource);
  clearButton.addEventListener("click", clearAll);

  updateCounts();
  sourceInput.focus();
})();
