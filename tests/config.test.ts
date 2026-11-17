import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import {
  authStatus,
  captureCurrent,
  editRawConfig,
  exportProviders,
  importProviders,
  matchProvider,
  newProvider,
  initialProviderSetup,
  providerEditorView,
  providerConfigFromEditor,
  planProviderEditorGlobals,
  planApply,
  projection,
  redactConfig,
  validateProvider,
} from "../src/core/codex.ts";
import { canonical, parseConfig, patchPath } from "../src/core/tomlPatch.ts";
import type { Provider, Snapshot } from "../src/core/types.ts";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    ...newProvider(),
    name: "测试服务",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "TEST_ONLY_KEY_123" },
      config:
        'model_provider = "vendor"\nmodel = "test-model"\nmodel_reasoning_effort = "high"\n[model_providers.vendor]\nname = "Test"\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\n',
    },
    ...overrides,
  };
}
function snapshot(config: string | null, auth: string | null = null): Snapshot {
  return {
    config,
    auth,
    revision: "fixture-not-a-real-SAF-revision",
    directory: {
      uri: "content://test.invalid/tree/fixture",
      name: "fixture",
      authority: "test.invalid",
      providerPackage: "test",
      isCodexProvider: false,
      canWrite: true,
    },
  };
}

const unrelated = `# User settings: untouched byte for byte
notify = ["notify-app", "[model_providers.custom]"]
cwd = "/home/codex/workspace"
cli_auth_credentials_store = "keyring"
user_message = "真实中文“引号”保留"
timestamp = 2026-11-16T01:02:03Z
[mcp_servers.android]
command = "/usr/local/bin/mcp-android"
args = ["--stdio", "[fake.section]", "model = 'fake'"]
env = { TOKEN_FOR_MCP = "MCP_SECRET_NOT_PROVIDER_KEY" }
[projects."/home/codex/workspace"]
trust_level = "trusted"
[desktop]
custom = true
[[custom_user_tables]]
name = "one"
[[custom_user_tables]]
name = "two"
`;

test("missing config: creates native Responses route, no auth.json key dependency", () => {
  const live = snapshot(null);
  const plan = planApply(live, provider());
  const doc = parse(plan.config) as any;
  assert.equal(doc.model_provider, "custom");
  assert.equal(
    doc.model_providers.custom.experimental_bearer_token,
    "TEST_ONLY_KEY_123",
  );
  assert.equal(doc.model_providers.custom.requires_openai_auth, false);
  assert.equal(live.auth, null);
  assert.equal(
    matchProvider({ ...live, config: plan.config }, provider()),
    "exact",
  );
});

test("preserves MCP, workspace, keyring mode, arrays, dates and unrelated source bytes", () => {
  const plan = planApply(snapshot('model = "old"\n' + unrelated), provider());
  assert.ok(plan.config.includes(unrelated));
  const doc = parse(plan.config) as any;
  assert.equal(
    doc.mcp_servers.android.env.TOKEN_FOR_MCP,
    "MCP_SECRET_NOT_PROVIDER_KEY",
  );
  assert.equal(doc.cwd, "/home/codex/workspace");
  assert.equal(doc.cli_auth_credentials_store, "keyring");
  assert.equal(doc.custom_user_tables.length, 2);
  assert.ok(plan.warnings.some((w) => w.includes("钥匙串")));
});

test("matching uses actual values including key and provider parameters", () => {
  const p = provider();
  const plan = planApply(snapshot(null), p);
  assert.equal(matchProvider(snapshot(plan.config), p), "exact");
  assert.equal(
    matchProvider(
      snapshot(plan.config.replace("TEST_ONLY_KEY_123", "DIFFERENT_TEST_KEY")),
      p,
    ),
    "related",
  );
  assert.equal(
    matchProvider(snapshot(plan.config.replace('"high"', '"low"')), p),
    "related",
  );
  assert.equal(
    matchProvider(
      snapshot(plan.config.replace("example.invalid", "other.invalid")),
      p,
    ),
    "different",
  );
});

test("reapplying an identical provider is a byte-identical no-op", () => {
  const p = provider();
  const first = planApply(snapshot(unrelated), p);
  const second = planApply(
    { ...snapshot(first.config), ownership: first.ownership },
    p,
  );
  assert.equal(second.config, first.config);
  assert.deepEqual(second.changedFields, []);
});

