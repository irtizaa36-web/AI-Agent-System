import type { EmailMessage } from "../../integrations/inkbox/client";
import type { InkboxClient } from "../../integrations/inkbox/client";
import type { RawPosting } from "../records";
import type { Source } from "./source";

/**
 * LinkedIn (and Indeed) job listings via forwarded alert emails, read
 * through the mailbox this project already controls — never automation
 * against linkedin.com itself. ADR 0013 already settled this: LinkedIn's
 * anti-automation stance is a policy boundary, not a technical hurdle, and
 * the risk of trying to defeat it lands on a real account. The safe path is
 * LinkedIn's own sanctioned distribution (its "Job Alerts" emails) plus a
 * mailbox this pipeline can read on its own — this Source is that reading.
 *
 * Reuses the existing `InkboxClient` port and its real HTTP implementation
 * (src/integrations/inkbox/real-client.ts) rather than a second Inkbox
 * client — one client, one set of credentials, one thing to configure.
 *
 * IMPORTANT HONESTY NOTE, worth reading before trusting this in production:
 * unlike Greenhouse/Lever/Ashby, there is no structured API here — this
 * parses an HTML email body written by LinkedIn's marketing team, not a
 * documented data format. `extractListingsFromEmail` is a best-effort
 * extractor built from the publicly-known shape of LinkedIn's alert emails
 * (repeated job cards: a title link to `linkedin.com/.../jobs/view/<id>`,
 * followed by "Company · Location" text). It is deliberately conservative:
 * if the expected shape isn't found, it returns nothing rather than
 * guessing at a company or location from unrelated text.
 *
 * Checked against a real forwarded batch on Sep 14: the card shape above was
 * confirmed correct — but the source still returned zero postings, for two
 * reasons stacked on top of each other, neither about the shape:
 *
 * 1. `InkboxClient#searchMail` turned out to return snippet-level messages —
 *    a ~200-char `body`, no HTML part at all — the same characteristic
 *    `readThread` already worked around elsewhere in real-client.ts by
 *    re-fetching each message in full. `fetch()` here now does the same via
 *    `client.getMessage`.
 * 2. Even a fully-fetched message's `EmailMessage.body` is plain text (or
 *    HTML with every tag already stripped) by design, because that's the
 *    right shape for a human-facing summary. `extractListingsFromEmail`
 *    parses for literal `<a href>` anchors, which cannot exist in that
 *    field — not "may be missing," structurally cannot. Fixed by adding
 *    `EmailMessage.bodyHtml` (client.ts) and reading that here instead, via
 *    `htmlBodyOf`.
 *
 * This source read zero postings from every real alert it was ever handed
 * until both were fixed together — extraction shape aside. Worth
 * remembering: an "empty" health status (see health.ts) looks identical for
 * "no alerts today" and "this integration is structurally broken" — the
 * only way either bug surfaced was checking the parser's actual output
 * against a real message, not trusting a clean run with 0 findings.
 *
 * Two ways a message counts as a job alert: `looksLikeJobAlert` (sender +
 * subject — the fast path for genuinely auto-forwarded originals) or
 * `looksLikeForwardedJobAlert` (extractable job-view links in the body —
 * the fallback for a backlog someone forwarded by hand, where Gmail's
 * "Forward" button rewrites the sender). See the latter's doc comment.
 */

const JOB_ALERT_SENDER = /linkedin\.com|indeed\.com/i;
const JOB_ALERT_SUBJECT = /job alert|jobs? for you|new jobs match|jobs? you may be interested/i;

/** True when a message looks like a job-alert digest, not some other LinkedIn/Indeed notification (a connection request, a profile view, etc). */
export function looksLikeJobAlert(message: Pick<EmailMessage, "from" | "subject">): boolean {
  return JOB_ALERT_SENDER.test(message.from.address) && JOB_ALERT_SUBJECT.test(message.subject);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

/** One job card extracted from an alert email. */
export interface ExtractedListing {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly url: string;
}

/**
 * Pulls job cards out of an alert email's HTML body. Anchors linking to a
 * job-view URL are the anchor point — everything else is read relative to
 * that anchor, within a bounded window, so unrelated page furniture (footer
 * links, "manage your alerts" boilerplate) never gets mistaken for a
 * listing. See the module doc comment: unverified against a real sample.
 */
export function extractListingsFromEmail(html: string): readonly ExtractedListing[] {
  const listings: ExtractedListing[] = [];
  const seenUrls = new Set<string>();

  // A job-view link, LinkedIn or Indeed shaped. Captures the href and the
  // anchor's own inner text (usually the title, sometimes empty if the
  // title lives just outside the anchor — handled below).
  const anchorPattern = /<a\b[^>]*href="([^"]*(?:jobs\/view|\/viewjob)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawUrl = decodeEntities(match[1] as string);
    // Alert emails wrap every link in tracking redirects; a raw job id in
    // the query string or path is the only part worth keeping as a stable
    // identifier, but the redirect URL itself still works as an apply link,
    // so it's used as-is rather than reconstructed.
    if (seenUrls.has(rawUrl)) continue;

    const anchorText = stripTags(match[2] as string);
    if (anchorText.length === 0) continue; // an image-only link card — nothing to read a title from

    // Look at the text immediately following this anchor, up to the next
    // anchor or a generous character cap, for "Company · Location" —
    // LinkedIn's own UI convention, carried into its emails.
    const tailStart = anchorPattern.lastIndex;
    const tail = html.slice(tailStart, tailStart + 400);
    const beforeNextAnchor = tail.split(/<a\b/i)[0] ?? "";
    // A real LinkedIn digest's markup (deeply nested tables, inline styles,
    // tracking attributes) routinely runs past the 400-char cap mid-tag —
    // confirmed against a real forwarded alert on Sep 14, where an unclosed
    // `<td style="...` survived stripTags as literal text and leaked into
    // the location field. stripTags only removes a tag it can see the whole
    // of; trimming to the last complete `>` first means a cut-off tag never
    // reaches it as text in the first place.
    const lastCompleteTag = beforeNextAnchor.lastIndexOf(">");
    const safeTail = lastCompleteTag >= 0 ? beforeNextAnchor.slice(0, lastCompleteTag + 1) : beforeNextAnchor;
    const tailText = stripTags(safeTail);

    const parts = tailText
      .split(/·|•|\|/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    // Never guess which part is the company and which is the location when
    // the separator convention isn't there — an empty field is honest,
    // a swapped one is not.
    const company = parts[0] ?? "";
    const location = parts[1] ?? "";

    if (company.length === 0) continue; // can't identify even the company — not a usable listing

    seenUrls.add(rawUrl);
    listings.push({ title: anchorText, company, location, url: rawUrl });
  }

  return listings;
}

