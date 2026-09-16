import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../jobsearch/pipeline";
import { renderDigest, digestPayload, type RunSummary } from "../jobsearch/digest";
import { sourcesFromWatchlist } from "../jobsearch/sources/registry";
import { JsonFileJobStore } from "../store/job-store";
import { createScoringClientFromEnv } from "../jobsearch/scoring-client";
import { CostLedger, readLedger } from "../jobsearch/cost";
import { createJobsDashboardServer } from "../jobsearch/dashboard";
import { createAlertMailSource } from "../jobsearch/sources/alert-mail";
import { createInkboxClientFromEnv } from "../integrations/inkbox/real-client";
import type { Source } from "../jobsearch/sources/source";
import { createSmsClientFromEnv, SmsRecipientBlockedError } from "../jobsearch/sms-client";
import { formatDigestSms } from "../jobsearch/digest-sms";
import { formatDigestEmailBody, formatDigestEmailSubject } from "../jobsearch/digest-email";
import { reconcileFiltered } from "../jobsearch/reconcile";
import { scoreRecords } from "../jobsearch/score";
import { sortByRank } from "../jobsearch/rank";
import { summarizeRejections } from "../jobsearch/filter";
import type { JobRecord } from "../jobsearch/records";
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
  savePreferences,
} from "../jobsearch/config";
import type { CandidateProfile } from "../jobsearch/score";
import {
  applyFeedbackPatch,
  buildFeedbackReplyBody,
  classifyFeedback,
  looksLikeDirectMessage,
  looksLikeDirectText,
  type PatchEntry,
} from "../jobsearch/feedback";
import { JsonFileFeedbackLog } from "../jobsearch/feedback-log";
import { createImessageClientFromEnv } from "../jobsearch/imessage-client";
import { commitAndPush } from "../integrations/git/auto-commit";

/**
 * `orchestrator jobs ...` — the pipeline's command surface, and the single
 * entrypoint the scheduled run invokes. Nothing here is interactive: a
 * launchd job runs `jobs run` and everything it needs comes from config files
 * and the environment.
 */

export interface JobsCommandDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly root?: string;
}

const USAGE = [
  "jobs subcommands (every one takes --profile <name>, or --all where noted):",
  "  run --profile <name>|--all   Fetch, dedupe, filter, score, and write today's digest",
  "  reconcile --profile <name>   Re-check already-filtered postings against today's rules (after a prefs/filter change) and score any that now pass",
  "  check-feedback --profile <name>|--all   Read new direct replies from the candidate (email and, if DIGEST_IMESSAGE_TO is set, iMessage), answer questions, and auto-apply any preference changes (FEEDBACK_LOOP_ENABLED=true required)",
  "  digest --profile <name>      Print the most recent digest without running the pipeline",
  "  sources --profile <name>     List the configured sources and check each one's health",
  "  costs                        Show what recent runs have cost (shared ledger)",
  "  profiles                     List every configured profile",
  "  dashboard --profile <name>   Serve the local review queue (default port 8899)",
  "",
  "Two people search through this one pipeline and their data never mixes —",
  "there is no default profile on purpose. See ADR 0017.",
].join("\n");

