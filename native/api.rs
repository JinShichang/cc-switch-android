//! Structured API shared by Android JNI and native host tests.
use crate::app_config::AppType;
use crate::database::Database;
use crate::platform::{AppHandle, Manager};
use crate::provider::Provider;
use crate::services::provider::{EditorSave, ProviderService};
use crate::store::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

static STATE: OnceLock<AppState> = OnceLock::new();
static HANDLE: OnceLock<AppHandle> = OnceLock::new();
static CALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn encoded<T: Serialize>(value: T) -> Result<Value, String> { serde_json::to_value(value).map_err(|e| e.to_string()) }
fn required<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name].as_str().ok_or_else(|| format!("缺少参数 {name}"))
}
fn optional<'a>(args: &'a Value, name: &str) -> Option<&'a str> { args[name].as_str().filter(|s| !s.is_empty()) }
fn provider(args: &Value) -> Result<Provider, String> {
    let mut value=args.clone();
    if let Some(meta)=value.get_mut("meta").and_then(Value::as_object_mut) {
        if !meta.contains_key("custom_endpoints") {
            if let Some(urls)=meta.get("customEndpoints").and_then(Value::as_array) {
                let mut endpoints=serde_json::Map::new();
                for url in urls.iter().filter_map(Value::as_str) {
                    endpoints.insert(url.into(),json!({"url":url,"addedAt":0}));
                }
                meta.insert("custom_endpoints".into(),Value::Object(endpoints));
            }
        }
        if !meta.contains_key("endpointAutoSelect") {
            if let Some(enabled)=meta.get("autoSelect").cloned() {meta.insert("endpointAutoSelect".into(),enabled);}
        }
        for key in ["customEndpoints","autoSelect","androidLoginPolicy","preserveCodexOfficialAuthOnSwitch"] {meta.remove(key);}
    }
    serde_json::from_value(value).map_err(|e| format!("供应商格式错误: {e}"))
}

