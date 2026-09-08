// STICKY — the persistence core.
//
// Three columns: pinned (no cap), active (hard cap, default 10), archive (cold).
// The whole point of the product lives in one rule: when active overflows, the OLDEST
// unpinned card tumbles to archive. Nothing grows forever. That is what every CLAUDE.md
// gets wrong.
//
// SQLite via node:sqlite — in the Node runtime since 22, so no native build step and no
// better-sqlite3 compile. A nail cutter should not need a C++ toolchain to install.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const COLUMNS = ["pinned", "active", "archive"];
export const TYPES = ["constraint", "decision", "state", "manual"];

export class Store {
  /**
   * @param pinnedCap Pinned rules are permanent, but "permanent" cannot mean "unbounded" —
   *   an agent posting constraints is doing the natural thing, and an uncapped pinned column
   *   grows the prompt forever, which is the exact failure this product exists to prevent.
   *   Pinned does not TUMBLE (a rule silently vanishing would be worse), so instead the cap
   *   REFUSES the write and tells the agent to retire one first. A hard limit the human can
   *   see beats a soft one nobody notices.
   */
  constructor(dbPath = join(homedir(), ".sticky", "store.db"), activeCap = 10, pinnedCap = 15) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.activeCap = activeCap;
    this.pinnedCap = pinnedCap;
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        title     TEXT NOT NULL DEFAULT '',
        content   TEXT NOT NULL,
        type      TEXT NOT NULL DEFAULT 'state',
        column    TEXT NOT NULL DEFAULT 'active',
        origin    TEXT NOT NULL DEFAULT 'agent',
        position  INTEGER NOT NULL DEFAULT 0,
        created   INTEGER NOT NULL,
        updated   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_column ON cards(column, position);
    `);
  }

  /**
   * Add a card. Returns { card, tumbled } — tumbled is the card pushed to archive by
   * this one arriving, or null. The caller decides whether to tell anyone; the store
   * just enforces the cap.
   */
  post({ title = "", content, type = "state", column = "active", origin = "agent" }) {
    if (!content || !content.trim()) throw new Error("content is required");
    if (!COLUMNS.includes(column)) throw new Error(`unknown column: ${column}`);
    if (!TYPES.includes(type)) throw new Error(`unknown type: ${type}`);

    if (column === "pinned" && this.list("pinned").length >= this.pinnedCap) {
      throw new Error(
        `the pinned column is full (${this.pinnedCap} rules) — archive one before adding another`
      );
    }

    const now = Date.now();
    const nextPos =
      (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM cards WHERE column = ?`)
        .get(column)?.p) ?? 1;

    const info = this.db
      .prepare(
        `INSERT INTO cards (title, content, type, column, origin, position, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, content.trim(), type, column, origin, nextPos, now, now);

    const card = this.get(Number(info.lastInsertRowid));
    const tumbled = column === "active" ? this.#enforceCap() : null;
    return { card, tumbled };
  }

  /** The auto-tumble. Oldest unpinned card in active goes cold when the cap is exceeded. */
  #enforceCap() {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE column = 'active'`).get().n;
    if (count <= this.activeCap) return null;

    const oldest = this.db
      .prepare(`SELECT * FROM cards WHERE column = 'active' ORDER BY position ASC LIMIT 1`)
      .get();
    if (!oldest) return null;

    this.move(oldest.id, "archive");
    return this.get(oldest.id);
  }

  get(id) {
    return this.db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id) ?? null;
  }

  list(column) {
    return column
      ? this.db.prepare(`SELECT * FROM cards WHERE column = ? ORDER BY position ASC`).all(column)
      : this.db.prepare(`SELECT * FROM cards ORDER BY column, position ASC`).all();
  }

  /**
   * What the agent actually sees: pinned + active only. The archive costs zero tokens,
   * which is the entire reason it exists.
   */
  activeContext() {
    return this.db
      .prepare(
        `SELECT id, title, content, type, column FROM cards
         WHERE column IN ('pinned', 'active')
         ORDER BY CASE column WHEN 'pinned' THEN 0 ELSE 1 END, position ASC`
      )
      .all();
  }

  move(id, column) {
    if (!COLUMNS.includes(column)) throw new Error(`unknown column: ${column}`);
    const card = this.get(id);
    if (!card) return null;

    // Dragging must not be a back door around the pinned cap.
    if (column === "pinned" && card.column !== "pinned" && this.list("pinned").length >= this.pinnedCap) {
      throw new Error(
        `the pinned column is full (${this.pinnedCap} rules) — archive one before adding another`
      );
    }

    const nextPos =
      (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM cards WHERE column = ?`)
        .get(column)?.p) ?? 1;

    // Dragging into pinned makes it a permanent rule — the spec's own behaviour.
    const type = column === "pinned" && card.type !== "constraint" ? "constraint" : card.type;

    this.db
      .prepare(`UPDATE cards SET column = ?, position = ?, type = ?, updated = ? WHERE id = ?`)
      .run(column, nextPos, type, Date.now(), id);

    const moved = this.get(id);
    if (column === "active") this.#enforceCap();
    return moved;
  }

  edit(id, { title, content, type }) {
    const card = this.get(id);
    if (!card) return null;
    this.db
      .prepare(`UPDATE cards SET title = ?, content = ?, type = ?, updated = ? WHERE id = ?`)
      .run(
        title ?? card.title,
        (content ?? card.content).trim(),
        type ?? card.type,
        Date.now(),
        id
      );
    return this.get(id);
  }

  remove(id) {
    return this.db.prepare(`DELETE FROM cards WHERE id = ?`).run(id).changes > 0;
  }

  purgeArchive() {
    return this.db.prepare(`DELETE FROM cards WHERE column = 'archive'`).run().changes;
  }

  /**
   * SQLite's own change counter. It only moves when a DIFFERENT connection commits, which
   * is exactly the case we care about: the agent process writing while the board is open.
   * Cheaper and more honest than watching the file, which lies about WAL and journal churn.
   */
  dataVersion() {
    return this.db.prepare("PRAGMA data_version").get().data_version;
  }

  /** Rough token estimate for the header badge. ~4 chars per token is close enough. */
  activeTokens() {
    const chars = this.activeContext().reduce(
      (n, c) => n + c.title.length + c.content.length + 8,
      0
    );
    return Math.ceil(chars / 4);
  }

  close() {
    this.db.close();
  }
}
