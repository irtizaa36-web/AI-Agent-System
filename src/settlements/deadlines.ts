import { daysUntil, earliest } from "./dates";
import { OPEN_STATUSES, type ActionItem, type IsoDate, type NudgeRecord, type Settlement } from "./types";

/**
 * The deadline engine (ADR 0022). Pure functions over the tracker's data:
 * how many days are left, which reminder is due, and whether it was already
 * sent. Nothing here changes a settlement's status — a passed deadline is
 * shown as overdue, never silently turned into "dropped".
 */

/** Days-left marks at which the owner gets one nudge each. */
export const NUDGE_THRESHOLDS: readonly number[] = [14, 7, 3, 1];

/**
 * The date to act by. When sources disagree, the earliest wins — filing a
 * week early costs nothing; filing a day late costs the claim.
 */
export function effectiveDeadline(s: Pick<Settlement, "deadline" | "deadlineConflicts">): IsoDate | undefined {
  const dates = [s.deadline?.date, ...s.deadlineConflicts.map((c) => c.date)].filter((d): d is IsoDate => d !== undefined);
  return earliest(dates);
}

export type Urgency = "overdue" | "today" | "critical" | "soon" | "upcoming" | "later" | "no_deadline";

export function urgencyOf(daysLeft: number | undefined): Urgency {
  if (daysLeft === undefined) return "no_deadline";
  if (daysLeft < 0) return "overdue";
  if (daysLeft === 0) return "today";
  if (daysLeft <= 3) return "critical";
  if (daysLeft <= 7) return "soon";
  if (daysLeft <= 14) return "upcoming";
  return "later";
}

export interface DeadlineRow {
  readonly settlement: Settlement;
  readonly deadline?: IsoDate;
  readonly daysLeft?: number;
  readonly urgency: Urgency;
  readonly openActions: readonly ActionItem[];
  readonly conflicting: boolean;
}

/** Open settlements (researching / ready to file), soonest first; no-deadline items last. */
export function deadlineRows(settlements: readonly Settlement[], today: IsoDate, opts: { includeClosed?: boolean } = {}): DeadlineRow[] {
  return settlements
    .filter((s) => opts.includeClosed || OPEN_STATUSES.has(s.status))
    .map((s) => {
      const deadline = effectiveDeadline(s);
      const daysLeft = deadline === undefined ? undefined : daysUntil(deadline, today);
      const conflicting = s.deadlineConflicts.some((c) => c.date !== s.deadline?.date);
      return { settlement: s, ...(deadline ? { deadline } : {}), ...(daysLeft !== undefined ? { daysLeft } : {}), urgency: urgencyOf(daysLeft), openActions: s.actions.filter((a) => !a.done), conflicting };
    })
    .sort((a, b) => (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY) || a.settlement.name.localeCompare(b.settlement.name));
}

export interface Nudge {
  readonly key: string;
  readonly settlement: Settlement;
  readonly threshold: number;
  readonly deadline: IsoDate;
  readonly daysLeft: number;
  readonly openActions: readonly ActionItem[];
}

/**
 * The key includes the deadline, so an extended deadline starts a fresh set
 * of nudges while the same deadline never nudges twice at the same mark.
 */
export function nudgeKey(settlementId: string, deadline: IsoDate, threshold: number): string {
  return `${settlementId}|${deadline}|${threshold}d`;
}

/**
 * Which nudges are due today and not yet sent. If several marks were crossed
 * since the last check (say, nothing ran for a week), only the tightest one
 * fires — the owner gets one accurate reminder, not a burst of stale ones.
 * Overdue items get no nudge; they show up as overdue in every review.
 */
export function dueNudges(settlements: readonly Settlement[], sent: readonly NudgeRecord[], today: IsoDate): Nudge[] {
  const sentKeys = new Set(sent.map((n) => n.key));
  const nudges: Nudge[] = [];
  for (const row of deadlineRows(settlements, today)) {
    if (row.deadline === undefined || row.daysLeft === undefined || row.daysLeft < 0) continue;
    const crossed = NUDGE_THRESHOLDS.filter((t) => row.daysLeft! <= t);
    if (crossed.length === 0) continue;
    const threshold = Math.min(...crossed);
    const key = nudgeKey(row.settlement.id, row.deadline, threshold);
    // A tighter mark already sent for this deadline also covers this one.
    const tighterSent = NUDGE_THRESHOLDS.some((t) => t < threshold && sentKeys.has(nudgeKey(row.settlement.id, row.deadline!, t)));
    if (sentKeys.has(key) || tighterSent) continue;
    nudges.push({ key, settlement: row.settlement, threshold, deadline: row.deadline, daysLeft: row.daysLeft, openActions: row.openActions });
  }
  return nudges;
}

export function toNudgeRecord(nudge: Nudge, sentOn: IsoDate): NudgeRecord {
  return { key: nudge.key, settlementId: nudge.settlement.id, threshold: nudge.threshold, deadline: nudge.deadline, sentOn };
}
