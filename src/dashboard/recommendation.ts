import { randomUUID } from "node:crypto";

/**
 * One entry in the dashboard's own "what I noticed, what I did about it"
 * feed — to itself, to the coworker system, or to a project it observes.
 * Per the autonomy this project runs under, most recommendations are
 * implemented directly rather than left pending; `implemented` still
 * exists for the rare case something is noticed but deliberately not acted
 * on yet (e.g. it needs the user's say-so first).
 */
export interface Recommendation {
  readonly id: string;
  readonly createdAt: string;
  /** What this is about — "dashboard", "system" (the coworker loop itself), or a project/task name. */
  readonly scope: string;
  readonly summary: string;
  readonly implemented: boolean;
  readonly implementedAt?: string;
  /** What was actually changed, once implemented. */
  readonly details?: string;
}

export function createRecommendation(
  scope: string,
  summary: string,
  id: string = randomUUID(),
  createdAt: string = new Date().toISOString(),
): Recommendation {
  if (summary.trim().length === 0) {
    throw new Error("Recommendation summary must not be empty");
  }
  if (scope.trim().length === 0) {
    throw new Error("Recommendation scope must not be empty");
  }
  return { id, createdAt, scope, summary, implemented: false };
}

export function withImplemented(recommendation: Recommendation, details?: string): Recommendation {
  return { ...recommendation, implemented: true, implementedAt: new Date().toISOString(), details };
}
