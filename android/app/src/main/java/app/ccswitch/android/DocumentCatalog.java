package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

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
        files.sort(Comparator.<JSONObject>comparingLong(item -> item.optLong("modified")).reversed().thenComparing(item -> item.optString("path")));
        int maximum = kind.equals("skills") ? 200 : 150;
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
            } else if ((skills && name.equals("SKILL.md")) || (!skills && name.endsWith(".jsonl"))) output.add(item);
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
        if (!(relative.startsWith("sessions/") || relative.startsWith("archived_sessions/")) || !relative.endsWith(".jsonl")) throw new AppFailure("read_scope", "不支持读取此会话文件。");
        JSONArray events = new JSONArray();
        long bytesRead = 0;
        int invalid = 0, lines = 0, outputBytes = 0;
        boolean limited = false;
        // Byte-level line bounds avoid BufferedReader.readLine allocating a huge tool output.
        try (InputStream input = tree.openFile(relative)) {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            boolean skipping = false;
            outer: for (int n; (n = input.read(buffer)) != -1;) {
                bytesRead += n;
                if (bytesRead > 32L * 1024 * 1024) { limited = true; break; }
                for (int i = 0; i < n; i++) {
                    if (buffer[i] != '\n') {
                        if (!skipping) {
                            if (line.size() >= 512 * 1024) { skipping = true; line.reset(); invalid++; }
                            else line.write(buffer[i]);
                        }
                        continue;
                    }
                    if (++lines > 100000) { limited = true; break outer; }
                    if (!skipping && line.size() > 0) {
                        try {
                            JSONObject event = new JSONObject(TreeAccess.utf8(line.toByteArray()));
                            JSONObject projected = project(event, usageOnly);
                            if (projected != null) {
                                int size = projected.toString().getBytes(StandardCharsets.UTF_8).length;
                                if (events.length() >= 2000 || outputBytes + size > 2 * 1024 * 1024) { limited = true; break outer; }
                                events.put(projected); outputBytes += size;
                            }
                        } catch (Exception malformed) { invalid++; }
                    }
                    line.reset(); skipping = false;
                }
            }
            // A non-terminated last line may still be in-flight; do not parse it.
            if (line.size() > 0 || skipping) limited = true;
        }
        return new JSONObject().put("path", relative).put("events", events).put("truncated", limited).put("invalidLines", invalid).put("bytesRead", bytesRead);
    }
    private static JSONObject project(JSONObject event, boolean usageOnly) throws Exception {
        String type = event.optString("type");
        JSONObject payload = event.optJSONObject("payload");
        if (payload == null) return null;
        JSONObject result = new JSONObject().put("type", type).put("timestamp", event.opt("timestamp"));
        JSONObject output = new JSONObject();
        if (type.equals("session_meta")) copy(payload, output, "id", "cwd", "timestamp", "forked_from_id", "source");
        else if (type.equals("turn_context")) copy(payload, output, "turn_id", "model");
        else if (type.equals("token_usage_record")) copy(payload, output, "turn_id", "response_id", "turn_token_usage", "token_usage", "usage");
        else if (type.equals("event_msg") && payload.optString("type").equals("token_count")) copy(payload, output, "type", "info");
        else if (!usageOnly && type.equals("event_msg") && (payload.optString("type").equals("user_message") || payload.optString("type").equals("agent_message"))) {
            copy(payload, output, "type"); output.put("message", clip(payload.optString("message")));
        } else if (!usageOnly && type.equals("response_item") && payload.optString("type").equals("message")) {
            copy(payload, output, "type", "role");
            JSONArray source = payload.optJSONArray("content"), content = new JSONArray();
            if (source != null) for (int i = 0; i < Math.min(source.length(), 32); i++) {
                JSONObject part = source.optJSONObject(i);
                if (part != null && part.has("text")) content.put(new JSONObject().put("text", clip(part.optString("text"))));
            }
            output.put("content", content);
        } else return null;
        return result.put("payload", output);
    }
    private static String clip(String text) { return text.length() > 16000 ? text.substring(0, 16000) + "\n[长消息已截断]" : text; }
    private static void copy(JSONObject source, JSONObject target, String... names) throws Exception {
        for (String name : names) if (source.has(name)) target.put(name, source.get(name));
    }
}
