import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionUsage,
  transcript,
  sessionMeta,
} from "../src/android/sessionData.ts";
import { modelCatalog } from "../src/core/modelCatalog.ts";
import { newProvider, validateProvider } from "../src/core/codex.ts";
const event = (type: string, payload: any) => ({
  type,
  payload,
  timestamp: "2026-11-16T06:00:00Z",
});
const data = (events: any[]) => ({
  events,
  path: "sessions/test.jsonl",
  truncated: false,
  invalidLines: 0,
});
test("request usage deduplicates token snapshots and preserves exact last usage", () => {
  const counts = {
    total_token_usage: {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 50,
    },
    last_token_usage: {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 50,
    },
  };
  const file = data([
    event("session_meta", { id: "thread" }),
    event("turn_context", { model: "fixture" }),
    event("event_msg", { type: "token_count", info: counts }),
    event("event_msg", { type: "token_count", info: counts }),
  ]);
  const out = sessionUsage(file);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].cacheReadTokens, 50);
  assert.equal(out.rows[0].statusCode, 0);
  assert.equal(out.rows[0].totalCostUsd, "");
  assert.equal(out.rows[0].model, "fixture");
});
test("usage record is not double counted, zero-last compaction is retained", () => {
  const usage = { input_tokens: 20, output_tokens: 5 };
  const rows = sessionUsage(
    data([
      event("session_meta", { id: "fixture" }),
      event("token_usage_record", { response_id: "r", token_usage: usage }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: usage, last_token_usage: usage },
      }),
    ]),
  ).rows;
  assert.equal(rows.length, 1);
  const other = sessionUsage(
    data([
      event("session_meta", { id: "fixture" }),
      event("token_usage_record", { response_id: "r", token_usage: usage }),
      event("event_msg", {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ]),
  );
  assert.equal(other.rows.length, 1);
});
test("inherited histories without a verified boundary are deferred instead of billed twice", () => {
  for (const meta of [
    { forked_from_id: "parent" },
    { parent_thread_id: "parent" },
    { history_base_thread_id: "parent" },
  ])
    assert.equal(
      sessionUsage(
        data([
          event("session_meta", meta),
          event("token_usage_record", {
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
        ]),
      ).deferred,
      true,
    );
  const prefix = sessionUsage({ ...data([]), truncated: true });
  assert.equal(prefix.deferred, false);
  assert.equal(prefix.partial, true);
});
test("reader retains tool pairing, thinking and event data", () => {
  const file = data([
    event("session_meta", { id: "thread", cwd: "/work" }),
    event("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }),
    event("event_msg", { type: "user_message", message: "hello" }),
    event("response_item", {
      type: "reasoning",
      summary: [{ text: "visible thinking" }],
    }),
    event("response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "c",
      arguments: "{}",
    }),
    event("response_item", {
      type: "function_call_output",
      call_id: "c",
      output: "done",
    }),
  ]);
  const out = transcript(file);
  assert.equal(out.length, 4);
  assert.equal((out[2].blocks![0] as any).id, "c");
  assert.equal((out[3].blocks![0] as any).callId, "c");
  assert.equal(sessionMeta(file).projectDir, "/work");
});
test("catalog preserves per-model reasoning and changes content address after edits", () => {
  const p = newProvider();
  p.settingsConfig.modelCatalog = {
    models: [
      {
        model: "fixture",
        displayName: "显示名",
        contextWindow: 256000,
        reasoningLevels: ["low", "high"],
        defaultReasoningLevel: "low",
      },
    ],
    autoReviewModel: "fixture",
  };
  const cat = modelCatalog(p)!;
  const entry = JSON.parse(cat.text).models[0];
  assert.equal(entry.display_name, "显示名");
  assert.equal(entry.auto_review_model_override, "fixture");
  assert.equal(entry.default_reasoning_level, "low");
  assert.equal(modelCatalog(p)!.name, cat.name);
  p.settingsConfig.modelCatalog.models[0].contextWindow = 512000;
  assert.notEqual(modelCatalog(p)!.name, cat.name);
});
test("provider round trip retains metadata and catalog while retiring the per-provider filter switch", () => {
  const p = newProvider();
  p.name = "fixture";
  p.meta = {
    apiFormat: "openai_responses",
    customUserAgent: "fixture-agent",
    future: { x: 1 },
  };
  p.historyFilter = true;
  p.settingsConfig.modelCatalog = { models: [{ model: "fixture" }] };
  const saved = validateProvider(p);
  assert.deepEqual(saved.meta, p.meta);
  assert.equal(saved.historyFilter, undefined);
  assert.deepEqual(
    saved.settingsConfig.modelCatalog,
    p.settingsConfig.modelCatalog,
  );
});

test("session timestamps use milliseconds while request logs use seconds", () => {
  const d = data([
    event("session_meta", { id: "thread", timestamp: "2026-11-16T06:00:00Z" }),
    event("response_item", {
      type: "message",
      role: "user",
      content: [{ text: "hi" }],
    }),
    event("event_msg", {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } },
    }),
  ]);
  assert.equal(sessionMeta(d).createdAt, Date.parse("2026-11-16T06:00:00Z"));
  assert.equal(transcript(d)[0].ts, Date.parse("2026-11-16T06:00:00Z"));
  assert.equal(
    sessionUsage(d).rows[0].createdAt,
    Date.parse("2026-11-16T06:00:00Z") / 1000,
  );
});

