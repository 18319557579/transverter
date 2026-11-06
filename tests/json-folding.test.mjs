import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { history, undo, redo } from "@codemirror/commands";
import { parseJsonTokens, indexJsonContainers, formatJson } from "../src/json-tools.mjs";
import { createDocumentAnalysisCache, unfoldEditedContainers, nextFoldTarget } from "../src/json-folding.mjs";

const indexOf = (text) => indexJsonContainers(parseJsonTokens(text)).containers;
const stateFor = (doc) => EditorState.create({ doc, extensions: [codeFolding(), history(), unfoldEditedContainers] });
const foldContainers = (state, containers) => state.update({
  effects: containers.filter((container) => container.count > 0).map(({ from, to }) => foldEffect.of({ from, to })),
}).state;

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
