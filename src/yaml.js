/**
 * A dependency-free YAML subset parser.
 *
 * pi-farm only needs a small, predictable slice of YAML; shipping a full
 * parser (or a runtime dependency) would make the CLI harder to install than
 * the problem it solves. Supported:
 *
 *   - block mappings and block sequences, arbitrarily nested
 *   - inline flow sequences / mappings (`[a, b]`, `{k: v}`) incl. valid JSON
 *   - single-quoted ('') and double-quoted ("") scalars with escapes
 *   - booleans (true/false), null (~/null), integers, floats
 *   - comments (`#` at line start or after whitespace, outside quotes)
 *   - literal (`|`) and folded (`>`) block scalars, with `-`/`+` chomping
 *
 * Not supported (throws or is treated as a plain string): anchors/aliases,
 * tags, multiple documents, complex keys, tabs for indentation.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "YamlError";
    this.line = line;
  }
}

/** Remove a trailing `# comment` while respecting quotes. */
function stripComment(input) {
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && input[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(input[i - 1]))) {
      return input.slice(0, i);
    }
  }
  return input;
}

function isSeqItem(text) {
  return text === "-" || /^-\s/.test(text);
}

function isBlockIndicator(text) {
  return /^[|>][+-]?$/.test(text);
}

/** Split `key: value` at the first top-level colon followed by whitespace/EOL. */
function splitKey(text, lineNo) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ":" && depth === 0 && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      const rawKey = text.slice(0, i).trim();
      if (!rawKey) throw new YamlError("empty mapping key", lineNo);
      return { key: unquoteKey(rawKey, lineNo), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquoteKey(key, lineNo) {
  if (key.startsWith('"')) {
    if (!key.endsWith('"')) throw new YamlError("unterminated quoted key", lineNo);
    return parseQuoted(key, lineNo);
  }
  if (key.startsWith("'")) {
    if (!key.endsWith("'")) throw new YamlError("unterminated quoted key", lineNo);
    return parseQuoted(key, lineNo);
  }
  return key;
}

function parseQuoted(text, lineNo) {
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError("unterminated single-quoted string", lineNo);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (!text.endsWith('"') || text.length < 2) throw new YamlError("unterminated double-quoted string", lineNo);
  const body = text.slice(1, -1);
  try {
    return JSON.parse(`"${body.replace(/\n/g, "\\n")}"`);
  } catch {
    // Fall back to a permissive unescape (YAML double quotes allow a few
    // escapes JSON does not, e.g. `\ ` and unknown escapes).
    return body.replace(/\\(["\\/bfnrt])/g, (_, ch) =>
      ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[ch] ?? ch,
    );
  }
}

/** Split a flow body on top-level commas. */
function splitTopLevel(body) {
  const parts = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) {
        if (quote === "'" && body[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p, i, all) => !(p === "" && all.length === 1));
}

function parseFlow(text, lineNo) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the lenient parser */
  }
  const open = text[0];
  const close = open === "[" ? "]" : "}";
  if (!text.endsWith(close)) throw new YamlError("unterminated flow collection", lineNo);
  const inner = text.slice(1, -1).trim();
  if (!inner) return open === "[" ? [] : {};
  const parts = splitTopLevel(inner);
  if (open === "[") return parts.map((p) => parseScalar(p, lineNo));
  const obj = {};
  for (const part of parts) {
    const kv = splitKey(part, lineNo);
    if (!kv) throw new YamlError(`invalid flow mapping entry: ${part}`, lineNo);
    obj[kv.key] = kv.rest === "" ? null : parseScalar(kv.rest, lineNo);
  }
  return obj;
}

function parseScalar(text, lineNo) {
  if (text === "") return null;
  if (text.startsWith('"') || text.startsWith("'")) return parseQuoted(text, lineNo);
  if (text.startsWith("[") || text.startsWith("{")) return parseFlow(text, lineNo);
  if (/^(null|Null|NULL|~)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(text) && /[.eE]/.test(text)) {
    return Number(text);
  }
  return text;
}

function preprocess(text) {
  const out = [];
  const rows = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let idx = 0; idx < rows.length; idx++) {
    const raw = rows[idx];
    const lineNo = idx + 1;
    const lead = raw.match(/^[ \t]*/)[0];
    if (lead.includes("\t")) {
      throw new YamlError("tabs are not allowed for indentation; use spaces", lineNo);
    }
    const withoutComment = stripComment(raw);
    const trimmed = withoutComment.trim();
    out.push({
      indent: lead.length,
      text: trimmed,
      raw,
      lineNo,
      blank: trimmed.length === 0,
    });
  }
  return out;
}

