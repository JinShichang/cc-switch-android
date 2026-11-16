package app.ccswitch.android;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.json.JSONObject;
import java.util.List;

/** Choose the system document broker instead of an OEM local-files replacement.
 * URI grants still come from the visible Android picker and the user's choice.
 */
final class DocumentPicker {
    private static final String[] BROKERS = { "com.google.android.documentsui", "com.android.documentsui" };
    static Intent intent(Context context, String action, String currentUri) throws Exception {
        Intent intent = new Intent(action).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        if (Intent.ACTION_OPEN_DOCUMENT_TREE.equals(action)) intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        else intent.addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        PackageManager manager = context.getPackageManager();
        ComponentName component = select(manager, intent);
        if (component == null) throw new AppFailure("documents_ui_missing", "系统 DocumentsUI 不可用或被禁用。请启用系统“文件 / DocumentsUI”后重试；厂商“全部文件”选择器不能显示 Codex 私有文档目录。");
        intent.setComponent(component);
        // Only a previously granted document is a known valid location. Codex's
        // root IDs contain an epoch: never fabricate or hard-code one.
        if (currentUri != null && !currentUri.isEmpty()) {
            Uri tree = Uri.parse(currentUri);
            if (DocumentsContract.isTreeUri(tree)) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
        }
        return intent;
    }
    private static ComponentName select(PackageManager manager, Intent intent) {
        for (String name : BROKERS) {
            Intent candidate = new Intent(intent).setPackage(name);
            List<ResolveInfo> matches = manager.queryIntentActivities(candidate, PackageManager.MATCH_DEFAULT_ONLY);
            for (ResolveInfo match : matches) if (systemBroker(manager, match)) return new ComponentName(name, match.activityInfo.name);
        }
        for (ResolveInfo match : manager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)) {
            if (systemBroker(manager, match)) return new ComponentName(match.activityInfo.packageName, match.activityInfo.name);
        }
        return null;
    }
    private static boolean systemBroker(PackageManager manager, ResolveInfo info) {
        return info.activityInfo != null && info.activityInfo.exported && info.activityInfo.enabled
            && (info.activityInfo.applicationInfo.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
            && manager.checkPermission("android.permission.MANAGE_DOCUMENTS", info.activityInfo.packageName) == PackageManager.PERMISSION_GRANTED;
    }
    static JSONObject status(Context context) throws Exception {
        ProviderInfo provider = context.getPackageManager().resolveContentProvider("com.ai.codex.documents", 0);
        ComponentName picker = select(context.getPackageManager(), new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE));
        return new JSONObject().put("codexProviderInstalled", provider != null && provider.enabled)
            .put("pickerAvailable", picker != null).put("pickerPackage", picker == null ? "" : picker.getPackageName())
            .put("message", provider == null
                ? "未检测到 Codex 文档提供方。请安装含 DocumentsProvider 的 Codex 版本，再在系统文件侧栏选择 Codex。"
                : "在系统文件选择器打开左侧“位置”菜单，选择 Codex → .codex → 使用此文件夹。若 Codex 根目录为空，请先在 Codex 中完成环境初始化。");
    }
}
