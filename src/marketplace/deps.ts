import { join } from "node:path";
import { InMemoryMarketplaceStorage, JsonFileMarketplaceStorage, MarketplaceState, seedDocument } from "./state";

/**
 * Everything the marketplace CLI runs against (ADR 0024). The state opens
 * fresh for each command so every invocation sees the same file — the same
 * instance works for Muse sessions and Claude Code sessions alike.
 */
export interface MarketplaceDeps {
  openState(): Promise<MarketplaceState>;
  now(): string;
}

export function createMarketplaceDeps(opts: {
  readonly storage?: InMemoryMarketplaceStorage | JsonFileMarketplaceStorage;
  readonly cwd?: string;
  readonly now?: () => string;
} = {}): MarketplaceDeps {
  const cwd = opts.cwd ?? process.cwd();
  const storage = opts.storage ?? new JsonFileMarketplaceStorage(join(cwd, ".orchestrator", "marketplace", "state.json"));
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    openState: () => MarketplaceState.open(storage, { seed: seedDocument, now }),
    now,
  };
}
