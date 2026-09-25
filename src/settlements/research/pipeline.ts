import { daysUntil } from "../dates";
import { effectiveDeadline } from "../deadlines";
import { evaluate, inferCriteria, OWNER_PROFILE, type Evaluation, type OwnerProfile } from "../eligibility";
import { domainOf, identityKeys, isSameListing, slugify, type Identity } from "../matching";
import { priority, type Priority } from "../scoring";
import type { SettlementTracker } from "../tracker";
import type { Candidate, DatedFact, SourceRef } from "../types";
import { readSource, type FetchLike, type Listing, type SettlementSource, type SourceReport } from "./sources";

/**
 * The research sweep (ADR 0022): read every source, merge listings that are
 * the same settlement, and sort each into one bucket — on the permanent
 * do-not-research list, already tracked, reported before, expired, or new.
 * Only new ones reach the owner, ranked, with their eligibility evaluated.
 * New candidates go to the research inbox; only the owner can move one into
 * the tracker.
 */

export interface RankedCandidate {
  readonly candidate: Candidate;
  readonly evaluation: Evaluation;
  readonly priority: Priority;
  readonly proofRequired: boolean;
}

export interface SweepResult {
  readonly reports: readonly SourceReport[];
  readonly fresh: readonly RankedCandidate[];
  readonly tracked: readonly { readonly settlementId: string; readonly name: string; readonly newDeadlineConflict?: DatedFact }[];
  readonly blocked: readonly { readonly name: string; readonly blockedBy: string; readonly reason: string }[];
  readonly alreadySeen: number;
  readonly expired: number;
}

interface Cluster {
  readonly listings: Listing[];
}

function identityOfListing(l: Listing): Identity {
  const domain = l.website ? domainOf(l.website) : undefined;
  return { names: [l.title], domains: domain ? [domain] : [] };
}

/** Groups listings that are the same settlement. Two listings from one source are never merged. */
export function clusterListings(listings: readonly Listing[]): Listing[][] {
  const clusters: Cluster[] = [];
  for (const listing of listings) {
    const home = clusters.find((c) => c.listings.every((m) => m.source !== listing.source) && c.listings.some((m) => isSameListing(identityOfListing(m), identityOfListing(listing))));
    if (home) home.listings.push(listing);
    else clusters.push({ listings: [listing] });
  }
  return clusters.map((c) => c.listings);
}

function clusterIdentity(cluster: readonly Listing[]): Identity {
  const ids = cluster.map(identityOfListing);
  return { names: ids.flatMap((i) => i.names), domains: [...new Set(ids.flatMap((i) => i.domains))] };
}

export function toCandidate(cluster: readonly Listing[], today: string, id: string): Candidate {
  const ref = (l: Listing): SourceRef => ({ label: l.source, url: l.sourceUrl, retrievedOn: today });
  // The shortest title is usually the cleanest name ("VSL Pharmaceuticals - Probiotics").
  const name = [...cluster].sort((a, b) => a.title.length - b.title.length)[0]!.title;
  const dated = cluster.filter((l) => l.deadline).map((l): DatedFact => ({ date: l.deadline!, source: ref(l) }));
  const sortedDates = [...dated].sort((a, b) => a.date.localeCompare(b.date));
  const deadline = sortedDates[0];
  const conflicts = sortedDates.filter((d) => d.date !== deadline?.date).filter((d, i, all) => all.findIndex((x) => x.date === d.date) === i);
  const payoutFrom = cluster.find((l) => l.payoutText);
  const eligibilityText = cluster.map((l) => l.eligibilityText).filter((t): t is string => !!t).sort((a, b) => b.length - a.length)[0];
  const proofText = cluster.find((l) => l.proofText)?.proofText;
  const website = cluster.find((l) => l.website)?.website;
  const claimUrl = cluster.find((l) => l.claimUrl)?.claimUrl;
  return {
    id,
    name,
    sources: cluster.map(ref),
    domains: clusterIdentity(cluster).domains,
    deadlineConflicts: conflicts,
    criteria: inferCriteria(name, eligibilityText),
    firstSeen: today,
    ...(deadline ? { deadline } : {}),
    ...(payoutFrom ? { payout: { text: payoutFrom.payoutText!, source: ref(payoutFrom) } } : {}),
    ...(eligibilityText ? { eligibilityText } : {}),
    ...(proofText ? { proofText } : {}),
    ...(website ? { website } : {}),
    ...(claimUrl ? { claimUrl } : {}),
  };
}

