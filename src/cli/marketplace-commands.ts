import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CliDeps } from "./index";
import { createMarketplaceDeps, type MarketplaceDeps } from "../marketplace/deps";
import { InMemoryMarketplaceStorage } from "../marketplace/state";
import { formatLeads, formatListing, formatOutbox, formatStatus } from "../marketplace/format";
import { renderTemplate, templateNames } from "../marketplace/templates";
import { stageMessage, pendingMessages, flushOutbox, recordSent } from "../marketplace/outbox";
import { advanceExpiredHolds, confirmLead, holdLead, markSold, queueFor } from "../marketplace/selling/queue";
import { createListing, setListingStatus, attachFbListingId } from "../marketplace/selling/listings";
import { requestBooking, approveBooking, bookingsFor } from "../marketplace/selling/rentals";
import { loadSidecar, validateIntake, buildIntakeDraft, approvalSummary, publishApproved, messengerCheckRunner, resolveIntakePrice } from "../marketplace/selling/intake";
import { startHunt, pauseHunt, cancelHunt, detectSellerAcceptance } from "../marketplace/buying/hunts";
import { createChannelPollers, pollAll, dedupe, matchLead, updateWatermarks, filterByWatermark, type LeadEvent } from "../marketplace/channels";
import { reconcileOwnerActivity, OWNER_FB_ID } from "../marketplace/owner_activity";
import { screenInbound } from "../marketplace/scam";
import { isLogisticsHandoff, escalate, AuthorityError } from "../marketplace/policy";
import { dueNudges, sendDueNudges } from "../marketplace/selling/nudge";
import { detectStaleListings, retireMissingListings } from "../marketplace/selling/health";
import { recordReliability, detectLowballOffer, buyerScore } from "../marketplace/selling/reliability";
import { rollSummaries } from "../marketplace/summarize";
import { logActivity } from "../marketplace/state";

/**
 * `orchestrator marketplace selling|buying|channels ...` (ADR 0024).
 *
 * Two mechanisms: SELLING (inbound: listings, queues, confirmations,
 * rentals) and BUYING (outbound: hunts, outreach, offers). Read-only
 * commands never send. Anything outbound is staged in the outbox and
 * flushed in spurts for his approval-card taps — the CLI itself never
 * sends a Messenger message.
 */

class UsageError extends Error {}

interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], m: MarketplaceDeps, deps: CliDeps): Promise<void>;
}

function parse<T extends ParseArgsConfig["options"]>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function req(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`${flag} is required.`);
  return value;
}

