// Read-only UI summaries, validation and portable provider import/export.
// All native mutations and provider editor projections use the upstream Rust backend.
// Upstream: aaf6ee963927ea0173e53ac00c1919840948ab22, 4.0.40 (MIT, Jason Young).
// File authentication follows upstream; system keyrings remain Codex-owned.
import { modelCatalog } from "./modelCatalog.ts";
import { stringify } from "smol-toml";
import { getCodexCustomTemplate } from "../upstream/codexTemplates.ts";
import { normalizeTomlText } from "../upstream/textNormalization.ts";
import {
  authApiKey,
  hasOpenAIAccount,
  parseAuth,
} from "../upstream/codexLogin.ts";
import {
  assertOnlyOwnedChanges,
  canonical,
  getPath,
  parseConfig,
  patchPath,
} from "./tomlPatch.ts";
import {
  ConfigError,
  type AuthKind,
  type Provider,
  type Snapshot,
  type TomlObject,
} from "./types.ts";

const FLOOR = [
  "model",
  "review_model",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
];
const ROUTE_KEYS = [
  "model_provider",
  "openai_base_url",
  "base_url",
  "wire_api",
  "experimental_bearer_token",
];
const EXCLUSIVE = [
  "web_search",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_supports_reasoning_summaries",
  "model_verbosity",
];
const NESTED = [
  "agents.default_subagent_model",
  "agents.default_subagent_reasoning_effort",
  "memories.extract_model",
  "memories.consolidation_model",
];
const EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const MAX_TEXT = 2 * 1024 * 1024;

function object(value: unknown): value is TomlObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function bad(code: string, message: string): never {
  throw new ConfigError(code, message);
}

export function authStatus(authText: string | null, config: TomlObject) {
  const parsed = parseAuth(authText);
  const auth = object(parsed.value) ? parsed.value : {};
  const declared = string(config.cli_auth_credentials_store);
  const mode = !declared ? "file" : ["file", "keyring", "auto", "ephemeral"].includes(declared) ? declared : "unknown";
  const fileLogin = hasOpenAIAccount(auth);
  const keyring = mode === "keyring" || mode === "auto";
  return {
    mode,
    fileLogin,
    keyring,
    state: fileLogin
      ? "auth.json 中有登录材料；有效性未验证"
      : keyring
        ? "登录可能保存在钥匙串，目录权限无法读取"
        : "auth.json 中未发现登录材料",
    auth,
    valid: parsed.valid,
  };
}

export interface Projection {
  official: boolean;
  route: TomlObject | null;
  top: TomlObject;
  extra: TomlObject;
  authKind: AuthKind;
  routeKind?: "custom" | "builtin" | "default" | "official";
  builtInId?: string;
  routeAuth?: "bearer" | "env" | "headers" | "none";
}

const RESERVED_IDS = ["openai", "ollama", "lmstudio"];
const BUILTIN_IDS = [...RESERVED_IDS, "amazon-bedrock", "amazon-bedrock-runtime"];
const DORMANT_URL = "http://127.0.0.1:18181/v1";
const PROXY_PLACEHOLDER = "PROXY_MANAGED";
function managedCatalogPointer(value: unknown) {
  return typeof value === "string" && /(?:^|[\\/])cc-switch-model-catalog(?:-[a-f0-9]{1,16})?\.json$/.test(value.trim());
}

function selectedTable(doc: TomlObject): TomlObject | undefined {
  const id = string(doc.model_provider);
  const table =
    id && object(doc.model_providers) ? doc.model_providers[id] : undefined;
  return object(table) ? table : undefined;
}

