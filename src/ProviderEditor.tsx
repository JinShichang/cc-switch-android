import { useState } from "react";
import { useForm } from "react-hook-form";
import type { Provider, ProviderEditorBase } from "./core/types";
import { validateProvider } from "./core/codex";
import { parseConfig } from "./core/tomlPatch";
import { canonical } from "./core/tomlPatch";
import { FullScreenPanel } from "./vendor/components/common/FullScreenPanel";
import { BasicFormFields } from "./vendor/components/providers/forms/BasicFormFields";
import { CodexFormFields } from "./vendor/components/providers/forms/CodexFormFields";
import CodexConfigEditor from "./vendor/components/providers/forms/CodexConfigEditor";
import { useCodexConfigState } from "./vendor/components/providers/forms/hooks/useCodexConfigState";
import { Form } from "./vendor/components/ui/form";
import { Button } from "./vendor/components/ui/button";
import { ConfirmDialog } from "./vendor/components/ConfirmDialog";
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
export function ProviderEditor({
  provider,
  shownProvider = provider,
  editorBase,
  loadNotice,
  onClose,
  onSave,
  busy = false,
  saveError,
}: {
  provider: Provider;
  shownProvider?: Provider;
  editorBase?: ProviderEditorBase;
  loadNotice?: string;
  onClose: () => void;
  onSave: (
    p: Provider,
    editor?: { base: ProviderEditorBase; config: string },
  ) => Promise<void>;
  busy?: boolean;
  saveError?: string;
}) {
  const c = useCodexConfigState({ initialData: shownProvider });
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
  const [meta, setMeta] = useState<Record<string, any>>(() => {
    const next = { ...provider.meta };
    delete next.androidLoginPolicy;
    if (!next.custom_endpoints && Array.isArray(next.customEndpoints)) {
      next.custom_endpoints = Object.fromEntries(next.customEndpoints.map((url: string) => [url, { url, addedAt: Date.now() }]));
    }
    if (next.endpointAutoSelect === undefined && next.autoSelect !== undefined) next.endpointAutoSelect = next.autoSelect;
    delete next.customEndpoints;
    delete next.autoSelect;
    return next;
  });
  const change = (key: string, value: unknown) =>
    setMeta((prev) => ({ ...prev, [key]: value }));
  const official=provider.category==='official';
  const bound=meta.authBinding?.source==='managed_account'&&meta.authBinding.authProvider==='codex_oauth'?meta.authBinding.accountId??null:null;
  const [softIssues, setSoftIssues] = useState<string[]|null>(null),
    [error, setError] = useState(""),
    [endpointModal, setEndpointModal] = useState(false);
  const [headers, setHeaders] = useState(
      JSON.stringify(meta.localProxyRequestOverrides?.headers ?? {}, null, 2),
    ),
    [body, setBody] = useState(
      JSON.stringify(meta.localProxyRequestOverrides?.body ?? {}, null, 2),
    );
  let configError = "";
  try {
    parseConfig(c.codexConfig);
  } catch (e) {
    configError = (e as Error).message;
  }
  const save = async (confirmed = false) => {
    setError("");
    try {
      if (configError) throw Error(configError);
      if (!confirmed && !official && meta.providerType !== 'github_copilot' && meta.providerType !== 'xai_oauth') {
        const issues=[];
        if (!c.codexBaseUrl.trim()) issues.push('非官方供应商请填写 API 端点');
        if (!c.codexApiKey.trim()) issues.push('非官方供应商请填写 API Key');
        if (issues.length) {setSoftIssues(issues);return;}
      }
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
        }),
        editorBase ? { base: editorBase, config: c.codexConfig } : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <FullScreenPanel
      isOpen
      title={provider.name ? "编辑供应商" : "添加供应商"}
      subtitle={
        provider.category === "official"
          ? "Codex · 官方配置"
          : "Codex · 自定义配置"
      }
      onClose={onClose}
      contentClassName="mobile-provider space-y-6 p-4"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            保存
          </Button>
        </div>
      }
    >
      {loadNotice && (
        <p role="status" className="inline-warning">
          {loadNotice}
        </p>
      )}
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
            category={provider.category}
            providerId={provider.id}
            isCodexOauthPreset={official}
            selectedCodexAccountId={bound}
            onCodexAccountSelect={accountId=>change('authBinding',accountId?{source:'managed_account',authProvider:'codex_oauth',accountId}:{source:'provider_config'})}
            codexOauthSelectionLabel="登录方式"
            codexOauthNoneOptionLabel="使用 Codex 中的登录"
            codexOauthNoneOptionDescription="沿用 Codex 已有登录；目录权限不能读取宿主钥匙串。"
            codexOauthAllowUnboundSelection
            codexOauthAllowUnboundSelectionWithoutStatus
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
            onCustomEndpointsChange={(urls) => change("custom_endpoints", Object.fromEntries(urls.map(url => [url, meta.custom_endpoints?.[url] ?? { url, addedAt: Date.now() }]))) }
            autoSelect={meta.endpointAutoSelect ?? false}
            onAutoSelectChange={(v) => change("endpointAutoSelect", v)}
            speedTestEndpoints={Object.values(meta.custom_endpoints ?? {}) as {url: string}[]}
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
            billingMultiplier={meta.billingMultiplier ?? ""}
            onBillingMultiplierChange={(v) => change("billingMultiplier", v)}
            customUserAgent={meta.customUserAgent ?? ""}
            onCustomUserAgentChange={(v) => change("customUserAgent", v)}
            localProxyHeadersOverride={headers}
            onLocalProxyHeadersOverrideChange={setHeaders}
            localProxyBodyOverride={body}
            onLocalProxyBodyOverrideChange={setBody}
          />
          <CodexConfigEditor
            authValue={c.codexAuth}
            configValue={c.codexConfig}
            providerName={form.watch("name")}
            onAuthChange={c.setCodexAuth}
            onConfigChange={c.handleCodexConfigChange}
            authError={c.codexAuthError}
            configError={configError}
          />
          {(error || saveError) && (
            <p role="alert" className="text-danger-text break-words">
              {error || saveError}
            </p>
          )}
        </form>
      </Form>
      <ConfirmDialog isOpen={!!softIssues?.length} variant="info" title="配置存在以下问题"
        message={(softIssues??[]).map(issue=>`• ${issue}`).join('\n')+'\n\n仍要保存吗？保存后切换此供应商时可能失败，可以之后再补全。'}
        confirmText="仍要保存" cancelText="取消" pending={busy}
        onConfirm={()=>{setSoftIssues(null);void save(true);}} onCancel={()=>setSoftIssues(null)}/>
    </FullScreenPanel>
  );
}
