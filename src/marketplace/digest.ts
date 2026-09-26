import type { TrackerDocument } from "./types";
import { DEFAULT_CONFIG, type KarenConfig } from "./config";
import { pendingMessages } from "./outbox";
import { watchOnlyThreads } from "./owner_activity";
import { detectStaleListings, planStaleDrops } from "./selling/health";
import { checklistComplete } from "./selling/rental_tree";

/**
 * END-OF-DAY DIGEST (Karen upgrade 7). One structured summary, always the
 * same four sections in the same order:
 *   1. ACTIVE LISTINGS + NEW INQUIRIES
 *   2. NEGOTIATIONS
 *   3. RENTALS
 *   4. ACTION NEEDED
 * Built from state only (ids, statuses, one-line activity) — never message
 * bodies. An empty section says so rather than disappearing.
 */

export interface DigestSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface Digest {
  readonly since: string;
  readonly sections: readonly [DigestSection, DigestSection, DigestSection, DigestSection];
}

export function buildDigest(doc: TrackerDocument, sinceIso: string, nowIso: string, config: KarenConfig = DEFAULT_CONFIG): Digest {
  // 1. Active listings + new inquiries
  const listingLines: string[] = [];
  for (const l of doc.listings.filter((x) => x.status === "active")) {
    const leads = doc.leads.filter((x) => x.listingId === l.id);
    const fresh = leads.filter((x) => x.firstSeenAt >= sinceIso);
    const live = leads.filter((x) => ["new", "contacted", "hold"].includes(x.status)).length;
    const holder = leads.find((x) => x.status === "hold");
    const confirmed = leads.find((x) => x.status === "confirmed");
    const bits = [`$${l.price}${l.kind === "rental" ? "/day" : ""}${l.priceFirm ? " firm" : ""}`, `${live} live lead(s)`, `${fresh.length} new inquiry(ies)`];
    if (confirmed) bits.push(`confirmed: ${confirmed.name}`);
    else if (holder) bits.push(`on hold: ${holder.name}${holder.holdExpiresAt ? ` until ${holder.holdExpiresAt.slice(0, 16)}` : ""}`);
    listingLines.push(`${l.title} — ${bits.join(" · ")}`);
    for (const f of fresh.slice(0, 5)) listingLines.push(`  new: ${f.name} (${f.channel})`);
  }

  // 2. Negotiations
  const negotiationLines = doc.leads
    .filter((l) => l.negotiation)
    .map((l) => {
      const n = l.negotiation!;
      const listing = doc.listings.find((x) => x.id === l.listingId);
      const where = listing ? `"${listing.title}" ($${listing.price}${listing.floorPrice !== undefined ? `, floor $${listing.floorPrice}` : ""})` : l.listingId;
      const state = n.status === "agreed" ? `agreed at $${n.agreedPrice}` : n.status === "escalated" ? "STALLED — escalated to you" : `open, round ${n.rounds}${n.countered ? ", countered at floor" : ""}`;
      return `${l.name} on ${where}: last offer $${n.lastOffer ?? "?"} — ${state}`;
    });

  // 3. Rentals
  const rentalLines: string[] = [];
  for (const b of doc.bookings.filter((x) => x.status !== "cancelled" && x.status !== "returned")) {
    const lead = doc.leads.find((l) => l.id === b.leadId);
    rentalLines.push(`${lead?.name ?? b.leadId}: ${b.status} ${b.pickupDate} → ${b.returnDate} · deposit $${b.deposit.amount} ${b.deposit.paid ? "paid" : "unpaid"}${b.deposit.returned ? ", returned" : ""}`);
  }
  for (const lead of doc.leads.filter((l) => l.rental && !["dead", "confirmed"].includes(l.status))) {
    const c = lead.rental!;
    if (doc.bookings.some((b) => b.leadId === lead.id && b.status !== "cancelled")) continue;
    const missing = [!c.rateAgreed && "rate", !c.depositCommitted && "deposit", !c.pickupTime && "specific time"].filter(Boolean);
    rentalLines.push(`${lead.name}: ${missing.length === 0 ? `ready to book (pickup ${c.pickupTime})` : `waiting on ${missing.join(", ")}`}`);
  }

  // 4. Action needed
  const actionLines: string[] = [];
  for (const a of doc.activity.filter((x) => x.at >= sinceIso && x.kind === "escalation").slice(-10)) actionLines.push(`escalation: ${a.text}`);
  for (const l of doc.leads.filter((x) => x.negotiation?.status === "escalated")) actionLines.push(`negotiation stalled: ${l.name} at $${l.negotiation!.lastOffer} — decide or let it go`);
  for (const b of doc.bookings.filter((x) => x.status === "pending-approval")) {
    const lead = doc.leads.find((l) => l.id === b.leadId);
    actionLines.push(`booking awaiting your tap: ${lead?.name ?? b.leadId} ${b.pickupDate}${checklistComplete(lead?.rental) ? "" : " (checklist incomplete — can't confirm yet)"}`);
  }
  for (const l of doc.leads.filter((x) => x.rental && checklistComplete(x.rental) && !doc.bookings.some((b) => b.leadId === x.id && b.status !== "cancelled"))) {
    actionLines.push(`rental ready to draft: ${l.name}, pickup ${l.rental!.pickupTime}`);
  }
  const pending = pendingMessages(doc).length;
  if (pending > 0) actionLines.push(`outbox: ${pending} message(s) pending your tap`);
  for (const s of detectStaleListings(doc, nowIso)) actionLines.push(`stale: "${s.title}" — ${s.reason} Suggest ${s.action}${s.suggestedPrice !== undefined ? ` → $${s.suggestedPrice}` : ""}`);
  if (!config.staleDrop.enabled) {
    for (const d of planStaleDrops(doc, nowIso, config.staleDrop)) actionLines.push(`auto-drop is OFF — would drop "${d.title}" $${d.from} → $${d.to} (floor $${d.floor})`);
  }
  const watching = watchOnlyThreads(doc, nowIso, config.ownerActivity.watchOnlyMinutes);
  if (watching.length > 0) actionLines.push(`watch-only (you're active): ${watching.length} thread(s)`);
  const parseFailures = doc.activity.filter((x) => x.at >= sinceIso && x.kind === "parse-failure");
  if (parseFailures.length > 0) actionLines.push(`parse failures: ${parseFailures.length} — raw outputs are in the sweep logs`);

  const orNone = (lines: string[], none: string) => (lines.length > 0 ? lines : [none]);
  return {
    since: sinceIso,
    sections: [
      { title: "ACTIVE LISTINGS + NEW INQUIRIES", lines: orNone(listingLines, "No active listings.") },
      { title: "NEGOTIATIONS", lines: orNone(negotiationLines, "No negotiations in progress.") },
      { title: "RENTALS", lines: orNone(rentalLines, "No rentals in progress.") },
      { title: "ACTION NEEDED", lines: orNone(actionLines, "Nothing needs you.") },
    ],
  };
}

export function formatDigest(digest: Digest): string {
  const out = [`MARKETPLACE DIGEST (since ${digest.since})`];
  digest.sections.forEach((s, i) => {
    out.push(`\n${i + 1}. ${s.title}`);
    for (const line of s.lines) out.push(`  ${line}`);
  });
  return out.join("\n");
}
