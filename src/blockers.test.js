// Regression tests for the three blockers Galahad found on 8 Sep. Each one names the
// fault it exists to stop coming back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { createHandler } from "./mcp.js";
import { startServer, DEFAULT_PORT } from "./server.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "sticky-b-")), "t.db");

// ---- BLOCKER 1: the board went stale when the AGENT posted, because the MCP server is a
// separate process and never called broadcast(). Fixed by watching SQLite's data_version.
test("blocker 1: a write from another connection is detectable", () => {
  const path = tmp();
  const board = new Store(path);       // stands in for the web server
  const agent = new Store(path);       // stands in for the --mcp process

  const before = board.dataVersion();
  agent.post({ content: "posted by the agent process" });
  const after = board.dataVersion();

  assert.notEqual(after, before, "the board must be able to see another process's write");
  assert.equal(board.list("active").length, 1, "and read it back");
  board.close();
  agent.close();
});

test("blocker 1: data_version is stable when nothing external happens", () => {
  const path = tmp();
  const board = new Store(path);
  const v = board.dataVersion();
  board.list("active");
  assert.equal(board.dataVersion(), v, "polling must not fire on reads");
  board.close();
});

// ---- BLOCKER 2: the default port was OpenTelemetry's reserved OTLP port, and a busy port
// crashed with a raw stacktrace AFTER printing a success line.
test("blocker 2: the default port is not OTLP's reserved 4317/4318", () => {
  assert.notEqual(DEFAULT_PORT, 4317);
  assert.notEqual(DEFAULT_PORT, 4318);
});

test("blocker 2: a busy port reports cleanly instead of throwing", async () => {
  const store = new Store(tmp());
  const first = startServer(store, 7391);
  await new Promise((r) => first.on("listening", r));

  // The second server must handle EADDRINUSE through its own error handler, not crash the
  // process with an unhandled 'error' event.
  const errs = [];
  const origError = console.error;
  const origExit = process.exit;
  console.error = (m) => errs.push(String(m));
  process.exit = () => {};

  const second = startServer(new Store(tmp()), 7391);
  await new Promise((r) => setTimeout(r, 300));

  console.error = origError;
  process.exit = origExit;
  first.close();
  second.close();
  store.close();

  assert.ok(errs.some((e) => /already in use/.test(e)), "the user is told plainly, with a fix");
});

// ---- BLOCKER 3: "your context never bloats" was false — the pinned column was unbounded
// and fully injected, so an agent posting constraints grew the prompt forever.
test("blocker 3: pinned is capped, and the refusal explains itself", () => {
  const s = new Store(tmp(), 10, 3);
  for (let i = 1; i <= 3; i++) s.post({ content: `rule ${i}`, column: "pinned" });

  assert.throws(
    () => s.post({ content: "rule 4", column: "pinned" }),
    /pinned column is full/,
    "the cap refuses rather than silently dropping a rule"
  );
  assert.equal(s.list("pinned").length, 3, "and no rule was lost in the attempt");
  s.close();
});

test("blocker 3: dragging is not a back door around the pinned cap", () => {
  const s = new Store(tmp(), 10, 2);
  s.post({ content: "rule 1", column: "pinned" });
  s.post({ content: "rule 2", column: "pinned" });
  const { card } = s.post({ content: "a note" });

  assert.throws(() => s.move(card.id, "pinned"), /pinned column is full/);
  assert.equal(s.list("pinned").length, 2);
  s.close();
});

test("blocker 3: the agent is told why, not just refused", () => {
  const store = new Store(tmp(), 10, 1);
  const call = createHandler(store);
  const rpc = (args) => call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_sticky", arguments: args } });

  rpc({ content: "first rule", type: "constraint" });
  const r = rpc({ content: "second rule", type: "constraint" });

  assert.ok(r.result.isError, "refused");
  assert.match(r.result.content[0].text, /pinned column is full/, "and the agent can act on the reason");
  store.close();
});

test("the whole context stays bounded even under a constraint flood", () => {
  const s = new Store(tmp(), 10, 15);
  for (let i = 0; i < 200; i++) {
    try { s.post({ content: `rule ${i}`, column: "pinned" }); } catch { /* expected once full */ }
    s.post({ content: `note ${i}` });
  }
  const ctx = s.activeContext();
  assert.ok(ctx.length <= 25, `context is bounded at ${ctx.length}, not 400`);
  assert.equal(s.list("pinned").length, 15);
  assert.equal(s.list("active").length, 10);
  s.close();
});
