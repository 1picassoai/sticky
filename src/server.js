// STICKY — the local web server behind the board.
//
// No framework. Node's own http module, a handful of JSON routes, and Server-Sent Events
// so the board updates the instant the agent posts a card. Nothing leaves the machine:
// the server binds to loopback only and refuses to do otherwise.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

export function startServer(store, port = 4317) {
  const clients = new Set();

  // Every mutation, whoever made it, pushes the whole board to every open tab. The board
  // is small by design, so sending it entire is simpler and cheaper than diffing.
  const broadcast = () => {
    const payload = `data: ${JSON.stringify(board(store))}\n\n`;
    for (const res of clients) res.write(payload);
  };
  store.onChange = broadcast;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (url.pathname === "/api/board" && req.method === "GET") return json(200, board(store));

      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(board(store))}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      if (url.pathname === "/api/cards" && req.method === "POST") {
        const body = await readBody(req);
        const { card } = store.post({ ...body, origin: "user" });
        broadcast();
        return json(201, card);
      }

      const cardMatch = url.pathname.match(/^\/api\/cards\/(\d+)$/);
      if (cardMatch) {
        const id = Number(cardMatch[1]);
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const card = body.column ? store.move(id, body.column) : store.edit(id, body);
          if (!card) return json(404, { error: "no such card" });
          broadcast();
          return json(200, card);
        }
        if (req.method === "DELETE") {
          const gone = store.remove(id);
          broadcast();
          return json(gone ? 200 : 404, { deleted: gone });
        }
      }

      if (url.pathname === "/api/archive" && req.method === "DELETE") {
        const n = store.purgeArchive();
        broadcast();
        return json(200, { purged: n });
      }

      if (url.pathname === "/api/export" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/markdown",
          "content-disposition": 'attachment; filename="STICKY.md"',
        });
        return res.end(exportMarkdown(store));
      }

      // Static files. Path is confined to /public — a local server is still a server.
      const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const full = join(PUBLIC, file);
      if (!full.startsWith(PUBLIC)) return json(403, { error: "no" });
      const data = await readFile(full);
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
      res.end(data);
    } catch (e) {
      if (e.code === "ENOENT") return json(404, { error: "not found" });
      json(500, { error: e.message });
    }
  });

  // Loopback only. Never 0.0.0.0 — the board is nobody else's business.
  server.listen(port, "127.0.0.1");
  return server;
}

function board(store) {
  return {
    pinned: store.list("pinned"),
    active: store.list("active"),
    archive: store.list("archive"),
    cap: store.activeCap,
    tokens: store.activeTokens(),
  };
}

function exportMarkdown(store) {
  const fmt = (c) => `- ${c.title ? `**${c.title}** — ` : ""}${c.content}`;
  const pinned = store.list("pinned");
  const active = store.list("active");
  return [
    "# Project rules and context",
    "",
    pinned.length ? "## Rules (always apply)\n" + pinned.map(fmt).join("\n") : "",
    active.length ? "\n## Current context\n" + active.map(fmt).join("\n") : "",
    "",
    "_Exported from STICKY._",
  ]
    .filter(Boolean)
    .join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
  });
}
