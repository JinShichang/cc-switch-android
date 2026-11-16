import { projection } from "./codex.ts";
import { parseConfig, patchPath } from "./tomlPatch.ts";
import { ConfigError, type Provider } from "./types.ts";

/** Keep remote credentials/parameters out of Codex's local relay transport. */
export function filterRouteSettings(provider: Provider) {
  if (
    provider.authKind !== "apiKey" ||
    (provider.meta?.apiFormat &&
      !["responses", "openai_responses"].includes(provider.meta.apiFormat))
  )
    throw new ConfigError(
      "filter_format",
      "历史过滤仅支持 API Key 认证的原生 Responses 方案。",
    );
  const route = projection(provider).route!;
  if (route.env_http_headers && Object.keys(route.env_http_headers).length)
    throw new ConfigError(
      "filter_external_headers",
      "此方案的请求头依赖 Codex 进程环境变量，本机中转无法读取。请改为静态请求头后启用过滤，或使用直连。",
    );
  const url = new URL(route.base_url);
  if (!provider.meta?.isFullUrl)
    url.pathname = url.pathname.replace(/\/+$/, "") + "/responses";
  for (const [key, value] of Object.entries(route.query_params ?? {}))
    url.searchParams.set(key, String(value));
  const extra = provider.meta?.localProxyRequestOverrides ?? {};
  for (const key of Object.keys(extra.body ?? {}))
    if (
      [
        "stream",
        "input",
        "previous_response_id",
        "conversation",
        "context_management",
      ].includes(key)
    )
      throw new ConfigError(
        "unsafe_override",
        "过滤路由不能覆盖历史或协议字段：" + key,
      );
  return {
    url: url.toString(),
    baseUrl: route.base_url,
    isFullUrl: provider.meta?.isFullUrl === true,
    apiKey: route.experimental_bearer_token,
    providerId: provider.id,
    sourceHeaders: route.http_headers,
    sourceQueryParams: route.query_params,
    sourceWebsockets: route.supports_websockets,
    headers: {
      ...route.http_headers,
      ...extra.headers,
      ...(provider.meta?.customUserAgent
        ? { "User-Agent": provider.meta.customUserAgent }
        : {}),
    },
    body: extra.body ?? {},
  };
}

export function withLocalFilterRoute(
  provider: Provider,
  prepared: { baseUrl: string; token: string },
): Provider {
  const source = parseConfig(provider.settingsConfig.config);
  const table =
    typeof source.model_provider === "string"
      ? source.model_provider
      : "custom";
  let config = provider.settingsConfig.config;
  config = patchPath(config, ["model_provider"], table);
  if (!source.model_providers?.[table])
    config = patchPath(
      config,
      ["model_providers", table],
      projection(provider).route!,
    );
  for (const key of ["http_headers", "env_http_headers", "query_params"])
    config = patchPath(config, ["model_providers", table, key], undefined);
  config = patchPath(
    config,
    ["model_providers", table, "base_url"],
    prepared.baseUrl,
  );
  config = patchPath(
    config,
    ["model_providers", table, "experimental_bearer_token"],
    prepared.token,
  );
  config = patchPath(
    config,
    ["model_providers", table, "supports_websockets"],
    false,
  );
  return {
    ...provider,
    settingsConfig: {
      ...provider.settingsConfig,
      config,
      auth: { OPENAI_API_KEY: prepared.token },
    },
  };
}
