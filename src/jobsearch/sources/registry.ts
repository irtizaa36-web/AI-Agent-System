import type { WatchlistEntry } from "../records";
import type { Source } from "./source";
import { createGreenhouseSource } from "./greenhouse";
import { createLeverSource } from "./lever";
import { createAshbySource } from "./ashby";
import { createFeedSource } from "./feed";

/**
 * Turns config/job-search/watchlist.json into live Sources. Adding a company
 * to the watchlist is a config edit, never a code change — which is the
 * point: the person who knows which employers matter is not the person who
 * writes TypeScript.
 */
export function sourcesFromWatchlist(entries: readonly WatchlistEntry[]): readonly Source[] {
  return entries.map((entry) => {
    switch (entry.atsType) {
      case "greenhouse":
        return createGreenhouseSource(entry.company, entry.boardToken);
      case "lever":
        return createLeverSource(entry.company, entry.boardToken);
      case "ashby":
        return createAshbySource(entry.company, entry.boardToken);
      case "feed":
        return createFeedSource(entry.company, entry.boardToken);
      default: {
        const exhaustive: never = entry.atsType;
        throw new Error(`Unknown ATS type in watchlist: ${String(exhaustive)}`);
      }
    }
  });
}
