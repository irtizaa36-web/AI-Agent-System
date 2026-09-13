import { createHash, randomUUID } from "node:crypto";
import type { JobRecord, LocationClass, RawPosting } from "./records";

/**
 * Stage 3-5 of the pipeline: turn a raw posting into a JobRecord, hash it so
 * it is never processed twice, and derive the key that collapses the same
 * role cross-posted to four sites into one record.
 *
 * Every function here is pure and free. No network, no model, no clock
 * except what the caller passes in — which is what makes the expensive
 * stages downstream small.
 */

const BLOCK_LEVEL = /<\/?(p|div|br|li|tr|h[1-6]|section|article|ul|ol|table)\b[^>]*>/gi;

/**
 * Boilerplate that appears in most postings and carries no signal about
 * whether this is the right job. Dropping it before the token budget is
 * applied means the budget spends itself on responsibilities and
 * requirements instead of EEO statements.
 */
const BOILERPLATE_MARKERS: readonly RegExp[] = [
  /equal opportunity employer/i,
  /we are an equal opportunity/i,
  /without regard to race/i,
  /reasonable accommodation/i,
  /e-?verify/i,
  /pursuant to the .{0,40}fair chance/i,
  /applicants with arrest/i,
  /this employer participates in/i,
];

/** HTML to readable text, without a DOM parser or a dependency. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BLOCK_LEVEL, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Drops legal/EEO boilerplate paragraphs. Everything else is left alone. */
export function stripBoilerplate(text: string): string {
  return text
    .split(/\n\s*\n/)
    .filter((para) => !BOILERPLATE_MARKERS.some((marker) => marker.test(para)))
    .join("\n\n")
    .trim();
}

// Deliberately narrow, and deliberately missing "anywhere in": Figma's board
// describes its own product as letting people "work together from anywhere in
// the world", which promoted an onsite Tel Aviv role into a remote-only
// search. Product copy is not an employment term.
const REMOTE_SIGNALS = /\b(fully remote|100% remote|remote[- ]first|work from home|telecommute|remote-eligible|this role is remote)\b/i;
const HYBRID_SIGNALS = /\b(hybrid|(\d\s*(days?|x)\s*(per week|\/week|a week)\s*(in|at)\s*(the\s*)?office)|in[- ]office \d+ days)\b/i;
const ONSITE_SIGNALS = /\b(on[- ]?site|in[- ]person|must (be able to )?relocate|based in our .{0,30}office)\b/i;

/**
 * Classifies where a role is worked. Ordering matters and is deliberate:
 * "hybrid" is checked before "remote", because a posting saying "remote/
 * hybrid — 3 days in office" is a hybrid role that used the word remote.
 * Anything we cannot place is `"unknown"`, never optimistically `"remote"` —
 * a false "remote" wastes her time, a false "unknown" only costs a flag.
 */
export function classifyLocation(rawLocation: string, body: string): LocationClass {
  const stated = rawLocation.trim();
  const haystack = `${stated}\n${body}`;

  // The location field is the employer's own structured answer to this exact
  // question, so it wins over anything in the prose. That ordering is the
  // whole point: a description is marketing copy that happens to contain
  // words like "remote" and "anywhere", and letting it override a stated city
  // surfaces onsite roles in a remote-only search — which wastes her time
  // every single morning, quietly.
  if (/\bremote\b/i.test(stated)) {
    return HYBRID_SIGNALS.test(haystack) ? "hybrid" : "remote";
  }

  if (namesAPlace(stated)) {
    return HYBRID_SIGNALS.test(haystack) ? "hybrid" : "onsite";
  }

  // No usable location field. Now, and only now, read the body — and only for
  // signals specific enough to be about employment.
  if (HYBRID_SIGNALS.test(body)) return "hybrid";
  if (REMOTE_SIGNALS.test(body)) return "remote";
  if (ONSITE_SIGNALS.test(body)) return "onsite";
  return "unknown";
}

/** True when the location field names a real place rather than a placeholder. */
function namesAPlace(stated: string): boolean {
  if (stated.length === 0) return false;
  return !/^(various|multiple|flexible|anywhere|worldwide|global|n\/?a|tbd|unspecified)$/i.test(stated);
}

