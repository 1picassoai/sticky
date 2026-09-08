#!/usr/bin/env node
// STICKY — one entry point, two modes.
//
//   npx @juvina/sticky          opens the board in your browser
//   npx @juvina/sticky --mcp    runs as an MCP server over stdio (what agents launch)
//
// The same SQLite file backs both, so a card the agent posts appears on the board
// immediately and a card you drag is what the agent reads next.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "./store.js";
import { serve } from "./mcp.js";
import { startServer } from "./server.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
STICKY — a visual board your coding agent can write to.

  npx @juvina/sticky                 open the board
  npx @juvina/sticky --mcp           run as an MCP server (agents launch this)

  --cap <n>      how many active notes before the oldest tumbles (default 10)
  --port <n>     board port (default 4317)
  --db <path>    where the board lives (default ~/.sticky/store.db)
  --no-open      start the server without opening a browser

Wire it to Claude Code:
  claude mcp add sticky -- npx -y @juvina/sticky --mcp
`);
  process.exit(0);
}

const db = flag("db", join(homedir(), ".sticky", "store.db"));
const cap = Number(flag("cap", 10));
const store = new Store(db, cap);

if (args.includes("--mcp")) {
  // stdio belongs to the protocol in this mode — anything written to stdout that is not
  // JSON-RPC corrupts the stream, so this mode stays silent.
  serve(store);
} else {
  const port = Number(flag("port", 4317));
  const url = `http://localhost:${port}`;
  startServer(store, port);
  console.log(`STICKY is on ${url}   (${store.list("active").length}/${cap} active)`);
  console.log(`Agent:  claude mcp add sticky -- npx -y @juvina/sticky --mcp`);

  if (!args.includes("--no-open")) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
  }
}
