import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DigestPayload } from "../jobsearch/digest";
import { CostLedger } from "../jobsearch/cost";
import { COST_LOG_PATH, configDirFor, dataDirFor, loadPreferences, savePreferences } from "../jobsearch/config";
import {
  applyFeedbackPatch,
  buildConversationHistory,
  buildFeedbackReplyBody,
  buildRunContext,
  classifyFeedback,
  looksLikeDirectMessage,
  looksLikeDirectText,
  normalizePhone,
  type ConversationTurn,
} from "../jobsearch/feedback";
import { JsonFileFeedbackLog, type FeedbackRecord } from "../jobsearch/feedback-log";
import type { Preferences } from "../jobsearch/records";
import type { ScoringClient } from "../jobsearch/scoring-client";
import type { Contact } from "../integrations/inkbox/contact-client";
import { resolveJobsContext, type JobsCommandDeps, type JobsContext } from "./jobs-context";

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
 * Config changes are committed and pushed immediately — necessary because
 * the scheduled pipeline run never runs `git pull` first (see
 * scripts/com.mobyai.jobsearch.plist), so an applied-but-uncommitted change
 * would vanish the moment anything else pulls or the worktree is recreated.
 */
export async function runJobsCheckFeedback(profile: string, deps: JobsCommandDeps): Promise<number> {
  return checkFeedback(profile, resolveJobsContext(deps));
}

/** runJobsCheckFeedback for callers that already hold a resolved context. */
export async function checkFeedback(profile: string, ctx: JobsContext): Promise<number> {
  if (ctx.env["FEEDBACK_LOOP_ENABLED"] !== "true") return 0;

  const emailResult = await checkEmailFeedback(profile, ctx);
  const imessageResult = await checkImessageFeedback(profile, ctx);
  return Math.max(emailResult, imessageResult);
}

/** Everything one feedback message needs, whichever channel carried it. */
interface IncomingFeedback {
  readonly id: string;
  readonly from: string;
  readonly text: string;
  /** Sends the reply on the same channel the message arrived on. */
  readonly reply: (body: string) => Promise<void>;
}

interface FeedbackChannel {
  readonly label: string;
  readonly log: JsonFileFeedbackLog;
}

/** State shared by every message in one pass over one channel. */
interface FeedbackPass {
  readonly profile: string;
  readonly ctx: JobsContext;
  readonly prefs: Preferences;
  readonly scoringClient: ScoringClient;
  readonly ledger: CostLedger;
  readonly latestRun: DigestPayload | undefined;
  readonly runContext: string;
}

async function startPass(profile: string, ctx: JobsContext, scoringClient: ScoringClient): Promise<FeedbackPass> {
  const prefs = await loadPreferences(profile, ctx.root);
  const latestRun = await loadLatestDigestPayload(profile, ctx.root);
  return {
    profile,
    ctx,
    prefs,
    scoringClient,
    ledger: new CostLedger(randomUUID(), join(ctx.root, COST_LOG_PATH)),
    latestRun,
    runContext: buildRunContext(prefs, latestRun),
  };
}