test("CRLF and inline comments survive scalar edits", () => {
  const source =
    '# note\r\nmodel = "old" # keep this comment\r\n[mcp_servers.a]\r\ncommand = "echo"\r\n';
  const result = patchPath(source, ["model"], "new");
  assert.equal(result, source.replace('"old"', '"new"'));
  const plan = planApply(snapshot(source), provider());
  assert.ok(plan.config.includes('[mcp_servers.a]\r\ncommand = "echo"\r\n'));
  assert.ok(!/(?<!\r)\n/.test(plan.config));
});

test("a TOML multiline string containing forged table headers is never treated as a table", () => {
  // A valid literal multiline form also includes quote-like and comment-like text.
  const literal =
    "message = '''\n[model_providers.custom]\nmodel = \"nested\"\n# not a comment\n'''\n";
  parse(literal);
  const plan = planApply(
    snapshot(
      literal + unrelated.replace('user_message = "真实中文“引号”保留"\n', ""),
    ),
    provider(),
  );
  assert.ok(plan.config.includes(literal));
  assert.equal(
    (parse(plan.config) as any).message,
    (parse(literal) as any).message,
  );
});

test("basic multiline strings, escapes and multiline arrays are preserved", () => {
  const source = `message = """\n[model_providers.custom]\nmodel = 'not a key'\n"""\narr = [\n "#not-comment", # actual comment\n { item = "[header]" },\n]\n`;
  const plan = planApply(snapshot(source), provider());
  assert.ok(plan.config.includes(source));
});

test("quoted and dotted custom provider keys are handled structurally", () => {
  const source =
    'model_provider = "custom"\nmodel = "old"\n["model_providers"."custom"]\nname = "Old"\nbase_url = "https://old.invalid"\n[model_providers.other]\nbase_url = "https://keep.invalid"\n';
  const plan = planApply(snapshot(source), provider());
  assert.equal(
    (parse(plan.config) as any).model_providers.other.base_url,
    "https://keep.invalid",
  );
  assert.equal((parse(plan.config) as any).model_providers.custom.name, "Test");
});

test("inline model_providers keeps unrelated members", () => {
  const source =
    'model_provider = "custom"\nmodel_providers = { custom = { name = "old", base_url = "https://old.invalid" }, other = { name = "keep", base_url = "https://keep.invalid" } } # preserve outer comment\n';
  const plan = planApply(snapshot(source), provider());
  assert.equal((parse(plan.config) as any).model_providers.other.name, "keep");
  assert.ok(plan.config.includes("# preserve outer comment"));
});

test("provider tables expressed through root dotted assignments can be replaced", () => {
  const source =
    'model_provider="custom"\nmodel_providers.custom.name="old"\nmodel_providers.custom.base_url="https://old.invalid"\nmodel_providers.other.name="keep"\n';
  const plan = planApply(snapshot(source), provider());
  assert.equal((parse(plan.config) as any).model_providers.other.name, "keep");
  assert.equal((parse(plan.config) as any).model_providers.custom.name, "Test");
});

test("provider-specific context changes restore prior user defaults on switch", () => {
  const p = provider();
  p.settingsConfig.config =
    "model_context_window = 200000\n" + p.settingsConfig.config;
  const first = planApply(
    snapshot("model_context_window = 100000\n" + unrelated),
    p,
  );
  assert.equal((parse(first.config) as any).model_context_window, 200000);
  const next = planApply(
    { ...snapshot(first.config), ownership: first.ownership },
    provider(),
  );
  assert.equal((parse(next.config) as any).model_context_window, 100000);
  assert.ok(next.config.includes(unrelated));
});

test("does not remove a user edit to a previously owned optional field", () => {
  const p = provider();
  p.settingsConfig.config =
    "model_context_window = 200000\n" + p.settingsConfig.config;
  const first = planApply(snapshot(null), p);
  const external = first.config.replace("200000", "300000");
  const next = planApply(
    { ...snapshot(external), ownership: first.ownership },
    provider(),
  );
  assert.equal((parse(next.config) as any).model_context_window, 300000);
});

test("nested model fields preserve other agents and memories settings", () => {
  const p = provider();
  p.settingsConfig.config +=
    '\n[agents]\ndefault_subagent_model = "test-subagent"\n';
  const source =
    '[agents]\nmax_threads = 6\n[agents.reviewer]\ndescription = "keep"\n[memories]\nuse = true\n';
  const plan = planApply(snapshot(source), p);
  const doc = parse(plan.config) as any;
  assert.equal(doc.agents.default_subagent_model, "test-subagent");
  assert.equal(doc.agents.max_threads, 6);
  assert.equal(doc.agents.reviewer.description, "keep");
});

