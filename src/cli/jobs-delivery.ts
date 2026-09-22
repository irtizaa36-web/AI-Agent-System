import type { RunSummary } from "../jobsearch/digest";
import { formatDigestSms } from "../jobsearch/digest-sms";
import { formatDigestEmailBody, formatDigestEmailSubject } from "../jobsearch/digest-email";
import { SmsRecipientBlockedError } from "../jobsearch/sms-client";
import type { JobsContext } from "./jobs-context";

/**
 * Pushes a finished digest out to the candidate over whichever channels are
 * switched on. Each channel has three separate gates on purpose: a client
 * that can be built, a destination, and an `*_ENABLED` flag set to exactly
 * "true" — having credentials configured for testing must never be the same
 * thing as live automated sends to a real person's phone or inbox (ADR 0016).
 *
 * Every failure here is reported and never fails the run: the digest was
 * already written to disk before any of this runs.
 */
export async function deliverDigest(summary: RunSummary, ctx: JobsContext): Promise<void> {
  await sendDigestSms(summary, ctx);
  await sendDigestImessage(summary, ctx);
  await sendDigestEmail(summary, ctx);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A positive integer from the environment, or the fallback. */
function maxRolesFrom(raw: string | undefined, fallback = 5): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function sendDigestSms(summary: RunSummary, ctx: JobsContext): Promise<void> {
  if (ctx.env["DIGEST_SMS_ENABLED"] !== "true") return;

  const to = ctx.env["DIGEST_SMS_TO"];
  if (!to) {
    ctx.stderr("DIGEST_SMS_ENABLED is true but DIGEST_SMS_TO is not set — skipping the text.");
    return;
  }

  const client = ctx.clients.sms();
  if (!client) {
    ctx.stderr("DIGEST_SMS_ENABLED is true but INKBOX_API_KEY/INKBOX_SMS_PHONE_NUMBER_ID are not both set — skipping the text.");
    return;
  }

  try {
    await client.send(to, formatDigestSms(summary, maxRolesFrom(ctx.env["DIGEST_SMS_MAX_ROLES"])));
    ctx.stdout(`Digest texted to ${to}.`);
  } catch (error) {
    const hint =
      error instanceof SmsRecipientBlockedError
        ? " Check that this number has been recorded as opted in through Inkbox before expecting this to work."
        : "";
    ctx.stderr(`Could not text the digest: ${describe(error)}${hint}`);
  }
}

async function sendDigestImessage(summary: RunSummary, ctx: JobsContext): Promise<void> {
  if (ctx.env["DIGEST_IMESSAGE_ENABLED"] !== "true") return;

  const to = ctx.env["DIGEST_IMESSAGE_TO"];
  if (!to) {
    ctx.stderr("DIGEST_IMESSAGE_ENABLED is true but DIGEST_IMESSAGE_TO is not set — skipping iMessage.");
    return;
  }

  const client = ctx.clients.imessage();
  if (!client) {
    ctx.stderr("DIGEST_IMESSAGE_ENABLED is true but INKBOX_API_KEY/INKBOX_IDENTITY_ID are not both set — skipping iMessage.");
    return;
  }

  try {
    await client.send(to, formatDigestSms(summary, maxRolesFrom(ctx.env["DIGEST_IMESSAGE_MAX_ROLES"])));
    ctx.stdout(`Digest iMessaged to ${to}.`);
  } catch (error) {
    ctx.stderr(`Could not iMessage the digest: ${describe(error)}`);
  }
}

/**
 * Goes through InkboxClient's draft-then-send flow because that is the one
 * path in this codebase that actually delivers mail (client.ts: `send` is
 * "Consequential: actually delivers the draft"). A digest to a candidate about
 * her own search is informational, not an application, so — like the text
 * channels — there is no human approval step between saveDraft and send.
 */
async function sendDigestEmail(summary: RunSummary, ctx: JobsContext): Promise<void> {
  if (ctx.env["DIGEST_EMAIL_ENABLED"] !== "true") return;

  const to = ctx.env["DIGEST_EMAIL_TO"];
  if (!to) {
    ctx.stderr("DIGEST_EMAIL_ENABLED is true but DIGEST_EMAIL_TO is not set — skipping the email.");
    return;
  }

  const client = ctx.clients.inkbox();
  if (!client) {
    ctx.stderr("DIGEST_EMAIL_ENABLED is true but Inkbox is not configured (INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS) — skipping the email.");
    return;
  }

  try {
    const draft = await client.saveDraft({
      to: [{ address: to }],
      subject: formatDigestEmailSubject(summary),
      body: formatDigestEmailBody(summary),
    });
    await client.send({ draftId: draft.id, revision: draft.revision });
    ctx.stdout(`Digest emailed to ${to}.`);
  } catch (error) {
    ctx.stderr(`Could not email the digest: ${describe(error)}`);
  }
}
