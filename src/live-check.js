// Blocker #1, verified the way it actually fails: a browser holding an SSE stream, and a
// SEPARATE process writing to the same database. A unit test cannot prove this — the fault
// was that two processes never spoke to each other.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { startServer } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "sticky-live-"));
const db = join(dir, "board.db");
const PORT = 7393;

const webStore = new Store(db);              // the board's connection
const server = startServer(webStore, PORT);
await new Promise((r) => server.on("listening", r));

// Stand in for the open browser tab.
const res = await fetch(`http://localhost:${PORT}/api/events`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let frames = 0;
let lastBoard = null;

(async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (line.startsWith("data: ")) {
        frames++;
        lastBoard = JSON.parse(line.slice(6));
      }
    }
  }
})().catch(() => {});

await new Promise((r) => setTimeout(r, 400));
const before = frames;

// The agent: a DIFFERENT connection, exactly as the --mcp process would be.
const agentStore = new Store(db);
agentStore.post({ content: "posted by a separate agent process", type: "decision" });
agentStore.close();

// The poll runs every 400ms; give it room without being generous enough to hide a fault.
await new Promise((r) => setTimeout(r, 1500));

const moved = frames > before;
console.log(`  frames before agent wrote : ${before}`);
console.log(`  frames after  agent wrote : ${frames}`);
console.log(`  board now shows           : ${lastBoard?.active?.length ?? 0} active card(s)`);
console.log(
  moved && lastBoard?.active?.length === 1
    ? "\nPASS — the board updated itself from another process's write."
    : "\nFAIL — the board is still stale."
);

await reader.cancel().catch(() => {});
server.close();
webStore.close();
rmSync(dir, { recursive: true, force: true });
process.exit(moved && lastBoard?.active?.length === 1 ? 0 : 1);
