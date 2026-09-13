/**
 * Per-source health. A source that breaks gets reported in the digest and
 * skipped; it never takes the run down with it.
 *
 * This is the difference between a pipeline that quietly stops working one
 * Tuesday and one that says "Greenhouse board `acme` returned HTTP 404 on
 * both attempts" at the bottom of the morning digest.
 */

export type SourceState = "ok" | "empty" | "degraded";

export interface SourceHealth {
  readonly sourceId: string;
  readonly state: SourceState;
  readonly postingCount: number;
  readonly error: string | null;
  readonly checkedAt: string;
}

export function healthy(sourceId: string, postingCount: number, checkedAt: string): SourceHealth {
  return {
    sourceId,
    // Zero postings is not a failure — a small company may genuinely have no
    // openings — but it is worth seeing, because it also looks exactly like a
    // board token that has silently gone stale.
    state: postingCount === 0 ? "empty" : "ok",
    postingCount,
    error: null,
    checkedAt,
  };
}

export function degraded(sourceId: string, error: unknown, checkedAt: string): SourceHealth {
  return {
    sourceId,
    state: "degraded",
    postingCount: 0,
    error: error instanceof Error ? error.message : String(error),
    checkedAt,
  };
}

export function summarizeHealth(health: readonly SourceHealth[]): string {
  const broken = health.filter((entry) => entry.state === "degraded");
  const empty = health.filter((entry) => entry.state === "empty");
  const ok = health.length - broken.length - empty.length;

  const parts = [`${ok} healthy`];
  if (empty.length > 0) parts.push(`${empty.length} returned nothing`);
  if (broken.length > 0) parts.push(`${broken.length} broken`);
  return parts.join(", ");
}
