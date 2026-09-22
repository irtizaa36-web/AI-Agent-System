import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../jobsearch/pipeline";
import { renderDigest, digestPayload, type RunSummary } from "../jobsearch/digest";
import { sourcesFromWatchlist } from "../jobsearch/sources/registry";
import { JsonFileJobStore } from "../store/job-store";
import { CostLedger, readLedger } from "../jobsearch/cost";
import { createJobsDashboardServer } from "../jobsearch/dashboard";
import { createAlertMailSource } from "../jobsearch/sources/alert-mail";
import type { Source } from "../jobsearch/sources/source";
import { reconcileFiltered } from "../jobsearch/reconcile";
import { scoreRecords, type CandidateProfile } from "../jobsearch/score";
import { sortByRank } from "../jobsearch/rank";
import { summarizeRejections } from "../jobsearch/filter";
import type { JobRecord, WatchlistEntry } from "../jobsearch/records";
import type { ScoringClient } from "../jobsearch/scoring-client";
import {
  assertValidProfile,
  CONFIG_ROOT,
  configDirFor,
  COST_LOG_PATH,
  dataDirFor,
  listProfiles,
  loadPreferences,
  loadProfile,
  loadWatchlist,
  MissingProfileError,
} from "../jobsearch/config";
import { resolveJobsContext, type JobsCommandDeps, type JobsContext } from "./jobs-context";
import { deliverDigest } from "./jobs-delivery";
import { checkFeedback, runJobsEnrichContact } from "./jobs-feedback";

export type { JobsCommandDeps } from "./jobs-context";

/**
 * `orchestrator jobs ...` — the pipeline's command surface, and the single
 * entrypoint the scheduled run invokes. Nothing here is interactive: a
 * launchd job runs `jobs run` and everything it needs comes from config files
 * and the environment.
 *
 * Digest delivery lives in jobs-delivery.ts; the feedback loop and contact
 * enrichment live in jobs-feedback.ts.
 */

const USAGE = [
  "jobs subcommands (every one takes --profile <name>, or --all where noted):",
  "  run --profile <name>|--all   Fetch, dedupe, filter, score, and write today's digest",
  "  reconcile --profile <name>   Re-check already-filtered postings against today's rules (after a prefs/filter change) and score any that now pass",
  "  check-feedback --profile <name>|--all   Read new direct replies from the candidate (email and, if DIGEST_IMESSAGE_TO is set, iMessage), answer questions, and auto-apply any preference changes (FEEDBACK_LOOP_ENABLED=true required)",
  "  enrich-contact --profile <name>|--all   Link DIGEST_IMESSAGE_TO's phone to the candidate's Inkbox contact record (found via DIGEST_EMAIL_TO) and tag it with this profile. Idempotent; safe to re-run.",
  "  digest --profile <name>      Print the most recent digest without running the pipeline",
  "  sources --profile <name>     List the configured sources and check each one's health",
  "  costs                        Show what recent runs have cost (shared ledger)",
  "  profiles                     List every configured profile",
  "  dashboard --profile <name>   Serve the local review queue (default port 8899)",
  "",
  "Two people search through this one pipeline and their data never mixes —",
  "there is no default profile on purpose. See ADR 0017.",
].join("\n");

/** Subcommands that accept `--all` and run once per profile, in turn. */
const PER_PROFILE: Readonly<Record<string, (profile: string, ctx: JobsContext) => Promise<number>>> = {
  run: runJobsRun,
  reconcile: runJobsReconcile,
  "check-feedback": checkFeedback,
  "enrich-contact": runJobsEnrichContact,
};

/** Subcommands that act on exactly one profile. */
const SINGLE_PROFILE: Readonly<Record<string, (profile: string, ctx: JobsContext, args: readonly string[]) => Promise<number>>> = {
  digest: printLatestDigest,
  sources: listSources,
  dashboard: serveDashboard,
};

