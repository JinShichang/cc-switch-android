import { parse, stringify } from "smol-toml";
import { ConfigError, type TomlObject } from "./types.ts";

export function parseConfig(text: string, label = "config.toml"): TomlObject {
  try {
    return parse(text.replace(/^\uFEFF/, "")) as TomlObject;
  } catch (error: any) {
    // Parser messages can contain the source line, including a credential.
    const location = Number.isInteger(error?.line)
      ? `（第 ${error.line} 行）`
      : "";
    throw new ConfigError(
      "invalid_toml",
      `${label} 格式错误${location}，没有写入任何文件。请修复 TOML 后重试。`,
    );
  }
}

export function canonical(value: any): string {
  if (value === undefined) return "<missing>";
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `int:${value}`;
  if (typeof value === "number" && !Number.isFinite(value))
    return `number:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getPath(root: any, path: string[]): any {
  let current = root;
  for (const key of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = current[key];
  }
  return current;
}

function starts(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((s, i) => s === path[i]);
}

function keys(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "." || i === text.length) {
      const key = text.slice(start, i).trim();
      const parsed = parse(`${key} = 0`);
      parts.push(Object.keys(parsed)[0]);
      start = i + 1;
    }
  }
  return parts;
}

interface Statement {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  path: string[];
  header: boolean;
  inArray: boolean;
}

/** Lexical positions only; smol-toml is the authoritative syntax parser.
 * Strings, comments, arrays, inline tables and quoted/dotted keys are skipped as
 * whole tokens. We never identify a table by a line regex inside a string.
 */
function statements(text: string): Statement[] {
  const result: Statement[] = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let section: string[] = [];
  let arrayRoot: string[] | null = null;
  while (pos < text.length) {
    while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++;
    if (text[pos] === "#") {
      const nl = text.indexOf("\n", pos);
      pos = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (pos >= text.length) break;
    const start = pos;
    if (text[pos] === "[") {
      const array = text[pos + 1] === "[";
      const begin = pos + (array ? 2 : 1);
      pos = begin;
      let quote = "";
      while (pos < text.length) {
        const ch = text[pos];
        if (quote) {
          if (quote === '"' && ch === "\\") pos++;
          else if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "]") break;
        pos++;
      }
      section = keys(text.slice(begin, pos));
      if (array) arrayRoot = section;
      else if (arrayRoot && !starts(section, arrayRoot)) arrayRoot = null;
      const nl = text.indexOf("\n", pos);
      pos = nl < 0 ? text.length : nl + 1;
      result.push({
        start,
        end: pos,
        valueStart: 0,
        valueEnd: 0,
        path: section,
        header: true,
        inArray: !!arrayRoot,
      });
      continue;
    }
    let quote = "";
    while (pos < text.length) {
      const ch = text[pos];
      if (quote) {
        if (quote === '"' && ch === "\\") pos++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "=") break;
      pos++;
    }
    const path = [...section, ...keys(text.slice(start, pos))];
    pos++;
    while (text[pos] === " " || text[pos] === "\t") pos++;
    const valueStart = pos;
    let depth = 0;
    let multiline = false;
    quote = "";
    let valueEnd = pos;
    while (pos < text.length) {
      const ch = text[pos];
      if (quote) {
        if (quote === '"' && ch === "\\") {
          pos += 2;
          continue;
        }
        if (ch === quote) {
          if (!multiline) quote = "";
          else if (text.slice(pos, pos + 3) === quote.repeat(3)) {
            let count = 3;
            while (text[pos + count] === quote) count++;
            pos += count;
            quote = "";
            continue;
          }
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        multiline = text.slice(pos, pos + 3) === ch.repeat(3);
        if (multiline) {
          pos += 3;
          continue;
        }
      } else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "#") {
        if (!depth) break;
        const nl = text.indexOf("\n", pos);
        pos = nl < 0 ? text.length : nl;
        continue;
      } else if ((ch === "\n" || ch === "\r") && !depth) break;
      pos++;
    }
    valueEnd = pos;
    while (valueEnd > valueStart && /[ \t\r\n]/.test(text[valueEnd - 1]))
      valueEnd--;
    const nl = text.indexOf("\n", pos);
    pos = nl < 0 ? text.length : nl + 1;
    result.push({
      start,
      end: pos,
      valueStart,
      valueEnd,
      path,
      header: false,
      inArray: !!arrayRoot,
    });
  }
  return result;
}

function valueText(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(valueText).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} = ${valueText(v)}`)
      .join(", ")} }`;
  }
  throw new ConfigError(
    "unsupported_toml_value",
    "无法安全写入该 TOML 值。原文件未修改。",
  );
}

function putObject(root: TomlObject, path: string[], value: any): void {
  let at = root;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(at, part)) at[part] = Object.create(null);
    if (!at[part] || typeof at[part] !== "object" || Array.isArray(at[part])) {
      throw new ConfigError(
        "invalid_table",
        "服务商配置表的类型不正确，无法安全修改。",
      );
    }
    at = at[part];
  }
  const last = path[path.length - 1];
  if (value === undefined) delete at[last];
  else
    Object.defineProperty(at, last, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
}

/** Patch one owned path while keeping all other source bytes intact. Inline
 * ancestor values are the only exception: their value is reserialized, and its
 * unrelated members are checked semantically before returning the plan.
 */
export function patchPath(text: string, path: string[], value: any): string {
  const doc = parseConfig(text);
  if (canonical(getPath(doc, path)) === canonical(value)) return text;
  const nodes = statements(text);
  const ancestor = nodes.find(
    (s) =>
      !s.header &&
      !s.inArray &&
      starts(path, s.path) &&
      s.path.length < path.length,
  );
  if (ancestor) {
    const parent = getPath(doc, ancestor.path);
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      throw new ConfigError(
        "invalid_table",
        "model_providers 必须是 TOML 表。请修复后重试。",
      );
    }
    putObject(parent, path.slice(ancestor.path.length), value);
    const output =
      text.slice(0, ancestor.valueStart) +
      valueText(parent) +
      text.slice(ancestor.valueEnd);
    parseConfig(output);
    return output;
  }
  const exact = nodes.find(
    (s) => !s.header && !s.inArray && canonical(s.path) === canonical(path),
  );
  if (exact && value !== undefined) {
    const output =
      text.slice(0, exact.valueStart) +
      valueText(value) +
      text.slice(exact.valueEnd);
    parseConfig(output);
    return output;
  }
  let output = text;
  for (const node of nodes.filter((s) => starts(s.path, path)).reverse()) {
    output = output.slice(0, node.start) + output.slice(node.end);
  }
  if (value !== undefined) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    if (
      path.length === 1 &&
      (typeof value !== "object" ||
        value instanceof Date ||
        Array.isArray(value))
    ) {
      // Prepend new root fields so an existing block of user comments/settings
      // remains contiguous, rather than inserting between it and its first table.
      const insertAt = output.charCodeAt(0) === 0xfeff ? 1 : 0;
      const before = output.slice(0, insertAt);
      const separator = before && !before.endsWith("\n") ? eol : "";
      output =
        before +
        separator +
        `${JSON.stringify(path[0])} = ${valueText(value)}` +
        eol +
        output.slice(insertAt);
    } else {
      // Use a dotted assignment in an existing parent table, otherwise append a
      // standalone table. This also supports owned nested scalar model fields.
      if (
        typeof value !== "object" ||
        value instanceof Date ||
        Array.isArray(value)
      ) {
        const parent = path.slice(0, -1);
        const remaining = statements(output);
        const headerIndex = remaining.findIndex(
          (s) =>
            s.header && !s.inArray && canonical(s.path) === canonical(parent),
        );
        if (headerIndex >= 0) {
          const following = remaining
            .slice(headerIndex + 1)
            .find((s) => s.header);
          const insertAt = following?.start ?? output.length;
          const before = output.slice(0, insertAt);
          output =
            before +
            (before.endsWith("\n") ? "" : eol) +
            `${JSON.stringify(path.at(-1))} = ${valueText(value)}` +
            eol +
            output.slice(insertAt);
        } else {
          // Dotted assignment avoids redefining a parent already introduced by
          // another dotted key or an implicit child table.
          const insertAt = output.charCodeAt(0) === 0xfeff ? 1 : 0;
          output =
            output.slice(0, insertAt) +
            `${path.map((k) => JSON.stringify(k)).join(".")} = ${valueText(value)}` +
            eol +
            output.slice(insertAt);
        }
      } else {
        const addition: TomlObject = Object.create(null);
        putObject(addition, path, value);
        output +=
          (output.endsWith("\n") || !output ? "" : eol) +
          eol +
          stringify(addition).replace(/\n/g, eol);
      }
    }
  }
  parseConfig(output);
  return output;
}

/** A semantic postcondition catches scanner mistakes before any native write. */
export function assertOnlyOwnedChanges(
  before: string,
  after: string,
  paths: string[][],
): void {
  const left = parseConfig(before);
  const right = parseConfig(after);
  for (const path of paths) {
    removeAndPrune(left, path);
    removeAndPrune(right, path);
  }
  if (canonical(left) !== canonical(right)) {
    throw new ConfigError(
      "preservation_check",
      "配置保护检查未通过：修改可能影响无关字段，因此已停止写入。",
    );
  }
}

function removeAndPrune(root: TomlObject, path: string[]): void {
  if (!Object.hasOwn(root, path[0])) return;
  if (path.length === 1) {
    delete root[path[0]];
    return;
  }
  const child = root[path[0]];
  if (
    !child ||
    typeof child !== "object" ||
    Array.isArray(child) ||
    child instanceof Date
  )
    return;
  removeAndPrune(child, path.slice(1));
  if (!Object.keys(child).length) delete root[path[0]];
}