test("nested model fields also work with an inline agents table", () => {
  const p = provider();
  p.settingsConfig.config +=
    '\n[agents]\ndefault_subagent_model="test-subagent"\n';
  const plan = planApply(
    snapshot(
      'agents = { max_threads = 6, reviewer = { description = "keep" } }\n',
    ),
    p,
  );
  assert.equal((parse(plan.config) as any).agents.reviewer.description, "keep");
});

test("keyring and auto modes do not invent authenticated account state", () => {
  for (const mode of ["keyring", "auto"]) {
    const live = snapshot(`cli_auth_credentials_store = "${mode}"\n`);
    const plan = planApply(live, provider());
    assert.equal(
      (parse(plan.config) as any).model_providers.custom.requires_openai_auth,
      false,
    );
    assert.equal(authStatus(null, parseConfig(live.config!)).fileLogin, false);
  }
});

test("file login material is preserved and official UI uses the provider's own key", () => {
  const auth =
    '{"tokens":{"access_token":"FAKE_ACCESS_TOKEN","refresh_token":"FAKE_REFRESH_TOKEN"},"custom":{"keep":true}}';
  const live = snapshot(null, auth);
  const plan = planApply(live, provider());
  assert.equal(
    (parse(plan.config) as any).model_providers.custom.requires_openai_auth,
    true,
  );
  assert.equal(
    (parse(plan.config) as any).model_providers.custom
      .experimental_bearer_token,
    "TEST_ONLY_KEY_123",
  );
  assert.equal(live.auth, auth);
});

test("official switch removes third-party routing and keeps auth/keyring settings", () => {
  const first = planApply(
    snapshot(unrelated, '{"tokens":{"access_token":"FAKE"}}'),
    provider(),
  );
  const official = { ...newProvider("official"), name: "官方" };
  const next = planApply(
    snapshot(first.config, '{"tokens":{"access_token":"FAKE"}}'),
    official,
  );
  const doc = parse(next.config) as any;
  assert.equal(doc.model_provider, undefined);
  assert.equal(doc.model_providers?.custom, undefined);
  assert.ok(!next.config.includes("TEST_ONLY_KEY_123"));
  assert.ok(next.config.includes(unrelated));
  assert.equal(matchProvider(snapshot(next.config), official), "exact");
});

test("missing key cannot fall back to official credentials", () => {
  const p = provider();
  p.settingsConfig.auth = {};
  assert.throws(
    () => planApply(snapshot(null, '{"OPENAI_API_KEY":"OFFICIAL_FAKE"}'), p),
    /缺少 API Key/,
  );
});

test("empty key can be saved as a draft, but cannot be applied", () => {
  const p = provider();
  p.settingsConfig.auth = {};
  assert.equal(
    validateProvider(p).settingsConfig.auth.OPENAI_API_KEY,
    undefined,
  );
  assert.throws(() => planApply(snapshot(null), p), /缺少 API Key/);
});

test("environment-variable auth removes stale bearer and preserves variable name", () => {
  const p = provider({ authKind: "env" });
  p.settingsConfig.config +=
    'env_key = "CODEX_TEST_KEY"\nexperimental_bearer_token="OLD_TEST_KEY"\n';
  const plan = planApply(snapshot(null), p);
  const route = (parse(plan.config) as any).model_providers.custom;
  assert.equal(route.env_key, "CODEX_TEST_KEY");
  assert.equal(route.experimental_bearer_token, undefined);
  assert.ok(plan.warnings.some((w) => w.includes("环境变量")));
});

test("no-auth service never requests official auth or includes a stale API key", () => {
  const p = provider({ authKind: "none" });
  const plan = planApply(
    snapshot(null, '{"tokens":{"access_token":"FAKE"}}'),
    p,
  );
  const route = (parse(plan.config) as any).model_providers.custom;
  assert.equal(route.requires_openai_auth, false);
  assert.equal(route.experimental_bearer_token, undefined);
});

test("legacy auth.json profile shape imports into native bearer projection", () => {
  const p = provider();
  const imported = importProviders(
    JSON.stringify({ codex: { providers: { old: p } } }),
  ).providers[0];
  assert.notEqual(imported.id, p.id);
  assert.equal(
    (parse(planApply(snapshot(null), imported).config) as any).model_providers
      .custom.experimental_bearer_token,
    "TEST_ONLY_KEY_123",
  );
});

test("legacy top-level endpoint profile is normalized to custom", () => {
  const p = provider();
  p.settingsConfig.config =
    'model="test-model"\nopenai_base_url="https://example.invalid/v1"\n';
  const plan = planApply(snapshot(null), p);
  assert.equal((parse(plan.config) as any).openai_base_url, undefined);
  assert.equal(
    (parse(plan.config) as any).model_providers.custom.base_url,
    "https://example.invalid/v1",
  );
});