export function parseYaml(text) {
  const lines = preprocess(text);
  let i = 0;

  const skipBlanks = () => {
    while (i < lines.length && lines[i].blank) i++;
  };
  const peek = () => {
    skipBlanks();
    return i < lines.length ? lines[i] : null;
  };

  function parseNode(minIndent) {
    const line = peek();
    if (!line || line.indent < minIndent) return null;
    return isSeqItem(line.text) ? parseSequence(line.indent) : parseMapping(line.indent, {});
  }

  function readBlockScalar(parentIndent, indicator, lineNo) {
    const style = indicator[0];
    const chomp = indicator.includes("-") ? "strip" : indicator.includes("+") ? "keep" : "clip";
    const collected = [];
    let j = i;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.blank && line.indent <= parentIndent) break;
      collected.push(line);
      j++;
    }
    let end = collected.length;
    const lastContent = (() => {
      for (let k = collected.length - 1; k >= 0; k--) if (!collected[k].blank) return k;
      return -1;
    })();
    if (lastContent === -1) {
      i = j;
      return "";
    }
    end = lastContent + 1;
    i = j;

    let minIndent = Infinity;
    for (let k = 0; k < end; k++) {
      if (!collected[k].blank) minIndent = Math.min(minIndent, collected[k].indent);
    }
    if (!Number.isFinite(minIndent)) minIndent = parentIndent + 1;

    const parts = [];
    for (let k = 0; k < end; k++) {
      const line = collected[k];
      if (line.blank) {
        parts.push("");
      } else if (line.indent < minIndent) {
        throw new YamlError("bad indentation inside block scalar", line.lineNo);
      } else {
        parts.push(line.raw.slice(minIndent).replace(/\s+$/, ""));
      }
    }

    let body;
    if (style === "|") {
      body = parts.join("\n");
    } else {
      let out = "";
      let pendingSpace = false;
      for (const part of parts) {
        if (part === "") {
          out += "\n";
          pendingSpace = false;
        } else {
          if (pendingSpace && out.length > 0 && !out.endsWith("\n")) out += " ";
          out += part;
          pendingSpace = true;
        }
      }
      body = out;
    }

    if (chomp === "strip") return body.replace(/\n+$/, "");
    if (chomp === "clip") return body === "" ? "" : `${body.replace(/\n+$/, "")}\n`;
    return `${body}\n`;
  }

  function parseMapping(indent, into) {
    for (;;) {
      const line = peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlError(`unexpected indentation (expected ${indent} spaces)`, line.lineNo);
      }
      if (isSeqItem(line.text)) break;
      parseMappingEntry(into, line, indent);
    }
    return into;
  }

  function parseMappingEntry(into, line, indent) {
    const kv = splitKey(line.text, line.lineNo);
    if (!kv) throw new YamlError(`expected "key: value", got "${line.text}"`, line.lineNo);
    i++;
    if (kv.rest === "") {
      const next = peek();
      into[kv.key] = next && next.indent > indent ? parseNode(next.indent) : null;
    } else if (isBlockIndicator(kv.rest)) {
      into[kv.key] = readBlockScalar(indent, kv.rest, line.lineNo);
    } else {
      into[kv.key] = parseScalar(kv.rest, line.lineNo);
    }
  }

  function parseSequence(indent) {
    const arr = [];
    for (;;) {
      const line = peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlError(`unexpected indentation (expected ${indent} spaces)`, line.lineNo);
      }
      if (!isSeqItem(line.text)) break;
      const rest = line.text === "-" ? "" : line.text.replace(/^-\s+/, "");
      i++;
      if (rest === "") {
        const next = peek();
        arr.push(next && next.indent > indent ? parseNode(next.indent) : null);
        continue;
      }
      if (isBlockIndicator(rest)) {
        arr.push(readBlockScalar(indent, rest, line.lineNo));
        continue;
      }
      const kv = splitKey(rest, line.lineNo);
      if (kv) {
        // Virtual line so the mapping entry shares the normal code path.
        const itemIndent = indent + 2;
        lines.splice(i, 0, { indent: itemIndent, text: rest, raw: "", lineNo: line.lineNo, blank: false });
        const obj = {};
        for (;;) {
          const first = peek();
          if (!first || first.indent < itemIndent) break;
          if (first.indent > itemIndent) {
            throw new YamlError(`unexpected indentation (expected ${itemIndent} spaces)`, first.lineNo);
          }
          if (isSeqItem(first.text)) break;
          parseMappingEntry(obj, first, itemIndent);
        }
        arr.push(obj);
        continue;
      }
      arr.push(parseScalar(rest, line.lineNo));
    }
    return arr;
  }

  const first = peek();
  if (!first) return null;
  const result = parseNode(first.indent);
  const leftover = peek();
  if (leftover) {
    throw new YamlError(`unexpected content: "${leftover.text}"`, leftover.lineNo);
  }
  return result;
}