function validateRelatedFields(doc: TomlObject): void {
  for (const key of [
    ...FLOOR,
    "model_provider",
    ...NESTED.filter((k) => k !== "agents.max_threads"),
  ]) {
    const value = getPath(doc, key.split("."));
    if (value !== undefined && typeof value !== "string")
      bad("invalid_type", `${key} 必须是字符串。`);
  }
  for (const key of [
    "model_reasoning_effort",
    "plan_mode_reasoning_effort",
    "agents.default_subagent_reasoning_effort",
  ]) {
    const value = getPath(doc, key.split("."));
    if (value !== undefined && !EFFORTS.includes(value))
      bad("invalid_effort", `${key} 的推理级别不受支持。`);
  }
  for (const key of [
    "model_context_window",
    "model_auto_compact_token_limit",
  ]) {
    if (
      doc[key] !== undefined &&
      (!Number.isSafeInteger(doc[key]) || doc[key] <= 0)
    )
      bad("invalid_number", `${key} 必须是正整数。`);
  }
  if (
    doc.agents?.max_threads !== undefined &&
    (!Number.isSafeInteger(doc.agents.max_threads) ||
      doc.agents.max_threads < 1)
  )
    bad("invalid_number", "子代理并发上限必须是正整数。");
  if (
    doc.web_search !== undefined &&
    !["disabled", "cached", "live"].includes(doc.web_search)
  )
    bad("invalid_web_search", "web_search 必须是 disabled、cached 或 live。");
  if (
    doc.model_verbosity !== undefined &&
    !["low", "medium", "high"].includes(doc.model_verbosity)
  )
    bad("invalid_verbosity", "model_verbosity 必须是 low、medium 或 high。");
  if (
    doc.model_supports_reasoning_summaries !== undefined &&
    typeof doc.model_supports_reasoning_summaries !== "boolean"
  )
    bad("invalid_type", "model_supports_reasoning_summaries 必须是布尔值。");
  if (doc.model_providers !== undefined && !object(doc.model_providers))
    bad("invalid_table", "model_providers 必须是 TOML 表。");
}

function checkUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return bad(
      "invalid_url",
      "请输入完整的 http:// 或 https:// 服务地址。请包含服务商要求的路径，例如 /v1。",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    baseUrl.length > 4096
  ) {
    bad("invalid_url", "服务地址只支持 HTTP(S)，不能带用户名、密码或 # 片段。");
  }
  return baseUrl.trim();
}

export function projection(
  provider: Provider,
  liveAuth?: ReturnType<typeof authStatus>,
  strict = true,
): Projection {
  const doc = parseConfig(provider.settingsConfig.config, "服务商 TOML");
  const official = provider.authKind === "official";
  const top: TomlObject = {};
  const extra: TomlObject = {};
  for (const key of FLOOR) if (Object.hasOwn(doc, key)) top[key] = doc[key];
  if (doc.model_catalog_json !== undefined && !managedCatalogPointer(doc.model_catalog_json)) top.model_catalog_json = doc.model_catalog_json;
  for (const key of [...EXCLUSIVE, ...NESTED]) {
    const value = getPath(doc, key.split("."));
    if (value !== undefined) extra[key] = value;
  }
  if (official)
    return { official, route: null, top, extra, authKind: "official", routeKind: "official" };
  const selector = string(doc.model_provider).trim();
  let source = selectedTable(doc);
  if (selector && !BUILTIN_IDS.includes(selector) && !source)
    bad("missing_provider_table", "配置选择了 model_provider，但没有对应的 model_providers 表。");
  if (RESERVED_IDS.includes(selector) && source) source = { ...source, wire_api: "responses" };
  if (!source) {
    const legacyUrl = (!selector || selector === "openai") ? string(doc.openai_base_url) || (!selector ? string(doc.base_url) : "") : "";
    if (legacyUrl) source = { base_url: legacyUrl, wire_api: "responses" };
    else if (selector && selector !== "openai" && BUILTIN_IDS.includes(selector))
      return { official: false, route: null, top, extra, authKind: provider.authKind, routeKind: "builtin", builtInId: selector };
    else if (selector === "openai")
      bad("missing_provider_table", "第三方配置需要自定义 model_providers 表；未改道的 openai 应使用官方供应商。");
    else if (!Object.keys(doc).length && authApiKey(provider.settingsConfig.auth))
      bad("missing_provider_table", "第三方供应商缺少 config.toml，无法写入 bearer token。");
    else return { official: false, route: null, top, extra, authKind: provider.authKind, routeKind: "default" };
  }
  const route = { ...source };
  route.name = string(source.name).trim() || selector || "Custom";
  let routeAuth: NonNullable<Projection["routeAuth"]>;
  const headersAuth = (value: unknown) => object(value) && Object.keys(value).some(key => key.toLowerCase() === "authorization");
  if (Object.hasOwn(source, "env_key")) routeAuth = "env";
  else if (Object.hasOwn(source, "auth") || Object.hasOwn(source, "aws") ||
    (!source.requires_openai_auth && (headersAuth(source.http_headers) || headersAuth(source.env_http_headers)))) routeAuth = "headers";
  else {
    const key = (
      string(provider.settingsConfig.auth.OPENAI_API_KEY) ||
      string(source.experimental_bearer_token) ||
      string(doc.experimental_bearer_token)
    ).trim();
    if (strict && !key && (source.requires_openai_auth || (doc.openai_base_url && !doc.model_providers)))
      bad(
        "missing_key",
        "该方案缺少 API Key，而 requires_openai_auth 或 openai_base_url 会回退使用官方登录。请填写 Key 或移除回退指令。",
      );
    if (key) { route.experimental_bearer_token = key; routeAuth = "bearer"; }
    else routeAuth = Object.hasOwn(route, "query_params") || headersAuth(route.http_headers) || headersAuth(route.env_http_headers) ? "headers" : "none";
  }
  if (routeAuth === "bearer" || routeAuth === "env") route.requires_openai_auth = !!liveAuth?.fileLogin;
  else delete route.requires_openai_auth;
  return { official, route, top, extra, authKind: provider.authKind, routeKind: "custom", routeAuth };
}

