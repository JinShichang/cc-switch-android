import { useEffect, useState } from "react";
import { invoke, isNative } from "../bridge";
export function FilterStatusPanel() {
  const [status, setStatus] = useState<any>(null),
    [error, setError] = useState("");
  const refresh = () => {
    if (isNative)
      invoke("native",{command:"get_proxy_status",payload:{}})
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
          路由请求 {status.total_requests} 次 · 成功 {status.success_requests} · 失败 {status.failed_requests}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="button"
          disabled={!isNative}
          onClick={() =>
            invoke("startRouter")
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
      <p className="text-caption text-fg-2">
        过滤与路由、聚合使用同一个上游中转服务。关闭过滤：编辑供应商关闭开关。运行状态不代表 Codex
        已重新加载配置。被强制停止或重启手机后，请先打开 CC Switch 恢复中转。
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
