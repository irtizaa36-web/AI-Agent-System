
# Project Registry

Maintained by Big Boss (Polar). Lifecycle: `Queued -> In progress -> Blocked -> Awaiting approval -> Completed -> Verified`.
No credentials, tokens, cookies, or personal identifiers are recorded here. Personal, financial, and clinical detail live outside this public repository; this registry holds pointers only.

Last reconciled: **2026-09-07, Big Boss session (Polar)**.

---

## 1. AI-agent system architecture & development ("Moby AI")

- **Purpose:** Reusable, model-agnostic agent orchestration engine (Core, Providers, Tools, Registry, Packs, Store, CLI).
- **Phase / Priority:** In progress · P2 (deprioritized today per user; see Decisions below)
- **Source of truth:** `github.com/irtizaa36-web/AI-Agent-System` (branch `main`)
- **Active tasks:** First real domain Pack (A&I Research candidate) — design stage, not started.
- **Delegate:** Team A (Sam) / Team B (PinkyBaby) via GitHub, when active.
- **Dependencies/Blockers:** No blockers on the engine itself. See Section 3 (Coworker fleet) for the stalled multi-agent layer built on top of it.
- **Next checkpoint:** User decision on coworker-fleet revival vs. park (open).
- **Last verified:** 2026-09-07 — CI green (`main`, run #34+), README/CLAUDE.md/PROJECT-BRAIN.md/CONTEXT.md read directly.

## 2. Coding & GitHub operations

- **Purpose:** Repository hygiene, CI, issue/PR management for the AI-Agent-System repo.
- **Phase / Priority:** In progress · P3
- **Source of truth:** GitHub Actions + Issues on the same repo.
- **Active tasks:** None open beyond Section 1. Issue #1 (coworker coordination) is stale since 2026-09-04.
- **Delegate:** none currently assigned.
- **Dependencies/Blockers:** none blocking.
- **Next checkpoint:** Decide whether to close/replace Issue #1 once the coworker-fleet decision is made.
- **Last verified:** 2026-09-07 — Actions tab, last 5 runs green; PR list read (30 PRs, all show `merged:false` but content is present on `main`, consistent with squash-merge).

## 3. Coworker fleet / multi-agent continuity layer

- **Purpose:** The Claude-Code-based "coworker loop" (personas: Coordinator/Sam, macmini/Max, Laptop2/Lucy, Jordan, Riley, PinkyBaby) that runs tasks via `coworker/tasks/*.json`, a local dashboard (`localhost:4317`), and a local Inkbox mail webhook (`localhost:8787`).
- **Phase / Priority:** Blocked · P4 (explicitly deprioritized by user, 2026-09-07 — "little concern... don't want us using credits on things we don't need to prioritize")
- **Source of truth:** `coworker/README.md`, `coworker/tasks/*.json`, GitHub Issue #1, the live dashboard.
- **Active tasks:** 7 of 13 tasks open (2 dispatched/blocked on a local permission classifier, 1 failed, 1 in-progress awaiting approval, 3 never dispatched).
- **Delegate:** This fleet lives on the user's own Claude Code account/hardware (Mac Mini, Windows laptop), not on Polar.
- **Dependencies/Blockers:** All 5 personas offline since 2026-09-03/04. Local services (`:4317`, `:8787`) are still up and healthy.
- **Next checkpoint:** User to decide revive-on-Claude-Code vs. formally park. A lightweight Polar-native equivalent (using Polar scheduled workflows instead of a persona fleet) was discussed as a future option — not being built now per user priority.
- **Last verified:** 2026-09-07 16:30 CT — dashboard HTTP 200, all personas "Offline"; webhook health endpoint HTTP 200.

## 4. Job search & applications — Irtiza (own)

- **Purpose:** Remote, part-time (5-10 hr/wk) medical-education advising/tutoring and AI clinical-expert contract work.
- **Phase / Priority:** In progress · **P1 (today's priority #2)**
- **Source of truth:** Gmail (`irtizaa36@gmail.com`) + Polar `/daily-job-search` workflow + `/home/project/Application_Tracker.md` (workflow-scoped folder, not reachable from general Polar sessions).
- **Active tasks:** Continue today's sweep — follow-ups, unblock stalled applications, submit new-fit roles.
- **Delegate:** Polar `/daily-job-search` workflow (autonomous submit, no-send-email, no-interview rules already in force).
- **Dependencies/Blockers:** Tracker/CV/cover-letter files live in a project-scoped folder invisible to this general session — continuity risk, not a task blocker.
- **Next checkpoint:** Today's continuation run (this session).
- **Last verified:** 2026-09-07 — 11 applications confirmed submitted via Gmail acknowledgments (Mercor x4, TrueLearn, Everlywell, Aptura, Weekday AI, BeMo, MedSchoolCoach, Meridial).

## 5. Job search — Shivani (Project Shivani)

- **Purpose:** Separate job-search-agent thread for the user's wife, run through the coworker fleet's `job-search-agent` Pack, coordinated via iMessage check-ins.
- **Phase / Priority:** **Conflicting state — needs a decision, not yet resolved**
- **Source of truth:** GitHub PR #26 ("Retire Project Shivani, pause all non-Dashboard work") vs. dashboard task showing the recurring "Shivani's job-search check-in" still `dispatched` vs. coworker task `38fd59e8` implying it was restarted.
- **Active tasks:** None running (all personas offline).
- **Delegate:** macmini persona (offline).
- **Dependencies/Blockers:** Three sources disagree on whether this project is retired or active.
- **Next checkpoint:** Awaiting user clarification on current intent for this project.
- **Last verified:** 2026-09-07 — read PR #26, dashboard task list, task `38fd59e8` note.

## 6. Residency, academic & conference planning

- **Purpose:** PGY-2 IM residency schedule, conference calendar, application/exam deadlines.
- **Phase / Priority:** In progress · P2
- **Source of truth:** **Outlook** (Houston Methodist mail) — connector unavailable; mirrored manually into Google Calendar.
- **Active tasks:** None pending action; calendar current through mid-Sep.
- **Delegate:** none.
- **Dependencies/Blockers:** Outlook connector cannot be used; user will open an authenticated browser tab instead so Polar can read it directly.
- **Next checkpoint:** Once the Outlook tab is open, re-verify the bHeme/PTO Sep 7-20 vs. Sep 1-30 conflict noted in the calendar.
- **Last verified:** 2026-09-07 — Google Calendar read directly; Outlook not yet reachable.

## 7. Personal administration

- **Purpose:** Routine personal/admin tasks (MyChart, Drive cleanup, correspondence).
- **Phase / Priority:** Queued · P4
- **Source of truth:** Gmail, Houston Methodist MyChart, Google Drive.
- **Active tasks:** MyChart "Daily Incision Check" task outstanding (user action).
- **Delegate:** none — user-only action.
- **Dependencies/Blockers:** none.
- **Next checkpoint:** none scheduled.
- **Last verified:** 2026-09-07 — Gmail read.

## 8. Financial / trading automation research — Public.com agents

- **Purpose:** Two automated crypto trading agents (BTC/SOL/ETH; altcoins), built as Public.com Agents.
- **Phase / Priority:** In progress · **P1 (today's priority #1)**
- **Source of truth:** Public.com Agents UI (`public.com/agents`), browser-only, no API connector.
- **Active tasks:** "Altcoin Trading Agent" went live 2026-09-07 15:42 CT. User wants it making active (real-money) trades starting today.
- **Delegate:** none yet — requires explicit, specific authorization per trade-enabling action (see Decisions/Next Actions).
- **Dependencies/Blockers:** Per standing safety rule, live trading requires the user's specific authorization for the exact action (budget, coins, risk controls), not a blanket go-ahead. Not yet authorized to a specific parameter set.
- **Next checkpoint:** Read-only inspection of current agent config and activity log, then confirm exact live-trade parameters with user before any activation.
- **Last verified:** 2026-09-07 — Gmail confirms agent-live notification, deposit processing, two SoFi crypto orders completed; agent's own run health not yet inspected this session.

---

### Decisions on record (2026-09-07)

- Coworker fleet / dashboard: **deprioritized**, not being rebuilt or revived on Polar right now.
- Today's priority #1: Public.com crypto trading agent — move toward live trading, pending specific parameter confirmation.
- Today's priority #2: continuation of Irtiza's own job search (Section 4).
- Project Shivani (Section 5) status unresolved — awaiting user input.
- Outlook: connector unusable; user to open an authenticated tab for direct browser access instead.
