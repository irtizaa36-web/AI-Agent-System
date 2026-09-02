# PROJECT-BRAIN.md

A permanent, plain-English briefing document for this repository. It exists for two audiences: Irtiza (the product/domain owner, not required to read TypeScript), and any future Claude Code session picking this project back up cold. Read this before any major architectural work.

This document describes the repository **as it actually exists**, checked directly against the code and `docs/adr/*` at the time of writing (3 commits: `ccb193e`, `24139fa`, `c46c39c`; 33 passing tests). Where something is planned rather than built, it is explicitly labeled as such.

---

## 1. What we are building

**AI-Agent-System** is a reusable engine for running AI agents against tasks — not a single application, but the shared foundation underneath several unrelated future products. The long-term vision is to run a family of specialized "agent packs" (see Section 4) on top of one generic orchestration engine, so that building the second and third product is mostly a matter of adding new configuration and prompts, not rewriting the engine.

It's built to be:
- **CLI-first now, service-ready later** — usable from a terminal today, without redesigning it to add a web API in the future.
- **Model-agnostic** — Claude is the default AI model, but the engine isn't wired specifically to Claude; other providers (e.g. Fable, or others) can be added later without changing the core logic.
- **Domain-agnostic at its core** — the engine itself knows nothing about medicine, research, or careers. Domain expertise lives in separate, pluggable "Packs" (Section 4).

## 2. What currently exists

Plain-English explanations of every implemented piece, in `src/`:

- **Core** (`src/core/`) — the heart of the system, with zero direct interaction with the outside world (no network calls, no file access, no calling other programs). It defines the basic vocabulary the whole system uses (see below) and the logic that drives one agent through one task, step by step, to a result. Keeping this piece "pure" like this means it's fast and simple to test, and it can't accidentally do something risky (like sending a real email) itself — only the pieces built specifically to talk to the outside world can do that.
  - **Task** — a unit of work you hand to the system: instructions plus a unique ID. A request, not yet an execution.
  - **Agent** (definition) — a configured persona: which AI model it uses, its instructions ("system prompt"), and which Tools it's allowed to use. This is a description on paper, not something running.
  - **Session** — the growing conversation history (system instructions, your message, the AI's replies, tool results) that gets shown to the AI model on every turn.
  - **Run** — one actual execution of a Task by an Agent. It has a status (queued → running → succeeded/failed), a timestamp for when it started and when it finished, and a full record of every step taken.
  - **Step** — one single back-and-forth turn within a Run: the AI's response, any tools it asked to use, and when that happened.
  - **Result** — the final outcome of a Run: whether it succeeded or failed, and the output text (or error).
- **Orchestrator** (`src/core/orchestrator.ts`) — the actual "conductor" logic living inside Core. It starts a Run, repeatedly advances it one Step at a time (ask the AI model something, run any tools it requests, feed the results back), and stops when the Run succeeds, fails, or hits a safety cap on how many steps it's allowed to take (to prevent an agent looping forever).
- **Agents** — currently there are exactly two, both examples/placeholders rather than real products (see Packs below): `default` (uses the real Claude model) and `demo` (uses a fake, scripted model for testing/demos that require no API key or cost).
- **Packs** (`src/packs/`) — a "Pack" is a self-contained bundle of Agents (and, eventually, their own Tools) for one product or domain. Right now there is exactly one: `core-demo`, holding the two placeholder agents above. This is intentionally not a real product — it exists to prove the pattern works before any real domain content (IM Brain, etc.) is built on top of it.
- **Model providers** (`src/providers/`) — the adapters that actually talk to an AI model vendor's API. There are two: `anthropic.ts` (talks to Claude's real API — requires an API key, which is deliberately not configured in this project yet) and `fake.ts` (a scripted, deterministic stand-in used for tests and for running the CLI demo without needing a real API key or spending any money).
- **Tools** (`src/tools/`) — capabilities an AI agent can use mid-conversation to act on the world, beyond just talking. There is currently exactly one: `read-file`, which lets an agent read the contents of a text file from disk. No other tools (email, web browsing, etc.) exist yet.
- **Registry** (`src/registry/`) — a simple lookup system: a place where Agents, Providers, and Tools are each registered under a name, so the system can find "the agent called X" or "the tool called Y" when it needs to.
- **Config** (`src/config/load.ts`) — the "wiring" step that runs when the program starts: it registers the built-in Providers and Tools, then loads whichever Packs are currently enabled (today, just `core-demo`).
- **Store** (`src/store/run-store.ts`) — where the history of a Run gets saved so it can be looked at later. There are two versions: one that only keeps history in memory (used for fast tests), and one that saves each Run as a JSON file on disk (used by the actual CLI, under a `.orchestrator/` folder that is not saved to Git).
- **CLI** (`src/cli/index.ts`) — the command-line program you actually run. It supports three commands: `run` (execute a task through an agent), `list-agents` (show what agents exist), and `help`.
- **Tests** — 33 automated tests currently exist and pass, covering Core's step-by-step logic, both providers, the tool, the registry, the pack, the config wiring, the run history storage, and the CLI itself. They use Node's own built-in test runner, so no extra testing library was added.
- **Documentation** — `CONTEXT.md` (a glossary defining every project-specific term precisely, so "Task" vs. "Run" vs. "Pack" always mean the same thing) and `docs/adr/` (four short "Architecture Decision Records" explaining *why* certain structural choices were made, listed in Section 5).
- **Git/GitHub** — this is a real Git repository with 3 commits so far, pushed once to a private GitHub repository (`github.com/irtizaa36-web/AI-Agent-System`) after the first commit; the two most recent commits exist locally only and have not been pushed yet.

