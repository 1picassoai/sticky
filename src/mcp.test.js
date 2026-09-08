// Proves the agent-facing half: handshake, tool discovery, and that a constraint lands
// on the pinned column without the agent needing to know columns exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { createHandler } from "./mcp.js";

const fresh = (cap = 10) => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sticky-mcp-")), "t.db"), cap);
  return { store, call: createHandler(store) };
};
const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });

test("initialize returns a valid MCP handshake", () => {
  const { store, call } = fresh();
  const r = call(rpc("initialize"));
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.equal(r.result.serverInfo.name, "sticky");
  store.close();
});

test("exposes exactly two tools — no Swiss knife", () => {
  const { store, call } = fresh();
  const names = call(rpc("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["post_sticky", "read_active_stickies"]);
  store.close();
});

test("a constraint lands on the pinned column automatically", () => {
  const { store, call } = fresh();
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "use C# 12", type: "constraint" } }));
  assert.equal(store.list("pinned").length, 1, "the agent never has to name a column");
  assert.equal(store.list("active").length, 0);
  store.close();
});

test("the agent is told when a card tumbled", () => {
  const { store, call } = fresh(2);
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "one" } }));
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "two" } }));
  const r = call(rpc("tools/call", { name: "post_sticky", arguments: { content: "three" } }));
  assert.match(r.result.content[0].text, /tumbled to the archive/);
  assert.equal(store.list("active").length, 2);
  store.close();
});

test("reading the board excludes the archive", () => {
  const { store, call } = fresh(2);
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "rule", type: "constraint" } }));
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "a" } }));
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "b" } }));
  call(rpc("tools/call", { name: "post_sticky", arguments: { content: "c" } })); // a tumbles

  const text = call(rpc("tools/call", { name: "read_active_stickies" })).result.content[0].text;
  assert.match(text, /RULES \(always apply\)/);
  assert.match(text, /- rule/);
  assert.ok(!text.includes("- a"), "archived notes must never reach the prompt");
  store.close();
});

test("empty board and bad tool names fail gracefully", () => {
  const { store, call } = fresh();
  assert.match(call(rpc("tools/call", { name: "read_active_stickies" })).result.content[0].text, /empty/);
  assert.equal(call(rpc("tools/call", { name: "nope" })).error.code, -32602);
  assert.equal(call(rpc("post_sticky")).error.code, -32601);
  const bad = call(rpc("tools/call", { name: "post_sticky", arguments: { content: "  " } }));
  assert.ok(bad.result.isError, "empty content is refused, not crashed on");
  store.close();
});

test("notifications get no reply", () => {
  const { store, call } = fresh();
  assert.equal(call(rpc("notifications/initialized")), null);
  store.close();
});
