export class JsonSyntaxError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = "JsonSyntaxError";
    this.offset = offset;
  }
}

const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const whitespacePattern = /[ \t\r\n]/;

// 只记录原始 token，不把数字转换成 JS Number，避免长 ID 和指数被改写。
export function parseJsonTokens(text) {
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const character = text[offset];
    if (whitespacePattern.test(character)) {
      offset += 1;
      continue;
    }

    const from = offset;
    let type;
    if ('{}[]:,'.includes(character)) {
      type = character;
      offset += 1;
    } else if (character === '"') {
      type = "string";
      offset += 1;
      let closed = false;
      while (offset < text.length) {
        const current = text[offset];
        if (current === '"') {
          offset += 1;
          closed = true;
          break;
        }
        if (current.charCodeAt(0) < 0x20) {
          throw new JsonSyntaxError("字符串中含有未转义的换行或控制字符", offset);
        }
        if (current === "\\") {
          offset += 1;
          if (offset >= text.length) break;
          const escape = text[offset];
          if (escape === "u") {
            if (!/^[\da-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) {
              throw new JsonSyntaxError("Unicode 转义需要四位十六进制字符", offset);
            }
            offset += 5;
            continue;
          }
          if (!'"\\/bfnrt'.includes(escape)) {
            throw new JsonSyntaxError("无效的字符串转义", offset);
          }
        }
        offset += 1;
      }
      if (!closed) throw new JsonSyntaxError("字符串未闭合", text.length);
    } else if (character === "-" || /\d/.test(character)) {
      numberPattern.lastIndex = offset;
      const match = numberPattern.exec(text);
      if (!match) throw new JsonSyntaxError("无效的数字", offset);
      type = "number";
      offset = numberPattern.lastIndex;
    } else {
      const literal = ["true", "false", "null"].find((value) => text.startsWith(value, offset));
      if (!literal) throw new JsonSyntaxError(`无法识别的字符 ${JSON.stringify(character)}`, offset);
      type = literal === "null" ? "null" : "boolean";
      offset += literal.length;
    }
    tokens.push({ type, from, to: offset, raw: text.slice(from, offset), isKey: false });
  }

  // 使用显式栈校验结构，深层 JSON 不依赖 JavaScript 的递归调用栈。
  const stack = [{ type: "root", state: "value" }];
  for (const token of tokens) {
    const container = stack[stack.length - 1];
    const fail = (message) => { throw new JsonSyntaxError(message, token.from); };

    if (container.state === "key" || container.state === "keyOrEnd") {
      if (token.type === "}" && container.state === "keyOrEnd") {
        stack.pop();
      } else if (token.type === "string") {
        token.isKey = true;
        container.state = "colon";
      } else {
        fail("对象属性名需要使用双引号，且末尾不能有多余逗号");
      }
      continue;
    }
    if (container.state === "colon") {
      if (token.type !== ":") fail("属性名后缺少冒号");
      container.state = "value";
      continue;
    }
    if (container.state === "commaOrEnd") {
      const closing = container.type === "object" ? "}" : "]";
      if (token.type === closing) stack.pop();
      else if (token.type === ",") container.state = container.type === "object" ? "key" : "value";
      else fail(`此处需要逗号或 ${closing}`);
      continue;
    }
    if (container.state === "done") fail("JSON 结束后存在多余内容");
    if (container.state === "valueOrEnd" && token.type === "]") {
      stack.pop();
      continue;
    }
    if (!["{", "[", "string", "number", "boolean", "null"].includes(token.type)) {
      fail("此处需要 JSON 值，不能有多余逗号或不匹配的括号");
    }
    container.state = container.type === "root" ? "done" : "commaOrEnd";
    if (token.type === "{") stack.push({ type: "object", state: "keyOrEnd" });
    if (token.type === "[") stack.push({ type: "array", state: "valueOrEnd" });
  }
  if (stack.length !== 1 || stack[0].state !== "done") {
    throw new JsonSyntaxError(tokens.length ? "JSON 内容不完整" : "请输入 JSON 内容", text.length);
  }
  return tokens;
}