## 3. What we have actually accomplished

Concrete, tested, working capabilities as of today:

- You can run a task through the AI orchestration engine from the command line and get a real result back.
- You can do this entirely for free and offline, using the built-in fake/demo agent — no API key, no cost, fully repeatable.
- The engine is also wired to run tasks through real Claude models, but this path has never actually been exercised (no API key has been configured, and none should be, per current instructions) — it is built and its "no key configured" error path is tested, but a real Claude call has never been made.
- Every Run's full history (what was asked, what the AI said, what tools ran, when each step happened) is automatically saved to disk as a readable JSON file.
- The system can look up available agents and reject unknown ones with a clear error message.
- The pattern for adding a brand-new domain (a "Pack") has been proven end-to-end, though only with placeholder content — no real domain (medical, research, career) content exists yet.
- 33 automated tests cover this behavior and all currently pass; the TypeScript build compiles cleanly with strict type-checking on.

## 4. Long-term product vision

Three future products are planned, none of which are built yet:

- **IM Brain** — clinical reasoning, differential diagnosis, diagnostic planning, management reasoning, teaching, and evidence verification. Explicitly educational/clinical decision-support — not autonomous patient care, and not an EHR-connected system.
- **A&I Research Agent** — identifying research/publication opportunities, literature search, novelty assessment, case-report opportunities, retrospective study ideas, study design, data collection planning, analysis, abstract/manuscript development, journal/conference targeting, and citation/evidence verification.
- **Medical Career Advisor** — pre-med advising, medical school application guidance, personal statement/application review, interview prep, residency and fellowship application guidance, specialty selection, program research, and research/career planning — potentially with a human consultant in the loop (the real-world "Scholr" consulting role is one example of what this could look like).

**Each of these should be built as a domain-specific Pack** (its own Agent definitions, prompts, and eventually its own Tools) sitting on top of the generic, unchanged Core — not as special-case logic hard-coded into the engine itself. None of the three has any code written for it yet.

## 5. Important architectural principles

These are the standing rules this project has committed to, most of them recorded formally in `docs/adr/`:

- **Core remains domain-agnostic.** The engine must never contain medical, research, or career-specific logic.
- **Domain-specific logic belongs in Packs**, not in Core (ADR 0003).
- **Model providers should remain replaceable.** Adding a new AI vendor should never require changing Core (ADR 0001).
- **Prefer small, composable components** — deep, focused modules behind simple interfaces, rather than large, tangled ones.
- **Avoid unnecessary dependencies and infrastructure.** The whole project currently has zero runtime dependencies — only TypeScript itself as a development tool (ADR 0002).
- **Test important behavior.** All 33 pieces of behavior described above are covered by automated tests, not just claimed to work.
- **Build infrastructure when a real use case requires it, not speculatively.** Several deferred items in Section 7 are deferred specifically because building them without a real use case to design against would mean guessing.
- **Consequential capabilities must be split into safe read/draft operations and separate, gated send/execute operations** (e.g. a `draft-email` tool must be a different tool from `send-email`) (ADR 0004).
- **Human approval / "approval-gating" for risky actions is intentionally not built into Core yet.** It will be designed once a real consequential tool (e.g. actually sending an email) exists to design it against, rather than guessed at now (ADR 0004).