/** Reads `--profile <name>` out of an argument list. Absent is a real answer (undefined), not a guess. */
export function parseProfileFlag(args: readonly string[]): string | undefined {
  const index = args.indexOf("--profile");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Resolves which profiles a command should act on. Deliberately refuses to
 * pick one for you: with two real people's searches in one repo, guessing
 * wrong means showing or writing the wrong person's data.
 */
async function resolveProfiles(
  args: readonly string[],
  root: string,
  deps: JobsCommandDeps,
  allowAll: boolean,
): Promise<readonly string[] | undefined> {
  const known = await listProfiles(root);

  if (allowAll && args.includes("--all")) {
    if (known.length === 0) {
      deps.stderr(`No profiles configured. Create ${CONFIG_ROOT}/<name>/preferences.json first.`);
      return undefined;
    }
    return known;
  }

  const requested = parseProfileFlag(args);
  if (!requested) {
    deps.stderr(
      `Which profile? Pass --profile <name>${allowAll ? " or --all" : ""}. ` +
        (known.length > 0 ? `Configured: ${known.join(", ")}.` : `None configured yet under ${CONFIG_ROOT}/.`),
    );
    return undefined;
  }

  try {
    assertValidProfile(requested);
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  if (!known.includes(requested)) {
    deps.stderr(
      `No profile named "${requested}". ` +
        (known.length > 0 ? `Configured: ${known.join(", ")}.` : `None configured yet under ${CONFIG_ROOT}/.`),
    );
    return undefined;
  }

  return [requested];
}

export async function runJobsCommand(args: readonly string[], deps: JobsCommandDeps): Promise<number> {
  const root = deps.root ?? ".";
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "run": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsRun(profile, root, deps));
      }
      return worst;
    }
    case "reconcile": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsReconcile(profile, root, deps));
      }
      return worst;
    }
    case "check-feedback": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsCheckFeedback(profile, root, deps));
      }
      return worst;
    }
    case "digest": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return printLatestDigest(profiles[0] as string, root, deps);
    }
    case "sources": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return listSources(profiles[0] as string, root, deps);
    }
    case "costs":
      return printCosts(root, deps);
    case "profiles": {
      const known = await listProfiles(root);
      if (known.length === 0) deps.stdout(`No profiles configured yet under ${CONFIG_ROOT}/.`);
      else for (const profile of known) deps.stdout(profile);
      return 0;
    }
    case "dashboard": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return serveDashboard(rest, profiles[0] as string, root, deps);
    }
    default:
      deps.stdout(USAGE);
      return subcommand === undefined || subcommand === "help" ? 0 : 1;
  }
}

