import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, keymap, lineNumbers, drawSelection, highlightSpecialChars, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, indentUnit, bracketMatching, syntaxTree, codeFolding, foldGutter, foldKeymap, foldEffect, unfoldEffect, foldedRanges, unfoldAll } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { tags } from "@lezer/highlight";
import { formatTokens, getHttpLink, getTimestampPreview, formatByteSize } from "./json-tools.mjs";
import { createDocumentAnalysisCache, unfoldEditedContainers, nextFoldTarget } from "./json-folding.mjs";

const statusButton = document.querySelector("#validationStatus");
const statusText = document.querySelector("#statusText");
const documentStats = document.querySelector("#documentStats");
const textStats = document.querySelector("#textStats");
const fileSize = document.querySelector("#fileSize");
const jsonDepth = document.querySelector("#jsonDepth");
const copyButton = document.querySelector("#copyButton");
const expandNextButton = document.querySelector("#expandNextButton");
const imagePreview = document.querySelector("#imagePreview");
const timestampPreview = document.querySelector("#timestampPreview");
const analyzeDocument = createDocumentAnalysisCache();
let validationTimer, copyResetTimer;
let lastError = null;

function setStatus(message, tone = "idle", error = null) {
  statusText.textContent = message;
  statusButton.dataset.tone = tone;
  statusButton.disabled = !error;
  statusButton.title = error ? `${message}，点击定位` : message;
  lastError = error;
}

let previewTimer;
let previewGeneration = 0;
let previewKey = null;
let activePreview = null;
let pointer = { x: 0, y: 0 };

function hidePreview() {
  window.clearTimeout(previewTimer);
  previewGeneration += 1;
  previewKey = null;
  activePreview = null;
  imagePreview.hidden = true;
  imagePreview.replaceChildren();
  timestampPreview.hidden = true;
  timestampPreview.textContent = "";
}

function positionPreview() {
  if (!activePreview || activePreview.hidden) return;
  const { width, height } = activePreview.getBoundingClientRect();
  let x = pointer.x + 18, y = pointer.y + 18;
  if (x + width > window.innerWidth - 12) x = pointer.x - width - 18;
  if (y + height > window.innerHeight - 12) y = pointer.y - height - 18;
  activePreview.style.left = `${Math.max(12, Math.min(x, window.innerWidth - width - 12))}px`;
  activePreview.style.top = `${Math.max(12, Math.min(y, window.innerHeight - height - 12))}px`;
}

function queuePreview(key, event, show) {
  pointer = { x: event.clientX, y: event.clientY };
  if (previewKey === key) { positionPreview(); return; }
  hidePreview();
  previewKey = key;
  const generation = previewGeneration;
  previewTimer = window.setTimeout(() => show(generation), 250);
}

function showLinkPreview(url, event) {
  queuePreview(`image:${url}`, event, (generation) => {
    // 直接尝试图片解码，兼容无扩展名地址，不依赖跨域 HEAD 请求。
    const image = new Image();
    image.alt = "链接图片预览";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      if (generation !== previewGeneration) return;
      imagePreview.replaceChildren(image);
      activePreview = imagePreview;
      imagePreview.hidden = false;
      positionPreview();
    };
    image.onerror = () => { if (generation === previewGeneration) hidePreview(); };
    image.src = url;
  });
}

function showTimestampPreview(element, event) {
  const time = element.dataset.jsonTimestamp;
  queuePreview(`timestamp:${element.dataset.jsonOffset}:${time}`, event, () => {
    const label = document.createElement("span");
    label.className = "timestamp-label";
    label.textContent = "北京时间";
    const value = document.createElement("span");
    value.textContent = time;
    timestampPreview.replaceChildren(label, value);
    activePreview = timestampPreview;
    timestampPreview.hidden = false;
    positionPreview();
  });
}

function linkElement(target) {
  return target instanceof Element ? target.closest(".cm-json-link") : null;
}

