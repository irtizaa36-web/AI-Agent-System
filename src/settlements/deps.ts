import { ownerClock } from "./dates";
import { OWNER_PROFILE, type OwnerProfile } from "./eligibility";
import { DEFAULT_SOURCES, type FetchLike, type SettlementSource } from "./research/sources";
import { seedDocument } from "./seed";
import { InMemoryTrackerStorage, type TrackerStorage } from "./storage";
import { SettlementTracker } from "./tracker";
import type { IsoDate } from "./types";

/**
 * Everything the settlements CLI and Tools run against (ADR 0022). Both open
 * the tracker fresh for each command or tool call, so they always see the
 * same file and never a stale copy.
 */
export interface SettlementsDeps {
  openTracker(): Promise<SettlementTracker>;
  readonly fetch: FetchLike;
  readonly sources: readonly SettlementSource[];
  readonly profile: OwnerProfile;
  readonly today: () => IsoDate;
}

export function createSettlementsDeps(opts: {
  readonly storage?: TrackerStorage;
  readonly today?: () => IsoDate;
  readonly fetch?: FetchLike;
  readonly sources?: readonly SettlementSource[];
  readonly profile?: OwnerProfile;
} = {}): SettlementsDeps {
  const storage = opts.storage ?? new InMemoryTrackerStorage();
  const today = opts.today ?? ownerClock();
  return {
    openTracker: () => SettlementTracker.open(storage, { today, seed: seedDocument }),
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    sources: opts.sources ?? DEFAULT_SOURCES,
    profile: opts.profile ?? OWNER_PROFILE,
    today,
  };
}
