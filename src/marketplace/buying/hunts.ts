import { randomUUID } from "node:crypto";
import type { Campaign, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, BUYING_SCOPE } from "../policy";
import { renderTemplate } from "../templates";
import { stageMessage } from "../outbox";

/**
 * BUYING — hunt definitions and lifecycle (ADR 0024).
 *
 * Hunts are outbound deal searches: item criteria (e.g. genuine-Apple-only),
 * price ceilings, seller outreach, offer sequences with walk-away points,
 * deal verification (authenticity). Start/pause/cancel lifecycle lives here.
 *
 * Hard stops: any PURCHASE needs Toozy's approval (he pays) — there is no
 * autonomous path to money moving out. Outreach, offers within ceiling, and
 * close-outs are autonomous.
 */

export interface StartHuntInput {
  readonly name: string;
  readonly criteria: string;
  readonly maxPrice?: number;
}

/** Starting a hunt is owner-initiated (he names the item + max price — that IS
 * the approval). Headless loops must never call this on their own. */
export function startHunt(doc: TrackerDocument, input: StartHuntInput, nowIso: string): { doc: TrackerDocument; campaign: Campaign } {
  if (doc.campaigns.some((c) => c.name === input.name && c.status !== "cancelled")) {
    throw new Error(`Hunt "${input.name}" already exists and is not cancelled.`);
  }
  const campaign: Campaign = {
    id: `hunt-${randomUUID().slice(0, 8)}`,
    name: input.name,
    status: "active",
    criteria: input.criteria,
    maxPrice: input.maxPrice,
    threads: [],
    offers: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return { doc: { ...doc, campaigns: [...doc.campaigns, campaign], updatedAt: nowIso }, campaign };
}

export function pauseHunt(doc: TrackerDocument, name: string, nowIso: string): { doc: TrackerDocument; campaign: Campaign } {
  assertAutonomous(doc, BUYING_SCOPE, ACTIONS.PAUSE_HUNT);
  const campaign = findActive(doc, name);
  const updated: Campaign = { ...campaign, status: "paused", updatedAt: nowIso };
  return { doc: withCampaign(doc, updated, nowIso), campaign: updated };
}

export interface CancelHuntInput {
  /** Thread ids to receive the templated close-out. */
  readonly threadIds?: readonly string[];
  /** "close-out" | "close-out-50pct" — the 50% follow-up variant leaves a callback number. */
  readonly template?: "close-out" | "close-out-50pct";
  readonly callbackNumber?: string;
}

/**
 * Cancel a hunt and stage a templated close-out to each supplied thread.
 * Autonomous — kill-switch with templated close-outs.
 */
export function cancelHunt(doc: TrackerDocument, name: string, input: CancelHuntInput = {}, nowIso: string = new Date().toISOString()): { doc: TrackerDocument; campaign: Campaign; staged: number } {
  assertAutonomous(doc, BUYING_SCOPE, ACTIONS.CLOSE_OUT);
  const campaign = findActive(doc, name);
  const updated: Campaign = { ...campaign, status: "cancelled", cancelledAt: nowIso, updatedAt: nowIso };
  let next = withCampaign(doc, updated, nowIso);

  const template = input.template ?? "close-out";
  if (template === "close-out-50pct" && !input.callbackNumber) {
    throw new Error(`cancelHunt with the "close-out-50pct" template needs a callbackNumber.`);
  }
  let staged = 0;
  for (const threadId of input.threadIds ?? campaign.threads) {
    const body = renderTemplate(next, template, {
      name: "there",
      callbackNumber: input.callbackNumber ?? "n/a",
    });
    const result = stageMessage(next, {
      kind: "close-out",
      channel: "messenger",
      threadId,
      recipient: threadId,
      body,
    }, nowIso);
    next = result.doc;
    staged++;
  }
  return { doc: next, campaign: updated, staged };
}

/** Track an outreach thread under a hunt. */
export function trackThread(doc: TrackerDocument, campaignId: string, threadId: string, nowIso: string): TrackerDocument {
  const campaign = doc.campaigns.find((c) => c.id === campaignId);
  if (!campaign) throw new Error(`Unknown campaign "${campaignId}".`);
  if (campaign.threads.includes(threadId)) return doc;
  return withCampaign(doc, { ...campaign, threads: [...campaign.threads, threadId] }, nowIso);
}

/**
 * Walk-away check: an offer above the hunt's ceiling is never made
 * autonomously — it escalates instead of sending.
 */
export function offerWithinCeiling(campaign: Campaign, amount: number): boolean {
  if (campaign.maxPrice === undefined) return true;
  return amount <= campaign.maxPrice;
}

/** Record an offer on a hunt thread (both sides of the negotiation). */
export function recordOffer(
  doc: TrackerDocument,
  campaignName: string,
  threadId: string,
  amount: number,
  kind: "ours" | "theirs",
  nowIso: string,
): TrackerDocument {
  const campaign = doc.campaigns.find((c) => c.name === campaignName);
  if (!campaign) throw new Error(`Unknown hunt "${campaignName}".`);
  const updated: Campaign = {
    ...campaign,
    offers: [...campaign.offers, { threadId, amount, kind, at: nowIso }],
  };
  return withCampaign(doc, updated, nowIso);
}

export type NegotiateStep = { readonly action: "offer"; readonly amount: number } | { readonly action: "walk-away"; readonly reason: string };

/**
 * Autonomous negotiation step for a seller's ask. Policy:
 *   - ask at/under ceiling → handled by detectSellerAcceptance (ping, not here).
 *   - ask over ceiling, first time on this thread → counter AT the ceiling.
 *   - ask over ceiling again after our ceiling counter → walk away.
 * Never offers above the ceiling. Never says "I'll take it" — the
 * deal-agreed ping is Toozy's call.
 */
export function negotiateStep(campaign: Campaign, threadId: string, theirAsk: number): NegotiateStep {
  const ceiling = campaign.maxPrice;
  if (ceiling === undefined) return { action: "offer", amount: theirAsk };
  if (theirAsk <= ceiling) return { action: "offer", amount: theirAsk };
  const ourCounters = campaign.offers.filter((o) => o.threadId === threadId && o.kind === "ours" && o.amount >= ceiling).length;
  if (ourCounters === 0) return { action: "offer", amount: ceiling };
  return { action: "walk-away", reason: `Seller holding above the $${ceiling} ceiling after our counter at ceiling.` };
}

const SELLER_YES = /\b(deal|agreed|yes|yeah|yep|sounds good|works for me|ok(ay)?|confirmed|i accept)\b/i;
const PRICE_RE = /\$\s?(\d+(?:\.\d{1,2})?)/;

export interface SellerAcceptance {
  readonly accepted: boolean;
  readonly price?: number;
}

/**
 * THE buying hard stop detector. A seller AGREES to our predetermined price
 * (at or under the ceiling) → accepted. The caller must NOT message the
 * seller ("I'll take it"), commit to pickup, or move money — it raises the
 * deal-agreed escalation: "seller said yes at your price, here's the deal,
 * want it?"
 */
export function detectSellerAcceptance(body: string, ceiling: number | undefined): SellerAcceptance {
  const text = body ?? "";
  if (!SELLER_YES.test(text)) return { accepted: false };
  const m = PRICE_RE.exec(text);
  if (!m) return { accepted: true };
  const price = Number(m[1]);
  if (ceiling !== undefined && price > ceiling) return { accepted: false, price };
  return { accepted: true, price };
}

function findActive(doc: TrackerDocument, name: string): Campaign {
  const campaign = doc.campaigns.find((c) => c.name === name);
  if (!campaign) throw new Error(`Unknown hunt "${name}".`);
  if (campaign.status === "cancelled") throw new Error(`Hunt "${name}" is already cancelled.`);
  return campaign;
}

function withCampaign(doc: TrackerDocument, campaign: Campaign, nowIso: string): TrackerDocument {
  return {
    ...doc,
    campaigns: doc.campaigns.map((c) => (c.id === campaign.id ? { ...campaign, updatedAt: nowIso } : c)),
    updatedAt: nowIso,
  };
}
