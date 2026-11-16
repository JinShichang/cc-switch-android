package app.ccswitch.android;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

/** All provider keys, backups and pending journals are device-bound AES-GCM.
 * No credentials in preferences, WebView storage, logs or Android backup.
 */
final class EncryptedRepository {
    private static final String ALIAS = "app.ccswitch.android.storage.v1";
    private static final int MAX_BYTES = 48 * 1024 * 1024;
    private final AtomicFile file;
    private JSONObject data;

    EncryptedRepository(Context context) throws Exception { this(context, "cc-switch.v1.enc"); }
    EncryptedRepository(Context context, String filename) throws Exception {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), filename));
        if (file.getBaseFile().exists() || new File(file.getBaseFile() + ".bak").exists()) {
            try (FileInputStream in = file.openRead()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) != -1;) {
                    if (out.size() + n > MAX_BYTES + 1024) throw new IllegalStateException();
                    out.write(buffer, 0, n);
                }
                byte[] bytes = out.toByteArray();
                if (bytes.length < 32 || bytes[0] != 'C' || bytes[1] != 'C' || bytes[2] != 'S' || bytes[3] != 1) throw new IllegalStateException();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOfRange(bytes, 4, 16)));
                cipher.updateAAD("CCSwitchAndroid/v1".getBytes(StandardCharsets.US_ASCII));
                data = new JSONObject(new String(cipher.doFinal(bytes, 16, bytes.length - 16), StandardCharsets.UTF_8));
            } catch (Exception error) {
                throw new AppFailure("vault_unavailable", "本地加密数据暂时无法读取。请解锁设备后重试；若密钥已丢失，需要从你导出的文件恢复。现有加密文件未覆盖。");
            }
        } else {
            data = new JSONObject().put("providers", new JSONArray()).put("backups", new JSONArray())
                .put("journals", new JSONObject()).put("ownership", new JSONObject())
                .put("settings", new JSONObject().put("zoom", 100).put("theme", "system"));
        }
    }
    void migrate() throws Exception {
        JSONObject next = copy();
        boolean changed = false;
        if (data.optInt("schemaVersion", 1) < 3) {
            next.getJSONObject("settings").put("zoom", 100);
            next.put("schemaVersion", 3); changed = true;
        }
        for (String key : new String[] { "prompts", "documentBackups" }) if (!next.has(key)) { next.put(key, new JSONArray()); changed = true; }
        if (!next.has("documentJournals")) { next.put("documentJournals", new JSONObject()); changed = true; }
        if (changed) replace(next);
    }
    JSONObject copy() throws Exception { return new JSONObject(data.toString()); }
    void replace(JSONObject next) throws Exception {
        byte[] plain = next.toString().getBytes(StandardCharsets.UTF_8);
        if (plain.length > MAX_BYTES) throw new AppFailure("storage_limit", "本地方案和备份超过 48 MB 限制，请先导出并删除不需要的方案。");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD("CCSwitchAndroid/v1".getBytes(StandardCharsets.US_ASCII));
        byte[] encrypted = cipher.doFinal(plain);
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(new byte[] { 'C', 'C', 'S', 1 });
            out.write(cipher.getIV());
            out.write(encrypted);
            out.getFD().sync();
            file.finishWrite(out);
            data = next;
        } catch (Exception error) {
            if (out != null) file.failWrite(out);
            throw new AppFailure("vault_write", "无法保存本地加密数据，请检查剩余空间。没有确认操作成功。");
        } finally { Arrays.fill(plain, (byte) 0); }
    }
    private static SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("Missing device key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setUnlockedDeviceRequired(true).build());
        return generator.generateKey();
    }
}
