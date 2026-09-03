import { randomUUID } from "node:crypto";

export type OperationalUpdateProvenance = "human" | "agent" | "external_operator";

export const OPERATIONAL_UPDATE_PROVENANCES: readonly OperationalUpdateProvenance[] = [
  "human",
  "agent",
  "external_operator",
];

/**
 * A concise, authored operational handoff. It records coordination context
 * without changing task state or implying that a recommendation was made.
 */
export interface OperationalUpdate {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly by: string;
  readonly provenance: OperationalUpdateProvenance;
  readonly details?: string;
}

export function createOperationalUpdate(
  summary: string,
  by: string,
  provenance: OperationalUpdateProvenance,
  details?: string,
  id: string = randomUUID(),
  createdAt: string = new Date().toISOString(),
): OperationalUpdate {
  if (summary.trim().length === 0) throw new Error("Operational update summary must not be empty");
  if (by.trim().length === 0) throw new Error("Operational update author must not be empty");
  if (!OPERATIONAL_UPDATE_PROVENANCES.includes(provenance)) throw new Error(`Invalid operational update provenance "${provenance}"`);
  return { id, createdAt, summary, by, provenance, details };
}
