import type { Lead, Listing, OutboxMessage, TrackerDocument } from "./types";

/** Plain-text formatting for CLI output. No raw ids beyond what's needed. */

export function formatStatus(doc: TrackerDocument): string {
  const lines: string[] = ["MARKETPLACE STATUS"];
  lines.push("\nListings (selling):");
  for (const l of doc.listings) {
    const live = doc.leads.filter((x) => x.listingId === l.id && ["new", "contacted", "hold"].includes(x.status)).length;
    const confirmed = doc.leads.filter((x) => x.listingId === l.id && x.status === "confirmed").length;
    lines.push(`  ${l.id} — ${l.title} — $${l.price}${l.priceFirm ? " firm" : ""} — ${l.status} — ${live} live leads, ${confirmed} confirmed`);
  }
  lines.push("\nHunts (buying):");
  for (const c of doc.campaigns) {
    lines.push(`  ${c.name} — ${c.status}${c.cancelledAt ? ` (cancelled ${c.cancelledAt.slice(0, 10)})` : ""} — ${c.threads.length} threads`);
  }
  const pending = doc.outbox.filter((m) => m.status === "pending").length;
  const tap = doc.outbox.filter((m) => m.status === "awaiting-tap").length;
  const bookings = doc.bookings.filter((b) => b.status === "pending-approval").length;
  lines.push(`\nOutbox: ${pending} pending, ${tap} awaiting his tap`);
  if (bookings > 0) lines.push(`Bookings awaiting approval: ${bookings}`);
  return lines.join("\n");
}

export function formatLeads(leads: Lead[], listings: readonly Listing[]): string {
  if (leads.length === 0) return "No leads.";
  return leads
    .map((l) => {
      const listing = listings.find((x) => x.id === l.listingId);
      const bits = [`${l.id} — ${l.name}`, `status: ${l.status}`, `queue: #${l.queuePosition}`, `channel: ${l.channel}`];
      if (l.pickupAt) bits.push(`pickup: ${l.pickupAt}`);
      if (l.holdExpiresAt) bits.push(`hold expires: ${l.holdExpiresAt}`);
      if (!l.needsAgentFollowUp) bits.push("owner-handled");
      return `  ${bits.join(" · ")}${listing ? `\n    listing: ${listing.title} ($${listing.price}${listing.priceFirm ? " firm" : ""})` : ""}`;
    })
    .join("\n");
}

export function formatOutbox(messages: OutboxMessage[]): string {
  if (messages.length === 0) return "Outbox is empty.";
  return messages
    .map((m, i) => [
      `--- message ${i + 1}/${messages.length} [${m.kind}] to ${m.recipient} (${m.channel}, thread ${m.threadId}) ---`,
      m.body,
      "",
    ].join("\n"))
    .join("\n");
}

export function formatListing(l: Listing): string {
  return [
    `${l.id} — ${l.title}`,
    `  kind: ${l.kind} · price: $${l.price}${l.priceFirm ? " firm" : ""} · payment: ${l.payment}`,
    `  meetup: ${l.meetup} · status: ${l.status} · monitoring: ${l.monitoring ? "on" : "off"}`,
    l.fbListingId ? `  fb listing: ${l.fbListingId}` : "  fb listing: not published yet",
  ].join("\n");
}
