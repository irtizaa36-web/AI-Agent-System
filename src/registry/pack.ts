import type { Registry } from "./registry";

/**
 * A self-contained bundle of Agent definitions (and, later, domain-specific
 * Tools) for one product or domain — e.g. a future "im-brain" or
 * "ai-research" pack. A Pack is the seam between this reusable engine and
 * any domain-specific content built on top of it: the engine loads whichever
 * Packs are enabled without ever knowing what's inside them.
 */
export interface Pack {
  readonly name: string;
  register(registry: Registry): void;
}
