import { invoke, isNative } from "../bridge";
import { parseSessionIndex } from "../core/workspace";
import {
  sessionMeta,
  sessionUsage,
  resolveUsageFiles,
  transcript,
  type EventFile,
} from "./sessionData";
import { normalizeCodexUsageModel } from "../upstream/codexUsage";
import type { RequestLog, ModelPricing } from "../vendor/types/usage";
import {
  buildTurns,
  buildTurnIndex,
} from "../vendor/components/sessions/reader/turns";
let ui: any = null;
let logs: RequestLog[] = [];
let syncAt: number | null = null;
let scans: Promise<any> | null = null;
let generation = 0;
let usageCache = new Map<
  string,
  { stamp: string; parsed: ReturnType<typeof sessionUsage> }
>();
export function resetAndroidData() {
  generation++;
  logs = [];
  syncAt = null;
  sessionCache.clear();
  usageCache.clear();
}
let sessionCache = new Map<
  string,
  { stamp: string; data: EventFile; meta: ReturnType<typeof sessionMeta> }
>();
const defaultSettings = {
  visibleApps: {
    claude: false,
    "claude-desktop": false,
    codex: true,
    gemini: false,
    grokbuild: false,
    opencode: false,
    openclaw: false,
    hermes: false,
    pi: false,
    omp: false,
    mcode: false,
    kimi: false,
    dsh: false,
    agy: false,
    copilot: false,
    workbuddy: false,
  },
  sessionContentSearchEnabled: false,
  sessionAutoSyncEnabled: true,
  usageDashboardRefreshIntervalMs: 60000,
  usageDisplay: { currency: "USD", rateSource: "manual" },
};
async function loadUi() {
  if (!ui) ui = isNative ? await invoke("readUiData") : {};
  ui.settings = { ...defaultSettings, ...ui.settings };
  ui.pricing ??= [];
  return ui;
}
async function saveUi() {
  if (isNative) await invoke("writeUiData", ui);
}
async function catalog() {
  if (!isNative) return { files: [], index: "", truncated: false };
  return invoke<any>("catalog", { kind: "sessions" });
}
async function file(path: string) {
  return invoke<EventFile>("readSession", { path, usageOnly: false });
}
async function sessions() {
  const c = await catalog(),
    names = parseSessionIndex(c.index ?? "");
  const output = [];
  const active = generation;
  const paths = new Set<string>(c.files.map((f: any) => f.path));
  for (const key of sessionCache.keys())
    if (!paths.has(key)) sessionCache.delete(key);
  for (const f of c.files) {
    if (active !== generation) throw Error("目录已更改，请重新读取。");
    const stamp =
      f.modified > 0 ? f.modified + ":" + f.size : String(Date.now());
    let known = sessionCache.get(f.path);
    if (!known || known.stamp !== stamp) {
      const data = await file(f.path);
      known = {
        stamp,
        data,
        meta: sessionMeta(
          data,
          names[
            data.events.find((e) => e.type === "session_meta")?.payload?.id
          ],
          f.modified,
        ),
      };
      sessionCache.set(f.path, known);
      while (sessionCache.size > 24)
        sessionCache.delete(sessionCache.keys().next().value!);
    }
    output.push(known.meta);
  }
  if (c.truncated)
    window.dispatchEvent(
      new CustomEvent("android-data-warning", {
        detail: "会话目录达到扫描边界，当前列表不是完整历史。",
      }),
    );
  return output;
}
async function sync() {
  if (scans) return scans;
  scans = (async () => {
    const active = generation;
    const list = await catalog();
    const paths = new Set<string>(list.files.map((f: any) => f.path));
    for (const key of usageCache.keys())
      if (!paths.has(key)) usageCache.delete(key);
    let deferred = 0,
      partial = 0,
      noUsage = 0,
      skipped = 0;
    const errors: string[] = [],
      rows: RequestLog[] = [];
    const parsedFiles: ReturnType<typeof sessionUsage>[] = [];
    for (const f of list.files)
      try {
        if (active !== generation) throw Error("目录已更改");
        const stamp =
          f.modified > 0 ? f.modified + ":" + f.size : String(Date.now());
        let entry = usageCache.get(f.path);
        if (!entry || entry.stamp !== stamp || entry.parsed.partial) {
          const data = await invoke<EventFile>("readSession", {
            path: f.path,
            usageOnly: true,
          });
          entry = { stamp, parsed: sessionUsage(data) };
          usageCache.set(f.path, entry);
        }
        parsedFiles.push(entry.parsed);
      } catch {
        errors.push(f.path + "：读取失败");
      }
    if (active !== generation) throw Error("目录已更改，请重新同步。");
    const reasons = new Map<string, number>();
    for (const parsed of resolveUsageFiles(parsedFiles)) {
      if (parsed.partial) partial++;
      for (const warning of parsed.warnings)
        reasons.set(warning, (reasons.get(warning) ?? 0) + 1);
      if (parsed.deferred) deferred++;
      else {
        rows.push(...parsed.rows);
        if (!parsed.rows.length) noUsage++;
      }
    }
    const seen = new Set<string>();
    logs = rows.filter((r) => {
      if (seen.has(r.requestId)) {
        skipped++;
        return false;
      }
      seen.add(r.requestId);
      return true;
    });
    syncAt = Date.now();
    window.dispatchEvent(
      new CustomEvent("android-data-warning", {
        detail: [
          `扫描 ${list.files.length} 个文件，读取到 ${logs.length} 条用量记录。`,
          deferred ? `${deferred} 个继承日志暂缓统计。` : "",
          noUsage ? `${noUsage} 个文件没有可统计的用量事件。` : "",
          errors.length ? `${errors.length} 个读取失败。` : "",
          list.truncated ? "目录达到扫描上限。" : "",
          ...[...reasons]
            .slice(0, 4)
            .map(([reason, count]) => `${count} 个文件：${reason}。`),
          !logs.length
            ? "没有读到可统计用量；请确认 Codex 已完成请求并写入会话日志。"
            : "请按时间范围筛选；历史记录可能不在“当天”内。",
        ]
          .filter(Boolean)
          .join(" "),
      }),
    );
    window.dispatchEvent(new CustomEvent("usage-log-recorded"));
    return {
      imported: logs.length,
      skipped,
      filesScanned: list.files.length,
      suspectedDuplicates: skipped,
      deferredFiles: deferred + (list.truncated ? 1 : 0),
      partialFiles: partial,
      filesWithoutUsage: noUsage,
      errors,
    };
  })();
  try {
    return await scans;
  } finally {
    scans = null;
  }
}
function priced(rows: RequestLog[], pricing: ModelPricing[]) {
  return rows.map((r) => {
    const p = pricing.find(
      (p) => normalizeCodexUsageModel(p.modelId) === r.model,
    );
    if (!p) return r;
    const cost = (n: number, s: string) => ((n * Number(s)) / 1e6).toFixed(8);
    const a = cost(
        Math.max(0, r.inputTokens - r.cacheReadTokens - r.cacheCreationTokens),
        p.inputCostPerMillion,
      ),
      b = cost(r.outputTokens, p.outputCostPerMillion),
      c = cost(r.cacheReadTokens, p.cacheReadCostPerMillion),
      d = cost(r.cacheCreationTokens, p.cacheCreationCostPerMillion);
    return {
      ...r,
      inputCostUsd: a,
      outputCostUsd: b,
      cacheReadCostUsd: c,
      cacheCreationCostUsd: d,
      totalCostUsd: (Number(a) + Number(b) + Number(c) + Number(d)).toFixed(8),
    };
  });
}
const total = (rows: RequestLog[]) =>
  rows.reduce(
    (s, r) => ({
      totalRequests: s.totalRequests + 1,
      totalCost: String(Number(s.totalCost) + Number(r.totalCostUsd || 0)),
      totalInputTokens:
        s.totalInputTokens +
        Math.max(0, r.inputTokens - r.cacheReadTokens - r.cacheCreationTokens),
      totalOutputTokens: s.totalOutputTokens + r.outputTokens,
      totalCacheCreationTokens:
        s.totalCacheCreationTokens + r.cacheCreationTokens,
      totalCacheReadTokens: s.totalCacheReadTokens + r.cacheReadTokens,
      successRate: 0,
      realTotalTokens: s.realTotalTokens + r.inputTokens + r.outputTokens,
      cacheHitRate: 0,
    }),
    {
      totalRequests: 0,
      totalCost: "0",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      successRate: 0,
      realTotalTokens: 0,
      cacheHitRate: 0,
    },
  );
