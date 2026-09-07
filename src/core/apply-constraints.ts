import type { AgentDefinition } from "./agent";

/**
 * Returns a copy of `agent` with `constraintsBlock` prepended to its system
 * prompt. Pure and I/O-free by design — Core stays free of how constraints
 * are stored (see store/constraints-store.ts); callers load the text and
 * hand it in. Passing an empty string is a no-op, so callers can always
 * call this unconditionally.
 */
export function applyConstraints(agent: AgentDefinition, constraintsBlock: string): AgentDefinition {
  if (constraintsBlock.length === 0) return agent;
  return { ...agent, systemPrompt: `${constraintsBlock}${agent.systemPrompt}` };
}