async function runJobsRun(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(profile, root);
  const watchlist = await loadWatchlist(profile, root);
  const inkboxClient = createInkboxClientFromEnv();

  if (watchlist.length === 0 && !inkboxClient) {
    deps.stderr(
      `No sources configured for ${profile}: ${join(configDirFor(profile), "watchlist.json")} is empty and Inkbox (for LinkedIn/Indeed alerts) is not set up. Add at least one.`,
    );
    return 1;
  }

  // A missing resume stops scoring, not the run: discovery and filtering are
  // still worth doing, and the digest says plainly why nothing was scored.
  let candidate: CandidateProfile = { resume: "", notes: "" };
  let profileMissing: string | null = null;
  try {
    candidate = await loadProfile(profile, root);
  } catch (error) {
    if (error instanceof MissingProfileError) {
      profileMissing = error.message;
    } else {
      throw error;
    }
  }

  const scoringClient = profileMissing ? undefined : createScoringClientFromEnv();
  if (!profileMissing && !scoringClient) {
    deps.stderr("ANTHROPIC_API_KEY is not set — running discovery only, scoring will be skipped.");
  }
  if (profileMissing) deps.stderr(profileMissing);
  // The digest's own failure line needs the real cause, not an assumption:
  // scoringClient can be undefined for two different reasons, and confusing
  // them sends whoever reads it chasing the wrong fix (confirmed in
  // production Sep 14 — a run with a perfectly good ANTHROPIC_API_KEY still
  // said "no ANTHROPIC_API_KEY configured" because the real cause was a
  // missing resume).
  const scoringUnavailableReason = profileMissing
    ? "no resume on file for this profile yet"
    : !scoringClient
      ? "no ANTHROPIC_API_KEY configured"
      : undefined;

  // Adds LinkedIn/Indeed coverage via forwarded alert emails (ADR 0013,
  // ADR 0015) when Inkbox is configured. Silently absent otherwise — never
  // a half-configured source, same pattern as the scoring client above.
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];
  if (inkboxClient) sources.push(createAlertMailSource(inkboxClient));

  const summary = await runPipeline({
    sources,
    store: new JsonFileJobStore(join(root, dataDirFor(profile))),
    prefs,
    profile: candidate,
    scoringClient,
    scoringUnavailableReason,
    costLogPath: join(root, COST_LOG_PATH),
  });

  const markdown = renderDigest(summary);
  const digestDir = join(root, dataDirFor(profile), "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");

  deps.stdout(markdown);
  deps.stdout("");
  deps.stdout(`Digest written to ${join(digestDir, "latest.md")}`);

  await sendDigestSmsIfConfigured(summary, deps);
  await sendDigestImessageIfConfigured(summary, deps);
  await sendDigestEmailIfConfigured(summary, deps);

  // Piggybacks on the same daily schedule as the pipeline itself, so the
  // feedback loop gets at least one pass a day with no separate scheduling
  // required. Self-gated on FEEDBACK_LOOP_ENABLED like every other optional
  // step above — a no-op unless explicitly turned on. Run `jobs check-feedback`
  // directly (or on its own more frequent schedule) for faster turnaround.
  await runJobsCheckFeedback(profile, root, deps);

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
async function runJobsReconcile(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(profile, root);
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const all = await store.listJobs();
  const { rescued, stillFiltered } = reconcileFiltered(all, prefs);

  deps.stdout(`${all.filter((r) => r.state === "filtered").length} previously-filtered posting(s) checked against current rules.`);

  if (rescued.length === 0) {
    deps.stdout("None now pass. Nothing to score, nothing written.");
    return 0;
  }

  let candidate: CandidateProfile = { resume: "", notes: "" };
  let profileMissing: string | null = null;
  try {
    candidate = await loadProfile(profile, root);
  } catch (error) {
    if (error instanceof MissingProfileError) {
      profileMissing = error.message;
    } else {
      throw error;
    }
  }

  const scoringClient = profileMissing ? undefined : createScoringClientFromEnv();
  if (!profileMissing && !scoringClient) {
    deps.stderr("ANTHROPIC_API_KEY is not set — rescued postings will be saved unscored.");
  }
  if (profileMissing) deps.stderr(profileMissing);
  const scoringUnavailableReason = profileMissing ? "no resume on file for this profile yet" : "no ANTHROPIC_API_KEY configured";

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new CostLedger(runId, join(root, COST_LOG_PATH));

  let scored: readonly JobRecord[] = [];
  let failures: readonly string[] = [];
  if (scoringClient) {
    const result = await scoreRecords(rescued, candidate, prefs, scoringClient, ledger);
    scored = result.scored;
    failures = result.failures;
  } else {
    failures = [`${rescued.length} rescued posting(s) not scored: ${scoringUnavailableReason}.`];
  }

  const scoredIds = new Set(scored.map((record) => record.id));
  const unscored = rescued.filter((record) => !scoredIds.has(record.id));
  await store.saveJobs([...scored, ...unscored, ...stillFiltered]);

  const ranked = sortByRank(scored, prefs);
  const aboveCutoff = ranked.filter((record) => (record.score ?? 0) >= prefs.scoreCutoff);
  const shortlisted = aboveCutoff.slice(0, prefs.digestLimit);
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
  const digestDir = join(root, dataDirFor(profile), "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `reconcile-${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");

  deps.stdout(markdown);
  deps.stdout("");
  deps.stdout(`${rescued.length} rescued, ${scored.length} scored, ${shortlisted.length} clear the cutoff.`);

  await sendDigestSmsIfConfigured(summary, deps);
  await sendDigestImessageIfConfigured(summary, deps);
  await sendDigestEmailIfConfigured(summary, deps);

  return 0;
}

/**
 * The feedback loop: reads whatever's new on either channel — email and
 * iMessage both — picks out messages that are genuinely the candidate
 * writing directly to us (see feedback.ts's looksLikeDirectMessage and
 * looksLikeDirectText — deliberately narrow, the same distinction
 * owner-forwarding.ts had to make once her full inbox started
 * auto-forwarding through this same mailbox), and for each one: answers any
 * question, applies any preference change she asked for, and replies on the
 * same channel telling her exactly what happened. Applied per Irtiza's
 * explicit Sep 16 call — no approval step — but "no approval step" and
 * "no guessing" are different rules: an ambiguous ask is reported back to
 * her as something to clarify, never silently guessed at (see feedback.ts's
 * own doc comment for why that distinction is load-bearing here).
 *
 * Config changes are committed and pushed immediately (commitAndPush) —
 * necessary because the scheduled pipeline run never runs `git pull`
 * first (see scripts/com.mobyai.jobsearch.plist), so an applied-but-
 * uncommitted change would vanish the moment anything else pulls or the
 * worktree is recreated. Both channels share this same apply-and-commit
 * step (applyFeedbackChanges below), since which channel she happened to
 * use has no bearing on how a change to preferences.json gets made durable.
 */