function kvPairs(values: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of values ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new UsageError(`--set expects key=value, got "${pair}".`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function withState<T>(m: MarketplaceDeps, fn: (doc: import("../marketplace/types").TrackerDocument) => Promise<{ doc: import("../marketplace/types").TrackerDocument; value: T }>): Promise<T> {
  const state = await m.openState();
  const { doc, value } = await fn(state.document);
  await state.update(() => doc);
  return value;
}

const SELLING: readonly Command[] = [
  {
    name: "status",
    usage: "marketplace selling status",
    summary: "Listings, queues, hunts, outbox counts (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      deps.stdout(formatStatus(state.document));
    },
  },
  {
    name: "leads",
    usage: "marketplace selling leads --listing <id>",
    summary: "Show the buyer queue for a listing (read-only).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" } });
      const state = await m.openState();
      const doc = state.document;
      const listingId = req(values.listing, "--listing");
      deps.stdout(formatLeads(queueFor(doc, listingId), doc.listings));
    },
  },
  {
    name: "confirm",
    usage: "marketplace selling confirm <lead-id> --pickup <iso-datetime> [--listing <id>]",
    summary: "Confirm a sale at the listed price (autonomous); stages the pickup message.",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { listing: { type: "string" }, pickup: { type: "string" } });
      const leadId = req(positionals[0], "<lead-id>");
      const pickupAt = req(values.pickup, "--pickup");
      await withState(m, async (doc) => {
        const found = doc.leads.find((l) => l.id === leadId);
        if (!found) throw new UsageError(`Unknown lead "${leadId}".`);
        const listingId = values.listing ?? found.listingId;
        const listing = doc.listings.find((l) => l.id === listingId);
        if (!listing) throw new UsageError(`Unknown listing "${listingId}".`);
        const { doc: d1, lead } = confirmLead(doc, listingId, leadId, { pickupAt }, m.now());
        const body = renderTemplate(d1, "pickup-confirm", {
          name: lead.name,
          pickupTime: pickupAt,
          price: listing.price,
          payment: listing.payment,
          meetup: listing.meetup,
        });
        const { doc: d2, message } = stageMessage(d1, {
          kind: "confirmation",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId,
          leadId,
        }, m.now());
        deps.stdout(`Confirmed ${lead.name} at $${listing.price}${listing.priceFirm ? " firm" : ""}, pickup ${pickupAt}. Confirmation staged in outbox (id ${message.id}).`);
        const d3 = recordReliability(d2, lead.name, lead.threadId, "completed", m.now());
        const d4 = logActivity(d3, "confirmation", `Confirmed ${lead.name} at $${listing.price} for "${listing.title}" (pickup ${pickupAt}).`, m.now());
        return { doc: d4, value: undefined };
      });
    },
  },
  {
    name: "reply",
    usage: "marketplace selling reply <lead-id> --template <name> [--set k=v ...]",
    summary: "Render a template for a lead and stage it in the outbox (never sends).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { template: { type: "string" }, set: { type: "string", multiple: true } });
      const leadId = req(positionals[0], "<lead-id>");
      const template = req(values.template, "--template");
      await withState(m, async (doc) => {
        const lead = doc.leads.find((l) => l.id === leadId);
        if (!lead) throw new UsageError(`Unknown lead "${leadId}".`);
        const listing = doc.listings.find((l) => l.id === lead.listingId)!;
        const ctx = {
          name: lead.name,
          item: listing.title,
          price: listing.price,
          payment: listing.payment,
          meetup: listing.meetup,
          ...kvPairs(values.set),
        };
        const body = renderTemplate(doc, template, ctx);
        const { doc: d2, message } = stageMessage(doc, {
          kind: "reply",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId: lead.listingId,
          leadId,
        }, m.now());
        deps.stdout(`Staged reply to ${lead.name} (outbox id ${message.id}):\n${body}`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "intake",
    usage: "marketplace selling intake --photos <p...> --sidecar <draft.json> [--approve] [--title T] [--price N] [--condition C] [--category G] [--obo] [--no-comps]",
    summary: "Photo-first intake: pull live comps for auto-pricing, print the one-tap approval summary, publish on --approve.",
    async run(args, m, deps) {
      const { values } = parse(args, {
        photos: { type: "string", multiple: true },
        sidecar: { type: "string" },
        approve: { type: "boolean", default: false },
        title: { type: "string" },
        price: { type: "string" },
        condition: { type: "string" },
        category: { type: "string" },
        obo: { type: "boolean", default: false },
        "no-comps": { type: "boolean", default: false },
      });
      const photos = values.photos ?? [];
      const sidecar = loadSidecar(req(values.sidecar, "--sidecar"));
      // Comp-based auto-pricing: live comps propose the price unless he pinned one.
      const comp = values["no-comps"] || values.price
        ? { price: sidecar.suggestedPrice, compBasis: "skipped — price pinned by sidecar/--price", fromComps: false as const }
        : await resolveIntakePrice(sidecar);
      const overrides = {
        title: values.title,
        price: values.price ? Number(values.price) : (comp.fromComps ? comp.price : undefined),
        condition: values.condition,
        category: values.category,
        obo: values.obo || undefined,
      };
      const { errors, warnings } = validateIntake(photos, sidecar, overrides);
      for (const w of warnings) deps.stderr(`warning: ${w}`);
      if (errors.length > 0) {
        deps.stderr(`intake blocked:\n- ${errors.join("\n- ")}`);
        throw new UsageError("Fix the blockers above and rerun.");
      }
      const draft = buildIntakeDraft(photos, sidecar, overrides);
      deps.stdout(approvalSummary(draft));
      deps.stdout(`  Comp basis: ${comp.compBasis}${comp.fromComps ? ` — proposed $${comp.price}` : ""}`);
      if (!values.approve) {
        deps.stdout("\nNot published. Rerun with --approve after his one-tap approval.");
        return;
      }
      const result = await publishApproved(draft);
      deps.stdout(`\nfacebook-cli: ${result.message}`);
      deps.stdout(result.live ? "Status: LIVE." : "Status: DRAFT (publish gate incomplete — see message).");
      await withState(m, async (doc) => {
        const { doc: d1, listing } = createListing(doc, {
          kind: "sale",
          title: draft.title,
          price: draft.price,
          priceFirm: draft.firm,
          payment: draft.payment,
          meetup: draft.meetup,
          description: draft.description,
        }, m.now());
        const d2 = result.fbListingId ? attachFbListingId(d1, listing.id, result.fbListingId, m.now()) : d1;
        deps.stdout(`Registered listing "${listing.id}" in state; inquiry monitoring on.${result.fbListingId ? ` FB id ${result.fbListingId}.` : ""}`);
        return { doc: d2, value: undefined };
      });
      if (result.live) {
        const check = await messengerCheckRunner();
        deps.stdout(`Messenger readiness: ${check.trim().slice(0, 200)}`);
      }
    },
  },
  {
    name: "book",
    usage: "marketplace selling book <lead-id> --listing <id> --pickup-date <yyyy-mm-dd> --return-date <yyyy-mm-dd>",
    summary: "Draft a rental booking (pending-approval; his tap books it).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, {
        listing: { type: "string" },
        "pickup-date": { type: "string" },
        "return-date": { type: "string" },
      });
      const leadId = req(positionals[0], "<lead-id>");
      const listingId = req(values.listing, "--listing");
      await withState(m, async (doc) => {
        const { doc: d2, booking } = requestBooking(doc, listingId, {
          leadId,
          pickupDate: req(values["pickup-date"], "--pickup-date"),
          returnDate: req(values["return-date"], "--return-date"),
        }, m.now());
        deps.stdout(`Booking draft ${booking.id}: ${booking.pickupDate} → ${booking.returnDate}, deposit $${booking.deposit.amount}. Status: pending-approval — needs his tap.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "approve-booking",
    usage: "marketplace selling approve-booking <booking-id>",
    summary: "Execute his approval: flip a pending booking to booked, stage the message.",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      const bookingId = req(positionals[0], "<booking-id>");
      await withState(m, async (doc) => {
        const { doc: d1, booking } = approveBooking(doc, bookingId, m.now());
        const lead = d1.leads.find((l) => l.id === booking.leadId)!;
        const listing = d1.listings.find((l) => l.id === booking.listingId)!;
        const body = renderTemplate(d1, "booking-request", {
          name: lead.name,
          pickupDate: booking.pickupDate,
          dayRate: listing.terms!.dayRate,
          deposit: listing.terms!.deposit,
          depositMethods: listing.terms!.depositMethods.join("/"),
          meetup: listing.meetup,
        });
        const { doc: d2, message } = stageMessage(d1, {
          kind: "booking",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId: booking.listingId,
          leadId: booking.leadId,
        }, m.now());
        deps.stdout(`Booking ${booking.id} is now booked. Message staged in outbox (id ${message.id}).`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "advance",
    usage: "marketplace selling advance --listing <id>",
    summary: "Expire stale holds and auto-advance the queue (autonomous).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" } });
      const listingId = req(values.listing, "--listing");
      await withState(m, async (doc) => {
        const { doc: d2, result } = advanceExpiredHolds(doc, listingId, m.now());
        let d3 = d2;
        for (const e of result.expired) {
          deps.stdout(`Hold expired for ${e.name} — back to backup.`);
          d3 = recordReliability(d3, e.name, e.threadId, "hold-expired", m.now());
        }
        if (result.advanced) deps.stdout(`Advanced ${result.advanced.name} to hold (expires ${result.advanced.holdExpiresAt}).`);
        if (result.expired.length === 0) deps.stdout("No expired holds.");
        return { doc: d3, value: undefined };
      });
    },
  },
  {
    name: "sold",
    usage: "marketplace selling sold --listing <id> --buyer <lead-id>",
    summary: "Mark a listing sold; other live leads are retired (autonomous).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" }, buyer: { type: "string" } });
      const listingId = req(values.listing, "--listing");
      const buyerId = req(values.buyer, "--buyer");
      await withState(m, async (doc) => {
        const { doc: d2, notify } = markSold(doc, listingId, buyerId, m.now());
        deps.stdout(`Listing ${listingId} marked sold. ${notify.length} other lead(s) retired.`);
        let d3 = d2;
        for (const lead of notify) {
          const body = renderTemplate(d3, "sold-notice", { name: lead.name, item: d3.listings.find((l) => l.id === listingId)!.title });
          const r = stageMessage(d3, { kind: "sold-notice", channel: lead.channel, threadId: lead.threadId, recipient: lead.name, body, listingId, leadId: lead.id }, m.now());
          d3 = r.doc;
        }
        if (notify.length > 0) deps.stdout(`Staged ${notify.length} sold-notice(s) in the outbox.`);
        return { doc: d3, value: undefined };
      });
    },
  },
  {
    name: "outbox",
    usage: "marketplace selling outbox [flush]",
    summary: "List pending outbox messages, or flush one spurt for his approval taps.",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      if (positionals[0] === "flush") {
        await withState(m, async (doc) => {
          const { doc: d2, spurt } = flushOutbox(doc, m.now());
          if (spurt.length === 0) {
            deps.stdout("Outbox is empty — nothing to flush.");
          } else {
            deps.stdout(`SPURT: ${spurt.length} message(s) awaiting his tap. Send each via hatch_messenger_cli send (one approval card each), then run "marketplace selling sent <id...>".\n`);
            deps.stdout(formatOutbox(spurt));
          }
          return { doc: d2, value: undefined };
        });
        return;
      }
      const state = await m.openState();
      deps.stdout(formatOutbox(pendingMessages(state.document)));
    },
  },
  {
    name: "sent",
    usage: "marketplace selling sent <outbox-id...>",
    summary: "Record that he tapped send on outbox messages (cards approved).",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      if (positionals.length === 0) throw new UsageError("Provide at least one outbox id.");
      await withState(m, async (doc) => {
        const d2 = recordSent(doc, positionals, m.now());
        deps.stdout(`Marked ${positionals.length} message(s) sent.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "nudge-due",
    usage: "marketplace selling nudge-due",
    summary: "Stage escalating nudges (gentle → firm → final-call) for stale threads (autonomous).",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const before = dueNudges(doc, m.now()).length;
        const { doc: d2, staged } = sendDueNudges(doc, m.now());
        let d3 = d2;
        for (const s of staged) {
          d3 = logActivity(d3, "nudge", `Nudge level ${s.level} (${s.template}) staged for ${s.lead.name} on "${d3.listings.find((l) => l.id === s.lead.listingId)?.title}".`, m.now());
        }
        if (staged.length === 0) {
          deps.stdout("No nudges due.");
        } else {
          for (const s of staged) deps.stdout(`Staged ${s.template} → ${s.lead.name} (level ${s.level}${s.lead.status === "dead" ? "; lead retired" : ""}).`);
        }
        deps.stdout(`${before} due, ${staged.length} staged (outbox dedupes re-runs).`);
        return { doc: d3, value: undefined };
      });
    },
  },
  {
    name: "health",
    usage: "marketplace selling health [--check-live]",
    summary: "Self-healing check: stale-listing suggestions (price-drop/refresh/retire); --check-live retires listings missing from my-listings.",
    async run(args, m, deps) {
      const { values } = parse(args, { "check-live": { type: "boolean", default: false } });
      await withState(m, async (doc) => {
        const stale = detectStaleListings(doc, m.now());
        if (stale.length === 0) {
          deps.stdout("No stale listings — every active listing has recent inquiries.");
        } else {
          deps.stdout("STALE LISTINGS (one-tap suggestions):");
          for (const s of stale) {
            deps.stdout(`  "${s.title}": ${s.reason} Suggested: ${s.action}${s.suggestedPrice !== undefined ? ` → $${s.suggestedPrice}` : ""}.`);
          }
        }
        let d2 = doc;
        if (values["check-live"]) {
          const { execFile } = await import("node:child_process");
          const { doc: d3, retired } = await retireMissingListings(doc, (a) => new Promise((resolve, reject) => {
            execFile("facebook-cli", [...a], { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(stdout)));
          }), m.now());
          d2 = d3;
          for (const r of retired) {
            deps.stdout(`Retired "${r.title}" — missing from my-listings (delisted or sold elsewhere).`);
            d2 = logActivity(d2, "listing", `Retired "${r.title}" — delisted/sold elsewhere.`, m.now());
          }
          if (retired.length === 0) deps.stdout("my-listings check: all tracked listings still live.");
        }
        return { doc: d2, value: undefined };
      });
    },
  },
];

