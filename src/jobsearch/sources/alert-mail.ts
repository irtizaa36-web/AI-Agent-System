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
 * followed by "Company · Location" text) — it has NOT been validated
 * against one of Shivani's real alert emails, because none has been
 * forwarded yet. It is deliberately conservative: if the expected shape
 * isn't found, it returns nothing rather than guessing at a company or
 * location from unrelated text. The first real batch of alerts should be
 * checked against this parser's output before trusting it unattended —
 * treat this the same as any other newly-added source that hasn't yet
 * proven itself against real data (see health.ts: an empty result reports
 * as `"empty"`, not silently as success).
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
    const tailText = stripTags(tail.split(/<a\b/i)[0] ?? "");

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

export function alertEmailToPostings(message: EmailMessage, sourceId: string): readonly RawPosting[] {
  return extractListingsFromEmail(message.body).map((listing) => ({
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
      const messages = await client.searchMail("job alert");
      const alerts = messages.filter(looksLikeJobAlert);
      return alerts.flatMap((message) => alertEmailToPostings(message, id));
    },
  };
}