async function runJobsCheckFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  if (process.env["FEEDBACK_LOOP_ENABLED"] !== "true") return 0;

  const emailResult = await checkEmailFeedback(profile, root, deps);
  const imessageResult = await checkImessageFeedback(profile, root, deps);
  return Math.max(emailResult, imessageResult);
}

/**
 * Applies whichever of `changes` are well-typed and allow-listed, and —
 * only when at least one actually applied — writes preferences.json and
 * commits+pushes it. Shared by both feedback channels below so the
 * write/commit path (and its failure handling) exists in exactly one place.
 */
async function applyFeedbackChanges(
  profile: string,
  root: string,
  changes: readonly PatchEntry[],
  prefs: Awaited<ReturnType<typeof loadPreferences>>,
  deps: JobsCommandDeps,
): Promise<{ readonly applied: readonly PatchEntry[]; readonly rejected: readonly PatchEntry[] }> {
  if (changes.length === 0) return { applied: [], rejected: [] };

  const patchResult = applyFeedbackPatch(prefs, changes);
  if (patchResult.applied.length > 0) {
    const patch = Object.fromEntries(patchResult.applied.map((c) => [c.field, c.value]));
    await savePreferences(profile, patch, root);

    const commitMessage = `feedback(${profile}): ${patchResult.applied.map((c) => `${c.field} — "${c.quote}"`).join("; ")}`;
    const gitResult = commitAndPush(join(configDirFor(profile), "preferences.json"), commitMessage, root);
    if (gitResult.error) {
      deps.stderr(`Applied a preference change locally but git failed (${gitResult.error}) — it will not survive a re-pull until this is fixed.`);
    } else if (gitResult.committed) {
      deps.stdout(`Committed and pushed: ${commitMessage}`);
    }
  }

  return { applied: patchResult.applied, rejected: patchResult.rejected };
}

/** Builds the same "Score cutoff: ... Salary floor: ..." context string both channels give the classifier, so a text and an email asking the same thing get judged against identical facts. */
function feedbackRunContext(prefs: Awaited<ReturnType<typeof loadPreferences>>): string {
  return `Score cutoff: ${prefs.scoreCutoff}. Salary floor: ${prefs.salaryFloor ?? "none stated"}. Titles tracked: ${prefs.titles.join(", ") || "(none configured)"}. Metros: ${prefs.metros.join(", ") || "(none — remote only)"}.`;
}