export function validateJson(text) {
  try {
    return { ok: true, tokens: parseJsonTokens(text) };
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    const offset = Math.min(error.offset, text.length);
    const lines = text.slice(0, offset).split(/\r\n?|\n/);
    return {
      ok: false,
      empty: /^[ \t\r\n]*$/.test(text),
      message: error.message,
      offset,
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    };
  }
}

// 每个容器只统计直接子项；属性 token 独立计数，因此重复键也不会被合并。
export function indexJsonContainers(tokens) {
  const containers = new Map();
  const stack = [];
  let maxDepth = 0;
  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type === "{" || token.type === "[") {
      if (parent?.kind === "array") parent.count += 1;
      const container = {
        kind: token.type === "{" ? "object" : "array",
        start: token.from,
        from: token.to,
        to: token.to,
        count: 0,
      };
      containers.set(container.from, container);
      stack.push(container);
      maxDepth = Math.max(maxDepth, stack.length);
    } else if (token.type === "}" || token.type === "]") {
      stack.pop().to = token.from;
    } else if (parent?.kind === "object" && token.isKey) {
      parent.count += 1;
    } else if (parent?.kind === "array" && ["string", "number", "boolean", "null"].includes(token.type)) {
      parent.count += 1;
    }
  }
  return { containers, maxDepth };
}

const utf8Encoder = new TextEncoder();

export function getUtf8ByteLength(text) {
  return utf8Encoder.encode(text).byteLength;
}

export function formatByteSize(bytes) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function getTimestampPreview(rawNumber) {
  // 仅在提示中转换约定长度的整数，不改写文档中的数值或长 ID。
  if (!/^(?:[1-9]\d{9}|[1-9]\d{12})$/.test(rawNumber)) return null;
  const milliseconds = Number(rawNumber) * (rawNumber.length === 10 ? 1000 : 1);
  const parts = Object.fromEntries(timestampFormatter.formatToParts(milliseconds).map(({ type, value }) => [type, value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatTokens(tokens, compact = false) {
  if (compact) return tokens.map((token) => token.raw).join("");
  const output = [];
  let depth = 0;
  const newline = () => output.push("\n", "    ".repeat(depth));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "{" || token.type === "[") {
      output.push(token.raw);
      const closing = token.type === "{" ? "}" : "]";
      if (tokens[index + 1]?.type !== closing) {
        depth += 1;
        newline();
      }
    } else if (token.type === "}" || token.type === "]") {
      const opening = token.type === "}" ? "{" : "[";
      if (tokens[index - 1]?.type !== opening) {
        depth -= 1;
        newline();
      }
      output.push(token.raw);
    } else if (token.type === ",") {
      output.push(",");
      newline();
    } else if (token.type === ":") {
      output.push(": ");
    } else {
      output.push(token.raw);
    }
  }
  return output.join("");
}

export function formatJson(text) {
  return formatTokens(parseJsonTokens(text));
}

export function minifyJson(text) {
  return formatTokens(parseJsonTokens(text), true);
}

export function getHttpLink(rawString) {
  try {
    // 只解码字符串本身，不经过对象反序列化；键名由调用方排除。
    const value = JSON.parse(rawString);
    if (typeof value !== "string" || value !== value.trim() || !/^https?:\/\//i.test(value)) return null;
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const namedColors = new Set((
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
  "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
  "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
  "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
  "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
  "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
  "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
  "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
  "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
  "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
  "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
  "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet " +
  "wheat white whitesmoke yellow yellowgreen"
).split(" "));

export function getColorPreview(rawString, supportsColor = (color) => globalThis.CSS?.supports("color", color) ?? false) {
  let value;
  try { value = JSON.parse(rawString); } catch { return null; }
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{8}$/.test(color)) {
    // 8 位值约定为 Android ARGB，仅在预览时换成浏览器使用的 RGBA 顺序。
    return `#${color.slice(3)}${color.slice(1, 3)}`;
  }
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6})$/.test(color) || namedColors.has(color)) return color;
  // 限定为独立的数值颜色，避免 CSS.supports 接受 var()、currentColor 或系统颜色。
  if (/^(?:rgba?|hsla?)\((?:[-+.\de,%/\s]|deg|grad|rad|turn|none)+\)$/.test(color) && supportsColor(color)) return color;
  return null;
}
