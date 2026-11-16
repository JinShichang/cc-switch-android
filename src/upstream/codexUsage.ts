// Adapted from CC Switch services/session_usage_codex.rs (MIT, Jason Young).
// Upstream fc3eb797c72e054d554eea6a2e7a8b93933c6ac5. SAF supplies bounded events;
// this module retains source-aware snapshots, high-water deltas, fork replay and continuation semantics.
import type { EventFile } from "../android/sessionData.ts";
import type { RequestLog } from "../vendor/types/usage";

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const time = (value: unknown) => {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? stamp : 0;
};
const nonempty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : "";
function tokens(value: any) {
  if (
    !value ||
    typeof value !== "object" ||
    ![
      "input_tokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
      "total_tokens",
    ].some((key) => key in value)
  )
    return null;
  return {
    input: count(value.input_tokens),
    cached: count(
      value.cached_input_tokens ??
        value.cache_read_input_tokens ??
        value.input_tokens_details?.cached_tokens,
    ),
    written: count(value.cache_write_input_tokens),
    output: count(value.output_tokens),
  };
}
type Counts = NonNullable<ReturnType<typeof tokens>>;
const nonzero = (value: Counts) =>
  Object.values(value).some((value) => value > 0);
const equal = (a: Counts, b: Counts) =>
  (Object.keys(a) as (keyof Counts)[]).every((key) => a[key] === b[key]);
const delta = (value: Counts, prior: Counts | null): Counts =>
  Object.fromEntries(
    Object.entries(value).map(([key, n]) => [
      key,
      Math.max(0, n - (prior?.[key as keyof Counts] ?? 0)),
    ]),
  ) as Counts;
const highWater = (a: Counts | null, b: Counts): Counts =>
  Object.fromEntries(
    Object.entries(b).map(([key, n]) => [
      key,
      Math.max(n, a?.[key as keyof Counts] ?? 0),
    ]),
  ) as Counts;
function signature(value: any) {
  if (!value || typeof value !== "object") return null;
  return [
    value.input_tokens ?? null,
    value.cached_input_tokens ?? value.cache_read_input_tokens ?? null,
    value.output_tokens ?? null,
    value.reasoning_output_tokens ?? null,
    value.total_tokens ?? null,
  ];
}
export function normalizeCodexUsageModel(value: string) {
  return value
    .toLowerCase()
    .split("/")
    .at(-1)!
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}
interface TokenEvent {
  signature: string;
  timestamp: number;
  index: number;
}
interface MeasuredRow {
  row: RequestLog;
  index: number;
  exact: boolean;
  timestamp: number;
}
interface Timeline {
  path: string;
  id: string;
  physicalId: string;
  parent: string;
  cutoff: number;
  continuation: boolean;
  verifiedOrdinal: boolean;
  maxTimestamp: number;
  signatures: TokenEvent[];
  measured: MeasuredRow[];
  high: Counts | null;
  inherited: boolean;
  baselineMissing: boolean;
  malformed: boolean;
  truncated: boolean;
  invalidIdentity: boolean;
}
export interface UsageParseResult {
  rows: RequestLog[];
  deferred: boolean;
  partial: boolean;
  warnings: string[];
  timeline: Timeline;
}
const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const fileIdentity = new RegExp(`(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`);