test("capture current copies routing, never MCP, projects or OAuth tokens", () => {
  const first = planApply(snapshot(unrelated), provider());
  const captured = captureCurrent(
    snapshot(first.config, '{"tokens":{"access_token":"PRIVATE_OAUTH_TEST"}}'),
    "导入",
  );
  assert.equal(
    captured.settingsConfig.auth.OPENAI_API_KEY,
    "TEST_ONLY_KEY_123",
  );
  assert.ok(!JSON.stringify(captured).includes("PRIVATE_OAUTH_TEST"));
  assert.ok(!captured.settingsConfig.config.includes("mcp_servers"));
  assert.ok(!captured.settingsConfig.config.includes("projects"));
});

test("export without keys removes tokens, headers, query auth and notes", () => {
  const p = provider();
  p.notes = "SECRET_IN_NOTE";
  p.settingsConfig.config +=
    'experimental_bearer_token="EXTRA_TEST_SECRET"\nhttp_headers={"X-Custom"="HEADER_TEST_SECRET"}\nquery_params={"access"="QUERY_TEST_SECRET"}\n';
  const text = exportProviders([p], false);
  for (const secret of [
    "TEST_ONLY_KEY_123",
    "EXTRA_TEST_SECRET",
    "HEADER_TEST_SECRET",
    "QUERY_TEST_SECRET",
    "SECRET_IN_NOTE",
  ])
    assert.ok(!text.includes(secret));
  assert.equal(importProviders(text).providers.length, 1);
  assert.ok(exportProviders([p], true).includes("TEST_ONLY_KEY_123"));
});

test("malformed config and auth block before returning a write plan; errors are redacted", () => {
  assert.throws(
    () =>
      planApply(
        snapshot('experimental_bearer_token="SECRET_UNTERMINATED\n'),
        provider(),
      ),
    (error) => !String(error).includes("SECRET_UNTERMINATED"),
  );
  assert.throws(
    () => planApply(snapshot('model = "a"\nmodel = "b"'), provider()),
    /格式错误/,
  );
  assert.throws(
    () =>
      planApply(snapshot(null, '{"token":"SECRET_UNTERMINATED'), provider()),
    (error) => !String(error).includes("SECRET_UNTERMINATED"),
  );
  assert.throws(
    () => planApply(snapshot(null, "[]"), provider()),
    /auth.json 格式错误/,
  );
});

test("unsupported wire APIs and external auth commands fail explicitly", () => {
  const p = provider();
  assert.throws(
    () =>
      projection({
        ...p,
        settingsConfig: {
          ...p.settingsConfig,
          config: p.settingsConfig.config.replace('"responses"', '"chat"'),
        },
      }),
    /协议转换/,
  );
  assert.throws(
    () =>
      projection({
        ...p,
        settingsConfig: {
          ...p.settingsConfig,
          config: p.settingsConfig.config + 'auth = { command = "external" }\n',
        },
      }),
    /外部认证/,
  );
});

test("reserved live provider names are not silently deleted", () => {
  assert.throws(
    () =>
      planApply(
        snapshot('[model_providers.openai]\nname="legacy"\n'),
        provider(),
      ),
    /保留名称/,
  );
});

test("wrong URL, control character key and type errors fail safely", () => {
  const p = provider();
  assert.throws(
    () =>
      planApply(snapshot(null), {
        ...p,
        settingsConfig: {
          ...p.settingsConfig,
          config: p.settingsConfig.config.replace(
            "https://example.invalid/v1",
            "javascript:bad",
          ),
        },
      }),
    /HTTP/,
  );
  assert.throws(
    () =>
      planApply(snapshot(null), {
        ...p,
        settingsConfig: {
          ...p.settingsConfig,
          auth: { OPENAI_API_KEY: "abc\nxyz" },
        },
      }),
    /控制字符/,
  );
  assert.throws(() => planApply(snapshot("model = 42\n"), p), /必须是字符串/);
  assert.throws(
    () => planApply(snapshot("model_providers = []\n"), p),
    /必须是 TOML 表/,
  );
});

test("an invalid import is all-or-nothing and database dumps are not mislabeled as supported", () => {
  assert.throws(
    () =>
      importProviders(
        JSON.stringify({ providers: [provider(), { name: "broken" }] }),
      ),
    /第 2 项/,
  );
  assert.throws(
    () => importProviders("CREATE TABLE providers (...)"),
    /不支持 SQLite/,
  );
  assert.throws(
    () => importProviders(JSON.stringify({ providers: [] })),
    /1–200/,
  );
});

