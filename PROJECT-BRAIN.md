# PROJECT-BRAIN.md

A permanent, plain-English briefing document for this repository. It exists for two audiences: Irtiza (the product/domain owner, not a software engineer, and not expected to read TypeScript or run terminal commands personally), and any future Claude Code session picking this project back up cold. Read this before any major architectural work.

This document describes the repository **as it actually exists**, checked directly against the code and `docs/adr/*` at the time of writing (latest commit `1e2d0c2`; 42 passing tests). Where something is planned rather than built, it is explicitly labeled as such.

---

## 1. What we are building

**AI-Agent-System** is a **general-purpose AI agent orchestration system** — a reusable engine for running AI agents against tasks, not a single application. It is **not** pivoting into a medical application, an email assistant, or a computer-automation product; medicine (IM Brain, A&I Research, Medical Career Advisor) is one planned family of things built *on top of* this engine, not what the engine itself is.

Conceptually, the intended shape is:

```
YOU
 ↓
ORCHESTRATOR
 ↓
AGENTS / PACKS
 ↓
MODELS + TOOLS
 ↓
RESULT
 ↓
VERIFICATION
 ↓
DELIVERY
```

You give the system a task; the Orchestrator (Section 2) runs it through an Agent belonging to some Pack; that Agent uses a Model and, optionally, Tools to produce a Result; important results get checked before being treated as final; then the result is delivered back to you. "Verification" and "Delivery" here describe the intended shape of the pipeline, not a built component yet — see Section 3.

It's built to be:
- **CLI-first now, service-ready later** — usable from a terminal today, without redesigning it to add a web API in the future.
- **Model-agnostic** — Claude is the default AI model, but the engine isn't wired specifically to Claude; other providers (e.g. Fable, or others) can be added later without changing the core logic.
- **Domain-agnostic at its core** — the engine itself knows nothing about medicine, research, or careers. Domain expertise lives in separate, pluggable "Packs" (Section 5).
- **Able to grow substantially without repeatedly redesigning the Core** — adding a new domain, model, tool, or external service should mean adding to the system, not rewriting its center.

## 2. Future external capabilities the architecture must remain compatible with

None of the following are built. This section exists so that current and future decisions don't accidentally make them hard to add later.

Eventually, this system should be able to interact with:
- **Computer/files** (partially true today — see the `read-file` tool in Section 3)
- **Email**
- **Messaging/texts**
- **Calendar**
- **Web/browser**
- **GitHub**
- **Other external services**, as they become relevant

For any of these, once built, the architecture should distinguish three tiers of action, not two:
- **Read/analyze** — safe, freely-executable (e.g. reading a file, checking a calendar).
- **Draft** — prepares something (an email, a form submission) without sending or committing it.
- **Send/execute/modify/delete** — consequential and hard to reverse; must eventually require appropriate authorization, auditability, and human control before it happens.

This three-tier split, and the decision to defer building the actual human-approval mechanism until a real consequential tool exists, is already recorded in `docs/adr/0004-consequential-tools-and-deferred-approval-gating.md`. **Nothing here is being built now** — this section is a constraint on future design, not a task list.

## 3. What currently exists

Plain-English explanations of every implemented piece, in `src/`:

