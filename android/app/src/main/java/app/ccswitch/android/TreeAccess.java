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
    private Uri child(String name, boolean needWrite) throws Exception {
        if (!name.equals("config.toml") && !name.equals("auth.json")) throw new IllegalArgumentException("Unsupported document");
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootId);
        Uri found = null;
        try (Cursor cursor = resolver.query(children, new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS }, null, null, null)) {
            if (cursor == null) throw new AppFailure("directory_unavailable", "无法列出授权目录，请检查提供方是否运行及目录权限。");
            while (cursor.moveToNext()) {
                if (!name.equals(cursor.getString(1))) continue;
                if (found != null) throw new AppFailure("ambiguous_file", "目录内有重名配置文件，无法确定写入对象。请整理后重试。");
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) throw new AppFailure("wrong_file_type", name + " 是目录，无法作为配置文件读取。");
                if (needWrite && (cursor.getInt(3) & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) == 0) throw new AppFailure("read_only", "config.toml 为只读文件，请检查 DocumentsProvider 提供的写入权限。");
                found = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
            }
        }
        return found;
    }
    byte[] auth() throws Exception {
        Uri uri = child("auth.json", false);
        return uri == null ? null : readUri(resolver, uri, MAX_CONFIG);
    }
    @Override public byte[] read() throws Exception {
        Uri uri = child("config.toml", false);
        return uri == null ? null : readUri(resolver, uri, MAX_CONFIG);
    }
    @Override public void write(byte[] bytes) throws Exception {
        if (bytes.length > MAX_CONFIG) throw new AppFailure("too_large", "config.toml 超过 2 MB 限制。");
        Uri target = child("config.toml", true);
        if (target == null) {
            if (!info().getBoolean("canWrite")) throw new AppFailure("cannot_create", "授权目录不允许创建 config.toml。请检查提供方的创建权限。");
            Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
            target = DocumentsContract.createDocument(resolver, root, "application/toml", "config.toml");
            if (target == null) throw new AppFailure("create_failed", "DocumentsProvider 没有创建 config.toml。");
            Uri resolved = child("config.toml", true);
            if (resolved == null || !DocumentsContract.getDocumentId(target).equals(DocumentsContract.getDocumentId(resolved))) {
                throw new AppFailure("create_renamed", "DocumentsProvider 改变了新文件名称，无法确认 config.toml。请检查授权目录。");
            }
        }
        writeUri(resolver, target, bytes);
    }
    @Override public void delete() throws Exception {
        Uri target = child("config.toml", false);
        if (target != null && !DocumentsContract.deleteDocument(resolver, target)) throw new AppFailure("delete_failed", "无法恢复“原文件不存在”的状态：提供方未允许删除 config.toml。");
    }
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