test("a provider's embedded unrelated config never overwrites live settings", () => {
  const p = provider();
  p.settingsConfig.config +=
    '\n[mcp_servers.android]\ncommand="wrong"\n[projects."/home/codex/workspace"]\ntrust_level="untrusted"\n';
  const plan = planApply(snapshot(unrelated), p);
  assert.ok(plan.config.includes(unrelated));
});

test("BOM, empty documents and final lines without newlines round-trip safely", () => {
  for (const source of [
    "",
    "\uFEFF",
    "# last comment",
    'model="old"',
    '\uFEFFmodel="old"\n',
  ]) {
    const plan = planApply(snapshot(source), provider());
    assert.equal((parseConfig(plan.config) as any).model, "test-model");
    assert.equal(matchProvider(snapshot(plan.config), provider()), "exact");
  }
});

test("retired storage flag is removed while a foreign model catalog pointer is preserved", () => {
  const source =
    'disable_response_storage = true\nmodel_catalog_json="/home/codex/.codex/my-catalog.json"\n';
  const plan = planApply(snapshot(source), provider());
  assert.equal((parse(plan.config) as any).disable_response_storage, undefined);
  assert.equal(
    (parse(plan.config) as any).model_catalog_json,
    "/home/codex/.codex/my-catalog.json",
  );
});

test("redacted preview never includes conventional credential fields", () => {
  const text =
    'experimental_bearer_token="SECRET_A"\n[mcp_servers.x.env]\nAPI_KEY="SECRET_B"\npassword="SECRET_C"\n';
  const result = redactConfig(text);
  assert.ok(!/SECRET_[ABC]/.test(result));
  assert.ok(result.includes("已隐藏"));
});

test("Chinese quote normalization applies only to imported profile syntax", () => {
  const p = provider();
  p.settingsConfig.config = p.settingsConfig.config.replace(
    'model = "test-model"',
    "model = “test-model”",
  );
  const saved = validateProvider(p);
  assert.equal((parse(saved.settingsConfig.config) as any).model, "test-model");
  assert.throws(
    () => planApply(snapshot("model = “broken live config”"), saved),
    /格式错误/,
  );
});

test("raw bearer editor updates the higher-priority auth key", () => {
  const p = provider();
  const edited = editRawConfig(
    p,
    p.settingsConfig.config + 'experimental_bearer_token="NEW_RAW_TEST_KEY"\n',
  );
  assert.equal(
    projection(edited).route?.experimental_bearer_token,
    "NEW_RAW_TEST_KEY",
  );
  const removed = editRawConfig(edited, p.settingsConfig.config);
  assert.throws(() => projection(removed), /缺少 API Key/);
});

test("dotted agents fields can coexist with inserted owned model fields", () => {
  const p = provider();
  p.settingsConfig.config +=
    '\n[agents]\ndefault_subagent_model="test-subagent"\n';
  const plan = planApply(snapshot("agents.max_threads=6\n"), p);
  assert.equal((parse(plan.config) as any).agents.max_threads, 6);
  assert.equal(
    (parse(plan.config) as any).agents.default_subagent_model,
    "test-subagent",
  );
});

test("URL query credentials are removed in redacted views and key-free exports", () => {
  const p = provider();
  p.settingsConfig.config = p.settingsConfig.config.replace(
    "https://example.invalid/v1",
    "https://example.invalid/v1?access_token=SECRET_IN_QUERY",
  );
  assert.ok(!redactConfig(p.settingsConfig.config).includes("SECRET_IN_QUERY"));
  assert.ok(!exportProviders([p], false).includes("SECRET_IN_QUERY"));
});

test("preview and key-free export strip arbitrary headers and URL query credentials", () => {
  const p = provider();
  p.settingsConfig.config =
    p.settingsConfig.config.replace('/v1"', '/v1?access=QUERY_SECRET"') +
    'http_headers={"X-Custom"="HEADER_SECRET"}\n';
  for (const result of [
    redactConfig(p.settingsConfig.config),
    exportProviders([p], false),
  ]) {
    assert.ok(!result.includes("QUERY_SECRET"));
    assert.ok(!result.includes("HEADER_SECRET"));
  }
});

test("capture retains legacy inline key, but blocks unresolvable official fallback", () => {
  const p = captureCurrent(
    snapshot(
      'model="test"\nopenai_base_url="https://example.invalid/v1"\nexperimental_bearer_token="LEGACY_TEST_KEY"\n',
    ),
    "legacy",
  );
  assert.equal(p.settingsConfig.auth.OPENAI_API_KEY, "LEGACY_TEST_KEY");
  assert.throws(
    () =>
      captureCurrent(
        snapshot('openai_base_url="https://example.invalid/v1"\n'),
        "legacy",
      ),
    /没有可迁移/,
  );
});