async function checkEmailFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  // The same address her digest goes to is the address whose direct
  // replies count as her own feedback — one identity, not a second env var
  // that could quietly drift from the first.
  const candidateEmail = process.env["DIGEST_EMAIL_TO"];
  if (!candidateEmail) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but DIGEST_EMAIL_TO is not set — skipping the email feedback channel (no address to treat as her own).");
    return 1;
  }

  const inkboxClient = createInkboxClientFromEnv();
  if (!inkboxClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but Inkbox is not configured — skipping the email feedback channel.");
    return 1;
  }

  const scoringClient = createScoringClientFromEnv();
  if (!scoringClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
    return 1;
  }

  const prefs = await loadPreferences(profile, root);
  const feedbackLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback"));
  const ledger = new CostLedger(randomUUID(), join(root, COST_LOG_PATH));

  // searchMail can return snippet-level messages (confirmed Sep 14 — the
  // same characteristic alert-mail.ts had to work around) — every candidate
  // here gets re-fetched in full via getMessage before classification, never
  // classified off a truncated snippet.
  const candidates = await inkboxClient.searchMail();
  let processed = 0;

  for (const summary of candidates) {
    if (await feedbackLog.hasProcessed(summary.id)) continue;
    if (!looksLikeDirectMessage(summary, candidateEmail, inkboxClient.mailboxAddress)) continue;

    const full = (await inkboxClient.getMessage(summary.id)) ?? summary;
    const classification = await classifyFeedback(full.body, prefs, feedbackRunContext(prefs), scoringClient, prefs.scoringModel, ledger);
    const { applied, rejected } = await applyFeedbackChanges(profile, root, classification.changes, prefs, deps);
    if (applied.length > 0) {
      deps.stdout(`Applied feedback from ${full.from.address}: ${applied.map((c) => `${c.field} -> ${JSON.stringify(c.value)}`).join(", ")}`);
    }

    const replyBody = buildFeedbackReplyBody(classification, applied, rejected);
    let replied = false;
    if (replyBody.length > 0) {
      try {
        const draft = await inkboxClient.saveDraft({
          to: [{ address: full.from.address }],
          subject: full.subject.toLowerCase().startsWith("re:") ? full.subject : `Re: ${full.subject}`,
          body: replyBody,
          threadId: full.threadId,
        });
        await inkboxClient.send({ draftId: draft.id, revision: draft.revision });
        replied = true;
        deps.stdout(`Replied to ${full.from.address}.`);
      } catch (error) {
        deps.stderr(`Could not reply to ${full.from.address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await feedbackLog.record({
      messageId: full.id,
      fromAddress: full.from.address,
      processedAt: new Date().toISOString(),
      appliedFields: applied.map((c) => c.field),
      hadQuestion: classification.hasQuestion,
      replied,
    });
    processed += 1;
  }

  if (processed === 0) deps.stdout("No new direct feedback emails found.");
  return 0;
}

/**
 * The iMessage twin of checkEmailFeedback above. Reuses DIGEST_IMESSAGE_TO
 * as her phone identity — same reasoning as reusing DIGEST_EMAIL_TO for the
 * email channel: one setting, not a second one that could quietly drift out
 * of sync — regardless of whether DIGEST_IMESSAGE_ENABLED (which only
 * controls the outbound daily-digest text) happens to be on; texting in
 * feedback and receiving the digest by text are independent choices.
 * Missing DIGEST_IMESSAGE_TO is treated as "she hasn't opted into texting
 * in feedback," not an error — unlike the email channel, which is the
 * primary channel and always expected to be configured.
 */
async function checkImessageFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const candidatePhone = process.env["DIGEST_IMESSAGE_TO"];
  if (!candidatePhone) return 0;

  const imessageClient = createImessageClientFromEnv();
  if (!imessageClient) {
    deps.stderr("DIGEST_IMESSAGE_TO is set but Inkbox iMessage is not configured (INKBOX_API_KEY/INKBOX_IDENTITY_ID) — skipping the iMessage feedback channel.");
    return 1;
  }

  const scoringClient = createScoringClientFromEnv();
  if (!scoringClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
    return 1;
  }

  const prefs = await loadPreferences(profile, root);
  const feedbackLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback-imessage"));
  const ledger = new CostLedger(randomUUID(), join(root, COST_LOG_PATH));

  const messages = await imessageClient.listMessages();
  let processed = 0;

  for (const message of messages) {
    if (await feedbackLog.hasProcessed(message.id)) continue;
    if (!looksLikeDirectText(message, candidatePhone)) continue;

    const classification = await classifyFeedback(message.content, prefs, feedbackRunContext(prefs), scoringClient, prefs.scoringModel, ledger);
    const { applied, rejected } = await applyFeedbackChanges(profile, root, classification.changes, prefs, deps);
    if (applied.length > 0) {
      deps.stdout(`Applied feedback (text) from ${message.remoteNumber}: ${applied.map((c) => `${c.field} -> ${JSON.stringify(c.value)}`).join(", ")}`);
    }

    const replyBody = buildFeedbackReplyBody(classification, applied, rejected);
    let replied = false;
    if (replyBody.length > 0) {
      try {
        await imessageClient.send(candidatePhone, replyBody);
        replied = true;
        deps.stdout(`Texted a reply to ${candidatePhone}.`);
      } catch (error) {
        deps.stderr(`Could not text a reply to ${candidatePhone}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await feedbackLog.record({
      messageId: message.id,
      fromAddress: message.remoteNumber ?? candidatePhone,
      processedAt: new Date().toISOString(),
      appliedFields: applied.map((c) => c.field),
      hadQuestion: classification.hasQuestion,
      replied,
    });
    processed += 1;
  }

  if (processed === 0) deps.stdout("No new direct feedback texts found.");
  return 0;
}

async function printLatestDigest(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  try {
    deps.stdout(await readFile(join(root, dataDirFor(profile), "digests", "latest.md"), "utf8"));
    return 0;
  } catch {
    deps.stderr(`No digest yet for ${profile}. Run \`orchestrator jobs run --profile ${profile}\` first.`);
    return 1;
  }
}

async function listSources(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const watchlist = await loadWatchlist(profile, root);
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];

  const inkboxClient = createInkboxClientFromEnv();
  if (inkboxClient) {
    sources.push(createAlertMailSource(inkboxClient));
  } else {
    deps.stdout("(LinkedIn/Indeed alert-mail source not checked — INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS not set)");
  }

  if (sources.length === 0) {
    deps.stderr(`No sources configured in ${join(configDirFor(profile), "watchlist.json")}, and Inkbox is not set up.`);
    return 1;
  }

  deps.stdout(`${sources.length} source(s) configured. Checking each...`);
  let broken = 0;

  for (const source of sources) {
    try {
      const postings = await source.fetch();
      deps.stdout(`  ok        ${source.id} — ${postings.length} posting(s)`);
    } catch (error) {
      broken += 1;
      deps.stdout(`  BROKEN    ${source.id} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return broken > 0 ? 1 : 0;
}

async function printCosts(root: string, deps: JobsCommandDeps): Promise<number> {
  const entries = await readLedger(join(root, COST_LOG_PATH));
  if (entries.length === 0) {
    deps.stdout("No model spend recorded yet.");
    return 0;
  }

  const byRun = new Map<string, { cost: number; ts: string }>();
  for (const entry of entries) {
    const current = byRun.get(entry.runId) ?? { cost: 0, ts: entry.ts };
    byRun.set(entry.runId, { cost: current.cost + entry.costUsd, ts: current.ts });
  }

  const runs = [...byRun.entries()].sort((left, right) => left[1].ts.localeCompare(right[1].ts));
  for (const [runId, run] of runs.slice(-20)) {
    deps.stdout(`  ${run.ts.slice(0, 16).replace("T", " ")}  $${run.cost.toFixed(4)}  ${runId.slice(0, 8)}`);
  }

  const total = runs.reduce((sum, [, run]) => sum + run.cost, 0);
  deps.stdout("");
  deps.stdout(`${runs.length} run(s), $${total.toFixed(2)} total.`);
  return 0;
}

/**
 * Texts the digest, when — and only when — every one of these is explicitly
 * set: an SMS client can be built from the environment (INKBOX_API_KEY +
 * INKBOX_SMS_PHONE_NUMBER_ID), a destination number is configured
 * (DIGEST_SMS_TO), and DIGEST_SMS_ENABLED is exactly "true". Three separate
 * gates on purpose — having the credentials configured for testing must
 * never be the same thing as live automated sends being turned on for a
 * real person's phone.
 *
 * A failure here (most commonly: the destination hasn't been recorded as
 * opted in with Inkbox yet) is reported and never fails the run — the
 * digest itself was already written successfully before this runs.
 */
async function sendDigestSmsIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (process.env["DIGEST_SMS_ENABLED"] !== "true") return;

  const to = process.env["DIGEST_SMS_TO"];
  if (!to) {
    deps.stderr("DIGEST_SMS_ENABLED is true but DIGEST_SMS_TO is not set — skipping the text.");
    return;
  }

  const client = createSmsClientFromEnv();
  if (!client) {
    deps.stderr("DIGEST_SMS_ENABLED is true but INKBOX_API_KEY/INKBOX_SMS_PHONE_NUMBER_ID are not both set — skipping the text.");
    return;
  }

  const maxRoles = Number.parseInt(process.env["DIGEST_SMS_MAX_ROLES"] ?? "5", 10);
  const text = formatDigestSms(summary, Number.isFinite(maxRoles) && maxRoles > 0 ? maxRoles : 5);

  try {
    await client.send(to, text);
    deps.stdout(`Digest texted to ${to}.`);
  } catch (error) {
    if (error instanceof SmsRecipientBlockedError) {
      deps.stderr(
        `Could not text the digest: ${error.message} Check that this number has been recorded as opted in through Inkbox before expecting this to work.`,
      );
    } else {
      deps.stderr(`Could not text the digest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Sends the digest as an iMessage, when — and only when — DIGEST_IMESSAGE_ENABLED
 * is exactly "true", DIGEST_IMESSAGE_TO is set, and INKBOX_API_KEY is present.
 * Three separate gates — same reasoning as sendDigestSmsIfConfigured above.
 * A send failure is reported and never fails the run.
 */
async function sendDigestImessageIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (process.env["DIGEST_IMESSAGE_ENABLED"] !== "true") return;

  const to = process.env["DIGEST_IMESSAGE_TO"];
  if (!to) {
    deps.stderr("DIGEST_IMESSAGE_ENABLED is true but DIGEST_IMESSAGE_TO is not set — skipping iMessage.");
    return;
  }

  const apiKey = process.env["INKBOX_API_KEY"];
  if (!apiKey) {
    deps.stderr("DIGEST_IMESSAGE_ENABLED is true but INKBOX_API_KEY is not set — skipping iMessage.");
    return;
  }

  const identityId = process.env["INKBOX_IDENTITY_ID"];
  if (!identityId) {
    deps.stderr("DIGEST_IMESSAGE_ENABLED is true but INKBOX_IDENTITY_ID is not set — skipping iMessage.");
    return;
  }

  const maxRoles = Number.parseInt(process.env["DIGEST_IMESSAGE_MAX_ROLES"] ?? "5", 10);
  const text = formatDigestSms(summary, Number.isFinite(maxRoles) && maxRoles > 0 ? maxRoles : 5);

  try {
    const url = `https://inkbox.ai/api/v1/imessage/messages?agent_identity_id=${encodeURIComponent(identityId)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ to, text }),
    });
    if (!response.ok) {
      let detail: string;
      try {
        const err = (await response.json()) as { detail?: string };
        detail = err.detail ?? response.statusText;
      } catch {
        detail = response.statusText;
      }
      deps.stderr(`Could not iMessage the digest: HTTP ${response.status} — ${detail}`);
      return;
    }
    deps.stdout(`Digest iMessaged to ${to}.`);
  } catch (error) {
    deps.stderr(`Could not iMessage the digest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Emails the digest, when — and only when — DIGEST_EMAIL_ENABLED is exactly
 * "true", DIGEST_EMAIL_TO is set, and Inkbox is configured. Same three-gate
 * shape as the SMS/iMessage senders above, and the same non-fatal failure
 * handling — a send failure is reported, never fails the run.
 *
 * Goes through InkboxClient's draft-then-send flow (saveDraft, then send by
 * the draft's own id+revision) rather than a bespoke endpoint, because
 * that's the one path in this codebase that actually delivers mail — see
 * client.ts: `send` is explicitly "Consequential: actually delivers the
 * draft." A digest to Shivani about her own job search is informational,
 * not a job application or anything the CLAUDE.md stage-and-stop rule is
 * about, so — same as the SMS/iMessage sends already did before this —
 * there is no separate human approval step between saveDraft and send here.
 */
async function sendDigestEmailIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (process.env["DIGEST_EMAIL_ENABLED"] !== "true") return;

  const to = process.env["DIGEST_EMAIL_TO"];
  if (!to) {
    deps.stderr("DIGEST_EMAIL_ENABLED is true but DIGEST_EMAIL_TO is not set — skipping the email.");
    return;
  }

  const client = createInkboxClientFromEnv();
  if (!client) {
    deps.stderr("DIGEST_EMAIL_ENABLED is true but Inkbox is not configured (INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS) — skipping the email.");
    return;
  }

  try {
    const draft = await client.saveDraft({
      to: [{ address: to }],
      subject: formatDigestEmailSubject(summary),
      body: formatDigestEmailBody(summary),
    });
    await client.send({ draftId: draft.id, revision: draft.revision });
    deps.stdout(`Digest emailed to ${to}.`);
  } catch (error) {
    deps.stderr(`Could not email the digest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Serves the review queue. Read-only: no endpoint here can act on the outside world. */
async function serveDashboard(args: readonly string[], profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 8899;
  if (!Number.isFinite(port) || port <= 0) {
    deps.stderr("--port must be a positive number.");
    return 1;
  }

  const server = createJobsDashboardServer({ dataDir: join(root, dataDirFor(profile)) });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  deps.stdout(`Job queue for ${profile}: http://localhost:${port}  (ctrl-c to stop)`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
