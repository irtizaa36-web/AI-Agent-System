import type { TrackerDocument } from "./types";

/**
 * Escalation policy (explicit). The agent acts autonomously on everything
 * inside the ledger and escalates ONLY for:
 *   (a) money moving out (purchases, deposits),
 *   (b) publishing a new listing (one-tap approval on the intake draft),
 *   (c) scam-flagged or ambiguous inbound messages,
 *   (d) owner override detected (he replied in a managed thread himself),
 *   (e) LOGISTICS HANDOFF — the primary selling escalation: a buyer has
 *       accepted the firm/listed price AND is asking for the address and
 *       pickup time. Surface buyer name, item, agreed price, proposed time.
 *       Do NOT disclose any address, do NOT lock a pickup time, do not mark
 *       logistics final without him. Until this trigger fires, selling is
 *       fully autonomous (inquiries, holding firm, confirming the sale,
 *       queue advance, nudges, backups).
 *   (f) DEAL AGREED — the only buying ping, symmetric with (e): a seller
 *       AGREES to our predetermined price (at or under the ceiling).
 *       Surface seller name, exact item, agreed price, pickup/delivery plan.
 *       No money moves, no pickup commitment, no "I'll take it" to the
 *       seller without his approval. Everything before the ping —
 *       discovery, outreach, offers/counters up to the ceiling, walk-aways,
 *       authenticity verification — is autonomous.
 */

export const ACTIONS = {
  REPLY: "reply",
  CONFIRM: "confirm",
  HOLD: "hold",
  ADVANCE_QUEUE: "advance-queue",
  MARK_SOLD: "mark-sold",
  NUDGE: "nudge",
  BOOK: "book",
  PRICE_CHANGE: "price-change",
  OUTREACH: "outreach",
  OFFER: "offer",
  CLOSE_OUT: "close-out",
  PAUSE_HUNT: "pause-hunt",
  START_HUNT: "start-hunt",
  PURCHASE: "purchase",
  PUBLISH_LISTING: "publish-listing",
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

/** Scope for a selling listing id, e.g. "selling:chair". */
export function sellingScope(listingId: string): string {
  return `selling:${listingId}`;
}

export const BUYING_SCOPE = "buying";

export function grantFor(doc: TrackerDocument, scope: string) {
  return doc.authority.find((g) => g.scope === scope);
}

/** True when the agent may perform `action` in `scope` without asking. */
export function canAutonomous(doc: TrackerDocument, scope: string, action: string): boolean {
  const grant = grantFor(doc, scope);
  if (!grant) return false;
  return grant.autonomous.includes(action);
}

/** True when `action` in `scope` explicitly requires Toozy's approval. */
export function needsApproval(doc: TrackerDocument, scope: string, action: string): boolean {
  const grant = grantFor(doc, scope);
  if (!grant) return true;
  return grant.approvalRequired.includes(action);
}

export class AuthorityError extends Error {}

/** Throw unless the action is autonomous in this scope. */
export function assertAutonomous(doc: TrackerDocument, scope: string, action: string): void {
  if (!canAutonomous(doc, scope, action)) {
    throw new AuthorityError(`"${action}" in scope "${scope}" requires the owner's approval — stage it, don't execute it.`);
  }
}

export type EscalationReason =
  | "money-out"
  | "publish-listing"
  | "scam-flagged"
  | "owner-override"
  | "logistics-handoff"
  | "deal-agreed";

export interface Escalation {
  readonly reason: EscalationReason;
  readonly summary: string;
  readonly context: Record<string, string>;
}

export function escalate(reason: EscalationReason, summary: string, context: Record<string, string> = {}): Escalation {
  return { reason, summary, context };
}

/**
 * THE selling hard stop. Fires when a buyer has accepted the firm/listed
 * price AND is asking for the address / pickup time.
 *
 * `priceAccepted` is true when the lead status is "confirmed" or the message
 * itself accepts the price ("deal", "I'll take it", "$90 works", ...).
 * When the trigger fires: reply with the holding template, stage a
 * logistics-handoff escalation with buyer name / item / price / proposed
 * time, and NEVER disclose an address or lock a time.
 */
const PRICE_ACCEPTED = /\b(deal|sold|i'll take it|ill take it|i will take it|works for me|sounds good|ok(ay)?|yes|agreed)\b/i;
const PRICE_MENTION = /\$\s?\d+/;
const ASKS_LOGISTICS = /\b(address|location|where|pick ?up|pickup|meet(ing| up)?|come by|time|when|today|tomorrow)\b/i;

export function messageAcceptsPrice(body: string): boolean {
  const text = body ?? "";
  return PRICE_ACCEPTED.test(text) || PRICE_MENTION.test(text);
}

export function messageAsksLogistics(body: string): boolean {
  return ASKS_LOGISTICS.test(body ?? "");
}

/**
 * True when the selling hard stop fires for this inbound message.
 * priceAccepted may come from the lead's confirmed status OR the message.
 */
export function isLogisticsHandoff(body: string, priceAccepted: boolean): boolean {
  return (priceAccepted || messageAcceptsPrice(body)) && messageAsksLogistics(body);
}