function editorDecorations(view) {
  const decorations = [], lines = new Set(), values = new Set();
  for (const range of view.visibleRanges) {
    for (let position = range.from; position <= range.to;) {
      const line = view.state.doc.lineAt(position);
      if (!lines.has(line.from)) {
        lines.add(line.from);
        const prefix = /^[ \t]+/.exec(line.text)?.[0] ?? "";
        const width = [...prefix].reduce((sum, character) => sum + (character === "\t" ? 4 : 1), 0);
        if (width >= 4) decorations.push(Decoration.line({ attributes: { class: "cm-json-indent", style: `--indent-width: ${width}ch` } }).range(line.from));
      }
      position = line.to + 1;
    }
    syntaxTree(view.state).iterate({
      from: range.from, to: range.to,
      enter(node) {
        if ((node.name !== "String" && node.name !== "Number") || values.has(node.from)) return;
        values.add(node.from);
        const raw = view.state.sliceDoc(node.from, node.to);
        if (node.name === "Number") {
          const time = getTimestampPreview(raw);
          if (time) decorations.push(Decoration.mark({
            class: "cm-json-timestamp", attributes: { "data-json-timestamp": time, "data-json-offset": String(node.from) },
          }).range(node.from, node.to));
          return;
        }
        const url = getHttpLink(raw);
        if (url && node.to - node.from > 2) decorations.push(Decoration.mark({
          class: "cm-json-link", attributes: { "data-json-url": url, title: "Ctrl+点击打开链接" },
        }).range(node.from + 1, node.to - 1));
      },
    });
  }
  return Decoration.set(decorations, true);
}

// 只装饰可见行，长文档由编辑器虚拟化；折叠从不删除完整文档的内容。
const decorationPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = editorDecorations(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = editorDecorations(update.view);
    if (update.docChanged || update.viewportChanged || foldedRanges(update.startState) !== foldedRanges(update.state)) hidePreview();
  }
}, { decorations: (plugin) => plugin.decorations });

const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "#d5e0e8", backgroundColor: "#1d2b35", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: '"Cascadia Code", Consolas, "Liberation Mono", monospace', lineHeight: "1.6" },
  ".cm-content": { padding: "18px 0 40px", caretColor: "#d5f9f2", minHeight: "100%" },
  ".cm-line": { padding: "0 6px" },
  ".cm-gutters": { backgroundColor: "#1d2b35", color: "#70838f", border: "none", padding: "0 5px 0 12px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", paddingRight: "10px", fontSize: "12px" },
  ".cm-foldGutter .cm-gutterElement": { width: "24px", padding: "0", textAlign: "center", color: "#9cafb9", cursor: "pointer" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "#b8f5e8" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#b8f5e8" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#395568 !important" },
  ".cm-foldPlaceholder": { margin: "0 4px", padding: "0 6px", border: "1px solid #485d69", borderRadius: "3px", backgroundColor: "#293d49", color: "#a5bac6", cursor: "pointer" },
  ".cm-matchingBracket": { color: "inherit", backgroundColor: "#49705d66", outline: "1px solid #6d9f88" },
  ".cm-placeholder": { color: "#70838f", fontStyle: "normal" },
  "@media (max-width: 600px)": { ".cm-gutters": { paddingLeft: "4px" } },
}, { dark: true });

const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "#55dff2" },
  { tag: tags.string, color: "#70df98" },
  { tag: tags.number, color: "#ffb454" },
  { tag: tags.bool, color: "#cba0f1" },
  { tag: tags.null, color: "#a3b0bc" },
  { tag: tags.brace, color: "#ffffff" },
  { tag: tags.squareBracket, color: "#ffe6a0" },
  { tag: tags.separator, color: "#c8d4dc" },
]);

function foldMarker(open) {
  const marker = document.createElement("span");
  marker.className = "cm-foldControl";
  marker.title = open ? "收起" : "展开";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("aria-hidden", "true");
  const triangle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  triangle.setAttribute("d", open ? "M3 5 8 11 13 5Z" : "M5 3 11 8 5 13Z");
  triangle.setAttribute("fill", "currentColor");
  icon.appendChild(triangle);
  marker.appendChild(icon);
  return marker;
}