- **Core** (`src/core/`) — the heart of the system, with zero direct interaction with the outside world (no network calls, no file access, no calling other programs). It defines the basic vocabulary the whole system uses (see below) and the logic that drives one agent through one task, step by step, to a result. Keeping this piece "pure" like this means it's fast and simple to test, and it can't accidentally do something risky (like sending a real email) itself — only the pieces built specifically to talk to the outside world can do that.
  - **Task** — a unit of work you hand to the system: instructions plus a unique ID. A request, not yet an execution.
  - **Agent** (definition) — a configured persona: which AI model it uses, its instructions ("system prompt"), and which Tools it's allowed to use. This is a description on paper, not something running.
  - **Session** — the growing conversation history (system instructions, your message, the AI's replies, tool results) that gets shown to the AI model on every turn.
  - **Run** — one actual execution of a Task by an Agent. It has a status (queued → running → succeeded/failed), timestamps for when it started and finished, and a full record of every step taken.
  - **Step** — one single back-and-forth turn within a Run: the AI's response, any tools it asked to use, and when that happened.
  - **Result** — the final outcome of a Run: whether it succeeded or failed, and the output text (or error).
- **Orchestrator** (`src/core/orchestrator.ts`) — the actual "conductor" logic living inside Core. It starts a Run, repeatedly advances it one Step at a time (ask the AI model something, run any tools it requests, feed the results back), and stops when the Run succeeds, fails, or hits a safety cap on how many steps it's allowed to take (to prevent an agent looping forever).
- **Agents** — currently there are exactly two, both examples/placeholders rather than real products (see Packs below): `default` (uses the real Claude model) and `demo` (uses a fake, scripted model for testing/demos that require no API key or cost).
- **Packs** (`src/packs/`) — a "Pack" is a self-contained bundle of Agents (and, eventually, their own Tools) for one product or domain. Right now there is exactly one: `core-demo`, holding the two placeholder agents above. This is intentionally not a real product — it exists to prove the pattern works before any real domain content (IM Brain, A&I Research, etc.) is built on top of it.
- **Model providers** (`src/providers/`) — the adapters that actually talk to an AI model vendor's API. There are two: `anthropic.ts` (talks to Claude's real API — requires an API key, which is deliberately not configured in this project) and `fake.ts` (a scripted, deterministic stand-in used for tests and for running the CLI demo without needing a real API key or spending any money).
- **Tools** (`src/tools/`) — capabilities an AI agent can use mid-conversation to act on the world, beyond just talking. There is currently exactly one: `read-file`, which lets an agent read the contents of a text file from disk. No other tools (email, web browsing, calendar, GitHub, etc.) exist yet.
- **Registry** (`src/registry/`) — a simple lookup system: a place where Agents, Providers, and Tools are each registered under a name, so the system can find "the agent called X" or "the tool called Y" when it needs to.
- **Config** (`src/config/load.ts`) — the "wiring" step that runs when the program starts: it registers the built-in Providers and Tools, then loads whichever Packs are currently enabled (today, just `core-demo`).
- **Store** (`src/store/run-store.ts`) — where the history of a Run gets saved so it can be looked at later. There are two versions: one that only keeps history in memory (used for fast tests), and one that saves each Run as a JSON file on disk (used by the actual CLI, under a `.orchestrator/` folder that is not saved to Git).
- **CLI** (`src/cli/index.ts`) — the command-line program you actually run. It supports four commands: `run` (execute a task through an agent), `list-agents` (show what agents exist), `status` (a live snapshot of agents/providers/tools/packs, test results, and Git state), and `help`.
- **Tests** — 42 automated tests currently exist and pass, covering Core's step-by-step logic, both providers, the tool, the registry, the pack, the config wiring, the run history storage, and the CLI itself (including its `status` command). They use Node's own built-in test runner, so no extra testing library was added.
- **Documentation** — `CONTEXT.md` (a glossary defining every project-specific term precisely, so "Task" vs. "Run" vs. "Pack" always mean the same thing) and `docs/adr/` (five short "Architecture Decision Records" explaining *why* certain structural choices were made, listed in Section 6).
- **Git/GitHub** — a real Git repository, pushed to a private GitHub repository (`github.com/irtizaa36-web/AI-Agent-System`); `main` was fully in sync with `origin/main` as of the last push.

## 4. What we have actually accomplished

Concrete, tested, working capabilities as of today:

- You can run a task through the AI orchestration engine from the command line and get a real result back.
- You can do this entirely for free and offline, using the built-in fake/demo agent — no API key, no cost, fully repeatable.
- The engine is also wired to run tasks through real Claude models, but this path has never actually been exercised (no API key has been configured, and none should be, per current instructions) — it is built and its "no key configured" error path is tested, but a real Claude call has never been made.
- Every Run's full history (what was asked, what the AI said, what tools ran, when each step happened) is automatically saved to disk as a readable JSON file.
- The system can look up available agents and reject unknown ones with a clear error message.
- The pattern for adding a brand-new domain (a "Pack") has been proven end-to-end, though only with placeholder content — no real domain (medical, research, career) content exists yet.
- 33 automated tests cover this behavior and all currently pass; the TypeScript build compiles cleanly with strict type-checking on.

Nothing beyond this list has been built. In particular: no domain Pack exists yet, no external-service tool exists yet, and no human-approval mechanism exists yet.

## 5. Long-term product vision: Domain Packs

