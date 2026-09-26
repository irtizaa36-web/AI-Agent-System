import { sortQueueByReliability } from "./reliability";
import type { Lead, Listing, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, sellingScope } from "../policy";
import { renderTemplate } from "../templates";
import { stageMessage } from "../outbox";

/**
 * SELLING — buyer queue with auto-advance (ADR 0024, Karen upgrade 2).
 *
 * A lead on "hold" owns the next-pickup slot — one active hold per item,
 * never two. Unconfirmed holds expire after the listing's holdTimeoutHours
 * (default 12, config queue.holdTimeoutHours); the expired lead drops back
 * to "contacted" and is told the hold lapsed, and the next buyer in strict
 * first-in-line order is offered the same terms with a fresh expiry.
 * Confirming a lead ("it's yours at $X") is autonomous at the listed price;
 * the LOGISTICS HANDOFF fires later when the buyer asks for the
 * address/pickup time.
 */

export function queueFor(doc: TrackerDocument, listingId: string): Lead[] {
  // Reliability-aware queue: known flakes sink to the bottom automatically.
  return sortQueueByReliability(
    doc,
    doc.leads.filter((l) => l.listingId === listingId && !["dead", "deferred"].includes(l.status)),
  );
}

export function holdExpiresAt(listing: Listing, fromIso: string): string {
  return new Date(new Date(fromIso).getTime() + listing.holdTimeoutHours * 3600_000).toISOString();
}

/** A hold that hasn't expired yet at nowIso (a hold with no expiry counts as active). */
function isActiveHold(lead: Lead, nowIso: string): boolean {
  return lead.status === "hold" && (!lead.holdExpiresAt || lead.holdExpiresAt > nowIso);
}

/** The lead currently owning the pickup slot on this listing, if any. */
export function activeHoldFor(doc: TrackerDocument, listingId: string, nowIso: string): Lead | undefined {
  return doc.leads.find((l) => l.listingId === listingId && isActiveHold(l, nowIso));
}

/** Strict first-in-line order: queue position, then first contact. */
function firstInLine(a: Lead, b: Lead): number {
  return a.queuePosition - b.queuePosition || a.firstSeenAt.localeCompare(b.firstSeenAt);
}

export interface AdvanceResult {
  readonly expired: Lead[];
  readonly advanced?: Lead;
  /** Price offered to the advanced buyer: the same terms the lapsed hold had. */
  readonly offeredPrice?: number;
}

export interface AdvanceOptions {
  /** Threads the agent must not message right now (owner watch-only); their leads are not advanced. */
  readonly skipThreads?: ReadonlySet<string>;
}

/**
 * Expire stale holds and advance the queue (Karen upgrade 2). A buyer who
 * claimed the pickup slot without confirming a specific time holds it for
 * the listing's holdTimeoutHours (default 12). On expiry the lead drops back
 * to "contacted", and the next buyer in STRICT first-in-line order is
 * offered the same terms. Invariant: never two active holds on one item —
 * nobody advances while another hold is live or a sale is confirmed.
 * Autonomous (advance-queue) in the selling scope — throws AuthorityError
 * otherwise.
 */
export function advanceExpiredHolds(
  doc: TrackerDocument,
  listingId: string,
  nowIso: string,
  opts: AdvanceOptions = {},
): { doc: TrackerDocument; result: AdvanceResult } {
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.ADVANCE_QUEUE);
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);

  const expired: Lead[] = [];
  let leads = doc.leads.map((lead) => {
    if (lead.listingId === listingId && lead.status === "hold" && lead.holdExpiresAt && lead.holdExpiresAt <= nowIso) {
      const done: Lead = {
        ...lead,
        status: "contacted",
        holdExpiresAt: undefined,
        notes: [...lead.notes, `Hold expired at ${nowIso}; dropped back to backup.`],
      };
      expired.push(done);
      return done;
    }
    return lead;
  });

  let advanced: Lead | undefined;
  let offeredPrice: number | undefined;
  const slotTaken = leads.some((l) => l.listingId === listingId && (isActiveHold(l, nowIso) || l.status === "confirmed"));
  if (expired.length > 0 && !slotTaken && listing.status === "active") {
    // The just-expired leads never re-advance in the same pass.
    const expiredIds = new Set(expired.map((e) => e.id));
    const next = leads
      .filter((l) =>
        l.listingId === listingId &&
        ["new", "contacted"].includes(l.status) &&
        !expiredIds.has(l.id) &&
        l.needsAgentFollowUp &&
        !opts.skipThreads?.has(l.threadId))
      .sort(firstInLine)[0];
    if (next) {
      const lapsed = [...expired].sort(firstInLine)[0];
      offeredPrice = lapsed.negotiation?.status === "agreed" && lapsed.negotiation.agreedPrice !== undefined ? lapsed.negotiation.agreedPrice : listing.price;
      advanced = {
        ...next,
        status: "hold",
        holdExpiresAt: holdExpiresAt(listing, nowIso),
        lastContactAt: nowIso,
        awaiting: "them",
        notes: [...next.notes, `Auto-advanced to hold at ${nowIso} after an expired hold; offered $${offeredPrice}.`],
      };
      leads = leads.map((l) => (l.id === advanced!.id ? advanced! : l));
    }
  }

  return { doc: { ...doc, leads, updatedAt: nowIso }, result: { expired, advanced, offeredPrice } };
}

