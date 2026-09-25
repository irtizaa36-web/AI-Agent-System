import { daysUntil } from "./dates";
import type { Evaluation } from "./eligibility";
import { parsePayout, rankingValue } from "./payout";
import type { IsoDate, Verdict } from "./types";

/**
 * Priority for the owner's attention, 0–100: is it plausibly his, is it worth
 * money, is time short, and how much digging it needs. It orders a list; it
 * is not a prediction and is never shown as a payout.
 */

export interface PriorityInput {
  readonly verdict: Verdict;
  readonly evaluation?: Evaluation;
  readonly payoutText?: string;
  readonly deadline?: IsoDate;
  readonly proofRequired?: boolean;
  readonly today: IsoDate;
}

export interface Priority {
  readonly score: number;
  readonly parts: { readonly fit: number; readonly value: number; readonly urgency: number; readonly effort: number };
}

const VERDICT_FIT: Readonly<Record<Verdict, number>> = { eligible: 1, unverified: 0.6, not_eligible: 0 };

export function priority(input: PriorityInput): Priority {
  const checks = input.evaluation?.checks ?? [];
  const metShare = checks.length === 0 ? 0 : checks.filter((c) => c.result === "met").length / checks.length;
  // Among unverified items, more profile matches means a better bet.
  const fit = input.verdict === "unverified" ? VERDICT_FIT.unverified + 0.3 * metShare : VERDICT_FIT[input.verdict];

  const dollars = rankingValue(parsePayout(input.payoutText));
  const value = Math.min(1, Math.log10(1 + dollars) / Math.log10(1 + 500));

  let urgency = 0.5;
  if (input.deadline !== undefined) {
    const days = daysUntil(input.deadline, input.today);
    urgency = days < 0 ? 0 : days <= 14 ? 1 : Math.max(0.3, 1 - ((days - 14) / 106) * 0.7);
  }

  const unknowns = input.evaluation?.evidenceRequired.length ?? 1;
  const effort = Math.max(0, 1 - 0.15 * unknowns - (input.proofRequired ? 0.3 : 0));

  const raw = fit === 0 || urgency === 0 ? 0 : fit * (0.45 * value + 0.35 * urgency + 0.2 * effort);
  return { score: Math.round(Math.min(1, raw) * 100), parts: { fit, value, urgency, effort } };
}
