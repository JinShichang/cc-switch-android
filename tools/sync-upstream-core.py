"""Copy the pinned CC Switch backend; apply documented platform substitutions.

The Android APK runs this Rust backend natively. No desktop startup, PRoot,
native-path access to content URIs, or replacement proxy implementation.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil

PROJECT = Path(__file__).resolve().parents[1]
UPSTREAM = PROJECT.parent / "references" / "cc-switch"
DEST = PROJECT / "native" / "vendor"
SOURCE = UPSTREAM / "src-tauri" / "src"
ROOT_MODULES = """agy_config app_config claude_desktop_config claude_mcp claude_plugin
codex_config codex_history_migration codex_rollout_file codex_state_db config
copilot_config database deeplink dsh_config error gemini_config gemini_mcp grok_auth
grok_config hermes_config jsonc_document kimi_config kimi_session live mcode_config
mcp mode model_capabilities omp_config openclaw_config opencode_config pi_config
prompt prompt_files provider provider_kind proxy services session_manager settings
store sync_utils test_support usage_events usage_script workbuddy_config""".split()

manifest = []
DEST.mkdir(parents=True, exist_ok=True)
for module in ROOT_MODULES:
    single = SOURCE / (module + ".rs")
    sources = [single] if single.exists() else list((SOURCE / module).rglob("*"))
    if single.exists() and (SOURCE / module).is_dir():
        sources += list((SOURCE / module).rglob("*"))
    for source in sources:
        if not source.is_file():
            continue
        relative = source.relative_to(SOURCE)
        target = DEST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = source.read_bytes()
        text = raw.decode("utf-8") if source.suffix in (".rs", ".py", ".toml") else None
        substitutions = []
        if text is not None and source.suffix == ".rs":
            if "tauri::" in text:
                text = text.replace("tauri::", "crate::platform::")
                substitutions.append("Tauri event/state/runtime transport -> Android platform transport")
            if str(relative).replace("\\", "/") == "services/mod.rs":
                for name in ("auto_sync", "webdav_auto_sync", "s3_auto_sync"):
                    text = text.replace(f"pub mod {name};", "")
                substitutions.append("Desktop automatic cloud synchronization startup omitted")
            if str(relative).replace("\\", "/") == "database/mod.rs":
                text = text.replace("use crate::services::{auto_sync, s3_auto_sync, webdav_auto_sync};", "")
                text = re.sub(r"auto_sync::notify_db_changed::<[^>]+>\(table\);", "crate::platform::notify_db_changed(table);", text)
                substitutions.append("Database change notification -> Android event bus")
            key = str(relative).replace("\\", "/")
            if key == "config.rs":
                text = text.replace("pub fn get_home_dir() -> PathBuf {", "pub fn get_home_dir() -> PathBuf {\n    if let Some(home) = crate::platform::home() { return home; }")
                text = text.replace("pub fn delete_file(path: &Path) -> Result<(), AppError> {", "pub fn delete_file(path: &Path) -> Result<(), AppError> {\n    if let Some(result) = crate::platform::delete_document(path) { return result.map_err(|e| AppError::io(path, e)); }")
                text = text.replace("pub fn read_json_file<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T, AppError> {", "pub fn read_json_file<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T, AppError> {\n    if let Some(result) = crate::platform::read_document(path) {\n        let bytes = result.map_err(|e| AppError::io(path, e))?.ok_or_else(|| AppError::Config(format!(\"文件不存在: {}\", path.display())))?;\n        return serde_json::from_slice(&bytes).map_err(|e| AppError::json(path, e));\n    }")
                text = text.replace("let parent = path\n        .parent()\n        .ok_or_else(|| AppError::Config(\"无效的路径\".to_string()))?;", "let saf_parent = crate::platform::relative(path).and_then(|_| crate::platform::staging_directory());\n    let parent = saf_parent.as_deref().or_else(|| path.parent())\n        .ok_or_else(|| AppError::Config(\"无效的路径\".to_string()))?;\n    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;")
                text = text.replace("pub(crate) fn commit_staged(tmp: &Path, path: &Path) -> Result<(), AppError> {", "pub(crate) fn commit_staged(tmp: &Path, path: &Path) -> Result<(), AppError> {\n    if crate::platform::relative(path).is_some() {\n        let bytes = fs::read(tmp).map_err(|e| AppError::io(tmp, e))?;\n        if let Some(result) = crate::platform::write_document(path, &bytes) {\n            result.map_err(|e| AppError::io(path, e))?;\n            let _ = fs::remove_file(tmp);\n            return Ok(());\n        }\n        return Err(AppError::Config(\"SAF 尚未初始化\".into()));\n    }")
                substitutions.append("Live document I/O -> SAF; native staged files -> private Android staging directory")
            if key == "live/engine.rs":
                text = text.replace('Self::at(crate::config::get_home_dir().join(".cc-switch"))', 'Self::at(crate::platform::document_state_directory().unwrap_or_else(|| crate::config::get_home_dir().join(".cc-switch")))')
                text = text.replace("pub fn read_current(path: &Path) -> Result<Option<Vec<u8>>, LiveWriteError> {", "pub fn read_current(path: &Path) -> Result<Option<Vec<u8>>, LiveWriteError> {\n    if let Some(result) = crate::platform::read_document(path) {\n        return result.map_err(|source| LiveWriteError::Io { path: path.to_path_buf(), source });\n    }")
                substitutions.append("Live reads -> SAF while pending and backup files remain native")
            if key == "codex_config.rs":
                text = text.replace('crate::config::get_app_config_dir().join(CODEX_MANAGED_OAUTH_LIVE_AUTH_MARKER_FILENAME)', 'crate::live::engine::DeviceStore::for_device().file(CODEX_MANAGED_OAUTH_LIVE_AUTH_MARKER_FILENAME)')
                text = text.replace("pub fn read_codex_config_text() -> Result<String, AppError> {\n    let path = get_codex_config_path();", "pub fn read_codex_config_text() -> Result<String, AppError> {\n    let path = get_codex_config_path();\n    if let Some(result) = crate::platform::read_document(&path) {\n        let bytes = result.map_err(|e| AppError::io(&path, e))?.unwrap_or_default();\n        return String::from_utf8(bytes).map_err(|_| AppError::Config(\"config.toml 不是 UTF-8\".into()));\n    }")
                substitutions.append("Codex configuration read -> SAF")
            if key == "services/subscription.rs":
                text = text.replace("fn read_codex_credentials_from_file() -> CodexCredentials {", "fn read_codex_credentials_from_file() -> CodexCredentials {\n    let path = crate::codex_config::get_codex_auth_path();\n    if let Some(result) = crate::platform::read_document(&path) {\n        return match result {\n            Ok(Some(bytes)) => parse_codex_credentials_json(&String::from_utf8_lossy(&bytes)),\n            Ok(None) => (None, None, CredentialStatus::NotFound, None),\n            Err(_) => (None, None, CredentialStatus::ParseError, Some(\"无法读取已授权的认证文件\".into())),\n        };\n    }")
                substitutions.append("Codex quota credential file read -> SAF; host keyring remains inaccessible")
                # Android exposes only Codex. Keep the shared upstream Gemini
                # refresh implementation without redistributing OAuth literals.
                text = text.replace(
                    "/// Gemini OAuth Client 凭据（公开值，来自 Gemini CLI 源码 google-gemini/gemini-cli）",
                    "/// Gemini OAuth Client 凭据（仅可选本地构建环境提供；Android 只启用 Codex）",
                )
                for credential in ("ID", "SECRET"):
                    name = f"GEMINI_OAUTH_CLIENT_{credential}"
                    replacement = (
                        f'const {name}: &str = match option_env!("CCSWITCH_{name}") {{\n'
                        '    Some(value) => value,\n'
                        '    None => "",\n'
                        '};'
                    )
                    text, count = re.subn(
                        rf'const {name}: &str =\s*"[^"\n]*";', replacement, text
                    )
                    if count != 1:
                        raise RuntimeError(f"Expected one upstream {name} declaration")
                text = text.replace(
                    "async fn refresh_gemini_token(refresh_token: &str) -> Option<String> {",
                    "async fn refresh_gemini_token(refresh_token: &str) -> Option<String> {\n"
                    "    if GEMINI_OAUTH_CLIENT_ID.is_empty() || GEMINI_OAUTH_CLIENT_SECRET.is_empty() {\n"
                    "        return None;\n"
                    "    }",
                )
                substitutions.append("Non-Codex Gemini OAuth literals -> optional local build environment; absent credentials disable its unused refresh")
            if key == "services/agy_account/oauth.rs":
                for name in ("ID", "SECRET"):
                    declaration = (
                        f'pub const CLIENT_{name}: &str = match option_env!("CCSWITCH_AGY_OAUTH_CLIENT_{name}") {{\n'
                        '    Some(value) => value,\n'
                        '    None => "",\n'
                        '};'
                    )
                    pattern = (
                        r'pub const CLIENT_ID: &str =\s*"[^"\n]*";'
                        if name == "ID" else
                        r'/// agy 二进制里内置的安装型客户端密钥[^\n]*\n/// [^\n]*\nconst CLIENT_SECRET_PARTS: \[&str; 2\] = \[[^\n]*\];'
                    )
                    text, count = re.subn(pattern, declaration, text)
                    if count != 1:
                        raise RuntimeError(f"Expected one upstream agy CLIENT_{name} declaration")
                text = text.replace("CLIENT_SECRET_PARTS.concat()", "CLIENT_SECRET.to_string()")
                text, count = re.subn(
                    r"    let secret = client_secret\(\);",
                    '    let secret = client_secret();\n'
                    '    if CLIENT_ID.is_empty() || secret.is_empty() {\n'
                    '        return Err(AgyOAuthError::TokenExchange("此 Android 构建只启用 Codex，未配置 agy OAuth".into()));\n'
                    '    }',
                    text,
                )
                if count != 2:
                    raise RuntimeError("Expected two upstream agy token credential checks")
                substitutions.append("Non-Codex agy OAuth literals -> optional local build environment; absent credentials disable its unused token exchange/refresh")
            if key == "mcp/codex.rs":
                text=text.replace('crate::codex_config::get_codex_config_dir().exists()', 'crate::platform::documents_bound()')
                text=text.replace('config_path.exists()', 'crate::platform::exists(&config_path)')
                text=text.replace('std::fs::read_to_string(&config_path)', 'crate::platform::read_to_string(&config_path)')
                substitutions.append("Original Codex MCP writer uses SAF file transport")
            if key == "services/prompt.rs":
                text=text.replace('target_path.exists()', 'crate::platform::exists(&target_path)').replace('file_path.exists()', 'crate::platform::exists(&file_path)')
                text=text.replace('std::fs::read_to_string(&target_path)', 'crate::platform::read_to_string(&target_path)').replace('std::fs::read_to_string(&file_path)', 'crate::platform::read_to_string(&file_path)')
                substitutions.append("Original prompt backfill/enable/save reads and writes use SAF transport")
            if key == "live/project/codex.rs":
                text = text.replace("pub(crate) fn catalog_pointer_value(config_dir: &Path) -> String {", "pub(crate) fn catalog_pointer_value(config_dir: &Path) -> String {\n    if crate::platform::relative(&config_dir.join(CATALOG_FILENAME)).is_some() { return format!(\"/home/codex/.codex/{CATALOG_FILENAME}\"); }")
                substitutions.append("SAF catalog pointer -> documented Codex guest path, never Android private path or installation UUID")
            if key == "services/provider/codex_client_catalog.rs":
                text = text.replace("#[cfg(unix)]\nfn read_process_table", "#[cfg(all(unix, not(target_os = \"android\")))]\nfn read_process_table")
                text = text.replace("#[cfg(not(unix))]\nfn read_process_table", "#[cfg(any(not(unix), target_os = \"android\"))]\nfn read_process_table")
                substitutions.append("Android process visibility -> unknown; requires user restart, no false runtime confirmation")
            if key == "proxy/forwarder.rs":
                text = text.replace("let original_model = body.get(\"model\").cloned();", "let mut body = body;\n        if crate::api::filter_for(&provider.id) {\n            if endpoint.split('?').next().is_some_and(|path| path.trim_end_matches('/').ends_with(\"/responses/compact\")) { return Err(ProxyError::InvalidRequest(\"历史过滤不能迁移加密压缩，请使用文本摘要开启新会话\".into())); }\n            crate::history_filter::apply(&mut body)?;\n        }\n        let original_model = body.get(\"model\").cloned();")
                substitutions.append("User-requested opt-in reasoning/item-ID filter before upstream request preparation")
            if key == "mode/controller.rs":
                text = text.replace('let apps = || AppType::all().filter(|app| app.spec().route_mode);', 'let apps = || [AppType::Codex].into_iter();')
                substitutions.append("Android exposes only Codex; other applications never attach during startup or exit")
            if key == "services/session_usage_codex.rs":
                text = text.replace('let codex_dir = get_codex_config_dir();', 'let codex_dir = crate::platform::session_cache_directory().unwrap_or_else(get_codex_config_dir);')
                substitutions.append("Original session parser reads a SAF-populated private cache; no URI is a native path")
            if key == "session_manager/providers/codex.rs":
                text = text.replace('let config_dir = get_codex_config_dir();', 'let config_dir = crate::platform::session_cache_directory().unwrap_or_else(get_codex_config_dir);')
                substitutions.append("Original transcript and metadata reader uses the SAF read-only session cache")
            if key == "session_manager/mod.rs":
                text = text.replace('let scanners: [(&str, Scanner); 15] = [', 'let scanners: [(&str, Scanner); 1] = [')
                start = text.index('        ("claude", claude::scan_sessions_with_status),')
                end = text.index('\n    ];',start)
                text = text[:start] + text[end:]
                substitutions.append("Only Codex sessions are enumerated on Android")
            if key == "session_manager/search.rs":
                text=text.replace('crate::config::get_app_config_dir().join(INDEX_FILE)', 'crate::platform::document_state_directory().unwrap_or_else(crate::config::get_app_config_dir).join(INDEX_FILE)')
                text=text.replace('crate::settings::get_settings().session_content_search_enabled', 'crate::settings::get_settings().session_content_search_enabled && crate::session_api::index_enabled()')
                text += '\n// The SAF input tree must stay stable while the original background index runs.\npub(crate) fn suspend_for_document_change() {\n    RERUN.store(false, Ordering::SeqCst);\n    while RUNNING.load(Ordering::SeqCst) { std::thread::sleep(std::time::Duration::from_millis(10)); }\n    *INDEX.lock_recover() = None;\n    *STATUS.lock_recover() = IndexStatus::default();\n}\n'
                substitutions.append("Original persistent FTS and background indexing use scoped private cache; pause before grant changes")
            if key == "claude_desktop_config.rs":
                text = text.replace('#[cfg(any(target_os = "macos", windows, target_os = "linux"))]\nuse crate::config::get_home_dir;', 'use crate::config::get_home_dir;')
                substitutions.append("Resolve desktop-only cfg import for Android build; no desktop client exposed")
            if key in ("codex_config.rs", "services/provider/codex_client_catalog.rs", "services/provider/codex_official_models.rs"):
                text = re.sub(r"(?<![\w:])(?:std::)?fs::read_to_string\(", "crate::platform::read_to_string(", text)
                text = re.sub(r"(?<![\w:])(?:std::)?fs::read\(", "crate::platform::read(", text)
                text = re.sub(r"\b([a-z_]+)\.exists\(\)", r"crate::platform::exists(&\1)", text)
                text = text.replace("get_codex_config_path().exists()", "crate::platform::exists(&get_codex_config_path())")
                substitutions.append("Codex file reads and existence checks -> SAF-aware platform I/O")
            if key == "codex_config.rs":
                text = text.replace("fn read_limited_string(path: &Path, max_bytes: u64) -> Result<String, AppError> {", "fn read_limited_string(path: &Path, max_bytes: u64) -> Result<String, AppError> {\n    if let Some(result) = crate::platform::read_document(path) {\n        let bytes = result.map_err(|e| AppError::io(path,e))?.ok_or_else(|| AppError::Config(\"模型目录不存在\".into()))?;\n        if bytes.len() as u64 > max_bytes { return Err(AppError::Config(\"模型目录过大\".into())); }\n        return String::from_utf8(bytes).map_err(|_| AppError::Config(\"模型目录不是 UTF-8\".into()));\n    }")
                text = text.replace('if crate::platform::exists(&resolved) {', 'if crate::platform::relative(&resolved).is_some() { return Some(resolved); }\n    if crate::platform::exists(&resolved) {')
                text = text.replace('let referenced_path = Path::new(catalog_path_str);', 'if catalog_path_str == "/home/codex/.codex/cc-switch-model-catalog.json" && crate::platform::relative(&base_dir.join(CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME)).is_some() { return Some(base_dir.join(CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME)); }\n    let referenced_path = Path::new(catalog_path_str);')
            if key == "services/provider/mod.rs":
                text = text.replace("mod editor_toml;", "pub(crate) mod editor_toml;").replace("mod claude_editor;", "pub(crate) mod claude_editor;")
                text = text.replace("mod codex_editor;", "pub(crate) mod codex_editor;")
                substitutions.append("Expose upstream TOML edits to Android raw-editor command")
            if key == "services/provider/codex_editor.rs":
                text += '''
// Read-only file matching uses the same projection and auth planner as writes.
pub(crate) fn matches_current(state: &AppState, provider: &Provider) -> Result<bool, AppError> {
    let path = get_codex_config_path();
    let before = read_current(&path)?;
    let mut expected = parse(&path, before.as_deref())?;
    let owner = LiveOwner::read(state)?;
    let planned = plan_for_view(&state.db, &owner.owner(), provider)?;
    let auth_after = codex_direct::predicted_auth_file(&state.db, &owner.owner(), &Target::Direct(Some(provider)))?;
    let live_auth = read_current(&crate::codex_config::get_codex_auth_path())?
        .map(|bytes| serde_json::from_slice::<Value>(&bytes)).transpose()
        .map_err(|e| AppError::Message(e.to_string()))?;
    let login = match crate::codex_config::codex_config_auth_store_mode(&String::from_utf8_lossy(before.as_deref().unwrap_or_default())) {
        crate::codex_config::CodexAuthStoreMode::File => auth_after.as_ref().is_some_and(crate::codex_config::codex_auth_has_openai_account_material),
        crate::codex_config::CodexAuthStoreMode::Ephemeral => false,
        _ => codex_direct::is_official(provider) || crate::settings::get_settings().preserve_codex_official_auth_on_switch,
    };
    let mut patch = planned.config().clone();
    if let Route::Custom { auth, .. } = super::codex_direct::project_for_matching(provider)?.route {
        if let crate::live::project::codex::RouteWrite::Custom(table) = &mut patch.route {
            if matches!(auth, crate::live::project::codex::RouteAuth::Bearer | crate::live::project::codex::RouteAuth::EnvKey) {
                table.insert("requires_openai_auth", toml_edit::value(crate::live::project::codex::requires_openai_auth(auth, login)));
            }
        }
    }
    patch.apply_to(&path, &mut expected)?;
    let current: toml::Value = String::from_utf8_lossy(before.as_deref().unwrap_or_default()).parse().map_err(|e:toml::de::Error|AppError::Message(e.to_string()))?;
    let expected: toml::Value = expected.to_string().parse().map_err(|e:toml::de::Error|AppError::Message(e.to_string()))?;
    Ok(current == expected && live_auth == auth_after)
}
'''
                substitutions.append("Expose read-only native file relationship check through existing writer projection")
            if key == "services/provider/codex_direct.rs":
                text += '\npub(crate) fn project_for_matching(provider: &Provider) -> Result<CodexProjection, AppError> { project(provider) }\n'
            # Desktop invokes native CLI processes. An Android app has no access
            # to the other app's guest process namespace; callers get explicit
            # unsupported errors through the platform command adapter.
            target.write_text(text, encoding="utf-8", newline="\n")
        else:
            target.write_bytes(raw)
        manifest.append({"path": str(relative).replace("\\", "/"),
                         "sha256": hashlib.sha256(raw).hexdigest(),
                         "substitutions": substitutions})
for source in (SOURCE / "resources").rglob("*"):
    if source.is_file():
        target = DEST / source.relative_to(SOURCE)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
shutil.copyfile(UPSTREAM / "LICENSE", DEST / "LICENSE")
# Original command orchestration; desktop-only updater and tray transport are
# omitted. Existing history migration requires guest SQLite access via SAF.
for command in ['failover','settings']:
    command_source=SOURCE/f'commands/{command}.rs'
    raw=command_source.read_bytes()
    text=raw.decode('utf-8')
    notes=['Tauri command transport -> Android JNI']
    if command=='settings':
        start=text.index('fn merge_settings_for_save(')
        end=text.index('\n#[derive(serde::Serialize)]',text.index('pub async fn save_settings(')+1)
        text='use crate::platform::Emitter;\n'+text[start:end]
        text=text.replace('    if tray_style_changed {\n        crate::tray::apply_tray_style(&app);\n    }','    let _ = tray_style_changed;')
        text=text.replace('    if auto_update_disabled {\n        crate::app_update::discard_pending(&app);\n    }','    let _ = auto_update_disabled;')
        start=text.index('        if unify_codex_enabled {')
        end=text.index('\n    Ok(true)',start)
        text=text[:start]+'''        let _ = unify_codex_enabled;
    }
'''+text[end:]
        text=text.replace('    let existing = crate::settings::get_settings();', '''    let existing = crate::settings::get_settings();
    if settings.unify_codex_migrate_existing == Some(true) && existing.unify_codex_migrate_existing != Some(true) {
        return Err("现有会话迁移需要修改 Codex 私有 SQLite，目录授权不能安全执行；请在 Codex 中管理现有会话".into());
    }''')
        notes.append('Desktop updater/tray effects omitted; existing-history migration reports SAF limitation, configuration resync/rollback unchanged')
    text=text.replace('#[tauri::command]\n','').replace('tauri::','crate::platform::').replace("crate::platform::State<'_, AppState>",'crate::platform::State<AppState>').replace("crate::platform::State<'_, crate::store::AppState>",'crate::platform::State<crate::store::AppState>')
    command_target=DEST/f'commands/{command}.rs'
    command_target.parent.mkdir(parents=True,exist_ok=True)
    command_target.write_text(text,encoding='utf-8',newline='\n')
    manifest.append({'path':f'commands/{command}.rs','sha256':hashlib.sha256(raw).hexdigest(),'substitutions':notes})
(PROJECT / "native" / "upstream-manifest.json").write_text(json.dumps({
    "version": "4.0.40", "commit": "aaf6ee963927ea0173e53ac00c1919840948ab22",
    "license": "MIT", "files": manifest,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
root = PROJECT / "native" / "modules.rs"
root.write_text("// Generated upstream module bindings; see upstream-manifest.json.\n" +
    "\n".join(('' if name != 'test_support' else '#[cfg(test)]\n') + (f'#[path = "vendor/{name}.rs"]\nmod {name};' if (DEST / (name + ".rs")).exists()
              else f'#[path = "vendor/{name}/mod.rs"]\nmod {name};') for name in ROOT_MODULES) + "\n", encoding="utf-8")
main = (SOURCE / 'lib.rs').read_text(encoding='utf-8')
start = main.index('pub(crate) struct RedactedUrl')
end = main.index('fn runtime_log_level_allows')
(PROJECT / 'native' / 'log_redaction.rs').write_text(main[start:end], encoding='utf-8')
print(f"Copied {len(manifest)} upstream source/resource files; desktop transport substitutions recorded.")
