import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { history, undo, redo } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { parseJsonTokens, indexJsonContainers, formatJson } from "../src/json-tools.mjs";
import { createDocumentAnalysisCache, subtreeFoldEffects, unfoldEditedContainers, nextFoldTarget } from "../src/json-folding.mjs";

const indexOf = (text) => indexJsonContainers(parseJsonTokens(text)).containers;
const stateFor = (doc) => EditorState.create({ doc, extensions: [codeFolding(), history(), unfoldEditedContainers] });
const foldContainers = (state, containers) => state.update({
  effects: containers.filter((container) => container.count > 0).map(({ from, to }) => foldEffect.of({ from, to })),
}).state;
const rangeOf = ({ from, to }) => ({ from, to });
const foldedIn = (state) => {
  const ranges = [];
  const cursor = foldedRanges(state).iter();
  for (; cursor.value; cursor.next()) ranges.push({ from: cursor.from, to: cursor.to });
  return ranges;
};

test("container counts include only immediate properties and array elements", () => {
  const source = '{"duplicate":1,"duplicate":2,"array":[{},[],{"inner":[1,2]},"commas, {} [] \\\"",null,true],"empty":{}}';
  const containers = [...indexOf(source).values()];
  assert.deepEqual(containers.map(({ kind, count }) => [kind, count]), [
    ["object", 4], ["array", 6], ["object", 0], ["array", 0], ["object", 1], ["array", 2], ["object", 0],
  ]);
  for (const container of containers) {
    const opening = source[container.from - 1];
    assert.equal(source[container.to], opening === "{" ? "}" : "]");
  }
  assert.equal(indexOf('"a,b{}[]"').size, 0);
});

test("container indexing remains iterative for deeply nested values", () => {
  const { containers: index, maxDepth } = indexJsonContainers(parseJsonTokens('['.repeat(12000) + '0' + ']'.repeat(12000)));
  const containers = [...index.values()];
  assert.equal(containers.length, 12000);
  assert.equal(containers.every((container) => container.count === 1), true);
  assert.equal(maxDepth, 12000);
});

test("document statistics use container depth and remain current across folds, edits and history", () => {
  const analyze = createDocumentAnalysisCache();
  for (const [text, depth] of [['{}', 1], ['[]', 1], ['{"a":[{},[]],"b":{}}', 3],
    ['"braces { [ ] } 中😀"', 0], ['1793350534', 0], ['true', 0], ['null', 0], ['', null], [' \n\t', null], ['{"a":[}', null]]) {
    const analysis = analyze(stateFor(text));
    assert.equal(analysis.maxDepth, depth, text);
    assert.equal(analysis.byteLength, Buffer.byteLength(text, "utf8"), text);
  }
  const text = '{"中":[[]],"emoji":"😀"}';
  let state = stateFor(text);
  const original = analyze(state);
  state = foldContainers(state, [...original.containers.values()]);
  assert.strictEqual(analyze(state), original);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: '42' } }).state;
  assert.equal(analyze(state).maxDepth, 0);
  assert.equal(analyze(state).byteLength, 2);
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(analyze(state).maxDepth, 3);
  assert.equal(analyze(state).byteLength, original.byteLength);
  assert.equal(redo(target), true);
  assert.equal(analyze(state).maxDepth, 0);
});

test("analysis cache follows document changes and undo without rescanning unchanged documents", () => {
  const analyze = createDocumentAnalysisCache();
  let state = stateFor('[1]');
  const first = analyze(state);
  assert.equal(first.containers.get(1).count, 1);
  assert.strictEqual(analyze(state.update({ selection: { anchor: 1 } }).state), first);
  state = state.update({ changes: { from: 2, insert: ',2' } }).state;
  assert.notStrictEqual(analyze(state), first);
  assert.equal(analyze(state).containers.get(1).count, 2);
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(analyze(state).containers.get(1).count, 1);
  assert.equal(redo(target), true);
  assert.equal(analyze(state).containers.get(1).count, 2);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: '{' } }).state;
  assert.equal(analyze(state).result.ok, false);
  assert.equal(analyze(state).containers.size, 0);
});

