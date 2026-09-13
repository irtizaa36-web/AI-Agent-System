# PLAN.md — Job Search Agent (Moby AI job-search pipeline, v2)

> Status: **awaiting approval.** Nothing in this document has been built. No code has been written.
> Scope owner: Irtiza. End user: his wife ("the candidate" below).

---

## 1. What we're building and for whom

A local, self-hosted job-search pipeline that runs twice a day on an always-on Mac mini and, without anyone babysitting it, discovers new postings across ATS boards, a watchlist of target companies, niche boards, and forwarded job-alert emails; deduplicates the same role cross-posted to four sites down to one record; kills the obvious no's with free deterministic rules; scores what survives against the candidate's real resume and stated preferences using a small model in batches; and publishes a short digest of high-fit roles — each with a two-line rationale, a confidence level, and a direct apply link — to a local dashboard she opens once a day. Later phases add resume tailoring from her existing accomplishment bank, browser form prefill that stops at the submit button, and outreach drafts that queue for her approval. **Nothing is ever auto-submitted, auto-sent, or auto-accepted.** It is built inside this repository, reusing the orchestrator, the browser client, the approval gate, and the anti-fabrication contract that already exist here.

---

## 2. Answers from the interview (the spec this plan is built against)

| Area | Answer |
| --- | --- |
| Field | Business / ops / marketing |
| Role scope | A cluster of related titles (3-6) |
| Level | Individual contributor through manager-of-a-function |
| Location | **Remote roles, location irrelevant.** (Supersedes the earlier "one metro + remote" answer — see Assumption A2.) |
| Urgency | Employed, searching hard — discretion matters |
| Eligibility filters | None (no sponsorship, licensure, or clearance constraints) |
| Dealbreakers | Compensation floor only |
| Base resume | PDF only |
| Accomplishment bank | Exists, already structured |
| Profile mining | LinkedIn profile, one-time only |
| Sources | ATS boards direct + target-company watchlist + aggregators + niche/society boards |
| Watchlist size | 20-50 companies |
| Volume | A handful of high-fit roles per run |
| Cadence | Twice daily |
| Runtime | Always-on Mac mini |
| Interface | Local web dashboard |
| Approvals | One daily review queue |
| Cost posture | Balanced (rules → small model → large model on shortlist only) |
| v1 scope | Discovery + application. No follow-up reminders, no interview prep. |
| Home | Inside this repo (`AI-Agent-System` / Moby AI) |
| Machine | Node 22+ present. **No Playwright browsers installed. No separate Anthropic API key.** (See Open Question Q1 — this is the one real blocker.) |

---

## 3. The pipeline, stage by stage, with the cheapest mechanism that can do each job

The rule this table enforces: **a model is allowed only where judgment or language generation is genuinely required.** Everything else is a deterministic script.

| # | Stage | Mechanism | Why that is the cheapest thing that works |
| --- | --- | --- | --- |
| 1 | **Fetch** | Pure code. `fetch` against public ATS JSON endpoints (Greenhouse `boards-api`, Lever `postings`, Ashby `posting-api`), RSS/Atom for niche boards, and the existing Inkbox mail tools for forwarded job alerts. | These are official, documented, structured endpoints. No scraping, no robots.txt problem, no markup to break, no model. |
| 2 | **Source health** | Pure code. Per-source success/failure ledger with one retry at backoff, then mark the source `degraded` and carry on. | A broken source must never take the run down. Reported in the digest, not swallowed. |
| 3 | **Normalize** | Pure code. HTML→text, strip nav/footer/legal boilerplate, extract title/company/location/remote-flag/salary-range/posted-date/apply-URL. Raw HTML written to disk, never carried in memory into a prompt. | Regex and DOM-free string work. Deterministic and free. |
| 4 | **Content hash + delta** | Pure code. SHA-256 over normalized title+company+description. Anything already `seen` is dropped before anything else happens. | The single largest cost lever: a posting is processed exactly once, ever. Steady-state runs touch ~5-15% of what they fetch. |
| 5 | **Dedupe across sources** | Pure code. Identity key = normalized(company) + normalized(title) + location-class. Merge into one record carrying every source URL. | Same role on Greenhouse + LinkedIn + a niche board = one record, four links. Pure string normalization. |
| 6 | **Hard filters** | Pure code / regex. Remote-required gate; title-cluster keyword match; compensation floor against the stated range; explicit exclusion list. | Removes roughly two-thirds of survivors for zero cost. **Unstated salary is flagged `unknown`, never guessed or assumed to pass.** |
| 7 | **Truncate** | Pure code. Cap each posting at a token budget (~600 tokens of the most signal-dense text: title, level, responsibilities, requirements, comp). | Job descriptions are 60% boilerplate. Trimming before the model is free and cuts scoring input by ~4x. |
| 8 | **Fit scoring + rationale** | **Small model (Claude Haiku 4.5, `claude-haiku-4-5`), batched.** ~15 postings per call, structured JSON out: `{id, score 0-100, confidence, rationale (2 lines), gaps[]}`. Stable prefix (resume summary + preferences + scoring rubric) is prompt-cached. | This is genuine judgment — the first point in the pipeline where a model earns its place. Batching amortizes the prefix; caching makes the repeat cost of that prefix ~10% of list price. |
| 9 | **Rank + threshold** | Pure code. Sort by score; publish above the cutoff; everything else collapses into a "also seen" list. | Arithmetic. |
| 10 | **Digest** | Pure code. Markdown file + JSON payload for the dashboard. | Templating, not generation. |
| 11 | **Cost ledger** | Pure code. Append `{run_id, ts, stage, model, input_tokens, output_tokens, cache_read, cost_usd}` to `logs/costs.jsonl`; run total surfaced in the digest. | Makes drift visible instead of arriving as a bill. |
| — | *(Phase 2)* **Enrichment** | Pure code + cached lookups; large model only to summarize red flags. | Company size/funding/reviews are per-**company**, not per-role — computed once and reused across every role at that company, forever. |
| — | *(Phase 2)* **Tailoring** | **Large model (`claude-opus-5`)**, per shortlisted role, human-triggered. | Language generation against her real accomplishment bank. Never runs unattended, never in the scheduled path. |
| — | *(Phase 3)* **Form prefill** | **Browser agent (Playwright), shortlist only, stops before submit.** | The most expensive tool in the box. Used for one thing: filling a form she has chosen to apply to. Never for discovery. |

