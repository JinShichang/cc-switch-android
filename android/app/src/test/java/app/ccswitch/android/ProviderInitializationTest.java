package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ProviderInitializationTest {
    private JSONObject row(String id) throws Exception {
        return new JSONObject().put("id", id).put("name", id)
            .put("settingsConfig", new JSONObject().put("auth", new JSONObject()).put("config", ""));
    }
    private JSONObject args(JSONArray expected, JSONArray additions, String imported) throws Exception {
        return new JSONObject().put("expectedProviderIds", expected).put("additions", additions).put("importedId", imported);
    }
    @Test public void emptyVaultImportsThenSeedsAndPreservesSettings() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray()).put("settings", new JSONObject().put("zoom", 100));
        JSONObject next = ProviderInitialization.initialize(original, args(new JSONArray(), new JSONArray().put(row("default")).put(row("codex-official")), "default"));
        assertEquals(0, original.getJSONArray("providers").length());
        assertEquals(2, next.getJSONArray("providers").length());
        assertEquals("default", next.getJSONArray("providers").getJSONObject(0).getString("id"));
        assertEquals(1, next.getInt("providerInitialization"));
        assertEquals(100, next.getJSONObject("settings").getInt("zoom"));
    }
    @Test public void upgradeSeedsOfficialWithoutDuplicatingCurrent() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray().put(row("mine")));
        JSONObject next = ProviderInitialization.initialize(original, args(new JSONArray().put("mine"), new JSONArray().put(row("codex-official")), ""));
        assertEquals("mine", next.getJSONArray("providers").getJSONObject(0).getString("id"));
        assertEquals(2, next.getJSONArray("providers").length());
    }
    @Test public void deletedRowsStayDeletedAfterInitialization() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray()).put("providerInitialization", 1);
        JSONObject next = ProviderInitialization.initialize(original, new JSONObject());
        assertEquals(0, next.getJSONArray("providers").length());
    }
    @Test public void changedProviderListRefusesInitialization() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray().put(row("mine")));
        try {
            ProviderInitialization.initialize(original, args(new JSONArray(), new JSONArray().put(row("codex-official")), ""));
            fail("Expected list conflict");
        } catch (IllegalStateException expected) { assertEquals(1, original.getJSONArray("providers").length()); }
    }
    @Test public void existingRowsRefuseDefaultOverwrite() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray().put(row("mine")));
        try {
            ProviderInitialization.initialize(original, args(new JSONArray().put("mine"), new JSONArray().put(row("default")).put(row("codex-official")), "default"));
            fail("Expected refusal");
        } catch (IllegalArgumentException expected) { assertEquals(1, original.getJSONArray("providers").length()); }
    }
    @Test public void missingLiveFileCanStillSeedOfficial() throws Exception {
        JSONObject original = new JSONObject().put("providers", new JSONArray());
        JSONObject next = ProviderInitialization.initialize(original, args(new JSONArray(), new JSONArray().put(row("codex-official")), ""));
        assertEquals(1, next.getJSONArray("providers").length());
        assertEquals("codex-official", next.getJSONArray("providers").getJSONObject(0).getString("id"));
    }
}
