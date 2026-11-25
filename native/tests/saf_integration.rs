//! Exercise the APK's real upstream provider/mode/writer/streaming path through
//! a document transport. The transport can fail exactly one publication and
//! change files while a transaction is staged, as a SAF provider can.
use cc_switch_android_core::{api, platform};
use serde_json::{json,Value};
use std::{collections::HashMap,io::{Read,Write},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},net::TcpListener,time::Duration};

#[derive(Default)]
struct Documents {
    trees:Mutex<HashMap<String,HashMap<String,Vec<u8>>>>,
    current:Mutex<String>,
    fail:Mutex<Option<String>>,
    revoked:AtomicBool,
    reads:Mutex<Vec<String>>,
    writes:Mutex<Vec<String>>,
}
impl Documents {
    fn select(&self,name:&str){*self.current.lock().unwrap()=name.into();}
    fn put(&self,path:&str,text:&str){self.trees.lock().unwrap().entry(self.current.lock().unwrap().clone()).or_default().insert(path.into(),text.as_bytes().to_vec());}
    fn text(&self,path:&str)->Option<String>{self.trees.lock().unwrap().get(&*self.current.lock().unwrap()).and_then(|t|t.get(path)).map(|b|String::from_utf8(b.clone()).unwrap())}
}
impl platform::Documents for Documents {
    fn read(&self,path:&str)->std::io::Result<Option<Vec<u8>>>{
        if self.revoked.load(Ordering::SeqCst){return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));}
        self.reads.lock().unwrap().push(path.into());
        Ok(self.trees.lock().unwrap().get(&*self.current.lock().unwrap()).and_then(|t|t.get(path)).cloned())
    }
    fn write(&self,path:&str,bytes:&[u8])->std::io::Result<()>{
        if self.revoked.load(Ordering::SeqCst){return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));}
        let mut fail=self.fail.lock().unwrap();
        if fail.as_deref()==Some(path){*fail=None;return Err(std::io::Error::other("synthetic SAF publication failure"));}
        self.writes.lock().unwrap().push(path.into());
        self.trees.lock().unwrap().entry(self.current.lock().unwrap().clone()).or_default().insert(path.into(),bytes.to_vec());Ok(())
    }
    fn delete(&self,path:&str)->std::io::Result<()>{
        if self.revoked.load(Ordering::SeqCst){return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));}
        self.writes.lock().unwrap().push(path.into());
        if let Some(tree)=self.trees.lock().unwrap().get_mut(&*self.current.lock().unwrap()){tree.remove(path);}Ok(())
    }
    fn emit(&self,_:&str,_:&str){}
}
fn call(name:&str,args:Value)->Value{api::call(name,args).unwrap_or_else(|error|panic!("{name}: {error}"))}
fn row(id:&str,base:&str,model:&str,filter:bool)->Value{
    json!({"id":id,"name":id,"category":"custom","historyFilter":filter,
        "settingsConfig":{"auth":{"OPENAI_API_KEY":format!("TEST_ONLY_{id}")},
            "config":format!("model_provider = \"custom\"\nmodel = \"{model}\"\nmodel_reasoning_effort = \"high\"\n[model_providers.custom]\nname = \"{id}\"\nbase_url = \"{base}\"\nwire_api = \"responses\"\n")}})
}
const ORIGINAL:&str="model = 'gpt-5.5'\ncwd = '/home/codex/workspace'\ncli_auth_credentials_store = 'file'\n[mcp_servers.android]\ncommand = '/usr/local/bin/mcp-android'\nargs = ['--stdio']\n[projects.'/home/codex/workspace']\ntrust_level = 'trusted'\n[features]\nmulti_agent = true\n";

