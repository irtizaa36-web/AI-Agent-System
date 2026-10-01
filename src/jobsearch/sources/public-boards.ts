import type { Source } from "./source";
import { createRemotiveSource } from "./remotive";
import { createRemoteOkSource } from "./remoteok";
import { createAdzunaSource } from "./adzuna";
import { join } from "node:path";
import { dataDirFor } from "../config";
import { createLinkedInGuestSource, LINKEDIN_GUEST_BREAKER_FILE } from "./linkedin-guest";

/**
 * The public job boards (Remotive, RemoteOK, Adzuna, and LinkedIn's anonymous
 * guest pages — ADR 0028) are marketing-role
 * discovery for Shivani's profile only. The repo's other profile is
 * unrelated gig-platform work (ADR 0017 keeps the two searches' data from
 * ever mixing), so these sources are never attached to it.
 */
const PUBLIC_BOARD_PROFILE_IDS: readonly string[] = ["shivani"];

export interface PublicBoardSources {
  readonly sources: readonly Source[];
  /**
   * True when the Adzuna source was left out because ADZUNA_APP_ID or
   * ADZUNA_APP_KEY is missing — the caller logs the skip line.
   */
  readonly adzunaSkipped: boolean;
}

/**
 * Builds the public board sources for a profile, or an empty set for any
 * profile that hasn't opted into them. Never a half-configured Adzuna: it
 * is silently absent without credentials, the same pattern as the scoring
 * client and the Inkbox source in jobs-commands.ts.
 */
export function createPublicBoardSources(
  profile: string,
  profileTitles: readonly string[] | undefined,
  options: { readonly onWarning?: (message: string) => void; readonly root?: string } = {},
): PublicBoardSources {
  if (!PUBLIC_BOARD_PROFILE_IDS.includes(profile)) {
    return { sources: [], adzunaSkipped: false };
  }
  const titles = profileTitles ?? [];
  const sources: Source[] = [createRemotiveSource(titles), createRemoteOkSource(titles)];
  // Anonymous guest pages only, once per daily run, capped and never retried (ADR 0028).
  // Its circuit-breaker flag lives in the profile's data directory, next to the run history.
  sources.push(
    createLinkedInGuestSource({
      onWarning: options.onWarning,
      breakerPath: join(options.root ?? ".", dataDirFor(profile), LINKEDIN_GUEST_BREAKER_FILE),
    }),
  );
  const adzuna = createAdzunaSource();
  if (adzuna) sources.push(adzuna);
  return { sources, adzunaSkipped: !adzuna };
}
