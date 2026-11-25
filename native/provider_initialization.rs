//! First SAF connection and the duplicate official row left by older Android builds.
use crate::app_config::AppType;
use crate::database::CODEX_OFFICIAL_PROVIDER_ID;
use crate::error::AppError;
use crate::live::engine::DeviceStore;
use crate::mode::{current, operation, state};
use crate::provider::ProviderMeta;
use crate::services::provider;
use crate::store::AppState;
use serde_json::json;

pub(crate) fn initialize(state: &AppState) -> Result<(), AppError> {
    if state.db.get_setting("android_initial_import_v1")?.is_none() {
        // The manual import predicate intentionally allows official seeds. A
        // startup/connection must use the upstream automatic-import predicate.
        if provider::should_import_default_config_on_startup(state, &AppType::Codex)? {
            provider::import_default_config(state, AppType::Codex)?;
        }
        state.db.ensure_official_seed_by_id(CODEX_OFFICIAL_PROVIDER_ID, AppType::Codex)?;
        state.db.set_setting("android_initial_import_v1", "true")?;
    }
    merge_duplicate_official_default(state)?;
    Ok(())
}

pub(crate) fn merge_duplicate_official_default(state: &AppState) -> Result<bool, AppError> {
    if !crate::platform::documents_bound() || state.db.get_setting("android_initial_import_v1")?.is_none() {
        return Ok(false);
    }
    let rows = state.db.get_all_providers(&AppType::Codex)?;
    let (Some(imported), Some(official)) = (rows.get("default"), rows.get(CODEX_OFFICIAL_PROVIDER_ID)) else {
        return Ok(false);
    };
    // Only the untouched automatically imported official row is a duplicate.
    // A third-party default, a renamed row or a customized card remains intact.
    if imported.name != "default" || !imported.has_official_category() || !official.has_official_category()
        || imported.created_at.is_some() || imported.notes.is_some() || imported.website_url.is_some()
        || imported.icon.is_some() || imported.icon_color.is_some() || imported.in_failover_queue
        || super::api::filter_enabled(&state.db, &imported.id)
        || serde_json::to_value(imported.meta.clone().unwrap_or_default()).map_err(|source| AppError::JsonSerialize { source })?
            != serde_json::to_value(ProviderMeta::default()).map_err(|source| AppError::JsonSerialize { source })?
    {
        return Ok(false);
    }
    let seed_settings = json!({"auth": {}, "config": ""});
    if official.settings_config != seed_settings && official.settings_config != imported.settings_config {
        return Ok(false);
    }
    let store = DeviceStore::for_device();
    let live = state::load(&store)?;
    let entry = live.apps.get("codex");
    // Settle pending operations first. Removing their target row would prevent
    // upstream recovery; initialize/startup retry this migration after settling.
    if entry.is_some_and(|entry| entry.pending.is_some() || entry.stack.is_member("default") || entry.stack.key_of("default").is_some()) {
        return Ok(false);
    }
    let backup = store.file("migrations/duplicate-official-default.json");
    if !backup.exists() {
        crate::config::atomic_write_private(&backup, &serde_json::to_vec_pretty(&json!({
            "default": imported, "official": official,
        })).map_err(|source| AppError::JsonSerialize { source })?)?;
    }
    if official.settings_config != imported.settings_config {
        let mut merged = official.clone();
        merged.settings_config = imported.settings_config.clone();
        state.db.save_provider(&AppType::Codex, &merged)?;
    }
    let mut target = state::PendingTarget::default();
    if current::provider_for(&state.db, &AppType::Codex, current::Purpose::Direct)?.as_deref() == Some("default") {
        target.pointer = Some(CODEX_OFFICIAL_PROVIDER_ID.into());
    }
    if let Some(entry) = entry.filter(|entry| entry.proxy_route.as_deref() == Some("default")) {
        let mut mode = entry.mode_state();
        mode.proxy_route = Some(CODEX_OFFICIAL_PROVIDER_ID.into());
        target.state = Some(mode);
    }
    operation::commit_target(&state.db, &store, "codex", &target)?;
    state.db.delete_provider(&AppType::Codex, "default")?;
    // This migration updates only CC Switch's records. Codex's current TOML,
    // auth.json and local login stash are never rewritten to remove a UI row.
    Ok(true)
}