const BUYING: readonly Command[] = [
  {
    name: "status",
    usage: "marketplace buying status",
    summary: "Hunt states and threads (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      const doc = state.document;
      const lines = ["BUYING STATUS"];
      for (const c of doc.campaigns) {
        lines.push(`  ${c.name} — ${c.status}${c.maxPrice ? ` — ceiling $${c.maxPrice}` : ""} — ${c.threads.length} threads`);
        lines.push(`    criteria: ${c.criteria}`);
      }
      deps.stdout(lines.join("\n"));
    },
  },
  {
    name: "start-hunt",
    usage: "marketplace buying start-hunt --name <n> --criteria <c> [--max-price <n>]",
    summary: "Start a hunt (approval-gated — new outbound campaigns are his call).",
    async run(args, m, deps) {
      const { values } = parse(args, { name: { type: "string" }, criteria: { type: "string" }, "max-price": { type: "string" } });
      await withState(m, async (doc) => {
        const { doc: d2, campaign } = startHunt(doc, {
          name: req(values.name, "--name"),
          criteria: req(values.criteria, "--criteria"),
          maxPrice: values["max-price"] ? Number(values["max-price"]) : undefined,
        }, m.now());
        deps.stdout(`Hunt "${campaign.name}" started.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "pause-hunt",
    usage: "marketplace buying pause-hunt <name>",
    summary: "Pause a hunt (autonomous).",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      const name = req(positionals[0], "<name>");
      await withState(m, async (doc) => {
        const { doc: d2 } = pauseHunt(doc, name, m.now());
        deps.stdout(`Hunt "${name}" paused.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "cancel-hunt",
    usage: "marketplace buying cancel-hunt <name> [--threads <csv>] [--template close-out|close-out-50pct] [--callback-number <n>]",
    summary: "Kill-switch: cancel a hunt, stage templated close-outs (autonomous).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, {
        threads: { type: "string" },
        template: { type: "string" },
        "callback-number": { type: "string" },
      });
      const name = req(positionals[0], "<name>");
      const template = values.template as "close-out" | "close-out-50pct" | undefined;
      if (template && !["close-out", "close-out-50pct"].includes(template)) throw new UsageError(`--template must be close-out or close-out-50pct.`);
      await withState(m, async (doc) => {
        const { doc: d2, staged } = cancelHunt(doc, name, {
          threadIds: values.threads ? values.threads.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          template,
          callbackNumber: values["callback-number"],
        }, m.now());
        deps.stdout(`Hunt "${name}" cancelled. Staged ${staged} close-out message(s) in the outbox.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "leads",
    usage: "marketplace buying leads --hunt <name>",
    summary: "Show tracked seller threads for a hunt (read-only).",
    async run(args, m, deps) {
      const { values } = parse(args, { hunt: { type: "string" } });
      const name = req(values.hunt, "--hunt");
      const state = await m.openState();
      const c = state.document.campaigns.find((x) => x.name === name);
      if (!c) throw new UsageError(`Unknown hunt "${name}".`);
      deps.stdout(c.threads.length === 0 ? `Hunt "${name}" (${c.status}): no threads tracked.` : `Hunt "${name}" (${c.status}) threads:\n${c.threads.map((t) => `  ${t}`).join("\n")}`);
    },
  },
];

const CHANNELS: readonly Command[] = [
  {
    name: "poll",
    usage: "marketplace channels poll [--since <iso>]",
    summary: "Poll Messenger + Voice SMS + AgentMail, match to leads, run scam + logistics checks (read-only; writes state only).",
    async run(args, m, deps) {
      const { values } = parse(args, { since: { type: "string" } });
      const since = values.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const events = await pollAll(createChannelPollers(), since);
      await withState(m, async (doc) => {
        // Watermark-based incremental reads: skip anything already read per
        // thread, then dedupe by event id. Runaway cap: 200 events per poll.
        const delta = filterByWatermark(doc, events).slice(0, 200);
        const fresh = dedupe(doc, delta);
        let d2: typeof doc = { ...doc, seenEvents: [...doc.seenEvents, ...fresh.map((e) => e.id)] };
        const lines: string[] = [`Polled 3 channels since ${since}: ${events.length} event(s), ${fresh.length} new.`];
        const escalations: string[] = [];

        // Owner-activity reconciliation first — he may have handled threads himself.
        const threadMessages = fresh
          .filter((e) => e.senderId === OWNER_FB_ID)
          .map((e) => ({ threadId: e.threadId, senderId: e.senderId!, senderName: e.senderName, body: e.body, sentAt: e.sentAt }));
        if (threadMessages.length > 0) {
          const { doc: d3, report } = reconcileOwnerActivity(d2, threadMessages);
          d2 = d3;
          for (const n of report.notes) lines.push(`owner: ${n}`);
        }

        for (const event of fresh) {
          if (event.senderId === OWNER_FB_ID) continue;
          const lead = matchLead(d2, event);
          const screen = screenInbound(event.body);
          if (screen.flagged) {
            const esc = escalate("scam-flagged", `Scam-flagged inbound from ${event.senderName} (${event.channel}): ${screen.reasons.join(", ")}`, {
              sender: event.senderName, channel: event.channel, threadId: event.threadId, reasons: screen.reasons.join(","),
            });
            escalations.push(`[${esc.reason}] ${esc.summary} — no auto-reply sent.`);
            continue;
          }
          if (lead && lead.listingId) {
            const listing = d2.listings.find((l) => l.id === lead.listingId);
            const priceAccepted = lead.status === "confirmed";
            if (listing && isLogisticsHandoff(event.body, priceAccepted)) {              // THE selling hard stop: holding reply + escalate, never address/time.
              const body = renderTemplate(d2, "holding-logistics", { name: event.senderName });
              const staged = stageMessage(d2, {
                kind: "reply",
                channel: event.channel,
                threadId: event.threadId,
                recipient: event.senderName,
                body,
                listingId: lead.listingId,
                leadId: lead.id,
              }, m.now());
              d2 = staged.doc;
              const esc = escalate("logistics-handoff",
                `LOGISTICS HANDOFF: ${event.senderName} accepted $${listing.price}${listing.priceFirm ? " firm" : ""} for "${listing.title}" and is asking for address/pickup time. Holding reply staged — address/time handoff is Toozy's call (suggest Highland Village public meetup).`,
                { buyer: event.senderName, item: listing.title, price: String(listing.price), threadId: event.threadId, message: event.body.slice(0, 200) });
              escalations.push(`[${esc.reason}] ${esc.summary}`);
              continue;
            }
          }
          // BUYING side: seller thread on an active hunt — check the deal-agreed hard stop.
          const campaign = d2.campaigns.find((c) => c.status === "active" && c.threads.includes(event.threadId));
          if (campaign) {
            const acceptance = detectSellerAcceptance(event.body, campaign.maxPrice);
            if (acceptance.accepted) {
              const esc = escalate("deal-agreed",
                `DEAL AGREED: ${event.senderName} said yes${acceptance.price !== undefined ? ` at $${acceptance.price}` : ""} on hunt "${campaign.name}" (${campaign.criteria}). No reply sent to the seller, no pickup committed, no money moved — "seller said yes at your price, here's the deal, want it?"`,
                { seller: event.senderName, hunt: campaign.name, price: acceptance.price !== undefined ? String(acceptance.price) : "", threadId: event.threadId, message: event.body.slice(0, 200) });
              escalations.push(`[${esc.reason}] ${esc.summary}`);
              continue;
            }
          }
          if (!lead) {
            lines.push(`new: ${event.senderName} (${event.channel}, thread ${event.threadId}): "${event.body.slice(0, 100)}"`);
          } else {
            lines.push(`lead ${lead.id}: ${event.senderName}: "${event.body.slice(0, 100)}"`);
            // Buyer reliability: contact + lowball pattern detection.
            d2 = recordReliability(d2, event.senderName, event.threadId, "contact", m.now());
            const listing = lead.listingId ? d2.listings.find((l) => l.id === lead.listingId) : undefined;
            if (listing && listing.priceFirm) {
              const lowball = detectLowballOffer(event.body, listing.price);
              if (lowball !== undefined) {
                d2 = recordReliability(d2, event.senderName, event.threadId, "lowball", m.now());
                lines.push(`  lowball pattern: ${event.senderName} offered $${lowball} vs $${listing.price} firm (reliability score now ${buyerScore(d2, event.senderName)})`);
              }
            }
          }
        }

        if (escalations.length > 0) {
          lines.push("\nESCALATIONS (surface to Toozy):");
          for (const e of escalations) {
            lines.push(`  ${e}`);
            d2 = logActivity(d2, "escalation", e.slice(0, 200), m.now());
          }
        }
        // Watermarks + rolling summaries: raw bodies are summarized once,
        // then dropped — full histories are never re-read.
        d2 = updateWatermarks(d2, fresh);
        d2 = await rollSummaries(d2, fresh, undefined, m.now());
        deps.stdout(lines.join("\n"));
        return { doc: { ...d2, updatedAt: m.now() }, value: undefined as void };
      });
    },
  },
];

