import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  BookOpen,
  ChartColumn,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  History,
  Info,
  KeyRound,
  Menu,
  Minus,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Sidebar } from "./components/shell/Sidebar";
import { AppPageHeader } from "./components/shell/AppPageHeader";
import { AppGlyph } from "./components/shell/AppGlyph";
import { SkillsIcon } from "./components/BrandIcons";
import { Button } from "./components/ui/button";
import { SegmentedControl } from "./components/ui/segmented-control";
import { Switch } from "./components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import PromptListItem from "./components/prompts/PromptListItem";
import { useQueryClient } from "@tanstack/react-query";
import { resetAndroidData } from "./android/commands";
import { DataStatus } from "./android/DataStatus";
import { SessionManagerPage } from "./vendor/components/sessions/SessionManagerPage";
import { UsagePage } from "./vendor/components/usage/UsagePage";
import {
  prepareFilteredProvider,
  FilterStatusPanel,
} from "./android/FilterControl";
import { ProviderEditor, Modal } from "./ProviderEditor";
import { invoke, isNative } from "./bridge";
import {
  captureCurrent,
  initialProviderSetup,
  providerEditorView,
  planProviderEditorGlobals,
  exportProviders,
  formValues,
  importProviders,
  matchProvider,
  newProvider,
  planApply,
  readSummary,
  redactConfig,
  validateProvider,
} from "./core/codex";
import type {
  AppState,
  Provider,
  ProviderEditorBase,
  Snapshot,
} from "./core/types";
import type { Prompt } from "./lib/api";
import type { SettingsSection, View } from "./lib/navigation";
import {
  aggregateUsage,
  changeMcp,
  mcpServers,
  parseMcpImport,
  parseSession,
  parseSessionIndex,
  skillMetadata,
  validateMcp,
  type Catalog,
  type DocumentFile,
  type SessionData,
  type SessionSummary,
  type TextDocument,
} from "./core/workspace";
import thirdPartyNotices from "../THIRD_PARTY_NOTICES.txt?raw";
import logo from "./assets/icons/logo.svg";