---

## 4. Data model

Three record types, persisted as JSON files under `.orchestrator/jobs/` (already gitignored), following the same one-file-per-record shape as the existing `JsonFileRunStore`.

### JobRecord
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable UUID, assigned once at first sight |
| `contentHash` | string | SHA-256 of normalized content — the "never re-process" key |
| `identityKey` | string | company+title+location-class — the cross-source dedupe key |
| `title`, `company`, `rawLocation` | string | As published |
| `locationClass` | `"remote" \| "hybrid" \| "onsite" \| "unknown"` | Drives the hard filter |
| `salaryMin`, `salaryMax`, `salaryCurrency` | number \| null | `null` means **not stated** — never inferred |
| `postedAt`, `firstSeenAt`, `lastSeenAt` | ISO date | `postedAt` null when the source doesn't publish it |
| `sources` | `{sourceId, url, fetchedAt}[]` | Every place this one role was found |
| `applyUrl` | string | The canonical direct-apply link |
| `descriptionPath` | string | Path to raw HTML on disk — never inlined into a prompt |
| `state` | `"seen" \| "filtered" \| "scored" \| "shortlisted" \| "rejected" \| "applied" \| "closed"` | Transitions are code, not a model |
| `filterReason` | string \| null | Which deterministic rule rejected it |
| `score`, `confidence` | number \| null, `"low"\|"medium"\|"high"` \| null | From stage 8 |
| `rationale` | string \| null | Two lines, model-written |
| `gaps` | string[] | Requirements her resume does not support — stated, never papered over |

### ApplicationRecord
`id`, `jobId`, `status` (`queued` → `materials_ready` → `prefilled` → `submitted_by_human` → `responded` → `rejected` → `withdrawn`), `appliedAt`, `resumeVariantPath`, `coverLetterPath`, `followUpDueAt`, `outcome`, `rejectionReason`, `notes[]`. **No status ever advances to `submitted_by_human` except by an explicit human action in the dashboard.**

### CompanyRecord (the enrichment cache)
`id`, `canonicalName`, `aliases[]`, `domain`, `atsType` + `atsBoardToken`, `sizeBand`, `fundingStage`, `remotePolicy`, `glassdoorSignals`, `redFlags[]`, `onWatchlist`, `enrichedAt`, `enrichmentTtlDays`. Keyed by canonical name so a role at a known company costs zero enrichment.

---

## 5. Repo layout

Everything new, additive; no existing file's behavior changes.

