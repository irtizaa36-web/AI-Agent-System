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

/**
 * Which entry of `locationPriority` a role matches, or -1 if none. Checked
 * in list order, so if "Houston" comes before "Remote" in her list, a role
 * that's both — a remote seat explicitly for Houston — matches "Houston"
 * first and gets the higher-priority tier, since it satisfies her top
 * choice AND happens to be remote.
 */
function locationPriorityTier(record: JobRecord, priority: readonly string[]): number {
  return priority.findIndex((entry) => {
    if (entry.toLowerCase() === "remote") return record.locationClass === "remote";
    return record.rawLocation.toLowerCase().includes(entry.toLowerCase());
  });
}

/** Points added for matching an earlier (more preferred) entry in `locationPriority`. Zero for no match or an empty list. */
export function locationBonus(record: JobRecord, prefs: Preferences): number {
  if (prefs.locationPriority.length === 0) return 0;
  const tier = locationPriorityTier(record, prefs.locationPriority);
  if (tier === -1) return 0;
  return (prefs.locationPriority.length - 1 - tier) * prefs.locationPriorityStep;
}

/** The key roles are sorted by. Higher sorts first. Never persisted, never shown — display order only. */
export function rankKey(record: JobRecord, prefs: Preferences): number {
  const penalty = salaryUnknown(record) ? prefs.unstatedSalaryRankPenalty : 0;
  return (record.score ?? 0) - penalty + locationBonus(record, prefs);
}

/** Stable sort by rank key, highest first. Ties keep their original relative order. */
export function sortByRank(records: readonly JobRecord[], prefs: Preferences): readonly JobRecord[] {
  return [...records]
    .map((record, index) => ({ record, index, key: rankKey(record, prefs) }))
    .sort((left, right) => right.key - left.key || left.index - right.index)
    .map((entry) => entry.record);
}
