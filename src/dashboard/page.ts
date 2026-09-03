/**
 * The dashboard's single HTML page. Server-rendered shell, client-side
 * fetches `/api/snapshot` and re-renders — no build step, no framework, no
 * new dependency (this project's zero-runtime-dependency stance, ADR 0002).
 * Kept as one plain-language, at-a-glance view: status badges use an icon
 * AND a text label (never color alone), body text stays at a normal
 * reading size. The "Add a task" dialog and each project's "Post an
 * update" disclosure are the page's only interactive pieces — real
 * <dialog>/<details>/<form>/<label>/<button> elements, not custom widgets,
 * so they're keyboard- and screen-reader-usable for free. The "Add a task"
 * trigger lives in the sticky header so it's reachable from anywhere on
 * the page, not just after scrolling to a particular section.
 *
 * Projects render as a Kanban board (Not started / In progress / Done
 * columns, one per `CoworkerOverallStatus`), modeled on Devin Desktop's
 * "Agent Command Center" — a Kanban view of coding-agent work organized by
 * status so you can tell what's in flight, needs attention, or finished at
 * a glance. Columns scroll horizontally as a set (standard Kanban/mobile
 * pattern) rather than reflowing into a single responsive grid; the Agents
 * roster above it keeps the plain responsive grid, since it's a status
 * roster, not a workflow.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coworker Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --card-bg: #ffffff;
    --text: #1a1d21;
    --muted: #4b515c;
    --border: #d8dce2;
    --working: #0a6e2e;
    --working-bg: #e4f7e9;
    --idle: #3a4a63;
    --idle-bg: #e7ecf5;
    --stuck: #8a4b00;
    --stuck-bg: #fbe9d2;
    --offline: #9a1c1c;
    --offline-bg: #fbe3e3;
    --unknown: #4a4f57;
    --unknown-bg: #eceef1;
    --focus: #1155cc;
    --input-bg: #ffffff;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 6px rgba(15, 23, 42, 0.04);
    --backdrop: rgba(20, 22, 26, 0.45);
    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-5: 1.5rem;
    --space-6: 2.25rem;
    --radius-sm: 0.4rem;
    --radius-md: 0.65rem;
    --radius-lg: 0.9rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #eef0f3;
      --muted: #b7bcc5;
      --border: #3a4048;
      --input-bg: #14161a;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 2px 10px rgba(0, 0, 0, 0.28);
      --backdrop: rgba(0, 0, 0, 0.6);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a, button, input, select, textarea { font: inherit; }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  header .header-title { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.01em; }
  #meta { color: var(--muted); font-size: 0.85rem; }
  header .header-actions { display: flex; gap: var(--space-2); align-items: center; margin-left: auto; }
  button { cursor: pointer; }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    padding: 0.5rem 0.9rem;
    font-size: 0.9rem;
    font-weight: 600;
    background: var(--card-bg);
    color: var(--text);
  }
  .btn-primary { background: var(--working-bg); color: var(--working); border-color: transparent; }
  .btn-ghost { background: var(--idle-bg); color: var(--idle); }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2rem; height: 2rem; border-radius: 999px; border: 1px solid var(--border);
    background: var(--card-bg); color: var(--muted); font-size: 1.1rem; line-height: 1; padding: 0;
  }
  main { max-width: 68rem; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-6); }
  section { margin-bottom: var(--space-6); }
  section h2 {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    margin: 0 0 var(--space-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
    gap: var(--space-4);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .metric {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow);
    padding: var(--space-3) var(--space-4);
  }
  .metric-value { display: block; font-size: 1.7rem; font-weight: 750; line-height: 1.2; }
  .metric-label { color: var(--muted); font-size: 0.82rem; }
  .attention-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .attention-item {
    background: var(--stuck-bg);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--stuck);
    padding: var(--space-3) var(--space-4);
  }
  .attention-item strong { display: block; }
  .attention-item .attention-meta { display: block; margin-top: var(--space-1); font-size: 0.78rem; }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    color: var(--muted);
    font-size: 0.82rem;
    font-weight: 650;
  }
  .filters select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--text);
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    padding: var(--space-3) var(--space-4);
  }
  .card h3 { margin: 0 0 var(--space-2); font-size: 1.02rem; font-weight: 650; }
  /* Task text is often a full written-out instruction, not a short title —
     clamp it to a scannable preview instead of letting a card become a
     wall of text; the full text is one click away via .task-detail. */
  .kanban-cards h3 {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  details.task-detail { margin: 0 0 var(--space-2); }
  details.task-detail summary { cursor: pointer; color: var(--focus); font-size: 0.82rem; font-weight: 600; }
  details.task-detail p { margin: var(--space-2) 0 0; font-size: 0.9rem; }
  .kanban {
    display: flex;
    gap: var(--space-4);
    overflow-x: auto;
    padding-bottom: var(--space-2);
    scroll-snap-type: x proximity;
  }
  .kanban-column {
    flex: 0 0 min(20rem, 85vw);
    display: flex;
    flex-direction: column;
    scroll-snap-align: start;
  }
  .kanban-column-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    padding-left: var(--space-2);
    border-left: 3px solid var(--border);
    margin-bottom: var(--space-3);
  }
  .kanban-column-head.status-pending { border-left-color: var(--unknown); }
  .kanban-column-head.status-in_progress { border-left-color: var(--idle); }
  .kanban-column-head.status-done { border-left-color: var(--working); }
  .kanban-column-head h3 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .kanban-count {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--muted);
    background: var(--unknown-bg);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    flex-shrink: 0;
  }
  .kanban-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .badge.working { color: var(--working); background: var(--working-bg); }
  .badge.idle { color: var(--idle); background: var(--idle-bg); }
  .badge.stuck { color: var(--stuck); background: var(--stuck-bg); }
  .badge.offline { color: var(--offline); background: var(--offline-bg); }
  .badge.unknown { color: var(--unknown); background: var(--unknown-bg); }
  .agent-card .badge { margin-bottom: var(--space-2); }
  .field { color: var(--muted); font-size: 0.88rem; margin: 0.2rem 0; }
  .empty { color: var(--muted); font-style: italic; }
  .persona-list { list-style: none; margin: var(--space-2) 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .persona-list li { font-size: 0.85rem; display: flex; flex-wrap: wrap; gap: 0.3rem 0.4rem; align-items: baseline; }
  .persona-list .persona-name { font-weight: 650; }
  .persona-list .persona-output { color: var(--muted); flex-basis: 100%; }
  .persona-list details.task-detail { flex-basis: 100%; margin: 0; }
  .recent-update {
    margin: var(--space-3) 0;
    padding: var(--space-3);
    background: var(--idle-bg);
    border-radius: var(--radius-md);
  }
  /* Note: this box keeps a light "chip" background in both themes (same
     pattern as .badge), so its text needs an explicit color that stays
     readable against that light background — it must not inherit the
     page's theme-aware --text/--muted, which turn light in dark mode and
     would go near-invisible here. */
  .recent-update-label { margin: 0 0 0.2rem; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--idle); }
  .recent-update-note { margin: 0; font-size: 0.92rem; color: var(--idle); }
  .recent-update-meta { margin: 0.3rem 0 0; font-size: 0.78rem; color: var(--idle); }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  li.rec {
    border-left: 3px solid var(--border);
    padding: var(--space-2) 0 var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }
  li.rec.implemented { border-left-color: var(--working); }
  li.rec .rec-summary { font-weight: 600; margin: 0 0 0.2rem; }
  details.history { margin-top: var(--space-3); }
  details.history summary { cursor: pointer; color: var(--muted); font-size: 0.82rem; }
  details.history ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
  details.history li { font-size: 0.8rem; color: var(--muted); }
  details.history .history-meta { display: block; font-weight: 600; color: var(--text); }
  details.update-toggle { margin-top: var(--space-3); }
  details.update-toggle summary {
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    background: var(--idle-bg);
    color: var(--idle);
    border-radius: var(--radius-sm);
    padding: 0.45rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 650;
  }
  details.update-toggle summary::-webkit-details-marker { display: none; }
  details.update-toggle[open] summary { margin-bottom: var(--space-2); }
  .update-form { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }
  .update-form input, .update-form textarea {
    padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--input-bg); color: var(--text); width: 100%;
  }
  .update-form button {
    align-self: flex-start;
    background: var(--working-bg);
    color: var(--working);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    font-weight: 650;
  }
  .form-status { font-size: 0.85rem; min-height: 1.2em; margin: 0; }
  .form-status.error { color: var(--offline); }
  .form-status.ok { color: var(--working); }
  dialog {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    background: var(--card-bg);
    color: var(--text);
    padding: var(--space-4);
    width: min(26rem, calc(100vw - 2rem));
  }
  dialog::backdrop { background: var(--backdrop); }
  .dialog-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
  .dialog-head h2 { margin: 0; font-size: 1.05rem; text-transform: none; letter-spacing: normal; font-weight: 650; color: var(--text); }
  #add-task-form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field-group label { font-size: 0.85rem; font-weight: 650; display: block; margin-bottom: 0.3rem; }
  .field-group input[type="text"], .field-group select {
    width: 100%;
    padding: 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--text);
  }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
