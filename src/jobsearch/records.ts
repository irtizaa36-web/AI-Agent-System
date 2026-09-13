/**
 * The three record types the job-search pipeline persists, plus the
 * preferences that drive its deterministic filters.
 *
 * Everything here is pure data. The rules that matter, encoded as types:
 * a salary that was never published is `null`, never a guess; a location we
 * could not classify is `"unknown"`, never optimistically `"remote"`; and a
 * requirement the candidate's resume does not support becomes a named `gap`
 * rather than quietly disappearing.
 */

/** What a Source hands back before any normalization. One posting, as published. */
export interface RawPosting {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
  /** HTML or plain text, exactly as the source returned it. */
  readonly body: string;
  /** ISO date when the source says it was posted, when the source says at all. */
  readonly postedAt: string | null;
  readonly fetchedAt: string;
}

export type LocationClass = "remote" | "hybrid" | "onsite" | "unknown";

/**
 * Which country a *remote* seat has to sit in, when the posting says. Only
 * meaningful when `locationClass` is `"remote"` — an onsite role's country is
 * just its location. `"unspecified"` means the posting named no country at
 * all (a bare "Remote"); it is never treated as `"us"` by assumption, the
 * same way an unpublished salary is never treated as adequate.
 */
export type RemoteRegion = "us" | "non-us" | "unspecified";

/**
 * Where a posting is in the pipeline. Transitions are made by code, never by
 * a model: `seen` on first sight, `filtered` when a deterministic rule
 * rejected it, `scored` once a model has judged it, `shortlisted` above the
 * cutoff. `applied` is only ever set by an explicit human action.
 */
export type JobState = "seen" | "filtered" | "scored" | "shortlisted" | "rejected" | "applied" | "closed";

export type Confidence = "low" | "medium" | "high";

export interface JobSource {
  readonly sourceId: string;
  readonly url: string;
  readonly fetchedAt: string;
}

export interface JobRecord {
  readonly id: string;
  /** SHA-256 over normalized content. The "never re-process a posting" key. */
  readonly contentHash: string;
  /** company + title + location class. The cross-source dedupe key. */
  readonly identityKey: string;
  readonly title: string;
  readonly company: string;
  readonly rawLocation: string;
  readonly locationClass: LocationClass;
  /** Only meaningful when `locationClass` is `"remote"`. See `RemoteRegion`. */
  readonly remoteRegion: RemoteRegion;
  /** `null` means the posting did not state it. Never inferred, never averaged. */
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
  readonly postedAt: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Every place this one role was found. Four entries here means one record, four links. */
  readonly sources: readonly JobSource[];
  readonly applyUrl: string;
  /** Path to the raw body on disk. Deliberately not inlined — raw HTML never enters a prompt. */
  readonly descriptionPath: string;
  /** The trimmed, signal-dense text the scorer actually sees. */
  readonly summary: string;
  readonly state: JobState;
  /** Which deterministic rule rejected it, when one did. */
  readonly filterReason: string | null;
  readonly score: number | null;
  readonly confidence: Confidence | null;
  readonly rationale: string | null;
  /** Requirements the resume does not support. Stated plainly, never papered over. */
  readonly gaps: readonly string[];
}

export type ApplicationStatus =
  | "queued"
  | "materials_ready"
  | "prefilled"
  | "submitted_by_human"
  | "responded"
  | "rejected"
  | "withdrawn";

export interface ApplicationRecord {
  readonly id: string;
  readonly jobId: string;
  /**
   * Never advances to `submitted_by_human` except by an explicit human
   * action in the dashboard. No code path in this repository sets it.
   */
  readonly status: ApplicationStatus;
  readonly appliedAt: string | null;
  readonly resumeVariantPath: string | null;
  readonly coverLetterPath: string | null;
  readonly followUpDueAt: string | null;
  readonly outcome: string | null;
  readonly rejectionReason: string | null;
  readonly notes: readonly string[];
}

export type AtsType = "greenhouse" | "lever" | "ashby" | "feed";

/** Enrichment cached per company, so a role at a known employer costs nothing to enrich. */
export interface CompanyRecord {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly domain: string | null;
  readonly atsType: AtsType | null;
  readonly atsBoardToken: string | null;
  readonly sizeBand: string | null;
  readonly fundingStage: string | null;
  readonly remotePolicy: string | null;
  readonly redFlags: readonly string[];
  readonly onWatchlist: boolean;
  readonly enrichedAt: string | null;
  readonly enrichmentTtlDays: number;
}

/** One entry in config/job-search/watchlist.json. */
export interface WatchlistEntry {
  readonly company: string;
  readonly atsType: AtsType;
  /** Greenhouse/Lever/Ashby board token, or the feed URL for `feed`. */
  readonly boardToken: string;
}

/** config/job-search/preferences.json — the deterministic filters, as data. */
export interface Preferences {
  /** The target title cluster. A posting must match one of these to survive stage 6. */
  readonly titles: readonly string[];
  /** Title substrings that reject outright (e.g. "intern", "vp of"). */
  readonly titleExclusions: readonly string[];
  /** Reject a posting whose stated maximum falls below this. A posting that states nothing is flagged, not rejected. */
  readonly salaryFloor: number | null;
  readonly salaryCurrency: string;
  /** When true, only `remote` postings survive. `metros` then re-admits onsite/hybrid roles in named places. */
  readonly remoteOnly: boolean;
  /** Metro names that re-admit non-remote roles. Empty means remote-only, full stop. */
  readonly metros: readonly string[];
  /**
   * When true, a `remote` posting is rejected if it names a specific
   * non-US country and no US option (`RemoteRegion` `"non-us"`) — e.g.
   * "Remote - India" or "Remote - Netherlands". A posting naming no country
   * at all (`"unspecified"`) is never rejected on this alone: the same
   * "don't guess" rule that applies to an unstated salary applies here.
   * Meaningless when `remoteOnly` is false.
   */
  readonly usRemoteOnly: boolean;
  readonly industryExclusions: readonly string[];
  readonly companyExclusions: readonly string[];
  /** Minimum score to reach the digest's main list. */
  readonly scoreCutoff: number;
  /**
   * Points subtracted from a role's DISPLAY-ORDER rank (never from its
   * stored `score`, and never from whether it clears `scoreCutoff`) when it
   * doesn't state a salary. Nudges pay-transparent roles toward the top of
   * the digest without excluding or re-scoring the rest — per Irtiza's
   * "de-prioritize, don't exclude" call.
   */
  readonly unstatedSalaryRankPenalty: number;
  /** How many roles the digest shows before collapsing the rest into "also seen". */
  readonly digestLimit: number;
  /** Token budget per posting handed to the scorer. */
  readonly postingTokenBudget: number;
  /** How many postings go into one batched scoring call. */
  readonly scoringBatchSize: number;
  /** Model used for batch scoring. */
  readonly scoringModel: string;
  /** Days to keep raw posting bodies on disk before pruning. The JobRecord is kept forever. */
  readonly rawRetentionDays: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  titles: [],
  titleExclusions: ["intern", "internship", "co-op", "contractor", "temporary"],
  salaryFloor: null,
  salaryCurrency: "USD",
  remoteOnly: true,
  metros: [],
  usRemoteOnly: false,
  industryExclusions: [],
  companyExclusions: [],
  scoreCutoff: 65,
  unstatedSalaryRankPenalty: 3,
  digestLimit: 8,
  postingTokenBudget: 600,
  scoringBatchSize: 15,
  scoringModel: "claude-haiku-4-5",
  rawRetentionDays: 90,
};
