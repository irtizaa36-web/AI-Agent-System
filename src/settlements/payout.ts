/**
 * Reads a payout as a source states it ("Up to $800", "$50 - $150",
 * "$20 Per Unit", "Varies") into bounds for ranking only. The owner always
 * sees the source's own words; these numbers never replace them.
 */

export interface PayoutBounds {
  readonly floor?: number;
  readonly ceiling?: number;
  readonly perUnit: boolean;
}

function amounts(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

export function parsePayout(text: string | undefined): PayoutBounds {
  if (!text) return { perUnit: false };
  const t = text.toLowerCase();
  const perUnit = /per (unit|item|product|bottle|purchase)/.test(t);
  const nums = amounts(text);
  if (nums.length === 0) return { perUnit };
  const first = nums[0]!;
  if (/^\s*up to\b/.test(t)) return { ceiling: first, perUnit };
  if (/at least|\$[\d,.]+\s*\+/.test(t)) return { floor: first, perUnit };
  if (nums.length >= 2 && /\$[\d,.]+\s*(-|–|to)\s*\$/.test(t)) return { floor: Math.min(nums[0]!, nums[1]!), ceiling: Math.max(nums[0]!, nums[1]!), perUnit };
  if (/between|from/.test(t) && nums.length >= 2) return { floor: Math.min(...nums), ceiling: Math.max(...nums), perUnit };
  return { floor: first, ceiling: first, perUnit };
}

/**
 * A deliberately conservative dollar figure for ranking. "Up to $5,000"
 * almost always means documented losses, so a lone ceiling counts for 10% of
 * itself, capped at $75. Unknown payouts count as $10.
 */
export function rankingValue(bounds: PayoutBounds): number {
  if (bounds.floor !== undefined) return bounds.floor;
  if (bounds.ceiling !== undefined) return Math.min(bounds.ceiling * 0.1, 75);
  return 10;
}