/**
 * Runaway guards (ADR 0024): per-run caps so a headless loop can never
 * spiral — max threads touched, max thread age, max events per poll.
 */
const MAX_THREADS_PER_SWEEP = 50;
const MAX_THREAD_AGE_DAYS = 60;
const MAX_EVENTS_PER_POLL = 200;

const TOPLEVEL: readonly Command[] = [
  {
    name: "sweep",
    usage: "marketplace sweep",
    summary: "One pass, all listings: incremental poll → advance holds → due nudges → stale check (shared sweep window, no per-listing polling).",
    async run(_args, m, deps) {
      const lines = ["SWEEP — one pass, all listings"];
      // 1. Incremental poll (watermarks; capped events).
      await findCommand(CHANNELS, "poll").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      // 2. Advance expired holds on every active listing (thread-age cap).
      const state = await m.openState();
      const now = m.now();
      const cutoff = new Date(new Date(now).getTime() - MAX_THREAD_AGE_DAYS * 24 * 3600_000).toISOString();
      const active = state.document.listings.filter((l) => l.status === "active" && l.monitoring).slice(0, MAX_THREADS_PER_SWEEP);
      let advanced = 0;
      let expired = 0;
      for (const listing of active) {
        try {
          await withState(m, async (doc) => {
            const { doc: d2, result } = advanceExpiredHolds(doc, listing.id, now);
            let d3 = d2;
            for (const e of result.expired) {
              if (e.firstSeenAt < cutoff) continue; // runaway guard: ancient threads age out quietly
              d3 = recordReliability(d3, e.name, e.threadId, "hold-expired", now);
              expired++;
            }
            if (result.advanced) advanced++;
            return { doc: d3, value: undefined };
          });
        } catch (error) {
          if (error instanceof AuthorityError) {
            lines.push(`advance: skipped "${listing.title}" — no advance-queue authority in this scope.`);
            continue;
          }
          throw error;
        }
      }
      lines.push(`advance: ${expired} hold(s) expired, ${advanced} queue(s) advanced.`);
      // 3. Due nudges (autonomous, outbox-deduped).
      await findCommand(SELLING, "nudge-due").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      // 4. Stale-listing suggestions (no live check in the loop — cheap).
      await findCommand(SELLING, "health").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      deps.stdout(lines.join("\n"));
    },
  },
  {
    name: "digest",
    usage: "marketplace digest [--since <iso>]",
    summary: "One short daily digest: confirmations, bookings, escalations, nudges, stale suggestions. Everything else is compressed here.",
    async run(args, m, deps) {
      const { values } = parse(args, { since: { type: "string" } });
      const since = values.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const state = await m.openState();
      const doc = state.document;
      const recent = doc.activity.filter((a) => a.at >= since);
      const lines = [`MARKETPLACE DIGEST (since ${since})`];
      if (recent.length === 0) lines.push("  Nothing to report — no confirmations, bookings, escalations, or nudges.");
      const byKind: Record<string, string[]> = {};
      for (const a of recent) (byKind[a.kind] ??= []).push(`  [${a.at.slice(0, 16)}] ${a.text}`);
      for (const [kind, items] of Object.entries(byKind)) {
        lines.push(`${kind.toUpperCase()} (${items.length}):`);
        lines.push(...items.slice(0, 10));
      }
      const stale = detectStaleListings(doc, m.now());
      if (stale.length > 0) {
        lines.push(`STALE LISTINGS (${stale.length}):`);
        for (const s of stale) lines.push(`  "${s.title}": ${s.reason} Suggest: ${s.action}${s.suggestedPrice !== undefined ? ` → $${s.suggestedPrice}` : ""}`);
      }
      const pending = pendingMessages(doc).length;
      lines.push(`Outbox: ${pending} message(s) pending his tap.`);
      deps.stdout(lines.join("\n"));
    },
  },
];

