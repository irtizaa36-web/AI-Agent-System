/**
 * The settlement tracker's data model (ADR 0022). Every fact that could be
 * wrong carries where it came from: a deadline, a payout, a verdict and a
 * status change each record their source or evidence. Nothing here is ever
 * filled in by guessing — a missing fact stays missing and is shown as such.
 */

/** A calendar date, YYYY-MM-DD, in the owner's timezone. */
export type IsoDate = string;

/**
 * Where a claim stands. Only `filed` and `paid` describe something the owner
 * did outside this system, and only the owner can record them (CLI only).
 */
export type SettlementStatus = "researching" | "ready_to_file" | "filed" | "paid" | "dropped";
export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = ["researching", "ready_to_file", "filed", "paid", "dropped"];

/** Still needs the owner before the deadline. */
export const OPEN_STATUSES: ReadonlySet<SettlementStatus> = new Set(["researching", "ready_to_file"]);

export type Verdict = "eligible" | "not_eligible" | "unverified";
export const VERDICTS: readonly Verdict[] = ["eligible", "not_eligible", "unverified"];

/** Things only the owner can do: the agent tracks them, it never does them. */
export type ActionKind = "attestation" | "verification_code" | "product_count" | "notice_search" | "documentation" | "other";
export const ACTION_KINDS: readonly ActionKind[] = ["attestation", "verification_code", "product_count", "notice_search", "documentation", "other"];

/** Provenance for a fact: a page, the owner's own records, or a notice. */
export interface SourceRef {
  readonly label: string;
  readonly url?: string;
  readonly retrievedOn: IsoDate;
}

export interface DatedFact {
  readonly date: IsoDate;
  readonly source: SourceRef;
}

export interface PayoutEstimate {
  /** Exactly as the source states it, e.g. "Up to $800" or "Varies". Never a computed number. */
  readonly text: string;
  readonly source: SourceRef;
}

export interface EligibilityRecord {
  readonly verdict: Verdict;
  /** Why, in the owner's words or the source's. */
  readonly reason: string;
  readonly decidedOn: IsoDate;
}

export interface ActionItem {
  readonly id: string;
  readonly kind: ActionKind;
  readonly description: string;
  readonly done: boolean;
  readonly doneOn?: IsoDate;
  readonly note?: string;
}

export interface StatusEvent {
  readonly on: IsoDate;
  readonly from?: SettlementStatus;
  readonly to: SettlementStatus;
  readonly evidence: string;
}

/**
 * One eligibility requirement from a class definition, checked against the
 * owner's profile. `profile` criteria can be answered from what the owner has
 * told us; `evidence` criteria never can — only a record he holds settles them.
 */
export type Criterion =
  | { readonly kind: "residence"; readonly states: readonly string[]; readonly description: string }
  | { readonly kind: "profile"; readonly fact: ProfileFact; readonly description: string }
  | { readonly kind: "evidence"; readonly description: string };

export type ProfileFact =
  | "cvs_app_user"
  | "received_robocalls_or_texts"
  | "iphone_user"
  | "amazon_shopper"
  | "amazon_refund_problems"
  | "renter";

export interface Settlement {
  readonly id: string;
  readonly name: string;
  /** Other names the same settlement goes by, for matching research results. */
  readonly aliases: readonly string[];
  /** Official settlement-site domains, the strongest identity signal. */
  readonly domains: readonly string[];
  readonly classDefinition?: string;
  readonly criteria: readonly Criterion[];
  readonly website?: string;
  readonly deadline?: DatedFact;
  /** Other deadlines a source reported. Never auto-applied; the earliest wins for alerts. */
  readonly deadlineConflicts: readonly DatedFact[];
  readonly payout?: PayoutEstimate;
  readonly eligibility: EligibilityRecord;
  readonly status: SettlementStatus;
  readonly history: readonly StatusEvent[];
  readonly actions: readonly ActionItem[];
  readonly filedOn?: IsoDate;
  /** Only ever the number the claims administrator gave the owner. */
  readonly confirmation?: string;
  readonly paid?: { readonly amount: number; readonly on: IsoDate };
  readonly dropReason?: string;
}

/** A permanent "don't research this again" entry. Dropped settlements are added automatically. */
export interface DoNotResearchEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly domains: readonly string[];
  readonly reason: string;
  readonly addedOn: IsoDate;
}

/** A settlement found by a research sweep that the owner hasn't decided on yet. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly SourceRef[];
  readonly domains: readonly string[];
  readonly website?: string;
  readonly claimUrl?: string;
  readonly deadline?: DatedFact;
  readonly deadlineConflicts: readonly DatedFact[];
  readonly payout?: PayoutEstimate;
  readonly eligibilityText?: string;
  readonly proofText?: string;
  readonly criteria: readonly Criterion[];
  readonly firstSeen: IsoDate;
}

/** A deadline nudge that was already delivered, so it never repeats. */
export interface NudgeRecord {
  readonly key: string;
  readonly settlementId: string;
  readonly threshold: number;
  readonly deadline: IsoDate;
  readonly sentOn: IsoDate;
}

export interface TrackerDocument {
  readonly version: 1;
  readonly settlements: Settlement[];
  readonly doNotResearch: DoNotResearchEntry[];
  readonly inbox: Candidate[];
  /** Identity keys of every candidate ever reported, so a sweep never re-reports one. */
  readonly seenKeys: string[];
  readonly nudges: NudgeRecord[];
}
