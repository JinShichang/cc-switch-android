import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Plus, Minus, Settings, Layers, FileText, Archive, FolderOpen, Check, RefreshCw, Pencil, Trash2, Copy, X, ArrowLeft, ArrowUpRight, Download, Upload, ShieldCheck, AlertTriangle, Search, Eye, EyeOff, ChevronRight, KeyRound, Moon, Sun, Smartphone, RotateCcw, SlidersHorizontal } from "lucide-react";
import { invoke, isNative } from "./bridge.ts";
import type { AppState, AuthKind, Provider, Snapshot } from "./core/types.ts";
import { captureCurrent, editRawConfig, exportProviders, formValues, importProviders, matchProvider, newProvider, planApply, readSummary, redactConfig, updateFormConfig, validateProvider } from "./core/codex.ts";
import { patchPath } from "./core/tomlPatch.ts";
import thirdPartyNotices from "../THIRD_PARTY_NOTICES.txt?raw";

const EMPTY: AppState = { providers: [], backups: [], directory: null, pendingRecovery: false, settings: { zoom: 200, theme: "system" }, native: isNative };
type Tab = "providers" | "current" | "backups" | "settings";
type Dialog = { title: string; content: ReactNode; confirm?: () => Promise<void>; confirmLabel?: string; danger?: boolean };
const date = (time: number) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(time);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试。";

function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = element.current!;
    el.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const all = [...el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(item => item.getClientRects().length);
        const first = all[0], last = all[all.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === el)) { event.preventDefault(); first.focus(); }
      }
    };
    el.addEventListener("keydown", key);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { el.removeEventListener("keydown", key); document.body.style.overflow = old; previous?.focus(); };
  }, [busy, onClose]);
  return <div className="modal-overlay"><div ref={element} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <header className="modal-header"><h2>{title}</h2><button className="icon-button" disabled={busy} aria-label="关闭" onClick={onClose}><X /></button></header>
    {children}
  </div></div>;
}

