# Moby AI command center: architecture checkpoint

Status: proposed implementation design; repository review complete, product not implemented.
Baseline: `main` at `4e61c9621bd316dcbf96bcee89b486b0fe8b42f1`.

## User-approved direction

Single-user, private access from phone, laptop, and Mac mini. The home screen
centers on natural-language conversation with the Orchestrator. Work is organized
by project. The Orchestrator coordinates execution, verifies results, and tracks
follow-ups, with proactive low-risk work inside defined limits. Continuous
availability should be event-driven, without an idle model loop. Default updates
show status, result, and next action. First-release outcomes are project visibility,
one conversation for assigning work, and reliable delegation/progress tracking.

At each checkpoint, recommend a model for the next step. Recommendations are not
provider activation, API-spend authorization, or a claim that the current model
was changed. Existing paused work remains paused unless explicitly resumed.

## Evidence and reuse decisions

| Existing code | Finding | Decision |
| --- | --- | --- |
| `src/dashboard/page.ts` | Responsive HTML, board, filters, notes, attention and operational feeds; no conversation interface | Reuse the information and accessible controls; introduce a chat-first layout with project navigation |
| `src/dashboard/snapshot.ts` | Each coworker task becomes a `ProjectView`; stale status is inferred from reports | Add actual project grouping; preserve provenance and show stale reports as unconfirmed rather than verified outages |
| `src/dashboard/server.ts` | Task creation/dispatch/completion mutate records; dispatch does not start a worker; no authentication | Retain compatibility; do not equate assignment with execution; add private authenticated access before remote exposure |
| `src/packs/dispatcher/pack.ts` | Claude-backed, tool-free planner returning ordered JSON; intentionally nonconversational | Reuse planning through an application module; add a separate conversational Orchestrator Agent |
| `src/core/workflow-runner.ts` | Sequential delegation, pause/resume, run-update hooks | Reuse execution; add durable workflow transitions and recovery before unattended operation |
| `src/cli/dispatch-commands.ts` | Workflow saved before and after execution; individual runs saved during execution | Extract shared application orchestration for CLI and web; close crash window between run creation and workflow linkage |
| `src/core/orchestrator.ts` | Exact-input approval checks; all approved actions enter waiting-for-response | Preserve checks; distinguish immediate completion from actions actually waiting for a reply |
| `src/core/run.ts` | Successful model completion is not independent result verification | Track verification separately with evidence and task acceptance criteria |
| `src/coworker/store.ts` | Direct JSON writes and no compare-and-swap | Do not use as a concurrent multi-device execution queue |
| `src/store/workflow-store.ts` | Atomic rename protects individual writes, not concurrent claims or multi-record transactions | Keep adapter contract; use transactional private state for worker claims and events |
| `src/config/load.ts`, `src/providers/` | Anthropic and fake providers are wired; no OpenAI adapter | Retain Claude; recommended OpenAI models require a separately implemented and tested provider |

The registry document was last reconciled September 7 and contains statements
superseded by September 16 commits and Issue #1. Importing it must preserve source
dates and uncertainty, not label every entry current or runnable.

`origin/claude/riley-dashboard-feedback-tasks` has one commit absent from main,
`b3ade72`, containing three feedback tasks, not an alternative dashboard
implementation: polished visual hierarchy, discoverable task/update controls,
and scannable status text. Incorporate those concepts without merging that branch.
The earlier dashboard benchmark also informs attention queues and progress views.
Open PR #33 is separate trading work; leave it unmerged and out of this scope.

## Proposed user experience

Desktop: project navigation on the left, Orchestrator conversation in the center,
and an optional task/progress panel. Mobile: full-width conversation with Chat,
Projects, and Activity navigation; task details open on demand. Keep the composer
visible, use concise cards, keyboard-accessible controls and clear empty/error states.

Each project has a purpose, active/paused state, tasks, results, and next action.
Each task exposes owner, status, last observed update, verification, and blocker.
Retain the board as a secondary project view. Agent roster and diagnostic logs
belong in details rather than dominating the home screen. Unmapped legacy tasks
appear as ungrouped; never silently guess project membership from free text.

## Proposed implementation structure

1. Keep Core pure and model-agnostic. Domain behavior stays in Packs.
2. Add an application module shared by web and CLI. Its small interface accepts
   messages, retrieves project/task state, and handles explicit control actions.
   It owns input validation, policy enforcement, persistence and dispatch linkage.
