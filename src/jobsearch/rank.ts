import type { JobRecord, Preferences } from "./records";
import { salaryUnknown } from "./filter";

/**
 * Stage 9's ordering rule, kept separate from the score itself on purpose.
 *
 * `JobRecord.score` is the model's honest judgment of fit and never changes
 * after scoring — it's what gets shown, and what `scoreCutoff` compares
 * against. This module answers a different question: given two roles that
 * already cleared the cutoff, which shows up first? A role with no stated
 * salary is nudged down the display order, not excluded and not re-scored —
 * "de-prioritize, don't exclude."
 */

/** The key roles are sorted by. Higher sorts first. Never persisted, never shown — display order only. */
export function rankKey(record: JobRecord, prefs: Preferences): number {
  const penalty = salaryUnknown(record) ? prefs.unstatedSalaryRankPenalty : 0;
  return (record.score ?? 0) - penalty;
}

/** Stable sort by rank key, highest first. Ties keep their original relative order. */
export function sortByRank(records: readonly JobRecord[], prefs: Preferences): readonly JobRecord[] {
  return [...records]
    .map((record, index) => ({ record, index, key: rankKey(record, prefs) }))
    .sort((left, right) => right.key - left.key || left.index - right.index)
    .map((entry) => entry.record);
}
