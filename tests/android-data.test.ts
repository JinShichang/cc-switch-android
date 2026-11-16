import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionUsage,
  transcript,
  sessionMeta,
} from "../src/android/sessionData.ts";
import { modelCatalog } from "../src/core/modelCatalog.ts";
import { newProvider, planApply, validateProvider } from "../src/core/codex.ts";
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
      event("token_usage_record", { response_id: "r", token_usage: usage }),
      event("event_msg", {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ]),
  );
  assert.equal(other.rows.length, 1);
});
test("inherited and incomplete histories are deferred instead of billed twice", () => {
  for (const meta of [
    { forked_from_id: "parent" },
    { parent_thread_id: "parent" },
    { history_base_thread_id: "parent" },
  ])
    assert.equal(
      sessionUsage(data([event("session_meta", meta)])).deferred,
      true,
    );
  assert.equal(sessionUsage({ ...data([]), truncated: true }).deferred, true);
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
test("provider round trip retains metadata, catalog and filter switch", () => {
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
  assert.equal(saved.historyFilter, true);
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