const editor = new EditorView({
  parent: document.querySelector("#editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(), drawSelection(), highlightSpecialChars(), history(), json(),
      indentUnit.of("    "), EditorState.tabSize.of(4), bracketMatching(),
      syntaxHighlighting(highlightStyle), editorTheme,
      placeholder("在这里粘贴 JSON，点击「可视化」即可格式化。"),
      EditorView.contentAttributes.of({ "aria-label": "JSON 编辑区", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorState.phrases.of({ "Fold line": "收起", "Unfold line": "展开", "unfold": "展开", "folded code": "已折叠的 JSON" }),
      codeFolding({
        preparePlaceholder(state, range) {
          const container = analyzeDocument(state).containers.get(range.from);
          return container?.to === range.to ? container : null;
        },
        placeholderDOM(view, onclick, container) {
          const element = document.createElement("span");
          element.className = "cm-foldPlaceholder";
          element.textContent = container ? ` … ${container.count} 项 ` : " … ";
          const detail = container ? `${container.count} 个${container.kind === "object" ? "属性" : "元素"}` : "JSON";
          element.title = `展开（${detail}）`;
          element.setAttribute("aria-label", `已收起，${detail}，点击展开`);
          element.onclick = onclick;
          return element;
        },
      }),
      foldGutter({ markerDOM: foldMarker }), unfoldEditedContainers,
      keymap.of([
        { key: "Mod-Enter", run: () => { visualize(); return true; } },
        { key: "Ctrl-Alt-[", run: () => { collapseEverything(); return true; } },
        ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
      ]), decorationPlugin,
      EditorView.domEventHandlers({
        mousemove(event) {
          const link = linkElement(event.target);
          if (link) showLinkPreview(link.dataset.jsonUrl, event);
          else {
            const timestamp = event.target instanceof Element ? event.target.closest(".cm-json-timestamp") : null;
            if (timestamp) showTimestampPreview(timestamp, event);
            else hidePreview();
          }
        },
        mouseleave() { hidePreview(); },
        mousedown(event) {
          const link = linkElement(event.target);
          if (link && event.button === 0 && (event.ctrlKey || event.metaKey)) {
            hidePreview();
            window.open(link.dataset.jsonUrl, "_blank", "noopener,noreferrer");
            event.preventDefault();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || foldedRanges(update.startState) !== foldedRanges(update.state)) updateExpandNextButton();
        if (!update.docChanged) return;
        updateStats();
        window.clearTimeout(validationTimer);
        setStatus("等待校验…");
        validationTimer = window.setTimeout(() => validateDocument(), 500);
      }),
    ],
  }),
});

function updateStats(analysis = null) {
  const { doc } = editor.state;
  textStats.textContent = `${doc.lines.toLocaleString("zh-CN")} 行 · ${doc.length.toLocaleString("zh-CN")} 字符`;
  const pending = !analysis && doc.length > 0;
  documentStats.setAttribute("aria-busy", String(pending));
  fileSize.textContent = pending ? "大小 更新中…" : `大小 ${formatByteSize(analysis?.byteLength ?? 0)}`;
  fileSize.title = pending ? "正在计算当前文本的 UTF-8 大小" : `${(analysis?.byteLength ?? 0).toLocaleString("zh-CN")} 字节（UTF-8，包含空白与折叠内容）`;
  jsonDepth.textContent = pending ? "深度 更新中…" : `深度 ${analysis?.maxDepth ?? "—"}`;
  copyButton.disabled = doc.length === 0;
}

function updateExpandNextButton() {
  expandNextButton.disabled = foldedRanges(editor.state).size === 0;
}

function validateDocument() {
  window.clearTimeout(validationTimer);
  const analysis = analyzeDocument(editor.state);
  const { result } = analysis;
  updateStats(analysis);
  if (result.ok) setStatus("JSON 有效", "success");
  else if (result.empty) setStatus("等待输入");
  else setStatus(`第 ${result.line} 行，第 ${result.column} 列：${result.message}`, "error", result);
  return result;
}

function focusError() {
  if (!lastError) return;
  const offset = Math.min(lastError.offset, editor.state.doc.length);
  editor.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: "center" }) });
  editor.focus();
}

function replaceDocument(text, userEvent) {
  hidePreview();
  unfoldAll(editor);
  if (text !== editor.state.doc.toString()) editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    selection: { anchor: 0 }, scrollIntoView: true,
    annotations: [Transaction.userEvent.of(userEvent), isolateHistory.of("full")],
  });
}

function visualize() {
  const result = validateDocument();
  if (!result.ok) { focusError(); return false; }
  replaceDocument(formatTokens(result.tokens), "input.format");
  window.clearTimeout(validationTimer);
  updateStats(analyzeDocument(editor.state));
  setStatus("已可视化 · 4 空格缩进", "success");
  editor.focus();
  return true;
}

function compress() {
  const result = validateDocument();
  if (!result.ok) { focusError(); return; }
  replaceDocument(formatTokens(result.tokens, true), "input.compress");
  window.clearTimeout(validationTimer);
  updateStats(analyzeDocument(editor.state));
  setStatus("已压缩", "success");
  editor.focus();
}

function collapseEverything() {
  const result = validateDocument();
  if (!result.ok) { focusError(); return; }
  const effects = [...analyzeDocument(editor.state).containers.values()]
    .filter((container) => container.count > 0)
    .map(({ from, to }) => foldEffect.of({ from, to }));
  // 同时收起所有层级，重新展开父节点后，子节点仍保持收起状态。
  if (effects.length) {
    effects.sort((left, right) => left.value.from - right.value.from);
    editor.dispatch({ effects });
  }
  hidePreview();
  setStatus(effects.length ? "已全部收起" : "没有可收起的对象或数组", "success");
  editor.focus();
}