const EMPTY: AppState = {
  providers: [],
  backups: [],
  prompts: [],
  documentBackups: [],
  pendingDocuments: [],
  directory: null,
  pendingRecovery: false,
  settings: { zoom: 100, theme: "system" },
  native: isNative,
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
const date = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
const number = (value: number) => new Intl.NumberFormat("zh-CN").format(value);
type Dialog = {
  title: string;
  body: ReactNode;
  confirm?: () => Promise<void>;
  label?: string;
  danger?: boolean;
};
type PickerStatus = {
  codexProviderInstalled: boolean;
  pickerAvailable: boolean;
  pickerPackage: string;
  message: string;
};
type McpEditor = { original?: string; name: string; json: string };
type PromptEditor = { draft: Prompt };
type SkillEditor = {
  file: TextDocument;
  draft: string;
  folder: string;
  create: boolean;
};
const PAGE_NAMES: Record<View, string> = {
  providers: "Codex",
  mcp: "MCP",
  skills: "Skills",
  prompts: "提示词",
  sessions: "会话",
  auth: "授权中心",
  usage: "用量统计",
  apps: "应用",
  settings: "设置",
};
const PAGE_ICONS = {
  mcp: Server,
  skills: SkillsIcon,
  prompts: BookOpen,
  sessions: History,
  auth: KeyRound,
  usage: ChartColumn,
  apps: Smartphone,
  settings: Settings,
};

function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function More({
  label,
  items,
}: {
  label: string;
  items: {
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="quiet" size="icon" aria-label={label}>
          <MoreHorizontal size={17} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            disabled={item.disabled}
            key={item.label}
            className={item.danger ? "text-danger-text" : ""}
            onSelect={item.onClick}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AppState>(EMPTY);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("providers");
  const [section, setSection] = useState<SettingsSection>("general");
  const [mobileNav, setMobileNav] = useState(false);
  const [busy, setBusy] = useState(false),
    [busyLabel, setBusyLabel] = useState("");
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [providerEditor, setProviderEditor] = useState<Provider | null>(null);
  const [providerShown, setProviderShown] = useState<Provider | null>(null);
  const [providerBase, setProviderBase] = useState<
    ProviderEditorBase | undefined
  >();
  const [providerLoadNotice, setProviderLoadNotice] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [mcpEditor, setMcpEditor] = useState<McpEditor | null>(null);
  const [promptEditor, setPromptEditor] = useState<PromptEditor | null>(null),
    [skillEditor, setSkillEditor] = useState<SkillEditor | null>(null);
  const [promptFile, setPromptFile] = useState<TextDocument | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null);
  const [session, setSession] = useState<{
    file: DocumentFile;
    parsed: SessionSummary;
  } | null>(null);
  const [usageRows, setUsageRows] = useState<SessionSummary[]>([]),
    [usageScanned, setUsageScanned] = useState(false);
  const [usageErrors, setUsageErrors] = useState(0),
    [usageLimit, setUsageLimit] = useState(false);
  const [picker, setPicker] = useState<PickerStatus | null>(null),
    [zoomInput, setZoomInput] = useState("100");
  const [keysIncluded, setKeysIncluded] = useState(false),
    [providerTab, setProviderTab] = useState<"list" | "current">("list");
  const [skillsMeta, setSkillsMeta] = useState<
    Record<string, { name: string; description: string }>
  >({});

  const action = async (label: string, work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setBusyLabel(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e: any) {
      if (e?.code !== "cancelled") setError(message(e));
      if (isNative)
        try {
          setState(await invoke<AppState>("bootstrap"));
        } catch {}
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const initializeProviders = async (next: AppState, live: Snapshot) => {
    if (!isNative || next.providerInitialization === 1) return next;
    const setup = initialProviderSetup(next, live);
    const result = await invoke<AppState>("initializeProviders", {
      expectedRevision: live.revision,
      expectedProviderIds: next.providers.map((p) => p.id),
      additions: setup.additions,
      importedId: setup.importedId,
    });
    if (setup.warnings.length) setError(setup.warnings.join(" "));
    return result;
  };
  const refresh = async () => {
    try {
      const live = await invoke<Snapshot>("readCurrent");
      setSnapshot(live);
      setState(
        await initializeProviders(await invoke<AppState>("bootstrap"), live),
      );
      return live;
    } catch (e) {
      setSnapshot(null);
      throw e;
    }
  };
  const openProviderEditor = (provider: Provider) =>
    action("读取当前配置…", async () => {
      setProviderShown(provider);
      setProviderBase(undefined);
      setProviderLoadNotice("");
      if (state.directory) {
        try {
          const live = await invoke<Snapshot>("readCurrent");
          setSnapshot(live);
          const shown = providerEditorView(live, provider);
          setProviderShown(shown);
          setProviderBase({
            snapshot: live,
            config: shown.settingsConfig.config,
          });
        } catch (e) {
          setProviderLoadNotice(
            "无法读取当前 Codex 配置，下面显示保存的方案或上游默认模板：" +
              message(e),
          );
        }
      } else {
        setProviderLoadNotice(
          "尚未授权 Codex 目录，当前显示上游默认模板或保存的方案。连接目录后重新打开，将带入完整 config.toml（含 MCP、插件和项目设置）。",
        );
      }
      setProviderEditor(provider);
    });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await invoke<AppState>("bootstrap");
        if (!alive) return;
        setState(next);
        setZoomInput(String(next.settings.zoom));
        setPicker(await invoke<PickerStatus>("providerStatus"));
        if (next.directory) {
          const current = await invoke<Snapshot>("readCurrent");
          if (alive) {
            setSnapshot(current);
            const initialized = await initializeProviders(next, current);
            if (alive) setState(initialized);
          }
        }
      } catch (e) {
        if (alive) setError(message(e));
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () =>
      document.documentElement.classList.toggle(
        "dark",
        state.settings.theme === "dark" ||
          (state.settings.theme === "system" && media.matches),
      );
    sync();
    media.addEventListener("change", sync);
    document.documentElement.style.setProperty(
      "--zoom",
      String(state.settings.zoom / 100),
    );
    document.body.style.zoom = String(state.settings.zoom / 100);
    const size = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        window.innerHeight / (state.settings.zoom / 100) + "px",
      );
    size();
    window.addEventListener("resize", size);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("resize", size);
    };
  }, [state.settings]);
  useEffect(() => {
    resetAndroidData();
    queryClient.removeQueries({ queryKey: ["sessions"] });
    queryClient.removeQueries({ queryKey: ["usage"] });
  }, [state.directory?.uri, queryClient]);
  const navigate = (next: View) => {
    if (busyRef.current) return;
    setView(next);
    setMobileNav(false);
    setQuery("");
    setSession(null);
    setError("");
  };
  useEffect(() => {
    if (!state.directory || !["prompts", "skills"].includes(view)) return;
    let alive = true;
    setCatalog(null);
    (async () => {
      try {
        if (view === "prompts") {
          const doc = await invoke<TextDocument>("readDocument", {
            path: "AGENTS.md",
          });
          if (alive) setPromptFile(doc);
        } else {
          const result = await invoke<Catalog>("catalog", { kind: view });
          if (alive) setCatalog(result);
        }
      } catch (e) {
        if (alive) setError(message(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [view, state.directory?.uri]);
  useEffect(() => {
    window.__ccswitchBack = () => {
      if (busyRef.current) return true;
      if (document.querySelector("[role=dialog][data-state=open]")) {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        return true;
      }
      if (dialog) {
        setDialog(null);
        return true;
      }
      if (providerEditor || promptEditor || mcpEditor || skillEditor) {
        setProviderEditor(null);
        setPromptEditor(null);
        setMcpEditor(null);
        setSkillEditor(null);
        return true;
      }
      if (mobileNav) {
        setMobileNav(false);
        return true;
      }
      if (session) {
        setSession(null);
        return true;
      }
      if (view !== "providers") {
        navigate("providers");
        return true;
      }
      return false;
    };
    return () => {
      delete window.__ccswitchBack;
    };
  }, [
    view,
    dialog,
    providerEditor,
    promptEditor,
    mcpEditor,
    skillEditor,
    mobileNav,
    session,
  ]);
  const authorize = () =>
    action("等待系统目录授权…", async () => {
      const next = await invoke<AppState>("chooseDirectory");
      setState(next);
      setSnapshot(null);
      setPromptFile(null);
      setCatalog(null);
      setUsageRows([]);
      setUsageScanned(false);
      const live = await invoke<Snapshot>("readCurrent");
      setSnapshot(live);
      setState(await initializeProviders(next, live));
      setNotice(
        next.directory?.isCodexProvider
          ? "已授权 Codex 文档目录。可直接切换配置，完成后重启 Codex 生效。"
          : "已授权普通 SAF 目录；对此目录的验证不代表已接通 Codex。",
      );
    });
  const saveProviders = async (providers: Provider[]) =>
    setState(await invoke<AppState>("saveProviders", { providers }));
  const savePrompts = async (prompts: Prompt[]) =>
    setState(await invoke<AppState>("savePrompts", { prompts }));
  const applyProvider = (provider: Provider) =>
    action("正在备份、写入并读回核对…", async () => {
      if (!snapshot) throw new Error("请先授权目录并读取配置。");
      planApply(snapshot, provider);
      const routed = await prepareFilteredProvider(provider);
      const plan = planApply(snapshot, routed);
      const result = await invoke<{ state: AppState; snapshot: Snapshot }>(
        "apply",
        {
          providerId: provider.id,
          config: plan.config,
          catalog: plan.catalog,
          ownership: plan.ownership,
          expectedRevision: snapshot.revision,
        },
      );
      let stopWarning = "";
      if (!provider.historyFilter) {
        try {
          await invoke("stopFilter");
        } catch {
          stopWarning = "配置已恢复直连，但停止中转服务失败，请检查运行状态。";
        }
      }
      setState(result.state);
      setSnapshot(result.snapshot);
      setNotice(
        "文件保存成功并已读回核对。请完全重启 Codex，在新会话确认服务商与模型。" +
          plan.warnings.join(" ") +
          stopWarning,
      );
    });
  const previewProvider = (provider: Provider) => {
    try {
      if (!snapshot) throw new Error("请先读取当前配置。");
      const plan = planApply(snapshot, provider);
      setDialog({
        title: "应用前预览",
        body: (
          <>
            <p>
              将修改：{plan.changedFields.join("、") || "内容已一致"}
              。密钥已隐藏。
            </p>
            {plan.warnings.map((w) => (
              <p key={w} className="inline-warning">
                {w}
              </p>
            ))}
            <pre className="code-view">{redactConfig(plan.config)}</pre>
          </>
        ),
      });
    } catch (e) {
      setError(message(e));
    }
  };
  const importFile = () =>
    action("选择导入文件…", async () => {
      const file = await invoke<{ text: string }>("importFile");
      const imported = importProviders(file.text);
      if (imported.providers.length + state.providers.length > 200)
        throw new Error("导入后超过 200 套方案限制。");
      setDialog({
        title: "导入供应商",
        body: (
          <>
            <p>
              添加 {imported.providers.map((p) => p.name).join("、")}
              。已有方案保留。
            </p>
            {imported.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </>
        ),
        label: "导入",
        confirm: async () => {
          await saveProviders([...state.providers, ...imported.providers]);
          setDialog(null);
          setNotice("导入成功，请检查配置后应用。");
        },
      });
    });
  const restoreConfig = (id?: string) =>
    setDialog({
      title: "恢复配置",
      body: (
        <p>
          恢复整个 config.toml，包括备份中的 MCP
          和用户设置。先备份当前文件，再写入并核验。auth.json
          与钥匙串保持原样；之后请重启 Codex。
        </p>
      ),
      label: "备份当前并恢复",
      danger: true,
      confirm: async () => {
        const live = await invoke<{ revision: string }>("readRevision");
        const result = await invoke<{ state: AppState; snapshot: Snapshot }>(
          id ? "restore" : "recover",
          { id, expectedRevision: live.revision },
        );
        setState(result.state);
        setSnapshot(result.snapshot);
        setDialog(null);
        setNotice("配置已恢复并读回核对。请重启 Codex。");
      },
    });
  const restoreDocument = (id: string | undefined, path: string) =>
    setDialog({
      title: "恢复文档",
      body: <p>将恢复 {path} 的完整内容，恢复前备份当前版本。</p>,
      label: "恢复",
      danger: true,
      confirm: async () => {
        const live = await invoke<{ hash: string }>("readDocumentRevision", {
          path,
        });
        await invoke("restoreDocument", {
          id,
          path,
          recover: !id,
          expectedHash: live.hash,
        });
        setState(await invoke<AppState>("bootstrap"));
        setPromptFile(null);
        setDialog(null);
        setNotice("文档已恢复并读回核对，请在 Codex 新会话中确认。");
      },
    });
  const saveMcp = async (
    name: string,
    value: Record<string, any> | undefined,
  ) => {
    if (!snapshot) throw new Error("请先读取 config.toml。");
    const config = changeMcp(snapshot.config ?? "", name, value);
    const result = await invoke<{ state: AppState; snapshot: Snapshot }>(
      "editMcp",
      { config, expectedRevision: snapshot.revision },
    );
    setState(result.state);
    setSnapshot(result.snapshot);
    setMcpEditor(null);
    setNotice("MCP 配置已保存并核验。请重启 Codex 以重新加载服务。");
  };
  const togglePrompt = (prompt: Prompt, enabled: boolean) => {
    if (!promptFile) {
      setError("请先授权目录并读取 AGENTS.md。");
      return;
    }
    setDialog({
      title: enabled ? "启用提示词" : "停用提示词",
      body: (
        <p>
          {enabled
            ? "将此提示词写入完整 AGENTS.md。现有文档先备份，可在设置 → 数据中恢复。"
            : "将清空当前 AGENTS.md；清空前备份完整文档。"}
          Codex 需要在新会话重新读取。
        </p>
      ),
      label: enabled ? "备份并启用" : "备份并停用",
      confirm: async () => {
        const result = await invoke<TextDocument>("saveDocument", {
          path: "AGENTS.md",
          text: enabled ? prompt.content : "",
          expectedHash: promptFile.hash,
        });
        setPromptFile(result);
        setState(await invoke<AppState>("bootstrap"));
        setDialog(null);
        setNotice("AGENTS.md 已保存并核验。请新建 Codex 会话。");
      },
    });
  };
  const openSkill = (file: DocumentFile) =>
    action("读取技能文档…", async () => {
      const doc = await invoke<TextDocument>("readDocument", {
        path: file.path,
      });
      setSkillEditor({
        file: doc,
        draft: doc.text ?? "",
        folder: file.path.split("/").slice(1, -1).join("/"),
        create: false,
      });
      try {
        setSkillsMeta((current) => ({
          ...current,
          [file.path]: skillMetadata(doc.text ?? ""),
        }));
      } catch {}
    });
  const importSkill = () =>
    action("选择 SKILL.md…", async () => {
      const source = await invoke<{ text: string }>("importFile");
      const meta = skillMetadata(source.text);
      const folder =
        meta.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "my-skill";
      setSkillEditor({
        file: { path: "", text: null, hash: "" },
        draft: source.text,
        folder,
        create: true,
      });
    });
  const openSession = (file: DocumentFile) =>
    action("读取会话…", async () => {
      const data = await invoke<SessionData>("readSession", {
        path: file.path,
      });
      setSession({ file, parsed: parseSession(data) });
    });
  const scanUsage = () =>
    action("扫描会话用量…", async () => {
      const files = await invoke<Catalog>("catalog", { kind: "sessions" });
      const rows: SessionSummary[] = [];
      let errors = 0;
      // A single explicit scan stays bounded; other files remain available in Sessions.
      for (const [i, file] of files.files.slice(0, 50).entries()) {
        setBusyLabel(
          "扫描用量 " + (i + 1) + " / " + Math.min(files.files.length, 50),
        );
        try {
          rows.push(
            parseSession(
              await invoke<SessionData>("readSession", {
                path: file.path,
                usageOnly: true,
              }),
            ),
          );
        } catch {
          errors++;
        }
      }
      setUsageRows(rows);
      setUsageErrors(errors);
      setUsageLimit(
        files.truncated ||
          files.files.length > 50 ||
          rows.some((row) => row.partial),
      );
      setUsageScanned(true);
    });
  const setZoom = (value: number) =>
    action("保存缩放…", async () => {
      if (!Number.isFinite(value) || value < 50 || value > 400) {
        setZoomInput(String(state.settings.zoom));
        throw new Error("缩放范围为 50–400%。");
      }
      const next = await invoke<AppState>("settings", {
        ...state.settings,
        zoom: Math.round(value),
      });
      setState(next);
      setZoomInput(String(next.settings.zoom));
    });
  const closeProvider = useCallback(() => setProviderEditor(null), []);
  const filtered = state.providers.filter((p) =>
    [p.name, p.notes, p.settingsConfig.config]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const prompts = (state.prompts ?? []).filter((p) =>
    [p.name, p.description]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  let summary: ReturnType<typeof readSummary> | null = null,
    configError = "";
  let mcps: ReturnType<typeof mcpServers> = [];
  try {
    if (snapshot) {
      summary = readSummary(snapshot);
      mcps = mcpServers(snapshot.config ?? "");
    }
  } catch (e) {
    configError = message(e);
  }
  const Icon = view === "providers" ? null : PAGE_ICONS[view];
  const grant = (
    <Empty
      icon={<FolderOpen size={28} />}
      title="连接 Codex 配置目录"
      action={
        <Button onClick={authorize} disabled={busy}>
          <FolderOpen size={16} /> 选择目录
        </Button>
      }
    >
      {picker?.message ??
        "在系统文件选择器中选择 Codex → .codex，然后使用此文件夹。"}
    </Empty>
  );
  const currentPrompt = (state.prompts ?? []).find(
    (p) => p.content === promptFile?.text && p.content.length > 0,
  );
  const totals = aggregateUsage(usageRows);
  const sessionNames = parseSessionIndex(catalog?.index ?? "");
  const headerActions =
    view === "providers" ? (
      <>
        <More
          label="供应商操作"
          items={[
            {
              label: "从当前配置导入",
              disabled: !snapshot,
              onClick: () => {
                try {
                  openProviderEditor(captureCurrent(snapshot!, "当前配置"));
                } catch (e) {
                  setError(message(e));
                }
              },
            },
            { label: "导入方案文件", onClick: importFile },
            { label: "连接目录", onClick: authorize },
          ]}
        />
        <Button
          size="icon"
          aria-label="添加供应商"
          onClick={() => openProviderEditor(newProvider())}
        >
          <Plus size={18} />
        </Button>
      </>
    ) : view === "mcp" ? (
      <Button
        size="icon"
        aria-label="添加 MCP"
        disabled={!snapshot || busy}
        onClick={() =>
          setMcpEditor({
            name: "",
            json: '{\n  "command": "npx",\n  "args": ["-y", "your-mcp-server"]\n}',
          })
        }
      >
        <Plus size={18} />
      </Button>
    ) : view === "prompts" ? (
      <Button
        size="icon"
        aria-label="添加提示词"
        onClick={() =>
          setPromptEditor({
            draft: {
              id: crypto.randomUUID(),
              name: "",
              content: "",
              updatedAt: Date.now(),
            },
          })
        }
      >
        <Plus size={18} />
      </Button>
    ) : view === "skills" ? (
      <Button
        size="icon"
        aria-label="导入技能"
        disabled={!state.directory}
        onClick={importSkill}
      >
        <Plus size={18} />
      </Button>
    ) : null;

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className={"sidebar-host " + (mobileNav ? "is-open" : "")}>
        <Sidebar
          activeApp="codex"
          view={view}
          settingsSection={section}
          onSelectApp={() => navigate("providers")}
          onSelectPage={navigate}
          onSelectSettingsSection={(value) => {
            setSection(value);
            setMobileNav(false);
          }}
          onExitSettings={() => navigate("providers")}
        />
      </div>
      <div id="content-area" className="content-area">
        <AppPageHeader
          className="android-page-header"
          leading={
            <Button
              className="mobile-menu"
              variant="quiet"
              size="icon"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </Button>
          }
          icon={
            view === "providers" ? (
              <AppGlyph size={20} />
            ) : Icon ? (
              <Icon className="h-5 w-5" />
            ) : null
          }
          title={session ? "会话" : PAGE_NAMES[view]}
          subtitle={view === "providers" ? "供应商" : undefined}
          variant={view === "providers" ? "app" : "page"}
          actions={headerActions}
        />
        <main id="main-content" className="page-scroll" aria-busy={busy}>
          {!ready && <p className="muted">正在读取本地数据…</p>}
          {!state.native && (
            <p className="preview-note">
              浏览器预览 · 目录读写与加密保存需安装 APK
            </p>
          )}
          {(error || configError) && (
            <div className="notice error" role="alert">
              <AlertTriangle size={18} />
              <span>{error || configError}</span>
              <Button
                variant="quiet"
                size="icon"
                aria-label="关闭提示"
                onClick={() => setError("")}
              >
                <X size={15} />
              </Button>
            </div>
          )}
          {notice && (
            <div className="notice success" role="status">
              <Check size={18} />
              <span>{notice}</span>
              <Button
                variant="quiet"
                size="icon"
                aria-label="关闭通知"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </Button>
            </div>
          )}
          {state.pendingRecovery && (
            <div className="notice warning">
              <AlertTriangle size={18} />
              <span>配置有未确认写入，请先恢复。</span>
              <Button variant="neutral" onClick={() => restoreConfig()}>
                恢复
              </Button>
            </div>
          )}
          {view === "providers" && (
            <>
              <div className="page-toolbar">
                <SegmentedControl
                  aria-label="供应商视图"
                  value={providerTab}
                  onValueChange={setProviderTab}
                  items={[
                    { value: "list", label: "供应商" },
                    { value: "current", label: "当前配置" },
                  ]}
                />
                <Button
                  variant="quiet"
                  size="icon"
                  aria-label="刷新当前配置"
                  disabled={!state.directory || busy}
                  onClick={() =>
                    action("读取配置…", async () => {
                      await refresh();
                    })
                  }
                >
                  <RefreshCw size={16} />
                </Button>
              </div>
              {!state.directory ? (
                <div className="connection-row">
                  <FolderOpen size={17} />
                  <span>尚未连接 Codex 目录</span>
                  <Button variant="neutral" size="compact" onClick={authorize}>
                    连接
                  </Button>
                </div>
              ) : (
                <div className="connection-row">
                  <span className="status-dot" />
                  <span>
                    {state.directory.name}
                    <small>
                      {state.directory.isCodexProvider
                        ? "Codex 文档提供方"
                        : "普通 / 测试 SAF 目录"}
                    </small>
                  </span>
                  <Button
                    variant="quiet"
                    size="icon"
                    aria-label="查看目录授权"
                    onClick={() => {
                      navigate("settings");
                      setSection("appConfig");
                    }}
                  >
                    <ChevronRight size={16} />
                  </Button>
                </div>
              )}
              {providerTab === "list" ? (
                <>
                  <div className="search">
                    <Search size={16} />
                    <input
                      aria-label="搜索供应商"
                      placeholder="搜索供应商…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  {!filtered.length ? (
                    <Empty
                      icon={<AppGlyph size={32} />}
                      title={
                        query ? "没有匹配的供应商" : "添加你的第一个供应商"
                      }
                      action={
                        !query ? (
                          <Button
                            variant="neutral"
                            onClick={() => openProviderEditor(newProvider())}
                          >
                            <Plus size={16} />
                            添加供应商
                          </Button>
                        ) : undefined
                      }
                    >
                      管理服务地址、API Key 和模型，在保存的配置间切换。
                    </Empty>
                  ) : (
                    <div className="provider-list">
                      {filtered.map((provider) => {
                        const values = formValues(provider);
                        const isCurrent =
                          state.currentProviderId === provider.id;
                        const match = snapshot
                          ? matchProvider(snapshot, provider)
                          : "none";
                        return (
                          <article
                            className={
                              "provider-row " +
                              (match === "exact" || isCurrent ? "current" : "")
                            }
                            key={provider.id}
                          >
                            <div className="provider-identity">
                              <span className="provider-glyph">
                                {provider.authKind === "official" ? (
                                  <AppGlyph size={21} />
                                ) : (
                                  <Server size={21} />
                                )}
                              </span>
                              <div className="min-w-0">
                                <div className="row-title">
                                  <strong>{provider.name}</strong>
                                  {(match === "exact" || isCurrent) && (
                                    <span className="badge success">
                                      {isCurrent ? "当前方案" : "当前文件"}
                                    </span>
                                  )}
                                </div>
                                <p className="truncate muted">
                                  {values.baseUrl || "Codex 官方登录"}
                                </p>
                                <div className="row-meta">
                                  <span>{values.model || "默认模型"}</span>
                                  <span>
                                    {provider.authKind === "apiKey"
                                      ? "API Key"
                                      : provider.authKind === "official"
                                        ? "官方"
                                        : "自定义认证"}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="row-actions">
                              <Button
                                variant="neutral"
                                size="compact"
                                disabled={
                                  busy ||
                                  !snapshot ||
                                  !!configError ||
                                  state.pendingRecovery
                                }
                                onClick={() => applyProvider(provider)}
                              >
                                {match === "exact" ? <Check size={14} /> : null}
                                {match === "exact" ? "已启用" : "启用"}
                              </Button>
                              <Button
                                variant="quiet"
                                size="icon"
                                aria-label={"编辑 " + provider.name}
                                disabled={busy}
                                onClick={() => openProviderEditor(provider)}
                              >
                                <Pencil size={15} />
                              </Button>
                              <More
                                label={provider.name + " 更多操作"}
                                items={[
                                  {
                                    label: "预览修改",
                                    disabled: !snapshot,
                                    onClick: () => previewProvider(provider),
                                  },
                                  {
                                    label: "复制配置",
                                    onClick: () => {
                                      openProviderEditor({
                                        ...structuredClone(provider),
                                        id: crypto.randomUUID(),
                                        name: provider.name + " 副本",
                                      });
                                    },
                                  },
                                  {
                                    label: "删除方案",
                                    danger: true,
                                    onClick: () =>
                                      setDialog({
                                        title: "删除供应商",
                                        body: (
                                          <p>
                                            删除本地方案“{provider.name}”。当前
                                            Codex 配置仍保留。
                                          </p>
                                        ),
                                        label: "删除",
                                        danger: true,
                                        confirm: async () => {
                                          await saveProviders(
                                            state.providers.filter(
                                              (p) => p.id !== provider.id,
                                            ),
                                          );
                                          setDialog(null);
                                        },
                                      }),
                                  },
                                ]}
                              />
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : !state.directory ? (
                grant
              ) : (
                <>
                  <Panel title="当前配置">
                    {summary && snapshot ? (
                      <>
                        <dl className="details">
                          <div>
                            <dt>供应商</dt>
                            <dd>{summary.providerId}</dd>
                          </div>
                          <div>
                            <dt>模型</dt>
                            <dd>{summary.model}</dd>
                          </div>
                          <div>
                            <dt>认证存储</dt>
                            <dd>{summary.auth.mode}</dd>
                          </div>
                          <div>
                            <dt>运行中生效</dt>
                            <dd>需重启后确认</dd>
                          </div>
                        </dl>
                        <p className="muted">{summary.auth.state}</p>
                        <Button
                          variant="neutral"
                          onClick={() => {
                            try {
                              openProviderEditor(
                                captureCurrent(snapshot, "当前配置"),
                              );
                            } catch (e) {
                              setError(message(e));
                            }
                          }}
                        >
                          保存为方案
                        </Button>
                      </>
                    ) : (
                      <p>请刷新当前配置。</p>
                    )}
                  </Panel>
                  <Panel title="config.toml · 脱敏查看">
                    <pre className="code-view">
                      {snapshot?.config == null
                        ? "文件尚不存在，启用供应商时创建。"
                        : redactConfig(snapshot.config)}
                    </pre>
                  </Panel>
                </>
              )}
              <p className="page-note">
                文件写入成功后，请完全重启 Codex，并在新会话确认配置。
              </p>
            </>
          )}
          {view === "mcp" && (
            <>
              {!state.directory ? (
                grant
              ) : (
                <>
                  <div className="page-toolbar">
                    <span className="muted">Codex · {mcps.length} 个服务</span>
                    <Button
                      variant="neutral"
                      disabled={!snapshot || busy}
                      onClick={() =>
                        action("导入 MCP…", async () => {
                          const file = await invoke<{ text: string }>(
                            "importFile",
                          );
                          const entries = parseMcpImport(file.text);
                          if (!snapshot) throw new Error("请刷新配置。");
                          let config = snapshot.config ?? "";
                          for (const [name, value] of entries) {
                            if (mcps.some(([key]) => key === name))
                              throw new Error(
                                "MCP 名称已存在：" +
                                  name +
                                  "。请通过编辑修改，以免覆盖内置服务。",
                              );
                            config = changeMcp(config, name, value);
                          }
                          const target = config;
                          setDialog({
                            title: "导入 MCP",
                            body: (
                              <p>
                                新增 {entries.map(([name]) => name).join("、")}
                                ，保留所有已存在服务。
                              </p>
                            ),
                            label: "导入",
                            confirm: async () => {
                              const result = await invoke<{
                                state: AppState;
                                snapshot: Snapshot;
                              }>("editMcp", {
                                config: target,
                                expectedRevision: snapshot.revision,
                              });
                              setState(result.state);
                              setSnapshot(result.snapshot);
                              setDialog(null);
                              setNotice("MCP 已导入并核验，请重启 Codex。");
                            },
                          });
                        })
                      }
                    >
                      <Upload size={15} />
                      导入
                    </Button>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="刷新 MCP"
                      onClick={() =>
                        action("读取 MCP…", async () => {
                          await refresh();
                        })
                      }
                    >
                      <RefreshCw size={16} />
                    </Button>
                  </div>
                  {mcps.length ? (
                    <div className="list-panel">
                      {mcps.map(([name, config]) => (
                        <div className="list-row" key={name}>
                          <Server size={20} />
                          <div className="min-w-0 grow">
                            <strong>{name}</strong>
                            <p className="muted truncate">
                              {config.command || config.url}
                            </p>
                            <span className="badge">
                              {config.command ? "stdio" : "HTTP"}
                            </span>
                          </div>
                          <Switch
                            checked={config.enabled !== false}
                            aria-label={"启用 " + name}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              action("更新 MCP…", () =>
                                saveMcp(name, { ...config, enabled: checked }),
                              )
                            }
                          />
                          <More
                            label={name + " 操作"}
                            items={[
                              {
                                label: "编辑",
                                onClick: () =>
                                  setMcpEditor({
                                    original: name,
                                    name,
                                    json: JSON.stringify(config, null, 2),
                                  }),
                              },
                              {
                                label: "删除",
                                danger: true,
                                onClick: () =>
                                  setDialog({
                                    title: "删除 MCP",
                                    body: (
                                      <p>
                                        从 config.toml 删除 {name}，可能影响
                                        Codex 的工具能力。操作前自动备份。
                                      </p>
                                    ),
                                    label: "删除",
                                    danger: true,
                                    confirm: async () => {
                                      await saveMcp(name, undefined);
                                      setDialog(null);
                                    },
                                  }),
                              },
                            ]}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<Server size={28} />} title="尚无 MCP 服务">
                      添加 stdio 或 HTTP 服务。命令由 Codex 环境执行。
                    </Empty>
                  )}
                  <p className="page-note">
                    显示授权目录中的完整 MCP
                    列表；编辑某项时保留其他服务、模型和用户设置。OAuth 授权须在
                    Codex 内完成。
                  </p>
                </>
              )}
            </>
          )}
          {view === "prompts" && (
            <>
              <div className="page-toolbar">
                <span className="muted">Codex · AGENTS.md</span>
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    action("导入提示词…", async () => {
                      const file = await invoke<{ text: string }>("importFile");
                      setPromptEditor({
                        draft: {
                          id: crypto.randomUUID(),
                          name: "导入的提示词",
                          content: file.text,
                          updatedAt: Date.now(),
                        },
                      });
                    })
                  }
                >
                  <Upload size={15} />
                  导入
                </Button>
              </div>
              {!state.directory && (
                <div className="connection-row">
                  <FolderOpen size={16} />
                  <span>连接目录后可启用提示词</span>
                  <Button variant="neutral" size="compact" onClick={authorize}>
                    连接
                  </Button>
                </div>
              )}
              {state.directory && (
                <Panel title="当前提示词">
                  <p>
                    {promptFile
                      ? currentPrompt
                        ? currentPrompt.name
                        : promptFile.text
                          ? "外部 / 自定义 AGENTS.md"
                          : "尚未写入提示词"
                      : "正在读取 AGENTS.md…"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="neutral"
                      disabled={!promptFile}
                      onClick={() =>
                        setDialog({
                          title: "当前 AGENTS.md",
                          body: (
                            <pre className="code-view">
                              {promptFile?.text ?? "文件不存在"}
                            </pre>
                          ),
                        })
                      }
                    >
                      查看
                    </Button>
                    <Button
                      variant="neutral"
                      disabled={!promptFile?.text}
                      onClick={() =>
                        setPromptEditor({
                          draft: {
                            id: crypto.randomUUID(),
                            name: "从当前导入",
                            content: promptFile?.text ?? "",
                            updatedAt: Date.now(),
                          },
                        })
                      }
                    >
                      保存到提示库
                    </Button>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="刷新提示词"
                      onClick={() =>
                        action("读取 AGENTS.md…", async () =>
                          setPromptFile(
                            await invoke("readDocument", { path: "AGENTS.md" }),
                          ),
                        )
                      }
                    >
                      <RefreshCw size={16} />
                    </Button>
                  </div>
                </Panel>
              )}
              {prompts.length ? (
                <ul className="list-panel prompt-list">
                  {prompts.map((prompt, i) => (
                    <PromptListItem
                      key={prompt.id}
                      id={prompt.id}
                      prompt={prompt}
                      active={currentPrompt?.id === prompt.id}
                      detail={
                        prompt.description ||
                        prompt.content
                          .split("\n")
                          .find((line) => line.trim()) ||
                        date(prompt.updatedAt)
                      }
                      first={i === 0}
                      disabled={busy}
                      onToggle={(_id, enabled) => togglePrompt(prompt, enabled)}
                      onEdit={() =>
                        setPromptEditor({ draft: structuredClone(prompt) })
                      }
                      onDelete={() =>
                        setDialog({
                          title: "删除提示词",
                          body: <p>删除本地提示词“{prompt.name}”。</p>,
                          label: "删除",
                          danger: true,
                          confirm: async () => {
                            await savePrompts(
                              (state.prompts ?? []).filter(
                                (p) => p.id !== prompt.id,
                              ),
                            );
                            setDialog(null);
                          },
                        })
                      }
                      deleteBlockedReason={
                        currentPrompt?.id === prompt.id ? "请先停用" : undefined
                      }
                    />
                  ))}
                </ul>
              ) : (
                <Empty icon={<BookOpen size={28} />} title="添加你的提示词">
                  在多套 AGENTS.md 提示词之间切换，原文档可从备份恢复。
                </Empty>
              )}
            </>
          )}
          {view === "skills" && (
            <>
              {!state.directory ? (
                grant
              ) : (
                <>
                  <div className="page-toolbar">
                    <span className="muted">已安装 · Codex</span>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="刷新技能"
                      disabled={busy}
                      onClick={() =>
                        action("扫描技能…", async () =>
                          setCatalog(
                            await invoke("catalog", { kind: "skills" }),
                          ),
                        )
                      }
                    >
                      <RefreshCw size={16} />
                    </Button>
                  </div>
                  {catalog?.truncated && (
                    <p className="inline-warning">
                      目录扫描达到数量或深度上限，仅展示部分技能。
                    </p>
                  )}
                  {catalog?.files.length ? (
                    <div className="list-panel">
                      {catalog.files.map((file) => (
                        <button
                          className="list-row text-start w-full"
                          key={file.path}
                          onClick={() => openSkill(file)}
                        >
                          <SkillsIcon size={21} />
                          <div className="grow min-w-0">
                            <strong>
                              {skillsMeta[file.path]?.name ??
                                file.path.split("/").at(-2)}
                            </strong>
                            <p className="muted truncate">
                              {skillsMeta[file.path]?.description ?? file.path}
                            </p>
                          </div>
                          <span className="badge">
                            {file.path.includes("/.system/")
                              ? "内置"
                              : "已安装"}
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<SkillsIcon size={28} />}
                      title={catalog ? "尚无技能" : "正在扫描技能…"}
                    >
                      通过右上角导入 SKILL.md。已安装技能的附属文件会保留。
                    </Empty>
                  )}
                  <p className="page-note">
                    本版支持目录浏览、用户 SKILL.md 编辑和单文档导入。包含脚本 /
                    资源的技能包需由 Codex 安装；内置技能只读。
                  </p>
                </>
              )}
            </>
          )}
          {view === "sessions" && (
            <div className="mobile-upstream-page">
              {!state.directory && grant}
              <DataStatus />
              <SessionManagerPage appId="codex" />
            </div>
          )}
          {view === "auth" && (
            <>
              <div className="page-toolbar">
                <span className="muted">Codex 认证与服务商密钥</span>
                <Button
                  variant="quiet"
                  size="icon"
                  aria-label="刷新认证状态"
                  disabled={!state.directory}
                  onClick={() =>
                    action("读取认证状态…", async () => {
                      await refresh();
                    })
                  }
                >
                  <RefreshCw size={16} />
                </Button>
              </div>
              <Panel title="Codex 官方登录">
                <dl className="details">
                  <div>
                    <dt>目录状态</dt>
                    <dd>{snapshot ? "已读取" : "尚未读取"}</dd>
                  </div>
                  <div>
                    <dt>凭据存储</dt>
                    <dd>{summary?.auth.mode ?? "未知"}</dd>
                  </div>
                  <div>
                    <dt>当前认证</dt>
                    <dd>
                      {summary?.hasBearer
                        ? "服务商 Bearer Token"
                        : summary?.custom
                          ? "自定义服务商"
                          : "需在 Codex 确认"}
                    </dd>
                  </div>
                </dl>
                <p className="muted">
                  {summary?.auth.state ??
                    "授权 .codex 目录后读取配置与 auth.json 的结构。"}
                </p>
                <p className="inline-info">
                  钥匙串、OAuth 刷新及账号切换属于 Codex
                  进程。目录授权无法访问钥匙串；文件中的登录材料也不等于运行中的登录状态。
                </p>
                <Button
                  variant="neutral"
                  onClick={() =>
                    action("打开 Codex…", async () => {
                      await invoke("openCodex");
                    })
                  }
                >
                  在 Codex 中管理登录
                </Button>
              </Panel>
              <Panel title="服务商密钥">
                <p>
                  本地保存{" "}
                  {
                    state.providers.filter((p) => p.authKind === "apiKey")
                      .length
                  }{" "}
                  套 API Key 方案。
                </p>
                <p className="muted">
                  密钥由 Android Keystore
                  加密保存。可在供应商编辑器中查看和修改。
                </p>
                <Button variant="neutral" onClick={() => navigate("providers")}>
                  管理供应商
                </Button>
              </Panel>
              <Panel title="MCP 授权">
                <p className="muted">
                  本版可管理 MCP 配置。MCP OAuth 登录、注销和令牌状态需要在
                  Codex 授权中心中完成。
                </p>
              </Panel>
            </>
          )}
          {view === "usage" && (
            <div className="mobile-upstream-page">
              {!state.directory && grant}
              <DataStatus usage />
              <UsagePage
                initialAppType="codex"
                onOpenRoutingSettings={() => setView("settings")}
              />
            </div>
          )}
          {view === "settings" && (
            <>
              {section === "general" && (
                <>
                  <Panel title="界面缩放">
                    <p className="muted">默认 100%，左右按钮每次调整 10%。</p>
                    <div className="zoom-control">
                      <Button
                        variant="neutral"
                        size="icon"
                        aria-label="缩小 10%"
                        disabled={busy || state.settings.zoom <= 50}
                        onClick={() => setZoom(state.settings.zoom - 10)}
                      >
                        <Minus size={17} />
                      </Button>
                      <div>
                        <input
                          type="number"
                          inputMode="numeric"
                          aria-label="缩放百分比"
                          min={50}
                          max={400}
                          value={zoomInput}
                          onChange={(e) => setZoomInput(e.target.value)}
                          onBlur={() => {
                            if (zoomInput !== String(state.settings.zoom))
                              void setZoom(
                                zoomInput.trim() ? Number(zoomInput) : NaN,
                              );
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                        <span>%</span>
                      </div>
                      <Button
                        variant="neutral"
                        size="icon"
                        aria-label="放大 10%"
                        disabled={busy || state.settings.zoom >= 400}
                        onClick={() => setZoom(state.settings.zoom + 10)}
                      >
                        <Plus size={17} />
                      </Button>
                    </div>
                    <Button
                      variant="quiet"
                      onClick={() => setZoom(100)}
                      disabled={busy}
                    >
                      恢复 100%
                    </Button>
                  </Panel>
                  <FilterStatusPanel />
                  <Panel title="外观">
                    <SegmentedControl
                      aria-label="外观"
                      value={state.settings.theme}
                      items={[
                        { value: "light", label: "浅色", icon: Sun },
                        { value: "dark", label: "深色", icon: Moon },
                        { value: "system", label: "系统", icon: Smartphone },
                      ]}
                      onValueChange={(theme) =>
                        action("保存外观…", async () =>
                          setState(
                            await invoke("settings", {
                              ...state.settings,
                              theme,
                            }),
                          ),
                        )
                      }
                    />
                    <p className="mt-4">
                      语言{" "}
                      <span className="float-right text-fg-2">简体中文</span>
                    </p>
                  </Panel>
                </>
              )}
              {section === "appConfig" && (
                <>
                  <Panel title="Codex 配置目录">
                    <p className="muted">{picker?.message}</p>
                    <dl className="details">
                      <div>
                        <dt>系统 DocumentsUI</dt>
                        <dd>{picker?.pickerAvailable ? "可用" : "未检测到"}</dd>
                      </div>
                      <div>
                        <dt>Codex 文档提供方</dt>
                        <dd>
                          {picker?.codexProviderInstalled
                            ? "已安装"
                            : "未检测到"}
                        </dd>
                      </div>
                      <div>
                        <dt>当前目录</dt>
                        <dd>{state.directory?.name ?? "未选择"}</dd>
                      </div>
                    </dl>
                    {state.directory && (
                      <p className="muted break-word">
                        {state.directory.authority} ·{" "}
                        {state.directory.isCodexProvider
                          ? "Codex 目录"
                          : "普通 / 测试 SAF 目录"}
                      </p>
                    )}
                    <Button
                      variant="neutral"
                      disabled={busy}
                      onClick={authorize}
                    >
                      <FolderOpen size={16} />
                      {state.directory ? "重新选择目录" : "选择目录"}
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={() =>
                        action("检测提供方…", async () =>
                          setPicker(await invoke("providerStatus")),
                        )
                      }
                    >
                      重新检测
                    </Button>
                    <p className="page-note">
                      打开系统文件侧栏 → 选择 Codex → .codex →
                      使用此文件夹。请勿选择 .codex 下的子目录。
                    </p>
                  </Panel>
                  {state.directory && (
                    <Button
                      variant="quiet"
                      onClick={() =>
                        action("解除授权…", async () => {
                          setState(await invoke("releaseDirectory"));
                          setSnapshot(null);
                          setPromptFile(null);
                          setCatalog(null);
                          setUsageScanned(false);
                          setUsageRows([]);
                        })
                      }
                    >
                      解除目录授权
                    </Button>
                  )}
                </>
              )}
              {section === "data" && (
                <>
                  <Panel title="导入与导出">
                    <Button
                      variant="neutral"
                      disabled={busy}
                      onClick={importFile}
                    >
                      <Upload size={15} />
                      导入供应商
                    </Button>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={keysIncluded}
                        onChange={(e) => setKeysIncluded(e.target.checked)}
                      />
                      导出包含 API Key（明文）
                    </label>
                    <Button
                      variant="neutral"
                      disabled={busy || !state.providers.length}
                      onClick={() =>
                        action("导出供应商…", async () => {
                          await invoke("exportFile", {
                            text: exportProviders(
                              state.providers,
                              keysIncluded,
                            ),
                          });
                          setNotice(
                            "方案已导出并读回核对。" +
                              (keysIncluded
                                ? "文件含明文密钥，请妥善保管。"
                                : ""),
                          );
                        })
                      }
                    >
                      <Download size={15} />
                      导出供应商
                    </Button>
                  </Panel>
                  <Panel title="配置备份 · 最近 10 次">
                    <p className="muted">备份绑定授权目录，在本机加密保存。</p>
                    {state.backups.length ? (
                      state.backups.map((backup) => (
                        <div className="list-row" key={backup.id}>
                          <div className="grow min-w-0">
                            <strong>{backup.reason}</strong>
                            <p className="muted">{date(backup.createdAt)}</p>
                          </div>
                          <Button
                            variant="neutral"
                            size="compact"
                            disabled={
                              busy || backup.treeUri !== state.directory?.uri
                            }
                            onClick={() => restoreConfig(backup.id)}
                          >
                            恢复
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="muted">尚无备份。</p>
                    )}
                  </Panel>
                  <Panel title="提示词 / 技能备份 · 最近 10 次">
                    {(state.pendingDocuments ?? []).map((path) => (
                      <div className="notice warning" key={path}>
                        <span>{path} 写入未确认</span>
                        <Button
                          variant="neutral"
                          onClick={() => restoreDocument(undefined, path)}
                        >
                          恢复
                        </Button>
                      </div>
                    ))}
                    {(state.documentBackups ?? []).map((backup) => (
                      <div className="list-row" key={backup.id}>
                        <div className="grow min-w-0">
                          <strong className="break-word">{backup.path}</strong>
                          <p className="muted">{date(backup.createdAt)}</p>
                        </div>
                        <Button
                          variant="neutral"
                          size="compact"
                          disabled={
                            busy || backup.treeUri !== state.directory?.uri
                          }
                          onClick={() =>
                            restoreDocument(backup.id, backup.path)
                          }
                        >
                          恢复
                        </Button>
                      </div>
                    ))}
                    {!state.documentBackups?.length && (
                      <p className="muted">尚无文档备份。</p>
                    )}
                  </Panel>
                </>
              )}
              {section === "about" && (
                <Panel title="CC Switch Android">
                  <div className="about-brand">
                    <img src={logo} width={42} height={42} alt="CC Switch" />
                    <div>
                      <strong>CC Switch</strong>
                      <p className="muted">0.3.1 · Android · Codex</p>
                    </div>
                  </div>
                  <p className="muted">
                    复用上游侧栏、页头、提示词行、控件、样式和图标。通过原生 SAF
                    接口访问配置目录。
                  </p>
                  <Button
                    variant="neutral"
                    onClick={() =>
                      setDialog({
                        title: "开源许可",
                        body: (
                          <pre className="license-text">
                            {thirdPartyNotices}
                          </pre>
                        ),
                      })
                    }
                  >
                    开源许可与版权
                  </Button>
                  <p className="page-note">
                    CC Switch © 2025 Jason Young · MIT License
                  </p>
                </Panel>
              )}
            </>
          )}
        </main>
        {busy && (
          <div className="busy-bar" role="status">
            <RefreshCw className="animate-spin" size={15} />
            {busyLabel}
          </div>
        )}
      </div>
      {providerEditor && (
        <ProviderEditor
          key={providerEditor.id}
          provider={providerEditor}
          shownProvider={providerShown ?? providerEditor}
          editorBase={providerBase}
          loadNotice={providerLoadNotice}
          onClose={closeProvider}
          busy={busy}
          saveError={error}
          onSave={(provider, editor) =>
            action("保存供应商…", async () => {
              const valid = validateProvider(provider);
              const providers = state.providers.some((p) => p.id === valid.id)
                ? state.providers.map((p) => (p.id === valid.id ? valid : p))
                : [...state.providers, valid];
              let globalsChanged = false;
              let savedCurrent = false;
              if (editor) {
                const live = await invoke<Snapshot>("readCurrent");
                if (live.directory.uri !== editor.base.snapshot.directory.uri)
                  throw new Error("授权目录已改变，请重新打开供应商编辑页。");
                const plan = planProviderEditorGlobals(
                  providerEditor,
                  editor.base.config,
                  editor.config,
                  live.config ?? "",
                );
                const isExisting = state.providers.some(
                  (p) => p.id === valid.id,
                );
                const currentId =
                  state.currentProviderId ?? state.lastApplied?.id;
                const writesKeyFields = isExisting
                  ? currentId === valid.id
                  : !currentId;
                if (plan.changedFields.length || writesKeyFields) {
                  let config = plan.config;
                  let applyArgs: Record<string, unknown> = {};
                  if (writesKeyFields) {
                    // Like desktop: saving the current direct provider also
                    // refreshes its live route in the same file transaction.
                    const routed = await prepareFilteredProvider(valid);
                    const applied = planApply({ ...live, config }, routed);
                    config = applied.config;
                    applyArgs = {
                      applyProvider: true,
                      providerId: valid.id,
                      ownership: applied.ownership,
                      catalog: applied.catalog,
                    };
                  }
                  const result = await invoke<{
                    state: AppState;
                    snapshot: Snapshot;
                  }>("saveProviderEditor", {
                    providers,
                    config,
                    expectedRevision: live.revision,
                    ...applyArgs,
                  });
                  setState(result.state);
                  setSnapshot(result.snapshot);
                  if (writesKeyFields && !valid.historyFilter) {
                    try {
                      await invoke("stopFilter");
                    } catch {
                      setError(
                        "配置已保存，但停止旧中转服务失败，请检查运行状态。",
                      );
                    }
                  }
                  globalsChanged = true;
                  savedCurrent = writesKeyFields;
                } else await saveProviders(providers);
              } else await saveProviders(providers);
              setProviderEditor(null);
              setNotice(
                globalsChanged
                  ? savedCurrent
                    ? "供应商方案已保存，当前供应商配置已写入并读回核验。重启 Codex 后确认生效。"
                    : "供应商方案与修改的全局设置已保存，文件已读回核验。新供应商需点击启用后切换；重启 Codex 后确认生效。"
                  : "供应商方案已保存。启用后切换配置，再重启 Codex 生效。",
              );
            })
          }
        />
      )}
      {mcpEditor && (
        <Modal
          title={mcpEditor.original ? "编辑 MCP" : "添加 MCP"}
          busy={busy}
          onClose={() => setMcpEditor(null)}
        >
          <div className="modal-body">
            {error && <p className="inline-warning">{error}</p>}
            <label className="field">
              <span>名称</span>
              <input
                disabled={!!mcpEditor.original}
                value={mcpEditor.name}
                onChange={(e) =>
                  setMcpEditor({ ...mcpEditor, name: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>MCP JSON</span>
              <textarea
                rows={13}
                className="toml-editor"
                autoCapitalize="none"
                spellCheck={false}
                value={mcpEditor.json}
                onChange={(e) =>
                  setMcpEditor({ ...mcpEditor, json: e.target.value })
                }
              />
              <small>
                支持 command / args / env 或 url / http_headers，以及 Codex
                支持的附加参数。命令在 Codex 环境执行。
              </small>
            </label>
          </div>
          <footer className="modal-footer">
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() => setMcpEditor(null)}
            >
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action("保存 MCP…", async () => {
                  if (
                    !mcpEditor.original &&
                    mcps.some(([name]) => name === mcpEditor.name)
                  )
                    throw new Error("该 MCP 名称已存在，请编辑原服务。");
                  let value: any;
                  try {
                    value = JSON.parse(mcpEditor.json);
                  } catch {
                    throw new Error("JSON 格式错误。");
                  }
                  await saveMcp(mcpEditor.name, validateMcp(value));
                })
              }
            >
              保存
            </Button>
          </footer>
        </Modal>
      )}
      {promptEditor && (
        <Modal
          title="编辑提示词"
          busy={busy}
          onClose={() => setPromptEditor(null)}
        >
          <div className="modal-body">
            {error && <p className="inline-warning">{error}</p>}
            <label className="field">
              <span>名称</span>
              <input
                maxLength={100}
                value={promptEditor.draft.name}
                onChange={(e) =>
                  setPromptEditor({
                    draft: { ...promptEditor.draft, name: e.target.value },
                  })
                }
              />
            </label>
            <label className="field">
              <span>说明</span>
              <input
                value={promptEditor.draft.description ?? ""}
                onChange={(e) =>
                  setPromptEditor({
                    draft: {
                      ...promptEditor.draft,
                      description: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span>提示词内容 · Markdown</span>
              <textarea
                rows={15}
                value={promptEditor.draft.content}
                onChange={(e) =>
                  setPromptEditor({
                    draft: { ...promptEditor.draft, content: e.target.value },
                  })
                }
              />
            </label>
            <p className="muted">
              保存到提示库。选择“启用”后才会写入 AGENTS.md。
            </p>
          </div>
          <footer className="modal-footer">
            <Button
              variant="neutral"
              disabled={busy || !promptEditor.draft.content}
              onClick={() =>
                action("导出提示词…", async () => {
                  await invoke("exportFile", {
                    text: promptEditor.draft.content,
                    name: "AGENTS.md",
                  });
                  setNotice("提示词已导出。");
                })
              }
            >
              <Download size={15} />
              导出
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action("保存提示词…", async () => {
                  const draft = {
                    ...promptEditor.draft,
                    updatedAt: Date.now(),
                  };
                  if (!draft.name.trim() || !draft.content.trim())
                    throw new Error("请输入名称和内容。");
                  const all = state.prompts ?? [];
                  await savePrompts(
                    all.some((p) => p.id === draft.id)
                      ? all.map((p) => (p.id === draft.id ? draft : p))
                      : [...all, draft],
                  );
                  setPromptEditor(null);
                })
              }
            >
              保存
            </Button>
          </footer>
        </Modal>
      )}
      {skillEditor && (
        <Modal
          title={skillEditor.create ? "导入技能" : "技能文档"}
          busy={busy}
          onClose={() => setSkillEditor(null)}
        >
          <div className="modal-body">
            {error && <p className="inline-warning">{error}</p>}
            {skillEditor.create && (
              <label className="field">
                <span>技能目录名</span>
                <input
                  value={skillEditor.folder}
                  onChange={(e) =>
                    setSkillEditor({ ...skillEditor, folder: e.target.value })
                  }
                />
                <small>
                  仅字母、数字、下划线、连字符；保存为 skills/目录名/SKILL.md。
                </small>
              </label>
            )}
            <p className="muted break-word">{skillEditor.file.path}</p>
            <label className="field">
              <span>SKILL.md</span>
              <textarea
                rows={18}
                className="toml-editor"
                readOnly={
                  !skillEditor.create &&
                  !/^skills\/[A-Za-z0-9_-]{1,80}\/SKILL\.md$/.test(
                    skillEditor.file.path,
                  )
                }
                value={skillEditor.draft}
                onChange={(e) =>
                  setSkillEditor({ ...skillEditor, draft: e.target.value })
                }
              />
            </label>
            <p className="muted">
              此处不会执行技能内的命令。保存后在 Codex 新会话确认加载。
            </p>
          </div>
          <footer className="modal-footer">
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() => setSkillEditor(null)}
            >
              关闭
            </Button>
            <Button
              disabled={
                busy ||
                (!skillEditor.create &&
                  !/^skills\/[A-Za-z0-9_-]{1,80}\/SKILL\.md$/.test(
                    skillEditor.file.path,
                  ))
              }
              onClick={() =>
                action("保存技能…", async () => {
                  skillMetadata(skillEditor.draft);
                  const target = skillEditor.create
                    ? "skills/" + skillEditor.folder + "/SKILL.md"
                    : skillEditor.file.path;
                  if (!/^skills\/[A-Za-z0-9_-]{1,80}\/SKILL\.md$/.test(target))
                    throw new Error("技能目录名无效。");
                  const before = skillEditor.create
                    ? await invoke<TextDocument>("readDocument", {
                        path: target,
                      })
                    : skillEditor.file;
                  if (skillEditor.create && before.text !== null)
                    throw new Error("该技能已存在，请从列表打开后编辑。");
                  await invoke("saveDocument", {
                    path: target,
                    text: skillEditor.draft,
                    expectedHash: before.hash,
                  });
                  setState(await invoke("bootstrap"));
                  setCatalog(await invoke("catalog", { kind: "skills" }));
                  setSkillEditor(null);
                  setNotice("技能文档已保存并读回核对。");
                })
              }
            >
              保存
            </Button>
          </footer>
        </Modal>
      )}
      {dialog && (
        <Modal title={dialog.title} busy={busy} onClose={() => setDialog(null)}>
          <div className="modal-body">
            {error && <p className="inline-warning">{error}</p>}
            {dialog.body}
          </div>
          <footer className="modal-footer">
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              {dialog.confirm ? "取消" : "关闭"}
            </Button>
            {dialog.confirm && (
              <Button
                variant={dialog.danger ? "destructive" : "solid"}
                disabled={busy}
                onClick={() => action("正在处理…", dialog.confirm!)}
              >
                {dialog.label ?? "确认"}
              </Button>
            )}
          </footer>
        </Modal>
      )}
    </div>
  );
}