The Core stays domain-agnostic (Section 7). All domain-specific capability is meant to live in Packs — self-contained bundles of Agents and, eventually, their own Tools. Four future Packs are currently planned; **none has any code written for it yet**:

- **A&I Research** — a research assistant focused on Allergy & Immunology. Potential eventual capabilities: literature research, evidence synthesis, identifying research questions, novelty/gap analysis, case-report opportunities, retrospective study ideas, study design, variables and statistics, abstracts, manuscripts, conference/journal targeting, citation/reference verification, and research project tracking. Not all of these are being built now — see Section 8 and 10 for how this gets built incrementally.
- **IM Brain** — a clinical reasoning and education assistant for Internal Medicine. Potential capabilities: differential diagnosis, diagnostic reasoning, management reasoning, teaching, evidence verification, and rounds preparation. This is clinical decision support/education with human verification, **not** autonomous patient care (see Section 9).
- **Medical Career Advisor** — a broader medical career/application advisor spanning premed, medical school, residency, fellowship, research/career strategy, application review, interview preparation, program research, and timelines — potentially with a human consultant in the loop (the real-world "Scholr" consulting role is one example of what this could look like).
- **Personal Assistant** — handles tedious real-world administrative and customer-service tasks (returns/refunds, order tracking, disputes, routine emails and calls, navigating customer-service chatbots/phone menus), eventually choosing the right method (website, chatbot, email, phone) itself rather than requiring Irtiza to specify it. Confirmed to fit the existing architecture with no Core changes (ADR 0005) — it registers as a Pack like any other, and every external capability it eventually needs (email, phone, browser, chat) becomes a Tool/Provider adapter when actually built, not before.

Each should be built as its own Pack sitting on top of the generic, unchanged Core — not as special-case logic hard-coded into the engine itself.

## 6. Important architectural principles

Standing rules this project has committed to, most of them recorded formally in `docs/adr/`:

- **Core remains domain-agnostic.** The engine must never contain medical, research, or career-specific logic.
- **Domain-specific logic belongs in Packs**, not in Core (ADR 0003).
- **Model providers should remain replaceable.** Adding a new AI vendor should never require changing Core (ADR 0001).
- **Prefer small, composable components** — deep, focused modules behind simple interfaces, rather than large, tangled ones.
- **Avoid unnecessary dependencies and infrastructure.** The whole project currently has zero runtime dependencies — only TypeScript itself as a development tool (ADR 0002).
- **Test important behavior.** All 33 pieces of behavior described above are covered by automated tests, not just claimed to work.
- **Build infrastructure when a real use case requires it, not speculatively.** Several deferred items in Section 10 are deferred specifically because building them without a real use case to design against would mean guessing.
- **Consequential capabilities must be split into safe read/draft operations and separate, gated send/execute/modify/delete operations** (e.g. a `draft-email` tool must be a different tool from `send-email`) (ADR 0004, Section 2).
- **Human approval / "approval-gating" for risky actions is intentionally not built into Core yet.** It will be designed once a real consequential tool (e.g. actually sending an email) exists to design it against, rather than guessed at now (ADR 0004).
- **Useful functionality over infrastructure for its own sake.** A solid foundation was deliberately built first, but the project must not get trapped endlessly building infrastructure. For every proposed change, ask:
  1. Does this solve an immediate problem?
  2. Does it preserve future extensibility?
  3. Does it avoid unnecessary complexity?
  4. Does it avoid hard-coding around one model, domain, or service?
  5. Does it preserve appropriate control over consequential actions?
  Don't add infrastructure merely because it might someday be useful.

## 7. Research and medical safety

**For research functionality** (A&I Research and the research aspects of the other Packs):
- Never fabricate studies or citations.
- Do not overstate novelty.
- Verify important claims; distinguish evidence from inference.
- Account for changing journal/conference requirements rather than assuming they're fixed.
- Avoid unnecessary exposure of PHI or other sensitive information.

**For medical functionality** (IM Brain, and the medical aspects of the other Packs):
- Educational / clinical decision-support role only.
- Important medical/research outputs require appropriate human verification before being relied upon or acted on.
- **Do not autonomously make clinical decisions.** A clinician remains the decision-maker at all times.
- **No autonomous patient care.**
- **No EHR (Electronic Health Record) actions** unless and until a separately designed, explicitly authorized integration exists for that purpose. None exists today.
- **Avoid PHI** (Protected Health Information — real, identifiable patient/research-subject data). Development and examples should use de-identified or fictional cases.

