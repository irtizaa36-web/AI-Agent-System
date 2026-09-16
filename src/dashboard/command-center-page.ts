/**
 * The chat-first Moby AI command center. This first interface slice reads
 * the existing dashboard snapshot and offers an explicit, deterministic
 * preview of the future Orchestrator conversation. It does not call a model
 * or enqueue work yet; the operational board remains available at /legacy.
 */
export const COMMAND_CENTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>Moby AI</title>
<style>
  :root {
    color-scheme: light;
    --navy: #0f172a;
    --navy-soft: #1e293b;
    --paper: #f8fafc;
    --surface: #ffffff;
    --surface-soft: #f1f5f9;
    --line: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --blue: #2563eb;
    --blue-soft: #eff6ff;
    --green: #15803d;
    --green-soft: #f0fdf4;
    --amber: #b45309;
    --amber-soft: #fffbeb;
    --red: #b91c1c;
    --red-soft: #fef2f2;
    --radius: 18px;
    --radius-small: 12px;
    --shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--text);
    font: 15px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  button, input, a { font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  button { cursor: pointer; }
  :focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .app { min-height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    min-height: 64px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px;
    background: rgba(248, 250, 252, 0.94);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(16px);
  }
  .brand-mark {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 13px;
    color: white;
    background: linear-gradient(145deg, #1d4ed8, #0f172a);
    font-size: 19px;
    font-weight: 800;
    box-shadow: 0 8px 20px rgba(37, 99, 235, 0.22);
  }
  .brand-copy { min-width: 0; }
  .brand-copy h1 { margin: 0; font-size: 17px; line-height: 1.2; letter-spacing: -0.02em; }
  .brand-copy p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
  .mode-pill {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border: 1px solid #bfdbfe;
    border-radius: 999px;
    color: #1d4ed8;
    background: var(--blue-soft);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }
  .mode-dot { width: 7px; height: 7px; border-radius: 999px; background: #3b82f6; }
  .layout { min-height: 0; display: grid; }
  .pane { min-width: 0; }
  .sidebar, .activity { display: none; }
  .conversation {
    display: flex;
    flex-direction: column;
    min-height: calc(100dvh - 121px);
    background: var(--surface);
  }
  .conversation-head {
    padding: 18px 18px 12px;
    border-bottom: 1px solid var(--line);
  }
  .eyebrow {
    margin: 0 0 5px;
    color: var(--blue);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .conversation-head h2 { margin: 0; font-size: 22px; letter-spacing: -0.035em; }
  .conversation-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
  .messages {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 15px;
    padding: 20px 18px 26px;
    overflow-y: auto;
  }
  .message { display: flex; align-items: flex-start; gap: 10px; max-width: 760px; }
  .message.user { align-self: flex-end; flex-direction: row-reverse; }
  .avatar {
    flex: 0 0 30px;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: var(--navy);
    color: white;
    font-size: 12px;
    font-weight: 800;
  }
  .message.user .avatar { background: #dbeafe; color: #1d4ed8; }
  .bubble {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 6px 17px 17px 17px;
    background: var(--surface-soft);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.03);
  }
  .message.user .bubble {
    color: white;
    background: var(--blue);
    border-color: var(--blue);
    border-radius: 17px 6px 17px 17px;
  }
  .bubble p { margin: 0; }
  .bubble p + p { margin-top: 8px; }
  .quick-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
  .quick-action {
    padding: 8px 11px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--navy-soft);
    font-size: 12px;
    font-weight: 700;
  }
  .composer-wrap {
    position: sticky;
    bottom: 57px;
    padding: 11px 14px max(11px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(16px);
  }
  .composer {
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: 780px;
    margin: 0 auto;
    padding: 7px 7px 7px 14px;
    border: 1px solid #cbd5e1;
    border-radius: 17px;
    background: var(--surface);
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  .composer:focus-within { border-color: #60a5fa; box-shadow: 0 0 0 3px #dbeafe; }
  .composer input { min-width: 0; flex: 1; border: 0; outline: 0; color: var(--text); background: transparent; }
  .composer input::placeholder { color: #94a3b8; }
  .send {
    width: 38px;
    height: 38px;
    border: 0;
    border-radius: 12px;
    color: white;
    background: var(--navy);
    font-size: 18px;
    font-weight: 800;
  }
  .composer-note { max-width: 780px; margin: 6px auto 0; color: var(--muted); font-size: 10px; text-align: center; }
  .mobile-nav {
    position: sticky;
    bottom: 0;
    z-index: 30;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    min-height: 57px;
    padding-bottom: env(safe-area-inset-bottom);
    border-top: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.98);
  }
  .mobile-nav button {
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
  }
  .mobile-nav button[aria-selected="true"] { color: var(--blue); }
  .mobile-only-pane { display: none; min-height: calc(100dvh - 121px); padding: 18px; overflow-y: auto; }
  .mobile-only-pane.mobile-active { display: block; }
  .pane-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .pane-heading h2 { margin: 0; font-size: 19px; letter-spacing: -0.025em; }
  .pane-heading p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .text-link { color: var(--blue); font-size: 12px; font-weight: 700; text-decoration: none; }
  .project-list, .attention-list { display: flex; flex-direction: column; gap: 10px; }
  .project-card, .attention-card, .summary-card {
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    background: var(--surface);
  }
  .project-card { box-shadow: 0 2px 8px rgba(15, 23, 42, 0.03); }
  .project-top { display: flex; align-items: flex-start; gap: 8px; justify-content: space-between; }
  .project-card h3 { margin: 0; font-size: 14px; line-height: 1.35; }
  .project-card dl { display: grid; grid-template-columns: 68px 1fr; gap: 5px 8px; margin: 11px 0 0; font-size: 12px; }
  .project-card dt { color: var(--muted); }
  .project-card dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .status {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
  }
  .status.in_progress { color: #1d4ed8; background: var(--blue-soft); }
  .status.done { color: var(--green); background: var(--green-soft); }
  .attention-card { border-color: #fde68a; background: var(--amber-soft); }
  .attention-card strong { display: block; color: #92400e; font-size: 13px; }
  .attention-card p { margin: 4px 0 0; color: #92400e; font-size: 12px; }
  .empty { margin: 0; color: var(--muted); font-size: 13px; }
  .summary-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 15px; }
  .summary-card { padding: 11px; text-align: center; }
  .summary-card strong { display: block; font-size: 20px; }
  .summary-card span { color: var(--muted); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .planned-spaces { margin: 0 0 18px; padding: 0; list-style: none; display: grid; gap: 7px; }
  .planned-spaces li { display: flex; justify-content: space-between; gap: 8px; padding: 9px 10px; border-radius: 10px; background: var(--surface-soft); font-size: 12px; }
  .planned-spaces span { color: var(--muted); }
  .sidebar-footer { margin-top: auto; padding-top: 16px; }
  .sidebar-footer a { display: block; padding: 10px 11px; border-radius: 10px; color: var(--text); text-decoration: none; font-size: 12px; font-weight: 750; }
  .sidebar-footer a:hover { background: var(--surface-soft); }

  @media (min-width: 900px) {
    .app { grid-template-rows: 70px 1fr; height: 100vh; overflow: hidden; }
    .topbar { position: static; padding: 12px 22px; }
    .layout { grid-template-columns: 250px minmax(420px, 1fr) 300px; height: calc(100vh - 70px); }
    .sidebar, .activity { display: flex; flex-direction: column; padding: 20px 17px; overflow-y: auto; background: var(--surface); }
    .sidebar { border-right: 1px solid var(--line); }
    .activity { border-left: 1px solid var(--line); }
    .conversation { display: flex !important; min-height: 0; background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); }
    .conversation-head { padding: 22px 28px 16px; }
    .messages { padding: 24px 28px 34px; }
    .composer-wrap { bottom: 0; padding: 12px 24px 16px; }
    .mobile-nav { display: none; }
    .mobile-only-pane { display: none !important; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand-mark" aria-hidden="true">M</div>
    <div class="brand-copy">
      <h1>Moby AI</h1>
      <p id="sync-status">Loading current work…</p>
    </div>
    <div class="mode-pill"><span class="mode-dot"></span>Interface preview</div>
  </header>

  <main class="layout">
    <aside class="sidebar pane" aria-label="Project navigation">
      <div class="pane-heading">
        <div><p class="eyebrow">Workspace</p><h2>Projects</h2></div>
      </div>
      <ul class="planned-spaces">
        <li><strong>Moby AI</strong><span>Active</span></li>
        <li><strong>Job search</strong><span>Planned space</span></li>
        <li><strong>Research</strong><span>Planned space</span></li>
        <li><strong>Dashboard</strong><span>Planned space</span></li>
      </ul>
      <div class="summary-row" id="desktop-summary"></div>
      <div class="sidebar-footer">
        <a href="/legacy">Open operational board →</a>
      </div>
    </aside>

    <section class="conversation pane" id="chat-pane" aria-labelledby="chat-heading">
      <div class="conversation-head">
        <p class="eyebrow">Orchestrator</p>
        <h2 id="chat-heading">What should we work on?</h2>
        <p>This preview reads current local status. Agent execution arrives in the next step.</p>
      </div>
      <div class="messages" id="messages" aria-live="polite">
        <article class="message assistant">
          <div class="avatar" aria-hidden="true">M</div>
          <div class="bubble">
            <p>I am the Moby AI interface preview. I can summarize the current task board without sending work to an Agent.</p>
            <p>Try a status question below.</p>
          </div>
        </article>
        <div class="quick-actions" id="quick-actions">
          <button class="quick-action" type="button">What needs attention?</button>
          <button class="quick-action" type="button">Show current work</button>
          <button class="quick-action" type="button">How many tasks are done?</button>
        </div>
      </div>
      <div class="composer-wrap">
        <form class="composer" id="composer">
          <label class="visually-hidden" for="message-input">Message Moby AI</label>
          <input id="message-input" autocomplete="off" placeholder="Message Moby AI…" required>
          <button class="send" type="submit" aria-label="Send message">↑</button>
        </form>
        <p class="composer-note">Preview mode: messages stay in this browser and do not invoke a model.</p>
      </div>
    </section>

    <aside class="activity pane" aria-label="Current activity">
      <div class="pane-heading">
        <div><p class="eyebrow">Now</p><h2>Activity</h2><p>Status, result, and next action</p></div>
        <a class="text-link" href="/legacy">Details</a>
      </div>
      <div class="attention-list" id="desktop-attention"><p class="empty">Loading…</p></div>
    </aside>

    <section class="mobile-only-pane" id="projects-pane" aria-labelledby="projects-heading">
      <div class="pane-heading">
        <div><p class="eyebrow">Workspace</p><h2 id="projects-heading">Current work</h2><p>Legacy tasks awaiting project grouping</p></div>
        <a class="text-link" href="/legacy">Board</a>
      </div>
      <div class="summary-row" id="mobile-summary"></div>
      <div class="project-list" id="mobile-projects"><p class="empty">Loading…</p></div>
    </section>

    <section class="mobile-only-pane" id="activity-pane" aria-labelledby="activity-heading">
      <div class="pane-heading">
        <div><p class="eyebrow">Now</p><h2 id="activity-heading">Activity</h2><p>Items that may need review</p></div>
      </div>
      <div class="attention-list" id="mobile-attention"><p class="empty">Loading…</p></div>
    </section>
  </main>

  <nav class="mobile-nav" aria-label="Primary navigation">
    <button type="button" data-screen="chat" aria-selected="true">Chat</button>
    <button type="button" data-screen="projects" aria-selected="false">Projects</button>
    <button type="button" data-screen="activity" aria-selected="false">Activity</button>
  </nav>
</div>

<script>
(function () {
  "use strict";
  var snapshot = null;
  var messages = document.getElementById("messages");
  var input = document.getElementById("message-input");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function counts() {
    var result = { pending: 0, in_progress: 0, done: 0 };
    if (!snapshot) return result;
    snapshot.projects.forEach(function (item) {
      if (Object.prototype.hasOwnProperty.call(result, item.overallStatus)) result[item.overallStatus] += 1;
    });
    return result;
  }

  function renderSummary(targetId) {
    var target = document.getElementById(targetId);
    var c = counts();
    target.innerHTML = "";
    [["Active", c.in_progress], ["Queued", c.pending], ["Done", c.done]].forEach(function (item) {
      var card = el("div", "summary-card");
      card.appendChild(el("strong", null, String(item[1])));
      card.appendChild(el("span", null, item[0]));
      target.appendChild(card);
    });
  }

  function firstResult(project) {
    var match = (project.personas || []).find(function (persona) { return !!persona.output; });
    return match ? match.output : "No result recorded yet.";
  }

  function nextAction(project) {
    if (project.overallStatus === "done") return "Review the recorded result.";
    if (project.overallStatus === "in_progress") return "Check the latest update or blocker.";
    return "Decide whether this task should be resumed and assigned.";
  }

  function renderProjects() {
    var target = document.getElementById("mobile-projects");
    target.innerHTML = "";
    if (!snapshot || !snapshot.projects.length) {
      target.appendChild(el("p", "empty", "No legacy tasks are recorded."));
      return;
    }
    snapshot.projects.slice(0, 30).forEach(function (project) {
      var card = el("article", "project-card");
      var top = el("div", "project-top");
      top.appendChild(el("h3", null, project.name));
      top.appendChild(el("span", "status " + project.overallStatus, project.overallStatus.replace("_", " ")));
      card.appendChild(top);
      var details = document.createElement("dl");
      [["Status", project.overallStatus.replace("_", " ")], ["Result", firstResult(project)], ["Next", nextAction(project)]].forEach(function (item) {
        details.appendChild(el("dt", null, item[0]));
        details.appendChild(el("dd", null, item[1]));
      });
      card.appendChild(details);
      target.appendChild(card);
    });
  }

  function renderAttention(targetId) {
    var target = document.getElementById(targetId);
    target.innerHTML = "";
    if (!snapshot || !snapshot.attention.length) {
      target.appendChild(el("p", "empty", "Nothing currently needs attention."));
      return;
    }
    snapshot.attention.slice(0, 12).forEach(function (item) {
      var card = el("article", "attention-card");
      card.appendChild(el("strong", null, item.reason));
      if (item.detail) card.appendChild(el("p", null, item.detail));
      card.appendChild(el("p", null, item.source + " · " + new Date(item.at).toLocaleString()));
      target.appendChild(card);
    });
  }

  function addMessage(role, text) {
    var article = el("article", "message " + role);
    article.appendChild(el("div", "avatar", role === "user" ? "You" : "M"));
    var bubble = el("div", "bubble");
    bubble.appendChild(el("p", null, text));
    article.appendChild(bubble);
    var quick = document.getElementById("quick-actions");
    if (quick) quick.remove();
    messages.appendChild(article);
    messages.scrollTop = messages.scrollHeight;
  }

  function previewReply(question) {
    if (!snapshot) return "Current status is still loading. Please try again in a moment.";
    var query = question.toLowerCase();
    var c = counts();
    if (query.indexOf("attention") !== -1 || query.indexOf("block") !== -1) {
      if (!snapshot.attention.length) return "Nothing in the current snapshot needs attention.";
      return snapshot.attention.length + " item(s) need review. First: " + snapshot.attention[0].reason + ". Open Activity for the evidence and timestamp.";
    }
    if (query.indexOf("done") !== -1 || query.indexOf("complete") !== -1) {
      return c.done + " task(s) are marked done. Completion is inherited from the legacy board and is not yet an independent verification result.";
    }
    if (query.indexOf("current") !== -1 || query.indexOf("status") !== -1 || query.indexOf("work") !== -1) {
      return "The current snapshot has " + c.in_progress + " active, " + c.pending + " queued, and " + c.done + " done task(s), with " + snapshot.attention.length + " attention item(s).";
    }
    if (query.indexOf("project") !== -1) {
      return "This preview shows " + snapshot.projects.length + " legacy task(s). Persistent project grouping will be added with the Orchestrator state in Step 3.";
    }
    return "Preview mode can answer questions about current work, completed tasks, and attention items. It does not plan or assign Agent work yet.";
  }

  function submitMessage(text) {
    var clean = text.trim();
    if (!clean) return;
    addMessage("user", clean);
    addMessage("assistant", previewReply(clean));
  }

  document.getElementById("composer").addEventListener("submit", function (event) {
    event.preventDefault();
    submitMessage(input.value);
    input.value = "";
    input.focus();
  });

  document.querySelectorAll(".quick-action").forEach(function (button) {
    button.addEventListener("click", function () { submitMessage(button.textContent || ""); });
  });

  function selectScreen(screen) {
    document.querySelectorAll(".mobile-nav button").forEach(function (button) {
      button.setAttribute("aria-selected", String(button.getAttribute("data-screen") === screen));
    });
    document.getElementById("chat-pane").style.display = screen === "chat" ? "flex" : "none";
    ["projects", "activity"].forEach(function (name) {
      document.getElementById(name + "-pane").classList.toggle("mobile-active", name === screen);
    });
  }

  document.querySelectorAll(".mobile-nav button").forEach(function (button) {
    button.addEventListener("click", function () { selectScreen(button.getAttribute("data-screen") || "chat"); });
  });

  fetch("/api/snapshot")
    .then(function (response) {
      if (!response.ok) throw new Error("Snapshot request failed");
      return response.json();
    })
    .then(function (data) {
      snapshot = data;
      renderSummary("desktop-summary");
      renderSummary("mobile-summary");
      renderProjects();
      renderAttention("desktop-attention");
      renderAttention("mobile-attention");
      document.getElementById("sync-status").textContent = "Updated " + new Date(data.generatedAt).toLocaleTimeString();
    })
    .catch(function () {
      document.getElementById("sync-status").textContent = "Current work could not be loaded";
      ["desktop-attention", "mobile-attention", "mobile-projects"].forEach(function (id) {
        document.getElementById(id).innerHTML = '<p class="empty">The local snapshot is unavailable.</p>';
      });
    });
})();
</script>
</body>
</html>`;