test("key-free exports strip proxy overrides but retain the model list", async () => {
  const { exportProviders } = await import("../src/core/codex.ts");
  const p = newProvider();
  p.name = "fixture";
  p.meta = {
    localProxyRequestOverrides: {
      headers: { "X-Custom": "private-fixture" },
      body: { arbitrary: "private-body" },
    },
    customEndpoints: ["https://example.invalid/?credential=private-endpoint"],
  };
  p.settingsConfig.modelCatalog = { models: [{ model: "fixture" }] };
  const out = exportProviders([p], false);
  assert.equal(out.includes("private-"), false);
  assert.equal(
    JSON.parse(out).providers[0].settingsConfig.modelCatalog.models[0].model,
    "fixture",
  );
});

test("local filter route separates upstream headers and query credentials", async () => {
  const { filterRouteSettings, withLocalFilterRoute } = await import(
    "../src/core/filterRoute.ts"
  );
  const { parseConfig } = await import("../src/core/tomlPatch.ts");
  const p = newProvider();
  p.name = "fixture";
  p.historyFilter = true;
  p.settingsConfig.auth = { OPENAI_API_KEY: "DUMMY_REMOTE" };
  p.settingsConfig.config =
    'model_provider="vendor"\nmodel="fixture"\n[model_providers.vendor]\nbase_url="https://example.invalid/v1"\nwire_api="responses"\nsupports_websockets=true\nhttp_headers={Authorization="Bearer DUMMY_HEADER",X_Test="fixture"}\nquery_params={api_key="DUMMY_QUERY"}\n';
  const settings = filterRouteSettings(p);
  assert.equal(
    new URL(settings.url).searchParams.get("api_key"),
    "DUMMY_QUERY",
  );
  assert.equal(settings.headers.Authorization, "Bearer DUMMY_HEADER");
  const routed = withLocalFilterRoute(p, {
    baseUrl: "http://127.0.0.1:18181/r/localtoken",
    token: "localtoken",
  });
  const table = parseConfig(routed.settingsConfig.config).model_providers
    .vendor;
  assert.equal(table.http_headers, undefined);
  assert.equal(table.query_params, undefined);
  assert.equal(table.supports_websockets, false);
  assert.equal(routed.settingsConfig.auth.OPENAI_API_KEY, "localtoken");
  assert.equal(p.settingsConfig.auth.OPENAI_API_KEY, "DUMMY_REMOTE");
});
test("filter rejects environment-derived headers instead of silently dropping them", async () => {
  const { filterRouteSettings } = await import("../src/core/filterRoute.ts");
  const p = newProvider();
  p.name = "fixture";
  p.settingsConfig.auth = { OPENAI_API_KEY: "DUMMY" };
  p.settingsConfig.config =
    'model_provider="vendor"\nmodel="fixture"\n[model_providers.vendor]\nbase_url="https://example.invalid/v1"\nenv_http_headers={X_Custom="HOST_HEADER"}\n';
  assert.throws(() => filterRouteSettings(p), /环境变量/);
});

