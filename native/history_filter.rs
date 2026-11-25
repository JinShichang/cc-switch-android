//! Android extension requested by the user, matching agentrouter's two filters.
//! Remove only Responses history reasoning items and top-level item IDs;
//! tool call_id, current request settings, and response IDs stay intact.
use serde_json::Value;
const SETTING: &str = "android_codex_history_filter";

pub(crate) fn migrate(db: &crate::database::Database) -> Result<(), crate::error::AppError> {
    if db.get_setting(SETTING)?.is_none() {
        let mut enabled = false;
        for id in db.get_provider_ids(&crate::app_config::AppType::Codex)? {
            if db.get_setting(&format!("android_history_filter:{id}"))?.as_deref() == Some("true") {
                enabled = true;
                break;
            }
        }
        db.set_setting(SETTING, if enabled { "true" } else { "false" })?;
    }
    Ok(())
}

pub(crate) fn enabled(db: &crate::database::Database) -> Result<bool, crate::error::AppError> {
    Ok(db.get_setting(SETTING)?.as_deref() == Some("true"))
}

pub(crate) fn set_enabled(db: &crate::database::Database, enabled: bool) -> Result<(), crate::error::AppError> {
    db.set_setting(SETTING, if enabled { "true" } else { "false" })
}

pub(crate) fn status(state: &crate::store::AppState) -> Result<Value, String> {
    let mode = crate::mode::controller::app_mode_view(state, &crate::app_config::AppType::Codex)?;
    let enabled = enabled(&state.db).map_err(|error| error.to_string())?;
    let running = crate::platform::async_runtime::block_on(state.proxy_service.is_running());
    Ok(serde_json::json!({"enabled": enabled, "active": enabled && mode.mode != "direct" && mode.attached && running,
        "mode": mode.mode, "attached": mode.attached, "running": running}))
}

pub(crate) fn apply(body: &mut Value) -> Result<(), crate::proxy::ProxyError> {
    use crate::proxy::ProxyError;
    fn truthy(value:Option<&Value>)->bool { match value { None|Some(Value::Null)|Some(Value::Bool(false))=>false,Some(Value::String(s))=>!s.is_empty(),Some(Value::Number(n))=>n.as_f64()!=Some(0.0),_=>true } }
    if !body.is_object(){return Err(ProxyError::InvalidRequest("Responses 请求必须是 JSON 对象".into()));}
    if truthy(body.get("previous_response_id"))||truthy(body.get("conversation")){return Err(ProxyError::InvalidRequest("历史包含跨服务商响应引用，请用文本摘要开启新会话".into()));}
    if body.get("include").is_some_and(|v|!v.is_array()){return Err(ProxyError::InvalidRequest("include 必须是数组".into()));}
    if body.get("input").is_some_and(|v|!v.is_string()&&!v.is_array()){return Err(ProxyError::InvalidRequest("input 必须是字符串或数组".into()));}
    if body.get("context_management").and_then(Value::as_array).is_some_and(|items|items.iter().any(|item|item["type"]=="compaction")){return Err(ProxyError::InvalidRequest("此过滤功能不能复用加密压缩上下文，请用文本摘要开启新会话".into()));}
    body["store"] = Value::Bool(false);
    if let Some(include)=body.get_mut("include").and_then(Value::as_array_mut) {
        include.retain(|value|value.as_str()!=Some("reasoning.encrypted_content"));
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        input.retain(|item|item.get("type").and_then(Value::as_str)!=Some("reasoning"));
        for item in input {
            if matches!(item.get("type").and_then(Value::as_str),Some("compaction"|"item_reference"))||truthy(item.get("encrypted_content")){return Err(ProxyError::InvalidRequest("加密历史不能跨服务商使用，历史没有被静默删除，请用文本摘要开启新会话".into()));}
            let portable=matches!(item.get("type").and_then(Value::as_str),Some("message"|"function_call"|"function_call_output"|"custom_tool_call"|"custom_tool_call_output")) ||
                (item.get("type").is_none()&&item.get("role").is_some_and(Value::is_string)&&item.get("content").is_some());
            if portable { if let Some(object)=item.as_object_mut() { object.remove("id"); } }
        }
    }
    Ok(())
}
