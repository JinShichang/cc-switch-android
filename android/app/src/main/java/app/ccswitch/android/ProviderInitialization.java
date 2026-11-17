package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

/** Desktop startup semantics with an explicit once flag in the encrypted vault.
 * No filesystem, credentials-store access or Android dependency. */
final class ProviderInitialization {
    static JSONObject initialize(JSONObject data, JSONObject args) throws Exception {
        JSONObject next = new JSONObject(data.toString());
        if (next.optInt("providerInitialization", 0) == 1) return next;
        JSONArray old = next.getJSONArray("providers");
        JSONArray expected = args.getJSONArray("expectedProviderIds");
        if (old.length() != expected.length()) throw new IllegalStateException("方案列表已改变，请刷新后重试。");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < old.length(); i++) {
            String id = old.getJSONObject(i).getString("id");
            if (!id.equals(expected.getString(i)) || !ids.add(id))
                throw new IllegalStateException("方案列表已改变，请刷新后重试。");
        }
        JSONArray additions = args.getJSONArray("additions");
        if (additions.length() > 2) throw new IllegalArgumentException("初始化方案数无效。");
        boolean imported = false;
        for (int i = 0; i < additions.length(); i++) {
            JSONObject item = additions.getJSONObject(i);
            String id = item.getString("id");
            if (!ids.add(id)) throw new IllegalArgumentException("初始化方案标识重复。");
            if (id.equals("default")) {
                if (old.length() != i || i != 0) throw new IllegalArgumentException("仅在方案为空时导入 default。");
                imported = true;
            } else if (!id.equals("codex-official")) throw new IllegalArgumentException("初始化方案标识无效。");
            if (item.getString("name").trim().isEmpty() || item.getJSONObject("settingsConfig").getString("config").length() > 2 * 1024 * 1024)
                throw new IllegalArgumentException("初始化方案结构无效。");
            old.put(new JSONObject(item.toString()));
        }
        if (!ids.contains("codex-official") || (imported != args.optString("importedId").equals("default")))
            throw new IllegalArgumentException("初始化结果不完整。");
        next.put("providerInitialization", 1);
        return next;
    }
}