function summary(rows: RequestLog[]) {
  const s = total(rows);
  s.cacheHitRate =
    s.totalCacheReadTokens /
    (s.totalInputTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens ||
      1);
  if (rows.some((r) => !r.totalCostUsd)) s.totalCost = "";
  return s;
}
export async function androidCommand(
  command: string,
  args: Record<string, any> = {},
): Promise<any> {
  switch (command) {
    case "get_settings":
      return (await loadUi()).settings;
    case "save_settings":
      (await loadUi()).settings = { ...ui.settings, ...args.settings };
      await saveUi();
      return ui.settings;
    case "list_sessions":
      return isNative ? sessions() : [];
    case "get_session_messages":
      return transcript(await file(args.sourcePath));
    case "stream_session_messages": {
      const messages = transcript(await file(args.sourcePath));
      args.onChunk.onmessage({
        type: "header",
        total: messages.length,
        turns: buildTurnIndex(buildTurns(messages)),
        cached: false,
        parseMs: 0,
      });
      for (let start = 0; start < messages.length; start += 100)
        args.onChunk.onmessage({
          type: "messages",
          start,
          messages: messages.slice(start, start + 100),
        });
      args.onChunk.onmessage({ type: "done", payloadBytes: 0 });
      return;
    }
    case "sync_session_index": {
      const list = await sessions();
      return { running: false, total: list.length, processed: list.length };
    }
    case "clear_session_index":
      sessionCache.clear();
      return true;
    case "search_session_content": {
      const list = await sessions(),
        needle = String(args.query).toLocaleLowerCase(),
        hits = [];
      for (const s of list) {
        const messages = transcript(
          sessionCache.get(s.sourcePath!)?.data ?? (await file(s.sourcePath!)),
        );
        const snippets: any[] = [];
        let count = 0;
        messages.forEach((m, index) => {
          const text =
            m.content ??
            m.blocks
              ?.map(
                (b) =>
                  (b as any).text ??
                  (b as any).inputPreview ??
                  (b as any).preview ??
                  "",
              )
              .join(" ") ??
            "";
          const at = text.toLocaleLowerCase().indexOf(needle);
          if (at >= 0) {
            count++;
            const start = Math.max(0, at - 70);
            if (snippets.length < 3)
              snippets.push({
                messageIndex: index,
                text: text.slice(start, at + needle.length + 100),
                highlights: [
                  { start: at - start, end: at - start + needle.length },
                ],
              });
          }
        });
        if (count)
          hits.push({
            providerId: "codex",
            sourcePath: s.sourcePath,
            snippets,
            matchCount: count,
          });
      }
      return {
        hits,
        status: { running: false, total: list.length, processed: list.length },
      };
    }
    case "export_session_markdown":
      await invoke("exportFile", {
        name: "codex-session-" + Date.now() + ".md",
        text: args.content,
      });
      return "系统选择的文档";
    case "launch_session_terminal":
      throw Error(
        "Android 目录授权不能启动 Codex 终端。请复制恢复命令后在 Codex 中执行。",
      );
    case "reveal_session_path":
      throw Error(
        "此路径位于 Codex 私有环境，Android 文件管理器不能直接打开；请在 Codex 内查看。",
      );
    case "delete_session":
    case "delete_sessions":
      throw Error(
        "删除会话还需更新 Codex 的 SQLite 索引；SAF 不能协调正在运行的 Codex。请在 Codex 内删除。",
      );
    case "sync_session_usage":
    case "rebuild_codex_usage":
      if (command === "rebuild_codex_usage") usageCache.clear();
      return sync();
    case "get_session_usage_last_sync":
      return syncAt;
    case "get_model_pricing":
      return (await loadUi()).pricing;
    case "update_model_pricing": {
      const d = await loadUi();
      const p = {
        modelId: args.modelId,
        displayName: args.displayName,
        inputCostPerMillion: args.inputCost,
        outputCostPerMillion: args.outputCost,
        cacheReadCostPerMillion: args.cacheReadCost,
        cacheCreationCostPerMillion: args.cacheCreationCost,
      };
      d.pricing = [...d.pricing.filter((v: any) => v.modelId !== p.modelId), p];
      await saveUi();
      return;
    }
    case "update_model_pricing_batch": {
      const d = await loadUi();
      const map = new Map(d.pricing.map((v: any) => [v.modelId, v]));
      for (const p of args.entries) map.set(p.modelId, p);
      d.pricing = [...map.values()];
      await saveUi();
      return args.entries.length;
    }
    case "delete_model_pricing":
      (await loadUi()).pricing = ui.pricing.filter(
        (p: any) => p.modelId !== args.modelId,
      );
      await saveUi();
      return;
    case "get_models_dev_sync_config":
      return {
        config: (await loadUi()).modelsDev ?? {
          autoSyncEnabled: false,
          includeCommonModels: false,
          selectedModelKeys: [],
          excludedCommonModelKeys: [],
          lastSyncAt: null,
          lastSyncError: null,
        },
        configPath: "Android 本地加密存储",
      };
    case "save_models_dev_sync_config":
      (await loadUi()).modelsDev = args.config;
      await saveUi();
      return;
    case "record_models_dev_sync_result":
      (await loadUi()).modelsDev = {
        ...ui.modelsDev,
        lastSyncAt: args.syncedAt,
        lastSyncError: args.error,
      };
      await saveUi();
      return;
    case "fetch_models_for_config":
      return invoke("fetchModels", args);
    case "test_api_endpoints":
      return invoke("testEndpoints", args);
    case "get_custom_endpoints":
      return [];
    case "get_providers":
      return {};
    case "fetch_exchange_rates":
      return invoke("exchangeRates");
    case "fetch_models_dev":
    case "fetch_models_dev_data":
      return invoke("modelsDev");
    case "get_native_config_path":
      return ".codex/config.toml（已授权文档目录）";
  }
  if (
    command.startsWith("get_usage") ||
    [
      "get_provider_stats",
      "get_model_stats",
      "get_request_logs",
      "get_request_detail",
      "get_session_usage_summary",
    ].includes(command)
  ) {
    const d = await loadUi();
    const f = args.filters ?? args;
    const rows = priced(logs, d.pricing).filter(
      (r) =>
        (!f.appType || f.appType === "all" || f.appType === "codex") &&
        (!f.startDate || r.createdAt >= f.startDate) &&
        (!f.endDate || r.createdAt <= f.endDate) &&
        (!f.model || r.model === f.model) &&
        (!f.providerName || r.providerName === f.providerName) &&
        (!f.statusCode || r.statusCode === f.statusCode),
    );
    if (command === "get_usage_summary") return summary(rows);
    if (command === "get_usage_summary_by_app")
      return [{ appType: "codex", summary: summary(rows) }];
    if (command === "get_request_logs")
      return {
        data: rows
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(
            (args.page ?? 0) * (args.pageSize ?? 20),
            ((args.page ?? 0) + 1) * (args.pageSize ?? 20),
          ),
        total: rows.length,
        page: args.page ?? 0,
        pageSize: args.pageSize ?? 20,
      };
    if (command === "get_request_detail")
      return (
        priced(logs, d.pricing).find((r) => r.requestId === args.requestId) ??
        null
      );
    if (command === "get_usage_first_date")
      return rows.length
        ? new Date(
            rows.reduce((min, r) => Math.min(min, r.createdAt), Infinity) *
              1000,
          ).toLocaleDateString("sv-SE")
        : null;
    if (command === "get_usage_data_sources")
      return [
        {
          dataSource: "session",
          requestCount: rows.length,
          totalCostUsd: summary(rows).totalCost,
        },
      ];
    if (command === "get_session_usage_summary")
      return summary(
        rows.filter(
          (r) =>
            r.sessionId === args.sessionId ||
            r.requestId.startsWith("codex:" + args.sessionId + ":"),
        ),
      );
    const groups = new Map<string, RequestLog[]>();
    for (const r of rows) {
      const key =
        command === "get_usage_trends"
          ? args.endDate &&
            args.startDate &&
            args.endDate - args.startDate <= 2 * 86400
            ? new Date(Math.floor(r.createdAt / 3600) * 3600000).toISOString()
            : new Date(r.createdAt * 1000).toLocaleDateString("sv-SE")
          : command === "get_provider_stats"
            ? r.providerName!
            : r.model;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => {
        const s = summary(items);
        return command === "get_usage_trends"
          ? {
              date: name,
              requestCount: items.length,
              totalTokens: s.realTotalTokens,
              ...s,
            }
          : {
              providerId: items[0].providerId,
              appType: "codex",
              providerName: name,
              model: name,
              requestCount: items.length,
              totalTokens: s.realTotalTokens,
              totalCost: s.totalCost,
              successRate: 0,
              successRateKnown: false,
              avgLatencyMs: 0,
              avgCostPerRequest: s.totalCost
                ? String(Number(s.totalCost) / items.length)
                : "",
              firstTokenMedianMs: null,
            };
      });
  }
  throw new Error(
    "此功能需要 Codex 宿主配合或尚未提供 Android 接口：" + command,
  );
}
