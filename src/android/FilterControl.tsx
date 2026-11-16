import { useEffect, useState } from "react";
import { invoke, isNative } from "../bridge";
import type { Provider } from "../core/types";
import {
  filterRouteSettings,
  withLocalFilterRoute,
} from "../core/filterRoute.ts";
export async function prepareFilteredProvider(
  provider: Provider,
): Promise<Provider> {
  if (!provider.historyFilter) return provider;
  const prepared = await invoke<{ baseUrl: string; token: string }>(
    "prepareFilter",
    filterRouteSettings(provider),
  );
  return withLocalFilterRoute(provider, prepared);
}
export function FilterStatusPanel() {
  const [status, setStatus] = useState<any>(null),
    [error, setError] = useState("");
  const refresh = () => {
    if (isNative)
      invoke("filterStatus")
        .then(setStatus)
        .catch((e) => setError(e.message));
  };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="filter-status rounded-panel border p-3 space-y-2">
      <strong>历史推理与ID过滤（解决不同源错误）</strong>
      <p>
        {status?.running
          ? "本机中转运行中"
          : "中转未运行 · 已应用过滤方案时，Codex 请求将无法连接"}
      </p>
      {status?.running && (
        <p>
          已过滤 {status.filteredRequests} 次 · 推理项{" "}
          {status.removedReasoningItems} · ID {status.removedItemIds} · 拦截{" "}
          {status.blockedRequests}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="button"
          disabled={!isNative}
          onClick={() =>
            invoke("startFilter")
              .then(refresh)
              .catch((e) => setError(e.message))
          }
        >
          恢复中转
        </button>
        <button
          className="button"
          disabled={!isNative}
          onClick={() =>
            invoke("openBatterySettings").catch((e) => setError(e.message))
          }
        >
          后台运行设置
        </button>
      </div>
      {!status?.running && (
        <details>
          <summary className="text-caption text-fg-2">历史中转路由</summary>
          <p className="text-caption text-fg-2">
            清理会使旧备份中的本机中转地址失效，恢复旧备份后需要重新应用供应商方案。
          </p>
          <button
            className="button"
            disabled={!isNative}
            onClick={() => {
              if (
                window.confirm(
                  "清理历史中转路由？旧备份中的中转地址将失效；重新应用保存的供应商可生成新路由。",
                )
              )
                invoke("clearFilterRoutes")
                  .then(() => setError("历史路由已清理"))
                  .catch((e) => setError(e.message));
            }}
          >
            清理历史路由
          </button>
        </details>
      )}
      <p className="text-caption text-fg-2">
        关闭过滤：编辑当前供应商关闭开关，再应用直连方案。运行状态不代表 Codex
        已重新加载配置。被强制停止或重启手机后，请先打开 CC Switch 恢复中转。
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
