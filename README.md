# STICKY

**A board your coding agent can write to — and you can see.**

Your agent forgets between sessions. The usual fix is a `CLAUDE.md` that grows until it's a
thousand lines of stale rules nobody deletes, quietly costing you tokens on every request.

STICKY holds **ten active notes**. When the eleventh arrives, the oldest one tumbles to the
archive on its own. Nothing to prune, nothing to garden.

```bash
npx @juvina/sticky
```

That's it. The board opens in your browser. No account, no cloud, no config.

---

## Wire it to your agent

```bash
claude mcp add sticky -- npx -y @juvina/sticky --mcp
```

Cursor, Cline, Windsurf and anything else that speaks MCP work the same way — point them at
`npx -y @juvina/sticky --mcp`.

Your agent gets two tools:

- **`post_sticky`** — pin a decision, a constraint, or where the work paused
- **`read_active_stickies`** — read the board at the start of a session

## The three columns

| | what it holds | reaches the agent |
|---|---|---|
| **Pinned** | permanent rules — *"use C# 12"*, *"never touch migrations by hand"* | always |
| **Active** | current decisions and where work stopped | always, newest 10 |
| **Archive** | whatever tumbled off | **never — zero tokens** |

Drag a note between columns. Drop it on **Pinned** and it becomes a permanent rule. Drop it on
**Archive** and it stops reaching the agent immediately. Double-click to edit, click the cross
to bin a bad assumption.

The board updates live as your agent posts — you watch it think.

## What's bounded, and what isn't

Being precise, because a promise that isn't quite true is worse than no promise:

- **Active is capped at 10** (configurable 5–20). The oldest unpinned note tumbles out.
- **Pinned is capped at 15.** Rules never tumble — a rule vanishing silently would be worse
  than the bloat — so instead the board refuses the sixteenth and asks you to retire one.
- **Archive is unbounded** and costs nothing, because it never reaches the model.

So the agent's context stays bounded at roughly 25 notes, permanently, no matter how long
you work.

## Your data

The board is a SQLite file at `~/.sticky/store.db`. The web server binds to `127.0.0.1` and
nothing else. There is no telemetry, no analytics, and no network code in this package beyond
the local server itself.

## Options

```
npx @juvina/sticky                 open the board
npx @juvina/sticky --mcp           run as an MCP server (agents launch this)

  --cap <n>      active notes before the oldest tumbles (default 10)
  --port <n>     board port (default 7317)
  --db <path>    where the board lives (default ~/.sticky/store.db)
  --no-open      start without opening a browser
```

Want it floating beside your editor? `chrome --app=http://localhost:7317`

## Requires

Node 22.5 or newer — STICKY uses Node's built-in SQLite, so there's nothing to compile and
no native modules to install.

---

MIT licensed. Built by [Juvina](https://juvina.ai).
