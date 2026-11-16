import test from "node:test";
import assert from "node:assert/strict";
import {
  changeMcp,
  mcpServers,
  parseMcpImport,
  skillMetadata,
  parseSessionIndex,
  parseSession,
  aggregateUsage,
  type SessionData,
} from "../src/core/workspace.ts";
import { parseConfig } from "../src/core/tomlPatch.ts";
const data = (
  events: any[],
  extra: Partial<SessionData> = {},
): SessionData => ({
  path: "sessions/log.jsonl",
  events,
  truncated: false,
  invalidLines: 0,
  bytesRead: 100,
  ...extra,
});
const meta = (id: string, extra = {}) => ({
  type: "session_meta",
  payload: { id, cwd: "/home/codex", ...extra },
});
const count = (input: number, output: number) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      },
    },
  },
});
test("MCP edits preserve builtin servers, model, project trust and comments", () => {
  const before =
    '# keep this comment\nmodel="my-model"\n[mcp_servers.builtin]\ncommand="/host/mcp"\nargs=["--internal"]\n[mcp_servers.user]\nurl="https://example.invalid/mcp"\n[projects."/work"]\ntrust_level="trusted"\n';
  const after = changeMcp(before, "user", {
    url: "https://second.invalid/mcp",
    enabled: false,
    http_headers: { "X-Custom": "dummy" },
  });
  assert.deepEqual(
    parseConfig(after).mcp_servers.builtin,
    parseConfig(before).mcp_servers.builtin,
  );
  assert.deepEqual(parseConfig(after).projects, parseConfig(before).projects);
  assert.equal(parseConfig(after).model, "my-model");
  assert.ok(after.startsWith("# keep this comment"));
  assert.equal(mcpServers(after).length, 2);
});
test("MCP dotted and inline forms retain all unrelated members", () => {
  for (const before of [
    'model="keep"\nmcp_servers={builtin={command="keep"},user={command="old"}}\n',
    'mcp_servers.builtin.command="keep"\nmcp_servers.user.command="old"\n',
  ]) {
    const after = changeMcp(before, "user", { command: "new", args: ["a"] });
    assert.equal(parseConfig(after).mcp_servers.builtin.command, "keep");
    assert.equal(parseConfig(after).mcp_servers.user.command, "new");
  }
});
test("MCP delete removes only the selected service including nested env", () => {
  const before =
    '[mcp_servers.one]\ncommand="one"\n[mcp_servers.one.env]\nTOKEN="dummy"\n[mcp_servers.two]\ncommand="two"\n';
  const after = changeMcp(before, "one", undefined);
  assert.deepEqual(Object.keys(parseConfig(after).mcp_servers), ["two"]);
});
test("MCP malformed input and incompatible transport do not produce a write plan", () => {
  assert.throws(() => changeMcp('model = "broken', "user", { command: "ok" }));
  assert.throws(() =>
    changeMcp("", "user", { command: "x", url: "https://example.invalid" }),
  );
  assert.throws(() => changeMcp("", "user", { url: "file:///private" }));
  assert.throws(() => changeMcp("", "user", { command: "x", env: { N: 42 } }));
  assert.throws(() => changeMcp("", "x\ny", { command: "x" }));
});
test("upstream MCP headers migrate to Codex http_headers without losing extra fields", () => {
  const [name, value] = parseMcpImport(
    '{"mcpServers":{"demo":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"dummy"},"startup_timeout_sec":15}}}',
  )[0];
  assert.equal(name, "demo");
  assert.equal(value.http_headers.Authorization, "dummy");
  assert.equal(value.startup_timeout_sec, 15);
  assert.equal(value.type, undefined);
  assert.throws(() => parseMcpImport('{"mcpServers":{"bad":false}}'));
});
test("SKILL frontmatter supports multiline description, rejects missing and malformed metadata", () => {
  assert.deepEqual(
    skillMetadata(
      "---\nname: demo\ndescription: >-\n  Useful\n  description\n---\nBody",
    ),
    { name: "demo", description: "Useful description" },
  );
  assert.throws(() => skillMetadata("# skill without frontmatter"));
  assert.throws(() => skillMetadata("---\nname: demo\n---\nBody"));
  assert.throws(() =>
    skillMetadata("---\nname: [broken\ndescription: test\n---\n"),
  );
});
test("session index ignores incomplete lines and retains the newest title", () => {
  const index = parseSessionIndex(
    '{"id":"abc","thread_name":"old"}\nmalformed\n{"id":"abc","thread_name":"new"}\n',
  );
  assert.equal(index.abc, "new");
});
test("usage repeated cumulative snapshots and archived duplicate logs are not summed", () => {
  const a = parseSession(
    data([meta("same"), count(100, 20), count(100, 20), count(200, 30)]),
  );
  const b = parseSession(
    data([meta("same"), count(100, 20)], {
      path: "archived_sessions/copy.jsonl",
    }),
  );
  assert.equal(a.usage.total, 230);
  assert.equal(aggregateUsage([a, b]).usage.total, 230);
  assert.equal(aggregateUsage([a, b]).counted, 1);
});
test("response usage and cumulative snapshots are not double counted", () => {
  const events = [
    meta("one"),
    {
      type: "token_usage_record",
      payload: {
        response_id: "r1",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
    count(100, 20),
  ];
  assert.equal(parseSession(data(events)).usage.total, 120);
  const recordOnly = events.slice(0, 2);
  recordOnly.push(recordOnly[1]);
  assert.equal(parseSession(data(recordOnly)).usage.total, 120);
});
test("latest per-turn total is used if only turn records exist", () => {
  const a = parseSession(
    data([
      meta("one"),
      {
        type: "token_usage_record",
        payload: {
          turn_id: "t",
          turn_token_usage: { input_tokens: 30, output_tokens: 5 },
        },
      },
      {
        type: "token_usage_record",
        payload: {
          turn_id: "t",
          turn_token_usage: { input_tokens: 80, output_tokens: 10 },
        },
      },
    ]),
  );
  assert.equal(a.usage.total, 90);
});
test("fork and spawned child metadata are excluded from aggregates; first metadata stays authoritative", () => {
  const normal = parseSession(data([meta("root"), count(100, 10)]));
  const fork = parseSession(
    data([
      meta("fork", { forked_from_id: "root" }),
      meta("historical-parent"),
      count(100, 10),
    ]),
  );
  const child = parseSession(
    data([
      meta("child", {
        source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
      }),
      count(150, 15),
    ]),
  );
  assert.equal(fork.id, "fork");
  const total = aggregateUsage([normal, fork, child]);
  assert.equal(total.excludedForks, 2);
  assert.equal(total.usage.total, 110);
});
test("session message mirrors do not duplicate text; malformed and bounded reads are marked partial", () => {
  const events = [
    meta("root"),
    { type: "event_msg", payload: { type: "user_message", message: "Hi" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "Hi" }] },
    },
  ];
  assert.deepEqual(parseSession(data(events)).messages, [
    { role: "user", text: "Hi" },
  ]);
  assert.equal(parseSession(data(events, { invalidLines: 1 })).partial, true);
  assert.equal(parseSession(data(events, { truncated: true })).partial, true);
  assert.equal(
    parseSession(data([count(100, 20), count(30, 10)])).partial,
    true,
  );
});