export function rankCandidate(candidate: Candidate, today: string, proofRequired: boolean, profile: OwnerProfile = OWNER_PROFILE): RankedCandidate {
  const evaluation = evaluate(candidate.criteria, profile);
  const deadline = effectiveDeadline(candidate);
  return {
    candidate,
    evaluation,
    proofRequired,
    priority: priority({ verdict: evaluation.verdict, evaluation, today, proofRequired, ...(candidate.payout ? { payoutText: candidate.payout.text } : {}), ...(deadline ? { deadline } : {}) }),
  };
}

export interface SweepDeps {
  readonly tracker: SettlementTracker;
  readonly fetch: FetchLike;
  readonly sources: readonly SettlementSource[];
  readonly profile?: OwnerProfile;
}

export async function runResearchSweep(deps: SweepDeps): Promise<SweepResult> {
  const { tracker } = deps;
  const today = tracker.todayDate();
  const read = await Promise.all(deps.sources.map((s) => readSource(s, deps.fetch)));
  const clusters = clusterListings(read.flatMap((r) => r.listings));

  const fresh: RankedCandidate[] = [];
  const freshKeys: string[] = [];
  const tracked: { settlementId: string; name: string; newDeadlineConflict?: DatedFact }[] = [];
  const blocked: { name: string; blockedBy: string; reason: string }[] = [];
  let alreadySeen = 0;
  let expired = 0;
  const usedIds = new Set([...tracker.inbox().map((c) => c.id)]);

  for (const cluster of clusters) {
    const identity = clusterIdentity(cluster);
    const block = tracker.blockedBy(identity);
    if (block) {
      blocked.push({ name: cluster[0]!.title, blockedBy: block.name, reason: block.reason });
      continue;
    }
    let id = `c-${slugify(identity.names[0]!)}`;
    for (let n = 2; usedIds.has(id); n++) id = `c-${slugify(identity.names[0]!)}-${n}`;
    const candidate = toCandidate(cluster, today, id);

    const existing = tracker.trackedAs(identity);
    if (existing) {
      // A source disagreeing with a tracked deadline is recorded for the owner, never applied.
      let newDeadlineConflict: DatedFact | undefined;
      for (const fact of [candidate.deadline, ...candidate.deadlineConflicts]) {
        if (fact && fact.date !== existing.deadline?.date && (await tracker.noteDeadlineConflict(existing.id, fact))) newDeadlineConflict ??= fact;
      }
      tracked.push({ settlementId: existing.id, name: existing.name, ...(newDeadlineConflict ? { newDeadlineConflict } : {}) });
      continue;
    }
    const deadline = effectiveDeadline(candidate);
    if (deadline && daysUntil(deadline, today) < 0) {
      expired++;
      continue;
    }
    const keys = identityKeys(identity);
    if (tracker.hasSeen(keys)) {
      alreadySeen++;
      continue;
    }
    usedIds.add(id);
    freshKeys.push(...keys);
    fresh.push(rankCandidate(candidate, today, cluster.some((l) => l.proofRequired === true), deps.profile));
  }

  fresh.sort((a, b) => b.priority.score - a.priority.score || a.candidate.name.localeCompare(b.candidate.name));
  await tracker.recordCandidates(
    fresh.map((f) => f.candidate),
    freshKeys,
  );
  return { reports: read.map((r) => r.report), fresh, tracked, blocked, alreadySeen, expired };
}