</style>
</head>
<body>
<header>
  <div class="header-title">
    <h1>Coworker Dashboard</h1>
    <div id="meta">Loading…</div>
  </div>
  <div class="header-actions">
    <button id="open-add-task" type="button" class="btn btn-primary">+ Add a task</button>
    <button id="refresh" type="button" class="btn btn-ghost">Refresh now</button>
  </div>
</header>

<dialog id="add-task-dialog" aria-labelledby="add-task-h">
  <div class="dialog-head">
    <h2 id="add-task-h">Add a task</h2>
    <button type="button" class="icon-btn" id="close-add-task" aria-label="Close">&times;</button>
  </div>
  <form id="add-task-form">
    <div class="field-group">
      <label for="task-text">What needs doing</label>
      <input type="text" id="task-text" name="task" placeholder="Describe the next concrete action" required>
    </div>
    <div class="field-group">
      <label for="task-assignee">Who it's for</label>
      <select id="task-assignee" name="assignedTo">
        <option value="macmini">macmini</option>
        <option value="Laptop2">Laptop2</option>
        <option value="Riley">Riley</option>
        <option value="Jordan">Jordan</option>
        <option value="PinkyBaby">PinkyBaby</option>
        <option value="both">Both (macmini &amp; Laptop2)</option>
      </select>
    </div>
    <button type="submit" class="btn btn-primary">Add task</button>
    <p id="add-task-status" class="form-status" role="status" aria-live="polite"></p>
  </form>
