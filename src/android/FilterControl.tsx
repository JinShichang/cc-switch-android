import { useEffect, useState } from "react";
import { invoke, isNative } from "../bridge";
import type { AppMode } from "../vendor/types/proxy";
import { Button } from "../vendor/components/ui/button";
import { Switch } from "../vendor/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../vendor/components/ui/dialog";

const FILTER_NAME = "历史推理与ID过滤（解决不同源错误）";
interface FilterStatus {
  enabled: boolean;
  active: boolean;
  mode: AppMode;
  attached: boolean;
  running: boolean;
}
interface BackgroundStatus { unrestricted: boolean; notifications: boolean }

export function HistoryFilterControl({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<FilterStatus | null>(null);
  const [power, setPower] = useState<BackgroundStatus | null>(null);
  const [prompt, setPrompt] = useState(false), [busy, setBusy] = useState(false);
  const native = (command: string, payload: Record<string, unknown> = {}) => invoke<FilterStatus>("native", { command, payload });
  const checkPower = () => {
    if (isNative) invoke<BackgroundStatus>("backgroundStatus").then(setPower).catch(() => {});
  };
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (isNative) native("get_history_filter_status").then(value => { if (alive) setStatus(value); }).catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    window.addEventListener("provider-data-changed", refresh);
    window.addEventListener("history-filter-changed", refresh);
    window.addEventListener("ccswitch-resume", refresh);
    window.addEventListener("ccswitch-resume", checkPower);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener("provider-data-changed", refresh);
      window.removeEventListener("history-filter-changed", refresh);
      window.removeEventListener("ccswitch-resume", refresh);
      window.removeEventListener("ccswitch-resume", checkPower);
    };
  }, []);
  const save = async (enabled: boolean, openSettings = false) => {
    setBusy(true);
    try {
      if (enabled) await invoke("requestNotifications");
      setStatus(await native("set_history_filter_enabled", { enabled }));
      setPrompt(false);
      if (openSettings) await invoke("openBatterySettings");
      checkPower();
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const stateText = !status ? "读取过滤状态…" : !status.enabled ? "已关闭"
    : status.mode === "direct" ? "已开启 · 等待进入路由或聚合"
    : status.active ? `过滤生效中 · ${status.mode === "stack" ? "聚合" : "路由"}`
    : !status.running ? "已开启 · 本机中转未运行" : "已开启 · 等待连接 Codex";
  return <section className="filter-status rounded-panel border p-3 space-y-2 mt-3" aria-label={FILTER_NAME}>
    <div className="flex items-center justify-between gap-3">
      <label htmlFor="history-filter" className="font-medium min-w-0">{FILTER_NAME}</label>
      <Switch id="history-filter" className="shrink-0" aria-label={FILTER_NAME} checked={status?.enabled ?? false}
        disabled={!isNative || !status || busy} onCheckedChange={enabled => {
          if (enabled) { checkPower(); setPrompt(true); }
          else void save(false);
        }} />
    </div>
    <p role="status">{stateText}</p>
    <p className="text-caption text-fg-2">路由与聚合共用此开关，对经本机中转的后续请求生效。回到直连后暂停过滤，不改变直连方式。</p>
    <p className="text-caption text-fg-2">移除历史推理项及可重建条目的 ID，保留本轮思考强度、正文和工具 call_id。加密压缩历史无法转换时会报错。</p>
    {status?.enabled && <Button variant="quiet" size="compact" disabled={busy} onClick={() => void invoke("openBatterySettings").catch(error => onError(error.message))}>后台运行设置</Button>}
    <Dialog open={prompt} onOpenChange={open => { if (!busy) setPrompt(open); }}>
      <DialogContent zIndex="top" className="max-w-[calc(100vw-24px)] sm:max-w-lg">
        <DialogHeader><DialogTitle>允许 CC Switch 持续后台运行</DialogTitle>
          <DialogDescription>开启“{FILTER_NAME}”后，路由与聚合中的过滤需要 CC Switch 持续在后台运行。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-auto overflow-y-auto space-y-3 text-body px-5">
          <p>请允许后台活动，将电池使用设为“不受限制”或关闭电池优化。一加系统的自启动、后台冻结等限制也需解除。</p>
          <p>请允许通知，以显示中转运行状态。锁屏清理、强制停止应用或系统结束进程会中断请求。</p>
          <p>直连时仅保存开关状态。进入路由或聚合后才开始过滤，不会因开启此开关自动切换模式。</p>
          {power && <p>电池优化：{power.unrestricted ? "已豁免" : "尚未豁免"}；通知：{power.notifications ? "已允许" : "尚未允许"}。厂商后台限制仍需在设置中检查。</p>}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setPrompt(false)}>取消</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void save(true)}>已了解，开启</Button>
          <Button disabled={busy} onClick={() => void save(true, true)}>开启并前往设置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