/** Pure port of token records; no URI, filesystem, keyring or SQLite operations. */
export function sessionUsage(data: EventFile): UsageParseResult {
  const root = data.events.find((event) => event.type === "session_meta");
  const meta = root?.payload ?? {};
  const id = nonempty(meta.id ?? meta.thread_id ?? meta.threadId) || data.path;
  const filename = fileIdentity.exec(data.path);
  const physicalId = filename?.[2] ?? filename?.[1] ?? id;
  const invalidIdentity =
    !!filename &&
    id.toLowerCase() !== filename[1].toLowerCase() &&
    id.toLowerCase() !== filename[2]?.toLowerCase();
  const directParent =
    nonempty(meta.forked_from_id) || nonempty(meta.parent_thread_id);
  const spawnedParent = nonempty(
    meta.source?.subagent?.thread_spawn?.parent_thread_id,
  );
  const parent = directParent || spawnedParent;
  const historyBase = nonempty(
    meta.history_base?.thread_id ?? meta.history_base_thread_id,
  );
  const continuation =
    historyBase === id ||
    (!!filename?.[2] &&
      filename[1] === id &&
      (meta.history_mode === "paginated" || !!historyBase || !!parent));
  const inherited = !!parent || !!historyBase;
  const cutoff = time(root?.timestamp ?? meta.timestamp);
  const verifiedOrdinal =
    Number.isSafeInteger(meta.forked_from_ordinal_exclusive) &&
    meta.forked_from_ordinal_exclusive > 0 &&
    root?.ordinal === meta.forked_from_ordinal_exclusive;
  const warnings: string[] = [];
  if (data.truncated) warnings.push("读取达到上限，仅统计已读取的完整记录");
  if (data.incompleteTail) warnings.push("尾行正在写入，已保留前面的完整记录");
  if (data.invalidLines)
    warnings.push(
      `${data.invalidLines} 行异常或过长，已跳过并保留其余可解析记录`,
    );
  if (
    invalidIdentity ||
    (directParent && spawnedParent && directParent !== spawnedParent) ||
    parent === id
  )
    warnings.push("会话身份或父历史标识不一致，暂缓统计");
  const invalidParent = !!(
    (directParent && spawnedParent && directParent !== spawnedParent) ||
    parent === id
  );
  let high: Counts | null = null,
    model = nonempty(meta.model) || "未记录模型",
    providerName = nonempty(meta.model_provider) || "Codex（会话日志）";
  let previousSignature = "",
    baselineMissing = false,
    missingTime = 0;
  const sourceSignatures = new Map<string, string>(),
    records = new Set<string>();
  const signatures: TokenEvent[] = [],
    measured: MeasuredRow[] = [];
  let pending: {
    usage: Counts;
    event: any;
    index: number;
    model: string;
    vendor: string;
    responseId: string;
  } | null = null;
  const add = (
    usage: Counts,
    event: any,
    index: number,
    exact: boolean,
    name = model,
    vendor = providerName,
    responseId = "",
  ) => {
    if (!nonzero(usage)) return;
    const stamp = time(event.timestamp);
    if (!stamp) {
      missingTime++;
      return;
    }
    const cached = Math.min(usage.cached, usage.input),
      written = Math.min(usage.written, usage.input - cached);
    const normalized = normalizeCodexUsageModel(name);
    measured.push({
      index,
      exact,
      timestamp: stamp,
      row: {
        requestId: `codex:${physicalId}:${responseId ? "usage:" + responseId : "event:" + (event.ordinal ?? index)}`,
        sessionId: id,
        providerId: "codex-session:" + vendor,
        providerName: vendor,
        appType: "codex",
        model: normalized,
        requestModel: name,
        pricingModel: normalized,
        costMultiplier: "1",
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: cached,
        cacheCreationTokens: written,
        inputCostUsd: "",
        outputCostUsd: "",
        cacheReadCostUsd: "",
        cacheCreationCostUsd: "",
        totalCostUsd: "",
        isStreaming: false,
        latencyMs: 0,
        statusCode: 0,
        createdAt: Math.floor(stamp / 1000),
        dataSource: "session",
        errorMessage:
          "会话日志未记录 HTTP 状态与精确耗时；费用仅按设置的价格估算。",
      },
    });
  };
  const flush = () => {
    if (pending)
      add(
        pending.usage,
        pending.event,
        pending.index,
        true,
        pending.model,
        pending.vendor,
        pending.responseId,
      );
    pending = null;
  };
  let maxTimestamp = data.maxTimestamp ?? 0;
  for (const [index, event] of data.events.entries()) {
    const p = event.payload ?? {};
    maxTimestamp = Math.max(maxTimestamp, time(event.timestamp));
    if (event.type === "turn_context") {
      model = nonempty(p.model ?? p.info?.model) || model;
      providerName = nonempty(p.model_provider) || providerName;
      continue;
    }
    if (p.type === "thread_settings_applied") {
      const settings = p.thread_settings ?? p.settings;
      model = nonempty(settings?.model) || model;
      providerName = nonempty(settings?.model_provider) || providerName;
      continue;
    }
    if (event.type === "compacted" || p.type === "context_compacted") {
      previousSignature = "";
      sourceSignatures.clear();
      continue;
    }
    if (event.type === "token_usage_record") {
      const responseId = nonempty(p.response_id);
      if (responseId && records.has(responseId)) continue;
      flush();
      if (responseId) records.add(responseId);
      const usage = tokens(p.usage ?? p.token_usage);
      if (usage)
        pending = {
          usage,
          event,
          index,
          model: nonempty(p.model) || model,
          vendor: providerName,
          responseId,
        };
      continue;
    }
    if (event.type !== "event_msg" || p.type !== "token_count" || !p.info)
      continue;
    const info = p.info,
      total = tokens(info.total_token_usage),
      last = tokens(info.last_token_usage);
    if (!total && !last) continue;
    model = nonempty(info.model ?? info.model_name ?? p.model) || model;
    const key = JSON.stringify([
      signature(info.total_token_usage),
      signature(info.last_token_usage),
    ]);
    signatures.push({
      signature: key,
      timestamp: time(event.timestamp),
      index,
    });
    const source = nonempty(p.rate_limits?.limit_id);
    const duplicate =
      !!total &&
      (sourceSignatures.get(source) === key || previousSignature === key);
    if (total) sourceSignatures.set(source, key);
    previousSignature = key;
    // Match native usage to its token_count; zero-last compaction uses the native record.
    if (pending) {
      if (last && !nonzero(last) && !equal(last, pending.usage)) flush();
      else pending = null;
    }
    const prior = high;
    if (total) high = highWater(high, total);
    if (duplicate) continue;
    if (last) {
      add(last, event, index, true);
      continue;
    }
    if (!total) continue;
    if (data.invalidLines || (!prior && (inherited || !root))) {
      baselineMissing = true;
      continue;
    }
    add(delta(total, prior), event, index, false);
  }
  flush();
  if (missingTime) warnings.push(`${missingTime} 条用量缺少有效时间，已跳过`);
  if (baselineMissing)
    warnings.push("累计用量缺少可靠的历史基线，暂缓对应条目");
  const afterFork =
    cutoff > 0 &&
    measured.length > 0 &&
    measured.every((item) => item.exact && item.timestamp > cutoff);
  const waitingForParent =
    inherited &&
    (measured.length > 0 || baselineMissing) &&
    !continuation &&
    !(verifiedOrdinal && afterFork);
  if (waitingForParent)
    warnings.push("继承会话等待父历史核验，暂缓统计以免重复计费");
  const deferred =
    invalidIdentity ||
    invalidParent ||
    (!root && measured.length > 0) ||
    waitingForParent ||
    (baselineMissing && measured.length === 0);
  const timeline: Timeline = {
    path: data.path,
    id,
    physicalId,
    parent,
    cutoff,
    continuation,
    verifiedOrdinal,
    maxTimestamp,
    signatures,
    measured,
    high,
    inherited,
    baselineMissing,
    malformed: !!data.invalidLines,
    truncated: data.truncated,
    invalidIdentity: invalidIdentity || invalidParent,
  };
  return {
    rows: deferred ? [] : measured.map((item) => item.row),
    deferred,
    partial: !!(
      data.truncated ||
      data.incompleteTail ||
      data.invalidLines ||
      missingTime ||
      baselineMissing
    ),
    warnings,
    timeline,
  };
}

