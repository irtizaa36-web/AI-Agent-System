import type { Lead, Listing, RentalChecklist, TrackerDocument } from "../types";
import { DEFAULT_CONFIG, type RentalConfig } from "../config";
import { ACTIONS, assertAutonomous, escalate, sellingScope, type Escalation } from "../policy";
import { renderTemplate, type TemplateContext } from "../templates";
import { stageMessage } from "../outbox";

/**
 * SELLING — rental decision tree (Karen upgrade 4; BISSELL Little Green and
 * any future rental).
 *
 * Every renter message is read for three facts — rate agreed, deposit
 * committed, specific pickup time — and routed, in this order:
 *   1. delivery / meet-elsewhere / shipping request → decline politely:
 *      pickup in the Highland Village area only. Never delivers, never ships.
 *   2. rate not yet agreed → quote the rate + deposit.
 *   3. no deposit commitment (or a request to skip it) → require the
 *      refundable deposit (Venmo / Zelle / cash at pickup). Never waived.
 *   4. vague pickup time ("tomorrow sometime") → demand a specific time.
 *   5. all three agreed → "ready": the booking can be drafted for the
 *      owner's tap. A booking is confirmed ONLY in this state
 *      (approveBooking enforces it).
 */

export type RentalStep = "decline-delivery" | "quote-rate" | "require-deposit" | "demand-specific-time" | "ready";

export interface RentalDecision {
  readonly step: RentalStep;
  readonly template: string;
  readonly context: TemplateContext;
  readonly checklist: RentalChecklist;
  readonly escalation?: Escalation;
}

