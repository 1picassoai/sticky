// Proves the one rule the product is built on: active never exceeds the cap, the OLDEST
// UNPINNED card is what leaves, and pinned cards never tumble no matter what arrives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";

const fresh = (cap = 10) => new Store(join(mkdtempSync(join(tmpdir(), "sticky-")), "t.db"), cap);

test("posts a card and reads it back", () => {
  const s = fresh();
  const { card } = s.post({ content: "use C# 12", type: "constraint" });
  assert.equal(card.content, "use C# 12");
  assert.equal(card.column, "active");
  assert.equal(s.list("active").length, 1);
  s.close();
});

test("the cap holds and the OLDEST card tumbles", () => {
  const s = fresh(10);
  for (let i = 1; i <= 10; i++) s.post({ content: `note ${i}` });
  assert.equal(s.list("active").length, 10);
  assert.equal(s.list("archive").length, 0);

  const { tumbled } = s.post({ content: "note 11" });
  assert.equal(s.list("active").length, 10, "active must never exceed the cap");
  assert.equal(tumbled.content, "note 1", "the OLDEST card is the one that leaves");
  assert.equal(s.list("archive").length, 1);
  assert.equal(s.list("active")[0].content, "note 2");
  s.close();
});

test("pinned cards never tumble, and pinned has its own cap", () => {
  const s = fresh(3);
  for (let i = 1; i <= 5; i++) s.post({ content: `rule ${i}`, column: "pinned" });
  assert.equal(s.list("pinned").length, 5);

  // Active churn must never cost a rule — that is the promise pinning makes.
  for (let i = 1; i <= 10; i++) s.post({ content: `note ${i}` });
  assert.equal(s.list("pinned").length, 5, "no rule is lost to active overflow");
  assert.equal(s.list("active").length, 3);

  // But pinned is NOT unbounded. It refuses past its own cap rather than dropping a rule,
  // because an uncapped pinned column would grow the prompt forever — the exact failure
  // this product exists to prevent.
  assert.equal(s.pinnedCap, 15);
  for (let i = 6; i <= 15; i++) s.post({ content: `rule ${i}`, column: "pinned" });
  assert.equal(s.list("pinned").length, 15, "fills to the cap");
  assert.throws(() => s.post({ content: "rule 16", column: "pinned" }), /pinned column is full/);
  assert.equal(s.list("pinned").length, 15, "and refuses without losing one");
  s.close();
});

test("dragging to pinned converts the card to a permanent rule", () => {
  const s = fresh();
  const { card } = s.post({ content: "never commit .env", type: "state" });
  const moved = s.move(card.id, "pinned");
  assert.equal(moved.column, "pinned");
  assert.equal(moved.type, "constraint", "pinning makes it a constraint");
  s.close();
});

test("the agent sees pinned + active, never the archive", () => {
  const s = fresh(2);
  s.post({ content: "rule", column: "pinned" });
  s.post({ content: "a" });
  s.post({ content: "b" });
  s.post({ content: "c" }); // tumbles "a"

  const ctx = s.activeContext();
  assert.equal(ctx.length, 3, "one pinned + two active");
  assert.ok(!ctx.some((c) => c.content === "a"), "archived cards cost zero tokens");
  assert.equal(ctx[0].column, "pinned", "pinned rules come first");
  s.close();
});

test("moving a card back to active can tumble another", () => {
  const s = fresh(2);
  s.post({ content: "a" });
  s.post({ content: "b" });
  const { card } = s.post({ content: "c" }); // a tumbles
  s.move(card.id, "archive");
  const restored = s.list("archive").find((c) => c.content === "a");
  s.move(restored.id, "active");
  assert.equal(s.list("active").length, 2, "restoring respects the cap too");
  s.close();
});

test("edit, delete and purge behave", () => {
  const s = fresh();
  const { card } = s.post({ content: "typo" });
  assert.equal(s.edit(card.id, { content: "fixed" }).content, "fixed");
  s.post({ content: "old", column: "archive" });
  assert.equal(s.purgeArchive(), 1);
  assert.ok(s.remove(card.id));
  assert.equal(s.list().length, 0);
  s.close();
});

test("rejects empty content and unknown columns", () => {
  const s = fresh();
  assert.throws(() => s.post({ content: "   " }), /content is required/);
  assert.throws(() => s.post({ content: "x", column: "nowhere" }), /unknown column/);
  s.close();
});