#[test]
fn upstream_codex_saf_workflow(){
    let dir=tempfile::tempdir().unwrap();
    let docs=Arc::new(Documents::default());docs.select("A");docs.put("config.toml",ORIGINAL);
    let payload=base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD,br#"{"sub":"fixture","exp":4102444800,"https://api.openai.com/auth":{"chatgpt_account_id":"fixture-workspace"}}"#);
    let token=format!("test.{payload}.test");
    let login=json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":token,"id_token":token,"refresh_token":"TEST_ONLY_REFRESH","account_id":"fixture-workspace"},"last_refresh":"2026-11-24T00:00:00Z"}).to_string();
    docs.put("auth.json",&login);
    let legacy=json!({"providers":[],"loginStashes":{"content://test/tree/A":{"logins":{"account:fixture-workspace":serde_json::from_str::<Value>(&login).unwrap()},"last":"account:fixture-workspace","version":1}},"uiData":{"settings":{"usageDashboardRefreshIntervalMs":120000},"pricing":[{"modelId":"migration-fixture","displayName":"Migration fixture","inputCostPerMillion":"1","outputCostPerMillion":"2","cacheReadCostPerMillion":"0.5","cacheCreationCostPerMillion":"0"}]}});
    api::initialize(dir.path().to_path_buf(),docs.clone(),legacy).unwrap();
    assert!(platform::document_state_for("content://test/tree/A").unwrap().join("codex-login-stash.json").is_file());
    assert_eq!(call("get_settings",json!({}))["usageDashboardRefreshIntervalMs"],120000);
    assert!(call("get_model_pricing",json!({})).as_array().unwrap().iter().any(|row|row["modelId"]=="migration-fixture"));
    call("bindDocuments",json!({"uri":""}));
    docs.revoked.store(true,Ordering::SeqCst);
    let mut offline=row("offline","https://example.invalid/v1","gpt-5.5",false);
    offline["meta"]=json!({"customEndpoints":["https://one.example.invalid/v1"],"autoSelect":true});
    call("saveProvider",json!({"provider":offline}));
    let saved=call("bootstrap",json!({}));
    let saved=saved["providers"].as_array().unwrap().iter().find(|p|p["id"]=="offline").unwrap();
    assert_eq!(saved["meta"]["endpointAutoSelect"],true);
    assert_eq!(saved["meta"]["custom_endpoints"]["https://one.example.invalid/v1"]["url"],"https://one.example.invalid/v1");
    call("saveProviders",json!({"providers":[]}));
    docs.revoked.store(false,Ordering::SeqCst);
    println!("PASS upgrade migrates login stash, custom endpoints, usage settings/prices and unbound profile saves");
    // The Android directory picker suspends the old transport before it saves
    // the first grant. No proxy exists on a fresh install; cleanup must succeed
    // without writing client files or requiring a foreground router service.
    let writes_before=docs.writes.lock().unwrap().len();
    assert_eq!(call("get_proxy_status",json!({}))["running"],false);
    call("suspendDocuments",json!({}));
    call("suspendDocuments",json!({}));
    call("stopListener",json!({}));
    assert_eq!(docs.writes.lock().unwrap().len(),writes_before);
    call("bindDocuments",json!({"uri":"content://test/tree/A"}));
    call("startup",json!({}));
    assert_eq!(call("get_app_mode",json!({}))["mode"],"direct");
    assert_eq!(call("get_proxy_status",json!({}))["running"],false);
    println!("PASS first directory grant completes while the upstream proxy is stopped");
    let initialized=call("initializeProviders",json!({}));
    assert!(initialized["providers"].as_array().unwrap().iter().any(|p|p["id"]=="default"));
    let first_count=initialized["providers"].as_array().unwrap().len();
    assert_eq!(call("initializeProviders",json!({}))["providers"].as_array().unwrap().len(),first_count);
    println!("PASS initial upstream live import and official seed are idempotent");
    call("saveProvider",json!({"provider":row("A","http://127.0.0.1:1/v1","gpt-5.5",false)}));
    call("saveProvider",json!({"provider":row("B","http://127.0.0.1:2/v1","gpt-5.5",false)}));
    let view=call("get_provider_editor_view",json!({"provider":row("A","http://127.0.0.1:1/v1","gpt-5.5",false)}));
    assert!(view["settings"]["config"].as_str().unwrap().contains("mcp_servers.android"));
    call("switch_provider",json!({"id":"A"}));
    let config=docs.text("config.toml").unwrap();
    let parsed:toml::Value=config.parse().unwrap();
    assert_eq!(parsed["model_providers"]["custom"]["experimental_bearer_token"].as_str(),Some("TEST_ONLY_A"));
    assert_eq!(parsed["mcp_servers"]["android"]["command"].as_str(),Some("/usr/local/bin/mcp-android"));
    assert_eq!(parsed["cwd"].as_str(),Some("/home/codex/workspace"));
    assert_eq!(parsed["projects"]["/home/codex/workspace"]["trust_level"].as_str(),Some("trusted"));
    assert_eq!(call("get_current_matches",json!({}))["A"],"exact");
    assert!(docs.text("auth.json").is_none(),"upstream default stashes native login when switching to third party");
    call("switch_provider",json!({"id":"default"}));
    assert_eq!(serde_json::from_str::<Value>(&docs.text("auth.json").unwrap()).unwrap(),serde_json::from_str::<Value>(&login).unwrap());
    println!("PASS real upstream route/key projection, unrelated fields and official login stash/restore");
    *docs.fail.lock().unwrap()=Some("config.toml".into());
    assert!(api::call("switch_provider",json!({"id":"B"})).is_err());
    assert!(call("bootstrap",json!({}))["pendingRecovery"].as_bool().unwrap());
    docs.put("config.toml",&(docs.text("config.toml").unwrap()+"\n# external change during pending recovery\n"));
    call("recover",json!({}));
    assert!(docs.text("config.toml").unwrap().contains("external change during pending recovery"));
    assert!(!call("bootstrap",json!({}))["pendingRecovery"].as_bool().unwrap());
    println!("PASS partial publication recovery preserves external edits");
    docs.revoked.store(true,Ordering::SeqCst);
    assert!(api::call("switch_provider",json!({"id":"A"})).is_err());
    docs.revoked.store(false,Ordering::SeqCst);
    let before=docs.text("config.toml").unwrap();
    assert!(api::call("editConfig",json!({"base":before,"config":"[invalid"})).is_err());
    assert_eq!(docs.text("config.toml").unwrap(),before);
    println!("PASS revoked grant and malformed TOML report errors without success");
    let edited=before.replace("multi_agent = true","multi_agent = false");
    docs.put("config.toml",&(before.clone()+"\n# concurrent editor change\n"));
    call("editConfig",json!({"base":before,"config":edited}));
    assert!(docs.text("config.toml").unwrap().contains("concurrent editor change"));
    println!("PASS raw editor uses upstream three-way edits");
    call("upsertMcp",json!({"name":"extra","value":{"command":"/usr/bin/true","type":"stdio","timeout":3000,"env":{"FIXTURE":"1"}}}));
    let mcp:toml::Value=docs.text("config.toml").unwrap().parse().unwrap();
    assert_eq!(mcp["mcp_servers"]["extra"]["command"].as_str(),Some("/usr/bin/true"));
    assert!(mcp["mcp_servers"]["extra"].get("type").is_none());assert!(mcp["mcp_servers"]["extra"].get("timeout").is_none());
    assert_eq!(mcp["mcp_servers"]["android"]["command"].as_str(),Some("/usr/local/bin/mcp-android"));
    call("removeMcp",json!({"name":"extra"}));
    docs.put("AGENTS.md","Original user instructions");
    call("savePrompts",json!({"prompts":[{"id":"prompt","name":"Prompt","content":"Replacement instructions"}]}));
    call("togglePrompt",json!({"id":"prompt","enabled":true}));
    assert_eq!(docs.text("AGENTS.md").as_deref(),Some("Replacement instructions"));
    assert!(call("bootstrap",json!({}))["prompts"].as_array().unwrap().iter().any(|row|row["content"]=="Original user instructions"));
    docs.put("AGENTS.md","External prompt edit");
    call("togglePrompt",json!({"id":"prompt","enabled":false}));
    assert_eq!(docs.text("AGENTS.md").as_deref(),Some(""));
    call("savePrompts",json!({"prompts":[]}));
    println!("PASS original MCP field conversion/removal and prompt backup/enable/disable");

    // Real upstream streaming proxy; captured upstream body checks exact filter
    // boundaries, including tool call_id and nested IDs.
    let server=TcpListener::bind("127.0.0.1:0").unwrap();let port=server.local_addr().unwrap().port();
    let captured=Arc::new(Mutex::new(None::<Value>));let capture=captured.clone();
    let worker=std::thread::spawn(move||{
        let (mut socket,_)=server.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut bytes=Vec::new();let mut buffer=[0u8;4096];
        let (head,len)=loop{let count=socket.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);if let Some(head)=bytes.windows(4).position(|w|w==b"\r\n\r\n"){let text=String::from_utf8_lossy(&bytes[..head]);let len=text.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap();break(head+4,len);}};
        while bytes.len()<head+len{let count=socket.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);}
        *capture.lock().unwrap()=Some(serde_json::from_slice(&bytes[head..head+len]).unwrap());
        let events="event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":15,\"output_tokens\":3,\"input_tokens_details\":{\"cached_tokens\":5}}}}\n\n";
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",events.len(),events).unwrap();
    });
    let relay=row("relay",&format!("http://127.0.0.1:{port}/v1"),"gpt-5.5",true);
    call("saveProvider",json!({"provider":relay}));
    let socket=TcpListener::bind("127.0.0.1:0").unwrap();let free=socket.local_addr().unwrap().port();drop(socket);
    let mut config=call("get_global_proxy_config",json!({}));config["listenPort"]=json!(free);
    call("update_global_proxy_config",json!({"config":config}));
    call("setMode",json!({"mode":"route","providerId":"relay"}));
    let status=call("get_proxy_status",json!({}));assert_eq!(status["running"],true);
    let listen=status["port"].as_u64().unwrap();
    let request=json!({"model":"gpt-5.5","stream":true,"store":true,"include":["reasoning.encrypted_content","message.output_text"],"reasoning":{"effort":"high"},"input":[{"type":"reasoning","id":"reasoning_id","encrypted_content":"opaque"},{"type":"message","role":"user","id":"message_id","content":[{"type":"input_text","text":"fixture","id":"nested_id"}]},{"type":"function_call","id":"item_id","call_id":"call_keep","name":"tool","arguments":"{}"},{"type":"function_call_output","id":"output_id","call_id":"call_keep","output":"fixture"}]});
    let body=platform::async_runtime::block_on(async{let response=reqwest::Client::new().post(format!("http://127.0.0.1:{listen}/v1/responses")).header("Authorization","Bearer fixture").json(&request).send().await.unwrap();assert!(response.status().is_success(),"{}",response.status());response.text().await.unwrap()});
    assert!(body.contains("response.output_text.delta")&&body.contains("resp_test"));worker.join().unwrap();
    let body=captured.lock().unwrap().clone().unwrap();assert_eq!(body["store"],false);assert_eq!(body["reasoning"]["effort"],"high");assert_eq!(body["input"].as_array().unwrap().len(),3);assert!(body["input"][0].get("id").is_none());assert_eq!(body["input"][0]["content"][0]["id"],"nested_id");assert_eq!(body["input"][1]["call_id"],"call_keep");
    println!("PASS upstream SSE proxy, optional filter, nested IDs and call_id preservation");
    call("setMode",json!({"mode":"stack","providerId":"relay"}));
    let mut stack_settings=call("get_settings",json!({}));
    stack_settings["codexProxyWithoutOfficialLogin"]=json!(true);
    *docs.fail.lock().unwrap()=Some("config.toml".into());
    assert!(api::call("save_settings",json!({"settings":stack_settings})).is_err());
    assert_eq!(call("get_settings",json!({}))["codexProxyWithoutOfficialLogin"],false);
    call("recover",json!({}));
    println!("PASS original settings rollback when Stack publication fails");
    call("set_proxy_stack_member",json!({"providerId":"A","enabled":true}));
    let stack=call("get_proxy_stack",json!({}));assert_eq!(stack["active"],true);assert!(stack["members"].as_array().unwrap().iter().any(|m|m["providerId"]=="A"));
    call("set_proxy_stack_member",json!({"providerId":"A","enabled":false}));
    call("add_to_failover_queue",json!({"providerId":"A"}));call("add_to_failover_queue",json!({"providerId":"B"}));assert_eq!(call("get_failover_queue",json!({})).as_array().unwrap().len(),2);
    assert!(api::call("set_auto_failover_enabled",json!({"enabled":true})).is_err(),"Stack uses original rejection");
    call("setMode",json!({"mode":"route","providerId":"relay"}));
    call("set_auto_failover_enabled",json!({"enabled":true}));
    assert_eq!(call("get_auto_failover_enabled",json!({})),true);
    assert_eq!(call("get_app_mode",json!({}))["routeProviderId"],"A");
    call("set_auto_failover_enabled",json!({"enabled":false}));
    assert!(api::call("add_to_failover_queue",json!({"providerId":"codex-official"})).is_err());
    call("setMode",json!({"mode":"direct"}));
    call("stop_proxy_with_restore",json!({}));
    call("stop_proxy_server",json!({}));
    call("stopListener",json!({}));
    assert_eq!(call("get_proxy_status",json!({}))["running"],false);
    println!("PASS upstream Stack add/remove, failover queue and return to direct");
    // Exact original parser and SQLite queries: a cached SAF session is joined
    // with real proxy logs and re-imported without inflating its token count.
    let cache=platform::session_cache_directory().unwrap().join("sessions/2026/11/24");std::fs::create_dir_all(&cache).unwrap();
    let events=[
        json!({"timestamp":"2026-11-24T00:00:00Z","type":"session_meta","payload":{"id":"11111111-2222-3333-4444-555555555555","cwd":"/home/codex/workspace","originator":"codex_cli_rs","source":"cli","model_provider":"openai"}}),
        json!({"timestamp":"2026-11-24T00:00:01Z","type":"turn_context","payload":{"model":"gpt-5.5"}}),
        json!({"timestamp":"2026-11-24T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"A searchable session fixture"}}),
        json!({"timestamp":"2026-11-24T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A searchable session fixture"}]}}),
        json!({"timestamp":"2026-11-24T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The original reader preserves this reply"}]}}),
        json!({"timestamp":"2026-11-24T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110}}}}),
    ];
    std::fs::write(cache.join("rollout-2026-11-24T00-00-00-11111111-2222-3333-4444-555555555555.jsonl"),events.iter().map(|e|format!("{e}\n")).collect::<String>()).unwrap();
    let synced=call("sync_session_usage",json!({}));assert!(synced["errors"].as_array().unwrap().is_empty());assert_eq!(synced["imported"],1);
    let summary=call("get_usage_summary",json!({}));let second=call("sync_session_usage",json!({}));assert_eq!(second["imported"],0);assert_eq!(summary,call("get_usage_summary",json!({})));
    assert!(call("get_model_pricing",json!({})).as_array().unwrap().len()>5);
    let sessions=call("list_sessions",json!({}));let source=sessions[0]["sourcePath"].as_str().unwrap();assert!(source.starts_with("sessions/"));
    let transcript=call("getSessionTranscript",json!({"sourcePath":source}));assert!(transcript["messages"].as_array().unwrap().iter().any(|m|m.to_string().contains("original reader")));
    let mut settings=call("get_settings",json!({}));settings["sessionContentSearchEnabled"]=json!(true);call("save_settings",json!({"settings":settings}));
    call("sync_session_index",json!({}));
    let mut hits=call("search_session_content",json!({"query":"searchable"}));
    for _ in 0..200 {if !hits["hits"].as_array().unwrap().is_empty(){break;}std::thread::sleep(Duration::from_millis(10));hits=call("search_session_content",json!({"query":"searchable"}));}
    assert_eq!(hits["hits"].as_array().unwrap().len(),1);
    assert!(hits["hits"][0]["sourcePath"].as_str().unwrap().starts_with("sessions/"));
    call("clear_session_index",json!({}));assert!(!platform::document_state_directory().unwrap().join("session-index.db").exists());
    println!("PASS original session token parser, incremental deduplication, prices and native dashboard");
    println!("PASS original session metadata, transcript, portable source and FTS search");
    // Pending intents and native login caches are isolated across trees.
    call("switch_provider",json!({"id":"default"}));
    *docs.fail.lock().unwrap()=Some("config.toml".into());let _=api::call("switch_provider",json!({"id":"A"}));
    assert_eq!(call("bootstrap",json!({}))["pendingRecovery"],true);
    docs.select("B");docs.put("config.toml","# Tree B must remain unchanged\n");call("bindDocuments",json!({"uri":"content://test/tree/B"}));
    assert_eq!(call("bootstrap",json!({}))["pendingRecovery"],false);call("recover",json!({}));assert_eq!(docs.text("config.toml").unwrap(),"# Tree B must remain unchanged\n");
    docs.select("A");call("bindDocuments",json!({"uri":"content://test/tree/A"}));assert_eq!(call("bootstrap",json!({}))["pendingRecovery"],true);call("recover",json!({}));
    println!("PASS pending operation cannot be replayed into a different SAF tree");
}
