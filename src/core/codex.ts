// Port of CC Switch's CodexProjection / floor / requires_openai_auth rules.
// Upstream: fc3eb797c72e054d554eea6a2e7a8b93933c6ac5 (MIT, Jason Young).
// Android intentionally leaves auth.json and the guest/host keyring untouched.
import { modelCatalog } from "./modelCatalog.ts";
import { stringify } from "smol-toml";
import { getCodexCustomTemplate } from "../upstream/codexTemplates.ts";
import { normalizeTomlText } from "../upstream/textNormalization.ts";
import {
  assertOnlyOwnedChanges,
  canonical,
  getPath,
  parseConfig,
  patchPath,
} from "./tomlPatch.ts";
import {
  ConfigError,
  type ApplyPlan,
  type AuthKind,
  type Ownership,
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
  "model_catalog_json",
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
  let auth: TomlObject = {};
  if (authText !== null) {
    try {
      auth = JSON.parse(authText.replace(/^\uFEFF/, ""));
      if (!object(auth)) throw new Error();
    } catch {
      bad(
        "invalid_auth",
        "auth.json 格式错误。已停止应用配置，原文件保持不变；请先在 Codex 中检查认证文件。",
      );
    }
  }
  const mode = string(config.cli_auth_credentials_store) || "file";
  const fileLogin = !!(
    string(auth.OPENAI_API_KEY).trim() ||
    string(auth.tokens?.access_token).trim() ||
    string(auth.tokens?.refresh_token).trim()
  );
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
  };
}