function expandNext() {
  const target = nextFoldTarget(editor.state);
  if (!target) { updateExpandNextButton(); setStatus("已全部展开", "success"); return; }
  editor.dispatch({
    effects: [unfoldEffect.of(target), EditorView.scrollIntoView(target.anchor, { y: "center" })],
    selection: { anchor: target.anchor },
  });
  hidePreview();
  setStatus(expandNextButton.disabled ? "已全部展开" : `已展开第 ${target.line} 行`, "success");
  editor.focus();
}

async function copyDocument() {
  const text = editor.state.doc.toString();
  if (!text) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch { /* 本地文件或权限受限时使用系统复制的兼容方式。 */ }
  if (!copied) {
    const temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.setAttribute("readonly", "");
    temporary.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(temporary);
    temporary.select();
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    temporary.remove();
    editor.focus();
  }
  if (!copied) { setStatus("复制失败，请在编辑区全选后使用 Ctrl+C", "warning"); return; }
  window.clearTimeout(copyResetTimer);
  copyButton.querySelector("span").textContent = "已复制";
  copyResetTimer = window.setTimeout(() => { copyButton.querySelector("span").textContent = "复制"; }, 1600);
}

async function pasteDocument() {
  try {
    if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
    const text = await navigator.clipboard.readText();
    editor.dispatch(editor.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
    editor.focus();
  } catch {
    editor.focus();
    setStatus("请在编辑区使用 Ctrl+V 粘贴", "warning");
  }
}

document.querySelector("#visualizeButton").addEventListener("click", visualize);
document.querySelector("#validateButton").addEventListener("click", () => { validateDocument(); focusError(); });
document.querySelector("#compressButton").addEventListener("click", compress);
document.querySelector("#expandButton").addEventListener("click", () => {
  unfoldAll(editor); hidePreview();
  if (validateDocument().ok) setStatus("已全部展开", "success");
  editor.focus();
});
document.querySelector("#collapseButton").addEventListener("click", collapseEverything);
expandNextButton.addEventListener("click", expandNext);
document.querySelector("#clearButton").addEventListener("click", () => {
  replaceDocument("", "delete.clear");
  window.clearTimeout(validationTimer);
  setStatus("等待输入"); editor.focus();
});
copyButton.addEventListener("click", copyDocument);
document.querySelector("#pasteButton").addEventListener("click", pasteDocument);
statusButton.addEventListener("click", focusError);
window.addEventListener("resize", hidePreview);
editor.scrollDOM.addEventListener("scroll", hidePreview, { passive: true });
window.addEventListener("blur", () => { hidePreview(); document.body.classList.remove("ctrl-pressed"); });
window.addEventListener("keydown", (event) => document.body.classList.toggle("ctrl-pressed", event.ctrlKey || event.metaKey));
window.addEventListener("keyup", (event) => document.body.classList.toggle("ctrl-pressed", event.ctrlKey || event.metaKey));

function receiveConvertedJson() {
  const requestId = new URLSearchParams(window.location.hash.slice(1)).get("request");
  const sourceWindow = window.opener;
  if (!requestId || !sourceWindow) return;
  const expectedOrigin = window.location.protocol === "file:" ? "null" : window.location.origin;
  const targetOrigin = expectedOrigin === "null" ? "*" : expectedOrigin;
  let readyTimer, timeoutTimer;
  function cleanup() {
    window.clearInterval(readyTimer);
    window.clearTimeout(timeoutTimer);
    window.removeEventListener("message", receivePayload);
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      window.opener = null;
    } catch { /* 清理地址或 opener 失败不影响已接收的文档。 */ }
  }
  function receivePayload(event) {
    const message = event.data;
    if (event.source !== sourceWindow || event.origin !== expectedOrigin || message?.source !== "transverter-converter" || message.requestId !== requestId || message.type !== "PAYLOAD") return;
    cleanup();
    let ok = false, error;
    try {
      if (typeof message.json !== "string") throw new Error("收到的 JSON 内容无效");
      replaceDocument(message.json, "input.load");
      ok = visualize();
      if (!ok) error = "收到的 JSON 校验失败，请在可视化页查看错误";
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "生成可视化失败";
      setStatus(error, "error");
    }
    sourceWindow.postMessage({ source: "transverter-viewer", type: "COMPLETE", requestId, ok, error }, targetOrigin);
  }
  window.addEventListener("message", receivePayload);
  const announce = () => sourceWindow.postMessage({ source: "transverter-viewer", type: "READY", requestId }, targetOrigin);
  setStatus("正在接收转换结果…");
  readyTimer = window.setInterval(announce, 200);
  timeoutTimer = window.setTimeout(() => { cleanup(); setStatus("未收到转换结果，请粘贴 JSON 或重新跳转", "warning"); }, 12000);
  announce();
}

updateStats(analyzeDocument(editor.state));
updateExpandNextButton();
editor.focus();
receiveConvertedJson();