export function validateProvider(value: unknown): Provider {
  if (!object(value) || !object(value.settingsConfig))
    bad("invalid_profile", "服务商条目必须包含 settingsConfig。");
  const name = string(value.name).trim();
  const config = normalizeTomlText(string(value.settingsConfig.config));
  if (!name || name.length > 100)
    bad("invalid_name", "服务商名称必须为 1–100 个字符。");
  if (config.length > MAX_TEXT) bad("too_large", "服务商配置超过 2 MB 限制。");
  const doc = parseConfig(config, "服务商 TOML");
  const table = selectedTable(doc);
  const apiKey = string(value.settingsConfig.auth?.OPENAI_API_KEY);
  const official =
    value.category === "official" ||
    (value.authKind === undefined &&
      (!doc.model_provider || doc.model_provider === "openai") &&
      !doc.base_url &&
      !doc.openai_base_url &&
      !table);
  let authKind = value.authKind as AuthKind;
  if (!["apiKey", "official", "env", "none"].includes(authKind)) {
    authKind = official ? "official" : table?.env_key ? "env" : "apiKey";
  }
  const result: Provider = {
    ...structuredClone(value),
    id: /^[A-Za-z0-9_-]{1,100}$/.test(string(value.id))
      ? value.id
      : crypto.randomUUID(),
    name,
    settingsConfig: {
      config,
      auth: object(value.settingsConfig.auth)
        ? structuredClone(value.settingsConfig.auth)
        : {},
      ...(object(value.settingsConfig.modelCatalog)
        ? {
            modelCatalog: structuredClone(
              value.settingsConfig.modelCatalog,
            ) as NonNullable<Provider["settingsConfig"]["modelCatalog"]>,
          }
        : {}),
    },
    meta: object(value.meta) ? structuredClone(value.meta) : {},
    websiteUrl: string(value.websiteUrl),
    icon: string(value.icon),
    iconColor: string(value.iconColor),
    historyFilter: value.historyFilter === true,
    category: authKind === "official" ? "official" : "custom",
    authKind,
    notes: string(value.notes).slice(0, 2000),
    createdAt:
      typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  // Remove the obsolete Android-only selector from older saves and imports.
  delete result.meta?.androidLoginPolicy;
  delete result.meta?.preserveCodexOfficialAuthOnSwitch;
  if (result.settingsConfig.modelCatalog) {
    const models = result.settingsConfig.modelCatalog.models;
    if (
      !Array.isArray(models) ||
      models.length > 500 ||
      models.some(
        (m) =>
          !object(m) ||
          typeof m.model !== "string" ||
          !m.model.trim() ||
          m.model.length > 256 ||
          (m.reasoningLevels !== undefined &&
            (!Array.isArray(m.reasoningLevels) ||
              m.reasoningLevels.some((l) => typeof l !== "string"))),
      )
    )
      bad("invalid_catalog", "模型目录必须包含最多 500 个有效模型。");
    modelCatalog(result);
  }
  // Preserve format metadata; protocol compatibility is checked when applying.
  return result;
}

export function newProvider(kind: AuthKind = "apiKey"): Provider {
  const template =
    kind === "official" ? { config: "", auth: {} } : getCodexCustomTemplate();
  return {
    id: crypto.randomUUID(),
    name: "",
    settingsConfig: template,
    category: kind === "official" ? "official" : "custom",
    authKind: kind,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Startup import then official seed, following provider/live.rs and
 * database/dao/providers_seed.rs. Native auth snapshots stay device-encrypted. */
export function readSummary(snapshot: Snapshot) {
  const doc = parseConfig(snapshot.config ?? "");
  const auth = authStatus(snapshot.auth, doc);
  const table = selectedTable(doc);
  return {
    doc,
    auth,
    providerId: string(doc.model_provider) || "openai",
    baseUrl:
      string(table?.base_url) ||
      string(doc.openai_base_url) ||
      string(doc.base_url),
    model: string(doc.model) || "Codex 默认",
    hasBearer: !!string(table?.experimental_bearer_token),
    custom: !!doc.model_provider && doc.model_provider !== "openai",
  };
}

export function matchProvider(
  snapshot: Snapshot,
  provider: Provider,
): "exact" | "related" | "different" {
  try {
    const summary = readSummary(snapshot);
    const expected = projection(provider, summary.auth);
    let currentTable = selectedTable(summary.doc);
    const token = /^http:\/\/127\.0\.0\.1:18181\/r\/([A-Za-z0-9_-]+)$/.exec(
      summary.baseUrl,
    )?.[1];
    const managed = token ? snapshot.filteredRoutes?.[token] : undefined;
    if (
      provider.historyFilter &&
      managed?.providerId === provider.id &&
      currentTable?.experimental_bearer_token === token &&
      currentTable
    ) {
      const originalUrl =
        managed.baseUrl ?? managed.url.replace(/\/responses\/?$/, "");
      currentTable = {
        ...currentTable,
        base_url: originalUrl,
        experimental_bearer_token: managed.apiKey,
      };
      if (currentTable.supports_websockets === false) {
        if (managed.sourceWebsockets !== undefined)
          currentTable.supports_websockets = managed.sourceWebsockets;
        else if (expected.route?.supports_websockets === undefined)
          delete currentTable.supports_websockets;
      }
      if (
        currentTable.http_headers === undefined &&
        managed.sourceHeaders !== undefined
      )
        currentTable.http_headers = managed.sourceHeaders;
      if (
        currentTable.query_params === undefined &&
        managed.sourceQueryParams !== undefined
      )
        currentTable.query_params = managed.sourceQueryParams;
    }
    let matchesRoute: boolean;
    if (expected.official) {
      matchesRoute =
        summary.providerId === "openai" && !summary.baseUrl && !currentTable;
    } else if (expected.routeKind === "builtin") {
      matchesRoute = summary.providerId === expected.builtInId;
    } else if (expected.routeKind === "default") {
      matchesRoute = summary.providerId === "openai" && !summary.baseUrl;
    } else {
      matchesRoute =
        summary.providerId !== "openai" &&
        canonical(currentTable) === canonical(expected.route);
    }
    if (provider.historyFilter && !managed) matchesRoute = false;
    if (!provider.historyFilter && managed) matchesRoute = false;
    const managedCatalog = modelCatalog(provider);
    if (managedCatalog && expected.top.model_catalog_json === undefined) expected.top.model_catalog_json = managedCatalog.name;
    const fields = { ...expected.top, ...expected.extra };
    const matchesFields =
      FLOOR.every(
        (k) => canonical(summary.doc[k]) === canonical(expected.top[k]),
      ) &&
      Object.entries(fields).every(
        ([key, value]) =>
          canonical(getPath(summary.doc, key.split("."))) === canonical(value),
      );
    if (
      matchesRoute &&
      matchesFields &&
      !summary.doc.openai_base_url &&
      !summary.doc.base_url &&
      !summary.doc.wire_api &&
      !summary.doc.experimental_bearer_token
    )
      return "exact";
    if (
      (expected.official && summary.providerId === "openai") ||
      (summary.baseUrl && summary.baseUrl === expected.route?.base_url)
    )
      return "related";
    return "different";
  } catch {
    return "different";
  }
}

export function captureCurrent(snapshot: Snapshot, name: string): Provider {
  const summary = readSummary(snapshot);
  const template: TomlObject = {};
  for (const key of [...FLOOR, ...EXCLUSIVE])
    if (Object.hasOwn(summary.doc, key)) template[key] = summary.doc[key];
  for (const key of NESTED) {
    const value = getPath(summary.doc, key.split("."));
    if (value !== undefined) {
      const [parent, child] = key.split(".");
      template[parent] ??= {};
      template[parent][child] = value;
    }
  }
  let table = selectedTable(summary.doc);
  const routeToken = /^http:\/\/127\.0\.0\.1:18181\/r\/([A-Za-z0-9_-]+)$/.exec(
    summary.baseUrl,
  )?.[1];
  const filteredRoute = routeToken
    ? snapshot.filteredRoutes?.[routeToken]
    : undefined;
  if (routeToken && !filteredRoute)
    bad(
      "missing_filter_route",
      "当前配置指向旧的本机过滤路由，但本地路由记录不可用。请从保存方案恢复，不要把该地址导入为供应商。",
    );
  if (filteredRoute) {
    summary.baseUrl =
      filteredRoute.baseUrl ?? filteredRoute.url.replace(/\/responses\/?$/, "");
    table = {
      ...table,
      base_url: summary.baseUrl,
      experimental_bearer_token: filteredRoute.apiKey,
      ...(filteredRoute.sourceHeaders
        ? { http_headers: filteredRoute.sourceHeaders }
        : {}),
      ...(filteredRoute.sourceQueryParams
        ? { query_params: filteredRoute.sourceQueryParams }
        : {}),
    };
    if (filteredRoute.sourceWebsockets !== undefined)
      table.supports_websockets = filteredRoute.sourceWebsockets;
    else delete table.supports_websockets;
  }
  const official =
    summary.providerId === "openai" && !summary.baseUrl && !table;
  let kind: AuthKind = official ? "official" : "apiKey";
  let key = "";
  if (!official) {
    template.model_provider = "custom";
    template.model_providers = {
      custom: {
        ...(table ?? {}),
        name: string(table?.name) || name,
        base_url: summary.baseUrl,
        wire_api: string(table?.wire_api) || "responses",
      },
    };
    key =
      string(table?.experimental_bearer_token) ||
      string(summary.doc.experimental_bearer_token) ||
      string(summary.auth.auth.OPENAI_API_KEY);
    if (
      !key &&
      !table?.env_key &&
      (table?.requires_openai_auth || summary.doc.openai_base_url)
    )
      bad(
        "missing_key",
        "当前第三方配置依赖已有登录，但目录内没有可迁移的 API Key。请新建方案并填写密钥；不能把它识别成无认证服务。",
      );
    kind = table?.env_key ? "env" : key ? "apiKey" : "none";
    delete template.model_providers.custom.experimental_bearer_token;
  }
  const provider = newProvider(kind);
  provider.name = name;
  provider.historyFilter = !!filteredRoute;
  provider.meta = filteredRoute?.isFullUrl ? { isFullUrl: true } : {};
  provider.settingsConfig = {
    config: stringify(template),
    auth: official ? structuredClone(summary.auth.auth) : key ? { OPENAI_API_KEY: key } : {},
  };
  return validateProvider(provider);
}

/** Form fields write the same TOML shape as upstream; raw edits remain available. */
export function updateFormConfig(
  config: string,
  values: {
    name: string;
    model: string;
    baseUrl: string;
    effort: string;
    envKey?: string;
  },
): string {
  let output = config;
  const doc = parseConfig(config, "服务商 TOML");
  const table = selectedTable(doc) ?? {};
  output = patchPath(output, ["model"], values.model || undefined);
  output = patchPath(
    output,
    ["model_reasoning_effort"],
    values.effort || undefined,
  );
  output = patchPath(output, ["model_provider"], "custom");
  const next: TomlObject = {
    ...table,
    name: values.name || "custom",
    base_url: values.baseUrl,
    wire_api: string(table.wire_api) || "responses",
  };
  if (values.envKey !== undefined) next.env_key = values.envKey;
  output = patchPath(output, ["model_providers", "custom"], next);
  return output;
}

export function formValues(provider: Provider) {
  const doc = parseConfig(provider.settingsConfig.config, "服务商 TOML");
  const table = selectedTable(doc);
  return {
    model: string(doc.model),
    effort: string(doc.model_reasoning_effort),
    baseUrl:
      string(table?.base_url) ||
      string(doc.openai_base_url) ||
      string(doc.base_url),
    apiKey:
      string(provider.settingsConfig.auth.OPENAI_API_KEY) ||
      string(table?.experimental_bearer_token),
    envKey: string(table?.env_key),
  };
}

/** Keep the raw editor and the API Key field consistent. Upstream prioritizes
 * auth.OPENAI_API_KEY, so an explicit raw bearer edit must update that value too.
 */
export function editRawConfig(provider: Provider, config: string): Provider {
  const next = {
    ...provider,
    settingsConfig: { ...provider.settingsConfig, config },
  };
  try {
    const doc = parseConfig(normalizeTomlText(config), "服务商 TOML");
    const table = selectedTable(doc);
    const hasKey =
      object(table) && Object.hasOwn(table, "experimental_bearer_token");
    if (hasKey || Object.hasOwn(doc, "experimental_bearer_token")) {
      next.settingsConfig.auth = {
        OPENAI_API_KEY: string(
          hasKey
            ? table!.experimental_bearer_token
            : doc.experimental_bearer_token,
        ),
      };
    } else {
      const old = parseConfig(provider.settingsConfig.config);
      const oldTable = selectedTable(old);
      if (
        (object(oldTable) &&
          Object.hasOwn(oldTable, "experimental_bearer_token")) ||
        Object.hasOwn(old, "experimental_bearer_token")
      )
        next.settingsConfig.auth = {};
    }
  } catch {
    /* Allow incomplete typing; saving still requires valid TOML. */
  }
  return next;
}

export function redactConfig(config: string): string {
  const doc = parseConfig(config);
  const redact = (value: any, key = ""): any => {
    if (
      /token|secret|password|api.?key|authorization|cookie|http_headers|query_params/i.test(
        key,
      )
    )
      return "[已隐藏]";
    if (typeof value === "string" && /^(base_url|openai_base_url)$/.test(key)) {
      try {
        const url = new URL(value);
        if (url.hostname === "127.0.0.1" && url.port === "18181")
          url.pathname = "/r/[已隐藏]";
        if (url.search) url.search = "[已隐藏]";
        return url.toString();
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((v) => redact(v));
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
      );
    return value;
  };
  return stringify(redact(doc));
}

export function importProviders(text: string): {
  providers: Provider[];
  warnings: string[];
} {
  if (text.length > 8 * MAX_TEXT) bad("too_large", "导入文件超过 16 MB 限制。");
  let input: any;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    bad(
      "invalid_json",
      "导入文件不是有效 JSON。支持安卓版导出和 CC Switch 的 Codex 供应商 JSON；不支持 SQLite 或 SQL 数据库备份。",
    );
  }
  let rows: any;
  if (Array.isArray(input)) rows = input;
  else if (input?.settingsConfig) rows = [input];
  else if (input?.codex?.providers) rows = input.codex.providers;
  else if (input?.providers?.codex)
    rows = input.providers.codex.providers ?? input.providers.codex;
  else rows = input?.providers;
  if (object(rows))
    rows = Object.entries(rows).map(([id, row]) =>
      object(row) ? { ...row, id: row.id ?? id } : row,
    );
  if (!Array.isArray(rows) || !rows.length || rows.length > 200)
    bad("invalid_import", "文件需包含 1–200 个 Codex 供应商。现有方案未改变。");
  const warnings: string[] = [];
  const providers = rows.map((row, i) => {
    try {
      if (row?.settingsConfig?.auth?.tokens)
        warnings.push(
          `第 ${i + 1} 项：认证材料仅作为方案保存，没有修改或切换 Codex 的 OAuth 登录。`,
        );
      if (row?.historyFilter)
        warnings.push(
          `第 ${i + 1} 项：包含历史过滤设置；应用后需要 CC Switch 持续后台运行。`,
        );
      const item = validateProvider(row);
      // Always create new local identities; import cannot silently replace a key.
      item.id = crypto.randomUUID();
      return item;
    } catch (error) {
      throw new ConfigError(
        "invalid_import_item",
        `第 ${i + 1} 项：${error instanceof Error ? error.message : "格式不正确"} 整次导入已停止。`,
      );
    }
  });
  return { providers, warnings };
}

export function exportProviders(
  providers: Provider[],
  includeKeys: boolean,
): string {
  const rows = providers.map((p) => {
    if (includeKeys) return p;
    const doc = parseConfig(p.settingsConfig.config);
    // Remove arbitrary header/query/auth material, not just OPENAI_API_KEY.
    const clean = (value: any, key = ""): any => {
      if (
        /token|secret|password|api.?key|authorization|cookie|http_headers|query_params|^auth$|^aws$/i.test(
          key,
        )
      )
        return undefined;
      if (
        typeof value === "string" &&
        /^(base_url|openai_base_url)$/.test(key)
      ) {
        try {
          const url = new URL(value);
          url.search = "";
          if (url.hostname === "127.0.0.1" && url.port === "18181")
            url.pathname = "/r/REAPPLY_REQUIRED";
          return url.toString();
        } catch {
          return value;
        }
      }
      if (Array.isArray(value))
        return value.map((v) => clean(v)).filter((v) => v !== undefined);
      if (value && typeof value === "object" && !(value instanceof Date))
        return Object.fromEntries(
          Object.entries(value)
            .map(([k, v]) => [k, clean(v, k)])
            .filter(([, v]) => v !== undefined),
        );
      return value;
    };
    const safeMeta = { ...(p.meta ?? {}) };
    // Arbitrary overrides may carry credentials under innocent names.
    delete safeMeta.localProxyRequestOverrides;
    delete safeMeta.customEndpoints;
    delete safeMeta.custom_endpoints;
    return {
      ...p,
      meta: clean(safeMeta),
      settingsConfig: {
        ...p.settingsConfig,
        auth: {},
        config: stringify(clean(doc)),
      },
      notes: "",
      websiteUrl: "",
    };
  });
  return (
    JSON.stringify(
      {
        schema: "cc-switch-android/v1",
        exportedAt: new Date().toISOString(),
        keysIncluded: includeKeys,
        providers: rows,
      },
      null,
      2,
    ) + "\n"
  );
}
