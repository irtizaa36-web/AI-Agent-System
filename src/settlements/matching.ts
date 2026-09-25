/**
 * Settlement identity (ADR 0022). The same settlement shows up under
 * different names ("$20M VSL Pharmaceuticals probiotic class action
 * settlement" vs "VSL Pharmaceuticals - Probiotics"), so matching is by the
 * official settlement-site domain first, and by significant name tokens only
 * when a domain isn't known on both sides.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "in", "on", "for", "to", "re", "v", "vs",
  "class", "action", "settlement", "settlements", "lawsuit", "litigation", "case",
  "inc", "llc", "co", "corp", "company", "ltd", "et", "al",
]);

/** Significant, lightly stemmed tokens of a settlement name. */
export function nameTokens(name: string): string[] {
  return [...new Set(rawTokens(name).map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)))];
}

function rawTokens(name: string): string[] {
  const text = name
    .toLowerCase()
    .replace(/&#0?38;|&amp;/g, " ")
    .replace(/\$[\d.,]+\s*(?:[mbk]|million|billion)?\b/g, " ") // "$20M", "$2.99 million"
    .replace(/['’]s\b/g, "") // "joe's" → "joe"
    .replace(/(\w)-(\w)/g, "$1$2") // "non-bank" → "nonbank"
    .replace(/[^a-z0-9#]+/g, " ");
  return text.split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** "https://www.VSL3Lawsuit.com/submit-claim" or "VSL3Lawsuit.com" → "vsl3lawsuit.com". */
export function domainOf(urlOrHost: string): string | undefined {
  const host = urlOrHost
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0];
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

export interface Identity {
  readonly names: readonly string[];
  readonly domains: readonly string[];
}

function sharesDomain(a: Identity, b: Identity): boolean | undefined {
  if (a.domains.length === 0 || b.domains.length === 0) return undefined;
  return a.domains.some((d) => b.domains.includes(d));
}

/**
 * Does `known` (a tracked or do-not-research settlement) describe the same
 * settlement as `found`? A known name matches when all of its significant
 * tokens (at least two) appear in the found name — "Apple Siri" matches
 * "iPhone - Siri Apple Intelligence", while "Bestway spa pump" does not match
 * "Bestway above-ground pools". Disjoint known domains veto a name match.
 */
export function isSameAs(known: Identity, found: Identity): boolean {
  const domains = sharesDomain(known, found);
  if (domains !== undefined) return domains;
  const foundTokenSets = found.names.map((n) => new Set(nameTokens(n)));
  return known.names.some((name) => {
    const key = nameTokens(name);
    if (key.length < 2) return foundTokenSets.some((f) => f.size === key.length && key.every((t) => f.has(t)));
    return foundTokenSets.some((f) => key.every((t) => f.has(t)));
  });
}

/** Category words shared by unrelated settlements ("Tift data breach" vs "Palomar data breach"). */
const GENERIC = new Set(["data", "breach", "privacy", "security", "incident", "tcpa", "unwanted", "text", "call", "robocall", "fee", "antitrust", "price", "fixing", "health", "bank", "insurance", "consumer", "report", "product", "false", "advertising", "tracking"]);

/**
 * Are two listings from different sources the same settlement? Domains
 * decide when both are known. Otherwise their distinctive (non-category)
 * name tokens must share at least two, covering 75% of the shorter name.
 * Deliberately strict: a missed merge shows a duplicate, a wrong merge hides
 * a settlement.
 */
export function isSameListing(a: Identity, b: Identity): boolean {
  const domains = sharesDomain(a, b);
  if (domains !== undefined) return domains;
  const distinctive = (name: string): string[] => nameTokens(name).filter((t) => !GENERIC.has(t));
  return a.names.some((an) =>
    b.names.some((bn) => {
      const x = distinctive(an);
      const y = new Set(distinctive(bn));
      const shared = x.filter((t) => y.has(t)).length;
      return shared >= 2 && shared / Math.min(x.length, y.size) >= 0.75;
    }),
  );
}

/** Stable keys for "have we reported this before?": every domain, plus the sorted name tokens. */
export function identityKeys(identity: Identity): string[] {
  const keys = identity.domains.map((d) => `domain:${d}`);
  for (const name of identity.names) {
    const tokens = nameTokens(name).sort();
    if (tokens.length > 0) keys.push(`name:${tokens.join(" ")}`);
  }
  return [...new Set(keys)];
}

export function slugify(text: string): string {
  return [...new Set(rawTokens(text))].join("-").replace(/#/g, "").slice(0, 60).replace(/-$/, "") || "settlement";
}