/** Match the child's leading replay to the parent's ordered snapshots, as upstream does. */
export function resolveUsageFiles(
  parsed: UsageParseResult[],
): UsageParseResult[] {
  return parsed.map((result) => {
    const child = result.timeline;
    if (
      !result.deferred ||
      child.continuation ||
      !child.parent ||
      child.invalidIdentity ||
      !child.cutoff ||
      child.malformed
    )
      return result;
    const candidates = parsed.filter(
      (candidate) =>
        candidate.timeline.id === child.parent ||
        candidate.timeline.physicalId === child.parent,
    );
    if (!candidates.length) return result;
    const physical = new Map<string, UsageParseResult>();
    for (const candidate of candidates) {
      if (
        candidate.timeline.malformed ||
        candidate.timeline.truncated ||
        candidate.timeline.invalidIdentity ||
        candidate.timeline.signatures.some((event) => !event.timestamp)
      )
        return result;
      const previous = physical.get(candidate.timeline.physicalId);
      const before = (value: UsageParseResult) =>
        value.timeline.signatures
          .filter((event) => event.timestamp <= child.cutoff)
          .map((event) => event.signature);
      if (
        previous &&
        JSON.stringify(before(previous)) !== JSON.stringify(before(candidate))
      )
        return result;
      physical.set(candidate.timeline.physicalId, candidate);
    }
    if (
      Math.max(
        ...[...physical.values()].map((value) => value.timeline.maxTimestamp),
      ) < child.cutoff
    )
      return result;
    const parent = [...physical.values()]
      .sort((a, b) => a.timeline.path.localeCompare(b.timeline.path))
      .flatMap((value) =>
        value.timeline.signatures.filter(
          (event) => event.timestamp <= child.cutoff,
        ),
      );
    let offset = 0,
      prefix = 0;
    for (const event of child.signatures) {
      const match = parent
        .slice(offset)
        .findIndex((value) => value.signature === event.signature);
      if (match < 0) break;
      offset += match + 1;
      prefix++;
    }
    const replay = new Set(
      child.signatures.slice(0, prefix).map((event) => event.index),
    );
    const own = child.measured.filter(
      (item) => !replay.has(item.index) && item.timestamp > child.cutoff,
    );
    // A remainder before the fork cannot be proved to be the child's own request.
    if (
      child.measured.some(
        (item) => !replay.has(item.index) && item.timestamp <= child.cutoff,
      )
    )
      return result;
    return {
      ...result,
      rows: own.map((item) => item.row),
      deferred: false,
      warnings: result.warnings.filter(
        (warning) => !warning.startsWith("继承会话等待"),
      ),
    };
  });
}
