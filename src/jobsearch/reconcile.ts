import type { JobRecord, Preferences } from "./records";
import { applyFilters } from "./filter";

/**
 * Stage 6 runs once per posting, the first time it is ever seen. Dedupe
 * (stage 4-5) then treats anything already in the store as known forever —
 * by design, so a role cross-posted to four boards collapses to one record
 * instead of re-scoring itself four times. The cost of that design: a
 * currently-open req that was wrongly rejected under an old title matcher,
 * salary floor, or age window stays rejected on every future run too, even
 * after the rule that rejected it is fixed or loosened. Nothing else in the
 * pipeline ever re-checks a `filtered` record against today's rules.
 *
 * This is the explicit, occasional exception: re-run the free filters over
 * everything currently `filtered`, using whatever `prefs` says right now.
 * Only the verdict that changes matters — a record that still fails keeps
 * its filtered state, refreshed with today's reason so the digest histogram
 * stays honest even when the specific wording shifted.
 */

export interface ReconcileResult {
  /** Previously filtered, now passes — ready for scoring. */
  readonly rescued: readonly JobRecord[];
  /** Still filtered, with filterReason refreshed against current prefs. */
  readonly stillFiltered: readonly JobRecord[];
}

export function reconcileFiltered(
  records: readonly JobRecord[],
  prefs: Preferences,
  now: Date = new Date(),
): ReconcileResult {
  const rescued: JobRecord[] = [];
  const stillFiltered: JobRecord[] = [];

  for (const record of records) {
    if (record.state !== "filtered") continue;

    const outcome = applyFilters(record, prefs, now);
    if (outcome.passed) {
      rescued.push({ ...record, state: "seen", filterReason: null });
    } else {
      stillFiltered.push(outcome.reason === record.filterReason ? record : { ...record, filterReason: outcome.reason });
    }
  }

  return { rescued, stillFiltered };
}
