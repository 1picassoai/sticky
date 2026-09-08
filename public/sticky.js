// STICKY — the board. Vanilla, no build step, no framework.
// Every change goes to the server; the server pushes the board back over SSE. One source
// of truth, so the agent writing a card and you dragging one behave identically.

const $ = (id) => document.getElementById(id);
const cols = { pinned: $("col-pinned"), active: $("col-active"), archive: $("col-archive") };

let board = { pinned: [], active: [], archive: [], cap: 10, tokens: 0 };
let editing = null; // id of the card open in a textarea — never re-render over a live edit

// ---- talking to the server ----
const api = (path, opts) => fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...opts });
const patch = (id, body) => api(`/cards/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const del = (id) => api(`/cards/${id}`, { method: "DELETE" });
const create = (body) => api("/cards", { method: "POST", body: JSON.stringify(body) });

const events = new EventSource("/api/events");
events.onmessage = (e) => { board = JSON.parse(e.data); render(); };
events.onopen = () => setStatus(true);
events.onerror = () => setStatus(false);

function setStatus(live) {
  const el = $("status");
  el.querySelector(".dot").className = `dot ${live ? "live" : "waiting"}`;
  el.querySelector("span:last-child").textContent = live ? "connected to MCP" : "waiting for agent";
}

// ---- rendering ----
function render() {
  $("tokens").textContent = `~${board.tokens} tokens active`;
  $("count").textContent = `${board.active.length} / ${board.cap}`;

  for (const [name, host] of Object.entries(cols)) {
    host.innerHTML = "";
    const cards = board[name];
    if (!cards.length) {
      host.innerHTML = `<div class="empty">${emptyText(name)}</div>`;
    } else {
      for (const c of cards) host.appendChild(cardEl(c));
    }
  }
}

const emptyText = (col) =>
  col === "pinned" ? "Rules you drop here always reach the agent."
  : col === "active" ? "Your agent's working memory. Notes tumble to archive when full."
  : "Nothing archived yet.";

function cardEl(c) {
  const el = document.createElement("div");
  el.className = "card";
  el.draggable = true;
  el.dataset.id = c.id;
  el.dataset.type = c.type;

  el.innerHTML = `
    <div class="head">
      <span class="tag">${c.type}</span>
      <div class="acts">
        <button data-act="pin" title="${c.column === "pinned" ? "unpin" : "pin as a rule"}">&#128204;</button>
        <button data-act="archive" title="archive">&#8595;</button>
        <button data-act="trash" title="delete">&#10005;</button>
      </div>
    </div>
    <div class="body clamped"></div>
    <div class="foot"><span>${ago(c.updated)}</span><span>${c.origin}</span></div>`;

  const body = el.querySelector(".body");
  body.innerHTML = markdown(c.title ? `**${c.title}** ${c.content}` : c.content);

  // Double-click to edit in place. Enter saves, Escape abandons, blur saves.
  body.addEventListener("dblclick", () => startEdit(el, c));

  el.querySelector('[data-act="pin"]').onclick = () =>
    patch(c.id, { column: c.column === "pinned" ? "active" : "pinned" });
  el.querySelector('[data-act="archive"]').onclick = () => patch(c.id, { column: "archive" });
  el.querySelector('[data-act="trash"]').onclick = () => del(c.id);

  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", c.id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));

  if (editing === c.id) queueMicrotask(() => startEdit(el, c));
  return el;
}

function startEdit(el, c) {
  if (el.querySelector("textarea")) return;
  editing = c.id;
  const body = el.querySelector(".body");
  const ta = document.createElement("textarea");
  ta.value = c.content;
  body.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const save = () => {
    if (editing !== c.id) return;
    editing = null;
    const next = ta.value.trim();
    if (next && next !== c.content) patch(c.id, { content: next });
    else render();
  };
  ta.addEventListener("blur", save);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === "Escape") { editing = null; render(); }
  });
}

// Deliberately tiny: bold, inline code, and nothing else. A note is a note.
const markdown = (s) =>
  s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---- drag and drop between columns ----
for (const [name, host] of Object.entries(cols)) {
  host.addEventListener("dragover", (e) => { e.preventDefault(); host.classList.add("dragover"); });
  host.addEventListener("dragleave", () => host.classList.remove("dragover"));
  host.addEventListener("drop", (e) => {
    e.preventDefault();
    host.classList.remove("dragover");
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (id) patch(id, { column: name });
  });
}

// ---- header actions ----
$("new").onclick = async () => {
  await create({ content: "New note", type: "manual" });
  // Open the newest card straight into edit — a note you have to click twice is friction.
  queueMicrotask(() => {
    const last = cols.active.lastElementChild;
    if (last) last.querySelector(".body")?.dispatchEvent(new MouseEvent("dblclick"));
  });
};

const modal = $("settings-modal");
$("settings").onclick = () => {
  $("cap").value = board.cap;
  $("cap-out").textContent = board.cap;
  $("app-cmd").textContent = `chrome --app=${location.origin}`;
  modal.showModal();
};
$("close-settings").onclick = () => modal.close();
$("cap").oninput = (e) => ($("cap-out").textContent = e.target.value);
$("purge").onclick = async () => { await api("/archive", { method: "DELETE" }); };
$("export").onclick = () => (location.href = "/api/export");

fetch("/api/board").then((r) => r.json()).then((b) => { board = b; render(); });