3. Add a conversational Orchestrator Pack with narrow tools: inspect project state,
   propose a plan, enqueue allowed work, inspect results, and record follow-ups.
   It cannot invent available workers or grant itself permissions.
4. Use the existing workflow runner for registered in-process Agents. Machine-local
   personas need a separate worker protocol with capability and availability checks.
   Naming a Claude/Polar session is not a connection to that session.
5. Proposed private runtime storage: a transactional store (SQLite for one host),
   behind injected interfaces with in-memory test adapters. Store conversations,
   projects, task links, workflow checkpoints, events and worker leases outside Git.
   Validate the runtime/driver choice before implementation. Keep versioned code,
   public-safe design notes and sanitized handoffs in Git.
6. Start with one execution host and bounded concurrency. Assign idempotency keys
   to submitted messages and events. Claim work transactionally, checkpoint before
   tool execution, and reconcile interrupted work. An uncertain external side effect
   goes to review; never automatically repeat a send after a crash.
7. Separate completed execution from verification. A verifier checks task-specific
   evidence; automated tests and source checks supplement model review. A claimed
   result alone cannot produce a verified badge.
8. Continuous operation uses durable scheduled/events work, bounded retries and
   budgets. No recurring model call merely to discover an empty queue. Store and
   enforce project pause state before queueing and again before execution.

Private remote access requires authenticated sessions, HTTPS, origin/CSRF defenses
for writes and event streams, and authorization on every route. Do not expose the
existing unauthenticated dashboard with a public tunnel. The hosting/authentication
provider remains undecided; prepare locally before any external deployment.

The new conversation interface must explicitly distinguish demo mode, configured
provider mode, unavailable tools, stale workers and live execution. Existing fake
integration fallbacks must not be presented as real mailbox/browser capabilities.

## Delivery checkpoints and acceptance criteria

| Step | Deliverable | Evidence of completion | Recommended development model |
| --- | --- | --- | --- |
| 1 | Architecture review and this handoff | Read relevant code, inspect dashboard branch, run baseline tests | Completed review; no runtime changes |
| 2 | Responsive chat/project interface in isolated development mode | Phone/desktop visual checks; real legacy read adapter; explicit demo chat; old task views remain accessible | GPT-5.6 Sol, medium reasoning |
| 3 | Persistent conversation and Orchestrator vertical slice | Message -> plan -> real registered Agent -> linked result; survives reload; blocked capability reported accurately | GPT-5.6 Sol, high reasoning |
| 4 | Durable execution and verification | Crash/restart, duplicate submission, competing claim, pause, approval mismatch, retry bounds and verification-failure tests | GPT-6 Astra, high reasoning for design/review; Sol for implementation |
| 5 | Private access and deployment preparation | Unauthenticated access denied; authenticated phone use; session expiry; CSRF; secrets remain server-side | GPT-6 Astra, high reasoning for review |
| 6 | Verified pilot | One approved low-risk project end-to-end; actual cost/latency measured; rollback and sanitized handoff | GPT-5.6 Sol, high reasoning |

Step 2 must not display a scripted response as a working AI Agent. Step 3 may use
deterministic providers in tests, but real-provider readiness must be checked
separately. No live messaging, job submissions, trades or paid calls are required
for these initial development checks. Do not restart existing scheduled services.

## Model routing proposal

Sol for normal orchestration, Terra for routine specialist work, Luna for narrow
classification/summaries, Astra for complex escalation. Keep routing configurable
and evaluate task success, latency and total cost before choosing defaults.
Scheduling, permissions and bookkeeping require no model. Provider availability,
credentials, a spending ceiling and retry limits must be established before live
unattended execution. No runtime model configuration changed in this checkpoint.

## Validation and continuation

Fresh clone from origin, Node v24.19.0; `npm ci --ignore-scripts` succeeded.
`npm test`: 580 passed, 0 failed, 0 skipped. These are isolated baseline tests,
not evidence that the user's Mac mini or external integrations are healthy.

Continue with Step 2 on this branch after checking origin for new work. Read this
file and the existing cross-team handoff. Implement a responsive chat/project
shell around existing dashboard data without live execution or changing the
running Mac mini. Preserve the old task controls and display demo conversation
honestly. Verify mobile, keyboard and desktop behavior, then recommend the model
for Step 3. No external deployment, branch merge or live worker activation has
occurred. This checkpoint must be pushed before another client can retrieve it
from GitHub; local preparation alone is not cross-client synchronization.
