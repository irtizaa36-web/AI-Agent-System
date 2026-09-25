import type { Criterion, ProfileFact, Verdict } from "./types";

/**
 * The eligibility evaluator (ADR 0022). It scores a class definition against
 * what the owner has told us about himself — and nothing more. A requirement
 * the profile can't answer ("the texts came from USA Clinics Group", "you
 * bought VSL#3 in 2017") stays unknown, so the verdict stays `unverified`
 * with the evidence he'd need, never a guessed `eligible`.
 */

export interface OwnerProfile {
  /** Two-letter state of residence. */
  readonly residenceState: string;
  /** true = confirmed, false = confirmed not; a missing fact is unknown. */
  readonly facts: Partial<Record<ProfileFact, boolean>>;
}

/** What the owner has told us (2026-09-25). */
export const OWNER_PROFILE: OwnerProfile = {
  residenceState: "TX",
  facts: {
    cvs_app_user: true,
    received_robocalls_or_texts: true,
    iphone_user: true,
    amazon_shopper: true,
    amazon_refund_problems: true,
    renter: true,
  },
};

export type CriterionResult = "met" | "not_met" | "unknown";

export interface CriterionCheck {
  readonly criterion: Criterion;
  readonly result: CriterionResult;
  readonly note: string;
}

export interface Evaluation {
  readonly verdict: Verdict;
  readonly checks: readonly CriterionCheck[];
  /** What the owner must personally confirm or find before this can be `eligible`. */
  readonly evidenceRequired: readonly string[];
  readonly summary: string;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const FACT_LABELS: Readonly<Record<ProfileFact, string>> = {
  cvs_app_user: "uses the CVS website/app",
  received_robocalls_or_texts: "received robocalls or marketing texts",
  iphone_user: "uses an iPhone",
  amazon_shopper: "shops on Amazon",
  amazon_refund_problems: "had Amazon returns with missing, late or wrong refunds",
  renter: "rents his home",
};

export function checkCriterion(criterion: Criterion, profile: OwnerProfile): CriterionCheck {
  if (criterion.kind === "residence") {
    const met = criterion.states.includes(profile.residenceState);
    return { criterion, result: met ? "met" : "not_met", note: met ? `resident of ${profile.residenceState}` : `class is limited to ${criterion.states.join(", ")} residents; owner lives in ${profile.residenceState}` };
  }
  if (criterion.kind === "profile") {
    const value = profile.facts[criterion.fact];
    if (value === true) return { criterion, result: "met", note: `profile: owner ${FACT_LABELS[criterion.fact]}` };
    if (value === false) return { criterion, result: "not_met", note: `profile: owner does not match "${FACT_LABELS[criterion.fact]}"` };
    return { criterion, result: "unknown", note: `profile doesn't say whether owner ${FACT_LABELS[criterion.fact]}` };
  }
  return { criterion, result: "unknown", note: "needs the owner's own records" };
}

export function evaluate(criteria: readonly Criterion[], profile: OwnerProfile = OWNER_PROFILE): Evaluation {
  const effective: readonly Criterion[] = criteria.length > 0 ? criteria : [{ kind: "evidence", description: "Read the class definition on the official settlement site; nothing could be checked automatically" }];
  const checks = effective.map((c) => checkCriterion(c, profile));
  const failed = checks.filter((c) => c.result === "not_met");
  const unknown = checks.filter((c) => c.result === "unknown");
  const evidenceRequired = unknown.map((c) => c.criterion.description);
  if (failed.length > 0) {
    return { verdict: "not_eligible", checks, evidenceRequired: [], summary: `Not eligible: ${failed.map((c) => c.note).join("; ")}` };
  }
  if (unknown.length === 0) {
    return { verdict: "eligible", checks, evidenceRequired: [], summary: "Every requirement matches the owner's profile" };
  }
  const met = checks.length - unknown.length;
  return { verdict: "unverified", checks, evidenceRequired, summary: `${met} of ${checks.length} requirements match the profile; ${unknown.length} need the owner's evidence` };
}

/**
 * Reads the requirements out of a class definition as best it can, for a
 * newly found settlement. Conservative by design: it only adds a `profile`
 * criterion for a trait the owner's profile covers, and turns anything
 * specific to one defendant into an `evidence` criterion.
 */
export function inferCriteria(title: string, classText: string | undefined): Criterion[] {
  const text = `${title}. ${classText ?? ""}`;
  const lower = text.toLowerCase();
  const criteria: Criterion[] = [];
  const add = (c: Criterion): void => {
    if (!criteria.some((x) => x.description === c.description)) criteria.push(c);
  };

  const residents = [...lower.matchAll(/\b([a-z]+(?: [a-z]+)?) (?:state )?residents\b/g)]
    .map((m) => STATE_NAMES[m[1]!] ?? STATE_NAMES[m[1]!.split(" ").pop()!])
    .filter((s): s is string => s !== undefined);
  // Listing titles mark state-limited classes, e.g. "High 5 Games (Washington)".
  const titleState = /\(([a-z]+(?: [a-z]+)?)\)/.exec(title.toLowerCase())?.[1];
  if (titleState && STATE_NAMES[titleState]) residents.push(STATE_NAMES[titleState]!);
  if (residents.length > 0) {
    const states = [...new Set(residents)];
    add({ kind: "residence", states, description: `Resident of ${states.join(" or ")}` });
  }

  if (/data breach|data security incident|(information|data) (was|were|may have been) (exposed|affected|compromised|impacted|accessed)/.test(lower)) {
    add({ kind: "evidence", description: "Your data was in this breach — search mail for the breach notice letter/email and its Class Member ID" });
  }
  if (/\btcpa\b|robocall|telemarket|text message|marketing text|\btexts?\b|phone calls?|prerecorded|autodial/.test(lower)) {
    add({ kind: "profile", fact: "received_robocalls_or_texts", description: "Received robocalls or marketing texts" });
    add({ kind: "evidence", description: "The calls/texts came from this defendant during the class period — find them or the notice (and the phone number it was sent to)" });
  }
  if (/\brent\b|\brented\b|\blease\b|tenant|renter/.test(lower)) {
    add({ kind: "profile", fact: "renter", description: "Rents a home" });
    add({ kind: "evidence", description: "Your rental property/landlord is covered in the class period — check the settlement's property list" });
  }
  if (/\biphone|\bapple\b/.test(lower)) {
    add({ kind: "profile", fact: "iphone_user", description: "Uses an iPhone" });
    if (/iphone \d+/.test(lower)) add({ kind: "evidence", description: "Owned one of the specific iPhone models named in the class definition during the class period" });
  }
  if (/amazon/.test(lower)) {
    add({ kind: "profile", fact: "amazon_shopper", description: "Shops on Amazon" });
    if (/refund|return/.test(lower)) {
      add({ kind: "profile", fact: "amazon_refund_problems", description: "Had an Amazon return with a missing, late or wrong refund" });
      add({ kind: "evidence", description: "Order numbers of the affected returns inside the class period" });
    }
  }
  if (/\bcvs\b/.test(lower)) add({ kind: "profile", fact: "cvs_app_user", description: "Used the CVS website/app" });
  if (/\b(purchased|bought|purchase of|purchasers?)\b/.test(lower) && !/amazon/.test(lower)) {
    add({ kind: "evidence", description: "Bought the product in the class period — count the units and find receipts or order history" });
  }
  if (/\b(employees?|employed|worked|wage|overtime|workers?)\b/.test(lower)) {
    add({ kind: "evidence", description: "Worked for this employer in the class period" });
  }
  if (/\b(account ?holders?|customers?|members?|patients?|subscribers?|policyholders?)\b/.test(lower) && criteria.every((c) => c.kind !== "evidence")) {
    add({ kind: "evidence", description: "Was a customer/member/patient of this defendant in the class period" });
  }
  return criteria;
}