</dialog>

<main>
  <section aria-labelledby="summary-h">
    <h2 id="summary-h">At a glance</h2>
    <div id="summary" class="summary-grid" aria-live="polite"></div>
  </section>

  <section aria-labelledby="attention-h" id="attention-section">
    <h2 id="attention-h">Attention needed</h2>
    <div id="attention" class="attention-list" aria-live="polite"></div>
  </section>

  <section aria-labelledby="agents-h">
    <h2 id="agents-h">Agents</h2>
    <ul id="agents" class="grid" aria-live="polite"></ul>
  </section>

  <section aria-labelledby="projects-h">
    <h2 id="projects-h">Projects and tasks</h2>
    <div class="filters" aria-label="Project filters">
      <label>
        Status
        <select id="status-filter">
          <option value="all">All statuses</option>
          <option value="pending">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select>
      </label>
      <label>
        Assignee
        <select id="assignee-filter">
          <option value="all">All assignees</option>
          <option value="macmini">macmini</option>
          <option value="Laptop2">Laptop2</option>
          <option value="Riley">Riley</option>
          <option value="Jordan">Jordan</option>
          <option value="PinkyBaby">PinkyBaby</option>
          <option value="both">Both</option>
        </select>
      </label>
    </div>
    <div class="kanban">
      <div class="kanban-column">
        <div class="kanban-column-head status-pending">
          <h3 id="kanban-pending-h">Not started</h3>
          <span class="kanban-count" id="kanban-count-pending">0</span>
        </div>
        <ul class="kanban-cards" id="kanban-pending" aria-labelledby="kanban-pending-h" aria-live="polite"></ul>
      </div>
      <div class="kanban-column">
        <div class="kanban-column-head status-in_progress">
          <h3 id="kanban-in_progress-h">In progress</h3>
          <span class="kanban-count" id="kanban-count-in_progress">0</span>
        </div>
        <ul class="kanban-cards" id="kanban-in_progress" aria-labelledby="kanban-in_progress-h" aria-live="polite"></ul>
      </div>
      <div class="kanban-column">
        <div class="kanban-column-head status-done">
          <h3 id="kanban-done-h">Done</h3>
          <span class="kanban-count" id="kanban-count-done">0</span>
        </div>
        <ul class="kanban-cards" id="kanban-done" aria-labelledby="kanban-done-h" aria-live="polite"></ul>
      </div>
    </div>
  </section>

  <section aria-labelledby="recs-h">
    <h2 id="recs-h">Recommendations &amp; changes</h2>
    <ul id="recommendations" class="plain" aria-live="polite"></ul>
  </section>
