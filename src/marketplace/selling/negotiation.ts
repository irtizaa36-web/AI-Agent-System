import type { Lead, Listing, NegotiationState, TrackerDocument } from "../types";
import { DEFAULT_CONFIG, type NegotiationConfig } from "../config";
import { ACTIONS, assertAutonomous, escalate, sellingScope, type Escalation } from "../policy";
import { renderTemplate, type TemplateContext } from "../templates";
import { stageMessage } from "../outbox";

/**
 * SELLING — negotiation bands (Karen upgrade 1).
 *
 * A buyer's offer is measured against the asking price:
 *   under 10% below  → polite hold: restate the firm price, no counter.
 *   10–25% below     → exactly ONE firm counter at the listing's floor price,
 *                      framed as the bottom line. Later offers in this band
 *                      get the bottom line restated, never a second counter.
 *   25%+ below       → decline without a counter, restate the asking price.
 * After maxCounterRounds (default 2) responses with no agreement, the agent
 * stops negotiating and escalates to the owner — no further messages.
 * The agent never agrees to a price below the floor. With no floor set on
 * the listing there is nothing to counter with, so the counter band gets
 * the polite hold instead.
 */

export type OfferBand = "at-asking" | "hold" | "counter" | "decline";

export type NegotiationAction =
  | "accept"
  | "polite-hold"
  | "counter"
  | "bottom-line"
  | "decline"
  | "escalate"
  | "stand-down";

export interface NegotiationDecision {
  readonly action: NegotiationAction;
  readonly band: OfferBand;
  readonly offer: number;
  readonly asking: number;
  readonly floor?: number;
  readonly counterPrice?: number;
  readonly agreedPrice?: number;
  /** Template to stage for the buyer; undefined → no message. */
  readonly template?: string;
  readonly context?: TemplateContext;
  readonly reason: string;
  readonly escalation?: Escalation;
}

/** Fraction below asking, rounded so 10%/25% boundaries are exact. */
function fractionBelow(asking: number, offer: number): number {
  return Math.round(((asking - offer) / asking) * 1e9) / 1e9;
}

export function classifyOffer(asking: number, offer: number, config: NegotiationConfig = DEFAULT_CONFIG.negotiation): OfferBand {
  if (offer >= asking) return "at-asking";
  const below = fractionBelow(asking, offer);
  if (below < config.holdBelowFraction) return "hold";
  if (below < config.declineAtFraction) return "counter";
  return "decline";
}

/** The listing's usable floor: set, positive, and below asking. */
export function floorFor(listing: Listing): number | undefined {
  const floor = listing.floorPrice;
  if (floor === undefined || !(floor > 0) || floor >= listing.price) return undefined;
  return floor;
}

/**
 * Pull a buyer's offer out of a message: "$70", "would you take 70",
 * "can you do 65?". The last amount that isn't the asking price wins
 * ("it says $90, would you take $70" → 70). undefined when there's no offer.
 */
export function extractOffer(body: string, asking: number): number | undefined {
  const amounts: number[] = [];
  const re = /\$\s?(\d+(?:\.\d{1,2})?)|\b(?:take|do|offer|give you|pay)\s+(\d+(?:\.\d{1,2})?)\b/gi;
  for (const m of (body ?? "").matchAll(re)) {
    const n = Number(m[1] ?? m[2]);
    if (n > 0 && n !== asking) amounts.push(n);
  }
  return amounts.length > 0 ? amounts[amounts.length - 1] : undefined;
}

function blankState(): NegotiationState {
  return { rounds: 0, countered: false, status: "open" };
}

/**
 * Decide the response to one offer and record it on the lead. Pure: the
 * caller stages the message (stageNegotiationReply) unless the thread is
 * watch-only.
 */
