//! Android transport for upstream session readers and content references.
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
use crate::session_manager::{self,content,model};
use std::sync::atomic::{AtomicBool,Ordering};
static INDEX_ENABLED:AtomicBool=AtomicBool::new(true);
pub(crate) fn index_enabled()->bool{INDEX_ENABLED.load(Ordering::SeqCst)&&crate::platform::documents_bound()}
pub(crate) fn suspend_index(){INDEX_ENABLED.store(false,Ordering::SeqCst);session_manager::search::suspend_for_document_change();}
pub(crate) fn resume_index(){INDEX_ENABLED.store(true,Ordering::SeqCst);}

fn path(args:&Value)->Result<PathBuf,String>{
    let relative=args["sourcePath"].as_str().ok_or("缺少会话文档路径")?;
    let root=crate::platform::session_cache_directory().ok_or("会话目录尚未授权")?;
    let path=root.join(relative);
    if !path.starts_with(&root)||Path::new(relative).is_absolute()||relative.split('/').any(|p|p.is_empty()||p=="."||p==".."||p.contains('\\'))||
        !(relative.starts_with("sessions/")||relative.starts_with("archived_sessions/"))||!(relative.ends_with(".jsonl")||relative.ends_with(".jsonl.zst")){return Err("会话文档路径不在授权目录内".into());}
    Ok(path)
}
fn encode<T:serde::Serialize>(value:T)->Result<Value,String>{serde_json::to_value(value).map_err(|e|e.to_string())}
pub fn call(command:&str,args:&Value)->Result<Value,String>{
    match command{
        "list_sessions"=>{
            let mut rows=session_manager::scan_sessions();
            let root=crate::platform::session_cache_directory().ok_or("会话目录尚未授权")?;
            for row in &mut rows{if let Some(path)=&row.source_path{let relative=Path::new(path).strip_prefix(&root).map_err(|_|"会话缓存目录发生变化")?;row.source_path=Some(relative.to_string_lossy().into());}}
            encode(rows)
        }
        "get_session_messages" | "getSessionTranscript"=>{
            let path=path(args)?;let loaded=session_manager::load_transcript("codex",path.to_str().ok_or("会话路径不是 UTF-8")?)?;
            if command=="get_session_messages"{encode(&loaded.transcript.messages)}
            else{Ok(json!({"messages":loaded.transcript.messages,"turns":loaded.transcript.turns,"cached":loaded.cached,"parseMs":loaded.parse_ms,"payloadBytes":loaded.transcript.approx_bytes}))}
        }
        "get_session_block_content"=>{
            let path=path(args)?;let source=content::validate_source("codex",path.to_str().ok_or("会话路径不是 UTF-8")?)?;
            let reference:model::ContentRef=serde_json::from_value(args["contentRef"].clone()).map_err(|e|e.to_string())?;
            let full=content::resolve_content_ref(&source,&reference)?;
            encode(content::paginate(&full,args["offset"].as_u64().map(|v|v as u32),args["limit"].as_u64().map(|v|v as u32)))
        }
        "get_session_image"=>{
            let path=path(args)?;let source=content::validate_source("codex",path.to_str().ok_or("会话路径不是 UTF-8")?)?;
            let reference:model::ImageRef=serde_json::from_value(args["imageRef"].clone()).map_err(|e|e.to_string())?;
            let bytes=content::load_image(&source,&reference)?;
            use base64::Engine;
            Ok(json!(format!("data:{};base64,{}",reference.media_type,base64::engine::general_purpose::STANDARD.encode(bytes))))
        }
        "sync_session_index"=>encode(session_manager::search::start_sync(|status|crate::platform::emit_event("session-index-status",&status))),
        "clear_session_index"=>{session_manager::search::clear()?;Ok(json!(true))}
        "search_session_content"=>{
            let root=crate::platform::session_cache_directory().ok_or("会话目录尚未授权")?;
            let request=session_manager::search::begin_search(uuid::Uuid::new_v4().to_string());
            let providers=args["providerIds"].as_array().map(|rows|rows.iter().filter_map(Value::as_str).map(String::from).collect());
            let mut result=session_manager::search::search(args["query"].as_str().unwrap_or(""),providers,args["limit"].as_u64().unwrap_or(200)as usize,request)?;
            result.hits.retain_mut(|hit|{
                if hit.provider_id!="codex" {return false;}
                let Ok(relative)=Path::new(&hit.source_path).strip_prefix(&root) else{return false;};
                hit.source_path=relative.to_string_lossy().into_owned();true
            });
            encode(result)
        }
        _=>Err("会话命令无效".into())
    }
}