/** Classify, apply, reply, record — identical for both channels. */
async function processFeedback(message: IncomingFeedback, channel: FeedbackChannel, pass: FeedbackPass): Promise<void> {
  const { ctx, profile, prefs } = pass;

  // Reloaded per message, not once per pass: if she sent more than one message
  // since the last check, an earlier one in this same pass needs to already be
  // in history by the time the next one is classified. Merges BOTH channel
  // logs, so a change made by email yesterday is visible to a text today.
  const conversationHistory = await loadConversationHistory(profile, ctx.root);
  const classification = await classifyFeedback(
    message.text,
    prefs,
    pass.runContext,
    pass.scoringClient,
    prefs.scoringModel,
    pass.ledger,
    conversationHistory,
  );

  const patch = applyFeedbackPatch(prefs, classification.changes);
  if (patch.applied.length > 0) {
    await persistPreferenceChanges(profile, patch.applied, ctx);
    ctx.stdout(`Applied feedback (${channel.label}) from ${message.from}: ${patch.applied.map((c) => `${c.field} -> ${JSON.stringify(c.value)}`).join(", ")}`);
  }

  const replyBody = buildFeedbackReplyBody(classification, patch.applied, patch.rejected, pass.latestRun);
  let replied = false;
  if (replyBody.length > 0) {
    try {
      await message.reply(replyBody);
      replied = true;
      ctx.stdout(`Replied (${channel.label}) to ${message.from}.`);
    } catch (error) {
      ctx.stderr(`Could not reply (${channel.label}) to ${message.from}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await channel.log.record({
    messageId: message.id,
    fromAddress: message.from,
    processedAt: new Date().toISOString(),
    appliedFields: patch.applied.map((c) => c.field),
    messageText: message.text,
    appliedChanges: patch.applied.map((c) => ({ field: c.field, value: c.value })),
    replyBody,
    hadQuestion: classification.hasQuestion,
    replied,
  });
}

/** Writes preferences.json and commits+pushes it, reporting — never throwing on — a git failure. */
async function persistPreferenceChanges(
  profile: string,
  applied: ReturnType<typeof applyFeedbackPatch>["applied"],
  ctx: JobsContext,
): Promise<void> {
  await savePreferences(profile, Object.fromEntries(applied.map((c) => [c.field, c.value])), ctx.root);

  const commitMessage = `feedback(${profile}): ${applied.map((c) => `${c.field} — "${c.quote}"`).join("; ")}`;
  const gitResult = ctx.clients.commitAndPush(join(configDirFor(profile), "preferences.json"), commitMessage, ctx.root);
  if (gitResult.error) {
    ctx.stderr(`Applied a preference change locally but git failed (${gitResult.error}) — it will not survive a re-pull until this is fixed.`);
  } else if (gitResult.committed) {
    ctx.stdout(`Committed and pushed: ${commitMessage}`);
  }
}

function feedbackLog(profile: string, root: string, channel: "email" | "imessage"): JsonFileFeedbackLog {
  return new JsonFileFeedbackLog(join(root, dataDirFor(profile), channel === "email" ? "feedback" : "feedback-imessage"));
}

async function checkEmailFeedback(profile: string, ctx: JobsContext): Promise<number> {
  // The same address her digest goes to is the address whose direct replies
  // count as her own feedback — one identity, not a second env var that could
  // quietly drift from the first.
  const candidateEmail = ctx.env["DIGEST_EMAIL_TO"];
  if (!candidateEmail) {
    ctx.stderr("FEEDBACK_LOOP_ENABLED is true but DIGEST_EMAIL_TO is not set — skipping the email feedback channel (no address to treat as her own).");
    return 1;
  }

  const inkbox = ctx.clients.inkbox();
  if (!inkbox) {
    ctx.stderr("FEEDBACK_LOOP_ENABLED is true but Inkbox is not configured — skipping the email feedback channel.");
    return 1;
  }

  const scoringClient = ctx.clients.scoring();
  if (!scoringClient) {
    ctx.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
    return 1;
  }

  const pass = await startPass(profile, ctx, scoringClient);
  const channel: FeedbackChannel = { label: "email", log: feedbackLog(profile, ctx.root, "email") };
  let processed = 0;

  for (const summary of await inkbox.searchMail()) {
    if (await channel.log.hasProcessed(summary.id)) continue;
    if (!looksLikeDirectMessage(summary, candidateEmail, inkbox.mailboxAddress)) continue;

    // searchMail can return snippet-level messages (confirmed Sep 14 — the
    // same characteristic alert-mail.ts had to work around), so every
    // candidate is re-fetched in full before classification.
    const full = (await inkbox.getMessage(summary.id)) ?? summary;
    await processFeedback(
      {
        id: full.id,
        from: full.from.address,
        text: full.body,
        reply: async (body) => {
          const draft = await inkbox.saveDraft({
            to: [{ address: full.from.address }],
            subject: full.subject.toLowerCase().startsWith("re:") ? full.subject : `Re: ${full.subject}`,
            body,
            threadId: full.threadId,
          });
          await inkbox.send({ draftId: draft.id, revision: draft.revision });
        },
      },
      channel,
      pass,
    );
    processed += 1;
  }

  if (processed === 0) ctx.stdout("No new direct feedback emails found.");
  return 0;
}

/**
 * Reuses DIGEST_IMESSAGE_TO as her phone identity — same reasoning as reusing
 * DIGEST_EMAIL_TO for email — regardless of DIGEST_IMESSAGE_ENABLED, which only
 * controls the outbound daily digest. Unset means she hasn't opted into texting
 * feedback, not an error; email is the primary channel and always expected.
 */
async function checkImessageFeedback(profile: string, ctx: JobsContext): Promise<number> {
  const candidatePhone = ctx.env["DIGEST_IMESSAGE_TO"];
  if (!candidatePhone) return 0;

  const imessage = ctx.clients.imessage();
  if (!imessage) {
    ctx.stderr("DIGEST_IMESSAGE_TO is set but Inkbox iMessage is not configured (INKBOX_API_KEY/INKBOX_IDENTITY_ID) — skipping the iMessage feedback channel.");
    return 1;
  }

  const scoringClient = ctx.clients.scoring();
  if (!scoringClient) {
    ctx.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
    return 1;
  }

  const pass = await startPass(profile, ctx, scoringClient);
  const channel: FeedbackChannel = { label: "text", log: feedbackLog(profile, ctx.root, "imessage") };
  let processed = 0;

  for (const message of await imessage.listMessages()) {
    if (await channel.log.hasProcessed(message.id)) continue;
    if (!looksLikeDirectText(message, candidatePhone)) continue;

    await processFeedback(
      {
        id: message.id,
        from: message.remoteNumber ?? candidatePhone,
        text: message.content,
        reply: async (body) => {
          await imessage.send(candidatePhone, body);
        },
      },
      channel,
      pass,
    );
    processed += 1;
  }

  if (processed === 0) ctx.stdout("No new direct feedback texts found.");
  return 0;
}

/**
 * Reads `digests/latest.json` — the payload `jobs run` and `jobs reconcile`
 * write on every pass — so the loop can answer "what did you find today" and
 * "why was X filtered out" from real data. Missing or unparseable is "no recent
 * run data", never a guess.
 */
async function loadLatestDigestPayload(profile: string, root: string): Promise<DigestPayload | undefined> {
  try {
    return JSON.parse(await readFile(join(root, dataDirFor(profile), "digests", "latest.json"), "utf8")) as DigestPayload;
  } catch {
    return undefined;
  }
}

/**
 * Merges both channel logs into one chronological conversation, because she
 * can text one day and email the next and "make it higher" needs to resolve
 * regardless of which channel carried the turn it refers to.
 */
async function loadConversationHistory(profile: string, root: string, limit = 5): Promise<string> {
  const [emailRecords, imessageRecords] = await Promise.all([
    feedbackLog(profile, root, "email").list(),
    feedbackLog(profile, root, "imessage").list(),
  ]);

  const toTurn = (record: FeedbackRecord): ConversationTurn => ({
    processedAt: record.processedAt,
    messageText: record.messageText ?? "",
    appliedChanges: record.appliedChanges ?? [],
    replyBody: record.replyBody ?? "",
  });

  const turns = [...emailRecords, ...imessageRecords].map(toTurn).sort((a, b) => a.processedAt.localeCompare(b.processedAt));
  return buildConversationHistory(turns, limit);
}

/**
 * One-time-per-change enrichment, not part of the daily run: finds the
 * candidate's existing Inkbox contact (Inkbox auto-creates one from her
 * inbound mail — this never creates one) via DIGEST_EMAIL_TO, links
 * DIGEST_IMESSAGE_TO's phone onto it, and tags it with this profile. Both
 * changes are idempotent.
 *
 * Deliberately does not touch review_status/is_confirmed or contact rules —
 * see contact-client.ts: neither is writable through Inkbox's documented API.
 */
export async function runJobsEnrichContact(profile: string, ctx: JobsContext): Promise<number> {
  const candidateEmail = ctx.env["DIGEST_EMAIL_TO"];
  if (!candidateEmail) {
    ctx.stderr("DIGEST_EMAIL_TO is not set — no address to look her Inkbox contact up by.");
    return 1;
  }

  const contacts = ctx.clients.contacts();
  if (!contacts) {
    ctx.stderr("INKBOX_API_KEY is not set — cannot reach Inkbox's contacts API.");
    return 1;
  }

  const existing = (await contacts.lookup({ email: candidateEmail }))[0];
  if (!existing) {
    ctx.stdout(`No Inkbox contact found for ${candidateEmail} yet — nothing to enrich. One is created automatically once mail from her arrives.`);
    return 0;
  }

  const patch: { phones?: Contact["phones"]; customFields?: Contact["customFields"] } = {};

  const candidatePhone = ctx.env["DIGEST_IMESSAGE_TO"];
  if (candidatePhone && !existing.phones.some((p) => normalizePhone(p.valueE164) === normalizePhone(candidatePhone))) {
    patch.phones = [...existing.phones, { valueE164: candidatePhone, label: "mobile", isPrimary: existing.phones.length === 0 }];
  }

  const tagLabel = "moby-role";
  const tagValue = `job-search-candidate:${profile}`;
  if (!existing.customFields.some((f) => f.label === tagLabel && f.value === tagValue)) {
    patch.customFields = [...existing.customFields, { label: tagLabel, value: tagValue }];
  }

  if (!patch.phones && !patch.customFields) {
    ctx.stdout(`${existing.preferredName ?? candidateEmail}'s Inkbox contact (${existing.id}) is already up to date.`);
    return 0;
  }

  const updated = await contacts.update(existing.id, patch);
  const changes = [patch.phones ? "linked her phone" : null, patch.customFields ? "added the profile tag" : null].filter((c): c is string => c !== null);
  ctx.stdout(`Updated Inkbox contact ${updated.id} (${updated.preferredName ?? candidateEmail}): ${changes.join(", ")}.`);
  return 0;
}
