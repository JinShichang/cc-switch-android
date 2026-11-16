import app.ccswitch.android.TransactionEngine;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Host fault-injection tests against the exact transaction engine in the APK. */
public final class TransactionEngineTest {
    interface Checked { void run() throws Exception; }
    static int passed;
    static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    static byte[] copy(byte[] value) { return value == null ? null : value.clone(); }
    static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    static void test(String name, Checked work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
    static void failure(String code, Checked work) throws Exception {
        try { work.run(); throw new AssertionError("Expected failure " + code); }
        catch (TransactionEngine.Failure error) { check(code.equals(error.code), "Wrong failure code: " + error.code); }
    }
    static final class Port implements TransactionEngine.Port {
        byte[] value;
        int reads, writes, deletes;
        String fault = "";
        boolean unreadable;
        Port(byte[] value) { this.value = copy(value); }
        public byte[] read() throws Exception { reads++; if (unreadable) throw new IOException("fixture read failure"); return copy(value); }
        public void write(byte[] after) throws Exception {
            writes++;
            if (fault.equals("intact")) throw new IOException("fixture permission failure");
            value = copy(after);
            if (fault.equals("partial")) { value = new byte[] { (byte)0xe4, (byte)0xb8 }; throw new IOException("fixture interrupted UTF-8 write"); }
            if (fault.equals("close")) throw new IOException("fixture close failure");
            if (fault.equals("mismatch")) value = bytes("external change");
            if (fault.equals("read")) unreadable = true;
        }
        public void delete() throws Exception { deletes++; if (fault.equals("intact")) throw new IOException("fixture delete denied"); value = null; }
    }
    static final class Journal implements TransactionEngine.Journal {
        int prepared, finished;
        byte[] original, target;
        Boolean committed;
        Checked onPrepare = () -> {};
        Checked onFinish = () -> {};
        public void prepare(byte[] before, byte[] after) throws Exception { prepared++; original = copy(before); target = copy(after); onPrepare.run(); }
        public void finish(boolean saved) throws Exception { finished++; committed = saved; onFinish.run(); }
    }
    static void apply(Port port, byte[] after, Journal journal) throws Exception { TransactionEngine.apply(port, TransactionEngine.hash(port.value), after, journal); }
    public static void main(String[] args) throws Exception {
        test("hash distinguishes missing, empty and auth-only changes", () -> {
            check(!TransactionEngine.hash(null).equals(TransactionEngine.hash(new byte[0])), "Missing and empty collided");
            check(!TransactionEngine.revision(bytes("same"), null).equals(TransactionEngine.revision(bytes("same"), bytes("new auth"))), "Auth not in revision");
        });
        test("successful write retains original bytes and commits only after readback", () -> {
            Port p = new Port(bytes("before 中文\r\n")); Journal j = new Journal(); byte[] before = p.value;
            apply(p, bytes("after"), j);
            check(Arrays.equals(before, j.original), "Backup changed bytes");
            check(Boolean.TRUE.equals(j.committed) && p.reads >= 3 && p.writes == 1, "Write not verified");
        });
        test("identical config makes no write or redundant journal", () -> {
            Port p = new Port(bytes("same")); Journal j = new Journal(); apply(p, bytes("same"), j);
            check(p.writes == 0 && j.prepared == 0 && j.finished == 0, "No-op wrote data");
        });
        test("missing file can be created with a missing-file backup", () -> {
            Port p = new Port(null); Journal j = new Journal(); apply(p, bytes("new"), j);
            check(j.original == null && Arrays.equals(p.value, bytes("new")), "Create failed");
        });
        test("restoring missing file deletes and verifies absence", () -> {
            Port p = new Port(bytes("current")); Journal j = new Journal(); apply(p, null, j);
            check(p.value == null && p.deletes == 1 && Boolean.TRUE.equals(j.committed), "Delete not verified");
        });
        test("revision conflict stops before journal and write", () -> {
            Port p = new Port(bytes("changed")); Journal j = new Journal();
            failure("conflict", () -> TransactionEngine.apply(p, TransactionEngine.hash(bytes("old")), bytes("new"), j));
            check(j.prepared == 0 && p.writes == 0, "Conflict overwrote external content");
        });
        test("external edit during backup aborts without a commit", () -> {
            Port p = new Port(bytes("old")); Journal j = new Journal(); j.onPrepare = () -> p.value = bytes("external");
            failure("conflict", () -> apply(p, bytes("new"), j));
            check(p.writes == 0 && Boolean.FALSE.equals(j.committed), "Race committed");
        });
        test("durable backup failure prevents truncation", () -> {
            Port p = new Port(bytes("old")); Journal j = new Journal(); j.onPrepare = () -> { throw new IOException("disk full"); };
            try { apply(p, bytes("new"), j); throw new AssertionError(); } catch (IOException expected) { }
            check(p.writes == 0, "Wrote without backup");
        });
        test("read-only write is identified as intact and aborted", () -> {
            Port p = new Port(bytes("old")); p.fault = "intact"; Journal j = new Journal();
            failure("write_failed_intact", () -> apply(p, bytes("new"), j));
            check(Boolean.FALSE.equals(j.committed) && Arrays.equals(p.value, bytes("old")), "Original not intact");
        });
        test("partial UTF-8 write retains recovery journal and never blindly rolls back", () -> {
            Port p = new Port(bytes("old")); p.fault = "partial"; Journal j = new Journal();
            failure("write_unconfirmed", () -> apply(p, bytes("中文"), j));
            check(j.finished == 0 && p.writes == 1 && Arrays.equals(j.original, bytes("old")), "Lost recovery evidence");
        });
        test("close failure stays unconfirmed even with matching readback", () -> {
            Port p = new Port(bytes("old")); p.fault = "close"; Journal j = new Journal();
            failure("write_unconfirmed", () -> apply(p, bytes("new"), j)); check(j.finished == 0, "Close failure marked successful");
        });
        test("foreign readback retains external bytes and recovery point", () -> {
            Port p = new Port(bytes("old")); p.fault = "mismatch"; Journal j = new Journal();
            failure("write_unconfirmed", () -> apply(p, bytes("new"), j));
            check(j.finished == 0 && Arrays.equals(p.value, bytes("external change")), "Overwrote foreign bytes");
        });
        test("unreadable readback remains recoverable", () -> {
            Port p = new Port(bytes("old")); p.fault = "read"; Journal j = new Journal();
            failure("write_unconfirmed", () -> apply(p, bytes("new"), j)); check(j.finished == 0, "Unknown state cleared journal");
        });
        test("recovery works from invalid UTF-8 using exact bytes", () -> {
            byte[] bad = { (byte)0xe4, (byte)0xb8 }; Port p = new Port(bad); Journal j = new Journal();
            apply(p, bytes("model = \"test\"\n"), j);
            check(Arrays.equals(j.original, bad) && Boolean.TRUE.equals(j.committed), "Invalid UTF-8 blocked recovery");
        });
        test("deletion refusal never claims recovery succeeded", () -> {
            Port p = new Port(bytes("old")); p.fault = "intact"; Journal j = new Journal();
            failure("write_failed_intact", () -> apply(p, null, j)); check(Boolean.FALSE.equals(j.committed), "Failed delete committed");
        });
        test("metadata commit failure propagates after file write", () -> {
            Port p = new Port(bytes("old")); Journal j = new Journal(); j.onFinish = () -> { throw new IOException("fixture vault failure"); };
            try { apply(p, bytes("new"), j); throw new AssertionError(); } catch (IOException expected) { }
            check(Arrays.equals(p.value, bytes("new")), "File result unknown");
        });
        System.out.println(passed + " native transaction tests passed");
    }
}