/**
 * Stage the buyer messages for an advance: a "hold lapsed" note to each
 * expired buyer, then the same-terms offer to the advanced one. Threads in
 * skipThreads (owner watch-only) and owner-handled leads get nothing.
 */
export function stageAdvanceMessages(
  doc: TrackerDocument,
  listingId: string,
  result: AdvanceResult,
  nowIso: string,
  opts: AdvanceOptions = {},
): { doc: TrackerDocument; staged: number } {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  let next = doc;
  let staged = 0;
  const stage = (lead: Lead, template: string, ctx: Record<string, string | number>) => {
    if (!lead.needsAgentFollowUp || opts.skipThreads?.has(lead.threadId)) return;
    const body = renderTemplate(next, template, ctx);
    const r = stageMessage(next, { kind: "queue", channel: lead.channel, threadId: lead.threadId, recipient: lead.name, body, listingId, leadId: lead.id }, nowIso);
    next = r.doc;
    if (!r.duplicated) staged++;
  };
  for (const lead of result.expired) stage(lead, "hold-lapsed", { name: lead.name, item: listing.title });
  if (result.advanced) {
    stage(result.advanced, "hold-offer", {
      name: result.advanced.name,
      item: listing.title,
      price: result.offeredPrice ?? listing.price,
      payment: listing.payment,
      meetup: listing.meetup,
      holdHours: listing.holdTimeoutHours,
    });
  }
  return { doc: next, staged };
}

export interface ConfirmInput {
  /** ISO datetime of the agreed pickup, e.g. "2026-09-26T14:30:00-05:00". */
  readonly pickupAt: string;
  readonly payment?: string;
}

/**
 * Confirm a sale to a lead at the listed price ("it's yours at $90").
 * Autonomous in the selling scope. Records the confirmation; the caller
 * stages the confirmation message via templates + outbox.
 */
export function confirmLead(doc: TrackerDocument, listingId: string, leadId: string, input: ConfirmInput, nowIso: string): { doc: TrackerDocument; lead: Lead } {
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.CONFIRM);
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  const lead = doc.leads.find((l) => l.id === leadId && l.listingId === listingId);
  if (!lead) throw new Error(`Unknown lead "${leadId}" for listing "${listingId}".`);
  if (lead.status === "confirmed") throw new Error(`Lead "${leadId}" is already confirmed.`);

  const updated: Lead = {
    ...lead,
    status: "confirmed",
    pickupAt: input.pickupAt,
    holdExpiresAt: undefined,
    lastContactAt: nowIso,
    needsAgentFollowUp: false,
    notes: [...lead.notes, `Sale confirmed at ${nowIso}: $${listing.price}${listing.priceFirm ? " firm" : ""}, pickup ${input.pickupAt}.`],
  };
  const leads = doc.leads.map((l) => (l.id === leadId ? updated : l));
  return { doc: { ...doc, leads, updatedAt: nowIso }, lead: updated };
}

/**
 * Mark the listing sold. Other live leads drop to "dead" with a note; the
 * caller decides which sold-notices to stage into the outbox.
 */
export function markSold(doc: TrackerDocument, listingId: string, buyerLeadId: string, nowIso: string): { doc: TrackerDocument; notify: Lead[] } {
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.MARK_SOLD);
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);

  const notify: Lead[] = [];
  const leads = doc.leads.map((lead) => {
    if (lead.listingId !== listingId || lead.id === buyerLeadId) return lead;
    if (["new", "contacted", "hold"].includes(lead.status)) {
      notify.push(lead);
      return { ...lead, status: "dead" as const, holdExpiresAt: undefined, notes: [...lead.notes, `Item sold to another buyer at ${nowIso}.`] };
    }
    return lead;
  });
  const listings = doc.listings.map((l) => (l.id === listingId ? { ...l, status: "sold" as const, updatedAt: nowIso } : l));
  return { doc: { ...doc, listings, leads, updatedAt: nowIso }, notify };
}

/** Place (or refresh) a time-boxed hold on a lead. Autonomous. */
export function holdLead(doc: TrackerDocument, listingId: string, leadId: string, nowIso: string): { doc: TrackerDocument; lead: Lead } {
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.HOLD);
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  const lead = doc.leads.find((l) => l.id === leadId && l.listingId === listingId);
  if (!lead) throw new Error(`Unknown lead "${leadId}" for listing "${listingId}".`);
  const holder = activeHoldFor(doc, listingId, nowIso);
  if (holder && holder.id !== leadId) {
    throw new Error(`${holder.name} already holds "${listing.title}" until ${holder.holdExpiresAt ?? "released"} — one active hold per item.`);
  }
  if (doc.leads.some((l) => l.listingId === listingId && l.status === "confirmed" && l.id !== leadId)) {
    throw new Error(`"${listing.title}" is already confirmed to another buyer — no new hold.`);
  }
  const updated: Lead = {
    ...lead,
    status: "hold",
    holdExpiresAt: holdExpiresAt(listing, nowIso),
    lastContactAt: nowIso,
    notes: [...lead.notes, `Hold placed at ${nowIso}, expires ${holdExpiresAt(listing, nowIso)}.`],
  };
  return { doc: { ...doc, leads: doc.leads.map((l) => (l.id === leadId ? updated : l)), updatedAt: nowIso }, lead: updated };
}