export function respondToOffer(
  doc: TrackerDocument,
  listingId: string,
  leadId: string,
  offer: number,
  nowIso: string,
  config: NegotiationConfig = DEFAULT_CONFIG.negotiation,
): { doc: TrackerDocument; decision: NegotiationDecision; lead: Lead } {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  const lead = doc.leads.find((l) => l.id === leadId && l.listingId === listingId);
  if (!lead) throw new Error(`Unknown lead "${leadId}" for listing "${listingId}".`);
  if (!(offer > 0)) throw new Error("Offer must be a positive amount.");

  const asking = listing.price;
  const floor = floorFor(listing);
  const band = classifyOffer(asking, offer, config);
  const state = lead.negotiation ?? blankState();
  const base = { band, offer, asking, floor };
  const ctx = { name: lead.name, item: listing.title, price: asking, offer };

  let decision: NegotiationDecision;
  let next: NegotiationState;

  if (state.status !== "open") {
    decision = { ...base, action: "stand-down", reason: `Negotiation already ${state.status}; no message.` };
    next = { ...state, lastOffer: offer };
  } else if (band === "at-asking") {
    decision = { ...base, action: "accept", agreedPrice: asking, reason: "Offer meets the asking price." };
    next = { ...state, lastOffer: offer, status: "agreed", agreedPrice: asking };
  } else if (state.countered && floor !== undefined && offer >= floor) {
    decision = { ...base, action: "accept", agreedPrice: offer, reason: `Offer $${offer} meets the $${floor} bottom line.` };
    next = { ...state, lastOffer: offer, status: "agreed", agreedPrice: offer };
  } else if (state.rounds >= config.maxCounterRounds) {
    const escalation = escalate(
      "negotiation-stalled",
      `NEGOTIATION STALLED: ${lead.name} is at $${offer} on "${listing.title}" ($${asking}${floor !== undefined ? `, floor $${floor}` : ""}) after ${state.rounds} rounds with no agreement. Agent stopped negotiating — your call.`,
      { leadId: lead.id, threadId: lead.threadId, offer: String(offer), asking: String(asking) },
    );
    decision = { ...base, action: "escalate", reason: `No agreement after ${state.rounds} rounds.`, escalation };
    next = { ...state, lastOffer: offer, status: "escalated" };
  } else if (band === "hold" || (band === "counter" && floor === undefined)) {
    decision = {
      ...base,
      action: "polite-hold",
      template: "offer-hold",
      context: ctx,
      reason: band === "hold" ? "Under 10% below asking: restate the firm price." : "No floor set on this listing: nothing to counter with, restate the firm price.",
    };
    next = { ...state, lastOffer: offer, rounds: state.rounds + 1 };
  } else if (band === "counter") {
    const counter = floor!;
    if (offer >= counter) {
      // Countering below what they offered would be absurd; the offer already clears the floor.
      decision = { ...base, action: "accept", agreedPrice: offer, reason: `Offer $${offer} is at or above the $${counter} floor.` };
      next = { ...state, lastOffer: offer, status: "agreed", agreedPrice: offer };
    } else if (!state.countered) {
      decision = { ...base, action: "counter", counterPrice: counter, template: "offer-counter", context: { ...ctx, counter }, reason: `10–25% below asking: one firm counter at the $${counter} floor.` };
      next = { ...state, lastOffer: offer, rounds: state.rounds + 1, countered: true };
    } else {
      decision = { ...base, action: "bottom-line", counterPrice: counter, template: "offer-bottom-line", context: { ...ctx, counter }, reason: "Already countered once: restate the bottom line, no new counter." };
      next = { ...state, lastOffer: offer, rounds: state.rounds + 1 };
    }
  } else {
    decision = { ...base, action: "decline", template: "offer-decline", context: ctx, reason: "25%+ below asking: decline without a counter." };
    next = { ...state, lastOffer: offer, rounds: state.rounds + 1 };
  }

  if (decision.agreedPrice !== undefined && floor !== undefined && decision.agreedPrice < floor) {
    throw new Error(`Refusing to agree at $${decision.agreedPrice}, below the $${floor} floor.`);
  }
  if (decision.template) assertAutonomous(doc, sellingScope(listingId), ACTIONS.REPLY);

  const note = `Offer $${offer} at ${nowIso}: ${decision.action}${decision.counterPrice !== undefined ? ` ($${decision.counterPrice})` : ""}${decision.agreedPrice !== undefined ? ` at $${decision.agreedPrice}` : ""}.`;
  const updated: Lead = { ...lead, negotiation: next, lastContactAt: nowIso, notes: [...lead.notes, note] };
  return { doc: { ...doc, leads: doc.leads.map((l) => (l.id === leadId ? updated : l)), updatedAt: nowIso }, decision, lead: updated };
}

/** Stage the decision's buyer message, if it has one. */
export function stageNegotiationReply(doc: TrackerDocument, lead: Lead, decision: NegotiationDecision, nowIso: string): TrackerDocument {
  if (!decision.template || !decision.context) return doc;
  const body = renderTemplate(doc, decision.template, decision.context);
  return stageMessage(doc, {
    kind: "negotiation",
    channel: lead.channel,
    threadId: lead.threadId,
    recipient: lead.name,
    body,
    listingId: lead.listingId,
    leadId: lead.id,
  }, nowIso).doc;
}

/** Set (or clear) a listing's floor price. Owner-supplied config, never agent-chosen. */
export function setFloorPrice(doc: TrackerDocument, listingId: string, floor: number | undefined, nowIso: string): TrackerDocument {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  if (floor !== undefined && !(floor > 0 && floor < listing.price)) throw new Error(`Floor must be positive and below the $${listing.price} asking price.`);
  return {
    ...doc,
    listings: doc.listings.map((l) => (l.id === listingId ? { ...l, floorPrice: floor, updatedAt: nowIso } : l)),
    updatedAt: nowIso,
  };
}
