import { EditorState } from "@codemirror/state";
import { foldedRanges, foldEffect, unfoldEffect, syntaxTree } from "@codemirror/language";
import { validateJson, indexJsonContainers, getUtf8ByteLength } from "./json-tools.mjs";

export function createDocumentAnalysisCache() {
  let document = null;
  let cached = null;
  return (state) => {
    if (document !== state.doc) {
      document = state.doc;
      const text = document.toString();
      const result = validateJson(text);
      const structure = result.ok ? indexJsonContainers(result.tokens) : { containers: new Map(), maxDepth: null };
      cached = { result, ...structure, byteLength: getUtf8ByteLength(text) };
    }
    return cached;
  };
}

export function subtreeFoldEffects(state, range, analyzeDocument) {
  const folded = new Set();
  foldedRanges(state).between(range.from, range.to, (from, to) => folded.add(`${from}:${to}`));
  const ranges = new Map();
  const add = (from, to) => {
    const key = `${from}:${to}`;
    if (from >= range.from && to <= range.to && from < to && !folded.has(key)) ranges.set(key, { from, to });
  };
  const analysis = analyzeDocument(state);
  if (analysis.result.ok) {
    // 索引包含所有层级和行内容器，一次遍历即可收起整棵子树。
    for (const container of analysis.containers.values()) {
      if (container.from > range.to) break;
      if (container.count > 0) add(container.from, container.to);
    }
  } else {
    // 编辑中的 JSON 可能不完整，只使用语法树中首尾括号完整的非空容器。
    syntaxTree(state).iterate({
      from: Math.max(0, range.from - 1), to: Math.min(state.doc.length, range.to + 1),
      enter(node) {
        if (node.name !== "Object" && node.name !== "Array") return;
        const first = node.node.firstChild, last = node.node.lastChild;
        const object = node.name === "Object";
        if (first?.name === (object ? "{" : "[") && last?.name === (object ? "}" : "]") &&
            first.nextSibling?.from < last.from) add(first.to, last.from);
      },
    });
  }
  // CodeMirror 要求同一事务中的折叠范围按起点排列；已折叠范围不重复提交。
  return [...ranges.values()].sort((left, right) => left.from - right.from || right.to - left.to)
    .map((value) => foldEffect.of(value));
}

// 输入、粘贴或外部修改触及隐藏内容时先展开，避免旧的计数留在占位符中。
export const unfoldEditedContainers = EditorState.transactionExtender.of((transaction) => {
  if (!transaction.docChanged) return null;
  const folded = foldedRanges(transaction.startState);
  if (!folded.size) return null;
  const effects = new Map();
  transaction.changes.iterChangedRanges((from, to) => {
    folded.between(Math.max(0, from - 1), Math.min(transaction.startState.doc.length, to + 1), (foldFrom, foldTo) => {
      if (foldFrom > to || foldTo < from) return;
      const mappedFrom = transaction.changes.mapPos(foldFrom, 1);
      const mappedTo = transaction.changes.mapPos(foldTo, -1);
      if (mappedFrom < mappedTo) effects.set(`${mappedFrom}:${mappedTo}`, unfoldEffect.of({ from: mappedFrom, to: mappedTo }));
    });
  });
  return effects.size ? { effects: [...effects.values()] } : null;
});

export function nextFoldTarget(state) {
  // RangeSet 按文档位置排列，父节点总在其隐藏子节点之前，无需维护额外游标。
  const first = foldedRanges(state).iter();
  if (!first.value) return null;
  const line = state.doc.lineAt(Math.max(0, first.from - 1));
  const anchor = line.from + Math.max(0, line.text.search(/\S/));
  return { from: first.from, to: first.to, anchor, line: line.number };
}
