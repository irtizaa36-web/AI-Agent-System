# Prompt audit — 2026-09-23

An audit of this repository's prompt surface for dated prompting patterns, for text that no longer matches the model it runs on, and for tool contracts that don't match what the code does. The proposed diff is in [`prompt-audit-2026-09.patch`](prompt-audit-2026-09.patch). **It has not been applied.** To take all of it, run `git apply docs/research/prompt-audit-2026-09.patch`. To take part of it, apply per file (the file-to-finding map is in the table below).

## Assumptions

- **Scope:** the whole working directory's prompt surface, because the request named no files.
- **Target models:** the models the code already uses. That is **Claude Sonnet 5** (`claude-sonnet-5`) for every Pack agent, and **Claude Haiku 4.5** (`claude-haiku-4-5`) for the job-search scorer, the feedback classifier, and tool-result summarization. No migration is in progress.
- **Vendored content is inventoried but not diffed.** `.claude/agents/` holds 289 personas from `msitarzewski/agency-agents`, and `.agents/skills/` holds skills pinned in `skills-lock.json`. Fixes to those belong upstream. Only the three repo-authored stewards are in the diff.
- **Non-Anthropic markers are recorded only.** `gpt-4o` and `ChatOpenAI` appear as example code in `.claude/agents/security-ai-generated-code-auditor.md` and `engineering-knowledge-graph-engineer.md`, and every skill has an `agents/openai.yaml`. No change is proposed to any of them.

## Inventory

| Surface | Where |
|---|---|
| Request builders | `src/providers/anthropic.ts` (agent runs), `src/jobsearch/scoring-client.ts` (scheduled pipeline) |
| System prompts | 7 Packs in `src/packs/*/pack.ts`; `SUMMARY_SYSTEM_PROMPT` in `src/tools/with-summarization.ts`; `RUBRIC` + `buildSystemPrompt` in `src/jobsearch/score.ts`; `buildFeedbackPrompt` in `src/jobsearch/feedback.ts` |
| Tool definitions | 13 tools in `src/tools/*.ts` |
| Model pins | Packs → `claude-sonnet-5`; scoring/feedback → `claude-haiku-4-5` (from `config/job-search/*/preferences.json`); summarization → `claude-3-5-haiku-20241022` |
| Rule/skill files | `CLAUDE.md`, `.github/copilot-instructions.md`, `docs/claude/*.md`, 3 repo-authored stewards in `.claude/agents/`, plus the vendored catalogs above |

## Summary

| Group | High | Medium | Flag |
|---|---|---|---|
| 1 — Dated prompt text | 2 | 3 | 1 |
| 2 — Brittle skill/agent files | — | 2 | 2 |
| 3 — Tool descriptions | 2 | 1 | 1 |
| 4 — Request config / architecture | 2 | 1 | 1 |

The three findings with the most impact:

1. **Tool-result summarization calls a retired model.** Any `read-file`, `read-web-page`, or `read-job-board-page` result over 6,000 characters goes to `claude-3-5-haiku-20241022`, which was retired on 2026-02-19. Such a read fails instead of being condensed, and job-board result pages routinely exceed that size.
2. **`browser-submit-form` misstates its own gate when returns autopilot is on.** Its description, and the personal-admin prompt, say the tool always pauses for human approval. With `RETURNS_AUTOPILOT_ENABLED=true` it runs immediately. The personal-admin agent has this tool, so it could make a live submit while believing a human will review it first.
3. **The agent provider drops thinking blocks.** Pack agents run Sonnet 5 without setting `thinking`, so adaptive thinking is on by default. `parseResponseBody` keeps only `text` and `tool_use` blocks, so every tool-loop turn is replayed without the thinking that led to its tool calls. That loses the reasoning, and the migration guide says it can trigger ordering or signature 400s.

## Findings

Findings are ordered by confidence. "Hunk files" lists the patch files that implement each fix.

### High