</main>
<script>
(function () {
  var STATUS_LABEL = { working: "Working", idle: "Idle", stuck: "Stuck", offline: "Offline", unknown: "No report yet" };
  var STATUS_ICON = { working: "\\u25CF", idle: "\\u25CB", stuck: "\\u25B2", offline: "\\u2715", unknown: "\\u2013" };
  var KANBAN_COLUMNS = ["pending", "in_progress", "done"];
  var latestProjects = [];

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function badge(key) {
    var b = el("span", "badge " + key);
    b.textContent = (STATUS_ICON[key] || "") + " " + (STATUS_LABEL[key] || key);
    return b;
  }

  function renderAgents(agents) {
    var list = document.getElementById("agents");
    list.innerHTML = "";
    if (!agents.length) { list.appendChild(el("li", "empty", "No agents yet.")); return; }
    agents.forEach(function (a) {
      var li = el("li", "card agent-card");
      li.appendChild(el("h3", null, a.name));
      li.appendChild(badge(a.status));
      if (a.currentTask) li.appendChild(el("p", "field", "Working on: " + a.currentTask));
      li.appendChild(el("p", "field", a.updatedAt ? "Last update: " + new Date(a.updatedAt).toLocaleString() : "Never reported in"));
      list.appendChild(li);
    });
  }

  function renderSummary(snap) {
    var summary = document.getElementById("summary");
    summary.innerHTML = "";
    [
      ["Total tasks", snap.projects.length],
      ["In progress", snap.projects.filter(function (p) { return p.overallStatus === "in_progress"; }).length],
      ["Ready to start", snap.projects.filter(function (p) { return p.overallStatus === "pending"; }).length]
    ].forEach(function (metric) {
      var card = el("div", "metric");
      card.appendChild(el("span", "metric-value", String(metric[1])));
      card.appendChild(el("span", "metric-label", metric[0]));
      summary.appendChild(card);
    });
  }

  function renderAttention(items) {
    var section = document.getElementById("attention-section");
    var list = document.getElementById("attention");
    list.innerHTML = "";
    section.hidden = items.length === 0;
    items.forEach(function (attentionItem) {
      var card = el("div", "attention-item");
      card.appendChild(el("strong", null, attentionItem.reason));
      if (attentionItem.detail) card.appendChild(el("span", null, attentionItem.detail));
      card.appendChild(el("span", "attention-meta", attentionItem.source + " · " + new Date(attentionItem.at).toLocaleString()));
      list.appendChild(card);
    });
  }

  function renderUpdateForm(projectId) {
    var form = el("form", "update-form");
    form.setAttribute("data-project-id", projectId);

    var byLabel = el("label", "visually-hidden", "Your name");
    var byId = "update-by-" + projectId;
    byLabel.setAttribute("for", byId);
    var byInput = document.createElement("input");
    byInput.type = "text"; byInput.id = byId; byInput.name = "by"; byInput.placeholder = "Your name"; byInput.required = true;

    var noteLabel = el("label", "visually-hidden", "Update");
    var noteId = "update-note-" + projectId;
    noteLabel.setAttribute("for", noteId);
    var noteInput = document.createElement("textarea");
    noteInput.id = noteId; noteInput.name = "note"; noteInput.rows = 2; noteInput.placeholder = "Post an update…"; noteInput.required = true;

    var button = el("button", null, "Post update");
    button.type = "submit";
    var status = el("p", "form-status", "");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    form.appendChild(byLabel);
    form.appendChild(byInput);
    form.appendChild(noteLabel);
    form.appendChild(noteInput);
    form.appendChild(button);
    form.appendChild(status);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      status.textContent = "Posting…";
      status.className = "form-status";
      fetch("/api/tasks/" + encodeURIComponent(projectId) + "/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: byInput.value, note: noteInput.value }),
      })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body && result.body.error ? result.body.error : "couldn't post that update");
          status.textContent = "Posted.";
          status.className = "form-status ok";
          noteInput.value = "";
          load();
        })
        .catch(function (err) {
          status.textContent = err.message;
          status.className = "form-status error";
        });
    });

    return form;
  }

  function renderUpdateToggle(projectId) {
    var details = document.createElement("details");
    details.className = "update-toggle";
    var summary = document.createElement("summary");
    summary.textContent = "+ Post an update";
    details.appendChild(summary);
    details.appendChild(renderUpdateForm(projectId));
    return details;
  }

  /** A short summary label + a collapsed <details> holding the full text — used anywhere free-written text (a task description, a completion note) is too long to show inline without turning a card into a wall of text. Text at or under the threshold renders plainly instead, no toggle needed. */
  function expandableText(text, summaryLabel, threshold) {
    if (text.length <= (threshold || 100)) return el("span", null, text);
    var d = document.createElement("details");
    d.className = "task-detail";
    var s = document.createElement("summary");
    s.textContent = summaryLabel;
    d.appendChild(s);
    d.appendChild(el("p", null, text));
    return d;
  }

  function renderPersonaList(personas) {
    var ul = el("ul", "persona-list");
    personas.forEach(function (ps) {
      var li = document.createElement("li");
      li.appendChild(el("span", "persona-name", ps.persona + ":"));
      li.appendChild(el("span", "persona-status", ps.status));
      if (ps.output) {
        var out = expandableText(ps.output, "Full output");
        out.className = (out.className ? out.className + " " : "") + "persona-output";
        li.appendChild(out);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function renderRecentUpdate(update) {
    var wrap = el("div", "recent-update");
    wrap.appendChild(el("p", "recent-update-label", "Latest update"));
    wrap.appendChild(el("p", "recent-update-note", update.note));
    wrap.appendChild(el("p", "recent-update-meta", update.by + " \\u00b7 " + new Date(update.at).toLocaleString()));
    return wrap;
  }

  /** True when mostRecentUpdate is a real posted progress note (the last entry in updateHistory) rather than one synthesized from a dispatch/result event that the persona list below already shows — showing both would just repeat the same status/output twice. */
  function isExplicitUpdate(p) {
    var last = p.updateHistory && p.updateHistory[p.updateHistory.length - 1];
    var u = p.mostRecentUpdate;
    return !!(last && u && last.at === u.at && last.by === u.by && last.note === u.note);
  }

  function renderHistory(updates) {
    if (!updates || updates.length < 2) return null;
    var details = document.createElement("details");
    details.className = "history";
    var summary = document.createElement("summary");
    summary.textContent = "History (" + updates.length + " updates)";
    details.appendChild(summary);
    var ul = el("ul");
    updates.slice().reverse().forEach(function (u) {
      var li = document.createElement("li");
      li.appendChild(el("span", "history-meta", u.by + " \\u00b7 " + new Date(u.at).toLocaleString()));
      li.appendChild(document.createTextNode(u.note));
      ul.appendChild(li);
    });
    details.appendChild(ul);
    return details;
  }

  function buildProjectCard(p) {
    var li = el("li", "card");
    li.appendChild(el("h3", null, p.name));

    // The clamped h3 above is a preview; give long task text an explicit
    // way to read the rest instead of just cutting it off.
    var titleDetail = expandableText(p.name, "Full task text");
    if (titleDetail.tagName === "DETAILS") li.appendChild(titleDetail);

    // "Assigned to" only earns its place when it says something the
    // persona list below doesn't already — i.e. for a "both" task. For a
    // single assignee, the persona list already names them.
    if (p.assignedTo === "both") li.appendChild(el("p", "field", "Assigned to: both"));

    li.appendChild(el(
      "p",
      "field",
      p.mostRecentUpdate
        ? "Last activity: " + new Date(p.mostRecentUpdate.at).toLocaleString()
        : "Created: " + new Date(p.createdAt).toLocaleString()
    ));

    li.appendChild(renderPersonaList(p.personas || []));
    if (isExplicitUpdate(p)) li.appendChild(renderRecentUpdate(p.mostRecentUpdate));
    var history = renderHistory(p.updateHistory);
    if (history) li.appendChild(history);
    li.appendChild(renderUpdateToggle(p.id));
    return li;
  }

  /** Groups projects into Kanban columns by overall status (Not started / In progress / Done) — see the file-level comment for why a Kanban board instead of a flat grid. */
  function renderProjects(projects) {
    var statusFilter = document.getElementById("status-filter").value;
    var assigneeFilter = document.getElementById("assignee-filter").value;
    var buckets = { pending: [], in_progress: [], done: [] };
    projects
      .filter(function (p) {
        return (statusFilter === "all" || p.overallStatus === statusFilter) &&
          (assigneeFilter === "all" || p.assignedTo === assigneeFilter);
      })
      .forEach(function (p) { (buckets[p.overallStatus] || buckets.pending).push(p); });

    KANBAN_COLUMNS.forEach(function (status) {
      var list = document.getElementById("kanban-" + status);
      var items = buckets[status];
      list.innerHTML = "";
      document.getElementById("kanban-count-" + status).textContent = String(items.length);
      if (!items.length) { list.appendChild(el("li", "empty", "Nothing here.")); return; }
      items.forEach(function (p) { list.appendChild(buildProjectCard(p)); });
    });
  }

  function renderRecommendations(recs) {
    var list = document.getElementById("recommendations");
    list.innerHTML = "";
    if (!recs.length) { list.appendChild(el("li", "empty", "Nothing recommended yet.")); return; }
    recs.forEach(function (r) {
      var li = el("li", "rec" + (r.implemented ? " implemented" : ""));
      li.appendChild(el("p", "rec-summary", "[" + r.scope + "] " + r.summary));
      var status = r.implemented ? "Implemented " + new Date(r.implementedAt).toLocaleString() : "Not yet implemented";
      li.appendChild(el("p", "field", status));
      if (r.details) li.appendChild(el("p", "field", r.details));
      list.appendChild(li);
    });
  }

  function load() {
    document.getElementById("meta").textContent = "Refreshing…";
    fetch("/api/snapshot")
      .then(function (res) { return res.json(); })
      .then(function (snap) {
        latestProjects = snap.projects;
        renderSummary(snap);
        renderAttention(snap.attention);
        renderAgents(snap.agents);
        renderProjects(latestProjects);
        renderRecommendations(snap.recommendations);
        document.getElementById("meta").textContent = "Updated " + new Date(snap.generatedAt).toLocaleTimeString();
      })
      .catch(function () {
        document.getElementById("meta").textContent = "Couldn't load the latest data.";
      });
  }

  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("status-filter").addEventListener("change", function () { renderProjects(latestProjects); });
  document.getElementById("assignee-filter").addEventListener("change", function () { renderProjects(latestProjects); });

  var addTaskDialog = document.getElementById("add-task-dialog");
  var openAddTaskBtn = document.getElementById("open-add-task");
  var closeAddTaskBtn = document.getElementById("close-add-task");
  openAddTaskBtn.addEventListener("click", function () {
    addTaskDialog.showModal();
    document.getElementById("task-text").focus();
  });
  closeAddTaskBtn.addEventListener("click", function () { addTaskDialog.close(); });
  addTaskDialog.addEventListener("click", function (event) {
    if (event.target === addTaskDialog) addTaskDialog.close();
  });

  var addTaskForm = document.getElementById("add-task-form");
  var addTaskStatus = document.getElementById("add-task-status");
  addTaskForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var taskText = document.getElementById("task-text").value;
    var assignedTo = document.getElementById("task-assignee").value;
    addTaskStatus.textContent = "Adding…";
    addTaskStatus.className = "form-status";
    fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: taskText, assignedTo: assignedTo }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body && result.body.error ? result.body.error : "couldn't add that task");
        addTaskStatus.textContent = "Added.";
        addTaskStatus.className = "form-status ok";
        document.getElementById("task-text").value = "";
        load();
      })
      .catch(function (err) {
        addTaskStatus.textContent = err.message;
        addTaskStatus.className = "form-status error";
      });
  });

  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>
`;
