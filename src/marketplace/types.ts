/**
 * Marketplace Agent v2 — shared types (ADR 0024).
 *
 * The whole agent is organized around two mechanisms:
 *   SELLING — everything inbound: listings, buyer queues, confirmations, pickups, rentals.
 *   BUYING  — everything outbound: hunts, sweeps, seller outreach, offers, purchases.
 * Everything else in this directory is shared by both.
 */

/** Inbound channel a lead event arrived on. */
export type Channel = "messenger" | "voice-sms" | "agentmail";

export type ListingKind = "sale" | "rental";
export type ListingStatus = "active" | "paused" | "sold";

export interface RentalTerms {
  readonly dayRate: number;
  readonly deposit: number;
  readonly depositMethods: readonly string[];
  /** When the deposit changes hands. */
  readonly depositPaidAt: "pickup" | "booking";
  readonly solutionIncluded: string;
  readonly extraSolutionPrice: number;
  readonly pickupReturn: string;
}

export interface Listing {
  readonly id: string;
  readonly kind: ListingKind;
  readonly title: string;
  /** Sale price, or $/day for rentals. */
  readonly price: number;
  readonly priceFirm: boolean;
  readonly payment: string;
  /** Public-meetup language only — never a street address. */
  readonly meetup: string;
  readonly description?: string;
  /** facebook-cli listing_id once published. */
  readonly fbListingId?: string;
  readonly status: ListingStatus;
  /** Inquiry monitoring enabled (cron watches this listing's threads). */
  readonly monitoring: boolean;
  /** Hours an unconfirmed hold lives before the queue auto-advances. */
  readonly holdTimeoutHours: number;
  readonly terms?: RentalTerms;
  /** Lowest price the agent may ever agree to. Unset → no counter below asking. */
  readonly floorPrice?: number;
  /** Price before any stale auto-drop, for the drop floor. */
  readonly originalPrice?: number;
  readonly lastPriceDropAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LeadStatus =
  | "new"
  | "contacted"
  | "hold"
  | "confirmed"
  | "deferred"
  | "dead";

export interface Lead {
  readonly id: string;
  readonly listingId: string;
  readonly name: string;
  readonly threadId: string;
  readonly channel: Channel;
  readonly status: LeadStatus;
  readonly queuePosition: number;
  readonly firstSeenAt: string;
  readonly lastContactAt: string;
  readonly holdExpiresAt?: string;
  readonly pickupAt?: string;
  readonly ownerRepliedAt?: string;
  /** False once the owner has handled the thread himself — agent stands down. */
  readonly needsAgentFollowUp: boolean;
  /** Thread turn-state for the nudge cadence: who are we waiting on? */
  readonly awaiting: "them" | "us";
  /** Escalating nudge level already sent: 0 = none, 1 = gentle, 2 = firm, 3 = final-call. */
  readonly nudgeLevel: number;
  readonly lastNudgeAt?: string;
  readonly notes: readonly string[];
  /** Offer negotiation progress (selling/negotiation.ts). */
  readonly negotiation?: NegotiationState;
  /** Rental booking checklist (selling/rental_tree.ts). */
  readonly rental?: RentalChecklist;
}

export interface NegotiationState {
  /** Agent responses to below-asking offers so far. */
  readonly rounds: number;
  /** The one firm counter at the floor has been given. */
  readonly countered: boolean;
  readonly lastOffer?: number;
  readonly status: "open" | "agreed" | "escalated";
  readonly agreedPrice?: number;
}

export interface RentalChecklist {
  readonly rateAgreed: boolean;
  readonly depositCommitted: boolean;
  readonly depositMethod?: string;
  /** The renter's specific pickup time, as they stated it. */
  readonly pickupTime?: string;
}

export type CampaignStatus = "active" | "paused" | "cancelled";

/** A BUYING hunt: outbound deal search with criteria and a walk-away point. */
export interface Offer {
  readonly threadId: string;
  readonly amount: number;
  /** "ours" = agent's offer, "theirs" = seller's ask/counter. */
  readonly kind: "ours" | "theirs";
  readonly at: string;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly criteria: string;
  readonly maxPrice?: number;
  /** Messenger thread ids under management for this hunt. */
  readonly threads: readonly string[];
  /** Offer history per thread (both sides). Walk-away decisions read this. */
  readonly offers: readonly Offer[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt?: string;
}

export interface SellerConstraint {
  readonly id: string;
  readonly text: string;
  readonly appliesTo: "pickup" | "all";
  readonly active: boolean;
}

export type OutboxKind =
  | "reply"
  | "confirmation"
  | "close-out"
  | "booking"
  | "sms-draft"
  | "nudge"
  | "sold-notice"
  | "negotiation"
  | "queue";

/** "suppressed" = held back at flush because the owner is active in the thread; never sent. */
export type OutboxStatus = "pending" | "awaiting-tap" | "sent" | "suppressed";

export interface OutboxMessage {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly channel: Channel;
  readonly threadId: string;
  readonly recipient: string;
  readonly body: string;
  readonly stagedAt: string;
  readonly status: OutboxStatus;
  readonly listingId?: string;
  readonly leadId?: string;
}

export type BookingStatus =
  | "pending-approval"
  | "booked"
  | "picked-up"
  | "returned"
  | "cancelled";

export interface RentalBooking {
  readonly id: string;
  readonly listingId: string;
  readonly leadId: string;
  readonly pickupDate: string;
  readonly returnDate: string;
  readonly status: BookingStatus;
  readonly deposit: {
    readonly amount: number;
    readonly paid: boolean;
    readonly paidAt?: string;
    readonly method?: string;
    readonly returned?: boolean;
    readonly returnedAt?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of the authority ledger: what the agent may do alone vs what needs Toozy. */
export interface AuthorityGrant {
  readonly scope: string;
  readonly autonomous: readonly string[];
  readonly approvalRequired: readonly string[];
}

/** Per-buyer reliability record, keyed by normalized name. */
export interface BuyerStats {
  readonly name: string;
  /** Threads seen for this buyer. */
  readonly threads: readonly string[];
  readonly contacts: number;
  /** Went silent after we replied (ghost). */
  readonly ghosts: number;
  /** Holds that expired unconfirmed (flaky). */
  readonly holdsExpired: number;
  /** Times they pushed below a firm price (lowball pattern). */
  readonly lowballs: number;
  /** Completed purchases/pickups. */
  readonly completed: number;
  /** 0..100. Starts at 70; ghosts/flakes/lowballs drag it down, completions lift it. */
  readonly score: number;
  readonly updatedAt: string;
}

/** Rolling thread summary — raw messages are summarized once, then dropped. */
export interface ThreadSummary {
  readonly threadId: string;
  /** Living summary text, updated incrementally. */
  readonly summary: string;
  readonly updatedAt: string;
  /** Count of messages folded into the summary. */
  readonly messageCount: number;
}

export interface ActivityEntry {
  readonly at: string;
  readonly kind: "confirmation" | "booking" | "escalation" | "nudge" | "hunt" | "listing" | "system" | "negotiation" | "queue" | "rental" | "parse-failure";
  /** One line, no message bodies. */
  readonly text: string;
}

export interface TrackerDocument {
  readonly version: 1;
  readonly listings: readonly Listing[];
  readonly leads: readonly Lead[];
  readonly campaigns: readonly Campaign[];
  readonly constraints: readonly SellerConstraint[];
  readonly authority: readonly AuthorityGrant[];
  readonly outbox: readonly OutboxMessage[];
  readonly bookings: readonly RentalBooking[];
  /** Dedupe keys for channel events already processed. */
  readonly seenEvents: readonly string[];
  /** Buyer reliability scores, keyed by normalized buyer name. */
  readonly buyers: Record<string, BuyerStats>;
  /** Watermark: last-read event id per thread — polls fetch deltas only. */
  readonly watermarks: Record<string, string>;
  /** Rolling summaries per thread — never full message bodies. */
  readonly summaries: Record<string, ThreadSummary>;
  /** Owner's latest own message per thread (ISO) — drives the watch-only window. */
  readonly ownerActivity: Record<string, string>;
  /** Capped activity log (latest 200) feeding the daily digest. */
  readonly activity: readonly ActivityEntry[];
  readonly updatedAt: string;
}
