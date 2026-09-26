import { sortQueueByReliability } from "./reliability";
import type { Lead, Listing, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, sellingScope } from "../policy";

/**
 * SELLING — buyer queue with auto-advance (ADR 0024).
 *
 * A lead on "hold" owns the next-pickup slot. Unconfirmed holds expire after
 * the listing's holdTimeoutHours; the expired lead drops back to "contacted"
 * (still a warm backup) and the next queued lead advances to "hold" with a
 * fresh expiry. Confirming a lead ("it's yours at $X") is autonomous at the
 * listed price; the LOGISTICS HANDOFF fires later when the buyer asks for
 * the address/pickup time.
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

export interface AdvanceResult {
  readonly expired: Lead[];
  readonly advanced?: Lead;
}

/**
 * Expire stale holds and advance the queue. Autonomous (advance-queue) in
 * the selling scope — throws AuthorityError otherwise.
 */
export function advanceExpiredHolds(doc: TrackerDocument, listingId: string, nowIso: string): { doc: TrackerDocument; result: AdvanceResult } {
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
  if (expired.length > 0) {
    // Reliability-aware: known flakes are skipped by the queue ordering, and
    // the just-expired lead never re-advances in the same pass (it dropped
    // back to backup unconfirmed).
    const expiredIds = new Set(expired.map((e) => e.id));
    const next = sortQueueByReliability(
      doc,
      leads.filter((l) => l.listingId === listingId && ["new", "contacted"].includes(l.status) && !expiredIds.has(l.id)),
    )[0];
    if (next) {
      advanced = {
        ...next,
        status: "hold",
        holdExpiresAt: holdExpiresAt(listing, nowIso),
        lastContactAt: nowIso,
        notes: [...next.notes, `Auto-advanced to hold at ${nowIso} after an expired hold.`],
      };
      leads = leads.map((l) => (l.id === advanced!.id ? advanced! : l));
    }
  }

  return { doc: { ...doc, leads, updatedAt: nowIso }, result: { expired, advanced } };
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
  const updated: Lead = {
    ...lead,
    status: "hold",
    holdExpiresAt: holdExpiresAt(listing, nowIso),
    lastContactAt: nowIso,
    notes: [...lead.notes, `Hold placed at ${nowIso}, expires ${holdExpiresAt(listing, nowIso)}.`],
  };
  return { doc: { ...doc, leads: doc.leads.map((l) => (l.id === leadId ? updated : l)), updatedAt: nowIso }, lead: updated };
}
