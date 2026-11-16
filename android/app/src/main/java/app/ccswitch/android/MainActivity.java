package app.ccswitch.android;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/web/index.html";
    private static final int TREE_PICKER = 41, IMPORT_PICKER = 42, EXPORT_PICKER = 43;
    private static final int GRANTS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView web;
    private FrameLayout root;
    private SharedPreferences preferences;
    private EncryptedRepository repository;
    private Call pickerCall;
    private String exportText;
    private String exportName = "cc-switch-codex.json", exportMime = "application/json";
    private boolean destroyed;

    private static final class Call {
        final String id;
        final JavaScriptReplyProxy reply;
        Call(String id, JavaScriptReplyProxy reply) { this.id = id; this.reply = reply; }
    }

    // The React UI is bundled in the APK, remote loads are blocked, and only
    // this HTTPS origin's main frame can use the source-restricted bridge.
    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        preferences = getSharedPreferences("directory", MODE_PRIVATE);
        getWindow().setDecorFitsSystemWindows(false);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        web.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return insets;
        });
        setContentView(root);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setSaveFormData(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
        });
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Only this packaged page can own the privileged bridge.
                return !request.getUrl().toString().equals(START);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                return response != null ? response : new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Map.of(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                root.removeView(view);
                view.destroy();
                web = null;
                TextView message = new TextView(MainActivity.this);
                message.setText(R.string.renderer_recovery);
                message.setPadding(32, 64, 32, 32);
                message.setOnClickListener(v -> recreate());
                root.addView(message, new FrameLayout.LayoutParams(-1, -1));
                return true;
            }
        });
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView error = new TextView(this);
            error.setText(R.string.webview_required);
            error.setPadding(32, 64, 32, 32);
            setContentView(error);
            return;
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.addWebMessageListener(web, "CCSwitch", Set.of(ORIGIN), (view, message, sourceOrigin, mainFrame, reply) -> {
            if (!mainFrame || !"https".equals(sourceOrigin.getScheme())
                    || !"appassets.androidplatform.net".equals(sourceOrigin.getHost())
                    || (sourceOrigin.getPort() != -1 && sourceOrigin.getPort() != 443)) return;
            String raw = message.getData();
            if (raw == null || raw.length() > 16 * 1024 * 1024) return;
            try {
                JSONObject request = new JSONObject(raw);
                Call call = new Call(request.getString("id"), reply);
                String method = request.getString("method");
                JSONObject args = request.optJSONObject("args");
                io.execute(() -> handle(call, method, args == null ? new JSONObject() : args));
            } catch (Exception ignored) { /* Unstructured requests cannot invoke a method. */ }
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::handleBack);
        web.loadUrl(START);
    }

    private void handle(Call call, String method, JSONObject args) {
        try {
            if (repository == null) { EncryptedRepository candidate = new EncryptedRepository(this); candidate.migrate(); repository = candidate; }
            Object result;
            switch (method) {
                case "bootstrap": result = state(); break;
                case "readCurrent": result = snapshot(tree()); break;
                case "providerStatus": result = DocumentPicker.status(this); break;
                case "openCodex":
                    Intent codex = getPackageManager().getLaunchIntentForPackage("com.ai.codex");
                    if (codex == null) throw new AppFailure("codex_missing", "未安装可打开的 Codex 应用。");
                    runOnUiThread(() -> startActivity(codex));
                    result = new JSONObject().put("opened", true); break;
                case "readRevision":
                    TreeAccess revisionAccess = tree();
                    result = new JSONObject().put("revision", TransactionEngine.revision(revisionAccess.read(), revisionAccess.auth()));
                    break;
                case "chooseDirectory": launchPicker(call, TREE_PICKER, null); return;
                case "importFile": launchPicker(call, IMPORT_PICKER, null); return;
                case "exportFile":
                    String text = args.getString("text");
                    if (text.getBytes(StandardCharsets.UTF_8).length > 16 * 1024 * 1024) throw new AppFailure("too_large", "导出文件超过 16 MB 限制。");
                    exportName = args.optString("name", "cc-switch-codex.json");
                    if (!exportName.matches("[A-Za-z0-9._-]{1,100}")) throw new AppFailure("invalid_export_name", "导出文件名无效。");
                    exportMime = exportName.endsWith(".md") ? "text/markdown" : "application/json";
                    launchPicker(call, EXPORT_PICKER, text); return;
                case "releaseDirectory":
                    String saved = preferences.getString("uri", "");
                    if (!saved.isEmpty()) {
                        try { getContentResolver().releasePersistableUriPermission(Uri.parse(saved), GRANTS); } catch (SecurityException ignored) { }
                    }
                    if (!preferences.edit().clear().commit()) throw new AppFailure("preferences_write", "无法保存目录授权设置。");
                    result = state(); break;
                case "saveProviders":
                    JSONArray providers = args.getJSONArray("providers");
                    if (providers.length() > 200) throw new AppFailure("profile_limit", "最多保留 200 个服务商方案。");
                    Set<String> ids = new HashSet<>();
                    for (int i = 0; i < providers.length(); i++) {
                        JSONObject item = providers.getJSONObject(i);
                        if (!ids.add(item.getString("id")) || item.getString("name").trim().isEmpty() || item.getJSONObject("settingsConfig").getString("config").length() > TreeAccess.MAX_CONFIG) {
                            throw new AppFailure("invalid_profile", "方案结构、大小或标识不正确，没有保存。");
                        }
                    }
                    JSONObject next = repository.copy();
                    next.put("providers", providers);
                    repository.replace(next);
                    result = state(); break;
                case "settings":
                    int zoom = args.getInt("zoom");
                    String theme = args.getString("theme");
                    if (zoom < 50 || zoom > 400 || !Set.of("light", "dark", "system").contains(theme)) throw new AppFailure("invalid_settings", "缩放范围为 50–400%。");
                    JSONObject updated = repository.copy();
                    updated.put("settings", new JSONObject().put("zoom", zoom).put("theme", theme));
                    repository.replace(updated);
                    updateBars(theme);
                    result = state(); break;
                case "savePrompts":
                    JSONArray prompts = args.getJSONArray("prompts");
                    if (prompts.length() > 100) throw new AppFailure("prompt_limit", "最多保存 100 套提示词。");
                    Set<String> promptIds = new HashSet<>();
                    for (int i = 0; i < prompts.length(); i++) {
                        JSONObject prompt = prompts.getJSONObject(i);
                        if (!promptIds.add(prompt.getString("id")) || prompt.getString("name").trim().isEmpty() || prompt.getString("content").getBytes(StandardCharsets.UTF_8).length > TreeAccess.MAX_CONFIG) throw new AppFailure("invalid_prompt", "提示词结构或大小无效。");
                    }
                    JSONObject promptData = repository.copy(); promptData.put("prompts", prompts); repository.replace(promptData);
                    result = state(); break;
                case "catalog": result = new DocumentCatalog(tree()).catalog(args.getString("kind")); break;
                case "readDocument": result = new DocumentCatalog(tree()).document(args.getString("path")); break;
                case "readDocumentRevision": result = new JSONObject().put("hash", TransactionEngine.hash(tree().port(args.getString("path")).read())); break;
                case "readSession": result = new DocumentCatalog(tree()).session(args.getString("path"), args.optBoolean("usageOnly")); break;
                case "saveDocument": result = new DocumentStore(tree(), repository).save(args); break;
                case "restoreDocument": result = new DocumentStore(tree(), repository).restore(args); break;
                case "editMcp":
                    TreeAccess mcpAccess = tree();
                    JSONObject mcpData = repository.copy();
                    if (mcpData.getJSONObject("journals").has(mcpAccess.tree.toString())) throw new AppFailure("pending_recovery", "请先恢复未确认的配置写入。");
                    JSONObject mcpOwnership = mcpData.getJSONObject("ownership").optJSONObject(mcpAccess.tree.toString());
                    byte[] mcpConfig = args.getString("config").getBytes(StandardCharsets.UTF_8);
                    if (mcpConfig.length > TreeAccess.MAX_CONFIG) throw new AppFailure("too_large", "配置超过 2 MB 限制。");
                    writeConfig(mcpAccess, mcpConfig, args.getString("expectedRevision"), mcpOwnership == null ? new JSONObject() : mcpOwnership, "mcp", "修改 MCP 配置");
                    result = new JSONObject().put("state", state()).put("snapshot", snapshot(mcpAccess)); break;
                case "apply": result = apply(args); break;
                case "restore": result = restore(args, false); break;
                case "recover": result = restore(args, true); break;
                default: throw new AppFailure("unknown_method", "不支持此操作。");
            }
            success(call, result);
        } catch (Exception error) { failure(call, error); }
    }

    private TreeAccess tree() throws Exception {
        String uri = preferences.getString("uri", "");
        return new TreeAccess(this, uri.isEmpty() ? null : Uri.parse(uri));
    }
    private JSONObject snapshot(TreeAccess access) throws Exception {
        byte[] config = access.read();
        byte[] auth = access.auth();
        JSONObject data = repository.copy();
        JSONObject ownership = data.optJSONObject("ownership");
        return new JSONObject().put("config", config == null ? JSONObject.NULL : TreeAccess.utf8(config))
            .put("auth", auth == null ? JSONObject.NULL : TreeAccess.utf8(auth))
            .put("revision", TransactionEngine.revision(config, auth)).put("directory", access.info())
            .put("ownership", ownership == null ? JSONObject.NULL : ownership.opt(access.tree.toString()));
    }
    private JSONObject state() throws Exception {
        JSONObject data = repository.copy();
        JSONObject directory = null;
        String uri = preferences.getString("uri", "");
        if (!uri.isEmpty()) {
            try { directory = tree().info(); }
            catch (Exception unavailable) {
                directory = new JSONObject().put("uri", uri).put("name", preferences.getString("name", "已授权目录"))
                    .put("authority", Uri.parse(uri).getAuthority()).put("providerPackage", "")
                    .put("isCodexProvider", false).put("canWrite", false);
            }
        }
        JSONArray backups = new JSONArray();
        JSONArray all = data.getJSONArray("backups");
        for (int i = all.length() - 1; i >= 0; i--) {
            JSONObject item = new JSONObject(all.getJSONObject(i).toString());
            item.remove("config");
            item.remove("configBase64");
            item.remove("ownership");
            backups.put(item);
        }
        JSONArray documentBackups = new JSONArray();
        JSONArray storedDocs = data.getJSONArray("documentBackups");
        for (int i = storedDocs.length() - 1; i >= 0; i--) {
            JSONObject item = new JSONObject(storedDocs.getJSONObject(i).toString()); item.remove("content"); documentBackups.put(item);
        }
        JSONArray pendingDocuments = new JSONArray();
        java.util.Iterator<String> pendingKeys = data.getJSONObject("documentJournals").keys();
        while (pendingKeys.hasNext()) {
            JSONObject item = data.getJSONObject("documentJournals").getJSONObject(pendingKeys.next());
            if (item.getString("treeUri").equals(uri)) pendingDocuments.put(item.getString("path"));
        }
        JSONObject settings = data.getJSONObject("settings");
        updateBars(settings.optString("theme", "system"));
        return new JSONObject().put("providers", data.getJSONArray("providers")).put("backups", backups)
            .put("directory", directory == null ? JSONObject.NULL : directory).put("settings", settings).put("native", true)
            .put("pendingRecovery", data.getJSONObject("journals").has(uri))
            .put("lastApplied", data.opt("lastApplied")).put("prompts", data.getJSONArray("prompts"))
            .put("documentBackups", documentBackups).put("pendingDocuments", pendingDocuments);
    }

    private Object apply(JSONObject args) throws Exception {
        TreeAccess access = tree();
        if (repository.copy().getJSONObject("journals").has(access.tree.toString())) throw new AppFailure("pending_recovery", "此目录有未确认的写入，请先在“备份”中恢复写入前的配置。");
        String config = args.getString("config");
        if (config.getBytes(StandardCharsets.UTF_8).length > TreeAccess.MAX_CONFIG) throw new AppFailure("too_large", "配置超过 2 MB 限制。");
        String providerId = args.getString("providerId");
        JSONArray providers = repository.copy().getJSONArray("providers");
        JSONObject selected = null;
        for (int i = 0; i < providers.length(); i++) if (providers.getJSONObject(i).getString("id").equals(providerId)) selected = providers.getJSONObject(i);
        if (selected == null) throw new AppFailure("missing_profile", "方案已被删除，请刷新后重试。");
        writeConfig(access, config.getBytes(StandardCharsets.UTF_8), args.getString("expectedRevision"),
            args.getJSONObject("ownership"), providerId, "应用 · " + selected.getString("name"));
        return new JSONObject().put("state", state()).put("snapshot", snapshot(access)).put("fileVerified", true).put("runtimeConfirmed", false);
    }

    private Object restore(JSONObject args, boolean recover) throws Exception {
        TreeAccess access = tree();
        JSONObject data = repository.copy();
        JSONObject backup = null;
        if (recover) {
            JSONObject journal = data.getJSONObject("journals").optJSONObject(access.tree.toString());
            if (journal != null) backup = journal.getJSONObject("before");
        } else {
            JSONArray backups = data.getJSONArray("backups");
            for (int i = 0; i < backups.length(); i++) if (backups.getJSONObject(i).getString("id").equals(args.getString("id"))) backup = backups.getJSONObject(i);
        }
        if (backup == null) throw new AppFailure("missing_backup", "备份已不存在或已被轮换删除。");
        if (!access.tree.toString().equals(backup.getString("treeUri"))) throw new AppFailure("wrong_directory", "该备份属于另一个目录。请先重新授权备份对应的目录，避免覆盖当前目录。");
        byte[] target = backup.has("configBase64")
            ? (backup.isNull("configBase64") ? null : Base64.getDecoder().decode(backup.getString("configBase64")))
            : (backup.isNull("config") ? null : backup.getString("config").getBytes(StandardCharsets.UTF_8));
        JSONObject ownership = backup.optJSONObject("ownership");
        writeConfig(access, target, args.getString("expectedRevision"), ownership == null ? new JSONObject() : ownership, "restored", "恢复 · 写入前配置");
        return new JSONObject().put("state", state()).put("snapshot", snapshot(access)).put("fileVerified", true).put("runtimeConfirmed", false);
    }

    private void writeConfig(TreeAccess access, byte[] target, String expectedRevision, JSONObject ownership, String providerId, String reason) throws Exception {
        byte[] before = access.read();
        byte[] auth = access.auth();
        if (!TransactionEngine.revision(before, auth).equals(expectedRevision)) throw new AppFailure("conflict", "配置或认证文件已在外部改变。请刷新后重试；没有覆盖外部修改。");
        String uri = access.tree.toString();
        String name = access.info().getString("name");
        JSONObject pending = repository.copy().getJSONObject("journals").optJSONObject(uri);
        boolean[] committed = { false };
        TransactionEngine.Port guarded = new TransactionEngine.Port() {
            private void checkAuth() throws Exception {
                if (!Arrays.equals(auth, access.auth())) throw new AppFailure("auth_conflict", "认证文件在写入前发生变化，请刷新后重试。没有覆盖认证文件。");
            }
            @Override public byte[] read() throws Exception { return access.read(); }
            @Override public void write(byte[] bytes) throws Exception { checkAuth(); access.write(bytes); }
            @Override public void delete() throws Exception { checkAuth(); access.delete(); }
        };
        TransactionEngine.apply(guarded, TransactionEngine.hash(before), target, new TransactionEngine.Journal() {
            @Override public void prepare(byte[] original, byte[] after) throws Exception {
                JSONObject data = repository.copy();
                JSONObject backup = new JSONObject().put("id", UUID.randomUUID().toString()).put("createdAt", System.currentTimeMillis())
                    .put("reason", reason).put("directoryName", name).put("treeUri", uri).put("existed", original != null)
                    .put("configBase64", original == null ? JSONObject.NULL : Base64.getEncoder().encodeToString(original))
                    .put("ownership", data.getJSONObject("ownership").opt(uri));
                JSONArray old = data.getJSONArray("backups");
                JSONArray retained = new JSONArray();
                for (int i = Math.max(0, old.length() - 9); i < old.length(); i++) retained.put(old.get(i));
                retained.put(backup);
                data.put("backups", retained);
                // Keep the original recovery point if recovery itself fails.
                if (pending == null) data.getJSONObject("journals").put(uri, new JSONObject().put("before", backup).put("targetHash", TransactionEngine.hash(after)));
                repository.replace(data);
            }
            @Override public void finish(boolean saved) throws Exception {
                JSONObject data = repository.copy();
                if (saved) {
                    if (!Arrays.equals(target, access.read())) throw new AppFailure("conflict", "文件在核验后发生改变。已保留恢复备份，请刷新后检查。");
                    data.getJSONObject("journals").remove(uri);
                    recordApplied(data, uri, ownership, providerId, access);
                    committed[0] = true;
                } else if (pending == null) {
                    data.getJSONObject("journals").remove(uri);
                }
                repository.replace(data);
            }
        });
        if (!committed[0]) {
            JSONObject data = repository.copy();
            // An explicit recovery may target bytes already present. Resolve its
            // pending journal only after verifying the no-op result as well.
            if (!Arrays.equals(target, access.read())) throw new AppFailure("conflict", "文件在核验后发生改变，请刷新后检查。");
            data.getJSONObject("journals").remove(uri);
            recordApplied(data, uri, ownership, providerId, access);
            repository.replace(data);
        }
    }
    private void recordApplied(JSONObject data, String uri, JSONObject ownership, String providerId, TreeAccess access) throws Exception {
        data.getJSONObject("ownership").put(uri, ownership);
        data.put("lastApplied", new JSONObject().put("id", providerId).put("time", System.currentTimeMillis())
            .put("treeUri", uri).put("revision", TransactionEngine.revision(access.read(), access.auth())));
    }

    private void launchPicker(Call call, int type, String payload) {
        runOnUiThread(() -> {
            if (pickerCall != null) { failure(call, new AppFailure("picker_busy", "系统文件选择器已经打开，请先完成当前选择。")); return; }
            pickerCall = call;
            exportText = payload;
            try {
                Intent intent;
                if (type == TREE_PICKER) {
                    intent = DocumentPicker.intent(this, Intent.ACTION_OPEN_DOCUMENT_TREE, preferences.getString("uri", ""));
                } else if (type == IMPORT_PICKER) {
                    intent = DocumentPicker.intent(this, Intent.ACTION_OPEN_DOCUMENT, "");
                } else {
                    intent = DocumentPicker.intent(this, Intent.ACTION_CREATE_DOCUMENT, "").setType(exportMime)
                        .putExtra(Intent.EXTRA_TITLE, exportName).addFlags(GRANTS);
                }
                startActivityForResult(intent, type);
            } catch (Exception error) {
                pickerCall = null; exportText = null;
                failure(call, error instanceof AppFailure ? error : new AppFailure("picker_unavailable", "无法打开系统 DocumentsUI，请检查系统“文件”组件是否已启用。"));
            }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent intent) {
        super.onActivityResult(request, result, intent);
        if (request != TREE_PICKER && request != IMPORT_PICKER && request != EXPORT_PICKER) return;
        Call call = pickerCall;
        String exportPayload = exportText;
        pickerCall = null; exportText = null;
        if (call == null) return;
        if (result != RESULT_OK || intent == null || intent.getData() == null) { failure(call, new AppFailure("cancelled", "已取消文件选择。")); return; }
        Uri uri = intent.getData();
        int flags = intent.getFlags() & GRANTS;
        io.execute(() -> {
            try {
                Object output;
                if (request == TREE_PICKER) {
                    if (flags != GRANTS) throw new AppFailure("insufficient_grant", "所选目录没有同时授予读写权限，请重新授权。");
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    TreeAccess access = new TreeAccess(this, uri);
                    JSONObject info = access.info();
                    if (info.optBoolean("isCodexProvider") && !info.optString("name").equals(".codex")) {
                        if (!uri.toString().equals(preferences.getString("uri", ""))) getContentResolver().releasePersistableUriPermission(uri, GRANTS);
                        throw new AppFailure("wrong_codex_root", "请选择 Codex 提供的整个 .codex 目录，不能选择它下面的子目录。");
                    }
                    String previousUri = preferences.getString("uri", "");
                    if (!preferences.edit().putString("uri", uri.toString()).putString("name", info.getString("name")).commit()) throw new AppFailure("preferences_write", "无法保存持久目录授权。");
                    if (!previousUri.isEmpty() && !previousUri.equals(uri.toString())) {
                        try { getContentResolver().releasePersistableUriPermission(Uri.parse(previousUri), GRANTS); } catch (SecurityException ignored) { }
                    }
                    output = state();
                } else if (request == IMPORT_PICKER) {
                    output = new JSONObject().put("text", TreeAccess.utf8(TreeAccess.readUri(getContentResolver(), uri, 16 * 1024 * 1024)));
                } else {
                    if (exportPayload == null) throw new AppFailure("export_lost", "导出内容已失效，请重试。");
                    byte[] bytes = exportPayload.getBytes(StandardCharsets.UTF_8);
                    TreeAccess.writeUri(getContentResolver(), uri, bytes);
                    if (!Arrays.equals(bytes, TreeAccess.readUri(getContentResolver(), uri, 16 * 1024 * 1024))) throw new AppFailure("export_unconfirmed", "导出文件读回不一致，未确认导出成功。");
                    output = new JSONObject().put("verified", true);
                }
                success(call, output);
            } catch (Exception error) { failure(call, error); }
        });
    }

    private void success(Call call, Object value) {
        try { respond(call, new JSONObject().put("id", call.id).put("ok", true).put("result", value)); } catch (Exception ignored) { }
    }
    private void failure(Call call, Exception error) {
        String code = "storage_error";
        String message = "操作未完成。请检查目录授权、文件提供方和剩余空间后重试。没有确认保存成功。";
        if (error instanceof AppFailure known) { code = known.code; message = known.getMessage(); }
        else if (error instanceof TransactionEngine.Failure known) { code = known.code; message = known.getMessage(); }
        else if (error instanceof SecurityException) { code = "permission_revoked"; message = "目录读写权限已失效，请重新通过系统文件选择器授权。"; }
        try { respond(call, new JSONObject().put("id", call.id).put("ok", false).put("error", new JSONObject().put("code", code).put("message", message))); } catch (Exception ignored) { }
    }
    private void respond(Call call, JSONObject response) {
        runOnUiThread(() -> {
            if (!destroyed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                try { call.reply.postMessage(response.toString()); } catch (Exception ignored) { }
            }
        });
    }
    private void updateBars(String choice) {
        runOnUiThread(() -> {
            boolean system = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            boolean dark = choice.equals("dark") || (choice.equals("system") && system);
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (getWindow().getInsetsController() != null) getWindow().getInsetsController().setSystemBarsAppearance(dark ? 0 : flags, flags);
            int background = Color.parseColor(dark ? "#1c1c1e" : "#ffffff");
            root.setBackgroundColor(background);
            if (web != null) web.setBackgroundColor(background);
        });
    }
    private void handleBack() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("window.__ccswitchBack ? window.__ccswitchBack() : false", result -> { if (!"true".equals(result)) finish(); });
    }
    // API 33+ is registered with the platform OnBackInvokedDispatcher above.
    // Keep this override solely for API 30–32 compatibility.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { handleBack(); }
    @Override protected void onDestroy() {
        destroyed = true;
        io.shutdown();
        if (web != null) { root.removeView(web); web.destroy(); }
        super.onDestroy();
    }
}
