//! The Android app's private data directory is selected by Context, not a
//! desktop plugin or an external .codex content URI.
pub fn get_app_config_dir_override() -> Option<std::path::PathBuf> { None }
