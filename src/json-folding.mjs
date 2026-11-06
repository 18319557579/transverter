import { EditorState } from "@codemirror/state";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
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
