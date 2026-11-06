import test from "node:test";
import assert from "node:assert/strict";
import { formatJson, minifyJson, parseJsonTokens, validateJson, getHttpLink, getTimestampPreview, getUtf8ByteLength, formatByteSize } from "../src/json-tools.mjs";

test("formatting preserves numeric spelling, duplicate keys, key order and escaped strings", () => {
  const input = '{"10":900719925474099312345,"2":-0,"same":1e+400,"same":2,"text":"中文😀 \\u4e2d \\/ \\\" {} [] \\n","empty":[{},[]]}';
  const expected = [
    "{",
    '    "10": 900719925474099312345,',
    '    "2": -0,',
    '    "same": 1e+400,',
    '    "same": 2,',
    '    "text": "中文😀 \\u4e2d \\/ \\\" {} [] \\n",',
    '    "empty": [',
    '        {},',
    '        []',
    '    ]',
    '}',
  ].join("\n");
  assert.equal(formatJson(input), expected);
  assert.equal(minifyJson(expected), input);
  assert.equal(formatJson(expected), expected);
});

test("all JSON root types and JSON whitespace are supported", () => {
  for (const input of ['{}', '[]', '"你好"', '42', '-0', '1.20e-12', 'true', 'false', 'null', '\r\n [1, {"a":null}]\t ']) {
    assert.equal(validateJson(input).ok, true, input);
    assert.deepEqual(JSON.parse(formatJson(input)), JSON.parse(input));
  }
});

test("strict validation rejects malformed JSON without accepting JavaScript syntax", () => {
  for (const input of ['', ' ', '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", '[}', '{"a" 1}', '{"a":}',
    '01', '-01', '+1', '1.', '.1', '1e', '1e+', 'NaN', 'Infinity', 'undefined', 'true false', '[1 2]',
    '"\\x20"', '"\\u123"', '"\\uZZZZ"', '"line\nbreak"', '"unterminated', '"trailing\\', '\uFEFF{}', '{}\u00a0',
    '/* comment */{}', '{"a":[1,2}', '{"a":true} trailing']) {
    assert.throws(() => JSON.parse(input), undefined, input);
    assert.equal(validateJson(input).ok, false, input);
    assert.throws(() => formatJson(input), undefined, input);
  }
});

test("validation reports the editable line, column and offset", () => {
  const result = validateJson('{\n    "a": 1,\n}');
  assert.equal(result.ok, false);
  assert.equal(result.line, 3);
  assert.equal(result.column, 1);
  assert.equal(result.offset, 14);
  assert.equal(validateJson('{"a":').offset, 5);
});

test("iterative parsing handles deep and large documents", () => {
  const deep = '['.repeat(12000) + '9007199254740993' + ']'.repeat(12000);
  assert.equal(minifyJson(deep), deep);
  const large = JSON.stringify(Array.from({ length: 20000 }, (_, index) => ({ index, name: `记录 ${index} 😀`, active: index % 2 === 0 })));
  const formatted = formatJson(large);
  assert.equal(minifyJson(formatted), large);
});

test("generated valid documents retain their values after both transformations", () => {
  let seed = 123456;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const makeValue = (depth) => {
    const kind = Math.floor(random() * (depth ? 6 : 4));
    if (kind === 0) return null;
    if (kind === 1) return random() > 0.5;
    if (kind === 2) return (random() - 0.5) * 1e15;
    if (kind === 3) return '中😀\\"\n\t{}[]:' + random();
    if (kind === 4) return [makeValue(depth - 1), makeValue(depth - 1)];
    return { a: makeValue(depth - 1), b: makeValue(depth - 1) };
  };
  for (let index = 0; index < 150; index += 1) {
    const input = JSON.stringify(makeValue(4));
    assert.deepEqual(JSON.parse(formatJson(input)), JSON.parse(input));
    assert.equal(minifyJson(formatJson(input)), input);
  }
});

test("only complete HTTP(S) string values can become links", () => {
  assert.equal(getHttpLink('"https:\\/\\/example.com/image?x=1&format=png"'), 'https://example.com/image?x=1&format=png');
  assert.equal(getHttpLink('"HTTP://example.com"'), 'http://example.com/');
  for (const raw of ['"VOVA://room/1"', '"javascript:alert(1)"', '"data:image/png;base64,x"', '"prefix https://example.com"', '" https://example.com"', '"https://"', '123', '"unterminated']) {
    assert.equal(getHttpLink(raw), null, raw);
  }
  const tokens = parseJsonTokens('{"https://key.example":"https://value.example"}');
  assert.equal(tokens.filter((token) => token.type === "string" && !token.isKey).length, 1);
});

test("timestamp previews recognize only 10/13-digit positive integer literals in Beijing time", () => {
  assert.equal(getTimestampPreview("1793350534"), "2026/10/30 16:55:34");
  assert.equal(getTimestampPreview("1793350534999"), "2026/10/30 16:55:34");
  assert.equal(getTimestampPreview("1609430400"), "2021/01/01 00:00:00");
  assert.equal(getTimestampPreview("1609430399999"), "2020/12/31 23:59:59");
  assert.equal(getTimestampPreview("1000000000"), "2001/09/09 09:46:40");
  assert.equal(getTimestampPreview("1000000000000"), "2001/09/09 09:46:40");
  for (const raw of ['"1793350534"', "179335053", "17933505340", "17933505340000", "0", "-1793350534",
    "1793350534.0", "1.793350534e9", "1793350534e0", "0179335053", "1793350534 ", "900719925474099312345"]) {
    assert.equal(getTimestampPreview(raw), null, raw);
  }
});

test("document sizes count current UTF-8 bytes rather than characters or decoded JSON values", () => {
  for (const [text, bytes] of [["", 0], ["ascii", 5], ["中😀", 7], ["\\u4e2d", 6], ["\ud800", 3], ["\r\n", 2]]) {
    assert.equal(getUtf8ByteLength(text), bytes, JSON.stringify(text));
  }
  const raw = '{"文本":"中文😀","nested":[{}]}';
  assert.equal(getUtf8ByteLength(raw), Buffer.byteLength(raw, "utf8"));
  assert.ok(getUtf8ByteLength(formatJson(raw)) > getUtf8ByteLength(raw));
  assert.equal(getUtf8ByteLength(minifyJson(formatJson(raw))), getUtf8ByteLength(raw));
  for (const [bytes, label] of [[0, "0 B"], [1023, "1023 B"], [1024, "1.00 KB"], [1536, "1.50 KB"], [1048576, "1.00 MB"], [2621440, "2.50 MB"]]) {
    assert.equal(formatByteSize(bytes), label);
  }
});
