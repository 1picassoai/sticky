#!/usr/bin/env node
// A bare command with no flags, for agent hosts to launch.
//
// `claude mcp add sticky -- npx sticky-mcp --mcp` does not work: Claude Code's CLI scans the
// whole line and claims --mcp (and -y) as its own before npx sees them. Other hosts do the
// same with other words. A command with nothing after it cannot be misparsed by anyone.
//
//   claude mcp add sticky -- npx sticky-mcp-server

process.env.STICKY_MCP = "1";
await import("./cli.js");