test("next fold advances through parents and children in document order, one at a time", () => {
  const source = formatJson('{"a":[{"nested":[1,2]},3],"b":{"value":true},"empty":[]}');
  const containers = [...indexOf(source).values()].filter((container) => container.count);
  let state = foldContainers(stateFor(source), containers);
  const original = state.doc.toString();
  for (let index = 0; index < containers.length; index += 1) {
    const target = nextFoldTarget(state);
    assert.equal(target.from, containers[index].from);
    const line = state.doc.line(target.line);
    assert.equal(target.anchor, line.from + line.text.search(/\S/));
    state = state.update({ effects: unfoldEffect.of(target), selection: { anchor: target.anchor } }).state;
    assert.equal(foldedRanges(state).size, containers.length - index - 1);
    assert.equal(state.doc.toString(), original);
  }
  assert.equal(nextFoldTarget(state), null);
  state = foldContainers(state, [containers[containers.length - 1]]);
  state = foldContainers(state, [containers[1]]);
  assert.equal(nextFoldTarget(state).from, containers[1].from);
});

test("edits unfold affected hidden ancestors while preserving and mapping unrelated folds", () => {
  const source = '{"left":[1],"right":[2]}';
  const containers = [...indexOf(source).values()];
  let state = foldContainers(stateFor(source), containers);
  const position = source.indexOf('1') + 1;
  state = state.update({ changes: { from: position, insert: ',3' } }).state;
  assert.equal(foldedRanges(state).size, 1);
  assert.equal(nextFoldTarget(state).from, containers[2].from + 2);
  assert.equal(indexOf(state.doc.toString()).get(containers[1].from).count, 2);

  const beforeArray = source.indexOf('[2]');
  let unrelated = foldContainers(stateFor(source), [containers[2]]);
  unrelated = unrelated.update({ changes: { from: 0, insert: ' ' } }).state;
  assert.equal(nextFoldTarget(unrelated).from, beforeArray + 2);
  unrelated = unrelated.update({ changes: { from: beforeArray + 2, insert: '3,' } }).state;
  assert.equal(foldedRanges(unrelated).size, 0);
});

test("collapsing one node folds every descendant and unfolding opens only the chosen level", () => {
  const source = formatJson('{"left":{"items":[{"deep":[1,{"leaf":true}]},2],"empty":{},"emptyArray":[]},"right":{"keep":[3]}}');
  const analyze = createDocumentAnalysisCache();
  let state = stateFor(source);
  const containers = [...indexOf(source).values()];
  const left = containers[1];
  const expected = containers.filter((item) => item.count > 0 && item.from >= left.from && item.to <= left.to);
  state = state.update({ effects: subtreeFoldEffects(state, left, analyze) }).state;
  assert.deepEqual(foldedIn(state), expected.map(rangeOf));
  for (const container of expected) {
    const target = nextFoldTarget(state);
    assert.deepEqual(rangeOf(target), rangeOf(container));
    state = state.update({ effects: unfoldEffect.of(target), selection: { anchor: target.anchor } }).state;
    assert.deepEqual(foldedIn(state), expected.filter((item) => item.from > container.from).map(rangeOf));
    assert.equal(state.doc.toString(), source);
  }
  assert.equal(nextFoldTarget(state), null);
});

test("subtree folding preserves sibling folds and deduplicates existing or repeated folds", () => {
  const source = '{"branch":{"first":{"values":[1]},"second":{"nested":[2]}},"keep":{"nested":[3]}}';
  const analyze = createDocumentAnalysisCache();
  const containers = [...indexOf(source).values()];
  const branch = containers[1], first = containers[2], keep = containers[6];
  const descendants = containers.filter((item) => item.from >= branch.from && item.to <= branch.to);
  let state = foldContainers(stateFor(source), [first, keep]);
  const cached = analyze(state);
  const effects = subtreeFoldEffects(state, branch, analyze);
  assert.deepEqual(effects.map((effect) => effect.value), descendants.filter((item) => item !== first).map(rangeOf));
  state = state.update({ effects }).state;
  assert.deepEqual(foldedIn(state), [...descendants, keep].map(rangeOf));
  assert.strictEqual(analyze(state), cached);
  assert.deepEqual(subtreeFoldEffects(state, branch, analyze), []);

  state = state.update({ effects: [unfoldEffect.of(branch), unfoldEffect.of(first)] }).state;
  assert.deepEqual(subtreeFoldEffects(state, branch, analyze).map((effect) => effect.value), [branch, first].map(rangeOf));
  state = state.update({ effects: subtreeFoldEffects(state, branch, analyze) }).state;
  assert.deepEqual(foldedIn(state), [...descendants, keep].map(rangeOf));
  assert.equal(state.doc.toString(), source);
});

