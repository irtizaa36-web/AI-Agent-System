import type { BuyerStats, TrackerDocument } from "../types";

/**
 * SELLING — buyer reliability scoring (ADR 0024).
 *
 * Tracks ghost rate, lowball pattern, and flakiness per buyer across
 * threads. Score 0–100, starts at 70:
 *   ghost (silent after our reply) .... −15
 *   hold expired unconfirmed (flaky) ... −10
 *   lowball below a firm price ......... −8
 *   completed pickup/purchase .......... +20 (cap 100)
 *
 * Queue ordering deprioritizes low scores automatically; below 30 the
 * agent firmly declines without asking ("politely, but no sale").
 */

export const DECLINE_BELOW = 30;

export function buyerKey(name: string): string {
  return name.trim().toLowerCase();
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function blank(name: string, now: string): BuyerStats {
  return { name, threads: [], contacts: 0, ghosts: 0, holdsExpired: 0, lowballs: 0, completed: 0, score: 70, updatedAt: now };
}

export type ReliabilitySignal = "contact" | "ghost" | "hold-expired" | "lowball" | "completed";

/** Record one signal for a buyer; returns the updated doc. */
export function recordReliability(
  doc: TrackerDocument,
  name: string,
  threadId: string,
  signal: ReliabilitySignal,
  now: string,
): TrackerDocument {
  const key = buyerKey(name);
  const prev = doc.buyers[key] ?? blank(name, now);
  const threads = prev.threads.includes(threadId) ? prev.threads : [...prev.threads, threadId];
  const next: BuyerStats = {
    ...prev,
    name: prev.name || name,
    threads,
    contacts: prev.contacts + (signal === "contact" ? 1 : 0),
    ghosts: prev.ghosts + (signal === "ghost" ? 1 : 0),
    holdsExpired: prev.holdsExpired + (signal === "hold-expired" ? 1 : 0),
    lowballs: prev.lowballs + (signal === "lowball" ? 1 : 0),
    completed: prev.completed + (signal === "completed" ? 1 : 0),
    score: clampScore(
      prev.score +
        (signal === "ghost" ? -15 : 0) +
        (signal === "hold-expired" ? -10 : 0) +
        (signal === "lowball" ? -8 : 0) +
        (signal === "completed" ? 20 : 0),
    ),
    updatedAt: now,
  };
  return { ...doc, buyers: { ...doc.buyers, [key]: next }, updatedAt: now };
}

export function buyerScore(doc: TrackerDocument, name: string): number {
  return doc.buyers[buyerKey(name)]?.score ?? 70;
}

/**
 * Detect a lowball offer in an inbound body: any $ amount materially below
 * the firm price (>5% under, and not the asking price itself).
 */
export function detectLowballOffer(body: string, firmPrice: number): number | undefined {
  const amounts: number[] = [];
  for (const m of body.matchAll(/\$(\d+(?:\.\d{1,2})?)/g)) {
    const n = Number(m[1]);
    if (n > 0) amounts.push(n);
  }
  const offers = amounts.filter((n) => n < firmPrice * 0.95);
  return offers.length > 0 ? Math.max(...offers) : undefined;
}

/** True when the buyer is a known flake — decline firmly, no sale, no ask. */
export function shouldDecline(doc: TrackerDocument, name: string): boolean {
  return buyerScore(doc, name) < DECLINE_BELOW;
}

/**
 * Queue order with reliability: confirmed/hold leads keep their slots;
 * among new/contacted leads, higher scores go first (stable otherwise).
 */
export function sortQueueByReliability<T extends { name: string; status: string; queuePosition: number }>(
  doc: TrackerDocument,
  leads: readonly T[],
): T[] {
  return [...leads].sort((a, b) => {
    const rank = (s: string) => (s === "confirmed" ? 0 : s === "hold" ? 1 : 2);
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    if (rank(a.status) === 2) {
      const s = buyerScore(doc, b.name) - buyerScore(doc, a.name);
      if (s !== 0) return s;
    }
    return a.queuePosition - b.queuePosition;
  });
}