test("stale root routing does not report an exact match", () => {
  const p = provider();
  const live = planApply(snapshot(null), p);
  assert.equal(
    matchProvider(
      snapshot('base_url="https://other.invalid"\n' + live.config),
      p,
    ),
    "related",
  );
});

test("model catalog application preserves MCP and restores a prior foreign pointer", () => {
  const p = provider({
    settingsConfig: {
      ...provider().settingsConfig,
      modelCatalog: {
        models: [{ model: "test-model", contextWindow: 256000 }],
        autoReviewModel: "test-model",
      },
    },
  });
  const original = snapshot(
    'model_catalog_json = "foreign.json"\n' + unrelated,
  );
  const plan = planApply(original, p);
  assert.ok(plan.catalog);
  assert.ok(plan.config.includes(unrelated));
  assert.equal(
    (parse(plan.config) as any).model_catalog_json,
    plan.catalog!.name,
  );
  const next = planApply(
    { ...original, config: plan.config, ownership: plan.ownership },
    provider(),
  );
  assert.equal((parse(next.config) as any).model_catalog_json, "foreign.json");
});
test("filtered route matching checks the recorded remote URL", () => {
  const p = provider({ historyFilter: true });
  const routed = provider({
    historyFilter: true,
    settingsConfig: {
      auth: { OPENAI_API_KEY: "localtoken" },
      config:
        'model_provider="custom"\nmodel="test-model"\nmodel_reasoning_effort="high"\n[model_providers.custom]\nname="Test"\nbase_url="http://127.0.0.1:18181/r/localtoken"\nwire_api="responses"\nsupports_websockets=false\n',
    },
  });
  const plan = planApply(snapshot(null), routed);
  const live = {
    ...snapshot(plan.config),
    filteredRoutes: {
      localtoken: {
        providerId: p.id,
        baseUrl: "https://example.invalid/v1",
        url: "https://example.invalid/v1/responses",
        apiKey: "TEST_ONLY_KEY_123",
      },
    },
  };
  assert.equal(matchProvider(live, p), "exact");
  live.filteredRoutes.localtoken.baseUrl = "https://different.invalid/v1";
  assert.equal(matchProvider(live, p), "different");
});

test("legacy Android login selectors are discarded and never override auth compatibility", () => {
  const old = {
    ...provider(),
    loginPolicy: "keep",
    meta: { androidLoginPolicy: "keep", future: true },
  };
  const normalized = validateProvider(old);
  assert.equal("loginPolicy" in normalized, false);
  assert.equal(normalized.meta?.androidLoginPolicy, undefined);
  assert.equal(normalized.meta?.future, true);
  const noLogin = parseConfig(planApply(snapshot(null), normalized).config);
  assert.equal(noLogin.model_providers.custom.requires_openai_auth, false);
  const loggedIn = parseConfig(
    planApply(
      snapshot(null, '{"tokens":{"access_token":"FIXTURE_OAUTH"}}'),
      normalized,
    ).config,
  );
  assert.equal(loggedIn.model_providers.custom.requires_openai_auth, true);
  assert.equal(
    loggedIn.model_providers.custom.experimental_bearer_token,
    "TEST_ONLY_KEY_123",
  );
});

const fullLiveConfig = `# Complete live file, not a mobile template
model = "current-model"
model_provider = "custom"
service_tier = "default"
cwd = "/home/codex/workspace"
[desktop]
localeOverride = "zh-CN"
sansFontSize = 14
[plugins."fixture@example"]
enabled = true
[[skills.config]]
path = "/home/codex/.codex/skills/test/SKILL.md"
enabled = true
[mcp_servers.android]
command = "/usr/local/bin/mcp-android"
args = ["--stdio"]
[mcp_servers.android.tools.click]
approval_mode = "approve"
[projects."/home/codex/workspace"]
trust_level = "trusted"
[agents]
max_threads = 8
[model_providers.custom]
name = "old"
base_url = "https://old.invalid/v1"
wire_api = "responses"
experimental_bearer_token = "TEST_OLD_ROUTE_KEY"
`;