test("subtree folding includes inline containers and skips empty containers and primitive values", () => {
  const source = '{"empty":{\n },"emptyArray":[\n ],"text":"{[1]}","values":[1,null]}';
  const state = stateFor(source);
  const containers = [...indexOf(source).values()];
  const effects = subtreeFoldEffects(state, containers[0], createDocumentAnalysisCache());
  assert.deepEqual(effects.map((effect) => effect.value), [containers[0], containers[3]].map(rangeOf));
  const folded = state.update({ effects }).state;
  assert.equal(foldedRanges(folded).size, 2);
  assert.equal(folded.doc.toString(), source);
});

test("invalid JSON still folds complete subtrees including inline descendants", () => {
  const source = '{\n "left": {\n "items": [\n {"deep":[1]},\n {},\n []\n ],\n "empty": {\n \n },\n "text": "{[ ]}"\n },\n "broken":\n}';
  const state = EditorState.create({ doc: source, extensions: [json(), codeFolding()] });
  const containers = [...indexOf(source.replace('"broken":', '"broken":null')).values()];
  const left = containers[1];
  const expected = containers.filter((item) => item.count > 0 && item.from >= left.from && item.to <= left.to);
  const effects = subtreeFoldEffects(state, left, createDocumentAnalysisCache());
  assert.deepEqual(effects.map((effect) => effect.value), expected.map(rangeOf));
  assert.equal(foldedRanges(state.update({ effects }).state).size, expected.length);
});

test("incomplete JSON folds only containers with matching closing delimiters", () => {
  const source = '{\n "good": {"x":[1]},\n "open": [\n {"complete": [2]}\n';
  const state = EditorState.create({ doc: source, extensions: [json(), codeFolding()] });
  const expected = ['{"x":[1]}', '[1]', '{"complete": [2]}', '[2]'].map((text) => ({
    from: source.indexOf(text) + 1, to: source.indexOf(text) + text.length - 1,
  }));
  const effects = subtreeFoldEffects(state, { from: 1, to: source.length }, createDocumentAnalysisCache());
  assert.deepEqual(effects.map((effect) => effect.value), expected);
  const folded = state.update({ effects }).state;
  assert.deepEqual(foldedIn(folded), expected);
  assert.equal(folded.doc.toString(), source);
});

test("edits inside recursively folded nodes unfold affected ancestors and map sibling subtrees", () => {
  const source = '{"left":{"items":[1]},"right":{"items":[2]}}';
  const analyze = createDocumentAnalysisCache();
  const containers = [...indexOf(source).values()];
  let state = stateFor(source);
  for (const branch of [containers[1], containers[3]]) {
    state = state.update({ effects: subtreeFoldEffects(state, branch, analyze) }).state;
  }
  const oldAnalysis = analyze(state);
  state = state.update({ changes: { from: source.indexOf('1') + 1, insert: ',3' } }).state;
  assert.deepEqual(foldedIn(state), containers.slice(3).map(({ from, to }) => ({ from: from + 2, to: to + 2 })));
  assert.notStrictEqual(analyze(state), oldAnalysis);
  assert.equal(analyze(state).containers.get(containers[2].from).count, 2);
});

test("subtree fold collection remains iterative for 12000 nested containers", () => {
  const source = '['.repeat(12000) + '0' + ']'.repeat(12000);
  const state = stateFor(source);
  const effects = subtreeFoldEffects(state, { from: 1, to: source.length - 1 }, createDocumentAnalysisCache());
  assert.equal(effects.length, 12000);
  assert.deepEqual(effects[0].value, { from: 1, to: source.length - 1 });
  assert.deepEqual(effects.at(-1).value, { from: 12000, to: 12001 });
  assert.equal(state.doc.toString(), source);
});

test("a deeply nested subtree folds and reopens one level without changing the document", () => {
  const source = '['.repeat(1000) + '0' + ']'.repeat(1000);
  let state = stateFor(source);
  state = state.update({ effects: subtreeFoldEffects(state, { from: 1, to: source.length - 1 }, createDocumentAnalysisCache()) }).state;
  assert.equal(foldedRanges(state).size, 1000);
  state = state.update({ effects: unfoldEffect.of({ from: 1, to: source.length - 1 }) }).state;
  assert.equal(foldedRanges(state).size, 999);
  assert.equal(nextFoldTarget(state).from, 2);
  assert.equal(state.doc.toString(), source);
});
