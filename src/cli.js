#!/usr/bin/env node
// STICKY — one entry point, two modes.
//
//   npx sticky-mcp          opens the board in your browser
//   npx sticky-mcp --mcp    runs as an MCP server over stdio (what agents launch)
//
// The same SQLite file backs both, so a card the agent posts appears on the board
// immediately and a card you drag is what the agent reads next.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "./store.js";
import { serve } from "./mcp.js";
import { startServer, DEFAULT_PORT } from "./server.js";

const args = process.argv.slice(2);

// MCP mode is reached three ways, and the reason is not tidiness.
//
// `claude mcp add sticky -- npx sticky-mcp --mcp` FAILS: Claude Code's own CLI scans the
// whole line and claims --mcp (and -y) as its own flags before npx ever sees them. Other
// hosts will do the same with other words. So the shipped instruction uses a BARE COMMAND
// with no flags at all — `sticky-mcp-server` — which nothing can misparse.
//   sticky-mcp-server      the bin every agent host should launch
//   sticky-mcp serve       a subcommand, for hosts that pass a positional through
//   sticky-mcp --mcp       still works when you control the shell
const mcpMode =
  args.includes("--mcp") ||
  args[0] === "serve" ||
  process.env.STICKY_MCP === "1" ||
  /sticky-mcp-server(\.js)?$/.test(process.argv[1] ?? "");
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
STICKY — a visual board your coding agent can write to.

  npx sticky-mcp                 open the board
  npx sticky-mcp-server          run as an MCP server (this is what agents launch)

  --cap <n>      how many active notes before the oldest tumbles (default 10)
  --port <n>     board port (default ${DEFAULT_PORT})
  --db <path>    where the board lives (default ~/.sticky/store.db)
  --no-open      start the server without opening a browser

Wire it to Claude Code:
  claude mcp add sticky -- npx sticky-mcp-server
`);
  process.exit(0);
}

// Env vars as well as flags: agent hosts (Smithery, Claude Desktop, Cursor) configure a
// server through its environment, not its command line, and a flag they cannot pass is a
// setting they cannot change. Flags still win when both are given.
const db = flag("db", process.env.STICKY_DB || join(homedir(), ".sticky", "store.db"));
const cap = Number(flag("cap", process.env.STICKY_CAP || 10));
const store = new Store(db, cap);

if (mcpMode) {
  // stdio belongs to the protocol in this mode — anything written to stdout that is not
  // JSON-RPC corrupts the stream, so this mode stays silent.
  serve(store);
} else {
  const port = Number(flag("port", DEFAULT_PORT));
  const url = `http://localhost:${port}`;
  const server = startServer(store, port);

  // Nothing is announced until the socket is actually bound — a success line followed by
  // a crash is worse than a plain failure.
  server.on("listening", () => {
    const n = store.list("active").length;
    console.log(`\n  STICKY is open at ${url}`);
    console.log(`  ${n}/${cap} active notes. Leave this running; Ctrl+C stops it.\n`);

    // This line read as a command the user still had to run, so people ran it and wondered
    // why nothing had waited for them. It is optional, it is one-off, and it says so now.
    console.log(`  To let your agent write to the board (one time, in another terminal):`);
    console.log(`    claude mcp add sticky -- npx sticky-mcp-server\n`);

    if (!args.includes("--no-open")) {
      const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
    }
  });
}
