//! Android adapters for desktop command dependencies. Guest process launch is
//! unavailable through SAF; native Codex configuration and networking stay in
//! the upstream engine and proxy.
use std::sync::Arc;
use tokio::sync::RwLock;
#[path="vendor/commands/failover.rs"]
pub(crate) mod failover;
#[path="vendor/commands/settings.rs"]
pub(crate) mod settings;
pub struct CodexOAuthState(pub Arc<crate::proxy::providers::codex_oauth_auth::CodexOAuthManager>);
pub struct CopilotAuthState(pub Arc<RwLock<crate::proxy::providers::copilot_auth::CopilotAuthManager>>);
pub struct XaiOAuthState(pub Arc<RwLock<crate::proxy::providers::xai_oauth_auth::XaiOAuthManager>>);
pub fn cached_login_shell_path() -> Option<String> { None }
pub fn merge_path_segments(first: &str, second: &str) -> String { format!("{first}:{second}") }
pub fn local_tool_version(_: &str) -> Option<String> { None }
pub fn decode_command_output(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() }
pub fn tool_runs_in_wsl(_: &str) -> bool { false }
pub fn is_safe_tool_command_arg(value: &str) -> bool { !value.contains('\0') }
fn unavailable() -> String { "SAF 只提供文件访问，CC Switch 无法运行 Codex 私有环境内的进程；请在 Codex 中操作。".into() }
pub fn locate_detected_tool(_: &str, _: std::time::Duration) -> Result<(), String> { Err(unavailable()) }
pub fn detected_tool_command(_: &str, _: &[&str], _: std::time::Duration) -> Result<std::process::Command, String> { Err(unavailable()) }
pub fn run_detected_tool_command_with_timeout(_: &str, _: &[&str], _: Option<std::time::Duration>, _: &[(&str, String)], _: &std::path::Path) -> Result<std::process::Output, String> { Err(unavailable()) }
pub fn terminate_child_tree(child: &mut std::process::Child) { let _ = child.kill(); }