const DELIVERY = /\b(deliver(y|ed)?|drop (it )?off (at|to)|bring (it )?(to|over|by)|ship(ping|ped)?|mail it|come to (me|my)|meet (me )?(at|in|near|halfway|somewhere)|halfway)\b/i;
const CLOCK_TIME = /\b(\d{1,2}(:\d{2})\s*(am|pm)?|\d{1,2}\s*(am|pm)|noon|midnight)\b/i;
const DAY = /\b(today|tonight|tomorrow|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}\/\d{1,2})\b/i;
const VAGUE = /\b(sometime|some time|whenever|anytime|any time|later|morning|afternoon|evening|this weekend|next week|soon|asap|tbd|not sure)\b/i;
const WAIVE_DEPOSIT = /\b(no deposit|without (a |the )?deposit|skip (the )?deposit|waive|don'?t (want to )?(pay|do) (a |the )?deposit)\b/i;
const DEPOSIT_METHOD = /\b(venmo|zelle|cash)\b/i;
const DEPOSIT_OK = /\b(deposit)\b[^.?!]{0,40}\b(fine|ok(ay)?|good|works|no problem|sure|yes|agree|can do|will)\b|\b(fine|ok(ay)?|good|works|no problem|sure|yes|agree|can do|will (pay|send|bring))\b[^.?!]{0,40}\bdeposit\b/i;
const RATE_OK = /\b(price|rate|\$\s?\d+|per day|a day|\/day)\b[^.?!]{0,40}\b(fine|ok(ay)?|good|works|no problem|sure|deal)\b|\b(sounds good|works for me|deal|i'?ll take it|let'?s do it|book (it|me))\b/i;

/** "tomorrow at 3pm" / "Sat 10:30" → specific; "tomorrow sometime" → vague. Returns the time phrase when specific. */
export function specificPickupTime(body: string): string | undefined {
  const text = body ?? "";
  const clock = text.match(CLOCK_TIME);
  if (!clock) return undefined;
  const day = text.match(DAY);
  return day ? `${day[0]} ${clock[0]}`.trim() : clock[0].trim();
}

export function mentionsVagueTime(body: string): boolean {
  return VAGUE.test(body ?? "") && specificPickupTime(body) === undefined;
}

export function asksForDelivery(body: string): boolean {
  return DELIVERY.test(body ?? "");
}

/** Read one renter message into the running checklist. Waiver requests never count as a commitment. */
export function readRentalMessage(body: string, prior: RentalChecklist = { rateAgreed: false, depositCommitted: false }): RentalChecklist {
  const text = body ?? "";
  const waiver = WAIVE_DEPOSIT.test(text);
  const method = text.match(DEPOSIT_METHOD)?.[0];
  const depositCommitted = waiver ? false : prior.depositCommitted || DEPOSIT_OK.test(text) || (method !== undefined && /\bdeposit\b/i.test(text));
  const pickupTime = specificPickupTime(text) ?? prior.pickupTime;
  // Agreeing to the deposit or naming a pickup time implies the quoted rate is accepted.
  const rateAgreed = prior.rateAgreed || RATE_OK.test(text) || (depositCommitted && !prior.depositCommitted);
  return {
    rateAgreed,
    depositCommitted,
    depositMethod: depositCommitted ? (method ? capitalize(method) : prior.depositMethod) : undefined,
    pickupTime,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function checklistComplete(c: RentalChecklist | undefined): boolean {
  return !!c && c.rateAgreed && c.depositCommitted && !!c.pickupTime;
}

function termsFor(listing: Listing, config: RentalConfig) {
  return {
    dayRate: listing.terms?.dayRate ?? listing.price,
    deposit: listing.terms?.deposit ?? config.deposit,
    depositMethods: config.depositMethods.join(", "),
  };
}

/**
 * Route one renter message through the tree, record the checklist on the
 * lead, and return the reply to stage. Pure; stageRentalReply stages it.
 */
export function evaluateRentalMessage(
  doc: TrackerDocument,
  listingId: string,
  leadId: string,
  body: string,
  nowIso: string,
  config: RentalConfig = DEFAULT_CONFIG.rental,
): { doc: TrackerDocument; decision: RentalDecision; lead: Lead } {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  if (listing.kind !== "rental") throw new Error(`Listing "${listingId}" is not a rental.`);
  const lead = doc.leads.find((l) => l.id === leadId && l.listingId === listingId);
  if (!lead) throw new Error(`Unknown lead "${leadId}" for listing "${listingId}".`);
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.REPLY);

  const checklist = readRentalMessage(body, lead.rental);
  const terms = termsFor(listing, config);
  const base = { name: lead.name, pickupArea: config.pickupArea };

  let decision: RentalDecision;
  if (asksForDelivery(body)) {
    decision = { step: "decline-delivery", template: "rental-no-delivery", context: base, checklist };
  } else if (!checklist.rateAgreed) {
    decision = { step: "quote-rate", template: "rental-rate", context: { ...base, dayRate: terms.dayRate, deposit: terms.deposit, depositMethods: terms.depositMethods }, checklist };
  } else if (!checklist.depositCommitted) {
    decision = { step: "require-deposit", template: "rental-need-deposit", context: { ...base, deposit: terms.deposit, depositMethods: terms.depositMethods }, checklist };
  } else if (!checklist.pickupTime) {
    decision = { step: "demand-specific-time", template: "rental-need-time", context: base, checklist };
  } else {
    decision = {
      step: "ready",
      template: "rental-ready",
      context: { ...base, dayRate: terms.dayRate, deposit: terms.deposit, depositMethod: checklist.depositMethod ?? "at pickup", pickupTime: checklist.pickupTime },
      checklist,
      escalation: escalate(
        "rental-ready",
        `RENTAL READY: ${lead.name} agreed $${terms.dayRate}/day + $${terms.deposit} deposit (${checklist.depositMethod ?? "method at pickup"}), pickup ${checklist.pickupTime}. Draft the booking for your tap.`,
        { leadId: lead.id, threadId: lead.threadId, pickupTime: checklist.pickupTime },
      ),
    };
  }

  const updated: Lead = { ...lead, rental: checklist, lastContactAt: nowIso, notes: [...lead.notes, `Rental tree at ${nowIso}: ${decision.step}.`] };
  return { doc: { ...doc, leads: doc.leads.map((l) => (l.id === leadId ? updated : l)), updatedAt: nowIso }, decision, lead: updated };
}

export function stageRentalReply(doc: TrackerDocument, lead: Lead, decision: RentalDecision, nowIso: string): TrackerDocument {
  const body = renderTemplate(doc, decision.template, decision.context);
  return stageMessage(doc, {
    kind: "reply",
    channel: lead.channel,
    threadId: lead.threadId,
    recipient: lead.name,
    body,
    listingId: lead.listingId,
    leadId: lead.id,
  }, nowIso).doc;
}
