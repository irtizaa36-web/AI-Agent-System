import { randomUUID } from "node:crypto";
import type { RentalBooking, TrackerDocument } from "../types";
import { checklistComplete } from "./rental_tree";

/**
 * SELLING — rental variant (BISSELL Little Green, ADR 0024).
 *
 * Replies and holds are autonomous; BOOKING needs Toozy's tap
 * (approval-gated): requestBooking() records a "pending-approval" draft and
 * stages nothing to send. approveBooking() flips it to "booked" and stages
 * the booking message into the outbox. Deposit is tracked pickup → return.
 */

export interface BookingRequest {
  readonly leadId: string;
  readonly pickupDate: string;
  readonly returnDate: string;
}

/** Draft a booking. Drafting is harmless bookkeeping (status pending-approval,
 * nothing staged to send), so it runs autonomously; the "book" action stays
 * approval-gated in the ledger, which is what blocks any booking message
 * from reaching the outbox without his tap. */
export function requestBooking(doc: TrackerDocument, listingId: string, req: BookingRequest, nowIso: string): { doc: TrackerDocument; booking: RentalBooking } {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  if (listing.kind !== "rental" || !listing.terms) throw new Error(`Listing "${listingId}" is not a rental.`);
  const lead = doc.leads.find((l) => l.id === req.leadId && l.listingId === listingId);
  if (!lead) throw new Error(`Unknown lead "${req.leadId}" for listing "${listingId}".`);

  const booking: RentalBooking = {
    id: randomUUID(),
    listingId,
    leadId: req.leadId,
    pickupDate: req.pickupDate,
    returnDate: req.returnDate,
    status: "pending-approval",
    deposit: { amount: listing.terms.deposit, paid: false },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return { doc: { ...doc, bookings: [...doc.bookings, booking], updatedAt: nowIso }, booking };
}

/**
 * Owner-approved step: flip a pending booking to "booked". Called only after
 * Toozy taps approve on the booking draft.
 */
export function approveBooking(doc: TrackerDocument, bookingId: string, nowIso: string): { doc: TrackerDocument; booking: RentalBooking } {
  const booking = doc.bookings.find((b) => b.id === bookingId);
  if (!booking) throw new Error(`Unknown booking "${bookingId}".`);
  if (booking.status !== "pending-approval") throw new Error(`Booking "${bookingId}" is ${booking.status}, not pending-approval.`);
  // Rental decision tree: confirmed ONLY when rate + deposit + a specific pickup time are all agreed.
  const lead = doc.leads.find((l) => l.id === booking.leadId);
  if (!checklistComplete(lead?.rental)) {
    const c = lead?.rental;
    const missing = [!c?.rateAgreed && "rate", !c?.depositCommitted && "deposit", !c?.pickupTime && "specific pickup time"].filter(Boolean).join(", ");
    throw new Error(`Booking "${bookingId}" can't be confirmed yet — not agreed: ${missing}.`);
  }
  const updated: RentalBooking = { ...booking, status: "booked", updatedAt: nowIso };
  return { doc: { ...doc, bookings: doc.bookings.map((b) => (b.id === bookingId ? updated : b)), updatedAt: nowIso }, booking: updated };
}

export function recordDepositPaid(doc: TrackerDocument, bookingId: string, method: string, nowIso: string): TrackerDocument {
  return updateBooking(doc, bookingId, (b) => ({
    ...b,
    status: b.status === "booked" ? "picked-up" : b.status,
    deposit: { ...b.deposit, paid: true, paidAt: nowIso, method },
    updatedAt: nowIso,
  }), nowIso);
}

/** Deposit returned at drop-off — the money-out-the-door moment, recorded not sent. */
export function recordDepositReturned(doc: TrackerDocument, bookingId: string, nowIso: string): TrackerDocument {
  return updateBooking(doc, bookingId, (b) => ({
    ...b,
    status: "returned",
    deposit: { ...b.deposit, returned: true, returnedAt: nowIso },
    updatedAt: nowIso,
  }), nowIso);
}

export function cancelBooking(doc: TrackerDocument, bookingId: string, nowIso: string): TrackerDocument {
  return updateBooking(doc, bookingId, (b) => ({ ...b, status: "cancelled", updatedAt: nowIso }), nowIso);
}

function updateBooking(doc: TrackerDocument, bookingId: string, fn: (b: RentalBooking) => RentalBooking, nowIso: string): TrackerDocument {
  const booking = doc.bookings.find((b) => b.id === bookingId);
  if (!booking) throw new Error(`Unknown booking "${bookingId}".`);
  return { ...doc, bookings: doc.bookings.map((b) => (b.id === bookingId ? fn(b) : b)), updatedAt: nowIso };
}

export function bookingsFor(doc: TrackerDocument, listingId: string): RentalBooking[] {
  return doc.bookings.filter((b) => b.listingId === listingId);
}