## 6. Safety / medical boundaries

These boundaries apply to all future medical-domain work (IM Brain, and the medical aspects of the Research Agent and Career Advisor):

- Any future medical system is for **education and clinical decision support only** — never autonomous patient care.
- **Do not autonomously make clinical decisions.** A clinician remains the decision-maker at all times.
- **Do not perform EHR (Electronic Health Record) actions.** No system built here should read from or write to a real patient's medical record.
- **Avoid PHI** (Protected Health Information — real, identifiable patient data). Development and examples should use de-identified or fictional cases.
- **Important medical/research outputs require appropriate human verification** before being relied upon or acted on.
- **Research agents must not fabricate citations or overstate novelty.** Anything presented as a citation or a "this hasn't been done before" claim must be genuinely verified, not invented or assumed.

## 7. What we are NOT building yet

Explicitly deferred, not started, and not to be built without a separate, explicit decision to do so:

- A full multi-step **workflow engine** (chaining multiple agents/tasks together automatically).
- **Human-in-the-loop infrastructure** (a way for a Run to pause and wait for a person's approval or input).
- **Browser automation** (an agent controlling a web browser).
- **Email or SMS automation** (reading, drafting, or sending real messages).
- **Computer-control tools** of any kind (clicking, typing, controlling apps on the Mac).
- **EHR integration** of any kind.
- **Deployment infrastructure** (servers, hosting, CI/CD pipelines, containers).
- **Unnecessary databases or external services** — the project currently uses only local JSON files for storage.
- **Configuring `ANTHROPIC_API_KEY` or incurring any API billing**, unless and until explicitly decided later.

## 8. Development workflow

**PLAN → DELEGATE → IMPLEMENT → TEST → VERIFY → INTEGRATE → DELIVER**

Division of responsibility:

- **Irtiza** is the product/domain owner: sets direction, makes product and medical/domain-judgment decisions, and approves architecture before it's built.
- **Claude Code** is the engineering agent: proposes architecture for approval, writes and tests the code, runs builds/tests, and reports back in plain English.
- Irtiza does **not** need to read every line of TypeScript or run every terminal command personally to stay in control of this project — reviewing summaries and approving proposals is sufficient.
- **ChatGPT** plays a separate, complementary role: translating technical decisions into plain English and helping think through architecture/product decisions, outside of this coding environment.

## 9. How future Claude sessions should behave

Any Claude Code session picking up this project should:

- Read `PROJECT-BRAIN.md` and the relevant ADRs in `docs/adr/` before doing major architectural work.
- Inspect the actual, current code before proposing changes — never assume the codebase matches what a past conversation described.
- Avoid unnecessary redesign. Prefer the smallest change that solves the actual problem.
- Use appropriate installed Matt Pocock skills (domain-modeling, codebase-design, etc.) when they fit the task.
- Test changes, and actually run the tests/build rather than assuming they pass.
- Explain what was actually produced in plain English, suitable for a non-engineer to understand.
- Clearly distinguish between what exists today and what is merely planned or proposed — never describe planned work as if it were already built.
- Ask for clarification when a major product decision is ambiguous, rather than guessing.

## 10. Current roadmap (high-level only)

This is a directional sketch, not a committed plan or a detailed implementation schedule. Not all of it may end up being built, and nothing here should be treated as scheduled work.

1. **Foundation** — the reusable engine itself: Core, Providers, Tools, Registry, Packs, Store, CLI. *(Largely in place today, as described in Sections 2–3.)*
2. **First useful domain Pack** — build one real Pack (most likely IM Brain, A&I Research Agent, or Medical Career Advisor — not yet decided) to prove the architecture holds up for a real product, not just a placeholder.
3. **Verification** — introduce real evidence/citation verification behavior once a domain pack actually needs it (e.g. IM Brain's evidence verification, or the Research Agent's citation checking).
4. **More domain Packs** — build out the remaining planned domains once the pattern is proven.
5. **Controlled external capabilities** — if and when justified, carefully introduce tools that touch the outside world (email, browser automation, order tracking, etc.), each split into safe read/draft vs. gated send/execute per ADR 0004, with human-approval infrastructure designed at that point.
6. **Production hardening** — if this grows beyond a local CLI tool (e.g. toward the "service" half of the CLI-first/service-ready design), address deployment, persistence beyond local JSON files, and related concerns at that time.

Each stage is intended to be justified by an actual need at the time, not built ahead of it — consistent with Section 5's "build infrastructure when a real use case requires it."