```
src/jobsearch/
  pipeline.ts              # stage sequencing; idempotent; the single entrypoint
  sources/
    source.ts              # the Source port (ADR 0001 ports-and-adapters)
    greenhouse.ts          # public boards-api JSON
    lever.ts               # public postings JSON
    ashby.ts               # public posting-api JSON
    feed.ts                # generic RSS/Atom for niche + society boards
    alert-mail.ts          # LinkedIn/Indeed via forwarded alerts (ADR 0013)
    registry.ts            # watchlist config -> Source instances
  normalize.ts             # raw -> JobRecord; boilerplate stripping; hashing
  dedupe.ts                # cross-source identity key
  filter.ts                # remote gate, title cluster, comp floor, exclusions
  truncate.ts              # per-posting token budget
  score.ts                 # batch prompt build + strict JSON parse (pure)
  digest.ts                # Markdown + dashboard payload
  health.ts                # per-source health ledger, degrade-don't-crash
  cost.ts                  # logs/costs.jsonl ledger
src/store/job-store.ts     # JobRecord / ApplicationRecord / CompanyRecord
src/cli/jobs-commands.ts   # orchestrator jobs run | digest | sources | status
config/job-search/
  preferences.json         # titles, comp floor, exclusions, score cutoff  (committed)
  watchlist.json           # 20-50 companies + ATS type + board token      (committed)
profile/                   # GITIGNORED — resume.md, accomplishments.json
.orchestrator/jobs/        # GITIGNORED — records, raw HTML, digests
logs/costs.jsonl           # GITIGNORED — per-run cost ledger
scripts/com.mobyai.jobsearch.plist   # launchd schedule
```

Tests colocated as `*.test.ts`, run by the existing `npm test` (`node --test` over `dist/`). Every pure stage (normalize, dedupe, filter, truncate, score-parse, digest) is unit-testable with zero network and zero model calls — which is most of the system.

**Runtime schedule:** `launchd` fires `npm run pipeline` at 08:00 and 18:00 local. The run is idempotent and safe to re-execute; re-running the same day costs near zero because the content-hash delta finds nothing new. `npm run pipeline` reproduces a full run by hand at any time.

---

## 6. Build order

### Phase 1 — ships in one session, usable that day
Sources (Greenhouse + Lever + Ashby + RSS feeds + watchlist) → normalize → hash/delta → dedupe → hard filters → truncate → Haiku batch scoring with two-line rationale → ranked digest to Markdown and the local dashboard → cost ledger → `npm run pipeline` → launchd plist → tests for every pure stage.

*Deliberately excluded from Phase 1:* no enrichment, no tailoring, no browser, no outreach. **No large model in the steady-state path at all** — Haiku produces the score, the confidence, and the two-line rationale in the same batched call, which is exactly what the definition of done asks for and keeps a run at a few cents.

### Phase 2 — materials and enrichment
Company enrichment cache; salary signals; PDF resume parsed once into `profile/resume.md`; accomplishment-bank-driven resume variants and cover letters via `claude-opus-5`, human-triggered from the dashboard, never scheduled; the daily approval queue.

### Phase 3 — browser prefill
Playwright form prefill on shortlisted roles, reusing the existing gated form-filling tools (ADR 0011): list fields → preview-fill → **stop**. Submission stays a human click, always. Needs `npx playwright install` once.

### Phase 4 — pipeline tracking (post-v1)
Application status board, dates applied, rejection-pattern analysis, outreach drafts queued for approval. Follow-up reminders and interview prep were explicitly scoped out of v1 and stay out until asked for.

---

## 7. Cost per run, and how it stays there

Live list prices: Haiku 4.5 `$1.00 / $5.00` per million input/output tokens; Sonnet 5 `$2.00 / $10.00`; Opus 5 `$5.00 / $25.00`. Cached prefix reads bill at roughly one-tenth of input rate; the Batch API is 50% off but async, so it is not used for a twice-daily digest.

**Phase 1 steady-state run** (~35 watchlist boards + feeds; ~600 postings fetched; ~80 new by content hash; ~30 survive the hard filters):

| Line | Tokens | Cost |
| --- | --- | --- |
| Haiku scoring input — 2 batched calls, ~15 postings each at ~600 tokens, plus a cached rubric/resume prefix | ~20K | **$0.020** |
| Haiku scoring output — structured JSON, ~150 tokens per posting | ~4.5K | **$0.023** |
| Everything else (fetch, hash, dedupe, filter, rank, digest) | 0 | **$0.000** |
| **Total per run** | | **≈ $0.04** |

Twice daily ≈ **$0.09/day, under $3/month.** The first backfill run is larger (~1,500 postings, one time) at roughly **$0.50**. Phase 2 tailoring adds ~$0.05-0.10 per role she actually asks for — human-triggered, so it never runs on a schedule.

The seven things holding that line: never re-process a posting (content hash); rules before models; batch many postings per call; prompt-cache the stable prefix; truncate every posting to a budget; cache company enrichment per company not per role; keep the browser out of discovery. `logs/costs.jsonl` plus the per-run number printed in the digest make any drift visible immediately.

---

## 8. How this respects the guardrails and the existing architecture

