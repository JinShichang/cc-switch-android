import type {
  SessionMeta,
  SessionMessage,
  SessionBlock,
} from "../vendor/types";
import type { RequestLog } from "../vendor/types/usage";
export interface EventFile {
  path: string;
  events: any[];
  truncated: boolean;
  invalidLines: number;
  incompleteTail?: boolean;
  maxTimestamp?: number;
}
const text = (v: any): string =>
  typeof v === "string" ? v : JSON.stringify(v ?? "");
const time = (v: any) => {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
export function transcript(data: EventFile): SessionMessage[] {
  const messages: SessionMessage[] = [],
    fallback: SessionMessage[] = [];
  let model = "",
    turn = "";
  for (const e of data.events) {
    const p = e.payload ?? {},
      blocks: SessionBlock[] = [];
    let role = "assistant";
    if (e.type === "turn_context") {
      model = p.model ?? model;
      turn = p.turn_id ?? turn;
      continue;
    }
    if (e.type === "response_item") {
      if (p.type === "message") {
        role = p.role;
        for (const part of p.content ?? [])
          if (typeof part.text === "string")
            blocks.push({ type: "text", text: part.text });
          else if (part.type?.includes("image"))
            blocks.push({
              type: "event",
              kind: "info",
              text: "此消息含图片；图片资源需要 Codex 宿主提供读取接口。",
            });
      } else if (p.type === "reasoning")
        blocks.push({
          type: "thinking",
          text: (p.summary ?? []).map((s: any) => s.text ?? "").join("\n"),
          redacted: !!p.encrypted_content || p.redacted === true,
        });
      else if (["function_call", "custom_tool_call"].includes(p.type)) {
        const value = text(p.arguments ?? p.input);
        blocks.push({
          type: "tool_call",
          id: p.call_id ?? p.id ?? "",
          rawName: p.name ?? "tool",
          kind: /shell|exec/.test(p.name)
            ? "shell"
            : /patch|edit/.test(p.name)
              ? "edit"
              : /search/.test(p.name)
                ? "search"
                : p.name?.startsWith("mcp")
                  ? "mcp"
                  : "other",
          title: p.name ?? "工具调用",
          inputPreview: value,
          inputTotalLen: value.length,
        });
      } else if (
        ["function_call_output", "custom_tool_call_output"].includes(p.type)
      ) {
        role = "tool";
        const value = text(p.output);
        blocks.push({
          type: "tool_result",
          callId: p.call_id ?? "",
          status: "unknown",
          preview: value,
          totalLen: value.length,
          lineCount: value.split("\n").length,
          truncated: false,
        });
      } else if (p.type === "compaction")
        blocks.push({
          type: "event",
          kind: "compaction",
          text: "上下文已压缩（加密内容不可读取）",
        });
    } else if (e.type === "event_msg") {
      if (["user_message", "agent_message"].includes(p.type)) {
        fallback.push({
          role: p.type === "user_message" ? "user" : "assistant",
          content: p.message,
          ts: time(e.timestamp),
          turnId: turn,
        });
        continue;
      }
      if (["turn_aborted", "context_compacted", "error"].includes(p.type))
        blocks.push({
          type: "event",
          kind:
            p.type === "error"
              ? "error"
              : p.type === "turn_aborted"
                ? "aborted"
                : "compaction",
          text: p.message ?? p.type,
        });
    }
    if (blocks.length)
      messages.push({
        role,
        blocks,
        ts: time(e.timestamp),
        id: p.id,
        turnId: turn,
        meta: { model },
      });
  }
  const output = messages.some((m) => m.blocks?.some((b) => b.type === "text"))
    ? messages
    : fallback;
  if (data.truncated || data.invalidLines)
    output.push({
      role: "system",
      blocks: [
        {
          type: "event",
          kind: "info",
          text: "此文件达到读取边界或含未完成/损坏行，当前显示的记录不完整。",
        },
      ],
    });
  return output;
}
export function sessionMeta(
  data: EventFile,
  name?: string,
  modified = 0,
): SessionMeta {
  const meta =
      data.events.find((e) => e.type === "session_meta")?.payload ?? {},
    m = transcript(data),
    lines = m
      .filter((v) => v.role === "user" || v.role === "assistant")
      .map(
        (v) =>
          v.content ??
          v.blocks
            ?.filter((b) => b.type === "text")
            .map((b) => (b as any).text)
            .join("\n") ??
          "",
      )
      .filter(Boolean);
  return {
    providerId: "codex",
    sessionId: meta.id ?? data.path,
    title: name ?? lines[0]?.slice(0, 200) ?? data.path.split("/").at(-1),
    summary: lines.at(-1)?.slice(0, 400),
    projectDir: meta.cwd,
    createdAt: time(meta.timestamp ?? data.events[0]?.timestamp),
    lastActiveAt: time(data.events.at(-1)?.timestamp) || modified,
    sourcePath: data.path,
    resumeCommand: meta.id ? "codex resume " + meta.id : undefined,
  };
}
export { sessionUsage, resolveUsageFiles } from "../upstream/codexUsage.ts";