| # | Location | Evidence | Pattern | Why it's obsolete or wrong for the target | Action | Hunk files |
|---|---|---|---|---|---|---|
| 1 | `src/tools/with-summarization.ts:9` | `DEFAULT_CHEAP_MODEL = "claude-3-5-haiku-20241022"` | 1d model-version fossil / 4 API fossil | Haiku 3.5 was retired on 2026-02-19, so requests to it fail. It is wired in `config/load.ts:101,106,110`. | replace → `claude-haiku-4-5` | `with-summarization.ts`, `.test.ts` |
| 2 | `src/tools/browser-submit-form.ts:61-62`; `src/packs/personal-assistant/pack.ts:10,45` | "only ever runs after exact-match human approval"; "it always pauses for a human to review" | 3 contract/behavior mismatch | `requiresApproval` is `!returnsAutopilotEnabled()` (ADR 0018). The description is the model's only view of the gate, and it is wrong whenever autopilot is on. | rewrite: build the description from the same flag, and have the prompt defer to the description | `browser-submit-form.ts`, `.test.ts`, `personal-assistant/pack.ts`, `pack.test.ts` |
| 3 | `src/providers/anthropic.ts:62-101` | `parseResponseBody` keeps only `text`/`tool_use`; `toAnthropicMessage` rebuilds assistant turns from them | 4 thinking config for the wrong model | On Sonnet 5, omitting `thinking` runs adaptive thinking. The migration guide says not to strip regular thinking blocks: removing them can trigger ordering or signature 400s. | rewrite: carry the verbatim assistant content as an opaque `providerContent` and replay it unchanged | `provider.ts`, `anthropic.ts`, `anthropic.test.ts`, `core/session.ts`, `core/orchestrator.ts` |
| 4 | `src/jobsearch/score.ts:53-55,108-117` | "Return ONLY a JSON array, no prose and no code fences" + fence-strip / bracket-hunt parser | 1b scaffold replaced by structured outputs | Haiku 4.5 supports `output_config.format`. The shape is then enforced by the API, and the fence tolerance only existed to serve the prompt-based format. | replace-with-API-feature: `SCORING_OUTPUT_SCHEMA` (`{"scores":[…]}`); the parser keeps the id and score-range checks the schema can't express | `scoring-client.ts`, `score.ts`, `score.test.ts`, `pipeline.test.ts` |
| 5 | `src/jobsearch/feedback.ts:238-239,270-275` | "Output ONLY a JSON object, no prose before or after" + bare `JSON.parse` | 1b | The same scaffold. Here a fenced reply fails `JSON.parse` and becomes the empty classification: no reply is drafted and nothing changes, which is the "silent on feedback" failure the last commit worked to prevent. | replace-with-API-feature: `FEEDBACK_OUTPUT_SCHEMA` (field names constrained to the allow-list); `applyFeedbackPatch` still re-checks types | `feedback.ts`, `feedback.test.ts` |
| 6 | `src/tools/send-email.ts:41-52` | "Sends an email draft. Consequential: only ever runs after exact-match human approval." — six required params, none described | 3 under-described | `bcc`, `draftId`, and `revision` must match the latest `inkbox-save-draft` result exactly or the send throws, and nothing tells the model that. | add: a contract description plus parameter descriptions | `send-email.ts` |

### Medium

| # | Location | Evidence | Pattern | Why | Action | Hunk files |
|---|---|---|---|---|---|---|
| 7 | `src/packs/career-advisor/pack.ts:19` vs `:27`, `:36` | "you no longer need to ask the user for it" | 1d migration-relative phrasing / patch accretion | Line 19 was patched in after the verified wording was found, but lines 27 and 36 still say to ask the user for that wording. Sonnet 5 follows instructions literally, so the prompt contradicts itself. | rewrite all three lines to one rule | `career-advisor/pack.ts` |
| 8 | `src/packs/ai-research/pack.ts:16,23` | "state the Sept 21, 2026 case-report deadline plainly"; "(already past)" | 2 time-sensitive content | The deadline passed two days ago, yet the prompt has the model present it as live. "(already past)" is relative to when the prompt was written. | rewrite: state the date, say it may have passed, and point the user to the portal | `ai-research/pack.ts` |
| 9 | `src/packs/personal-assistant/pack.ts:36` | "State explicitly … that this is planning/drafting only: nothing has been sent" | 1c conflicting duplicated rule | This is unconditional, but the agent can send after approval. The tool-result-proves-it clause that follows it conflicts with it. | rewrite: make the status conditional on tool-result evidence | `personal-assistant/pack.ts` |
| 10 | `src/providers/anthropic.ts:99` | `refusal` collapses to `"end_turn"` | 4, Sonnet 5 migration checklist (safeguard refusals) | A refusal comes back as an empty "succeeded" result. | add: a `refusal` stop reason, failed like `max_tokens`; the scoring client throws on it too | `provider.ts`, `anthropic.ts`, `orchestrator.ts`, `orchestrator.test.ts`, `scoring-client.ts` |
| 11 | `src/tools/inkbox-save-draft.ts:28`, `inkbox-search-mail.ts:8`, `read-file.ts:18`, `with-summarization.ts:49` | one-line descriptions; undescribed params; wrapped tools don't mention condensing | 3 under-described | These omit what search returns (headers only, up to 50), what save-draft returns, the path base for `read-file`, and that results over 6,000 characters are condensed. | add | those files + `with-summarization.test.ts` |
| 12 | `src/packs/core-demo/pack.ts:16` | "You are a helpful, concise assistant." | 1d identity stub as the only context | This line is the fallback agent's entire prompt. | rewrite: its role, tools, limits, and length | `core-demo/pack.ts` |
| 13 | `.claude/agents/job-search-steward-shivani.md:33`; `…-irtiza.md:17` | "43 verified companies"; "43 boards" | 2 volatile specifics | Already stale: the watchlist now has 135 ATS boards and 8 feeds (commit d495425). | rewrite: point at `watchlist.json` | both steward files |
| 14 | `.claude/agents/job-search-steward-shivani.md:37` | "Work happens on `claude/polar-job-search-agent-n8d0kn`; … already established in this session" | 2 history narrative / recency trap | The branch and "this session" belong to the session that wrote the line. Branch and attribution come from each session's own instructions. | remove | `job-search-steward-shivani.md` |

