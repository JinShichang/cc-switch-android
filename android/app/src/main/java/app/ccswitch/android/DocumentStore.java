package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;

/** The same fault-tested transaction engine protects prompt and skill writes. */
final class DocumentStore {
    private final TreeAccess access;
    private final EncryptedRepository repository;
    DocumentStore(TreeAccess access, EncryptedRepository repository) { this.access = access; this.repository = repository; }
    JSONObject save(JSONObject args) throws Exception {
        String relative = args.getString("path");
        String key = access.tree + "\n" + relative;
        if (repository.copy().getJSONObject("documentJournals").has(key)) throw new AppFailure("pending_document_recovery", "此文档有未确认写入，请先在设置 → 数据中恢复文档。");
        String text = args.getString("text");
        byte[] target = text.getBytes(StandardCharsets.UTF_8);
        if (target.length > TreeAccess.MAX_CONFIG) throw new AppFailure("too_large", "文档超过 2 MB 限制。");
        return write(relative, target, args.getString("expectedHash"), "保存 · " + relative);
    }
    JSONObject restore(JSONObject args) throws Exception {
        JSONObject data = repository.copy(), backup = null;
        if (args.optBoolean("recover")) backup = data.getJSONObject("documentJournals").optJSONObject(access.tree + "\n" + args.getString("path"));
        else {
            JSONArray all = data.getJSONArray("documentBackups");
            for (int i = 0; i < all.length(); i++) if (all.getJSONObject(i).getString("id").equals(args.getString("id"))) backup = all.getJSONObject(i);
        }
        if (backup == null) throw new AppFailure("missing_backup", "文档备份不存在。");
        if (!backup.getString("treeUri").equals(access.tree.toString())) throw new AppFailure("wrong_directory", "此备份属于另一个授权目录。");
        byte[] target = backup.isNull("content") ? null : Base64.getDecoder().decode(backup.getString("content"));
        return write(backup.getString("path"), target, args.getString("expectedHash"), "恢复 · " + backup.getString("path"));
    }
    private JSONObject write(String relative, byte[] target, String expectedHash, String reason) throws Exception {
        TransactionEngine.Port port = access.port(relative);
        String key = access.tree + "\n" + relative;
        JSONObject pending = repository.copy().getJSONObject("documentJournals").optJSONObject(key);
        byte[] current = port.read();
        if (!TransactionEngine.hash(current).equals(expectedHash)) throw new AppFailure("conflict", "文档已在外部修改，请重新读取后重试。");
        TransactionEngine.Journal journal = new TransactionEngine.Journal() {
            @Override public void prepare(byte[] before, byte[] after) throws Exception {
                JSONObject data = repository.copy();
                JSONObject backup = new JSONObject().put("id", UUID.randomUUID().toString()).put("createdAt", System.currentTimeMillis())
                    .put("path", relative).put("treeUri", access.tree.toString()).put("reason", reason)
                    .put("content", before == null ? JSONObject.NULL : Base64.getEncoder().encodeToString(before));
                JSONArray all = data.getJSONArray("documentBackups"), retained = new JSONArray();
                for (int i = Math.max(0, all.length() - 9); i < all.length(); i++) retained.put(all.get(i));
                retained.put(backup); data.put("documentBackups", retained);
                if (pending == null) data.getJSONObject("documentJournals").put(key, backup);
                repository.replace(data);
            }
            @Override public void finish(boolean saved) throws Exception {
                JSONObject data = repository.copy();
                if (saved || pending == null) data.getJSONObject("documentJournals").remove(key);
                repository.replace(data);
            }
        };
        if(!Arrays.equals(current,target)){
            journal.prepare(current,target);
            String digest=null;
            if(current!=null){StringBuilder hex=new StringBuilder();for(byte b:java.security.MessageDigest.getInstance("SHA-256").digest(current)){hex.append(Character.forDigit((b>>>4)&15,16));hex.append(Character.forDigit(b&15,16));}digest=hex.toString();}
            NativeCore.get(access.context(),null).call("writeDocument",new JSONObject().put("path",relative)
                .put("expectedDigest",digest==null?JSONObject.NULL:digest).put("text",target==null?JSONObject.NULL:TreeAccess.utf8(target)));
            journal.finish(true);
        }
        if (Arrays.equals(current, target) && pending != null) journal.finish(true);
        JSONObject result = new JSONObject().put("path", relative).put("hash", TransactionEngine.hash(target)).put("fileSaved", true).put("runtimeConfirmed", false);
        try { result.put("text", target == null ? JSONObject.NULL : TreeAccess.utf8(target)); }
        catch (AppFailure invalidEncoding) { result.put("text", JSONObject.NULL).put("invalidEncoding", true); }
        return result;
    }
}