export interface Projection {
  official: boolean;
  route: TomlObject | null;
  top: TomlObject;
  extra: TomlObject;
  authKind: AuthKind;
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
  validateRelatedFields(doc);
  const official = provider.authKind === "official";
  const top: TomlObject = {};
  const extra: TomlObject = {};
  for (const key of FLOOR) if (Object.hasOwn(doc, key)) top[key] = doc[key];
  for (const key of [...EXCLUSIVE, ...NESTED]) {
    const value = getPath(doc, key.split("."));
    if (value !== undefined) extra[key] = value;
  }
  if (official)
    return { official, route: null, top, extra, authKind: "official" };
  if (strict && !string(doc.model).trim())
    bad("missing_model", "请填写模型名称后再应用。");
  let source = selectedTable(doc);
  if (!source) {
    const legacyUrl = string(doc.openai_base_url) || string(doc.base_url);
    if (legacyUrl) source = { base_url: legacyUrl, wire_api: "responses" };
    else
      bad(
        "missing_provider_table",
        "配置中找不到已选服务商表，请检查 model_provider 和 model_providers。",
      );
  }
  const route = { ...source };
  route.name = string(source.name) || provider.name;
  route.wire_api = string(source.wire_api) || "responses";
  if (route.wire_api !== "responses")
    bad(
      "proxy_required",
      "此配置需要 Chat Completions/Anthropic 协议转换。首版只支持原生 Responses 服务，尚未包含上游本地代理。",
    );
  if (source.auth || source.aws)
    bad(
      "external_auth",
      "此配置依赖外部认证命令或 AWS 凭据。首版无法管理该认证来源，请使用 API Key、环境变量或已有官方登录。",
    );
  const base = string(source.base_url).trim();
  if (strict || base) route.base_url = checkUrl(base);
  else route.base_url = "";
  for (const key of [
    "request_max_retries",
    "stream_max_retries",
    "stream_idle_timeout_ms",
  ]) {
    if (
      route[key] !== undefined &&
      (!Number.isSafeInteger(route[key]) || route[key] < 0)
    )
      bad("invalid_number", `${key} 必须是非负整数。`);
  }
  if (provider.authKind === "apiKey") {
    const key = (
      string(provider.settingsConfig.auth.OPENAI_API_KEY) ||
      string(source.experimental_bearer_token) ||
      string(doc.experimental_bearer_token)
    ).trim();
    if (strict && !key)
      bad(
        "missing_key",
        "该方案缺少 API Key。请编辑后再应用；不会回退使用 Codex 的官方登录凭据。",
      );
    if (/[\x00-\x1f\x7f]/.test(key))
      bad("invalid_key", "API Key 不能包含换行或控制字符。");
    delete route.env_key;
    delete route.env_key_instructions;
    route.experimental_bearer_token = key;
  } else if (provider.authKind === "env") {
    if (strict && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(string(route.env_key)))
      bad(
        "invalid_env_key",
        "请填写 Codex 进程已有的环境变量名称，例如 CODEX_API_KEY。",
      );
    delete route.experimental_bearer_token;
  } else {
    delete route.env_key;
    delete route.env_key_instructions;
    delete route.experimental_bearer_token;
    if (
      object(route.http_headers) &&
      Object.keys(route.http_headers).some(
        (k) => k.toLowerCase() === "authorization",
      )
    )
      bad(
        "auth_kind_mismatch",
        "该方案声明了 Authorization 请求头，不能按无认证方案应用。请改为 API Key 配置。",
      );
  }
  const ownCredential =
    provider.authKind === "apiKey" || provider.authKind === "env";
  route.requires_openai_auth = ownCredential && !!liveAuth?.fileLogin;
  return { official, route, top, extra, authKind: provider.authKind };
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
  projection(result, undefined, false);
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
 * database/dao/providers_seed.rs. Authentication tokens stay with Codex. */
export function initialProviderSetup(
  state: Pick<
    import("./types.ts").AppState,
    "providers" | "providerInitialization"
  >,
  snapshot: Snapshot,
) {
  if (state.providerInitialization === 1)
    return {
      additions: [] as Provider[],
      warnings: [] as string[],
      importedId: undefined as string | undefined,
    };
  const additions: Provider[] = [],
    warnings: string[] = [];
  let importedId: string | undefined;
  if (
    !state.providers.length &&
    (snapshot.config !== null || snapshot.auth !== null)
  ) {
    try {
      const source = snapshot.config ?? "";
      const doc = parseConfig(source);
      const route = selectedTable(doc);
      if (
        source.includes("PROXY_MANAGED") ||
        /^http:\/\/127\.0\.0\.1:18181\/r\//.test(string(route?.base_url))
      )
        bad(
          "proxy_import",
          "当前配置由本机中转接管，不能把中转地址导入为 default。请先恢复原供应商配置。",
        );
      const imported = captureCurrent(snapshot, "default");
      imported.id = "default";
      // Preserve the entire original TOML in the imported row, just like desktop.
      // The editor projection and switch retain ownership of unrelated live keys.
      imported.settingsConfig.config = source;
      additions.push(validateProvider(imported));
      importedId = imported.id;
    } catch (error) {
      warnings.push(
        "未自动导入 default：" +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (!state.providers.some((p) => p.id === "codex-official")) {
    const official = newProvider("official");
    official.id = "codex-official";
    official.name = "OpenAI Official";
    official.icon = "openai";
    official.iconColor = "#00A67E";
    official.websiteUrl = "https://chatgpt.com/codex";
    additions.push(official);
  }
  return { additions, warnings, importedId };
}

export function readSummary(snapshot: Snapshot) {
  const doc = parseConfig(snapshot.config ?? "");
  validateRelatedFields(doc);
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

export function planApply(snapshot: Snapshot, provider: Provider): ApplyPlan {
  if (
    provider.meta?.apiFormat &&
    !["responses", "openai_responses"].includes(provider.meta.apiFormat)
  )
    bad(
      "proxy_required",
      "此配置需要协议转换；Android 本机过滤服务目前只支持原生 Responses，已保留设置但未应用。",
    );
  const source = snapshot.config ?? "";
  const summary = readSummary(snapshot);
  const target = projection(provider, summary.auth);
  if (!provider.historyFilter && provider.meta?.isFullUrl)
    bad(
      "proxy_required",
      "完整 URL 需要本机路由；请启用历史过滤中转，或关闭完整 URL 并填写基础地址。",
    );
  const catalog = modelCatalog(provider);
  if (catalog) target.extra.model_catalog_json = catalog.name;
  const warnings: string[] = [];
  if (
    !provider.historyFilter &&
    (provider.meta?.customUserAgent ||
      Object.keys(provider.meta?.localProxyRequestOverrides?.headers ?? {})
        .length ||
      Object.keys(provider.meta?.localProxyRequestOverrides?.body ?? {}).length)
  )
    warnings.push(
      "当前为直连：本地代理 User-Agent 与请求覆盖仅保存于方案，未应用到请求。",
    );
  if (provider.meta?.autoSelect)
    warnings.push(
      "Android 未启用后台自动测速切换，请使用管理与测速手动选择地址。",
    );
  if (summary.auth.keyring)
    warnings.push("钥匙串状态无法通过 SAF 确认；没有改动钥匙串或 auth.json。");
  if (target.official && !summary.auth.fileLogin)
    warnings.push(
      "仅切回 Codex 官方配置。登录状态需要在 Codex 内确认，必要时重新登录。",
    );
  if (provider.authKind === "env")
    warnings.push(
      "CC Switch 无法设置或验证 Codex 进程的环境变量，请在 Codex 宿主确认该变量已注入。",
    );
  if (provider.historyFilter)
    warnings.push(
      "此方案将通过 CC Switch 本机中转。保持 CC Switch 后台运行；退出、强制停止或端口不可达会中断请求。远程加密压缩不可用。",
    );
  if (target.route?.base_url?.startsWith("http:"))
    warnings.push(
      "此服务使用 HTTP 明文连接；请确认这是你预期的本地或受信任服务。",
    );
  if (summary.doc.profile)
    warnings.push(
      "当前配置选择了 profile；配置档、项目配置或启动参数可能覆盖本次设置，请在 Codex 中核对最终生效值。",
    );
  if (catalog)
    warnings.push(
      "已生成所选模型目录，需完整重启 Codex 才能重新加载模型列表。",
    );
  else if (summary.doc.model_catalog_json)
    warnings.push("当前没有配置模型列表，将保留非本应用管理的模型目录指针。");
  // Codex rejects reserved provider tables. Leave them intact and report the
  // incompatibility instead of deleting a user's unrelated provider definitions.
  if (
    ["openai", "ollama", "lmstudio"].some(
      (id) => summary.doc.model_providers?.[id],
    )
  ) {
    bad(
      "reserved_table",
      "当前文件含 Codex 保留名称的 model_providers 表（openai/ollama/lmstudio）。请先在 Codex 中迁移该旧配置；本次未覆盖这些表。",
    );
  }
  const applied = patchProviderProjection(snapshot, target);
  return {
    ...applied,
    warnings,
    ...(catalog ? { catalog } : {}),
  };
}

/** Shared by real switches and the read-only editor view, as in upstream's
 * codex_editor::view / CodexProjection. Opening an editor never writes files. */
function patchProviderProjection(snapshot: Snapshot, target: Projection) {
  const source = snapshot.config ?? "";
  const summary = { doc: parseConfig(source) };
  const changedFields: string[] = [];
  const paths: string[][] = [];
  let output = source;
  const patch = (path: string[], value: any) => {
    const previous = getPath(parseConfig(output), path);
    if (canonical(previous) !== canonical(value))
      changedFields.push(path.join("."));
    paths.push(path);
    output = patchPath(output, path, value);
  };
  for (const key of ROUTE_KEYS)
    patch(
      [key],
      key === "model_provider" && !target.official ? "custom" : undefined,
    );
  for (const key of FLOOR) patch([key], target.top[key]);
  patch(["model_providers", "custom"], target.route ?? undefined);
  // Removed upstream in Codex 0.167; it is a retired routing field, not a user
  // setting. Leaving it makes the current Codex report an unrecognized setting.
  if (Object.hasOwn(summary.doc, "disable_response_storage"))
    patch(["disable_response_storage"], undefined);
  const ownership: Ownership = { written: {}, prior: {} };
  const old = snapshot.ownership;
  for (const key of [...EXCLUSIVE, ...NESTED]) {
    const path = key.split(".");
    const current = getPath(parseConfig(output), path);
    if (
      old?.written &&
      Object.hasOwn(old.written, key) &&
      canonical(current) === canonical(old.written[key])
    ) {
      patch(path, old.prior?.[key]);
    }
    if (Object.hasOwn(target.extra, key)) {
      const prior = getPath(parseConfig(output), path);
      if (prior !== undefined) ownership.prior[key] = prior;
      ownership.written[key] = target.extra[key];
      patch(path, target.extra[key]);
    }
  }
  assertOnlyOwnedChanges(source, output, paths);
  return {
    config: output,
    ownership,
    changedFields: [...new Set(changedFields)],
  };
}

/** Adapted from services/provider/codex_editor.rs::view (MIT, Jason Young).
 * Project the row over the current file, not over a fabricated mobile template.
 * Incomplete drafts can be displayed; strict validation stays in planApply. */
export function providerEditorView(
  snapshot: Snapshot,
  provider: Provider,
): Provider {
  const current = parseConfig(snapshot.config ?? "");
  const target = projection(
    provider,
    authStatus(snapshot.auth, current),
    false,
  );
  if (target.route) {
    if (!target.route.base_url) delete target.route.base_url;
    // The provider's Key already has its own input. Never copy a live route Key
    // into a new provider, and keep empty/pending credentials out of the TOML.
    const rowKey = string(provider.settingsConfig.auth.OPENAI_API_KEY);
    const token = string(target.route.experimental_bearer_token);
    if (!token || (rowKey && token === rowKey))
      delete target.route.experimental_bearer_token;
  }
  return {
    ...provider,
    settingsConfig: {
      ...provider.settingsConfig,
      config: patchProviderProjection(snapshot, target).config,
    },
  };
}

/** Same comparison granularity as upstream codex_editor::entries: root
 * values, each child of a global table, and nonselected provider tables. */
function editorGlobalPaths(
  docs: TomlObject[],
  routes: Set<string>,
): string[][] {
  const paths = new Map<string, string[]>();
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      if (
        [
          ...FLOOR,
          ...EXCLUSIVE,
          ...ROUTE_KEYS,
          "disable_response_storage",
        ].includes(key)
      )
        continue;
      if (object(value)) {
        for (const child of Object.keys(value)) {
          if (key === "model_providers" && routes.has(child)) continue;
          if (NESTED.includes(key + "." + child)) continue;
          const path = [key, child];
          paths.set(JSON.stringify(path), path);
        }
      } else paths.set(JSON.stringify([key]), [key]);
    }
  }
  const all = [...paths.values()];
  return all.filter(
    (path) =>
      !all.some(
        (parent) =>
          parent.length < path.length &&
          parent.every((part, i) => part === path[i]),
      ),
  );
}

function editorRoutes(...docs: TomlObject[]) {
  return new Set(["custom", ...docs.map((doc) => string(doc.model_provider))]);
}

/** Keep global settings out of new provider rows. Global edits are saved through
 * the version-checked SAF transaction, matching upstream's editor save split. */
export function providerConfigFromEditor(
  provider: Provider,
  base: string,
  edited: string,
): string {
  const stored = parseConfig(provider.settingsConfig.config);
  const before = parseConfig(base);
  const after = parseConfig(edited);
  let output = edited;
  for (const path of editorGlobalPaths(
    [stored, before, after],
    editorRoutes(stored, before, after),
  ))
    output = patchPath(output, path, getPath(stored, path));
  // Optional values inherited unchanged from live are global, not row-owned.
  for (const key of [...EXCLUSIVE, ...NESTED]) {
    const path = key.split(".");
    if (
      getPath(stored, path) === undefined &&
      canonical(getPath(before, path)) === canonical(getPath(after, path))
    )
      output = patchPath(output, path, undefined);
  }
  const prune = (doc: TomlObject, path: string[] = []) => {
    for (const [key, value] of Object.entries(doc)) {
      const next = [...path, key];
      if (!object(value)) continue;
      prune(value, next);
      if (
        !Object.keys(getPath(parseConfig(output), next) ?? {}).length &&
        getPath(stored, next) === undefined
      )
        output = patchPath(output, next, undefined);
    }
  };
  prune(parseConfig(output));
  return output;
}

/** Adapted from upstream editor_toml::TomlEdits: only user-edited global keys
 * are merged; an independently changed value is refused without exposing it. */
export function planProviderEditorGlobals(
  provider: Provider,
  base: string,
  edited: string,
  current: string,
): { config: string; changedFields: string[] } {
  const stored = parseConfig(provider.settingsConfig.config);
  const before = parseConfig(base);
  const after = parseConfig(edited);
  const live = parseConfig(current);
  const paths = editorGlobalPaths(
    [before, after],
    editorRoutes(stored, before, after),
  );
  // Deleting a live-only compatibility value is a deliberate global edit.
  for (const key of EXCLUSIVE) {
    if (
      !Object.hasOwn(stored, key) &&
      Object.hasOwn(before, key) &&
      !Object.hasOwn(after, key)
    )
      paths.push([key]);
  }
  let output = current;
  const changedFields: string[] = [];
  for (const path of paths) {
    const oldValue = getPath(before, path);
    const newValue = getPath(after, path);
    if (canonical(oldValue) === canonical(newValue)) continue;
    const liveValue = getPath(live, path);
    if (
      canonical(liveValue) !== canonical(oldValue) &&
      canonical(liveValue) !== canonical(newValue)
    )
      bad(
        "editor_conflict",
        "编辑期间 Codex 已修改 " +
          path.join(".") +
          "。请取消并重新打开，核对后再保存；没有覆盖外部修改。",
      );
    if (canonical(liveValue) !== canonical(newValue)) {
      output = patchPath(output, path, newValue);
      changedFields.push(path.join("."));
    }
  }
  assertOnlyOwnedChanges(current, output, paths);
  return { config: output, changedFields };
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
    } else {
      matchesRoute =
        summary.providerId !== "openai" &&
        canonical(currentTable) === canonical(expected.route);
    }
    if (provider.historyFilter && !managed) matchesRoute = false;
    if (!provider.historyFilter && managed) matchesRoute = false;
    const managedCatalog = modelCatalog(provider);
    if (managedCatalog) expected.extra.model_catalog_json = managedCatalog.name;
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
    auth: key ? { OPENAI_API_KEY: key } : {},
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
