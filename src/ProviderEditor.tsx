import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Provider } from "./core/types";
import { validateProvider } from "./core/codex";
import { parseConfig } from "./core/tomlPatch";
import { invoke, isNative } from "./bridge";
import { FullScreenPanel } from "./vendor/components/common/FullScreenPanel";
import { BasicFormFields } from "./vendor/components/providers/forms/BasicFormFields";
import { CodexFormFields } from "./vendor/components/providers/forms/CodexFormFields";
import CodexConfigEditor from "./vendor/components/providers/forms/CodexConfigEditor";
import { useCodexConfigState } from "./vendor/components/providers/forms/hooks/useCodexConfigState";
import { Form } from "./vendor/components/ui/form";
import { Button } from "./vendor/components/ui/button";
import { Switch } from "./vendor/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./vendor/components/ui/dialog";
import {
  parseBodyOverrideJson,
  parseHeaderOverrideJson,
} from "./vendor/lib/requestOverrides";
import type { ProviderFormData } from "./vendor/lib/schemas/provider";
import type {
  CodexApiFormat,
  CodexChatReasoning,
  PromptCacheRoutingMode,
  ClaudeApiKeyField,
} from "./vendor/types";
export { Modal } from "./Modal";
export const FILTER_NAME = "历史推理与ID过滤（解决不同源错误）";
export function ProviderEditor({
  provider,
  onClose,
  onSave,
  busy = false,
  saveError,
}: {
  provider: Provider;
  onClose: () => void;
  onSave: (p: Provider) => Promise<void>;
  busy?: boolean;
  saveError?: string;
}) {
  const c = useCodexConfigState({ initialData: provider });
  const form = useForm<ProviderFormData>({
    defaultValues: {
      name: provider.name,
      notes: provider.notes ?? "",
      websiteUrl: provider.websiteUrl ?? "",
      icon: provider.icon ?? "",
      iconColor: provider.iconColor ?? "",
      settingsConfig: JSON.stringify(provider.settingsConfig),
    },
  });
  const [meta, setMeta] = useState<Record<string, any>>({ ...provider.meta });
  const change = (key: string, value: unknown) =>
    setMeta((prev) => ({ ...prev, [key]: value }));
  const [filter, setFilter] = useState(provider.historyFilter === true),
    [prompt, setPrompt] = useState(false),
    [error, setError] = useState(""),
    [endpointModal, setEndpointModal] = useState(false);
  const [headers, setHeaders] = useState(
      JSON.stringify(meta.localProxyRequestOverrides?.headers ?? {}, null, 2),
    ),
    [body, setBody] = useState(
      JSON.stringify(meta.localProxyRequestOverrides?.body ?? {}, null, 2),
    );
  const [power, setPower] = useState<{
    unrestricted: boolean;
    notifications: boolean;
  } | null>(null);
  const checkPower = () => {
    if (isNative)
      invoke("backgroundStatus")
        .then(setPower)
        .catch(() => {});
  };
  useEffect(() => {
    checkPower();
    window.addEventListener("focus", checkPower);
    window.addEventListener("ccswitch-resume", checkPower);
    const listener = () => {
      if (!document.hidden) checkPower();
    };
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("focus", checkPower);
      window.removeEventListener("ccswitch-resume", checkPower);
      document.removeEventListener("visibilitychange", listener);
    };
  }, []);
  const enable = async (settings: boolean) => {
    setFilter(true);
    setPrompt(false);
    if (isNative) {
      try {
        await invoke("requestNotifications");
        if (settings) await invoke("openBatterySettings");
        checkPower();
      } catch (e) {
        setError(String(e));
      }
    }
  };
  let configError = "";
  try {
    parseConfig(c.codexConfig);
  } catch (e) {
    configError = (e as Error).message;
  }
  const save = async () => {
    setError("");
    try {
      if (configError) throw Error(configError);
      const auth = JSON.parse(c.codexAuth || "{}");
      if (!auth || Array.isArray(auth) || typeof auth !== "object")
        throw Error("auth.json 必须是 JSON 对象");
      const h = parseHeaderOverrideJson(headers),
        b = parseBodyOverrideJson(body);
      if (h.error || b.error) throw Error(h.error || b.error);
      const models = c.codexCatalogModels
        .filter((m) => m.model.trim())
        .map((m) => ({
          ...m,
          model: m.model.trim(),
          contextWindow: m.contextWindow
            ? Number(String(m.contextWindow).replace(/[^0-9]/g, ""))
            : undefined,
        }));
      if (new Set(models.map((m) => m.model)).size !== models.length)
        throw Error("模型列表包含重复名称");
      if (
        models.some(
          (m) =>
            m.contextWindow !== undefined &&
            (!Number.isSafeInteger(m.contextWindow) || m.contextWindow <= 0),
        )
      )
        throw Error("上下文窗口必须是正整数");
      await onSave(
        validateProvider({
          ...provider,
          ...form.getValues(),
          loginPolicy: meta.androidLoginPolicy ?? provider.loginPolicy,
          settingsConfig: {
            auth,
            config: c.codexConfig,
            modelCatalog: {
              models,
              autoReviewModel: c.codexAutoReviewModel,
              officialSpeedTiers: c.codexOfficialSpeedTiers,
            },
          },
          meta: {
            ...meta,
            localProxyRequestOverrides: { headers: h.headers, body: b.value },
          },
          historyFilter: filter,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <FullScreenPanel
      isOpen
      title={provider.name ? "编辑供应商" : "添加供应商"}
      subtitle="Codex · 自定义配置"
      onClose={onClose}
      contentClassName="mobile-provider space-y-6 p-4"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            保存
          </Button>
        </div>
      }
    >
      <Form {...form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="space-y-6"
        >
          <BasicFormFields form={form} />
          <CodexFormFields
            appId="codex"
            variant="classic"
            category="custom"
            codexApiKey={c.codexApiKey}
            onApiKeyChange={c.handleCodexApiKeyChange}
            shouldShowApiKeyLink={false}
            websiteUrl={form.watch("websiteUrl") ?? ""}
            shouldShowSpeedTest
            codexBaseUrl={c.codexBaseUrl}
            onBaseUrlChange={c.handleCodexBaseUrlChange}
            isFullUrl={meta.isFullUrl ?? false}
            onFullUrlChange={(v) => change("isFullUrl", v)}
            isEndpointModalOpen={endpointModal}
            onEndpointModalToggle={setEndpointModal}
            onCustomEndpointsChange={(v) => change("customEndpoints", v)}
            autoSelect={meta.autoSelect ?? false}
            onAutoSelectChange={(v) => change("autoSelect", v)}
            speedTestEndpoints={(meta.customEndpoints ?? []).map(
              (url: string) => ({ url }),
            )}
            codexModel={c.codexModel}
            onModelChange={c.handleCodexModelChange}
            subagentModel={c.codexSubagentModel}
            onSubagentModelChange={c.handleCodexSubagentModelChange}
            subagentReasoningEffort={c.codexSubagentReasoningEffort}
            onSubagentReasoningEffortChange={
              c.handleCodexSubagentReasoningEffortChange
            }
            agentMaxThreads={c.codexAgentMaxThreads}
            multiAgentV2Total={c.codexMultiAgentV2Total}
            onAgentMaxThreadsChange={c.handleCodexAgentMaxThreadsChange}
            apiFormat={(meta.apiFormat ?? "openai_responses") as CodexApiFormat}
            onApiFormatChange={(v) => change("apiFormat", v)}
            anthropicAuthField={
              (meta.anthropicAuthField ?? "x-api-key") as ClaudeApiKeyField
            }
            onAnthropicAuthFieldChange={(v) => change("anthropicAuthField", v)}
            impersonateClaudeCode={meta.impersonateClaudeCode ?? false}
            onImpersonateClaudeCodeChange={(v) =>
              change("impersonateClaudeCode", v)
            }
            maxOutputTokens={String(meta.maxOutputTokens ?? "")}
            onMaxOutputTokensChange={(v) => change("maxOutputTokens", v)}
            codexChatReasoning={meta.codexChatReasoning as CodexChatReasoning}
            onCodexChatReasoningChange={(v) => change("codexChatReasoning", v)}
            promptCacheRouting={
              (meta.promptCacheRouting ?? "auto") as PromptCacheRoutingMode
            }
            onPromptCacheRoutingChange={(v) => change("promptCacheRouting", v)}
            catalogModels={c.codexCatalogModels}
            onCatalogModelsChange={c.setCodexCatalogModels}
            autoReviewModel={c.codexAutoReviewModel}
            onAutoReviewModelChange={c.setCodexAutoReviewModel}
            officialSpeedTiers={c.codexOfficialSpeedTiers}
            onOfficialSpeedTiersChange={c.setCodexOfficialSpeedTiers}
            customUserAgent={meta.customUserAgent ?? ""}
            onCustomUserAgentChange={(v) => change("customUserAgent", v)}
            localProxyHeadersOverride={headers}
            onLocalProxyHeadersOverrideChange={setHeaders}
            localProxyBodyOverride={body}
            onLocalProxyBodyOverrideChange={setBody}
          />
          <section className="rounded-panel border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="history-filter" className="font-medium">
                {FILTER_NAME}
              </label>
              <Switch
                id="history-filter"
                checked={filter}
                onCheckedChange={(v) =>
                  v ? setPrompt(true) : setFilter(false)
                }
              />
            </div>
            <p className="text-caption text-fg-2">
              应用此方案后，Codex 请求经 CC Switch
              本机中转，移除历史推理项及可重建条目的
              ID。保留本轮思考强度、正文及工具
              call_id。加密压缩上下文无法安全转换时会报错。
            </p>
            {filter && (
              <>
                <p className="text-caption text-fg-2">
                  需要持续后台运行。保存方案后还需应用；关闭后重新应用恢复直连，并重启
                  Codex。
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPrompt(true)}
                >
                  后台运行设置
                  {power
                    ? power.unrestricted
                      ? " · 已解除电池优化"
                      : " · 需检查电池限制"
                    : ""}
                </Button>
              </>
            )}
          </section>
          <CodexConfigEditor
            authValue={c.codexAuth}
            configValue={c.codexConfig}
            providerName={form.watch("name")}
            onAuthChange={c.setCodexAuth}
            onConfigChange={c.handleCodexConfigChange}
            authError={c.codexAuthError}
            configError={configError}
          />
          <p className="text-caption text-fg-2">
            auth.json 作为此方案的认证输入保存。应用 API Key 方案时写入服务商
            bearer token，保留 Codex 的 auth.json
            和钥匙串登录材料。其他本地代理参数需要启用中转；协议转换尚未移植的选项会在应用时明确报错。
          </p>
          <label className="block text-body">
            保留官方登录界面
            <select
              className="mt-2 block w-full border rounded-control p-2 bg-surface"
              value={meta.androidLoginPolicy ?? provider.loginPolicy}
              onChange={(e) => change("androidLoginPolicy", e.target.value)}
            >
              <option value="auto">自动</option>
              <option value="keep">启用（已在 Codex 中登录）</option>
              <option value="omit">关闭</option>
            </select>
          </label>
          {(error || saveError) && (
            <p role="alert" className="text-danger-text break-words">
              {error || saveError}
            </p>
          )}
        </form>
      </Form>
      <Dialog open={prompt} onOpenChange={setPrompt}>
        <DialogContent
          zIndex="top"
          className="max-w-[calc(100vw-24px)] sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>允许 CC Switch 持续后台运行</DialogTitle>
            <DialogDescription>
              开启“{FILTER_NAME}”后，CC Switch 需要作为本机路由持续运行。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-auto overflow-y-auto space-y-3 text-body px-5">
            <p>
              请在系统设置中允许后台活动，并将 CC Switch
              的电池使用设为“不受限制”或关闭电池优化。若一加系统提供自启动、后台冻结限制，也请允许。
            </p>
            <p>
              请允许通知，以显示中转运行状态。锁屏、系统清理或手动强制停止应用可能中断
              Codex 请求；后台设置不能保证进程永不被系统终止。
            </p>
            <p>
              此功能无法跨供应商复用加密压缩历史。出现相关提示时，请用文本摘要开启新会话。
            </p>
            {power && (
              <p>
                系统电池优化：{power.unrestricted ? "已豁免" : "尚未豁免"}
                ；通知：{power.notifications ? "已允许" : "尚未允许"}
                。厂商后台限制需要你在设置中检查。
              </p>
            )}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPrompt(false)}>
              取消
            </Button>
            <Button variant="secondary" onClick={() => void enable(false)}>
              已了解，开启
            </Button>
            <Button onClick={() => void enable(true)}>开启并前往设置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FullScreenPanel>
  );
}
