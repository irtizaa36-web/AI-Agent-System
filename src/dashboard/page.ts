/**
 * The dashboard's single HTML page. Server-rendered shell, client-side
 * fetches `/api/snapshot` and re-renders — no build step, no framework, no
 * new dependency (this project's zero-runtime-dependency stance, ADR 0002).
 * Kept as one plain-language, at-a-glance view: status badges use an icon
 * AND a text label (never color alone), body text stays at a normal
 * reading size, and layout is a single responsive grid so it reads fine on
 * a phone with no separate mobile layout to maintain. The two forms (add a
 * task, add a progress note) are the page's only interactive pieces — real
 * <form>/<label>/<button> elements, not custom widgets, so they're
 * keyboard- and screen-reader-usable for free.
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
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #eef0f3;
      --muted: #b7bcc5;
      --border: #3a4048;
      --input-bg: #14161a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  a, button, input, select, textarea { font: inherit; }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  header {
    padding: 1.25rem 1rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  header h1 { margin: 0; font-size: 1.4rem; }
  #meta { color: var(--muted); font-size: 0.95rem; }
  button { cursor: pointer; }
  button#refresh {
    background: var(--idle-bg);
    color: var(--idle);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
  }
  main { max-width: 68rem; margin: 0 auto; padding: 1rem; }
  section { margin-bottom: 2rem; }
  section h2 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 0.85rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1rem;
  }
  .card h3 { margin: 0 0 0.4rem; font-size: 1.05rem; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    margin-bottom: 0.5rem;
  }
  .badge.working { color: var(--working); background: var(--working-bg); }
  .badge.idle { color: var(--idle); background: var(--idle-bg); }
  .badge.stuck { color: var(--stuck); background: var(--stuck-bg); }
  .badge.offline { color: var(--offline); background: var(--offline-bg); }
  .badge.unknown, .badge.pending { color: var(--unknown); background: var(--unknown-bg); }
  .badge.done { color: var(--working); background: var(--working-bg); }
  .badge.in_progress { color: var(--idle); background: var(--idle-bg); }
  .field { color: var(--muted); font-size: 0.9rem; margin: 0.15rem 0; }
  .empty { color: var(--muted); font-style: italic; }
  .persona-line { font-size: 0.85rem; margin: 0.2rem 0; }
  .recent-update { font-size: 0.9rem; margin: 0.5rem 0; padding: 0.5rem 0.6rem; background: var(--idle-bg); border-radius: 0.5rem; }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  li.rec {
    border-left: 3px solid var(--border);
    padding: 0.5rem 0 0.5rem 0.75rem;
    margin-bottom: 0.6rem;
  }
  li.rec.implemented { border-left-color: var(--working); }
  li.rec .rec-summary { font-weight: 600; }
  details.history { margin-top: 0.5rem; }
  details.history summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
  details.history ul { list-style: none; margin: 0.4rem 0 0; padding: 0; }
  details.history li { font-size: 0.82rem; margin: 0.25rem 0; color: var(--muted); }
  form.card { display: flex; flex-direction: column; gap: 0.6rem; }
  form label { font-size: 0.85rem; font-weight: 600; display: block; margin-bottom: 0.25rem; }
  form input[type="text"], form select, form textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--input-bg);
    color: var(--text);
  }
  form .submit {
    align-self: flex-start;
    background: var(--working-bg);
    color: var(--working);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
  }
  .update-form { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; }
  .update-form input, .update-form textarea { padding: 0.4rem; border: 1px solid var(--border); border-radius: 0.4rem; background: var(--input-bg); color: var(--text); }
  .update-form button {
    align-self: flex-start;
    background: var(--idle-bg);
    color: var(--idle);
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    padding: 0.35rem 0.8rem;
    font-size: 0.85rem;
  }
  .form-status { font-size: 0.85rem; min-height: 1.2em; }
  .form-status.error { color: var(--offline); }
  .form-status.ok { color: var(--working); }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
</style>
</head>
<body>
<header>
  <h1>Coworker Dashboard</h1>
  <div id="meta">Loading…</div>
  <button id="refresh" type="button">Refresh now</button>
</header>
<main>
  <section aria-labelledby="agents-h">
    <h2 id="agents-h">Agents</h2>
    <ul id="agents" class="grid" aria-live="polite"></ul>
  </section>

  <section aria-labelledby="add-task-h">
    <h2 id="add-task-h">Add a task</h2>
    <form id="add-task-form" class="card">
      <div>
        <label for="task-text">What needs doing</label>
        <input type="text" id="task-text" name="task" required>
      </div>
      <div>
        <label for="task-assignee">Who it's for</label>
        <select id="task-assignee" name="assignedTo">
          <option value="macmini">macmini</option>
          <option value="Laptop2">Laptop2</option>
          <option value="Riley">Riley</option>
          <option value="both">Both (macmini &amp; Laptop2)</option>
        </select>
      </div>
      <button type="submit" class="submit">Add task</button>
      <p id="add-task-status" class="form-status" role="status" aria-live="polite"></p>
    </form>
  </section>

  <section aria-labelledby="projects-h">
    <h2 id="projects-h">Projects</h2>
    <ul id="projects" class="grid" aria-live="polite"></ul>
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
  var PROJECT_LABEL = { pending: "Not started", in_progress: "In progress", done: "Done" };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function badge(kind, key) {
    var b = el("span", "badge " + key);
    var label = kind === "project" ? (PROJECT_LABEL[key] || key) : (STATUS_LABEL[key] || key);
    var icon = kind === "project" ? "" : (STATUS_ICON[key] || "") + " ";
    b.textContent = icon + label;
    return b;
  }

  function renderAgents(agents) {
    var list = document.getElementById("agents");
    list.innerHTML = "";
    if (!agents.length) { list.appendChild(el("li", "empty", "No agents yet.")); return; }
    agents.forEach(function (a) {
      var li = el("li", "card");
      li.appendChild(el("h3", null, a.name));
      li.appendChild(badge("agent", a.status));
      if (a.currentTask) li.appendChild(el("p", "field", "Working on: " + a.currentTask));
      li.appendChild(el("p", "field", a.updatedAt ? "Last update: " + new Date(a.updatedAt).toLocaleString() : "Never reported in"));
      list.appendChild(li);
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

  function renderProjects(projects) {
    var list = document.getElementById("projects");
    list.innerHTML = "";
    if (!projects.length) { list.appendChild(el("li", "empty", "No projects yet.")); return; }
    projects.forEach(function (p) {
      var li = el("li", "card");
      li.appendChild(el("h3", null, p.name));
      li.appendChild(badge("project", p.overallStatus));
      li.appendChild(el("p", "field", "Assigned to: " + p.assignedTo));
      (p.personas || []).forEach(function (ps) {
        li.appendChild(el("p", "persona-line", ps.persona + ": " + ps.status + (ps.output ? " \\u2014 " + ps.output : "")));
      });

      if (p.mostRecentUpdate) {
        var when = new Date(p.mostRecentUpdate.at).toLocaleString();
        li.appendChild(el("p", "recent-update", "Latest (" + p.mostRecentUpdate.by + ", " + when + "): " + p.mostRecentUpdate.note));
      } else {
        li.appendChild(el("p", "field", "No updates yet."));
      }

      if (p.updateHistory && p.updateHistory.length > 1) {
        var details = document.createElement("details");
        details.className = "history";
        var summary = document.createElement("summary");
        summary.textContent = "History (" + p.updateHistory.length + " updates)";
        details.appendChild(summary);
        var ul = el("ul");
        p.updateHistory.slice().reverse().forEach(function (u) {
          ul.appendChild(el("li", null, new Date(u.at).toLocaleString() + " \\u2014 " + u.by + ": " + u.note));
        });
        details.appendChild(ul);
        li.appendChild(details);
      }

      li.appendChild(renderUpdateForm(p.id));
      list.appendChild(li);
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
        renderAgents(snap.agents);
        renderProjects(snap.projects);
        renderRecommendations(snap.recommendations);
        document.getElementById("meta").textContent = "Updated " + new Date(snap.generatedAt).toLocaleTimeString();
      })
      .catch(function () {
        document.getElementById("meta").textContent = "Couldn't load the latest data.";
      });
  }

  document.getElementById("refresh").addEventListener("click", load);

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