test("new editor overlays the upstream template on the full live config without copying old route credentials", () => {
  const draft = newProvider();
  const live = snapshot(fullLiveConfig);
  const original = structuredClone(live);
  const shown = providerEditorView(live, draft);
  const doc = parseConfig(shown.settingsConfig.config);
  assert.equal(doc.model, "gpt-5.6-sol");
  assert.equal(doc.desktop.localeOverride, "zh-CN");
  assert.equal(doc.plugins["fixture@example"].enabled, true);
  assert.equal(
    doc.skills.config[0].path,
    "/home/codex/.codex/skills/test/SKILL.md",
  );
  assert.equal(doc.mcp_servers.android.tools.click.approval_mode, "approve");
  assert.equal(doc.projects["/home/codex/workspace"].trust_level, "trusted");
  assert.equal(doc.agents.max_threads, 8);
  assert.ok(shown.settingsConfig.config.split("\n").length > 25);
  assert.ok(!shown.settingsConfig.config.includes("TEST_OLD_ROUTE_KEY"));
  assert.equal(shown.settingsConfig.auth.OPENAI_API_KEY, "");
  assert.deepEqual(live, original);
  assert.throws(() => planApply(live, draft), /模型|地址|Key/);
});

test("editor no-op keeps inherited globals out of a new row and performs no live write", () => {
  const draft = newProvider();
  const base = providerEditorView(snapshot(fullLiveConfig), draft)
    .settingsConfig.config;
  const stored = providerConfigFromEditor(draft, base, base);
  const doc = parseConfig(stored);
  assert.equal(doc.mcp_servers, undefined);
  assert.equal(doc.desktop, undefined);
  assert.equal(doc.skills, undefined);
  assert.equal(doc.projects, undefined);
  assert.equal(doc.agents, undefined);
  const plan = planProviderEditorGlobals(draft, base, base, fullLiveConfig);
  assert.equal(plan.config, fullLiveConfig);
  assert.deepEqual(plan.changedFields, []);
});

test("editor global edits merge only changed values and preserve independent external edits", () => {
  const draft = newProvider();
  const base = providerEditorView(snapshot(fullLiveConfig), draft)
    .settingsConfig.config;
  let edited = patchPath(base, ["desktop", "sansFontSize"], 16);
  edited = patchPath(edited, ["agents", "max_threads"], 12);
  edited = patchPath(
    edited,
    ["mcp_servers", "android", "tools", "click", "approval_mode"],
    "deny",
  );
  const current = patchPath(
    fullLiveConfig,
    ["desktop", "localeOverride"],
    "en-US",
  );
  const plan = planProviderEditorGlobals(draft, base, edited, current);
  const doc = parseConfig(plan.config);
  assert.equal(doc.desktop.sansFontSize, 16);
  assert.equal(doc.desktop.localeOverride, "en-US");
  assert.equal(doc.agents.max_threads, 12);
  assert.equal(doc.mcp_servers.android.tools.click.approval_mode, "deny");
  assert.equal(
    doc.model_providers.custom.experimental_bearer_token,
    "TEST_OLD_ROUTE_KEY",
  );
  assert.equal(
    parseConfig(providerConfigFromEditor(draft, base, edited)).desktop,
    undefined,
  );
});

test("editor refuses conflicting global changes without echoing credentials", () => {
  const draft = newProvider();
  const base = providerEditorView(snapshot(fullLiveConfig), draft)
    .settingsConfig.config;
  const edited = patchPath(base, ["mcp_servers", "android", "args"], ["mine"]);
  const current = patchPath(
    fullLiveConfig,
    ["mcp_servers", "android", "args"],
    ["theirs"],
  );
  assert.throws(
    () => planProviderEditorGlobals(draft, base, edited, current),
    (error: any) => {
      assert.equal(error.code, "editor_conflict");
      assert.ok(!error.message.includes("TEST_OLD_ROUTE_KEY"));
      return true;
    },
  );
});

test("editor allows deliberate global additions and removals without changing the selected route", () => {
  const draft = newProvider();
  const base = providerEditorView(snapshot(fullLiveConfig), draft)
    .settingsConfig.config;
  let edited = patchPath(base, ["plugins", "fixture@example"], undefined);
  edited = patchPath(edited, ["mcp_servers", "new"], {
    command: "fixture-tool",
    args: [],
  });
  const plan = planProviderEditorGlobals(draft, base, edited, fullLiveConfig);
  const doc = parseConfig(plan.config);
  assert.equal(doc.plugins?.["fixture@example"], undefined);
  assert.equal(doc.mcp_servers.new.command, "fixture-tool");
  assert.equal(doc.mcp_servers.android.command, "/usr/local/bin/mcp-android");
  assert.equal(doc.model, "current-model");
});

