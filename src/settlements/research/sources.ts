import { parseUsDate } from "../dates";
import { domainOf } from "../matching";
import type { IsoDate } from "../types";

/**
 * Where research sweeps look for new settlements (ADR 0022). Each source is a
 * public page read with a plain GET and parsed into listings; nothing here
 * posts, logs in or fills a form. A source that fails or changes its markup
 * reports that, rather than failing the whole sweep.
 */

export interface Listing {
  readonly source: string;
  /** The page the listing was read from (the article, or the list page). */
  readonly sourceUrl: string;
  readonly title: string;
  readonly website?: string;
  readonly claimUrl?: string;
  readonly deadline?: IsoDate;
  readonly payoutText?: string;
  readonly eligibilityText?: string;
  readonly proofText?: string;
  readonly proofRequired?: boolean;
}

export interface SettlementSource {
  readonly name: string;
  readonly url: string;
  parse(body: string): Listing[];
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function clean(title: string): string {
  return decodeEntities(title)
    .replace(/^\$[\d.,]+\s*[MBK]?\s+/i, "")
    .replace(/\s+class action settlement$/i, "")
    .trim();
}

/**
 * Top Class Actions' "open settlements" RSS feed. Most articles carry a fact
 * box of <h6> labels ("Who's Eligible", "Potential Award", "Claim Form
 * Deadline", "Settlement Website", ...) each followed by its value.
 */
export const topClassActionsSource: SettlementSource = {
  name: "Top Class Actions",
  url: "https://topclassactions.com/category/lawsuit-settlements/open-lawsuit-settlements/feed/",
  parse(body) {
    const listings: Listing[] = [];
    for (const [, item] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const title = /<title>([\s\S]*?)<\/title>/.exec(item!)?.[1];
      const link = /<link>([\s\S]*?)<\/link>/.exec(item!)?.[1]?.trim();
      if (!title || !link) continue;
      const content = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]>/.exec(item!)?.[1] ?? "";
      const parts = content.split(/<h6[^>]*>([\s\S]*?)<\/h6>/);
      const fields = new Map<string, { text: string; html: string }>();
      for (let i = 1; i + 1 < parts.length; i += 2) {
        fields.set(htmlToText(parts[i]!).toLowerCase().replace(/’/g, "'"), { text: htmlToText(parts[i + 1]!), html: parts[i + 1]! });
      }
      const website = fields.get("settlement website")?.text;
      const claimHref = /href="([^"]+)"/.exec(fields.get("claim form")?.html ?? "")?.[1];
      const deadline = fields.get("claim form deadline")?.text;
      const payout = fields.get("potential award")?.text;
      const eligibility = fields.get("who's eligible")?.text;
      const proof = fields.get("proof of purchase")?.text;
      listings.push({
        source: this.name,
        sourceUrl: link,
        title: clean(title),
        ...(website && domainOf(website) ? { website } : {}),
        ...(claimHref ? { claimUrl: decodeEntities(claimHref) } : {}),
        ...(deadline && parseUsDate(deadline) ? { deadline: parseUsDate(deadline)! } : {}),
        ...(payout ? { payoutText: payout } : {}),
        ...(eligibility ? { eligibilityText: eligibility } : {}),
        ...(proof ? { proofText: proof, proofRequired: !/^n\/a$/i.test(proof) } : {}),
      });
    }
    return listings;
  },
};

/**
 * ClassAction.org's settlements page: one card per open settlement with a
 * payout, a deadline (M/D/YY), "Proof Required?", a one-line description and
 * a link to the official settlement website.
 */
export const classActionOrgSource: SettlementSource = {
  name: "ClassAction.org",
  url: "https://www.classaction.org/settlements",
  parse(body) {
    const listings: Listing[] = [];
    const starts = [...body.matchAll(/<div id="([^"]+)" data-name="([^"]+)"[^>]*settlement-card/g)];
    starts.forEach((m, i) => {
      const card = body.slice(m.index!, starts[i + 1]?.index ?? body.length);
      const text = htmlToText(card);
      const website = /<a href="([^"]+)"[^>]*class="js-settlement-link/.exec(card)?.[1];
      const deadline = /Deadline\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(text)?.[1];
      const payout = /Settlement Payout\s+(.*?)\s+Deadline/.exec(text)?.[1];
      const proof = /Proof Required\?\s+(Yes|No)/i.exec(text)?.[1];
      const description = /<p[^>]*>([\s\S]*?)<\/p>/.exec(card)?.[1];
      listings.push({
        source: this.name,
        sourceUrl: `${this.url}#${m[1]}`,
        title: decodeEntities(m[2]!),
        ...(website ? { website: decodeEntities(website) } : {}),
        ...(deadline && parseUsDate(deadline) ? { deadline: parseUsDate(deadline)! } : {}),
        ...(payout ? { payoutText: payout } : {}),
        ...(description ? { eligibilityText: htmlToText(description) } : {}),
        ...(proof ? { proofRequired: proof.toLowerCase() === "yes" } : {}),
      });
    });
    return listings;
  },
};

export const DEFAULT_SOURCES: readonly SettlementSource[] = [topClassActionsSource, classActionOrgSource];

export interface SourceReport {
  readonly source: string;
  readonly ok: boolean;
  readonly listings: number;
  readonly error?: string;
}

export async function readSource(source: SettlementSource, fetchFn: FetchLike, timeoutMs = 30_000): Promise<{ report: SourceReport; listings: Listing[] }> {
  try {
    const response = await fetchFn(source.url, { headers: { "user-agent": "Mozilla/5.0 (settlements research; read-only)" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { report: { source: source.name, ok: false, listings: 0, error: `HTTP ${response.status}` }, listings: [] };
    const listings = source.parse(await response.text());
    if (listings.length === 0) return { report: { source: source.name, ok: false, listings: 0, error: "no listings found (the page layout may have changed)" }, listings };
    return { report: { source: source.name, ok: true, listings: listings.length }, listings };
  } catch (error) {
    return { report: { source: source.name, ok: false, listings: 0, error: (error as Error).message }, listings: [] };
  }
}