export interface ParsedSalary {
  readonly min: number | null;
  readonly max: number | null;
  readonly currency: string | null;
}

const NO_SALARY: ParsedSalary = { min: null, max: null, currency: null };

/**
 * Pulls a stated salary range out of posting text. Returns nulls when the
 * posting states nothing — the caller must treat that as "unknown", never as
 * "probably fine". A single figure sets both ends of the range.
 */
export function parseSalary(text: string): ParsedSalary {
  const range =
    /(?:\$|USD\s*)\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK]|\d{5,7})\s*(?:-|–|—|to)\s*(?:\$|USD\s*)?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK]|\d{5,7})/;
  const match = range.exec(text);
  if (match) {
    const min = toAmount(match[1]);
    const max = toAmount(match[2]);
    if (min !== null && max !== null && min <= max) return { min, max, currency: "USD" };
  }

  const single = /(?:\$|USD\s*)\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK]|\d{5,7})\b/.exec(text);
  if (single) {
    const amount = toAmount(single[1]);
    if (amount !== null) return { min: amount, max: amount, currency: "USD" };
  }

  return NO_SALARY;
}

function toAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "").trim();
  if (/[kK]$/.test(cleaned)) {
    const base = Number.parseFloat(cleaned.slice(0, -1).trim());
    return Number.isFinite(base) ? Math.round(base * 1000) : null;
  }
  const value = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(value)) return null;
  // An hourly or monthly figure is not an annual salary; refuse to guess.
  return value >= 10000 ? value : null;
}

/** Lowercase, punctuation-free, suffix-free company name — the half of the dedupe key that varies most between sources. */
export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv|holdings|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Strips the decoration boards add around the same job title — req IDs,
 * bracketed locations, trailing "(Remote)" — so one role posted four ways
 * produces one key.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\((remote|hybrid|onsite|on-site|us|usa|united states)[^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[-–—|,]\s*(remote|hybrid|onsite|us|usa|united states).*$/g, " ")
    .replace(/\b(req|requisition|job)\s*#?\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The cross-source identity. Location class rather than raw location is
 * deliberate: the same remote role listed as "Remote - US" and "Remote"
 * must collapse, while a genuinely different Chicago office role must not.
 */
export function identityKeyFor(company: string, title: string, locationClass: LocationClass): string {
  return `${normalizeCompany(company)}::${normalizeTitle(title)}::${locationClass}`;
}

/** Content hash over what actually matters. A reworded footer must not make a posting look new. */
export function contentHashFor(company: string, title: string, summary: string): string {
  return createHash("sha256")
    .update(`${normalizeCompany(company)}\n${normalizeTitle(title)}\n${summary.replace(/\s+/g, " ").trim()}`)
    .digest("hex");
}

export interface NormalizeOptions {
  /** Where the raw body was written. Kept out of prompts on purpose. */
  readonly descriptionPath: string;
  readonly tokenBudget: number;
  readonly now: string;
}

/** Rough token estimate — ~4 characters per token. Good enough to enforce a budget without a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trims a posting to a token budget, keeping the front (title, level,
 * responsibilities, requirements all appear early) and cutting the tail.
 */
export function truncateToBudget(text: string, tokenBudget: number): string {
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd() + "\n[truncated]";
}

/** Raw posting -> JobRecord. The one place a posting becomes a record. */
export function toJobRecord(raw: RawPosting, options: NormalizeOptions): JobRecord {
  const text = stripBoilerplate(htmlToText(raw.body));
  const summary = truncateToBudget(text, options.tokenBudget);
  const locationClass = classifyLocation(raw.location, text);
  const salary = parseSalary(text);

  return {
    id: randomUUID(),
    contentHash: contentHashFor(raw.company, raw.title, summary),
    identityKey: identityKeyFor(raw.company, raw.title, locationClass),
    title: raw.title.trim(),
    company: raw.company.trim(),
    rawLocation: raw.location.trim(),
    locationClass,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    postedAt: raw.postedAt,
    firstSeenAt: options.now,
    lastSeenAt: options.now,
    sources: [{ sourceId: raw.sourceId, url: raw.url, fetchedAt: raw.fetchedAt }],
    applyUrl: raw.url,
    descriptionPath: options.descriptionPath,
    summary,
    state: "seen",
    filterReason: null,
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
  };
}