test("partial tails and malformed unrelated lines retain complete response records", () => {
  const usage = {
    input_tokens: 120,
    output_tokens: 12,
    cached_input_tokens: 60,
  };
  const file = data([
    event("session_meta", { id: "prefix", model_provider: "fixture" }),
    event("turn_context", { model: "model-a" }),
    event("token_usage_record", { response_id: "response", usage }),
    event("event_msg", {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage },
    }),
  ]);
  for (const boundary of [
    { incompleteTail: true },
    { truncated: true },
    { invalidLines: 1 },
  ]) {
    const result = sessionUsage({ ...file, ...boundary });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].inputTokens, 120);
    assert.equal(result.partial, true);
    assert.equal(result.deferred, false);
  }
});

test("native usage records retain their own models and never sum cumulative turn counters", () => {
  const a = { input_tokens: 30, output_tokens: 3 };
  const b = { input_tokens: 40, output_tokens: 4 };
  const result = sessionUsage(
    data([
      event("session_meta", { id: "native" }),
      event("turn_context", { model: "first", turn_id: "a" }),
      event("token_usage_record", {
        response_id: "r-a",
        usage: a,
        turn_token_usage: { input_tokens: 3000 },
      }),
      event("turn_context", { model: "second", turn_id: "b" }),
      event("token_usage_record", {
        response_id: "r-b",
        usage: b,
        turn_token_usage: { input_tokens: 7000 },
      }),
      event("token_usage_record", { response_id: "r-b", usage: b }),
    ]),
  );
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((r) => r.model),
    ["first", "second"],
  );
  assert.equal(
    result.rows.reduce((n, r) => n + r.inputTokens, 0),
    70,
  );
});

test("cumulative counters resume after compaction instead of being suppressed by a global seen set", () => {
  const counts = { input_tokens: 100, output_tokens: 10 };
  const result = sessionUsage(
    data([
      event("session_meta", { id: "reset" }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: counts, last_token_usage: counts },
      }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: counts, last_token_usage: counts },
      }),
      event("compacted", {}),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: counts, last_token_usage: counts },
      }),
    ]),
  );
  assert.equal(result.rows.length, 2);
});

test("verified post-fork ordinals admit only local response usage", () => {
  const result = sessionUsage(
    data([
      {
        ...event("session_meta", {
          id: "child",
          forked_from_id: "parent",
          forked_from_ordinal_exclusive: 100,
        }),
        ordinal: 100,
        timestamp: "2026-11-16T05:00:00Z",
      },
      event("token_usage_record", {
        response_id: "r-child",
        usage: { input_tokens: 20, output_tokens: 2 },
      }),
    ]),
  );
  assert.equal(result.deferred, false);
  assert.equal(result.rows.length, 1);
});

test("subagent metadata alone does not imply copied history", () => {
  const file = data([
    event("session_meta", { id: "subagent", source: { subagent: "review" } }),
    event("token_usage_record", {
      response_id: "review",
      usage: { input_tokens: 7, output_tokens: 1 },
    }),
  ]);
  assert.equal(sessionUsage(file).rows.length, 1);
});

test("cumulative counters with malformed gaps defer instead of inventing a baseline", () => {
  const result = sessionUsage({
    ...data([
      event("session_meta", { id: "gap" }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 5 } },
      }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 120, output_tokens: 8 } },
      }),
    ]),
    invalidLines: 1,
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.deferred, true);
  assert.equal(result.partial, true);
});

test("cumulative-only complete records use the previous snapshot as a baseline", () => {
  const result = sessionUsage(
    data([
      event("session_meta", { id: "cumulative" }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 5 } },
      }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 120, output_tokens: 8 } },
      }),
    ]),
  );
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((r) => r.inputTokens),
    [100, 20],
  );
});

test("upstream source-aware deduplication ignores stale repeats within each rate-limit lane", () => {
  const a = { input_tokens: 100, output_tokens: 10 },
    b = { input_tokens: 200, output_tokens: 20 };
  const msg = (source: string, value: any) =>
    event("event_msg", {
      type: "token_count",
      rate_limits: { limit_id: source },
      info: {
        total_token_usage: value,
        last_token_usage: { input_tokens: 100, output_tokens: 10 },
      },
    });
  const result = sessionUsage(
    data([
      event("session_meta", { id: "sources" }),
      msg("a", a),
      msg("b", b),
      msg("a", a),
      msg("c", b),
    ]),
  );
  assert.equal(result.rows.length, 3);
  assert.equal(
    result.rows.reduce((sum, row) => sum + row.inputTokens, 0),
    300,
  );
});