### Flag only (no hunk)

| # | Location | Note |
|---|---|---|
| 15 | `src/packs/dispatcher/pack.ts:16-25`, `src/core/workflow.ts:75` | The fenced ` ```json ` plan parsed by regex matches pattern 1b (structured outputs). Adopting structured outputs means adding an output schema to the `GenerateRequest` port (ADR 0001), so it is a design change rather than an audit hunk. The fix from #3 already touches that port. |
| 16 | `src/packs/job-search/pack.ts:31`, and tool names across all Pack prompts | Pattern 3, "tool names in the system prompt". Each Pack has a fixed toolset, so no reference can dangle, and the form-tool order in personal-admin is a fragile sequence worth keeping. This is working redundancy. |
| 17 | `.claude/agents/job-search-steward-irtiza.md:36-67` | A live application-status table (volatile, and it duplicates `.orchestrator/jobs/irtiza/applications/`). It also puts application details in a committed file, against the file's own rule that personal data stays in `profile/irtiza/` and `.orchestrator/`. The right destination is gitignored, so this is the owner's call, not a diff. |
| 18 | `.claude/agents/*` (vendored) | 28 files use caps emphasis. The clearest case is `security-senior-secops.md:24`, "This runs ALWAYS. Before reading the request." ("CRITICAL" there is mostly a severity label, which is fine.) Fix upstream if at all. |
| 19 | Group 4: token accounting | The scheduled pipeline has a `CostLedger`, but agent runs through `src/providers/anthropic.ts` record no usage and use no prompt caching. Add usage capture before measuring any prompt change. The deterministic-executor check came back clean: the pipeline filters in code and makes model calls only for judgment (scoring, feedback) and condensing. |

## Keep list (checked and left alone)

- **Truthfulness and never-submit rules.** This covers never inventing credentials, clinical findings, or listings; the PHI strip-and-flag rule; the never-submit and stop-at-CAPTCHA rules; and "unconfirmed, never done". These state real constraints and give their reasons.
- **Fixed section headings.** They pin format-sensitive outputs that downstream readers and tests depend on.
- **Numbered steps for fragile flows.** These are the form-tool order and the customer-service steward's order of operations. They cover consequential operations where only one sequence is safe.
- **Scoring rubric bands and the two-sentence rationale.** These are a format requirement for the digest, not a verbosity clamp.
- **`docs/claude/job-search.md` vs the job-search Pack prompt.** They overlap but agree, so the overlap is working redundancy.

## Verification

- **Tests:** the patch was built in a scratch worktree off `f929573`. With it applied, `npm test` passes 613/613 (609 before; the new tests are the thinking-block replay, the refusal mapping and failure, and the scoring schema being sent). `git diff --check` is clean, and `git apply --check` passes against `main`.
- **Not verified live:** no API call was made, because doing so needs a key and costs money. Before merging, run one real `job-search-agent` task with a tool call (for #3), and one scoring and one feedback call with `output_config` on `claude-haiku-4-5` (for #4 and #5).
- **Separately:** removing a prompt line is a hypothesis about model behavior, not a proven fix. Re-check #7, #9, and #12 on real runs, one change at a time.