fn migrate_auxiliary(state:&AppState,legacy:&Value)->Result<(),String>{
    if state.db.get_setting("android_legacy_aux_v1").map_err(|e|e.to_string())?.is_some(){return Ok(());}
    if let Some(stashes)=legacy["loginStashes"].as_object(){
        for (uri,stash) in stashes {
            if !uri.starts_with("content://"){continue;}
            let Some(logins)=stash["logins"].as_object() else{return Err("旧版登录暂存格式错误，原数据已保留".into());};
            if logins.values().any(|auth|!auth.is_object()){return Err("旧版登录暂存包含无效认证，原数据已保留".into());}
            let path=crate::platform::document_state_for(uri).ok_or("本地数据目录未初始化")?.join("codex-login-stash.json");
            if !path.exists(){
                let mut saved=stash.clone();saved.as_object_mut().expect("validated stash").remove("initialized");
                crate::config::atomic_write_private(&path,&serde_json::to_vec_pretty(&saved).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            }
        }
    }
    if let Some(settings)=legacy["uiData"]["settings"].as_object(){
        let mut current=encoded(crate::settings::get_settings())?;
        for key in ["sessionContentSearchEnabled","sessionAutoSyncEnabled","usageDashboardRefreshIntervalMs","usageDisplay","quotaDisplay"] {
            if let Some(value)=settings.get(key){current[key]=value.clone();}
        }
        crate::settings::update_settings(serde_json::from_value(current).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    }
    if let Some(prices)=legacy["uiData"]["pricing"].as_array(){
        let entries:Vec<crate::services::model_pricing::ModelPricingInfo>=serde_json::from_value(json!(prices)).map_err(|e|e.to_string())?;
        if !entries.is_empty(){crate::services::model_pricing::update_model_pricing_batch(&state.db,entries).map_err(|e|e.to_string())?;}
    }
    if let Some(prompts)=legacy["prompts"].as_array(){
        for row in prompts {
            let mut row:crate::prompt::Prompt=serde_json::from_value(row.clone()).map_err(|e|e.to_string())?;
            row.enabled=false;
            state.db.save_prompt(&AppType::Codex,&row).map_err(|e|e.to_string())?;
        }
    }
    state.db.set_setting("android_legacy_aux_v1","true").map_err(|e|e.to_string())
}
pub fn state() -> Result<&'static AppState, String> { STATE.get().ok_or_else(|| "原生后端尚未初始化".into()) }

pub fn initialize(home: std::path::PathBuf, documents: Arc<dyn crate::platform::Documents>, legacy: Value) -> Result<Value, String> {
    let _=rustls::crypto::ring::default_provider().install_default();
    crate::platform::install(home, documents)?;
    if STATE.get().is_none() {
        crate::settings::reload_settings().map_err(|e| e.to_string())?;
        let db = Arc::new(Database::init().map_err(|e| e.to_string())?);
        let state = AppState::new(db);
        let handle = AppHandle::default();
        handle.manage(state.clone());
        handle.manage(crate::commands::CodexOAuthState(state.codex_oauth_manager.clone()));
        handle.manage(crate::commands::XaiOAuthState(state.xai_oauth_manager.clone()));
        handle.manage(crate::commands::CopilotAuthState(Arc::new(tokio::sync::RwLock::new(
            crate::proxy::providers::copilot_auth::CopilotAuthManager::new(crate::config::get_app_config_dir())))));
        state.proxy_service.set_app_handle(handle.clone());
        crate::usage_events::init(handle.clone());
        migrate_auxiliary(&state,&legacy)?;
        if state.db.get_setting("android_migrated_v1").map_err(|e| e.to_string())?.is_none() {
            if let Some(rows) = legacy["providers"].as_array() {
                for (index, row) in rows.iter().enumerate() {
                    let mut item = provider(row)?;
                    item.sort_index = Some(index);
                    state.db.save_provider(&AppType::Codex, &item).map_err(|e| e.to_string())?;
                    set_filter(&state, &item.id, row["historyFilter"].as_bool().unwrap_or(false))?;
                }
                if let Some(id) = optional(&legacy, "currentProviderId") {
                    if state.db.provider_exists(id, &AppType::Codex).map_err(|e| e.to_string())? {
                        state.db.set_current_provider(&AppType::Codex, id).map_err(|e| e.to_string())?;
                        crate::settings::set_current_provider(&AppType::Codex, Some(id)).map_err(|e| e.to_string())?;
                    }
                }
            }
            state.db.set_setting("android_migrated_v1", "true").map_err(|e| e.to_string())?;
        }
        STATE.set(state).map_err(|_| "原生状态重复初始化")?;
        HANDLE.set(handle).map_err(|_| "原生事件重复初始化")?;
    }
    bootstrap()
}

fn set_filter(state: &AppState, id: &str, enabled: bool) -> Result<(), String> {
    state.db.set_setting(&format!("android_history_filter:{id}"), if enabled { "true" } else { "false" }).map_err(|e| e.to_string())
}
pub(crate) fn filter_enabled(db: &Database, id: &str) -> bool {
    db.get_setting(&format!("android_history_filter:{id}")).ok().flatten().as_deref() == Some("true")
}
pub(crate) fn filter_for(id:&str)->bool { STATE.get().is_some_and(|state|filter_enabled(&state.db,id)) }
fn public_provider(state: &AppState, row: &Provider) -> Value {
    let mut value = serde_json::to_value(row).unwrap_or_default();
    value["historyFilter"] = Value::Bool(filter_enabled(&state.db, &row.id));
    value["authKind"] = json!(if row.has_official_category() { "official" } else if row.settings_config["config"].as_str().unwrap_or("").contains("env_key") { "env" } else { "apiKey" });
    value["updatedAt"] = json!(chrono::Utc::now().timestamp_millis());
    value
}
fn auth_account(account: crate::proxy::providers::copilot_auth::GitHubAccount, default: Option<&str>) -> Value {
    json!({"id":account.id,"provider":"codex_oauth","login":account.login,
        "avatar_url":account.avatar_url,"authenticated_at":account.authenticated_at,
        "is_default":default==Some(account.id.as_str()),"github_domain":account.github_domain,
        "reauth_required":account.reauth_required,"requires_reauth":false})
}
fn bootstrap() -> Result<Value, String> {
    let state = state()?;
    let rows = state.db.get_all_providers(&AppType::Codex).map_err(|e| e.to_string())?;
    let mode = crate::mode::controller::app_mode_view(state, &AppType::Codex)?;
    let current = crate::mode::current::provider_for(&state.db, &AppType::Codex, crate::mode::current::Purpose::InUse).map_err(|e| e.to_string())?;
    Ok(json!({
        "providers": rows.values().map(|p| public_provider(state,p)).collect::<Vec<_>>(),
        "prompts": state.db.get_prompts(&AppType::Codex).map_err(|e|e.to_string())?.values().collect::<Vec<_>>(),
        "currentProviderId": current, "mode": mode,
        "pendingRecovery": crate::mode::state::pending(&crate::live::engine::DeviceStore::for_device(), "codex").map_err(|e|e.to_string())?.is_some(),
        "backendVersion": "4.0.40",
        "providerInitialization": state.db.get_setting("android_initial_import_v1").map_err(|e| e.to_string())?.is_some(),
    }))
}

// Android lifecycle and document-grant cleanup may run before a listener was
// started, or after the upstream mode controller already stopped it. Match
// the controller's is_running guard; leave ProxyService::stop's contract intact.
fn stop_proxy_if_running(state: &AppState) -> Result<(), String> {
    crate::platform::async_runtime::block_on(async {
        if state.proxy_service.is_running().await {
            state.proxy_service.stop().await?;
        }
        Ok(())
    })
}

pub fn call(command: &str, args: Value) -> Result<Value, String> {
    let _guard = CALL_LOCK.lock().map_err(|_| "原生操作锁已失效，请重新打开 CC Switch")?;
    let state = state()?;
    let start = args["startDate"].as_i64();
    let end = args["endDate"].as_i64();
    let name = optional(&args,"providerName");
    let model = optional(&args,"model");
    match command {
        "bootstrap" => bootstrap(),
        "list_sessions" | "get_session_messages" | "getSessionTranscript" | "get_session_block_content" | "get_session_image" | "search_session_content" | "sync_session_index" | "clear_session_index" => crate::session_api::call(command,&args),
        "bindDocuments" => {
            let identity = args["uri"].as_str().unwrap_or("");
            crate::session_api::suspend_index();
            crate::platform::set_document_scope(identity);
            crate::session_api::resume_index();
            let store=crate::live::engine::DeviceStore::for_device();
            if crate::mode::state::mode_state(&store,"codex").map_err(|e|e.to_string())?.mode.is_none(){
                let mode=crate::mode::state::ModeState{mode:Some(crate::mode::state::Mode::Direct),..Default::default()};
                crate::mode::operation::commit_target(&state.db,&store,"codex",&crate::mode::state::PendingTarget::mode(mode)).map_err(|e|e.to_string())?;
            }
            bootstrap()
        }
        "suspendDocuments" => {
            if crate::mode::current::is_proxy(&AppType::Codex) {
                // A lost grant must not prevent choosing a new tree. Keep its
                // scoped pending intent for the next grant to that same tree.
                let _ = crate::platform::async_runtime::block_on(crate::mode::controller::exit(state, &AppType::Codex));
            }
            stop_proxy_if_running(state)?;
            Ok(json!(true))
        }
        "startup" => {
            crate::mode::operation::settle(&state.db,"codex").map_err(|e|e.to_string())?;
            crate::platform::async_runtime::block_on(crate::mode::controller::startup(state));
            let failures=crate::mode::controller::take_startup_attach_failures();
            if !failures.is_empty(){return Err(failures.iter().map(|f|f.error.as_str()).collect::<Vec<_>>().join("；"));}
            bootstrap()
        }
        "initializeProviders" => {
            if state.db.get_setting("android_initial_import_v1").map_err(|e|e.to_string())?.is_none() {
                if !state.db.has_non_official_seed_provider(&AppType::Codex).map_err(|e|e.to_string())? {
                    crate::services::provider::import_default_config(state,AppType::Codex).map_err(|e|e.to_string())?;
                }
                state.db.ensure_official_seed_by_id(crate::database::CODEX_OFFICIAL_PROVIDER_ID,AppType::Codex).map_err(|e|e.to_string())?;
                state.db.set_setting("android_initial_import_v1","true").map_err(|e|e.to_string())?;
            }
            bootstrap()
        }
        "get_provider_editor_view" => {
            let row = provider(&args["provider"])?;
            encoded(ProviderService::editor_view_with_meta(state,AppType::Codex,&row.settings_config,row.category.as_deref(),Some(&row.id),row.meta.as_ref()).map_err(|e|e.to_string())?)
        }
        "captureCurrent" => {
            let settings=crate::codex_config::read_codex_live_settings().map_err(|e|e.to_string())?;
            let official=crate::codex_config::codex_auth_has_login_material(&settings["auth"]) && crate::codex_config::extract_codex_api_key(settings.get("auth"),settings["config"].as_str()).is_none();
            let mut row=Provider::with_id(uuid::Uuid::new_v4().to_string(),args["name"].as_str().unwrap_or("当前配置").into(),settings,None);
            row.category=Some(if official{"official"}else{"custom"}.into());
            Ok(public_provider(state,&row))
        }
        "get_custom_endpoints" => encoded(ProviderService::get_custom_endpoints(state,AppType::Codex,required(&args,"providerId")?).map_err(|e|e.to_string())?),
        "add_custom_endpoint" => {ProviderService::add_custom_endpoint(state,AppType::Codex,required(&args,"providerId")?,required(&args,"url")?.into()).map_err(|e|e.to_string())?;Ok(json!(true))}
        "remove_custom_endpoint" => {ProviderService::remove_custom_endpoint(state,AppType::Codex,required(&args,"providerId")?,required(&args,"url")?.into()).map_err(|e|e.to_string())?;Ok(json!(true))}
        "editConfig" => {
            let before=required(&args,"base")?;
            let after=required(&args,"config")?;
            let base:toml_edit::DocumentMut=before.parse().map_err(|_|"原配置 TOML 格式错误")?;
            let edited:toml_edit::DocumentMut=after.parse().map_err(|_|"新配置 TOML 格式错误")?;
            fn entries(doc:&toml_edit::DocumentMut)->Vec<crate::services::provider::editor_toml::Entry>{
                let mut result=Vec::new();
                for (key,item) in doc.iter(){
                    if let Some(table)=item.as_table_like(){for(child,value)in table.iter(){result.push(crate::services::provider::editor_toml::Entry{path:vec![key.into(),child.into()],item:value.clone()});}}
                    else{result.push(crate::services::provider::editor_toml::Entry{path:vec![key.into()],item:item.clone()});}
                }
                result
            }
            let patch=crate::services::provider::editor_toml::TomlEdits::between(&entries(&base),&entries(&edited),crate::services::provider::claude_editor::ConflictPolicy::Refuse);
            crate::mode::operation::AppWrite::begin(&state.db,"codex").map_err(|e|e.to_string())?.run("apply",&[crate::mode::operation::FileChange{file:crate::live::engine::LiveFile::private(crate::codex_config::get_codex_config_path()),patch:&patch}],crate::mode::state::PendingTarget::default()).map_err(|e|e.to_string())?;
            bootstrap()
        }
        "upsertMcp" => {
            let name=required(&args,"name")?;
            let mut spec=args["value"].clone();
            let spec=spec.as_object_mut().ok_or("MCP 配置必须是对象")?;
            if let Some(headers)=spec.remove("http_headers"){spec.insert("headers".into(),headers);}
            if !spec.contains_key("type"){spec.insert("type".into(),json!(if spec.contains_key("url"){ "http" }else{"stdio"}));}
            crate::mcp::sync_single_server_to_codex(name,&json!(spec)).map_err(|e|e.to_string())?;
            Ok(json!(true))
        }
        "removeMcp" => {crate::mcp::remove_server_from_codex(required(&args,"name")?).map_err(|e|e.to_string())?;Ok(json!(true))}
        "savePrompts" => {
            let rows=args["prompts"].as_array().ok_or("提示词列表格式错误")?;
            let previous=state.db.get_prompts(&AppType::Codex).map_err(|e|e.to_string())?;
            for value in rows {
                let mut row:crate::prompt::Prompt=serde_json::from_value(value.clone()).map_err(|e|e.to_string())?;
                if !value.as_object().is_some_and(|value|value.contains_key("enabled")){row.enabled=previous.get(&row.id).is_some_and(|row|row.enabled);}
                crate::services::prompt::PromptService::upsert_prompt(state,AppType::Codex,&row.id.clone(),row).map_err(|e|e.to_string())?;
            }
            for id in previous.keys().filter(|id|!rows.iter().any(|row|row["id"].as_str()==Some(id.as_str()))){crate::services::prompt::PromptService::delete_prompt(state,AppType::Codex,id).map_err(|e|e.to_string())?;}
            bootstrap()
        }
        "togglePrompt" => {
            let id=required(&args,"id")?;
            if args["enabled"].as_bool().unwrap_or(false){crate::services::prompt::PromptService::enable_prompt(state,AppType::Codex,id).map_err(|e|e.to_string())?;}
            else{let mut row=state.db.get_prompts(&AppType::Codex).map_err(|e|e.to_string())?.get(id).cloned().ok_or("提示词已不存在")?;row.enabled=false;crate::services::prompt::PromptService::upsert_prompt(state,AppType::Codex,id,row).map_err(|e|e.to_string())?;}
            bootstrap()
        }
        "writeDocument" => {
            use crate::live::patch::{Guarded,WholeFile};
            let relative=required(&args,"path")?;
            if relative!="AGENTS.md" && !(relative.starts_with("skills/")&&relative.ends_with("/SKILL.md")){return Err("不支持修改此文档".into());}
            let path=crate::codex_config::get_codex_config_dir().join(relative);
            if crate::platform::relative(&path).is_none(){return Err("文档路径越出授权目录".into());}
            let bytes=if args["text"].is_null(){None}else{Some(required(&args,"text")?.as_bytes().to_vec())};
            let patch=Guarded{expected_pre:optional(&args,"expectedDigest").map(String::from),then:bytes.map(WholeFile::Write).unwrap_or(WholeFile::Delete)};
            crate::mode::operation::AppWrite::begin(&state.db,"codex").map_err(|e|e.to_string())?.run("apply",&[crate::mode::operation::FileChange{file:crate::live::engine::LiveFile::private(&path),patch:&patch}],crate::mode::state::PendingTarget::default()).map_err(|e|e.to_string())?;
            Ok(json!(true))
        }
        "restoreFiles" => {
            use crate::live::patch::{Guarded,WholeFile};
            use base64::Engine;
            let path=crate::codex_config::get_codex_config_path();
            let original=crate::live::engine::read_current(&path).map_err(|e|e.to_string())?;
            let target=if args["configBase64"].is_null(){None}else{Some(base64::engine::general_purpose::STANDARD.decode(required(&args,"configBase64")?).map_err(|_|"备份编码错误")?)};
            let config_patch=Guarded{expected_pre:crate::live::engine::digest(original.as_deref()),then:target.map(WholeFile::Write).unwrap_or(WholeFile::Delete)};
            let auth_path=crate::codex_config::get_codex_auth_path();
            let auth_before=crate::live::engine::read_current(&auth_path).map_err(|e|e.to_string())?;
            let auth=if args["authBase64"].is_null(){None}else{Some(base64::engine::general_purpose::STANDARD.decode(required(&args,"authBase64")?).map_err(|_|"备份认证编码错误")?)};
            let auth_patch=Guarded{expected_pre:crate::live::engine::digest(auth_before.as_deref()),then:auth.map(WholeFile::Write).unwrap_or(WholeFile::Delete)};
            let mut changes=Vec::new();
            if args.get("authBase64").is_some(){changes.push(crate::mode::operation::FileChange{file:crate::live::engine::LiveFile::private(&auth_path),patch:&auth_patch as &dyn crate::live::patch::LivePatch});}
            changes.push(crate::mode::operation::FileChange{file:crate::live::engine::LiveFile::private(&path),patch:&config_patch});
            crate::mode::operation::AppWrite::begin(&state.db,"codex").map_err(|e|e.to_string())?.run("apply",&changes,crate::mode::state::PendingTarget::default()).map_err(|e|e.to_string())?;
            bootstrap()
        }
        "saveProvider" => {
            let row_value=&args["provider"];
            let row=provider(row_value)?;
            let context: Option<EditorSave> = if args["editor"].is_object() { Some(serde_json::from_value(args["editor"].clone()).map_err(|e|e.to_string())?) } else { None };
            let exists=state.db.provider_exists(&row.id,&AppType::Codex).map_err(|e|e.to_string())?;
            let id = row.id.clone();
            if !crate::platform::documents_bound() { ProviderService::add_without_switching(state,AppType::Codex,row).map_err(|e|e.to_string())?; }
            else if exists { ProviderService::update_from_editor(state,AppType::Codex,None,row,context).map_err(|e|e.to_string())?; }
            else { ProviderService::add_from_editor(state,AppType::Codex,row,false,context).map_err(|e|e.to_string())?; }
            set_filter(state,&id,row_value["historyFilter"].as_bool().unwrap_or(false))?;
            bootstrap()
        }
        "saveProviders" => {
            let rows=args["providers"].as_array().ok_or("供应商列表格式错误")?;
            let stored=state.db.get_all_providers(&AppType::Codex).map_err(|e|e.to_string())?;
            let mut sort_updates=Vec::new();
            for (index,value) in rows.iter().enumerate() {
                let mut row=provider(value)?;row.sort_index=Some(index);
                let id=row.id.clone();
                if let Some(previous)=stored.get(&id) {
                    let mut previous=previous.clone();previous.sort_index=Some(index);
                    if serde_json::to_value(&previous).map_err(|e|e.to_string())? != serde_json::to_value(&row).map_err(|e|e.to_string())? {
                        ProviderService::update(state,AppType::Codex,None,row).map_err(|e|e.to_string())?;
                    }
                } else { ProviderService::add_without_switching(state,AppType::Codex,row).map_err(|e|e.to_string())?; }
                set_filter(state,&id,value["historyFilter"].as_bool().unwrap_or(false))?;
                sort_updates.push((id,index));
            }
            for id in stored.keys().filter(|id| !rows.iter().any(|r|r["id"].as_str()==Some(id.as_str()))) {
                ProviderService::delete(state,AppType::Codex,id).map_err(|e|e.to_string())?;
            }
            state.db.update_provider_sort_indexes(&AppType::Codex,&sort_updates).map_err(|e|e.to_string())?;
            bootstrap()
        }
        "switch_provider" => encoded(ProviderService::switch(state,AppType::Codex,required(&args,"id")?).map_err(|e|e.to_string())?),
        "selectDirect" => {
            let id=required(&args,"providerId")?;
            if crate::mode::current::is_proxy(&AppType::Codex){crate::platform::async_runtime::block_on(crate::mode::controller::exit(state,&AppType::Codex))?;}
            encoded(ProviderService::switch(state,AppType::Codex,id).map_err(|e|e.to_string())?)
        }
        "get_app_mode" => encoded(crate::mode::controller::app_mode_view(state,&AppType::Codex)?),
        "codex_forces_multi_agent_v2" => encoded(crate::codex_config::codex_config_forces_multi_agent_v2(&crate::codex_config::read_codex_config_text().map_err(|e|e.to_string())?)),
        "setMode" => {
            match required(&args,"mode")? {
                "direct" => crate::platform::async_runtime::block_on(crate::mode::controller::exit(state,&AppType::Codex))?,
                mode @ ("route"|"stack") => crate::platform::async_runtime::block_on(crate::mode::controller::enter_with_route(state,&AppType::Codex,mode=="stack",optional(&args,"providerId")))?,
                _ => return Err("模式无效".into()),
            }
            bootstrap()
        }
        "set_proxy_route" => encoded(crate::platform::async_runtime::block_on(crate::mode::controller::set_route(state,&AppType::Codex,required(&args,"providerId")?))?),
        "get_proxy_stack" => encoded(crate::mode::controller::stack_views(state,&AppType::Codex)?),
        "set_proxy_stack_member" => encoded(crate::platform::async_runtime::block_on(crate::mode::controller::set_stack_member(state,&AppType::Codex,required(&args,"providerId")?,args["enabled"].as_bool().unwrap_or(false))).map_err(|e|e.message)?),
        "get_proxy_status" => encoded(crate::platform::async_runtime::block_on(state.proxy_service.get_status())?),
        "start_proxy_server" => encoded(crate::platform::async_runtime::block_on(state.proxy_service.start())?),
        "stop_proxy_server" => { crate::platform::async_runtime::block_on(crate::mode::controller::exit(state,&AppType::Codex))?;stop_proxy_if_running(state)?;Ok(json!(true)) }
        "detach" => {crate::platform::async_runtime::block_on(crate::mode::controller::detach_all(state));Ok(json!(true))}
        "stopListener" => {stop_proxy_if_running(state)?;Ok(json!(true))}
        "stop_proxy_with_restore" => {crate::platform::async_runtime::block_on(crate::mode::controller::exit(state,&AppType::Codex))?;stop_proxy_if_running(state)?;Ok(json!(true))}
        "get_global_proxy_config" => encoded(crate::platform::async_runtime::block_on(state.db.get_global_proxy_config()).map_err(|e|e.to_string())?),
        "update_global_proxy_config" => {
            let config=serde_json::from_value(args["config"].clone()).map_err(|e|e.to_string())?;
            crate::platform::async_runtime::block_on(state.proxy_service.update_global_config(&config))?;
            if crate::mode::current::is_proxy(&AppType::Codex){crate::platform::async_runtime::block_on(crate::mode::controller::resync_codex_proxy(state))?;}
            Ok(json!(true))
        }
        "get_proxy_config_for_app" => encoded(crate::platform::async_runtime::block_on(state.db.get_proxy_config_for_app(&AppType::Codex)).map_err(|e|e.to_string())?),
        "update_proxy_config_for_app" => {
            let mut config:crate::proxy::types::AppProxyConfig=serde_json::from_value(args["config"].clone()).map_err(|e|e.to_string())?;
            let circuit=crate::proxy::CircuitBreakerConfig::from(&config);
            config.enabled=crate::mode::current::is_proxy(&AppType::Codex);
            crate::platform::async_runtime::block_on(state.db.update_proxy_config_for_app(config)).map_err(|e|e.to_string())?;
            crate::platform::async_runtime::block_on(state.proxy_service.update_circuit_breaker_config_for_app(&AppType::Codex,circuit))?;
            Ok(json!(true))
        }
        "get_auto_failover_enabled" => encoded(crate::platform::async_runtime::block_on(crate::commands::failover::get_auto_failover_enabled(HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),"codex".into()))?),
        "set_auto_failover_enabled" => {crate::platform::async_runtime::block_on(crate::commands::failover::set_auto_failover_enabled(HANDLE.get().ok_or("事件后端未就绪")?.clone(),HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),"codex".into(),args["enabled"].as_bool().unwrap_or(false)))?;Ok(json!(true))}
        "get_failover_queue" => encoded(crate::platform::async_runtime::block_on(crate::commands::failover::get_failover_queue(HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),"codex".into()))?),
        "add_to_failover_queue" => {crate::platform::async_runtime::block_on(crate::commands::failover::add_to_failover_queue(HANDLE.get().ok_or("事件后端未就绪")?.clone(),HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),"codex".into(),required(&args,"providerId")?.into()))?;Ok(json!(true))}
        "remove_from_failover_queue" => {crate::platform::async_runtime::block_on(crate::commands::failover::remove_from_failover_queue(HANDLE.get().ok_or("事件后端未就绪")?.clone(),HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),"codex".into(),required(&args,"providerId")?.into()))?;Ok(json!(true))}
        "get_current_matches" => {
            let rows=state.db.get_all_providers(&AppType::Codex).map_err(|e|e.to_string())?;
            let mut matches=serde_json::Map::new();
            if !crate::mode::current::is_proxy(&AppType::Codex) {
                for (id,row) in rows {
                    if crate::services::provider::codex_editor::matches_current(state,&row).unwrap_or(false){matches.insert(id,json!("exact"));}
                }
            }
            Ok(Value::Object(matches))
        }
        "update_provider_sort_order" => {
            let entries=args["updates"].as_array().ok_or("排序列表格式错误")?;
            let updates=entries.iter().map(|v|Ok((required(v,"id")?.to_owned(),v["sortIndex"].as_u64().ok_or("排序位置无效")? as usize))).collect::<Result<Vec<_>,String>>()?;
            state.db.update_provider_sort_indexes(&AppType::Codex,&updates).map_err(|e|e.to_string())?;Ok(json!(true))
        }
        "queryProviderUsage" => encoded(crate::platform::async_runtime::block_on(ProviderService::query_usage(state,AppType::Codex,required(&args,"providerId")?)).map_err(|e|e.to_string())?),
        "testUsageScript" => encoded(crate::platform::async_runtime::block_on(ProviderService::test_usage_script(state,AppType::Codex,required(&args,"providerId")?,required(&args,"scriptCode")?,args["timeout"].as_u64().unwrap_or(15),optional(&args,"apiKey"),optional(&args,"baseUrl"),optional(&args,"accessToken"),optional(&args,"userId"),optional(&args,"templateType"))).map_err(|e|e.to_string())?),
        "fetch_models_for_config" => {
            let user_agent=optional(&args,"userAgent").map(http::HeaderValue::from_str).transpose().map_err(|e|e.to_string())?;
            let headers:Option<std::collections::BTreeMap<String,String>>=if args["requestHeaders"].is_object(){Some(serde_json::from_value(args["requestHeaders"].clone()).map_err(|e|e.to_string())?)}else{None};
            encoded(crate::platform::async_runtime::block_on(crate::services::model_fetch::fetch_models(required(&args,"baseUrl")?,args["apiKey"].as_str().unwrap_or(""),args["isFullUrl"].as_bool().unwrap_or(false),optional(&args,"modelsUrl"),user_agent,optional(&args,"apiFormat"),headers.as_ref()))?)
        }
        "test_api_endpoints" => encoded(crate::platform::async_runtime::block_on(crate::services::speedtest::SpeedtestService::test_endpoints(serde_json::from_value(args["urls"].clone()).map_err(|e|e.to_string())?,args["timeoutSecs"].as_u64())).map_err(|e|e.to_string())?),
        "get_usage_summary" => encoded(state.db.get_usage_summary(start,end,Some("codex"),name,model).map_err(|e|e.to_string())?),
        "get_usage_trends" => encoded(state.db.get_daily_trends(start,end,Some("codex"),name,model).map_err(|e|e.to_string())?),
        "get_provider_stats" => encoded(state.db.get_provider_stats(start,end,Some("codex"),name,model).map_err(|e|e.to_string())?),
        "get_model_stats" => encoded(state.db.get_model_stats(start,end,Some("codex"),name,model).map_err(|e|e.to_string())?),
        "get_request_logs" => {
            let filters=serde_json::from_value(args.get("filters").unwrap_or(&args).clone()).map_err(|e|e.to_string())?;
            encoded(state.db.get_request_logs(&filters,args["page"].as_u64().unwrap_or(0) as u32,args["pageSize"].as_u64().unwrap_or(20) as u32).map_err(|e|e.to_string())?)
        }
        "get_request_detail" => encoded(state.db.get_request_detail(required(&args,"requestId")?).map_err(|e|e.to_string())?),
        "get_usage_first_date" => encoded(state.db.get_first_usage_date(Some("codex"),name,model).map_err(|e|e.to_string())?),
        "get_usage_summary_by_app" => encoded(state.db.get_usage_summary_by_app(start,end,name,model).map_err(|e|e.to_string())?),
        "get_session_usage_summary" => encoded(state.db.get_session_usage_summary("codex",required(&args,"sessionId")?).map_err(|e|e.to_string())?),
        "sync_session_usage" | "rebuild_codex_usage" => {
            if command=="rebuild_codex_usage"{state.db.reset_codex_usage().map_err(|e|e.to_string())?;}
            let result=crate::services::session_usage_codex::sync_codex_usage(&state.db).map_err(|e|e.to_string())?;
            crate::services::session_usage::record_sync_completed(chrono::Utc::now().timestamp_millis());
            crate::platform::emit_event("usage-updated", &true);
            encoded(result)
        }
        "get_session_usage_last_sync" => encoded(crate::services::session_usage::last_sync_completed_at()),
        "get_model_pricing" => {
            use crate::services::model_pricing::ModelPricingInfo;
            state.db.ensure_model_pricing_seeded().map_err(|e|e.to_string())?;
            crate::services::model_pricing::sync_local_model_pricing(&state.db).map_err(|e|e.to_string())?;
            let conn=crate::database::lock_conn!(state.db.conn);
            let mut stmt=conn.prepare("SELECT model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million FROM model_pricing ORDER BY display_name").map_err(|e|e.to_string())?;
            let rows=stmt.query_map([],|row|Ok(ModelPricingInfo{model_id:row.get(0)?,display_name:row.get(1)?,input_cost_per_million:row.get(2)?,output_cost_per_million:row.get(3)?,cache_read_cost_per_million:row.get(4)?,cache_creation_cost_per_million:row.get(5)?})).map_err(|e|e.to_string())?;
            encoded(rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?)
        }
        "update_model_pricing" => {
            let row=crate::services::model_pricing::ModelPricingInfo{model_id:required(&args,"modelId")?.into(),display_name:required(&args,"displayName")?.into(),input_cost_per_million:required(&args,"inputCost")?.into(),output_cost_per_million:required(&args,"outputCost")?.into(),cache_read_cost_per_million:required(&args,"cacheReadCost")?.into(),cache_creation_cost_per_million:required(&args,"cacheCreationCost")?.into()};
            encoded(crate::services::model_pricing::update_model_pricing(&state.db,row).map_err(|e|e.to_string())?)
        }
        "update_model_pricing_batch" => encoded(crate::services::model_pricing::update_model_pricing_batch(&state.db,serde_json::from_value(args["entries"].clone()).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?),
        "delete_model_pricing" => {crate::services::model_pricing::delete_model_pricing(&state.db,required(&args,"modelId")?).map_err(|e|e.to_string())?;Ok(json!(true))}
        "get_models_dev_sync_config" => encoded(crate::services::model_pricing::get_models_dev_sync_state(&state.db).map_err(|e|e.to_string())?),
        "save_models_dev_sync_config" => {crate::services::model_pricing::save_models_dev_sync_config(&state.db,serde_json::from_value(args["config"].clone()).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;Ok(json!(true))}
        "record_models_dev_sync_result" => {crate::services::model_pricing::record_models_dev_sync_result(&state.db,args["syncedAt"].as_i64(),optional(&args,"error").map(String::from)).map_err(|e|e.to_string())?;Ok(json!(true))}
        "fetch_models_dev" | "fetch_models_dev_data" => encoded(crate::platform::async_runtime::block_on(crate::services::model_pricing::fetch_models_dev())?),
        "get_usage_data_sources" => {
            let conn=crate::database::lock_conn!(state.db.conn);
            let mut stmt=conn.prepare("SELECT COALESCE(data_source,'proxy'),COUNT(*),COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) FROM proxy_request_logs WHERE app_type='codex' GROUP BY data_source").map_err(|e|e.to_string())?;
            let rows=stmt.query_map([],|row|Ok(json!({"dataSource":row.get::<_,String>(0)?,"requestCount":row.get::<_,i64>(1)?,"totalCostUsd":row.get::<_,f64>(2)?.to_string()}))).map_err(|e|e.to_string())?;
            encoded(rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?)
        }
        "auth_get_status" | "auth_list_accounts" => {
            if required(&args,"authProvider")?!="codex_oauth"{return Err("安卓版仅支持 Codex 授权".into());}
            let status=crate::platform::async_runtime::block_on(state.codex_oauth_manager.get_status());
            let accounts=status.accounts.into_iter().map(|a|auth_account(a,status.default_account_id.as_deref())).collect::<Vec<_>>();
            if command=="auth_list_accounts"{Ok(json!(accounts))}else{Ok(json!({"provider":"codex_oauth","authenticated":status.authenticated,"default_account_id":status.default_account_id,"migration_error":null,"accounts":accounts}))}
        }
        "auth_start_login" => {
            if required(&args,"authProvider")?!="codex_oauth"{return Err("安卓版仅支持 Codex 授权".into());}
            let response=crate::platform::async_runtime::block_on(async{
                if args["loginMethod"]=="browser"{state.codex_oauth_manager.start_browser_flow(optional(&args,"targetAccountId")).await}
                else{state.codex_oauth_manager.start_device_flow(optional(&args,"targetAccountId")).await}
            }).map_err(|e|e.to_string())?;
            let mut value=encoded(response)?;value["provider"]=json!("codex_oauth");Ok(value)
        }
        "auth_poll_for_account" => {
            if required(&args,"authProvider")?!="codex_oauth"{return Err("安卓版仅支持 Codex 授权".into());}
            let result=crate::platform::async_runtime::block_on(state.codex_oauth_manager.poll_for_token(required(&args,"deviceCode")?,||async{state.proxy_service.lock_switch_for_app("codex").await}));
            match result{
                Ok(account)=>{let default=crate::platform::async_runtime::block_on(state.codex_oauth_manager.default_account_id());Ok(account.map(|a|auth_account(a,default.as_deref())).unwrap_or(Value::Null))}
                Err(crate::proxy::providers::codex_oauth_auth::CodexOAuthError::AuthorizationPending)=>Ok(Value::Null),
                Err(error)=>Err(error.to_string()),
            }
        }
        "auth_cancel_login" => encoded(crate::platform::async_runtime::block_on(state.codex_oauth_manager.cancel_device_flow(required(&args,"deviceCode")?))),
        "auth_set_default_account" => {crate::platform::async_runtime::block_on(state.codex_oauth_manager.set_default_account(required(&args,"accountId")?)).map_err(|e|e.to_string())?;Ok(json!(true))}
        "auth_remove_account" | "auth_logout" => {
            crate::platform::async_runtime::block_on(async{
                let _guard=state.proxy_service.lock_switch_for_app("codex").await;
                let removed=if command=="auth_remove_account"{
                    let id=required(&args,"accountId")?;
                    state.codex_oauth_manager.remove_account(id).await.map_err(|e|e.to_string())?;vec![id.to_owned()]
                }else{
                    let removed=state.codex_oauth_manager.list_accounts().await.into_iter().map(|a|a.id).collect::<Vec<_>>();
                    state.codex_oauth_manager.clear_auth().await.map_err(|e|e.to_string())?;removed
                };
                state.db.unbind_codex_managed_accounts(&removed).map_err(|e|e.to_string())?;Ok::<_,String>(())
            })?;bootstrap()
        }
        "get_subscription_quota" => encoded(crate::platform::async_runtime::block_on(crate::services::subscription::get_subscription_quota("codex"))?),
        "get_codex_oauth_quota" | "get_codex_oauth_models" => {
            let manager=&state.codex_oauth_manager;
            crate::platform::async_runtime::block_on(async{
                let id=optional(&args,"accountId").map(String::from).or(manager.default_account_id().await);
                let Some(id)=id else{return if command=="get_codex_oauth_quota"{encoded(crate::services::subscription::SubscriptionQuota::not_found("codex_oauth"))}else{Err("没有可用的 ChatGPT 账号".into())};};
                let token=manager.get_valid_token_for_account(&id).await.map_err(|e|e.to_string())?;
                let workspace=manager.chatgpt_account_id_for_account(&id).await.map_err(|e|e.to_string())?;
                if command=="get_codex_oauth_models"{encoded(crate::services::codex_oauth_models::fetch_models_with_token(&token,&workspace).await?)}
                else{let quota=crate::services::subscription::query_codex_quota(&token,Some(&workspace),"codex_oauth","登录已失效，请重新登录").await?;state.usage_cache.put_codex_oauth(id,quota.clone());encoded(quota)}
            })
        }
        "acknowledge_codex_stale_clients" => {crate::services::provider::codex_client_catalog::acknowledge(&crate::live::engine::DeviceStore::for_device());Ok(json!(true))}
        "adopt_codex_stack_catalog" => encoded(crate::platform::async_runtime::block_on(crate::mode::controller::adopt_codex_stack_catalog(state))?),
        "get_settings" => {
            let mut value=encoded(crate::settings::get_settings_for_frontend())?;
            let mut visible=serde_json::Map::new();
            for app in AppType::all(){visible.insert(app.as_str().into(),Value::Bool(app==AppType::Codex));}
            value["visibleApps"]=Value::Object(visible);value["language"]=json!("zh");Ok(value)
        }
        "save_settings" => {
            encoded(crate::platform::async_runtime::block_on(crate::commands::settings::save_settings(HANDLE.get().ok_or("事件后端未就绪")?.clone(),HANDLE.get().ok_or("事件后端未就绪")?.state::<AppState>(),serde_json::from_value(args["settings"].clone()).map_err(|e|e.to_string())?))?)
        }
        "recover" => encoded(crate::mode::operation::settle(&state.db,"codex").map_err(|e|e.to_string())?.map(|outcome|format!("{outcome:?}"))),
        _ => Err(format!("原生后端未暴露命令: {command}")),
    }
}
