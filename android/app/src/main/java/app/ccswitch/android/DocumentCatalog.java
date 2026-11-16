package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;

/** Bounded catalog and JSONL reads from the granted tree, never guest paths. */
final class DocumentCatalog {
    private static final int MAX_NODES = 5000;
    private final TreeAccess tree;
    private int nodes;
    private boolean truncated;
    DocumentCatalog(TreeAccess tree) { this.tree = tree; }
    JSONObject catalog(String kind) throws Exception {
        List<JSONObject> files = new ArrayList<>();
        if (kind.equals("skills")) walk("skills", 0, 4, true, files);
        else if (kind.equals("sessions")) {
            walk("sessions", 0, 6, false, files);
            walk("archived_sessions", 0, 6, false, files);
        } else throw new AppFailure("invalid_catalog", "不支持此文档列表。");
        // Codex can briefly expose plain and compressed siblings while resuming a thread.
        Map<String, JSONObject> logical = new LinkedHashMap<>();
        for (JSONObject candidate : files) {
            String name = candidate.getString("path");
            String logicalName = name.endsWith(".jsonl.zst") ? name.substring(0, name.length() - 4) : name;
            JSONObject previous = logical.get(logicalName);
            if (previous == null || name.endsWith(".jsonl")) logical.put(logicalName, candidate);
        }
        files = new ArrayList<>(logical.values());
        files.sort(Comparator.<JSONObject>comparingLong(item -> item.optLong("modified")).reversed().thenComparing(item -> item.optString("path")));
        int maximum = kind.equals("skills") ? 200 : 1000;
        if (files.size() > maximum) truncated = true;
        JSONArray output = new JSONArray();
        for (int i = 0; i < Math.min(files.size(), maximum); i++) output.put(files.get(i));
        JSONObject result = new JSONObject().put("files", output).put("truncated", truncated).put("limit", maximum);
        if (kind.equals("sessions")) {
            try { byte[] index = tree.readFile("session_index.jsonl"); result.put("index", index == null ? "" : TreeAccess.utf8(index)); }
            catch (AppFailure failure) { if (!failure.code.equals("too_large")) throw failure; result.put("index", "").put("indexTruncated", true); }
        }
        return result;
    }
    private void walk(String directory, int depth, int maxDepth, boolean skills, List<JSONObject> output) throws Exception {
        if (nodes >= MAX_NODES) { truncated = true; return; }
        JSONArray entries = tree.list(directory, MAX_NODES);
        for (int i = 0; i < entries.length(); i++) {
            if (++nodes > MAX_NODES) { truncated = true; return; }
            JSONObject item = entries.getJSONObject(i);
            String name = item.getString("name");
            if (item.getBoolean("directory")) {
                if (name.equals(".git") || name.equals("node_modules")) continue;
                if (depth < maxDepth) walk(item.getString("path"), depth + 1, maxDepth, skills, output);
                else truncated = true;
            } else if ((skills && name.equals("SKILL.md")) || (!skills && (name.endsWith(".jsonl") || name.endsWith(".jsonl.zst")))) output.add(item);
        }
    }
    JSONObject document(String relative) throws Exception {
        TreeAccess.validPath(relative);
        if (!relative.equals("AGENTS.md") && !(relative.startsWith("skills/") && relative.endsWith("/SKILL.md"))) throw new AppFailure("read_scope", "不支持读取此文档。");
        byte[] content = tree.readFile(relative);
        return new JSONObject().put("path", relative).put("text", content == null ? JSONObject.NULL : TreeAccess.utf8(content)).put("hash", TransactionEngine.hash(content));
    }
    JSONObject session(String relative, boolean usageOnly) throws Exception {
        TreeAccess.validPath(relative);
        if (!(relative.startsWith("sessions/") || relative.startsWith("archived_sessions/")) || !(relative.endsWith(".jsonl") || relative.endsWith(".jsonl.zst"))) throw new AppFailure("read_scope", "不支持读取此会话文件。");
        return SessionLogReader.read(tree.openFile(relative), relative, usageOnly);
    }
}
