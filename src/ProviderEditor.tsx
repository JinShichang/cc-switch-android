import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, Eye, EyeOff, ArrowLeft, Check } from "lucide-react";
import type { Provider, AuthKind } from "./core/types";
import {
  formValues,
  newProvider,
  updateFormConfig,
  editRawConfig,
  validateProvider,
} from "./core/codex";
import { patchPath } from "./core/tomlPatch";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成";
export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = element.current!;
    el.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const all = [
          ...el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        ].filter((item) => item.getClientRects().length);
        const first = all[0],
          last = all[all.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === el)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === el)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("keydown", key);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-overlay">
      <div
        ref={element}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            disabled={busy}
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function ProviderEditor({
  provider,
  onClose,
  onSave,
  busy,
  saveError,
}: {
  saveError: string;
  provider: Provider;
  onClose: () => void;
  onSave: (provider: Provider) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Provider>(() => structuredClone(provider));
  const [fields, setFields] = useState(() => formValues(provider));
  const [rawMode, setRawMode] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const setField = (key: keyof typeof fields, value: string) => {
    const nextFields = { ...fields, [key]: value };
    setFields(nextFields);
    try {
      let config = draft.settingsConfig.config;
      if (draft.authKind !== "official") {
        config = updateFormConfig(config, {
          name: draft.name,
          model: nextFields.model,
          baseUrl: nextFields.baseUrl,
          effort: nextFields.effort,
          envKey: draft.authKind === "env" ? nextFields.envKey : undefined,
        });
        if (key === "apiKey") {
          config = patchPath(
            config,
            ["model_providers", "custom", "experimental_bearer_token"],
            undefined,
          );
          config = patchPath(config, ["experimental_bearer_token"], undefined);
        }
      } else {
        config = patchPath(config, ["model"], nextFields.model || undefined);
        config = patchPath(
          config,
          ["model_reasoning_effort"],
          nextFields.effort || undefined,
        );
      }
      setDraft({
        ...draft,
        settingsConfig: { config, auth: { OPENAI_API_KEY: nextFields.apiKey } },
      });
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const changeKind = (kind: AuthKind) => {
    if (kind === "official" || draft.authKind === "official") {
      const next = newProvider(kind);
      next.id = draft.id;
      next.name = draft.name;
      next.notes = draft.notes;
      setDraft(next);
      setFields(formValues(next));
    } else setDraft({ ...draft, authKind: kind });
  };
  const submit = async () => {
    try {
      let result = structuredClone(draft);
      if (!rawMode && result.authKind !== "official")
        result.settingsConfig.config = updateFormConfig(
          result.settingsConfig.config,
          {
            name: result.name,
            model: fields.model,
            baseUrl: fields.baseUrl,
            effort: fields.effort,
            envKey: result.authKind === "env" ? fields.envKey : undefined,
          },
        );
      result = validateProvider(result);
      setError("");
      await onSave(result);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal
      title={provider.name ? "编辑服务商" : "添加服务商"}
      busy={busy}
      onClose={onClose}
    >
      <div className="modal-body editor-body">
        {(error || saveError) && (
          <p role="alert" className="inline-warning">
            {error || saveError}
          </p>
        )}
        <label className="field">
          <span>
            名称 <em>*</em>
          </span>
          <input
            value={draft.name}
            maxLength={100}
            placeholder="例如：我的 API 服务"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>认证方式</span>
          <select
            value={draft.authKind}
            onChange={(e) => changeKind(e.target.value as AuthKind)}
          >
            <option value="apiKey">API Key · 原生 Responses</option>
            <option value="official">Codex 已有官方登录</option>
            <option value="env">Codex 进程环境变量</option>
            <option value="none">无认证服务</option>
          </select>
        </label>
        {draft.authKind === "official" && (
          <p className="inline-info">
            切回 Codex 已有的官方登录。此处无法读取或切换钥匙串账号，登录需要在
            Codex 中完成。
          </p>
        )}
        <div className="segmented editor-tabs">
          <button
            className={!rawMode ? "chosen" : ""}
            onClick={() => {
              try {
                setFields(formValues(draft));
                setRawMode(false);
                setError("");
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            基本设置
          </button>
          <button
            className={rawMode ? "chosen" : ""}
            onClick={() => setRawMode(true)}
          >
            高级 TOML
          </button>
        </div>
        {!rawMode ? (
          <>
            {draft.authKind !== "official" && (
              <label className="field">
                <span>服务地址</span>
                <input
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://api.example.com/v1"
                  value={fields.baseUrl}
                  onChange={(e) => setField("baseUrl", e.target.value)}
                />
                <small>填写完整 API 基础地址，保留服务商要求的路径。</small>
              </label>
            )}
            {draft.authKind === "apiKey" && (
              <label className="field">
                <span>API Key</span>
                <div className="password-field">
                  <input
                    type={visible ? "text" : "password"}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={fields.apiKey}
                    placeholder="输入 API Key"
                    onChange={(e) => setField("apiKey", e.target.value)}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff /> : <Eye />}
                  </button>
                </div>
                <small>
                  方案密钥在本机加密保存。应用后写入 Codex 的服务商配置表。
                </small>
              </label>
            )}
            {draft.authKind === "env" && (
              <label className="field">
                <span>环境变量名</span>
                <input
                  value={fields.envKey}
                  placeholder="CODEX_API_KEY"
                  autoCapitalize="none"
                  onChange={(e) => setField("envKey", e.target.value)}
                />
                <small>需要 Codex 宿主预先注入。本应用只能保存变量名。</small>
              </label>
            )}
            {draft.authKind === "none" && (
              <p className="inline-info">
                适用于明确无需认证的服务。不会发送 Codex 的官方登录凭据。
              </p>
            )}
            <label className="field">
              <span>模型</span>
              <input
                value={fields.model}
                placeholder={
                  draft.authKind === "official"
                    ? "留空使用 Codex 默认值"
                    : "服务商支持的模型名称"
                }
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setField("model", e.target.value)}
              />
            </label>
            <label className="field">
              <span>推理强度</span>
              <select
                value={fields.effort}
                onChange={(e) => setField("effort", e.target.value)}
              >
                <option value="">Codex 默认</option>
                {[
                  "none",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                  "ultra",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <small>可用档位由服务商和模型决定。</small>
            </label>
          </>
        ) : (
          <label className="field">
            <span>供应商 config.toml</span>
            <textarea
              className="toml-editor"
              rows={15}
              spellCheck={false}
              autoCapitalize="none"
              value={draft.settingsConfig.config}
              onChange={(e) => setDraft(editRawConfig(draft, e.target.value))}
            />
            <small>
              支持请求头、重试、上下文窗口、模型等原生参数。只投影服务商相关字段；模板中的
              MCP、项目和用户设置不会覆盖现有配置。此编辑器可能含密钥。
            </small>
          </label>
        )}
        {draft.authKind !== "official" && (
          <label className="field">
            <span>保留官方登录界面</span>
            <select
              value={draft.loginPolicy}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  loginPolicy: e.target.value as Provider["loginPolicy"],
                })
              }
            >
              <option value="auto">自动 · 按 auth.json 中的登录材料</option>
              <option value="keep">启用 · 我已在 Codex 中登录</option>
              <option value="omit">关闭</option>
            </select>
            <small>钥匙串登录无法自动确认。此设置不迁移或删除账号。</small>
          </label>
        )}
        <label className="field">
          <span>备注</span>
          <textarea
            rows={2}
            maxLength={2000}
            value={draft.notes ?? ""}
            placeholder="可选"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>
      </div>
      <footer className="modal-footer">
        <button className="button" disabled={busy} onClick={onClose}>
          <ArrowLeft /> 返回
        </button>
        <button className="button primary" disabled={busy} onClick={submit}>
          <Check /> 保存方案
        </button>
      </footer>
    </Modal>
  );
}