## 8. Development philosophy: how we decide what to build

We deliberately spent time establishing a solid foundation (Sections 3–4), but the priority now is **useful functionality over infrastructure for its own sake**. The five-question checklist in Section 6 is how every proposed change — big or small — should be evaluated before building it.

## 9. Development workflow

**PLAN → DELEGATE → IMPLEMENT → TEST → VERIFY → INTEGRATE → DELIVER**

Division of responsibility:

- **Irtiza** is the product/domain owner and domain expert, not a computer-science expert. He gives high-level instructions in plain English and expects Claude Code to handle the engineering work — including running terminal commands — rather than being asked to type or execute technical steps himself.
- **Claude Code** is the engineering agent: understands the goal, inspects the real repository and documentation, proposes an approach in plain English with tradeoffs, asks for approval before major architectural changes, implements the smallest sensible version, runs tests/build, explains in practical terms what was actually produced, and commits when appropriate — without pushing to GitHub unless explicitly asked.
- When explaining a technical decision, explain what it actually produces or accomplishes in practical terms — not jargon for its own sake.
- **ChatGPT** plays a separate, complementary role outside this coding environment: translating technical decisions into plain English and helping think through architecture/product decisions.

## 10. How future Claude sessions should behave

When Irtiza gives a high-level idea rather than a technical specification, the expected loop is:

1. Understand the goal.
2. Inspect the actual repository and documentation (`PROJECT-BRAIN.md`, `CONTEXT.md`, `docs/adr/`, the real code) — never assume it matches what a past conversation described.
3. Explain the proposed approach in plain English.
4. Identify important tradeoffs.
5. Ask for approval before major architectural changes.
6. Implement the smallest sensible version — avoid unnecessary redesign.
7. Run tests/build.
8. Explain what was actually produced, in plain English, distinguishing clearly between what now exists and what is merely planned or proposed.
9. Commit changes when appropriate.
10. Do not push to GitHub unless explicitly asked.

Also: use appropriate installed Matt Pocock skills (domain-modeling, codebase-design, etc.) when they fit the task, and ask for clarification when a major product decision is ambiguous rather than guessing.

## 11. Current roadmap (high-level only)

This is a directional sketch, not a committed plan or a detailed implementation schedule. Not all of it may end up being built, and nothing here should be treated as scheduled work.

1. **Foundation** — the reusable engine itself: Core, Providers, Tools, Registry, Packs, Store, CLI. *(Largely in place today, as described in Sections 3–4.)*
2. **First useful domain Pack** — build one real Pack (A&I Research is the current leading candidate) to prove the architecture holds up for a real product, not just a placeholder. Design comes before implementation for this step.
3. **Verification** — introduce real evidence/citation verification behavior once a domain pack actually needs it.
4. **More domain Packs** — build out the remaining planned domains once the pattern is proven.
5. **Controlled external capabilities** — if and when justified, carefully introduce tools that touch the outside world (Section 2's list), each split into read/analyze vs. draft vs. gated send/execute/modify/delete per ADR 0004, with human-approval infrastructure designed at that point.
6. **Production hardening** — if this grows beyond a local CLI tool (e.g. toward the "service" half of the CLI-first/service-ready design), address deployment, persistence beyond local JSON files, and related concerns at that time.

Each stage is intended to be justified by an actual need at the time, not built ahead of it — consistent with Section 6's "build infrastructure when a real use case requires it."

For what's currently and intentionally *not* being built, see the list below.

### Not being built right now

- A full multi-step **workflow engine** (chaining multiple agents/tasks together automatically).
- **Human-in-the-loop infrastructure** (a way for a Run to pause and wait for a person's approval or input).
- **Browser automation, email/SMS automation, calendar integration, GitHub integration, or any computer-control tools.**
- **EHR integration** of any kind.
- **Deployment infrastructure** (servers, hosting, CI/CD pipelines, containers).
- **Unnecessary databases or external services** — the project currently uses only local JSON files for storage.
- **Configuring `ANTHROPIC_API_KEY` or incurring any API billing**, unless and until explicitly decided later.

This list will shrink over time as real use cases justify building each item (Section 6) — it is not a permanent ban, just today's boundary.