/** Reads `--profile <name>` out of an argument list. Absent is a real answer (undefined), not a guess. */
export function parseProfileFlag(args: readonly string[]): string | undefined {
  const index = args.indexOf("--profile");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export async function runJobsCommand(args: readonly string[], deps: JobsCommandDeps): Promise<number> {
  const ctx = resolveJobsContext(deps);
  const [subcommand, ...rest] = args;

  const perProfile = subcommand === undefined ? undefined : PER_PROFILE[subcommand];
  if (perProfile) {
    const profiles = await resolveProfiles(rest, ctx, true);
    if (!profiles) return 1;
    let worst = 0;
    for (const profile of profiles) {
      if (profiles.length > 1) ctx.stdout(`\n===== ${profile} =====\n`);
      worst = Math.max(worst, await perProfile(profile, ctx));
    }
    return worst;
  }

  const single = subcommand === undefined ? undefined : SINGLE_PROFILE[subcommand];
  if (single) {
    const profiles = await resolveProfiles(rest, ctx, false);
    if (!profiles) return 1;
    return single(profiles[0] as string, ctx, rest);
  }

  switch (subcommand) {
    case "costs":
      return printCosts(ctx);
    case "profiles": {
      const known = await listProfiles(ctx.root);
      if (known.length === 0) ctx.stdout(`No profiles configured yet under ${CONFIG_ROOT}/.`);
      else for (const profile of known) ctx.stdout(profile);
      return 0;
    }
    default:
      ctx.stdout(USAGE);
      return subcommand === undefined || subcommand === "help" ? 0 : 1;
  }
}

/**
 * Resolves which profiles a command should act on. Deliberately refuses to
 * pick one for you: with two real people's searches in one repo, guessing
 * wrong means showing or writing the wrong person's data.
 */
async function resolveProfiles(args: readonly string[], ctx: JobsContext, allowAll: boolean): Promise<readonly string[] | undefined> {
  const known = await listProfiles(ctx.root);
  const configured = known.length > 0 ? `Configured: ${known.join(", ")}.` : `None configured yet under ${CONFIG_ROOT}/.`;

  if (allowAll && args.includes("--all")) {
    if (known.length === 0) {
      ctx.stderr(`No profiles configured. Create ${CONFIG_ROOT}/<name>/preferences.json first.`);
      return undefined;
    }
    return known;
  }

  const requested = parseProfileFlag(args);
  if (!requested) {
    ctx.stderr(`Which profile? Pass --profile <name>${allowAll ? " or --all" : ""}. ${configured}`);
    return undefined;
  }

  try {
    assertValidProfile(requested);
  } catch (error) {
    ctx.stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  if (!known.includes(requested)) {
    ctx.stderr(`No profile named "${requested}". ${configured}`);
    return undefined;
  }

  return [requested];
}

interface Scoring {
  readonly candidate: CandidateProfile;
  readonly client: ScoringClient | undefined;
  /** Why scoring can't happen, when it can't — the digest prints this, so it must be the real cause. */
  readonly unavailableReason: string | undefined;
}

/**
 * A missing resume stops scoring, not the run: discovery and filtering are
 * still worth doing. The two reasons scoring can be unavailable are kept
 * distinct because confusing them sends whoever reads the digest chasing the
 * wrong fix (confirmed in production Sep 14 — a run with a good
 * ANTHROPIC_API_KEY said "no ANTHROPIC_API_KEY configured" when the real
 * cause was a missing resume).
 */
async function prepareScoring(profile: string, ctx: JobsContext, noKeyWarning: string): Promise<Scoring> {
  try {
    const candidate = await loadProfile(profile, ctx.root);
    const client = ctx.clients.scoring();
    if (!client) ctx.stderr(noKeyWarning);
    return { candidate, client, unavailableReason: client ? undefined : "no ANTHROPIC_API_KEY configured" };
  } catch (error) {
    if (!(error instanceof MissingProfileError)) throw error;
    ctx.stderr(error.message);
    return { candidate: { resume: "", notes: "" }, client: undefined, unavailableReason: "no resume on file for this profile yet" };
  }
}

/** Every configured source: the watchlist, plus LinkedIn/Indeed alert mail when Inkbox is set up (ADR 0013, 0015). */
function buildSources(watchlist: readonly WatchlistEntry[], ctx: JobsContext): { readonly sources: Source[]; readonly hasAlertMail: boolean } {
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];
  const inkbox = ctx.clients.inkbox();
  if (inkbox) sources.push(createAlertMailSource(inkbox));
  return { sources, hasAlertMail: inkbox !== undefined };
}

/** Writes the timestamped digest plus latest.md/latest.json, which `jobs digest`, the dashboard, and the feedback loop read. */
async function writeDigest(profile: string, ctx: JobsContext, summary: RunSummary, markdown: string, prefix = ""): Promise<string> {
  const digestDir = join(ctx.root, dataDirFor(profile), "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `${prefix}${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");
  return join(digestDir, "latest.md");
}

async function runJobsRun(profile: string, ctx: JobsContext): Promise<number> {
  const prefs = await loadPreferences(profile, ctx.root);
  const watchlist = await loadWatchlist(profile, ctx.root);
  const { sources, hasAlertMail } = buildSources(watchlist, ctx);

  if (watchlist.length === 0 && !hasAlertMail) {
    ctx.stderr(
      `No sources configured for ${profile}: ${join(configDirFor(profile), "watchlist.json")} is empty and Inkbox (for LinkedIn/Indeed alerts) is not set up. Add at least one.`,
    );
    return 1;
  }

  const scoring = await prepareScoring(profile, ctx, "ANTHROPIC_API_KEY is not set — running discovery only, scoring will be skipped.");

  const summary = await runPipeline({
    sources,
    store: new JsonFileJobStore(join(ctx.root, dataDirFor(profile))),
    prefs,
    profile: scoring.candidate,
    scoringClient: scoring.client,
    scoringUnavailableReason: scoring.unavailableReason,
    costLogPath: join(ctx.root, COST_LOG_PATH),
  });

  const markdown = renderDigest(summary);
  const latestPath = await writeDigest(profile, ctx, summary, markdown);
  ctx.stdout(markdown);
  ctx.stdout("");
  ctx.stdout(`Digest written to ${latestPath}`);

  await deliverDigest(summary, ctx);

  // Piggybacks on the pipeline's own daily schedule so the feedback loop gets
  // at least one pass a day with no separate scheduling. A no-op unless
  // FEEDBACK_LOOP_ENABLED is on; run `jobs check-feedback` directly (or on its
  // own schedule) for faster turnaround.
  await checkFeedback(profile, ctx);

  // A run where every source broke is a failure worth a non-zero exit, so a
  // scheduled job surfaces it rather than looking like a quiet success.
  const allBroken = summary.health.length > 0 && summary.health.every((entry) => entry.state === "degraded");
  return allBroken ? 1 : 0;
}

/**
 * Re-checks every currently `filtered` posting against today's prefs and
 * scores whatever now passes. Exists because dedupe treats anything already
 * in the store as known forever — see reconcile.ts — so a prefs or filter
 * logic change only ever affects postings discovered after the change
 * unless something explicitly replays the old ones too. Fetches nothing new;
 * it only re-judges what the store already has.
 */
async function runJobsReconcile(profile: string, ctx: JobsContext): Promise<number> {
  const prefs = await loadPreferences(profile, ctx.root);
  const store = new JsonFileJobStore(join(ctx.root, dataDirFor(profile)));
  const all = await store.listJobs();
  const { rescued, stillFiltered } = reconcileFiltered(all, prefs);

  ctx.stdout(`${all.filter((r) => r.state === "filtered").length} previously-filtered posting(s) checked against current rules.`);

  if (rescued.length === 0) {
    ctx.stdout("None now pass. Nothing to score, nothing written.");
    return 0;
  }

  const scoring = await prepareScoring(profile, ctx, "ANTHROPIC_API_KEY is not set — rescued postings will be saved unscored.");

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new CostLedger(runId, join(ctx.root, COST_LOG_PATH));

  let scored: readonly JobRecord[] = [];
  let failures: readonly string[] = [];
  if (scoring.client) {
    ({ scored, failures } = await scoreRecords(rescued, scoring.candidate, prefs, scoring.client, ledger));
  } else {
    failures = [`${rescued.length} rescued posting(s) not scored: ${scoring.unavailableReason}.`];
  }

  const scoredIds = new Set(scored.map((record) => record.id));
  const unscored = rescued.filter((record) => !scoredIds.has(record.id));
  await store.saveJobs([...scored, ...unscored, ...stillFiltered]);

  const ranked = sortByRank(scored, prefs);
  const shortlisted = ranked.filter((record) => (record.score ?? 0) >= prefs.scoreCutoff).slice(0, prefs.digestLimit);
  const alsoSeen = ranked.filter((record) => !shortlisted.includes(record));
  const tokens = ledger.totalTokens();

  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetchedCount: 0,
    newCount: rescued.length,
    duplicateCount: 0,
    filteredCount: stillFiltered.length,
    filterReasons: summarizeRejections(stillFiltered),
    scoredCount: scored.length,
    shortlisted,
    alsoSeen,
    health: [],
    failures,
    costUsd: ledger.total(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };

  const markdown = renderDigest(summary).replace(
    "# Job digest",
    "# Job digest (reconciliation — re-checked previously-filtered postings, fetched nothing new)",
  );
  await writeDigest(profile, ctx, summary, markdown, "reconcile-");

  ctx.stdout(markdown);
  ctx.stdout("");
  ctx.stdout(`${rescued.length} rescued, ${scored.length} scored, ${shortlisted.length} clear the cutoff.`);

  await deliverDigest(summary, ctx);
  return 0;
}

async function printLatestDigest(profile: string, ctx: JobsContext): Promise<number> {
  try {
    ctx.stdout(await readFile(join(ctx.root, dataDirFor(profile), "digests", "latest.md"), "utf8"));
    return 0;
  } catch {
    ctx.stderr(`No digest yet for ${profile}. Run \`orchestrator jobs run --profile ${profile}\` first.`);
    return 1;
  }
}

async function listSources(profile: string, ctx: JobsContext): Promise<number> {
  const { sources, hasAlertMail } = buildSources(await loadWatchlist(profile, ctx.root), ctx);
  if (!hasAlertMail) {
    ctx.stdout("(LinkedIn/Indeed alert-mail source not checked — INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS not set)");
  }

  if (sources.length === 0) {
    ctx.stderr(`No sources configured in ${join(configDirFor(profile), "watchlist.json")}, and Inkbox is not set up.`);
    return 1;
  }

  ctx.stdout(`${sources.length} source(s) configured. Checking each...`);
  let broken = 0;

  for (const source of sources) {
    try {
      const postings = await source.fetch();
      ctx.stdout(`  ok        ${source.id} — ${postings.length} posting(s)`);
    } catch (error) {
      broken += 1;
      ctx.stdout(`  BROKEN    ${source.id} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return broken > 0 ? 1 : 0;
}

async function printCosts(ctx: JobsContext): Promise<number> {
  const entries = await readLedger(join(ctx.root, COST_LOG_PATH));
  if (entries.length === 0) {
    ctx.stdout("No model spend recorded yet.");
    return 0;
  }

  const byRun = new Map<string, { cost: number; ts: string }>();
  for (const entry of entries) {
    const current = byRun.get(entry.runId) ?? { cost: 0, ts: entry.ts };
    byRun.set(entry.runId, { cost: current.cost + entry.costUsd, ts: current.ts });
  }

  const runs = [...byRun.entries()].sort((left, right) => left[1].ts.localeCompare(right[1].ts));
  for (const [runId, run] of runs.slice(-20)) {
    ctx.stdout(`  ${run.ts.slice(0, 16).replace("T", " ")}  $${run.cost.toFixed(4)}  ${runId.slice(0, 8)}`);
  }

  const total = runs.reduce((sum, [, run]) => sum + run.cost, 0);
  ctx.stdout("");
  ctx.stdout(`${runs.length} run(s), $${total.toFixed(2)} total.`);
  return 0;
}

/** Serves the review queue. Read-only: no endpoint here can act on the outside world. */
async function serveDashboard(profile: string, ctx: JobsContext, args: readonly string[]): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 8899;
  if (!Number.isFinite(port) || port <= 0) {
    ctx.stderr("--port must be a positive number.");
    return 1;
  }

  const server = createJobsDashboardServer({ dataDir: join(ctx.root, dataDirFor(profile)) });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  ctx.stdout(`Job queue for ${profile}: http://localhost:${port}  (ctrl-c to stop)`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
