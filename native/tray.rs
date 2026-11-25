//! Desktop tray mutations become Android UI invalidation events.
use crate::platform::AppHandle;
pub fn tray_language() -> String { "zh".into() }
pub fn refresh_tray_menu(_: &AppHandle) { crate::platform::emit_event("provider-data-changed", &()); }
pub fn schedule_tray_status_check(handle: &AppHandle) { refresh_tray_menu(handle); }
pub fn schedule_tray_refresh(handle: &AppHandle) { refresh_tray_menu(handle); }
pub fn provider_needs_routing(_: &crate::app_config::AppType, provider: &crate::provider::Provider) -> bool {
    !crate::proxy::providers::is_codex_official_provider(provider) &&
        (crate::proxy::providers::should_convert_codex_responses_to_chat(provider, "/v1/responses") ||
         crate::proxy::providers::should_convert_codex_responses_to_anthropic(provider, "/v1/responses"))
}
