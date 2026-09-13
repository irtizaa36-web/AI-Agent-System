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

export function applyFilters(record: JobRecord, prefs: Preferences): FilterOutcome {
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
