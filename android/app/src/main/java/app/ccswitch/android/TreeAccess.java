package app.ccswitch.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.UriPermission;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** The external directory is always a document tree. There is no filesystem
 * fallback, guest UUID discovery, root command, ADB call, or storage permission.
 */
final class TreeAccess implements TransactionEngine.Port {
    static final int MAX_CONFIG = 2 * 1024 * 1024;
    final Uri tree;
    private final Context context;
    private final ContentResolver resolver;
    private final String rootId;

    TreeAccess(Context context, Uri tree) throws Exception {
        if (tree == null || !"content".equals(tree.getScheme()) || !DocumentsContract.isTreeUri(tree)) {
            throw new AppFailure("no_directory", "请先通过系统文件选择器授权 Codex 的 .codex 目录或专用 SAF 测试目录。");
        }
        this.context = context;
        this.resolver = context.getContentResolver();
        this.tree = tree;
        rootId = DocumentsContract.getTreeDocumentId(tree);
        boolean granted = false;
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (tree.equals(permission.getUri()) && permission.isReadPermission() && permission.isWritePermission()) granted = true;
        }
        if (!granted) throw new AppFailure("permission_revoked", "目录授权已失效或没有持久读写权限，请重新授权目录。");
    }
    JSONObject info() throws Exception {
        Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
        String name;
        int flags;
        try (Cursor cursor = resolver.query(root, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS }, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new AppFailure("directory_unavailable", "授权目录暂时不可用，请启动提供该目录的应用后重试。");
            if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1))) throw new AppFailure("not_directory", "所选文档不是目录，请重新选择 .codex 目录。");
            name = cursor.getString(0);
            flags = cursor.getInt(2);
        }
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(tree.getAuthority(), 0);
        String packageName = provider == null ? "" : provider.packageName;
        return new JSONObject().put("uri", tree.toString()).put("name", name == null ? "已授权目录" : name)
            .put("authority", tree.getAuthority()).put("providerPackage", packageName)
            .put("isCodexProvider", "com.ai.codex".equals(packageName))
            .put("canWrite", (flags & DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) != 0);
    }
    static void validPath(String relative) throws AppFailure {
        if (relative == null || relative.isEmpty() || relative.length() > 1024 || relative.startsWith("/") || relative.contains("\\")) throw new AppFailure("invalid_path", "文档路径无效。");
        for (String part : relative.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..") || part.indexOf('\0') >= 0) throw new AppFailure("invalid_path", "文档路径必须位于已授权目录内。");
    }
    private Uri root() { return DocumentsContract.buildDocumentUriUsingTree(tree, rootId); }
    private Uri findChild(Uri parent, String name, boolean directory, boolean writable) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent));
        Uri found = null;
        try (Cursor cursor = resolver.query(children, new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS }, null, null, null)) {
            if (cursor == null) throw new AppFailure("directory_unavailable", "无法列出授权目录，请检查文档提供方和权限。");
            while (cursor.moveToNext()) {
                if (!name.equals(cursor.getString(1))) continue;
                if (found != null) throw new AppFailure("ambiguous_file", "目录内有重名文档，无法确定操作对象。");
                if (directory != DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) throw new AppFailure("wrong_file_type", "文档的文件 / 目录类型不符合预期。");
                if (writable && (cursor.getInt(3) & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) == 0) throw new AppFailure("read_only", "目标文档只读，请检查提供方写入权限。");
                found = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
            }
        }
        return found;
    }
    private Uri locate(String relative, boolean directory, boolean createParents) throws Exception {
        validPath(relative);
        String[] parts = relative.split("/");
        Uri current = root();
        for (int i = 0; i < parts.length; i++) {
            boolean isDirectory = i < parts.length - 1 || directory;
            Uri found = findChild(current, parts[i], isDirectory, false);
            if (found == null && createParents && isDirectory) {
                found = DocumentsContract.createDocument(resolver, current, DocumentsContract.Document.MIME_TYPE_DIR, parts[i]);
                Uri checked = findChild(current, parts[i], true, false);
                if (found == null || checked == null || !DocumentsContract.getDocumentId(found).equals(DocumentsContract.getDocumentId(checked))) throw new AppFailure("create_failed", "未能按预期名称创建子目录。");
            }
            if (found == null) return null;
            current = found;
        }
        return current;
    }
    org.json.JSONArray list(String relative, int limit) throws Exception {
        Uri directory = relative.isEmpty() ? root() : locate(relative, true, false);
        org.json.JSONArray entries = new org.json.JSONArray();
        if (directory == null) return entries;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(directory));
        try (Cursor cursor = resolver.query(children, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
            if (cursor == null) throw new AppFailure("directory_unavailable", "无法列出文档目录。");
            while (cursor.moveToNext()) {
                String name = cursor.getString(0);
                if (name == null || name.contains("/") || name.contains("\\") || name.equals(".") || name.equals("..")) continue;
                if (entries.length() >= limit) throw new AppFailure("scan_limit", "目录项过多，已停止扫描。请按日期整理会话目录后重试。");
                entries.put(new JSONObject().put("name", name).put("path", relative.isEmpty() ? name : relative + "/" + name)
                    .put("directory", DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1)))
                    .put("size", cursor.isNull(2) ? -1 : cursor.getLong(2)).put("modified", cursor.isNull(3) ? 0 : cursor.getLong(3)));
            }
        }
        return entries;
    }
    byte[] readFile(String relative) throws Exception {
        Uri uri = locate(relative, false, false);
        return uri == null ? null : readUri(resolver, uri, MAX_CONFIG);
    }
    InputStream openFile(String relative) throws Exception {
        Uri uri = locate(relative, false, false);
        if (uri == null) throw new AppFailure("file_missing", "文档已不存在，请刷新列表。");
        InputStream stream = resolver.openInputStream(uri);
        if (stream == null) throw new AppFailure("read_failed", "无法打开文档读取流。");
        return stream;
    }
    private void writeFile(String relative, byte[] bytes) throws Exception {
        validPath(relative);
        if (bytes.length > MAX_CONFIG) throw new AppFailure("too_large", "文档超过 2 MB 限制。");
        int slash = relative.lastIndexOf('/');
        Uri parent = slash < 0 ? root() : locate(relative.substring(0, slash), true, true);
        if (parent == null) throw new AppFailure("directory_unavailable", "目标父目录不存在。");
        String name = relative.substring(slash + 1);
        Uri target = findChild(parent, name, false, true);
        if (target == null) {
            target = DocumentsContract.createDocument(resolver, parent, relative.endsWith(".toml") ? "application/toml" : "text/plain", name);
            Uri checked = findChild(parent, name, false, true);
            if (target == null || checked == null || !DocumentsContract.getDocumentId(target).equals(DocumentsContract.getDocumentId(checked))) throw new AppFailure("create_renamed", "文档提供方改变了文件名称，未确认写入成功。");
        }
        writeUri(resolver, target, bytes);
    }
    private void deleteFile(String relative) throws Exception {
        Uri target = locate(relative, false, false);
        if (target != null && !DocumentsContract.deleteDocument(resolver, target)) throw new AppFailure("delete_failed", "提供方未允许删除文档。");
    }
    TransactionEngine.Port port(String relative) throws Exception {
        validPath(relative);
        if (!relative.matches("cc-switch-model-catalog-[a-f0-9]{1,16}\\.json") && !relative.equals("AGENTS.md") && !relative.matches("skills/[A-Za-z0-9_-]{1,80}/SKILL\\.md")) throw new AppFailure("write_scope", "本版本仅修改 config.toml、AGENTS.md 和用户技能 SKILL.md。");
        return new TransactionEngine.Port() {
            @Override public byte[] read() throws Exception { return readFile(relative); }
            @Override public void write(byte[] bytes) throws Exception { writeFile(relative, bytes); }
            @Override public void delete() throws Exception { deleteFile(relative); }
        };
    }
    byte[] auth() throws Exception { return readFile("auth.json"); }
    @Override public byte[] read() throws Exception { return readFile("config.toml"); }
    @Override public void write(byte[] bytes) throws Exception { writeFile("config.toml", bytes); }
    @Override public void delete() throws Exception { deleteFile("config.toml"); }
    static byte[] readUri(ContentResolver resolver, Uri uri, int limit) throws Exception {
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) throw new AppFailure("read_failed", "DocumentsProvider 无法打开读取流。");
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int count; (count = stream.read(buffer)) != -1;) {
                if (result.size() + count > limit) throw new AppFailure("too_large", "文件超过本应用的安全读取大小限制。");
                result.write(buffer, 0, count);
            }
            return result.toByteArray();
        }
    }
    static void writeUri(ContentResolver resolver, Uri uri, byte[] bytes) throws Exception {
        // rwt requests truncation. Do not fall back to w: its truncation behavior
        // is provider-specific and can leave an old tail on a shorter TOML file.
        try (OutputStream stream = resolver.openOutputStream(uri, "rwt")) {
            if (stream == null) throw new AppFailure("write_failed", "DocumentsProvider 无法打开写入流。");
            stream.write(bytes);
            stream.flush();
        }
    }
    static String utf8(byte[] bytes) throws Exception {
        if (bytes == null) return null;
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (Exception error) { throw new AppFailure("invalid_encoding", "文件不是有效 UTF-8 文本。没有覆盖原文件。"); }
    }
}