test("same-thread continuation with exact per-request usage is not deferred as a fork", () => {
  const id = "11111111-1111-4111-8111-111111111111",
    page = "22222222-2222-4222-8222-222222222222";
  const result = sessionUsage({
    ...data([
      event("session_meta", {
        id,
        forked_from_id: "33333333-3333-4333-8333-333333333333",
        history_mode: "paginated",
        history_base: { thread_id: id },
      }),
      event("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10000, output_tokens: 500 },
          last_token_usage: { input_tokens: 100, output_tokens: 5 },
        },
      }),
    ]),
    path: `sessions/rollout-2026-11-16T06-00-00-${id}_${page}.jsonl`,
  });
  assert.equal(result.deferred, false);
  assert.equal(result.rows[0].inputTokens, 100);
  assert.ok(result.rows[0].requestId.includes(page));
  assert.equal(result.rows[0].sessionId, id);
});

test("parent replay resolution removes copied token snapshots and keeps only child requests", async () => {
  const { resolveUsageFiles } = await import("../src/upstream/codexUsage.ts");
  const count = (n: number, stamp: string) => ({
    ...event("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: n, output_tokens: n / 10 },
        last_token_usage: { input_tokens: 100, output_tokens: 10 },
      },
    }),
    timestamp: stamp,
  });
  const parent = sessionUsage(
    data([
      {
        ...event("session_meta", { id: "parent" }),
        timestamp: "2026-11-16T04:00:00Z",
      },
      count(100, "2026-11-16T04:01:00Z"),
      {
        ...event("response_item", { type: "message" }),
        timestamp: "2026-11-16T05:00:00Z",
      },
    ]),
  );
  const child = sessionUsage({
    ...data([
      {
        ...event("session_meta", { id: "child", forked_from_id: "parent" }),
        timestamp: "2026-11-16T05:00:00Z",
      },
      count(100, "2026-11-16T04:01:00Z"),
      count(200, "2026-11-16T06:00:00Z"),
    ]),
    path: "sessions/child.jsonl",
  });
  assert.equal(child.deferred, true);
  const resolved = resolveUsageFiles([parent, child])[1];
  assert.equal(resolved.deferred, false);
  assert.equal(resolved.rows.length, 1);
  assert.equal(
    resolved.rows[0].createdAt,
    Date.parse("2026-11-16T06:00:00Z") / 1000,
  );
});

test("conflicting parent copies keep fork usage deferred", async () => {
  const { resolveUsageFiles } = await import("../src/upstream/codexUsage.ts");
  const meta = {
    ...event("session_meta", { id: "parent" }),
    timestamp: "2026-11-16T04:00:00Z",
  };
  const item = (n: number) => ({
    ...event("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: n, output_tokens: 1 },
        last_token_usage: { input_tokens: n, output_tokens: 1 },
      },
    }),
    timestamp: "2026-11-16T04:01:00Z",
  });
  const finish = {
    ...event("response_item", {}),
    timestamp: "2026-11-16T06:00:00Z",
  };
  const a = sessionUsage({
    ...data([meta, item(10), finish]),
    path: "sessions/parent.jsonl",
  });
  const b = sessionUsage({
    ...data([meta, item(20), finish]),
    path: "archived_sessions/parent.jsonl",
  });
  const c = sessionUsage({
    ...data([
      {
        ...event("session_meta", { id: "child", forked_from_id: "parent" }),
        timestamp: "2026-11-16T05:00:00Z",
      },
      item(10),
    ]),
    path: "sessions/child.jsonl",
  });
  assert.equal(resolveUsageFiles([a, b, c])[2].deferred, true);
});

test("usage models normalize provider prefixes and dated aliases while retaining request names", () => {
  const result = sessionUsage(
    data([
      event("session_meta", { id: "names" }),
      event("turn_context", { model: "OpenAI/GPT-5.6-SOL-2026-11-16" }),
      event("token_usage_record", {
        usage: { input_tokens: 20, output_tokens: 2 },
      }),
    ]),
  );
  assert.equal(result.rows[0].model, "gpt-5.6-sol");
  assert.equal(result.rows[0].requestModel, "OpenAI/GPT-5.6-SOL-2026-11-16");
});

test("metadata-only inherited files are empty rather than failed usage imports", () => {
  const parsed = sessionUsage(
    data([event("session_meta", { id: "empty", forked_from_id: "parent" })]),
  );
  assert.equal(parsed.deferred, false);
  assert.equal(parsed.rows.length, 0);
});