- **Never auto-submit, auto-send, auto-accept.** Phase 1 has no outbound capability whatsoever — it writes a file and serves a page. ADR 0004's `requiresApproval` gate stays untouched; Phase 3's prefill stops at preview, exactly as ADR 0011 built it.
- **Digest delivery closes ADR 0012's open gap honestly.** That ADR flagged that a scheduled run can't send email because `send-email` is unconditionally approval-gated, and refused to weaken the gate. A local dashboard plus a Markdown file needs no email and no exception — the gate stays exactly as strict as it is.
- **LinkedIn and Indeed are handled per ADR 0013: forwarded job-alert emails, not automation.** LinkedIn's anti-automation stance is a policy boundary, not an engineering problem, and she is employed and searching discreetly — automated activity against her logged-in account is precisely the wrong risk. Indeed sits behind Cloudflare (ADR 0012) and gets the same treatment. Her LinkedIn profile is read **once**, from LinkedIn's own "Download your data" export, by hand.
- **Robots.txt, rate limits, official endpoints first.** Every Phase 1 source is an official JSON API or a published feed. Concurrency limits and jitter on every fetch; no browser in the scheduled path at all.
- **No credentials in the repo.** `.env` is already gitignored; `profile/` gets added to `.gitignore` before a single byte of her data lands on disk.
- **Nothing is fabricated, ever.** Unstated salary is `unknown`, not assumed. A requirement her resume doesn't support becomes a named `gap`, not an invented skill. This is the existing contract in `docs/claude/job-search.md` and it is inherited wholesale.
- **All personal data stays local.** Resume and accomplishment bank live in a gitignored directory on the Mac mini and are sent to exactly one third party: Anthropic's API, for scoring and tailoring. No other service.
- **Architecture fit.** Sources are adapters behind a port (ADR 0001). Job-search content stays in its Pack and its own module (ADR 0003). No new npm dependencies — `fetch`, `node:test`, and `node:util.parseArgs` cover all of Phase 1, keeping ADR 0002 intact. New decisions will be recorded as ADR 0014.

---

## 9. Open questions — I need answers to Q1 and Q2 before Phase 1 can finish

**Q1 — No Anthropic API key. This is the one genuine blocker.** A launchd job cannot drive a Claude Code session, so unattended scoring needs credentials of its own. Three options: **(a)** create an API key — cleanest, and at under $3/month the cost is not the issue; **(b)** invoke `claude -p` headless from launchd against your existing subscription, which requires the CLI installed and authenticated on the Mac mini and is the option I'd want to verify rather than assume; **(c)** ship Phase 1 against the repo's existing `fake` provider, which exercises the entire pipeline end-to-end with fabricated scores — useful for validating the plumbing today, useless as a real digest. **I recommend (a).** Everything in Phase 1 except stage 8 works with no key at all, so I can build and test the whole pipeline while this is resolved.

**Q2 — Inputs I don't have yet.** The 3-6 target titles; the compensation floor number; the 20-50 watchlist companies (or say the word and I'll propose a starter list from her resume and her stated targets for you to approve); any industry exclusions. Phase 1 ships with these as config files, so they can land after the code — but the first real digest is only as good as they are.

**Q3 — The PDF.** Nothing in Node's standard library reads PDF, and adding a parser means breaking the zero-dependency ADR for a file we convert exactly once. I propose a one-time human-assisted conversion into `profile/resume.md`, cached forever, with the accomplishment bank imported as-is. Tell me if you'd rather I add a parser.

**Q4 — Dashboard placement.** A new "Jobs" section inside the existing dashboard at `src/dashboard/`, or a separate server on its own port? I'd add it to the existing one.

**Q5 — Retention.** How long do we keep raw posting HTML on disk? Default proposal: 90 days, then prune, keeping the JobRecord forever.

## Assumptions I've made (correct me if any are wrong)

- **A1 — Scoring model.** Haiku 4.5 produces score, confidence, and rationale in Phase 1; Opus 5 enters only in Phase 2, only for tailoring, only when she asks. If the Phase 1 rationales read as too blunt, the fix is a one-line model swap, not a redesign.
- **A2 — Location.** Your two answers differed ("one metro + remote", then "location not an issue as long as remote is offered"). I've encoded the later one as authoritative: **remote-only is the hard gate, and remote roles anywhere pass.** A `metros` list exists in the config, empty by default, so onsite/hybrid roles are rejected — fill it in and those become eligible again.
- **A3 — Level.** "IC or manages a function" is encoded as a wide band: IC through manager, with director-level roles surfaced but scored against that band rather than auto-rejected.
- **A4 — Digest size.** "A handful" is a config value defaulting to the top 8 above a score threshold, with the remainder collapsed into an "also seen" list so nothing is silently dropped.
- **A5 — First run.** The first run backfills whatever the sources currently list, which will be a much larger and more expensive digest than steady state. That's a one-time event, and it's the right way to establish the `seen` baseline.

---

**Awaiting your go before any implementation begins.**