export function App() {
  const [state, setState] = useState<AppState>(EMPTY);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("providers");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Provider | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [keysIncluded, setKeysIncluded] = useState(false);
  const [zoomInput, setZoomInput] = useState("200");
  const [busyLabel, setBusyLabel] = useState("正在处理…");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<AppState>("bootstrap").then(async next => {
      if (!alive) return;
      setState(next); setZoomInput(String(next.settings.zoom));
      if (next.directory) {
        try { const live = await invoke<Snapshot>("readCurrent"); if (alive) setSnapshot(live); }
        catch (e) { if (alive) setError(errorMessage(e)); }
      }
    }).catch(e => { if (alive) setError(errorMessage(e)); }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", state.settings.theme === "dark" || (state.settings.theme === "system" && media.matches));
    apply(); media.addEventListener("change", apply);
    document.documentElement.style.setProperty("--zoom", String(state.settings.zoom / 100));
    return () => media.removeEventListener("change", apply);
  }, [state.settings, systemDark]);

  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  useEffect(() => {
    window.__ccswitchBack = () => {
      if (busy) return true;
      if (dialog) { setDialog(null); return true; }
      if (editor) { setEditor(null); return true; }
      if (tab !== "providers") { setTab("providers"); return true; }
      return false;
    };
    return () => { delete window.__ccswitchBack; };
  }, [busy, dialog, editor, tab]);

  const action = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setBusyLabel(label); setError(""); setNotice("");
    try { await work(); }
    catch (e: any) {
      if (e?.code !== "cancelled") setError(errorMessage(e));
      // A failed native transaction may have created a recovery journal.
      if (state.native) try { setState(await invoke<AppState>("bootstrap")); } catch { }
    } finally { setBusy(false); }
  };
  const refresh = async () => {
    try {
      const current = await invoke<Snapshot>("readCurrent");
      setSnapshot(current);
      setState(await invoke<AppState>("bootstrap"));
      return current;
    } catch (error) { setSnapshot(null); throw error; }
  };
  const authorize = () => action("等待系统目录授权…", async () => {
    const next = await invoke<AppState>("chooseDirectory");
    setState(next); setSnapshot(null);
    const live = await invoke<Snapshot>("readCurrent");
    setSnapshot(live);
    setNotice(next.directory?.isCodexProvider ? "已获得 Codex 文档目录权限；运行中的配置仍需在 Codex 中确认。" : "已授权普通 SAF 目录。这里的读写属于测试/普通目录操作，不代表已经接通 Codex。");
  });
  const saveProviders = async (providers: Provider[]) => setState(await invoke<AppState>("saveProviders", { providers }));
  const apply = (provider: Provider) => action("正在备份、写入并读回核对…", async () => {
    if (!snapshot) throw new Error("请先授权目录并读取当前配置。");
    // Use the displayed revision. Native code rejects changes since this view;
    // never silently refresh and overwrite a concurrent Codex edit on apply.
    const plan = planApply(snapshot, provider);
    const result = await invoke<{ state: AppState; snapshot: Snapshot }>("apply", { providerId: provider.id, config: plan.config, expectedRevision: snapshot.revision, ownership: plan.ownership });
    setState(result.state); setSnapshot(result.snapshot);
    setNotice(`文件保存成功，已读回核对。请完全重启 Codex，并在新会话中确认服务商和模型。${plan.warnings.length ? " " + plan.warnings.join(" ") : ""}`);
  });
  const previewPlan = (provider: Provider) => {
    try {
      if (!snapshot) throw new Error("请先授权目录并读取当前配置。");
      const plan = planApply(snapshot, provider);
      setDialog({ title: "应用前预览", content: <><p className="muted">将修改以下字段，API Key 已隐藏。MCP、工作目录及无关设置通过保护检查。</p>
        <div className="chips">{plan.changedFields.length ? plan.changedFields.map(f => <code key={f}>{f}</code>) : <span className="badge success">文件内容已一致</span>}</div>
        {plan.warnings.map(w => <p className="inline-warning" key={w}>{w}</p>)}<pre className="code-view">{redactConfig(plan.config)}</pre></> });
    } catch (e) { setError(errorMessage(e)); }
  };
  const restore = (id?: string) => {
    setDialog({ title: id ? "恢复配置备份" : "恢复未确认写入", danger: true, confirmLabel: "备份当前并恢复", content: <>
      <p>恢复会替换此目录的整个 config.toml，包括备份中的 MCP 和自定义设置。恢复前会先备份当前文件，并在完成后读回核对。</p>
      <p className="muted">auth.json 和钥匙串保持原样。恢复文件后仍需重启 Codex。</p>
    </>, confirm: async () => {
      // A corrupt current TOML is still restorable: native reads bytes without
      // requiring the UI parser to accept the damaged file.
      const live = await invoke<{ revision: string }>("readRevision");
      const result = await invoke<{ state: AppState; snapshot: Snapshot }>(id ? "restore" : "recover", { id, expectedRevision: live.revision });
      setState(result.state); setSnapshot(result.snapshot); setDialog(null);
      setNotice("配置备份已恢复，读回核对通过。请重启 Codex 后确认生效。");
    } });
  };
  const importFile = () => action("等待选择导入文件…", async () => {
    const file = await invoke<{ text: string }>("importFile");
    const imported = importProviders(file.text);
    if (state.providers.length + imported.providers.length > 200) throw new Error("导入后将超过 200 个方案，请先删除不需要的方案。");
    setDialog({ title: "确认导入方案", confirmLabel: `导入 ${imported.providers.length} 项`, content: <>
      <p>将添加以下方案，现有方案保留。导入不会修改已授权目录。</p>
      <ul>{imported.providers.map(p => <li key={p.id}>{p.name}</li>)}</ul>
      {imported.warnings.map((w, i) => <p className="inline-warning" key={i}>{w}</p>)}
    </>, confirm: async () => {
      await saveProviders([...state.providers, ...imported.providers]); setDialog(null); setTab("providers");
      setNotice("方案已导入。请检查服务地址和 API Key，再应用到目录。");
    } });
  });
  const saveSetting = async (settings: AppState["settings"]) => {
    setState(await invoke<AppState>("settings", settings)); setZoomInput(String(settings.zoom));
  };
  const setZoom = (number: number) => action("保存缩放…", async () => {
    const zoom = Math.min(400, Math.max(50, Math.round(number)));
    if (!Number.isFinite(zoom)) { setZoomInput(String(state.settings.zoom)); return; }
    await saveSetting({ ...state.settings, zoom });
  });
  const closeEditor = useCallback(() => setEditor(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  let summary: ReturnType<typeof readSummary> | null = null;
  let configError = "";
  if (snapshot) try { summary = readSummary(snapshot); } catch (e) { configError = errorMessage(e); }
  const providers = state.providers.filter(p => `${p.name} ${formDescription(p)}`.toLowerCase().includes(query.toLowerCase()));
  const matched = snapshot ? state.providers.filter(p => matchProvider(snapshot, p) === "exact") : [];

  const dark = state.settings.theme === "dark" || (state.settings.theme === "system" && systemDark);
  return <div className={`scaled-root ${dark ? "dark" : ""}`} style={{ zoom: state.settings.zoom / 100 } as CSSProperties}>
    <div className="shell" aria-hidden={!!(editor || dialog)}>
      <header className="topbar"><div className="brand"><img src="./logo.svg" alt="" /><span>CC Switch</span><span className="platform-tag">Android</span></div><button className="icon-button" aria-label="打开设置" onClick={() => setTab("settings")} disabled={busy}><Settings /></button></header>
      <main className="content" aria-busy={busy}>
        {!state.native && <div className="preview-banner"><Smartphone /><span>浏览器预览 · 草稿仅保存在内存中，SAF 读写请安装 APK</span></div>}
        {(error || configError) && <div className="banner error" role="alert"><AlertTriangle /><div>{error || configError}</div><button aria-label="关闭错误提示" className="icon-button" onClick={() => setError("")}><X /></button></div>}
        {notice && <div className="banner notice" role="status"><Check /><div>{notice}</div><button aria-label="关闭操作提示" className="icon-button" onClick={() => setNotice("")}><X /></button></div>}
        {!ready ? <div className="empty"><RefreshCw className="spin" /><p>正在读取本地方案…</p></div> : <>
          {tab === "providers" && <>
            <div className="page-heading"><div><div className="eyebrow"><img src="./codex.svg" alt="" /> CODEX</div><h1>服务商</h1></div><button className="button primary" disabled={busy} onClick={() => setEditor(newProvider())}><Plus /> 添加</button></div>
            <button className={`directory-card ${state.directory ? "connected" : ""}`} disabled={busy} onClick={authorize}>
              <span className="directory-icon"><FolderOpen /></span><span className="directory-copy"><strong>{state.directory?.name ?? "连接配置目录"}</strong><small>{state.directory ? state.directory.isCodexProvider ? "Codex 文档目录 · 点击更换" : "普通 SAF 目录 · 尚未接通 Codex" : "选择 Codex 提供的 .codex 文件夹"}</small></span><ChevronRight />
            </button>
            {snapshot && <div className="live-line"><span className={`status-dot ${summary ? "ok" : ""}`} /><span>{summary ? matched.length ? `${matched.length} 个方案与文件匹配` : "当前文件未匹配已保存方案" : "当前文件需要修复"}</span><button className="icon-button" disabled={busy} aria-label="刷新当前配置" onClick={() => action("读取当前配置…", async () => { await refresh(); })}><RefreshCw /></button></div>}
            {state.pendingRecovery && <button className="recovery-callout" disabled={busy} onClick={() => setTab("backups")}><AlertTriangle /> 有未确认写入，请先恢复 <ChevronRight /></button>}
            {!!state.providers.length && <label className="search-box"><Search /><input aria-label="搜索服务商" placeholder="搜索服务商、模型或地址" value={query} onChange={e => setQuery(e.target.value)} /></label>}
            {!providers.length ? <section className="empty"><div className="empty-icon"><Layers /></div><h2>{query ? "没有找到匹配方案" : "为 Codex 添加服务商"}</h2><p>{query ? "试试其他名称或地址。" : "保存多套服务地址、API Key 和模型，随时切换。"}</p>{!query && <><button className="button primary" disabled={busy} onClick={() => setEditor(newProvider())}><Plus /> 添加第一个方案</button><button className="button ghost" disabled={busy} onClick={importFile}><Upload /> 从文件导入</button></>}</section> : <div className="provider-grid">
              {providers.map(provider => {
                const match = snapshot ? matchProvider(snapshot, provider) : "different";
                const exact = match === "exact";
                let values; try { values = formValues(provider); } catch { values = { model: "配置需修复", baseUrl: "", apiKey: "", effort: "", envKey: "" }; }
                return <article className={`provider-card ${exact ? "active" : ""}`} key={provider.id}>
                  <div className="card-heading"><div className={`provider-avatar ${provider.authKind === "official" ? "official" : ""}`}>{provider.authKind === "official" ? <img src="./codex.svg" alt="" /> : provider.name.charAt(0).toUpperCase()}</div><div className="card-title"><h2>{provider.name}</h2><span className={`badge ${exact ? "direct" : "neutral"}`}>{exact ? <><Check /> 文件匹配</> : match === "related" ? "部分参数不同" : provider.authKind === "official" ? "官方登录" : "直连"}</span></div><button className="icon-button" disabled={busy} aria-label={`编辑 ${provider.name}`} onClick={() => setEditor(structuredClone(provider))}><Pencil /></button></div>
                  <div className="provider-endpoint" title={values.baseUrl}>{values.baseUrl || (provider.authKind === "official" ? "使用 Codex 已有的官方登录" : "尚未填写服务地址")}</div>
                  <div className="provider-model"><span>模型</span><strong>{values.model || "Codex 默认"}</strong></div>
                  <div className="provider-meta"><span><KeyRound /> {provider.authKind === "official" ? "由 Codex 管理" : provider.authKind === "env" ? values.envKey || "环境变量未设置" : provider.authKind === "none" ? "无认证" : values.apiKey ? "API Key 已保存" : "待填写 API Key"}</span>{values.effort && <span>{values.effort}</span>}</div>
                  {provider.notes && <p className="card-notes">{provider.notes}</p>}
                  <div className="card-actions"><button className={`button ${exact ? "selected" : "primary"}`} disabled={busy || !snapshot || !!configError || state.pendingRecovery} onClick={() => apply(provider)}>{exact ? <Check /> : <ArrowUpRight />} {exact ? "重新应用" : "应用"}</button><button className="icon-button" aria-label={`预览 ${provider.name} 的修改`} disabled={busy || !snapshot} onClick={() => previewPlan(provider)}><Eye /></button><button className="icon-button" aria-label={`复制 ${provider.name}`} disabled={busy} onClick={() => { const copy = structuredClone(provider); copy.id = crypto.randomUUID(); copy.name += " 副本"; setEditor(copy); }}><Copy /></button><button className="icon-button danger-text" aria-label={`删除 ${provider.name}`} disabled={busy} onClick={() => setDialog({ title: "删除服务商方案", danger: true, confirmLabel: "删除方案", content: <p>删除“{provider.name}”的本地方案。已写入 Codex 目录的配置和备份将保留。</p>, confirm: async () => { await saveProviders(state.providers.filter(p => p.id !== provider.id)); setDialog(null); } })}><Trash2 /></button></div>
                </article>;
              })}
            </div>}
            <p className="page-footnote"><ShieldCheck /> 文件写入会备份并读回核对。运行中的 Codex 是否已使用新配置，需要重启后确认。</p>
          </>}

          {tab === "current" && <>
            <div className="page-heading"><div><div className="eyebrow">CONFIGURATION</div><h1>当前配置</h1></div><button className="icon-button" disabled={busy || !state.directory} aria-label="重新读取文件" onClick={() => action("读取当前配置…", async () => { await refresh(); })}><RefreshCw /></button></div>
            {!state.directory ? <section className="empty"><FolderOpen /><h2>先授权配置目录</h2><p>系统文件选择器会让你选择 Codex 的 .codex 目录。</p><button className="button primary" disabled={busy} onClick={authorize}>选择目录</button></section> : <>
              <section className="panel"><h2><FolderOpen /> {state.directory.name}</h2><p className="muted break-word">{state.directory.authority}</p><span className="badge neutral">{state.directory.isCodexProvider ? "Codex DocumentsProvider" : "普通 / 测试 SAF 目录"}</span></section>
              {summary && snapshot && <>
                <section className="panel"><h2>文件状态</h2><dl className="details"><div><dt>config.toml</dt><dd>{snapshot.config === null ? "不存在，应用时创建" : "已读取"}</dd></div><div><dt>当前服务商</dt><dd>{summary.providerId}</dd></div><div><dt>模型</dt><dd>{summary.model}</dd></div><div><dt>认证存储</dt><dd>{summary.auth.mode}</dd></div><div><dt>运行状态</dt><dd className="warning-text">未确认，需在 Codex 中核对</dd></div></dl><p className="muted">{summary.auth.state}</p></section>
                <button className="button full" disabled={busy || snapshot.config === null} onClick={() => { try { setEditor(captureCurrent(snapshot, "从当前配置导入")); } catch (e) { setError(errorMessage(e)); } }}><Plus /> 将当前配置保存为方案</button>
                <section className="panel"><h2><FileText /> config.toml</h2><p className="muted">脱敏查看。API Key、令牌和密码已隐藏。</p><pre className="code-view">{snapshot.config === null ? "（文件尚不存在）" : redactConfig(snapshot.config)}</pre></section>
              </>}
              {!snapshot && <button className="button full" disabled={busy} onClick={authorize}>重新授权目录</button>}
            </>}
          </>}

          {tab === "backups" && <>
            <div className="page-heading"><div><div className="eyebrow">LOCAL BACKUPS</div><h1>备份与恢复</h1></div><Archive className="heading-icon" /></div>
            <section className="panel"><h2><ShieldCheck /> 最近 10 次</h2><p className="muted">每次更改文件前保存备份，并用 Android Keystore 加密。备份绑定原目录；恢复会保留当前版本供再次恢复。</p></section>
            {state.pendingRecovery && <section className="panel warning-panel"><h2><AlertTriangle /> 上次写入未确认</h2><p>可能发生中断或写入失败。请先恢复写入前的文件，再继续切换。</p><button className="button danger" disabled={busy} onClick={() => restore()}>恢复写入前配置</button></section>}
            {!state.backups.length ? <section className="empty"><Archive /><h2>还没有文件备份</h2><p>首次应用服务商时会自动创建。</p></section> : state.backups.map(backup => <section className="backup-row" key={backup.id}><div><strong>{backup.reason}</strong><span>{date(backup.createdAt)} · {backup.directoryName}</span><small>{backup.existed ? "保存了原 config.toml" : "原 config.toml 不存在"}</small></div><button className="button" disabled={busy || backup.treeUri !== state.directory?.uri} onClick={() => restore(backup.id)}><RotateCcw /> 恢复</button></section>)}
          </>}

          {tab === "settings" && <>
            <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>设置</h1></div><SlidersHorizontal className="heading-icon" /></div>
            <section className="panel"><h2>界面缩放</h2><p className="muted">默认 200%。可以直接输入，或每次调整 10%。</p><div className="zoom-control"><button aria-label="缩小 10%" disabled={busy || state.settings.zoom <= 50} onClick={() => setZoom(state.settings.zoom - 10)}><Minus /></button><div><input type="number" inputMode="numeric" min={50} max={400} step={1} aria-label="缩放百分比" value={zoomInput} onChange={e => setZoomInput(e.target.value)} onBlur={() => { if (zoomInput !== String(state.settings.zoom)) void setZoom(Number(zoomInput)); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /><span>%</span></div><button aria-label="放大 10%" disabled={busy || state.settings.zoom >= 400} onClick={() => setZoom(state.settings.zoom + 10)}><Plus /></button></div><button className="text-button" disabled={busy} onClick={() => setZoom(200)}>恢复 200%</button></section>
            <section className="panel"><h2>外观</h2><div className="segmented">{([["light", "浅色", Sun], ["dark", "深色", Moon], ["system", "系统", Smartphone]] as const).map(([value, label, Icon]) => <button key={value} className={state.settings.theme === value ? "chosen" : ""} disabled={busy} onClick={() => action("保存外观…", () => saveSetting({ ...state.settings, theme: value }))}><Icon />{label}</button>)}</div><div className="setting-label"><span>语言</span><strong>简体中文</strong></div></section>
            <section className="panel"><h2>配置目录</h2><p className="muted">{state.directory ? `${state.directory.name} · ${state.directory.isCodexProvider ? "Codex 目录" : "普通 SAF 目录"}` : "尚未选择目录"}</p><button className="button full" disabled={busy} onClick={authorize}><FolderOpen /> {state.directory ? "重新授权 / 更换目录" : "选择目录"}</button>{state.directory && <button className="text-button danger-text" disabled={busy} onClick={() => action("解除目录授权…", async () => { setState(await invoke<AppState>("releaseDirectory")); setSnapshot(null); setNotice("目录授权已解除，本地方案与备份已保留。"); })}>解除目录授权</button>}</section>
            <section className="panel"><h2>导入与导出</h2><p className="muted">支持安卓版方案 JSON 和上游 Codex 供应商 JSON。导入后先检查，再应用。</p><button className="button full" disabled={busy} onClick={importFile}><Upload /> 导入方案</button><label className="checkbox-row"><input type="checkbox" checked={keysIncluded} onChange={e => setKeysIncluded(e.target.checked)} /><span>导出时包含 API Key（明文文件）</span></label><button className="button full" disabled={busy || !state.providers.length} onClick={() => action("等待选择导出位置…", async () => { await invoke("exportFile", { text: exportProviders(state.providers, keysIncluded) }); setNotice(keysIncluded ? "方案已导出并读回核对。文件包含明文 API Key，请妥善保管。" : "方案已导出并读回核对，未包含 API Key。导入后需要重新填写密钥。"); })}><Download /> 导出 {state.providers.length} 个方案</button></section>
            <section className="panel about"><div className="about-brand"><img src="./logo.svg" alt="" /><div><h2>CC Switch Android</h2><span>0.1.0 · Codex 专用</span></div></div><p className="muted">基于 CC Switch 4.0.33，由独立 Android 宿主提供目录访问。无需 PRoot 或存储管理权限。</p><button className="text-button" onClick={() => setDialog({ title: "开源许可", content: <><p>CC Switch · Copyright (c) 2025 Jason Young</p><p>本项目采用 MIT 许可证。保留了上游 Codex 模板、文本规范化函数、图标与设计 token；配置投影规则移植自上游 Rust 实现。</p><p>React · MIT<br />Lucide · ISC<br />smol-toml · BSD-3-Clause<br />AndroidX WebKit · Apache-2.0</p><pre className="license-text">{thirdPartyNotices}</pre><p className="license-text">Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:<br /><br />The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.<br /><br />THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p></> })}>开源许可与版权说明 <ChevronRight /></button></section>
          </>}
        </>}
      </main>
      <nav className="bottom-nav" aria-label="主导航">{([["providers", "服务商", Layers], ["current", "当前", FileText], ["backups", "备份", Archive], ["settings", "设置", Settings]] as const).map(([key, label, Icon]) => <button key={key} className={tab === key ? "nav-active" : ""} aria-current={tab === key ? "page" : undefined} disabled={busy} onClick={() => { setTab(key); window.scrollTo(0, 0); }}><Icon /><span>{label}</span></button>)}</nav>
      {busy && <div className="busy-indicator" role="status"><RefreshCw className="spin" />{busyLabel}</div>}
    </div>
    {editor && <Editor provider={editor} saveError={error} busy={busy} onClose={closeEditor} onSave={async provider => { await action("保存服务商方案…", async () => { const valid = validateProvider(provider); const existing = state.providers.some(p => p.id === valid.id); await saveProviders(existing ? state.providers.map(p => p.id === valid.id ? valid : p) : [...state.providers, valid]); setEditor(null); setNotice(state.native ? "方案已保存到本地。点击“应用”才会修改授权目录。" : "草稿已保存在本次预览内存中，关闭或刷新页面后清除。"); }); }} />}
    {dialog && <Modal title={dialog.title} busy={busy} onClose={closeDialog}><div className="modal-body">{error && <p className="inline-warning" role="alert">{error}</p>}{dialog.content}</div><footer className="modal-footer"><button className="button" disabled={busy} onClick={closeDialog}>{dialog.confirm ? "取消" : "关闭"}</button>{dialog.confirm && <button className={`button ${dialog.danger ? "danger" : "primary"}`} disabled={busy} onClick={() => action("正在处理…", dialog.confirm!)}>{dialog.confirmLabel ?? "确认"}</button>}</footer></Modal>}
  </div>;
}

function formDescription(provider: Provider) {
  try { const values = formValues(provider); return `${values.model} ${values.baseUrl}`; } catch { return ""; }
}

function Editor({ provider, onClose, onSave, busy, saveError }: { saveError: string; provider: Provider; onClose: () => void; onSave: (provider: Provider) => Promise<void>; busy: boolean }) {
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
        config = updateFormConfig(config, { name: draft.name, model: nextFields.model, baseUrl: nextFields.baseUrl, effort: nextFields.effort, envKey: draft.authKind === "env" ? nextFields.envKey : undefined });
        if (key === "apiKey") {
          config = patchPath(config, ["model_providers", "custom", "experimental_bearer_token"], undefined);
          config = patchPath(config, ["experimental_bearer_token"], undefined);
        }
      } else {
        config = patchPath(config, ["model"], nextFields.model || undefined);
        config = patchPath(config, ["model_reasoning_effort"], nextFields.effort || undefined);
      }
      setDraft({ ...draft, settingsConfig: { config, auth: { OPENAI_API_KEY: nextFields.apiKey } } });
      setError("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const changeKind = (kind: AuthKind) => {
    if (kind === "official" || draft.authKind === "official") {
      const next = newProvider(kind); next.id = draft.id; next.name = draft.name; next.notes = draft.notes;
      setDraft(next); setFields(formValues(next));
    } else setDraft({ ...draft, authKind: kind });
  };
  const submit = async () => {
    try {
      let result = structuredClone(draft);
      if (!rawMode && result.authKind !== "official") result.settingsConfig.config = updateFormConfig(result.settingsConfig.config, { name: result.name, model: fields.model, baseUrl: fields.baseUrl, effort: fields.effort, envKey: result.authKind === "env" ? fields.envKey : undefined });
      result = validateProvider(result);
      setError(""); await onSave(result);
    } catch (e) { setError(errorMessage(e)); }
  };
  return <Modal title={provider.name ? "编辑服务商" : "添加服务商"} busy={busy} onClose={onClose}>
    <div className="modal-body editor-body">
      {(error || saveError) && <p role="alert" className="inline-warning">{error || saveError}</p>}
      <label className="field"><span>名称 <em>*</em></span><input value={draft.name} maxLength={100} placeholder="例如：我的 API 服务" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="field"><span>认证方式</span><select value={draft.authKind} onChange={e => changeKind(e.target.value as AuthKind)}><option value="apiKey">API Key · 原生 Responses</option><option value="official">Codex 已有官方登录</option><option value="env">Codex 进程环境变量</option><option value="none">无认证服务</option></select></label>
      {draft.authKind === "official" && <p className="inline-info">切回 Codex 已有的官方登录。此处无法读取或切换钥匙串账号，登录需要在 Codex 中完成。</p>}
      <div className="segmented editor-tabs"><button className={!rawMode ? "chosen" : ""} onClick={() => { try { setFields(formValues(draft)); setRawMode(false); setError(""); } catch (e) { setError(errorMessage(e)); } }}>基本设置</button><button className={rawMode ? "chosen" : ""} onClick={() => setRawMode(true)}>高级 TOML</button></div>
      {!rawMode ? <>
        {draft.authKind !== "official" && <label className="field"><span>服务地址</span><input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://api.example.com/v1" value={fields.baseUrl} onChange={e => setField("baseUrl", e.target.value)} /><small>填写完整 API 基础地址，保留服务商要求的路径。</small></label>}
        {draft.authKind === "apiKey" && <label className="field"><span>API Key</span><div className="password-field"><input type={visible ? "text" : "password"} autoComplete="off" autoCapitalize="none" spellCheck={false} value={fields.apiKey} placeholder="输入 API Key" onChange={e => setField("apiKey", e.target.value)} /><button type="button" className="icon-button" aria-label={visible ? "隐藏 API Key" : "显示 API Key"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff /> : <Eye />}</button></div><small>方案密钥在本机加密保存。应用后写入 Codex 的服务商配置表。</small></label>}
        {draft.authKind === "env" && <label className="field"><span>环境变量名</span><input value={fields.envKey} placeholder="CODEX_API_KEY" autoCapitalize="none" onChange={e => setField("envKey", e.target.value)} /><small>需要 Codex 宿主预先注入。本应用只能保存变量名。</small></label>}
        {draft.authKind === "none" && <p className="inline-info">适用于明确无需认证的服务。不会发送 Codex 的官方登录凭据。</p>}
        <label className="field"><span>模型</span><input value={fields.model} placeholder={draft.authKind === "official" ? "留空使用 Codex 默认值" : "服务商支持的模型名称"} autoCapitalize="none" spellCheck={false} onChange={e => setField("model", e.target.value)} /></label>
        <label className="field"><span>推理强度</span><select value={fields.effort} onChange={e => setField("effort", e.target.value)}><option value="">Codex 默认</option>{["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(value => <option key={value}>{value}</option>)}</select><small>可用档位由服务商和模型决定。</small></label>
      </> : <label className="field"><span>供应商 config.toml</span><textarea className="toml-editor" rows={15} spellCheck={false} autoCapitalize="none" value={draft.settingsConfig.config} onChange={e => setDraft(editRawConfig(draft, e.target.value))} /><small>支持请求头、重试、上下文窗口、模型等原生参数。只投影服务商相关字段；模板中的 MCP、项目和用户设置不会覆盖现有配置。此编辑器可能含密钥。</small></label>}
      {draft.authKind !== "official" && <label className="field"><span>保留官方登录界面</span><select value={draft.loginPolicy} onChange={e => setDraft({ ...draft, loginPolicy: e.target.value as Provider["loginPolicy"] })}><option value="auto">自动 · 按 auth.json 中的登录材料</option><option value="keep">启用 · 我已在 Codex 中登录</option><option value="omit">关闭</option></select><small>钥匙串登录无法自动确认。此设置不迁移或删除账号。</small></label>}
      <label className="field"><span>备注</span><textarea rows={2} maxLength={2000} value={draft.notes ?? ""} placeholder="可选" onChange={e => setDraft({ ...draft, notes: e.target.value })} /></label>
    </div><footer className="modal-footer"><button className="button" disabled={busy} onClick={onClose}><ArrowLeft /> 返回</button><button className="button primary" disabled={busy} onClick={submit}><Check /> 保存方案</button></footer>
  </Modal>;
}
