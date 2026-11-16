import type { AppState } from "./core/types.ts";

declare global {
  interface Window {
    CCSwitch?: {
      postMessage: (message: string) => void;
      onmessage: ((event: { data: string }) => void) | null;
    };
    __ccswitchBack?: () => boolean;
  }
}

export const isNative = !!window.CCSwitch;
let counter = 0;
const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
if (window.CCSwitch) {
  window.CCSwitch.onmessage = event => {
    const response = JSON.parse(event.data);
    const pending = waiting.get(response.id);
    if (!pending) return;
    waiting.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
  };
}

let preview: AppState = {
  providers: [], backups: [], directory: null, pendingRecovery: false,
  settings: { zoom: 200, theme: "system" }, native: false,
};

/** Browser preview deliberately has no fake SAF directory or successful writes.
 * Its draft providers are memory-only, never WebView localStorage credentials.
 */
export async function invoke<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!window.CCSwitch) {
    if (method === "bootstrap") return structuredClone(preview) as T;
    if (method === "saveProviders") {
      preview = { ...preview, providers: args.providers as AppState["providers"] };
      return structuredClone(preview) as T;
    }
    if (method === "settings") {
      preview = { ...preview, settings: args as AppState["settings"] };
      return structuredClone(preview) as T;
    }
    throw new Error("浏览器仅用于界面预览。目录授权、真实文件读写和加密持久保存需要安装 Android APK。");
  }
  const id = `request-${++counter}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    try { window.CCSwitch!.postMessage(JSON.stringify({ id, method, args })); }
    catch (error) { waiting.delete(id); reject(error); }
  });
}
