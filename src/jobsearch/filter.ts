import type { JobRecord, Preferences } from "./records";
import { normalizeCompany, normalizeTitle } from "./normalize";

/**
 * Stage 6: the free filters. Everything here is a string comparison or a
 * number comparison, and it runs before a single token is spent — which is
 * the whole point. Roughly two-thirds of what survives deduplication dies
 * here at zero cost.
 *
 * The rule that needs stating out loud: a posting that does not publish a
 * salary is NOT rejected by the salary floor. It passes, flagged, and the
 * scorer sees that the figure is unknown. Rejecting silent postings would
 * throw away most of the market; assuming they clear the floor would be a
 * guess. Neither is acceptable, so the unknown travels with the record.
 */

export interface FilterOutcome {
  readonly passed: boolean;
  /** Why it was rejected, in words that will appear in the digest. Null when it passed. */
  readonly reason: string | null;
}

const PASSED: FilterOutcome = { passed: true, reason: null };

export function applyFilters(record: JobRecord, prefs: Preferences, now: Date = new Date()): FilterOutcome {
  const title = normalizeTitle(record.title);
  const company = normalizeCompany(record.company);
  const haystack = `${record.title}\n${record.company}\n${record.summary}`.toLowerCase();

  for (const excluded of prefs.companyExclusions) {
    if (company === normalizeCompany(excluded)) {
      return { passed: false, reason: `Company excluded: ${record.company}` };
    }
  }

  for (const excluded of prefs.titleExclusions) {
    if (title.includes(excluded.toLowerCase())) {
      return { passed: false, reason: `Title excluded: matched "${excluded}"` };
    }
  }

  // An empty titles list means "not configured yet" — let everything through
  // rather than silently rejecting the entire market on a blank config file.
  if (prefs.titles.length > 0) {
    const matched = prefs.titles.some((target) => title.includes(normalizeTitle(target)));
    if (!matched) {
      return { passed: false, reason: "Title outside the target cluster" };
    }
  }

  for (const industry of prefs.industryExclusions) {
    if (haystack.includes(industry.toLowerCase())) {
      return { passed: false, reason: `Industry excluded: matched "${industry}"` };
    }
  }

  const locationOutcome = checkLocation(record, prefs);
  if (!locationOutcome.passed) return locationOutcome;

  const regionOutcome = checkRemoteRegion(record, prefs);
  if (!regionOutcome.passed) return regionOutcome;

  const experienceOutcome = checkExperience(record, prefs);
  if (!experienceOutcome.passed) return experienceOutcome;

  const recencyOutcome = checkRecency(record, prefs, now);
  if (!recencyOutcome.passed) return recencyOutcome;

  return checkSalary(record, prefs);
}

function checkLocation(record: JobRecord, prefs: Preferences): FilterOutcome {
  if (!prefs.remoteOnly) return PASSED;
  if (record.locationClass === "remote") return PASSED;

  // A named metro re-admits onsite and hybrid roles in that place.
  if (prefs.metros.length > 0) {
    const place = `${record.rawLocation} ${record.summary.slice(0, 400)}`.toLowerCase();
    if (prefs.metros.some((metro) => place.includes(metro.toLowerCase()))) return PASSED;
  }

  if (record.locationClass === "unknown") {
    return { passed: false, reason: "Location not stated and no remote signal found" };
  }
  return { passed: false, reason: `Not remote (${record.locationClass})` };
}

/**
 * A stricter version of the remote check: not just remote, but remote from
 * the US. Only fires on a posting that actively excludes the US (a specific
 * non-US country/region and no US option) — a bare "Remote" with no country
 * stated passes, the same way an unpublished salary passes the floor. That
 * asymmetry is deliberate: rejecting every unlabeled "Remote" would throw
 * away a large share of US-based postings that simply didn't spell it out.
 */
function checkRemoteRegion(record: JobRecord, prefs: Preferences): FilterOutcome {
  if (!prefs.usRemoteOnly) return PASSED;
  if (record.locationClass !== "remote") return PASSED;
  if (record.remoteRegion !== "non-us") return PASSED;

  return {
    passed: false,
    reason: `Remote, but not eligible from the US (${record.rawLocation || "a specific non-US region"})`,
  };
}

/**
 * Rejects a posting only when its stated experience-years requirement
 * cannot possibly overlap her target band — e.g. a floor/ceiling both
 * configured as [3, 6] rejects a posting that says "8+ years" (min 8 is
 * past the ceiling) and one that says "0-1 years" (max 1 is short of the
 * floor). A posting whose stated range still overlaps the band at all
 * (e.g. "3-8 years" against a [3,6] band) survives — this is an overlap
 * check, not an exact match. A posting that states no years requirement is
 * NEVER rejected: same "don't guess" rule as the salary floor.
 */
function checkExperience(record: JobRecord, prefs: Preferences): FilterOutcome {
  if (prefs.experienceYearsFloor === null && prefs.experienceYearsCeiling === null) return PASSED;
  if (record.experienceYearsMin === null && record.experienceYearsMax === null) return PASSED;

  if (prefs.experienceYearsCeiling !== null && record.experienceYearsMin !== null) {
    if (record.experienceYearsMin > prefs.experienceYearsCeiling) {
      return {
        passed: false,
        reason: `Wants ${record.experienceYearsMin}+ years, above the ${prefs.experienceYearsCeiling}-year ceiling`,
      };
    }
  }

  if (prefs.experienceYearsFloor !== null && record.experienceYearsMax !== null) {
    if (record.experienceYearsMax < prefs.experienceYearsFloor) {
      return {
        passed: false,
        reason: `Wants at most ${record.experienceYearsMax} years, below the ${prefs.experienceYearsFloor}-year floor`,
      };
    }
  }

  return PASSED;
}

/**
 * Rejects a posting only when a post date is actually stated and it's past
 * the age limit. A posting with no stated date passes — the same "don't
 * guess" rule as the salary floor: silence is not evidence of staleness.
 */
function checkRecency(record: JobRecord, prefs: Preferences, now: Date): FilterOutcome {
  if (prefs.maxPostingAgeDays === null) return PASSED;
  if (record.postedAt === null) return PASSED;

  const posted = new Date(record.postedAt);
  if (Number.isNaN(posted.getTime())) return PASSED;

  const ageDays = (now.getTime() - posted.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays <= prefs.maxPostingAgeDays) return PASSED;

  return {
    passed: false,
    reason: `Posted ${Math.floor(ageDays)} days ago, older than the ${prefs.maxPostingAgeDays}-day limit`,
  };
}

function checkSalary(record: JobRecord, prefs: Preferences): FilterOutcome {
  if (prefs.salaryFloor === null) return PASSED;
  // Not stated is not the same as too low. It passes, and the scorer is told.
  if (record.salaryMax === null) return PASSED;
  if (record.salaryMax >= prefs.salaryFloor) return PASSED;

  return {
    passed: false,
    reason: `Stated pay tops out at ${record.salaryMax.toLocaleString()} ${record.salaryCurrency ?? prefs.salaryCurrency}, below the ${prefs.salaryFloor.toLocaleString()} floor`,
  };
}

/** True when the posting published no salary, so the digest can say so rather than implying a figure. */
export function salaryUnknown(record: JobRecord): boolean {
  return record.salaryMin === null && record.salaryMax === null;
}