function findCommand(table: readonly Command[], name: string | undefined): Command {
  const cmd = table.find((c) => c.name === name);
  if (!cmd) throw new UsageError(`Unknown subcommand "${name ?? ""}".`);
  return cmd;
}

function usageFor(table: readonly Command[], title: string): string {
  return [`${title}:`, ...table.map((c) => `  ${c.usage}\n    ${c.summary}`)].join("\n");
}

/**
 * `orchestrator marketplace selling|buying|channels ...`
 * Read-only commands never send. Outbound is always staged → flushed in spurts.
 */
export async function runMarketplaceCommand(args: readonly string[], m: MarketplaceDeps, deps: CliDeps): Promise<void> {
  const [mechanism, sub, ...rest] = args;
  try {
    if (mechanism === "selling") {
      const cmd = findCommand(SELLING, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "buying") {
      const cmd = findCommand(BUYING, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "channels") {
      const cmd = findCommand(CHANNELS, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "sweep" || mechanism === "digest") {
      const cmd = findCommand(TOPLEVEL, mechanism);
      await cmd.run([sub, ...rest].filter((x): x is string => x !== undefined), m, deps);
      return;
    }
    throw new UsageError(`Expected selling|buying|channels|sweep|digest, got "${mechanism ?? ""}".`);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`Usage: orchestrator marketplace <selling|buying|channels|sweep|digest> <command>\n\n${usageFor(SELLING, "selling")}\n\n${usageFor(BUYING, "buying")}\n\n${usageFor(CHANNELS, "channels")}\n\n${usageFor(TOPLEVEL, "top-level")}`);
      deps.stderr(`\nError: ${(error as Error).message}`);
      throw error;
    }
    throw error;
  }
}

/** Entry used by src/cli/index.ts — opens state from the working directory. */
export async function runMarketplaceCommandFromCwd(args: readonly string[], deps: CliDeps): Promise<number> {
  const m = createMarketplaceDeps({ cwd: deps.cwd });
  await runMarketplaceCommand(args, m, deps);
  return 0;
}

/** Test helper: run against in-memory state. */
export function createTestMarketplaceDeps(): MarketplaceDeps {
  return createMarketplaceDeps({ storage: new InMemoryMarketplaceStorage(), now: () => "2026-09-26T05:00:00Z" });
}
