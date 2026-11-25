//! Android-owned runtime, typed application state, and event delivery.
use serde::Serialize;
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

pub trait Documents: Send + Sync {
    fn read(&self, relative: &str) -> std::io::Result<Option<Vec<u8>>>;
    fn write(&self, relative: &str, bytes: &[u8]) -> std::io::Result<()>;
    fn delete(&self, relative: &str) -> std::io::Result<()>;
    fn emit(&self, event: &str, payload: &str);
}
static DOCUMENTS: OnceLock<Arc<dyn Documents>> = OnceLock::new();
static HOME: OnceLock<PathBuf> = OnceLock::new();
static DOCUMENT_SCOPE: RwLock<String> = RwLock::new(String::new());
pub fn install(home: PathBuf, documents: Arc<dyn Documents>) -> Result<(), String> {
    if let Some(existing) = HOME.get() {
        if existing != &home { return Err("CC Switch 的本地数据目录已改变".into()); }
        return Ok(());
    }
    HOME.set(home).map_err(|_| "初始化数据目录失败")?;
    DOCUMENTS.set(documents).map_err(|_| "初始化 SAF 访问失败")?;
    Ok(())
}
pub fn home() -> Option<PathBuf> { HOME.get().cloned() }
/// Provider-independent document identity. Pending intents and login stashes
/// belong to the selected tree, even when its permission is later revoked.
pub fn set_document_scope(identity: &str) {
    use sha2::{Digest, Sha256};
    let key = if identity.is_empty() { "unbound".into() } else {
        format!("{:x}", Sha256::digest(identity.as_bytes()))
    };
    *DOCUMENT_SCOPE.write().expect("document scope") = key;
}
pub fn document_scope() -> String { DOCUMENT_SCOPE.read().expect("document scope").clone() }
pub fn documents_bound() -> bool { document_scope() != "unbound" }
pub fn document_state_for(identity: &str) -> Option<PathBuf> {
    use sha2::{Digest,Sha256};
    Some(HOME.get()?.join(".cc-switch").join("documents").join(format!("{:x}",Sha256::digest(identity.as_bytes()))))
}
pub fn document_state_directory() -> Option<PathBuf> {
    Some(HOME.get()?.join(".cc-switch").join("documents").join(document_scope()))
}
pub fn session_cache_directory() -> Option<PathBuf> {
    Some(HOME.get()?.join("session-cache").join(document_scope()))
}
pub fn staging_directory() -> Option<PathBuf> { Some(document_state_directory()?.join("saf-staging")) }
pub fn relative(path: &Path) -> Option<String> {
    let base = HOME.get()?.join(".codex");
    let name = path.strip_prefix(base).ok()?.to_str()?;
    if !name.is_empty() && !name.starts_with('/') && !name.contains('\\') &&
        name.split('/').all(|part| !matches!(part,""|"."|"..") && !part.contains('\0')) {
        Some(name.to_string())
    } else { None }
}
pub fn exists(path: &Path) -> bool {
    read_document(path).map(|result| result.ok().flatten().is_some()).unwrap_or_else(|| path.exists())
}
pub fn read(path: impl AsRef<Path>) -> std::io::Result<Vec<u8>> {
    let path=path.as_ref();
    if let Some(result) = read_document(path) { return result?.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound)); }
    std::fs::read(path)
}
pub fn read_to_string(path: impl AsRef<Path>) -> std::io::Result<String> {
    String::from_utf8(read(path)?).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData,e))
}
pub fn is_file(path:&Path) -> bool {
    if relative(path).is_some() { exists(path) } else { path.is_file() }
}
pub fn has_documents() -> bool { DOCUMENTS.get().is_some() }
pub fn read_document(path: &Path) -> Option<std::io::Result<Option<Vec<u8>>>> {
    Some(DOCUMENTS.get()?.read(&relative(path)?))
}
pub fn write_document(path: &Path, bytes: &[u8]) -> Option<std::io::Result<()>> {
    Some(DOCUMENTS.get()?.write(&relative(path)?, bytes))
}
pub fn delete_document(path: &Path) -> Option<std::io::Result<()>> {
    Some(DOCUMENTS.get()?.delete(&relative(path)?))
}
pub fn emit_event<T: Serialize>(event: &str, payload: &T) {
    if let (Some(documents), Ok(json)) = (DOCUMENTS.get(), serde_json::to_string(payload)) {
        documents.emit(event, &json);
    }
}
pub fn notify_db_changed(table: &str) { emit_event("database-changed", &table); }

#[derive(Clone, Default)]
pub struct AppHandle {
    state: Arc<RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>>,
}
pub struct State<T: Send + Sync + 'static>(Arc<T>);
impl<T: Send + Sync + 'static> State<T> { pub fn inner(&self) -> &T { &self.0 } }
impl<T: Send + Sync + 'static> Deref for State<T> { type Target = T; fn deref(&self) -> &T { &self.0 } }
pub trait Manager {
    fn manage<T: Send + Sync + 'static>(&self, value: T);
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<T>>;
    fn state<T: Send + Sync + 'static>(&self) -> State<T>;
}
impl Manager for AppHandle {
    fn manage<T: Send + Sync + 'static>(&self, value: T) {
        self.state.write().unwrap().insert(TypeId::of::<T>(), Arc::new(value));
    }
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        let value = self.state.read().ok()?.get(&TypeId::of::<T>())?.clone();
        Some(State(value.downcast().ok()?))
    }
    fn state<T: Send + Sync + 'static>(&self) -> State<T> {
        self.try_state().expect("Android native state must be installed at startup")
    }
}
pub trait Emitter {
    fn emit<T: Serialize + Clone>(&self, event: &str, payload: T) -> Result<(), String>;
}
impl Emitter for AppHandle {
    fn emit<T: Serialize + Clone>(&self, event: &str, payload: T) -> Result<(), String> {
        emit_event(event, &payload); Ok(())
    }
}
pub mod async_runtime {
    use super::*;
    pub fn runtime() -> &'static tokio::runtime::Runtime {
        static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4).enable_all().build().expect("Tokio runtime"))
    }
    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where F: std::future::Future + Send + 'static, F::Output: Send + 'static {
        runtime().spawn(future)
    }
    pub fn spawn_blocking<F, T>(work: F) -> tokio::task::JoinHandle<T>
    where F: FnOnce() -> T + Send + 'static, T: Send + 'static {
        runtime().spawn_blocking(work)
    }
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output { runtime().block_on(future) }
    pub fn handle() -> tokio::runtime::Handle { runtime().handle().clone() }
}
pub mod ipc {
    #[derive(Debug)]
    pub struct InvokeError(pub serde_json::Value);
    impl<T: serde::Serialize> From<T> for InvokeError {
        fn from(value: T) -> Self { Self(serde_json::to_value(value).unwrap_or_default()) }
    }
}
