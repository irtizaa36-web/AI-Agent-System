import { execFile } from "node:child_process";
/**
 * SELLING — comp-based auto-pricing (ADR 0024).
 *
 * The intake pulls comparable active listings via `facebook-cli marketplace
 * search` (read-only) and proposes the list price from the comp distribution.
 * One-tap approve on the intake summary; no pricing questions.
 */

export interface Comp {
  readonly title: string;
  readonly price: number;
  readonly condition?: string;
}

export interface CompAnalysis {
  readonly comps: readonly Comp[];
  /** Suggested list price: median of comps, rounded to the nearest $5. */
  readonly suggestedPrice?: number;
  readonly basis: string;
}

/** Runs `facebook-cli marketplace search ...`. Injected so tests never hit the network. */
export type CompSearchRunner = (args: readonly string[]) => Promise<string>;

export function realCompSearchRunner(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("facebook-cli", [...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`facebook-cli search failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

function parsePrice(raw: unknown): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    const m = raw.replace(/,/g, "").match(/\d+(\.\d{1,2})?/);
    if (m) {
      const n = Number(m[0]);
      return n > 0 ? n : undefined;
    }
  }
  return undefined;
}

export function parseComps(stdout: string): Comp[] {
  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
    if (!Array.isArray(items)) return [];
    const comps: Comp[] = [];
    for (const item of items) {
      const price = parsePrice(item?.price);
      const title = typeof item?.title === "string" ? item.title : "";
      if (price !== undefined && title) {
        comps.push({ title, price, condition: typeof item?.condition === "string" ? item.condition : undefined });
      }
    }
    return comps;
  } catch {
    return [];
  }
}

function median(prices: number[]): number {
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Fetch comps for an item query and propose a price. Returns an empty comp
 * list (no suggestion) when the search fails or finds nothing — the intake
 * then falls back to the sidecar price with a warning, never a guess.
 */
export async function analyzeComps(query: string, runner: CompSearchRunner = realCompSearchRunner): Promise<CompAnalysis> {
  let stdout: string;
  try {
    stdout = await runner(["marketplace", "search", "--query", query, "--sort-by", "price_ascend", "--limit", "10"]);
  } catch {
    return { comps: [], basis: "comp search failed — using the sidecar price" };
  }
  const comps = parseComps(stdout).slice(0, 10);
  if (comps.length === 0) return { comps, basis: "no comps found — using the sidecar price" };
  const suggestedPrice = Math.round(median(comps.map((c) => c.price)) / 5) * 5;
  const lo = Math.min(...comps.map((c) => c.price));
  const hi = Math.max(...comps.map((c) => c.price));
  return {
    comps,
    suggestedPrice,
    basis: `median of ${comps.length} comps ($${lo}–$${hi}) → $${suggestedPrice}`,
  };
}
