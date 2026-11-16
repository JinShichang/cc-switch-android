package app.ccswitch.android;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Single-document, optimistic transaction. SAF has no general atomic rename or
 * cross-process lock. A durable local journal precedes truncation; uncertain
 * partial writes are never "rolled back" over possible concurrent client edits.
 * This class deliberately has no Android dependency so failure paths can be
 * tested on the host using the exact implementation included in the APK.
 */
public final class TransactionEngine {
    public interface Port {
        byte[] read() throws Exception;
        void write(byte[] bytes) throws Exception;
        void delete() throws Exception;
    }
    public interface Journal {
        void prepare(byte[] before, byte[] after) throws Exception;
        void finish(boolean committed) throws Exception;
    }
    public static final class Failure extends Exception {
        public final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }
    public static String hash(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update((byte) (bytes == null ? 0 : 1));
            if (bytes != null) digest.update(bytes);
            StringBuilder hex = new StringBuilder(64);
            for (byte value : digest.digest()) {
                hex.append(Character.forDigit((value >>> 4) & 15, 16));
                hex.append(Character.forDigit(value & 15, 16));
            }
            return hex.toString();
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
    public static String revision(byte[] config, byte[] auth) {
        return hash((hash(config) + ":" + hash(auth)).getBytes(StandardCharsets.US_ASCII));
    }
    public static void apply(Port port, String expectedHash, byte[] after, Journal journal) throws Exception {
        byte[] before = port.read();
        if (!hash(before).equals(expectedHash)) throw conflict();
        if (Arrays.equals(before, after)) return;
        journal.prepare(before, after);
        // Preparing a durable encrypted backup may take time. Re-check after it.
        if (!Arrays.equals(before, port.read())) {
            journal.finish(false);
            throw conflict();
        }
        try {
            if (after == null) port.delete(); else port.write(after);
            if (!Arrays.equals(after, port.read())) {
                throw new Failure("write_unconfirmed", "写入后的内容与目标不一致。已保留写入前备份；请检查目录后恢复。未确认保存成功。");
            }
        } catch (Exception failure) {
            boolean intact = false;
            try { intact = Arrays.equals(before, port.read()); } catch (Exception ignored) { }
            if (intact) {
                journal.finish(false);
                throw new Failure("write_failed_intact", "写入失败，已读回确认原文件未改变。请检查目录权限和剩余空间。");
            }
            // Even a close() failure with matching bytes remains unconfirmed:
            // read-back alone cannot guarantee provider-side durability.
            throw new Failure("write_unconfirmed", "写入未能完成确认，文件可能不完整。已保留加密恢复备份，请使用“恢复”检查并处理。");
        }
        journal.finish(true);
    }
    private static Failure conflict() {
        return new Failure("conflict", "配置已被其他应用修改。请刷新当前配置后重试；没有覆盖外部修改。");
    }
}