/**
 * A manually-forwarded copy of a job-alert email fails `looksLikeJobAlert`
 * for a structural reason, not a content one: Gmail's "Forward" button (as
 * opposed to its Settings-based auto-forwarding) rewrites the `From` header
 * to whoever hit forward, so the sender check above sees Shivani's own
 * address, never linkedin.com/indeed.com. Rejecting on sender alone would
 * silently drop an entire manually-recovered backlog — exactly the failure
 * mode found when her Sep 14 auto-forwarding turned out to have never been
 * switched on, and the existing alerts in her inbox had to be forwarded by
 * hand.
 *
 * The fallback trusts the same structural evidence `extractListingsFromEmail`
 * already relies on: a genuine `jobs/view` or `/viewjob` URL is a far more
 * specific signal than a sender header, and unlike the sender, it survives
 * forwarding intact (Gmail quotes the original HTML body). A message that
 * merely mentions LinkedIn without a single extractable job-view link still
 * gets nothing here — this never lowers the bar to "contains the word
 * LinkedIn."
 */
export function looksLikeForwardedJobAlert(message: Pick<EmailMessage, "body" | "bodyHtml">): boolean {
  return extractListingsFromEmail(htmlBodyOf(message)).length > 0;
}

/**
 * `EmailMessage.body` is plain text, or HTML with every tag stripped, by
 * design (see the field's own doc comment in client.ts) — right for a
 * summary, structurally unusable for `extractListingsFromEmail`, which
 * parses for literal `<a href>` anchors. `bodyHtml` carries those tags when
 * the source had them; a test fixture that sets `body` directly to inline
 * HTML (no separate `bodyHtml`) still works via the fallback.
 */
function htmlBodyOf(message: Pick<EmailMessage, "body" | "bodyHtml">): string {
  return message.bodyHtml ?? message.body;
}

export function alertEmailToPostings(message: EmailMessage, sourceId: string): readonly RawPosting[] {
  return extractListingsFromEmail(htmlBodyOf(message)).map((listing) => ({
    sourceId,
    url: listing.url,
    title: listing.title,
    company: listing.company,
    location: listing.location,
    body: "", // alert emails carry no job description — the scorer sees a thin summary and (correctly, per its own rubric) reports low confidence rather than a fabricated read
    // The email's own receipt time, not the job's true post date — the
    // alert body doesn't restate one. An approximation, not a lie: LinkedIn
    // includes a listing in an alert only while it considers it recent.
    postedAt: message.receivedAt,
    fetchedAt: new Date().toISOString(),
  }));
}

export function createAlertMailSource(client: InkboxClient, id = "inkbox:alert-mail"): Source {
  return {
    id,
    company: null,
    async fetch() {
      const matches = await client.searchMail("job alert");
      // Confirmed against Shivani's real mailbox on Sep 14: `searchMail`
      // returns snippet-level messages — a ~200-char body and no HTML part
      // at all — the same characteristic `readThread` already works around
      // by re-fetching each message in full (see fetchMessageDetail in
      // real-client.ts). extractListingsFromEmail needs the real thing, so
      // every match here gets the same treatment before being judged.
      // Bounded by the search query itself already narrowing the mailbox
      // down to a small candidate set, not the whole inbox.
      const detailed = await Promise.all(matches.map((match) => client.getMessage(match.id)));
      const alerts = detailed.filter(
        (message): message is EmailMessage =>
          message !== undefined && (looksLikeJobAlert(message) || looksLikeForwardedJobAlert(message)),
      );
      return alerts.flatMap((message) => alertEmailToPostings(message, id));
    },
  };
}
