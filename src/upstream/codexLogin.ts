// Faithful port of services/provider/codex_login.rs and its codex_config helpers.
// CC Switch 4.0.40, aaf6ee963927ea0173e53ac00c1919840948ab22.
// MIT License, Copyright (c) 2025 Jason Young. See LICENSE.
// SAF and encrypted device storage are handled separately by the Android bridge.
import { canonical } from "../core/tomlPatch.ts";
import { ConfigError } from "../core/types.ts";

type Auth = Record<string, any>;
export interface LoginStash {
  logins: Record<string, Auth>;
  last?: string;
  version: number;
  initialized?: boolean;
}
export type AuthTarget =
  | { kind: "thirdParty" }
  | { kind: "proxyThirdParty"; restoreLast: boolean }
  | { kind: "official"; auth: Auth };

function object(value: unknown): value is Auth {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function present(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return !!value.trim();
  if (Array.isArray(value)) return !!value.length;
  if (object(value)) return !!Object.keys(value).length;
  return true;
}
export function authApiKey(auth: unknown): string {
  return object(auth) ? text(auth.OPENAI_API_KEY) : "";
}
export function hasLoginMaterial(auth: unknown): auth is Auth {
  return object(auth) && Object.entries(auth).some(([key, value]) =>
    key !== "auth_mode" && (key === "OPENAI_API_KEY" ? !!text(value) : present(value)),
  );
}
export function hasCredentialLogin(auth: unknown): auth is Auth {
  return object(auth) && (
    ["personal_access_token", "agent_identity", "bedrock_api_key"].some(key => present(auth[key])) ||
    (object(auth.tokens) && ["id_token", "access_token", "refresh_token"].some(key => present(auth.tokens[key])))
  );
}
export function hasOpenAIAccount(auth: unknown): boolean {
  if (!object(auth)) return false;
  const explicit = auth.auth_mode !== undefined && auth.auth_mode !== null;
  const mode = explicit ? auth.auth_mode :
    auth.personal_access_token != null ? "personalAccessToken" :
    auth.bedrock_api_key != null ? "bedrockApiKey" :
    auth.bedrock_access_keys != null ? "bedrockAccessKeys" :
    auth.OPENAI_API_KEY != null ? "apikey" : "chatgpt";
  switch (mode) {
    case "apikey": return !!authApiKey(auth);
    case "personalAccessToken": return present(auth.personal_access_token);
    case "agentIdentity": return present(auth.agent_identity);
    case "chatgpt": case "chatgptAuthTokens":
      return object(auth.tokens) && ["id_token", "access_token", "refresh_token"].some(key => present(auth.tokens[key]));
    default: return false;
  }
}
export function parseAuth(text: string | null): { value: unknown; valid: boolean } {
  if (text === null) return { value: undefined, valid: true };
  try { return { value: JSON.parse(text.replace(/^\uFEFF/, "")), valid: true }; }
  catch { return { value: null, valid: false }; }
}
function jwtPart(token: string, index: number): Auth | undefined {
  try {
    const segment = token.split(".")[index];
    if (!segment || !/^[A-Za-z0-9_-]+={0,2}$/.test(segment)) return;
    const raw = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
    return object(decoded) ? decoded : undefined;
  } catch { return; }
}
export function loginIdentity(auth: Auth): string {
  const token = text(auth.tokens?.id_token);
  const user = token.split(".").length === 3 && text(jwtPart(token, 0)?.alg) ? text(jwtPart(token, 1)?.sub) : "";
  const account = text(auth.tokens?.account_id);
  return user ? "sub:" + user + (account ? "|account:" + account : "") :
    account ? "account:" + account : authApiKey(auth) ? "api-key" : "unknown";
}
function oauthIdentity(auth: unknown): string | undefined {
  return hasCredentialLogin(auth) ? loginIdentity(auth) : undefined;
}
function userIdentity(auth: Auth) {
  const id = loginIdentity(auth);
  return id.startsWith("sub:") ? id.split("|account:")[0] : undefined;
}
function loadStash(input: LoginStash | undefined, rows: Auth[], live: unknown): LoginStash {
  if (!input) {
    const stash: LoginStash = { logins: {}, version: 1, initialized: false };
    for (const row of rows) {
      const id = oauthIdentity(row);
      if (id && !Object.hasOwn(stash.logins, id)) stash.logins[id] = structuredClone(row);
    }
    return stash;
  }
  if (!object(input.logins) || Object.values(input.logins).some(auth => !object(auth)))
    throw new ConfigError("invalid_login_stash", "本机登录暂存无法解析，已停止切换，未修改 Codex 文件。");
  const stash = structuredClone(input);
  if (stash.version >= 1) return { ...stash, initialized: true };
  const last = stash.last && stash.logins[stash.last] ? loginIdentity(stash.logins[stash.last]) : undefined;
  const logins: Record<string, Auth> = {};
  for (const auth of Object.values(stash.logins)) logins[loginIdentity(auth)] = auth;
  const native = hasCredentialLogin(live) ? live : undefined;
  const users = new Set([...Object.values(logins), ...(native ? [native] : [])].map(userIdentity).filter(Boolean));
  const liveId = native ? loginIdentity(native) : undefined;
  for (const row of rows) {
    const id = oauthIdentity(row);
    if (id && users.has(userIdentity(row)) && liveId !== id && !Object.hasOwn(logins, id)) logins[id] = structuredClone(row);
  }
  return { logins, last, version: 1, initialized: false };
}

/** No preserve-login switch: direct third-party uses the upstream default false.
 * Proxy takeover retains native login, as required by upstream AuthTarget. */
export function planCodexLogin(input: {
  live: unknown;
  target: AuthTarget;
  stash?: LoginStash;
  officialRows?: Auth[];
  thirdPartyKeys?: string[];
  leavingOfficial?: Auth;
  now?: number;
}) {
  const original = loadStash(input.stash, input.officialRows ?? [], input.live);
  const stash = structuredClone(original);
  const live = input.live;
  const residue = object(live) && !hasCredentialLogin(live) && !!authApiKey(live) && (input.thirdPartyKeys ?? []).includes(authApiKey(live));
  const native = !residue && hasLoginMaterial(live) ? live : undefined;
  const take = (id: string | undefined): Auth | undefined => {
    if (!id || !Object.hasOwn(stash.logins, id)) return;
    const auth = stash.logins[id]; delete stash.logins[id];
    if (stash.last === id) delete stash.last;
    return auth;
  };
  const put = (auth: Auth) => { const id = loginIdentity(auth); stash.logins[id] = structuredClone(auth); stash.last = id; };
  if (input.leavingOfficial && !native) {
    take(oauthIdentity(input.leavingOfficial) ?? stash.last);
    delete stash.last;
  }
  let auth: Auth | null | undefined;
  switch (input.target.kind) {
    case "thirdParty":
      if (native) put(native);
      if (live !== undefined) auth = null;
      break;
    case "proxyThirdParty": {
      const last = stash.last && stash.logins[stash.last];
      const exp = last ? jwtPart(text(last.tokens?.access_token), 1)?.exp : undefined;
      const expired = Number.isInteger(exp) && exp <= (input.now ?? Math.floor(Date.now() / 1000));
      if (input.target.restoreLast && !native && last && !expired) auth = take(stash.last);
      break;
    }
    case "official": {
      const row = input.target.auth;
      if (authApiKey(row) && !hasCredentialLogin(row)) {
        if (native && canonical(native) !== canonical(row)) put(native);
        auth = structuredClone(row);
        break;
      }
      const wanted = oauthIdentity(row);
      if (native) {
        if (wanted && loginIdentity(native) !== wanted) {
          const saved = take(wanted);
          if (saved) { put(native); auth = saved; }
        }
      } else {
        const saved = take(wanted ?? stash.last);
        if (saved) auth = saved;
        else if (residue) auth = null;
      }
      break;
    }
  }
  const after = auth === undefined ? live : auth;
  const changed = canonical(stash) !== canonical(original) || !original.initialized;
  stash.initialized = true;
  return {
    auth,
    stash: changed ? stash : undefined,
    loginOnDisk: hasOpenAIAccount(auth === undefined ? native : after),
  };
}

export function routeLoginState(mode: string, target: AuthTarget, loginOnDisk: boolean) {
  if (mode === "file") return loginOnDisk;
  if (mode === "ephemeral") return false;
  // Same fallback as codex_direct::run_with_edits when the keyring is unknown.
  return target.kind !== "thirdParty";
}
