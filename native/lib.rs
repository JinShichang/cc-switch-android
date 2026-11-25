//! CC Switch's real Codex backend, hosted by a standalone Android app.
//! Upstream logic is vendored under MIT; platform bindings use SAF and Tokio.
#![allow(dead_code)]
include!("modules.rs");
pub mod api;
pub mod platform;
mod app_store;
mod commands;
mod tray;
mod history_filter;
mod session_api;
pub use app_config::AppType;
use std::fmt;
include!("log_redaction.rs");

#[cfg(target_os = "android")]
mod jni_bridge;
