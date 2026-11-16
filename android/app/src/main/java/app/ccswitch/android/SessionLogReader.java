package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.io.FilterInputStream;
import java.io.IOException;
import com.github.luben.zstd.ZstdInputStream;

/** Read complete JSONL records under fixed bounds. A growing tail does not invalidate the prefix. */
final class SessionLogReader {
    static JSONObject read(InputStream source, String relative, boolean usageOnly) throws Exception {
        try (InputStream input = decoded(source, relative)) {
            return readJsonl(input, relative, usageOnly);
        }
    }
    private static InputStream decoded(InputStream source, String relative) throws Exception {
        if (!relative.endsWith(".jsonl.zst")) return source;
        try { return new ZstdInputStream(new FilterInputStream(source) {
            long compressedBytes;
            private void check(int count) throws IOException {
                if (count > 0 && (compressedBytes += count) > 32L * 1024 * 1024) throw new IOException("Compressed session exceeds read limit");
            }
            @Override public int read() throws IOException { int n = in.read(); check(n >= 0 ? 1 : 0); return n; }
            @Override public int read(byte[] b, int off, int len) throws IOException { int n = in.read(b, off, len); check(n); return n; }
        }); } catch (Exception | LinkageError failure) { source.close(); throw new IOException("Session decompressor is unavailable", failure); }
    }
    private static JSONObject readJsonl(InputStream input, String relative, boolean usageOnly) throws Exception {
        JSONArray events = new JSONArray();
        long bytesRead = 0, maxTimestamp = 0;
        int invalid = 0, lines = 0, outputBytes = 0;
        boolean limited = false, incompleteTail = false;
        // Byte-level line bounds avoid BufferedReader.readLine allocating a huge tool output.
        try (input) {
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
                            JSONObject event = new JSONObject(utf8(line.toByteArray()));
                            maxTimestamp = Math.max(maxTimestamp, timestamp(event));
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
            // Match upstream: accept a complete final JSON object without a newline;
            // a partial final record is left unconsumed for the next append.
            if (!limited && (line.size() > 0 || skipping)) {
                if (skipping) incompleteTail = true;
                else try {
                    JSONObject event = new JSONObject(utf8(line.toByteArray()));
                    maxTimestamp = Math.max(maxTimestamp, timestamp(event));
                    JSONObject projected = project(event, usageOnly);
                    if (projected != null) {
                        int size = projected.toString().getBytes(StandardCharsets.UTF_8).length;
                        if (events.length() >= 2000 || outputBytes + size > 2 * 1024 * 1024) limited = true;
                        else events.put(projected);
                    }
                } catch (Exception partial) { incompleteTail = true; }
            }
        }
        return new JSONObject().put("path", relative).put("events", events).put("truncated", limited).put("incompleteTail", incompleteTail).put("invalidLines", invalid).put("bytesRead", bytesRead).put("maxTimestamp", maxTimestamp);
    }

    private static long timestamp(JSONObject event) {
        try { return java.time.Instant.parse(event.optString("timestamp")).toEpochMilli(); }
        catch (Exception ignored) { return 0; }
    }
    private static JSONObject project(JSONObject event, boolean usageOnly) throws Exception {
        String type = event.optString("type");
        JSONObject payload = event.optJSONObject("payload");
        if (payload == null) return null;
        JSONObject result = new JSONObject().put("type", type).put("timestamp", event.opt("timestamp"));
        if (event.has("ordinal")) result.put("ordinal", event.get("ordinal"));
        JSONObject output = new JSONObject();
        if (type.equals("session_meta")) copy(payload, output, "id", "thread_id", "cwd", "timestamp", "forked_from_id", "forked_from_ordinal_exclusive", "history_base", "parent_thread_id", "history_base_thread_id", "history_mode", "threadId", "model_provider", "model", "source");
        else if (!usageOnly && type.equals("response_item")) { output=new JSONObject(payload.toString());if(output.has("encrypted_content")){output.remove("encrypted_content");output.put("redacted",true);} }
        else if (!usageOnly && type.equals("event_msg") && java.util.Set.of("turn_aborted","context_compacted","error").contains(payload.optString("type"))) copy(payload,output,"type","message");
        else if (type.equals("event_msg") && payload.optString("type").equals("thread_settings_applied")) copy(payload, output, "type", "thread_settings", "settings");
        else if (type.equals("turn_context")) copy(payload, output, "turn_id", "model", "model_provider", "info");
        else if (type.equals("token_usage_record")) copy(payload, output, "turn_id", "response_id", "turn_token_usage", "thread_token_usage", "model", "token_usage", "usage");
        else if (type.equals("compacted")) copy(payload, output, "type");
        else if (type.equals("event_msg") && payload.optString("type").equals("context_compacted")) copy(payload, output, "type");
        else if (type.equals("event_msg") && payload.optString("type").equals("token_count")) copy(payload, output, "type", "info", "model", "rate_limits");
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
    private static String utf8(byte[] data) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(data)).toString();
    }
}
