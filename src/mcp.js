// STICKY — the MCP server. Speaks JSON-RPC over stdio, which is what every agent host
// (Claude Code, Claude Desktop, Cursor, Cline, Windsurf) already knows how to launch.
//
// Two tools, deliberately. post_sticky and read_active_stickies. A third would be the
// start of a Swiss knife.

import { Store } from "./store.js";

const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "post_sticky",
    description:
      "Pin a note to the STICKY board so it survives this session. Use it for a decision " +
      "you just made, a constraint you must not break, or where the work paused. The board " +
      "keeps only the newest few active notes: older ones tumble to the archive on their own, " +
      "so post freely and never worry about clutter.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "the note itself, one thought, kept short" },
        title: { type: "string", description: "optional short heading" },
        type: {
          type: "string",
          enum: ["constraint", "decision", "state", "manual"],
          description:
            "constraint = a permanent rule (goes to the pinned column) · decision = a choice made · state = where work paused",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "read_active_stickies",
    description:
      "Read the board: the permanent pinned rules plus the active notes. The archive is " +
      "never included, so this stays small. Call it at the start of a session to find out " +
      "what was decided before you arrived.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function createHandler(store) {
  return function handle(req) {
    const { id, method, params } = req;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "sticky", version: "0.1.0" },
          instructions:
            "A visual board for what must not be forgotten. Post decisions and constraints " +
            "as you make them; read the board when you need to know what was already decided.",
        });

      case "notifications/initialized":
        return null; // notification, no reply

      case "tools/list":
        return ok({ tools: TOOLS });

      case "tools/call": {
        const { name, arguments: args = {} } = params ?? {};

        if (name === "post_sticky") {
          try {
            // A constraint IS a permanent rule, so it belongs on the pinned column. The
            // agent should not have to know about columns to do the right thing.
            const column = args.type === "constraint" ? "pinned" : "active";
            const { card, tumbled } = store.post({ ...args, column, origin: "agent" });
            const note = tumbled
              ? ` (the board was full, so "${tumbled.content.slice(0, 40)}..." tumbled to the archive)`
              : "";
            return ok({
              content: [
                {
                  type: "text",
                  text: `Posted to the ${card.column} column${note}. ${store.list("active").length}/${store.activeCap} active.`,
                },
              ],
            });
          } catch (e) {
            return ok({ content: [{ type: "text", text: `Could not post: ${e.message}` }], isError: true });
          }
        }

        if (name === "read_active_stickies") {
          const cards = store.activeContext();
          if (cards.length === 0) {
            return ok({ content: [{ type: "text", text: "The board is empty." }] });
          }
          const pinned = cards.filter((c) => c.column === "pinned");
          const active = cards.filter((c) => c.column === "active");
          const fmt = (c) => `- ${c.title ? c.title + ": " : ""}${c.content}`;
          const text = [
            pinned.length ? `RULES (always apply):\n${pinned.map(fmt).join("\n")}` : "",
            active.length ? `ACTIVE CONTEXT:\n${active.map(fmt).join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          return ok({ content: [{ type: "text", text }] });
        }

        return err(-32602, `unknown tool: ${name}`);
      }

      default:
        return err(-32601, `unknown method: ${method}`);
    }
  };
}

/** Wire stdin/stdout as newline-delimited JSON-RPC. */
export function serve(store = new Store()) {
  const handle = createHandler(store);
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let reply;
      try {
        reply = handle(JSON.parse(line));
      } catch {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
      }
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    }
  });
}