test("editor preserves stored inactive settings while showing current live settings", () => {
  const p = provider();
  p.settingsConfig.config += "\n[desktop]\nsansFontSize=10\n";
  const base = providerEditorView(snapshot(fullLiveConfig), p).settingsConfig
    .config;
  assert.equal(parseConfig(base).desktop.sansFontSize, 14);
  const row = providerConfigFromEditor(
    p,
    base,
    patchPath(base, ["desktop", "sansFontSize"], 18),
  );
  assert.equal(parseConfig(row).desktop.sansFontSize, 10);
  assert.equal(parseConfig(row).mcp_servers, undefined);
});

test("first connection imports the complete default and seeds the official card without login tokens", () => {
  const live = snapshot(
    fullLiveConfig,
    '{"tokens":{"access_token":"TEST_OAUTH_ONLY"}}',
  );
  const setup = initialProviderSetup({ providers: [] }, live);
  assert.deepEqual(
    setup.additions.map((p) => p.id),
    ["default", "codex-official"],
  );
  assert.equal(setup.additions[0].settingsConfig.config, fullLiveConfig);
  assert.equal(
    setup.additions[0].settingsConfig.auth.OPENAI_API_KEY,
    "TEST_OLD_ROUTE_KEY",
  );
  assert.equal(setup.importedId, "default");
  assert.deepEqual(setup.additions[1].settingsConfig, { auth: {}, config: "" });
  assert.ok(!JSON.stringify(setup.additions).includes("TEST_OAUTH_ONLY"));
});

test("initialization adds only the official card for existing installs and honors the once flag", () => {
  const setup = initialProviderSetup(
    { providers: [provider()] },
    snapshot(fullLiveConfig),
  );
  assert.deepEqual(
    setup.additions.map((p) => p.id),
    ["codex-official"],
  );
  assert.equal(setup.importedId, undefined);
  const done = initialProviderSetup(
    { providers: [], providerInitialization: 1 },
    snapshot(fullLiveConfig),
  );
  assert.deepEqual(done.additions, []);
});

test("official current config is imported fully while keyring login is not invented", () => {
  const source =
    'model="gpt-5.6-sol"\ncli_auth_credentials_store="keyring"\n[mcp_servers.android]\ncommand="fixture"\n';
  const setup = initialProviderSetup({ providers: [] }, snapshot(source));
  assert.equal(setup.additions[0].authKind, "official");
  assert.equal(setup.additions[0].settingsConfig.config, source);
  assert.deepEqual(setup.additions[0].settingsConfig.auth, {});
});

test("malformed or taken-over current files are not imported as a misleading default", () => {
  const malformed = initialProviderSetup(
    { providers: [] },
    snapshot("model = @"),
  );
  assert.deepEqual(
    malformed.additions.map((p) => p.id),
    ["codex-official"],
  );
  assert.equal(malformed.warnings.length, 1);
  const relay = fullLiveConfig.replace(
    "https://old.invalid/v1",
    "http://127.0.0.1:18181/r/TEST_ROUTE",
  );
  const managed = initialProviderSetup({ providers: [] }, snapshot(relay));
  assert.equal(
    managed.additions.some((p) => p.id === "default"),
    false,
  );
  const missing = initialProviderSetup({ providers: [] }, snapshot(null));
  assert.deepEqual(
    missing.additions.map((p) => p.id),
    ["codex-official"],
  );
});

test("editor empty endpoint does not preinsert an empty URL that upstream form would duplicate", () => {
  const shown = providerEditorView(snapshot(fullLiveConfig), newProvider());
  const doc = parseConfig(shown.settingsConfig.config);
  assert.equal(doc.model_providers.custom.base_url, undefined);
  assert.match(shown.settingsConfig.config, /^model_reasoning_effort = /m);
  const withAddress = patchPath(
    shown.settingsConfig.config,
    ["model_providers", "custom", "base_url"],
    "https://new.invalid/v1",
  );
  assert.equal(
    parseConfig(withAddress).model_providers.custom.base_url,
    "https://new.invalid/v1",
  );
});

test("editor supports arrays of tables, multiline strings and CRLF without copying live globals into a row", () => {
  const p = newProvider();
  const source = fullLiveConfig.replace(/\n/g, "\r\n");
  const base = providerEditorView(snapshot(source), p).settingsConfig.config;
  assert.ok(base.includes("[[skills.config]]\r\n"));
  const edited = patchPath(
    base,
    ["user_note"],
    "line one\n[model_providers.fake]\nline two",
  );
  const plan = planProviderEditorGlobals(p, base, edited, source);
  assert.equal(
    parseConfig(plan.config).user_note,
    "line one\n[model_providers.fake]\nline two",
  );
  assert.ok(plan.config.includes("[[skills.config]]\r\n"));
  assert.equal(
    parseConfig(providerConfigFromEditor(p, base, edited)).user_note,
    undefined,
  );
});
