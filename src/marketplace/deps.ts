import { join } from "node:path";
import { InMemoryMarketplaceStorage, JsonFileMarketplaceStorage, MarketplaceState, seedDocument } from "./state";
import { DEFAULT_CONFIG, loadConfig, type KarenConfig } from "./config";
import { createChannelPollers, type ChannelPoller } from "./channels";

/**
 * Everything the marketplace CLI runs against (ADR 0024). The state opens
 * fresh for each command so every invocation sees the same file — the same
 * instance works for Muse sessions and Claude Code sessions alike.
 */
export interface MarketplaceDeps {
  openState(): Promise<MarketplaceState>;
  now(): string;
  /** Karen config: defaults, overridden by .orchestrator/marketplace/config.json when present. */
  config(): KarenConfig;
  /** Inbound channel pollers (read-only). Injected in tests so no external CLI ever runs. */
  pollers(): ChannelPoller[];
}

export function createMarketplaceDeps(opts: {
  readonly storage?: InMemoryMarketplaceStorage | JsonFileMarketplaceStorage;
  readonly cwd?: string;
  readonly now?: () => string;
  readonly config?: KarenConfig;
  readonly pollers?: () => ChannelPoller[];
} = {}): MarketplaceDeps {
  const cwd = opts.cwd ?? process.cwd();
  const storage = opts.storage ?? new JsonFileMarketplaceStorage(join(cwd, ".orchestrator", "marketplace", "state.json"));
  const now = opts.now ?? (() => new Date().toISOString());
  // Injected storage (tests) never reads a config file from disk.
  const configPath = join(cwd, ".orchestrator", "marketplace", "config.json");
  const config = () => opts.config ?? (opts.storage ? DEFAULT_CONFIG : loadConfig(configPath));
  return {
    openState: () => MarketplaceState.open(storage, { seed: seedDocument, now }),
    now,
    config,
    pollers: opts.pollers ?? (() => createChannelPollers()),
  };
}
