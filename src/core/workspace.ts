import { parse as parseYaml } from "yaml";
import {
  assertOnlyOwnedChanges,
  canonical,
  parseConfig,
  patchPath,
} from "./tomlPatch.ts";

export interface DocumentFile {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modified: number;
}
export interface TextDocument {
  path: string;
  text: string | null;
  hash: string;
}
export interface Catalog {
  files: DocumentFile[];
  truncated: boolean;
  limit: number;
  index?: string;
  indexTruncated?: boolean;
}
export interface SessionData {
  path: string;
  events: any[];
  truncated: boolean;
  invalidLines: number;
  bytesRead: number;
}
export interface Usage {
  input: number;
  output: number;
  cached: number;
  total: number;
}
export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  forked: boolean;
  messages: { role: string; text: string }[];
  usage: Usage;
  usageSource: string;
  partial: boolean;
}
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function mcpServers(config: string): [string, Record<string, any>][] {
  const doc = parseConfig(config);
  if (doc.mcp_servers === undefined) return [];
  if (!object(doc.mcp_servers)) throw new Error("mcp_servers 必须是 TOML 表。");
  return Object.entries(doc.mcp_servers).map(([name, value]) => {
    if (!object(value)) throw new Error("MCP 服务配置必须是 TOML 表。");
    return [name, value];
  });
}
export function validateMcp(value: unknown): Record<string, any> {
  if (!object(value)) throw new Error("MCP 配置需要一个 JSON 对象。");
  const result = structuredClone(value);
  if (result.headers && !result.http_headers) {
    result.http_headers = result.headers;
    delete result.headers;
  }
  if (
    result.type === "stdio" ||
    result.type === "http" ||
    result.type === "sse"
  )
    delete result.type;
  const command = typeof result.command === "string" && !!result.command.trim();
  const url = typeof result.url === "string" && !!result.url.trim();
  if (command === url) throw new Error("请提供 command 或 url，二者选一。");
  if (url) {
    let valid = false;
    try {
      valid = ["http:", "https:"].includes(new URL(result.url).protocol);
    } catch {}
    if (!valid) throw new Error("MCP URL 必须使用 HTTP 或 HTTPS。");
  }
  if (
    result.args !== undefined &&
    (!Array.isArray(result.args) ||
      result.args.some((x: any) => typeof x !== "string"))
  )
    throw new Error("args 必须是字符串数组。");
  for (const key of ["env", "http_headers", "env_http_headers"])
    if (
      result[key] !== undefined &&
      (!object(result[key]) ||
        Object.values(result[key]).some((x) => typeof x !== "string"))
    )
      throw new Error(key + " 必须是字符串键值对象。");
  if (result.enabled !== undefined && typeof result.enabled !== "boolean")
    throw new Error("enabled 必须为布尔值。");
  return result;
}
export function changeMcp(
  config: string,
  name: string,
  value: Record<string, any> | undefined,
): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(name))
    throw new Error("MCP 名称只允许字母、数字、下划线和连字符。");
  const next = patchPath(
    config,
    ["mcp_servers", name],
    value === undefined ? undefined : validateMcp(value),
  );
  assertOnlyOwnedChanges(config, next, [["mcp_servers", name]]);
  return next;
}
export function parseMcpImport(text: string): [string, Record<string, any>][] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("MCP JSON 格式错误。");
  }
  const servers = data?.mcpServers ?? data?.mcp_servers;
  if (!object(servers))
    throw new Error("导入 JSON 需要 mcpServers 或 mcp_servers 对象。");
  return Object.entries(servers).map(([name, value]) => [
    name,
    validateMcp(value),
  ]);
}
export function skillMetadata(text: string): {
  name: string;
  description: string;
} {
  const match = text
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match)
    throw new Error(
      "SKILL.md 需要以 YAML frontmatter 开头，包含 name 和 description。",
    );
  let data: any;
  try {
    data = parseYaml(match[1], { maxAliasCount: 20 });
  } catch {
    throw new Error("SKILL.md 的 YAML 格式错误。");
  }
  if (
    !object(data) ||
    typeof data.name !== "string" ||
    !data.name.trim() ||
    typeof data.description !== "string" ||
    !data.description.trim()
  )
    throw new Error("技能需要非空 name 和 description。");
  return { name: data.name, description: data.description };
}
export function parseSessionIndex(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const line of text.split("\n")) {
    try {
      const item = JSON.parse(line);
      if (typeof item.id === "string" && typeof item.thread_name === "string")
        result[item.id] = item.thread_name;
    } catch {}
  }
  return result;
}
const amount = (value: any) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function usage(value: any): Usage | null {
  if (
    !object(value) ||
    !(
      "input_tokens" in value ||
      "output_tokens" in value ||
      "total_tokens" in value
    )
  )
    return null;
  const input = amount(value.input_tokens),
    output = amount(value.output_tokens);
  return {
    input,
    output,
    cached: Math.min(
      input,
      amount(
        value.cached_input_tokens ?? value.input_tokens_details?.cached_tokens,
      ),
    ),
    total: amount(value.total_tokens) || input + output,
  };
}
export function parseSession(data: SessionData): SessionSummary {
  let id = data.path,
    cwd = "",
    model = "",
    forked = false;
  let cumulative: Usage | null = null;
  let metaSeen = false,
    ambiguousUsage = false;
  const records = new Map<string, Usage>(),
    turns = new Map<string, Usage>();
  const messages: SessionSummary["messages"] = [],
    fallback: SessionSummary["messages"] = [];
  for (const [index, event] of data.events.entries()) {
    const p = event?.payload;
    if (!object(p)) continue;
    if (event.type === "session_meta" && !metaSeen) {
      metaSeen = true;
      id = typeof p.id === "string" ? p.id : id;
      cwd = typeof p.cwd === "string" ? p.cwd : "";
      forked = !!(
        p.forked_from_id || p.source?.subagent?.thread_spawn?.parent_thread_id
      );
    }
    if (event.type === "turn_context" && typeof p.model === "string")
      model = p.model;
    if (event.type === "event_msg" && p.type === "token_count") {
      const next = usage(p.info?.total_token_usage);
      if (next) {
        if (cumulative && next.total < cumulative.total) ambiguousUsage = true;
        cumulative = next;
      }
    }
    if (event.type === "token_usage_record") {
      const record = usage(p.usage ?? p.token_usage);
      if (record)
        records.set(
          typeof p.response_id === "string" && p.response_id
            ? p.response_id
            : "line-" + index,
          record,
        );
      const turn = usage(p.turn_token_usage);
      if (turn && typeof p.turn_id === "string") turns.set(p.turn_id, turn);
    }
    if (
      event.type === "response_item" &&
      p.type === "message" &&
      ["user", "assistant"].includes(p.role)
    ) {
      const text = Array.isArray(p.content)
        ? p.content
            .map((part: any) =>
              typeof part?.text === "string" ? part.text : "",
            )
            .filter(Boolean)
            .join("\n")
        : "";
      if (text) messages.push({ role: p.role, text });
    }
    if (
      event.type === "event_msg" &&
      ["user_message", "agent_message"].includes(p.type) &&
      typeof p.message === "string"
    )
      fallback.push({
        role: p.type === "user_message" ? "user" : "assistant",
        text: p.message,
      });
  }
  const fallbackRecords = records.size ? records : turns;
  const measured =
    cumulative ??
    [...fallbackRecords.values()].reduce(
      (a, b) => ({
        input: a.input + b.input,
        output: a.output + b.output,
        cached: a.cached + b.cached,
        total: a.total + b.total,
      }),
      { input: 0, output: 0, cached: 0, total: 0 },
    );
  return {
    id,
    cwd,
    model,
    forked,
    messages: messages.length ? messages : fallback,
    usage: measured,
    usageSource: cumulative
      ? "日志累计快照"
      : fallbackRecords.size
        ? "日志记录合计"
        : "未记录用量",
    partial: data.truncated || data.invalidLines > 0 || ambiguousUsage,
  };
}
export function aggregateUsage(sessions: SessionSummary[]): {
  usage: Usage;
  counted: number;
  excludedForks: number;
} {
  const unique = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const known = unique.get(session.id);
    if (!known || session.usage.total > known.usage.total)
      unique.set(session.id, session);
  }
  let counted = 0,
    excludedForks = 0;
  const total: Usage = { input: 0, output: 0, cached: 0, total: 0 };
  for (const session of unique.values()) {
    if (session.forked) {
      excludedForks++;
      continue;
    }
    counted++;
    for (const key of ["input", "output", "cached", "total"] as const)
      total[key] += session.usage[key];
  }
  return { usage: total, counted, excludedForks };
}
export const equalConfig = (a: unknown, b: unknown) =>
  canonical(a) === canonical(b);
