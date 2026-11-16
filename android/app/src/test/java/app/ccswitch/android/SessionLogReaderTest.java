package app.ccswitch.android;

import org.junit.Test;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class SessionLogReaderTest {
    private static final String ROOT = "{\"ordinal\":10,\"type\":\"session_meta\",\"payload\":{\"id\":\"fixture\",\"forked_from_id\":\"parent\",\"forked_from_ordinal_exclusive\":10}}\n";
    private static final String USAGE = "{\"timestamp\":\"2026-11-16T06:00:00Z\",\"type\":\"token_usage_record\",\"payload\":{\"response_id\":\"r\",\"usage\":{\"input_tokens\":100,\"output_tokens\":10}}}\n";
    private JSONObject read(String input) throws Exception {
        return SessionLogReader.read(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)), "sessions/fixture.jsonl", true);
    }
    @Test public void incompleteTailPreservesCompletePrefix() throws Exception {
        JSONObject result = read(ROOT + USAGE + "{\"type\":");
        assertFalse(result.getBoolean("truncated"));
        assertTrue(result.getBoolean("incompleteTail"));
        assertEquals(2, result.getJSONArray("events").length());
        assertEquals(100, result.getJSONArray("events").getJSONObject(1).getJSONObject("payload").getJSONObject("usage").getInt("input_tokens"));
    }
    @Test public void malformedUnrelatedLineDoesNotDiscardUsage() throws Exception {
        JSONObject result = read(ROOT + "broken line\n" + USAGE);
        assertEquals(1, result.getInt("invalidLines"));
        assertEquals(2, result.getJSONArray("events").length());
        assertFalse(result.getBoolean("incompleteTail"));
    }
    @Test public void forkBoundaryAndOrdinalSurviveProjection() throws Exception {
        JSONObject meta = read(ROOT + USAGE).getJSONArray("events").getJSONObject(0);
        assertEquals(10, meta.getLong("ordinal"));
        assertEquals(10, meta.getJSONObject("payload").getLong("forked_from_ordinal_exclusive"));
    }
    @Test public void projectionLimitRetainsBoundedPrefix() throws Exception {
        JSONObject result = read(ROOT + USAGE.repeat(2100));
        assertTrue(result.getBoolean("truncated"));
        assertEquals(2000, result.getJSONArray("events").length());
        assertFalse(result.getBoolean("incompleteTail"));
    }
    @Test public void subsequentAppendIsReadableWithoutCountingPartialJson() throws Exception {
        String half = USAGE.substring(0, USAGE.length() / 2);
        assertEquals(1, read(ROOT + half).getJSONArray("events").length());
        assertEquals(2, read(ROOT + USAGE).getJSONArray("events").length());
    }
    @Test public void compressedSessionRetainsSameProjectedUsage() throws Exception {
        byte[] compressed = com.github.luben.zstd.Zstd.compress((ROOT + USAGE).getBytes(StandardCharsets.UTF_8));
        JSONObject result = SessionLogReader.read(new ByteArrayInputStream(compressed), "sessions/fixture.jsonl.zst", true);
        assertEquals(2, result.getJSONArray("events").length());
        assertFalse(result.getBoolean("truncated"));
    }
    @Test public void damagedCompressionFailsInsteadOfClaimingEmptySuccess() throws Exception {
        try {
            SessionLogReader.read(new ByteArrayInputStream("damaged".getBytes(StandardCharsets.UTF_8)), "sessions/fixture.jsonl.zst", true);
            fail("expected decompression failure");
        } catch (java.io.IOException expected) { }
    }
    @Test public void completeFinalRecordWithoutNewlineIsAccepted() throws Exception {
        JSONObject result = read(ROOT + USAGE.stripTrailing());
        assertEquals(2, result.getJSONArray("events").length());
        assertFalse(result.getBoolean("incompleteTail"));
    }
    @Test public void sourceLanesAndContinuationMetadataSurviveProjection() throws Exception {
        String data = "{\"timestamp\":\"2026-11-16T05:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"fixture\",\"history_mode\":\"paginated\",\"history_base\":{\"thread_id\":\"fixture\"}}}\n" +
            "{\"timestamp\":\"2026-11-16T06:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{},\"rate_limits\":{\"limit_id\":\"lane\"}}}\n";
        JSONObject result = read(data);
        assertEquals("paginated", result.getJSONArray("events").getJSONObject(0).getJSONObject("payload").getString("history_mode"));
        assertEquals("lane", result.getJSONArray("events").getJSONObject(1).getJSONObject("payload").getJSONObject("rate_limits").getString("limit_id"));
        assertEquals(java.time.Instant.parse("2026-11-16T06:00:00Z").toEpochMilli(), result.getLong("maxTimestamp"));
    }
}
