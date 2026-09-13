import { randomUUID } from "node:crypto";
import type { JobRecord, Preferences } from "./records";
import type { Source } from "./sources/source";
import { jitter, mapWithConcurrency } from "./sources/source";
import { toJobRecord } from "./normalize";
import { dedupe } from "./dedupe";
import { applyFilters } from "./filter";
import { sortByRank } from "./rank";
import { scoreRecords, type CandidateProfile } from "./score";
import type { ScoringClient } from "./scoring-client";
import { CostLedger } from "./cost";
import { degraded, healthy, type SourceHealth } from "./health";
import type { RunSummary } from "./digest";
import type { JobStore } from "../store/job-store";

/**
 * The pipeline. One function, ten stages, in the order the plan set out.
 *
 * Two properties are load-bearing and worth stating plainly:
 *
 * It is idempotent. Running it twice in a row costs almost nothing the second
 * time, because every posting is hashed and anything already seen is dropped
 * before a single token is spent. That is what makes a scheduled run safe to
 * re-execute, and what makes "did the 8am run work?" a cheap question.
 *
 * It degrades rather than dies. A source that 404s, a batch the model fails
 * on, a board that changes its markup — each is recorded and reported in the
 * digest, and the rest of the run completes. The failure mode this is built
 * to avoid is the silent one: a pipeline that stops finding jobs and does not
 * mention it.
 */

export interface PipelineDeps {
  readonly sources: readonly Source[];
  readonly store: JobStore;
  readonly prefs: Preferences;
  readonly profile: CandidateProfile;
  /** Absent means no API key is configured: the run still fetches, dedupes and filters, and simply does not score. */
  readonly scoringClient?: ScoringClient;
  readonly costLogPath: string;
  /** How many sources to fetch at once. Deliberately small — politeness, not throughput. */
  readonly concurrency?: number;
  /** Off in tests, on in real runs. */
  readonly politeDelay?: boolean;
}

export async function runPipeline(deps: PipelineDeps): Promise<RunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new CostLedger(runId, deps.costLogPath);
  const health: SourceHealth[] = [];

  // Stages 1-2 — fetch, with per-source health and no source able to fail the run.
  const fetched = await mapWithConcurrency(deps.sources, deps.concurrency ?? 4, async (source) => {
    if (deps.politeDelay !== false) await jitter();
    const checkedAt = new Date().toISOString();
    try {
      const postings = await source.fetch();
      health.push(healthy(source.id, postings.length, checkedAt));
      return postings;
    } catch (error) {
      health.push(degraded(source.id, error, checkedAt));
      return [];
    }
  });

  const rawPostings = fetched.flat();
  const now = new Date().toISOString();

  // Stage 3 — normalize. The raw body goes to disk; only the trimmed summary
  // travels onward, so no prompt ever carries a page of HTML.
  const normalized: JobRecord[] = [];
  for (const raw of rawPostings) {
    const provisional = toJobRecord(raw, { descriptionPath: "", tokenBudget: deps.prefs.postingTokenBudget, now });
    const descriptionPath = await deps.store.saveRawBody(provisional.contentHash, raw.body);
    normalized.push({ ...provisional, descriptionPath });
  }

  // Stages 4-5 — the delta. Everything already known is dropped here, before
  // anything expensive happens.
  const known = await deps.store.listJobs();
  const { fresh, merged, duplicateCount } = dedupe(normalized, known);

  // Stage 6 — the free filters. One `now` shared across the whole batch, so
  // recency comparisons are consistent within a single run.
  const passed: JobRecord[] = [];
  const rejected: JobRecord[] = [];
  const filterNow = new Date(now);
  for (const record of fresh) {
    const outcome = applyFilters(record, deps.prefs, filterNow);
    if (outcome.passed) {
      passed.push(record);
    } else {
      rejected.push({ ...record, state: "filtered", filterReason: outcome.reason });
    }
  }

  // Stage 8 — the only model call. Skipped entirely with no client configured.
  let scored: readonly JobRecord[] = [];
  let failures: readonly string[] = [];
  if (deps.scoringClient && passed.length > 0) {
    const result = await scoreRecords(passed, deps.profile, deps.prefs, deps.scoringClient, ledger);
    scored = result.scored;
    failures = result.failures;
  } else if (passed.length > 0) {
    failures = [
      `${passed.length} posting(s) fetched and filtered but not scored: no ANTHROPIC_API_KEY configured. They are saved and will be scored on the next run once a key is set.`,
    ];
  }

  // Anything the model did not get to keeps its `seen` state on purpose, so
  // the next run picks it up instead of losing it.
  const scoredIds = new Set(scored.map((record) => record.id));
  const unscored = passed.filter((record) => !scoredIds.has(record.id));

  await deps.store.saveJobs([...scored, ...unscored, ...rejected, ...merged]);

  // Stage 9 — rank and cut. The cutoff compares the model's actual score;
  // the sort order is a separate, tunable display concern (rank.ts) — a role
  // with no stated salary is never excluded by it, only shown lower.
  const ranked = sortByRank(scored, deps.prefs);
  const aboveCutoff = ranked.filter((record) => (record.score ?? 0) >= deps.prefs.scoreCutoff);
  const shortlisted = aboveCutoff.slice(0, deps.prefs.digestLimit);
  const alsoSeen = ranked.filter((record) => !shortlisted.includes(record));

  const tokens = ledger.totalTokens();

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetchedCount: rawPostings.length,
    newCount: fresh.length,
    duplicateCount,
    filteredCount: rejected.length,
    scoredCount: scored.length,
    shortlisted,
    alsoSeen,
    health,
    failures,
    costUsd: ledger.total(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
}
