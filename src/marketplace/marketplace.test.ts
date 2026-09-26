import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMarketplaceStorage, MarketplaceState, seedDocument } from "./state";
import { advanceExpiredHolds, confirmLead, holdLead, markSold } from "./selling/queue";
import { renderTemplate } from "./templates";
import { stageMessage, pendingMessages, flushOutbox, recordSent } from "./outbox";
import { cancelHunt, startHunt, negotiateStep, detectSellerAcceptance, recordOffer } from "./buying/hunts";
import { screenInbound } from "./scam";
import { reconcileOwnerActivity, isOwnerSender } from "./owner_activity";
import { dedupe, matchLead, draftSmsReply, createChannelPollers, type LeadEvent } from "./channels";
import { isLogisticsHandoff, canAutonomous, needsApproval, escalate } from "./policy";
import { validateIntake, buildIntakeDraft, approvalSummary, publishApproved, type IntakeSidecar } from "./selling/intake";
import { requestBooking, approveBooking } from "./selling/rentals";
import { runMarketplaceCommand, createTestMarketplaceDeps } from "../cli/marketplace-commands";
import type { CliDeps } from "../cli/index";
import type { TrackerDocument } from "./types";

const NOW = "2026-09-26T05:00:00Z";

async function openSeeded(doc?: TrackerDocument): Promise<MarketplaceState> {
  const storage = new InMemoryMarketplaceStorage(doc);
  return MarketplaceState.open(storage, { seed: () => doc ?? seedDocument(NOW), now: () => NOW });
}

function cliDeps(): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    cwd: "/tmp",
  } as unknown as CliDeps;
  return { deps, out, err };
}

// ---------- queue auto-advance ----------

test("queue: expired hold drops the lead back and advances the next one", async () => {
  const state = await openSeeded();
  let doc = state.document;
  // Put Buyer 2 on an expired hold.
  ({ doc } = holdLead(doc, "chair", "buyer-2", "2026-09-25T00:00:00Z"));
  const { doc: d2, result } = advanceExpiredHolds(doc, "chair", "2026-09-27T00:00:00Z");
  assert.equal(result.expired.length, 1);
  assert.equal(result.expired[0].id, "buyer-2");
  assert.equal(result.expired[0].status, "contacted");
  assert.ok(result.advanced, "next lead should advance");
  assert.equal(result.advanced!.id, "buyer-3");
  assert.equal(result.advanced!.status, "hold");
  assert.ok(result.advanced!.holdExpiresAt);
  void d2;
});

test("queue: live holds are untouched", async () => {
  const state = await openSeeded();
  let doc = state.document;
  ({ doc } = holdLead(doc, "chair", "buyer-2", NOW));
  const { result } = advanceExpiredHolds(doc, "chair", NOW);
  assert.equal(result.expired.length, 0);
  assert.equal(result.advanced, undefined);
});

test("queue: confirm is autonomous at the listed price", async () => {
  const state = await openSeeded();
  const { doc, lead } = confirmLead(state.document, "chair", "buyer-4", { pickupAt: "2026-09-26T15:00:00-05:00" }, NOW);
  assert.equal(lead.status, "confirmed");
  assert.equal(lead.pickupAt, "2026-09-26T15:00:00-05:00");
  assert.ok(canAutonomous(doc, "selling:chair", "confirm"));
  assert.ok(needsApproval(doc, "selling:chair", "price-change"));
});

test("queue: markSold retires other live leads", async () => {
  const state = await openSeeded();
  const { doc, notify } = markSold(state.document, "chair", "buyer-1", NOW);
  assert.equal(doc.listings.find((l) => l.id === "chair")!.status, "sold");
  assert.ok(notify.length >= 3, `expected backups notified, got ${notify.length}`);
});

// ---------- templates ----------

test("templates: pickup messages auto-inject the carry constraint", async () => {
  const state = await openSeeded();
  const body = renderTemplate(state.document, "pickup-confirm", {
    name: "Buyer 1", pickupTime: "Sat 2:30pm", price: 90, payment: "cash or Venmo", meetup: "Highland Village area",
  });
  assert.match(body, /can't help carry or lift heavy items/);
  assert.match(body, /bring a friend/);
});

test("templates: non-pickup templates do not inject the constraint", async () => {
  const state = await openSeeded();
  const body = renderTemplate(state.document, "price-firm", { name: "Buyer 2", price: 90 });
  assert.doesNotMatch(body, /can't help carry or lift heavy items/);
});

test("templates: address markers are rejected", async () => {
  const state = await openSeeded();
  assert.throws(() => renderTemplate(state.document, "pickup-confirm", {
    name: "Buyer 1", pickupTime: "2:30", price: 90, payment: "cash", meetup: "Apt 1202, Westcreek",
  }), /address-leak/);
});

test("templates: missing variables throw", async () => {
  const state = await openSeeded();
  assert.throws(() => renderTemplate(state.document, "pickup-confirm", { name: "Buyer 1" }), /pickupTime/);
});

// ---------- campaign cancel ----------

test("campaigns: cancel stages templated close-outs per thread", async () => {
  const state = await openSeeded();
  let doc = state.document;
  // Revive the keyboard hunt as active with threads for the test.
  const revived = { ...doc.campaigns.find((c) => c.name === "keyboard-mouse")!, status: "active" as const, threads: ["t1", "t2"], cancelledAt: undefined };
  doc = { ...doc, campaigns: doc.campaigns.map((c) => (c.name === "keyboard-mouse" ? revived : c)) };
  const { doc: d2, campaign, staged } = cancelHunt(doc, "keyboard-mouse", { threadIds: ["t1", "t2"] }, NOW);
  assert.equal(campaign.status, "cancelled");
  assert.equal(staged, 2);
  const closeouts = d2.outbox.filter((m) => m.kind === "close-out");
  assert.equal(closeouts.length, 2);
  assert.match(closeouts[0].body, /going to pass/);
});

test("campaigns: close-out-50pct needs a callback number", async () => {
  const state = await openSeeded();
  let doc = state.document;
  const revived = { ...doc.campaigns.find((c) => c.name === "keyboard-mouse")!, status: "active" as const, threads: [], cancelledAt: undefined };
  doc = { ...doc, campaigns: doc.campaigns.map((c) => (c.name === "keyboard-mouse" ? revived : c)) };
  assert.throws(() => cancelHunt(doc, "keyboard-mouse", { template: "close-out-50pct", threadIds: ["t1"] }, NOW), /callbackNumber/);
  const { doc: d2, staged } = cancelHunt(doc, "keyboard-mouse", { template: "close-out-50pct", threadIds: ["t1"], callbackNumber: "(832) 915-0174" }, NOW);
  assert.equal(staged, 1);
  assert.match(d2.outbox[0].body, /\(832\) 915-0174/);
});

// ---------- outbox batching ----------

test("outbox: stage → flush marks awaiting-tap, recordSent closes the loop", async () => {
  const state = await openSeeded();
  let doc = state.document;
  const r1 = stageMessage(doc, { kind: "reply", channel: "messenger", threadId: "t1", recipient: "A", body: "hi A" }, NOW);
  const r2 = stageMessage(r1.doc, { kind: "reply", channel: "messenger", threadId: "t2", recipient: "B", body: "hi B" }, NOW);
  doc = r2.doc;
  assert.equal(pendingMessages(doc).length, 2);
  const { doc: d2, spurt } = flushOutbox(doc, NOW);
  assert.equal(spurt.length, 2);
  assert.ok(spurt.every((m) => m.status === "awaiting-tap"));
  assert.equal(pendingMessages(d2).length, 0);
  const d3 = recordSent(d2, [spurt[0].id], NOW);
  assert.equal(d3.outbox.find((m) => m.id === spurt[0].id)!.status, "sent");
  assert.equal(d3.outbox.find((m) => m.id === spurt[1].id)!.status, "awaiting-tap");
});

// ---------- scam screening ----------

test("scam: 6-digit code requests are flagged, normal interest is not", () => {
  const flagged = screenInbound("please send me the 6 digit verification code 482910 so I can confirm");
  assert.ok(flagged.flagged);
  assert.ok(flagged.reasons.includes("code-request"));
  const clean = screenInbound("Hi! Is the chair still available? Can I come by Saturday?");
  assert.ok(!clean.flagged);
});

test("scam: ship-only + overpay patterns are flagged", () => {
  const r = screenInbound("my mover will ship it, I'll send a cashier check for extra, refund me the difference");
  assert.ok(r.flagged);
  assert.ok(r.reasons.includes("overpay-ship"));
});

// ---------- owner activity ----------

test("owner_activity: his own messages stand the agent down", async () => {
  const state = await openSeeded();
  const { doc, report } = reconcileOwnerActivity(state.document, [
    { threadId: "buyer-2-chair-thread", senderId: "owner-test-id", senderName: "Owner", body: "yes 2pm works", sentAt: NOW },
    { threadId: "other", senderId: "999", senderName: "Stranger", body: "hello", sentAt: NOW },
  ], "owner-test-id");
  assert.deepEqual(report.ownerActiveThreads, ["buyer-2-chair-thread"]);
  const buyer2 = doc.leads.find((l) => l.id === "buyer-2")!;
  assert.equal(buyer2.needsAgentFollowUp, false);
  assert.equal(buyer2.ownerRepliedAt, NOW);
  assert.equal(report.escalations[0].reason, "owner-override");

  // With no owner id configured, reconciliation no-ops, even for messages with an empty sender id.
  const unset = reconcileOwnerActivity(state.document, [
    { threadId: "buyer-2-chair-thread", senderId: "", senderName: "Buyer 2", body: "hi", sentAt: NOW },
  ], "");
  assert.deepEqual(unset.report.ownerActiveThreads, []);
  assert.equal(isOwnerSender("", ""), false);
});

// ---------- policy: hard stops ----------

test("policy: logistics handoff fires on price-accepted + asks address/time", () => {
  assert.ok(isLogisticsHandoff("Deal! What's your address? Can I come at 3?", true));
  assert.ok(!isLogisticsHandoff("What's your address?", false), "no price acceptance → no trigger");
  assert.ok(!isLogisticsHandoff("Deal, see you then!", true), "no logistics ask → no trigger");
});

test("policy: buying escalation reason exists", () => {
  const esc = escalate("deal-agreed", "seller said yes", { seller: "X" });
  assert.equal(esc.reason, "deal-agreed");
});

// ---------- buying: negotiation ----------

test("buying: negotiateStep counters at ceiling once, then walks away", async () => {
  const state = await openSeeded();
  const { doc, campaign } = startHunt(state.document, { name: "kb", criteria: "genuine Apple only", maxPrice: 60 }, NOW);
  let step = negotiateStep(campaign, "t1", 80);
  assert.deepEqual(step, { action: "offer", amount: 60 });
  const d2 = recordOffer(doc, "kb", "t1", 60, "ours", NOW);
  const c2 = d2.campaigns.find((c) => c.name === "kb")!;
  step = negotiateStep(c2, "t1", 75);
  assert.equal(step.action, "walk-away");
});

test("buying: detectSellerAcceptance — yes at/under ceiling pings, over does not", () => {
  const yes = detectSellerAcceptance("Yes deal! $50 works, when can you pick up?", 60);
  assert.ok(yes.accepted);
  assert.equal(yes.price, 50);
  const over = detectSellerAcceptance("Ok deal at $80", 60);
  assert.ok(!over.accepted);
  const vague = detectSellerAcceptance("Sounds good, it's yours", 60);
  assert.ok(vague.accepted);
  assert.equal(vague.price, undefined);
});

// ---------- channels ----------

test("channels: dedupe drops seen events, matchLead finds threads", async () => {
  const state = await openSeeded();
  const events: LeadEvent[] = [
    { id: "messenger:t1:1", channel: "messenger", threadId: "t1", senderName: "A", body: "hi", sentAt: NOW },
    { id: "messenger:t1:2", channel: "messenger", threadId: "buyer-2-chair-thread", senderName: "Buyer 2", body: "hi", sentAt: NOW },
  ];
  const fresh = dedupe({ ...state.document, seenEvents: ["messenger:t1:1"] }, events);
  assert.equal(fresh.length, 1);
  const lead = matchLead(state.document, fresh[0]);
  assert.equal(lead!.id, "buyer-2");
});

test("channels: pollers never throw — fake exec failures return []", async () => {
  const pollers = createChannelPollers(async () => { throw new Error("nope"); });
  for (const p of pollers) {
    const events = await p.poll(NOW);
    assert.deepEqual(events, []);
  }
});

test("channels: draftSmsReply screens scams before rendering", async () => {
  const state = await openSeeded();
  const scamEvent: LeadEvent = { id: "voice-sms:1", channel: "voice-sms", threadId: "v1", senderName: "X", body: "send the 6 digit code 123456", sentAt: NOW };
  const flagged = draftSmsReply(state.document, scamEvent, { item: "chair", price: 90, meetup: "Highland Village area" });
  assert.ok(flagged.flagged);
  assert.equal(flagged.body, "");
  const okEvent: LeadEvent = { id: "voice-sms:2", channel: "voice-sms", threadId: "v2", senderName: "Sam", body: "is the chair available?", sentAt: NOW };
  const draft = draftSmsReply(state.document, okEvent, { item: "chair", price: 90, meetup: "Highland Village area" });
  assert.ok(!draft.flagged);
  assert.match(draft.body, /Sam/);
});

// ---------- intake ----------

const SIDECAR: IntakeSidecar = {
  item: "gaming chair",
  brand: "Generic",
  condition: "used_good",
  flaws: ["small scuff on armrest"],
  suggestedTitle: "Ergonomic Gaming Chair",
  suggestedDescription: "Comfortable ergonomic gaming chair, barely used.",
  suggestedPrice: 90,
  compBasis: "3 similar FB listings at $85–100",
};

test("intake: validation blocks missing photos/price/condition", () => {
  const { errors } = validateIntake([], { ...SIDECAR, suggestedPrice: 0, condition: "" });
  assert.ok(errors.length >= 3);
  assert.ok(errors.some((e) => /photo/i.test(e)));
  assert.ok(errors.some((e) => /price/i.test(e)));
  assert.ok(errors.some((e) => /condition/i.test(e)));
});

test("intake: draft builds with defaults + approval summary shows the publish gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-"));
  try {
    const photo = join(dir, "chair.jpg");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(photo, "fake-bytes");
    const { errors, warnings } = validateIntake([photo], { ...SIDECAR, category: undefined });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some((w) => /assuming/i.test(w)), "category guess should warn");
    const draft = buildIntakeDraft([photo], { ...SIDECAR, category: undefined });
    assert.equal(draft.category, "furniture");
    assert.ok(draft.categoryAssumed);
    assert.match(draft.description, /Price is firm/);
    assert.match(draft.description, /Highland Village/);
    const summary = approvalSummary(draft);
    assert.match(summary, /will publish immediately/i);
    assert.match(summary, /photos: ✓ 1 attached/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("intake: publish uses the injected runner — never the real facebook-cli", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-"));
  try {
    const photo = join(dir, "chair.jpg");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(photo, "fake-bytes");
    const draft = buildIntakeDraft([photo], SIDECAR);
    let seenArgs: readonly string[] = [];
    const result = await publishApproved(draft, async (args) => {
      seenArgs = args;
      return JSON.stringify({ data: { listing_id: "123", message: "Listing published successfully", product_url: "https://example/x" } });
    });
    assert.ok(result.live);
    assert.equal(result.fbListingId, "123");
    assert.ok(seenArgs.includes("--photo") && seenArgs.includes(photo));
    assert.ok(seenArgs.includes("--delivery-type") && seenArgs.includes("public_meetup"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- rentals ----------

test("rentals: booking drafts pending-approval, approve flips to booked", async () => {
  const state = await openSeeded();
  const { doc: d1, booking } = requestBooking(state.document, "bissell", {
    leadId: "renter-1", pickupDate: "2026-09-27", returnDate: "2026-09-28",
  }, NOW);
  assert.equal(booking.status, "pending-approval");
  assert.equal(booking.deposit.amount, 30);
  const { booking: b2 } = approveBooking(d1, booking.id, NOW);
  assert.equal(b2.status, "booked");
});

// ---------- CLI ----------

test("cli: selling status prints listings and hunts", async () => {
  const m = createTestMarketplaceDeps();
  const { deps, out } = cliDeps();
  await runMarketplaceCommand(["selling", "status"], m, deps);
  const text = out.join("\n");
  assert.match(text, /chair/);
  assert.match(text, /keyboard-mouse/);
});

test("cli: selling confirm stages the pickup message in the outbox", async () => {
  const m = createTestMarketplaceDeps();
  const { deps, out } = cliDeps();
  await runMarketplaceCommand(["selling", "confirm", "buyer-4", "--pickup", "2026-09-26T15:00:00-05:00"], m, deps);
  assert.match(out.join("\n"), /Confirmed Buyer 4/);
  const { deps: d2, out: o2 } = cliDeps();
  await runMarketplaceCommand(["selling", "outbox"], m, d2);
  assert.match(o2.join("\n"), /can't help carry or lift heavy items/);
});

test("cli: buying cancel-hunt kills the hunt and stages close-outs", async () => {
  const m = createTestMarketplaceDeps();
  // Start a hunt first (owner-initiated).
  const { deps: d0 } = cliDeps();
  await runMarketplaceCommand(["buying", "start-hunt", "--name", "kb-test", "--criteria", "genuine Apple", "--max-price", "60"], m, d0);
  const { deps, out } = cliDeps();
  await runMarketplaceCommand(["buying", "cancel-hunt", "kb-test", "--threads", "t9", "--template", "close-out-50pct", "--callback-number", "(832) 915-0174"], m, deps);
  assert.match(out.join("\n"), /cancelled.*1 close-out/i);
  const { deps: d2, out: o2 } = cliDeps();
  await runMarketplaceCommand(["selling", "outbox"], m, d2);
  assert.match(o2.join("\n"), /50% of your asking price/);
});

// ---------- watermark deltas ----------

test("watermarks: updateWatermarks records newest id per thread; filterByWatermark drops repeats", async () => {
  const { updateWatermarks, filterByWatermark } = await import("./channels.js");
  const doc = seedDocument(NOW);
  const mk = (id: string, threadId: string): LeadEvent => ({
    id, channel: "messenger", threadId, senderName: "X", body: "hi", sentAt: NOW,
  });
  const d1 = updateWatermarks(doc, [mk("m:t1:1", "t1"), mk("m:t1:2", "t1"), mk("m:t2:1", "t2")]);
  assert.equal(d1.watermarks["t1"], "m:t1:2");
  assert.equal(d1.watermarks["t2"], "m:t2:1");
  // Same poll again (only latest snippets re-fetched): watermarked ids are dropped.
  const again = filterByWatermark(d1, [mk("m:t1:2", "t1"), mk("m:t2:1", "t2")]);
  assert.deepEqual(again, []);
  // A genuinely new message passes through.
  const delta = filterByWatermark(d1, [mk("m:t1:2", "t1"), mk("m:t1:3", "t1")]);
  assert.equal(delta.length, 1);
  assert.equal(delta[0].id, "m:t1:3");
});

test("pollers truncate bodies at the boundary — full message bodies never enter state", async () => {
  const pollers = createChannelPollers(async () => JSON.stringify([
    { conversation_id: "t9", name: "Long", snippet_sender_id: "1", snippet: "x".repeat(1000), updated_at: "1727241600000" },
  ]));
  const events = await pollers[0].poll("x");
  assert.equal(events.length, 1);
  assert.ok(events[0].body.length <= 281, `body not truncated: ${events[0].body.length}`);
});

// ---------- summary rollover ----------

test("rollSummaries: folds messages into living summaries, keeps messageCount", async () => {
  const { rollSummaries, extractiveSummarizer } = await import("./summarize.js");
  const doc = seedDocument(NOW);
  const mk = (threadId: string, body: string, n: number): LeadEvent => ({
    id: `e${n}`, channel: "messenger", threadId, senderName: "Buyer 2", body, sentAt: NOW,
  });
  const d1 = await rollSummaries(doc, [mk("t-kat", "still interested, can I pick up Friday?", 1)], extractiveSummarizer, NOW);
  assert.ok(d1.summaries["t-kat"]);
  assert.equal(d1.summaries["t-kat"].messageCount, 1);
  const d2 = await rollSummaries(d1, [mk("t-kat", "Friday morning works for me", 2)], extractiveSummarizer, NOW);
  assert.equal(d2.summaries["t-kat"].messageCount, 2);
  assert.ok(d2.summaries["t-kat"].summary.length > 0);
  assert.ok(d2.summaries["t-kat"].summary.length <= 2000);
});

test("rollSummaries: injected summarizer receives previous summary + new messages", async () => {
  const { rollSummaries } = await import("./summarize.js");
  const doc = seedDocument(NOW);
  const seen: Array<[string, readonly string[]]> = [];
  const fake = async (prev: string, msgs: readonly string[]) => { seen.push([prev, msgs]); return `SUM(${msgs.length})`; };
  const mk = (body: string): LeadEvent => ({ id: "e1", channel: "voice-sms", threadId: "t-v", senderName: "Renter 2", body, sentAt: NOW });
  await rollSummaries(doc, [mk("is Saturday available?")], fake, NOW);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "");
  assert.ok(seen[0][1][0].includes("Renter 2"));
});

// ---------- outbox dedup ----------

test("stageMessage: identical body to same thread is never staged twice while pending", () => {
  const doc = seedDocument(NOW);
  const input = { kind: "nudge" as const, channel: "messenger" as const, threadId: "buyer-2-chair-thread", recipient: "Buyer 2", body: "Hey Buyer 2 — just checking in!" };
  const r1 = stageMessage(doc, input, NOW);
  assert.equal(r1.duplicated, false);
  const r2 = stageMessage(r1.doc, input, NOW);
  assert.equal(r2.duplicated, true);
  assert.equal(r2.message.id, r1.message.id);
  assert.equal(r2.doc.outbox.length, 1);
});

test("stageMessage: same thread, different body is staged normally", () => {
  const doc = seedDocument(NOW);
  const base = { kind: "nudge" as const, channel: "messenger" as const, threadId: "buyer-2-chair-thread", recipient: "Buyer 2" };
  const r1 = stageMessage(doc, { ...base, body: "gentle nudge" }, NOW);
  const r2 = stageMessage(r1.doc, { ...base, body: "firm nudge" }, NOW);
  assert.equal(r2.duplicated, false);
  assert.equal(r2.doc.outbox.length, 2);
});

test("stageMessage: dedup only applies while pending/awaiting-tap — sent copies don't block", () => {
  const doc = seedDocument(NOW);
  const input = { kind: "nudge" as const, channel: "messenger" as const, threadId: "t1", recipient: "A", body: "same" };
  const r1 = stageMessage(doc, input, NOW);
  const sent = recordSent(r1.doc, [r1.message.id], NOW);
  const r2 = stageMessage(sent, input, NOW);
  assert.equal(r2.duplicated, false);
});

// ---------- reliability scoring ----------

test("reliability: ghosts, flakes, lowballs drag the score down; completions lift it", async () => {
  const { recordReliability, buyerScore, shouldDecline, buyerKey } = await import("./selling/reliability.js");
  const doc = seedDocument(NOW);
  let d = recordReliability(doc, "Flaky Frank", "t1", "ghost", NOW);
  assert.equal(buyerScore(d, "Flaky Frank"), 55);
  d = recordReliability(d, "Flaky Frank", "t1", "hold-expired", NOW);
  assert.equal(buyerScore(d, "Flaky Frank"), 45);
  d = recordReliability(d, "Flaky Frank", "t2", "lowball", NOW);
  assert.equal(buyerScore(d, "Flaky Frank"), 37);
  assert.equal(shouldDecline(d, "Flaky Frank"), false);
  d = recordReliability(d, "flaky frank", "t3", "ghost", NOW); // key normalization
  assert.equal(buyerScore(d, "Flaky Frank"), 22);
  assert.equal(shouldDecline(d, "Flaky Frank"), true);
  assert.equal(buyerKey("  Flaky FRANK "), "flaky frank");
  d = recordReliability(d, "Solid Sam", "t9", "completed", NOW);
  assert.equal(buyerScore(d, "Solid Sam"), 90);
  d = recordReliability(d, "Solid Sam", "t9", "completed", NOW);
  assert.equal(buyerScore(d, "Solid Sam"), 100); // capped
});

test("reliability: detectLowballOffer flags offers materially below a firm price", async () => {
  const { detectLowballOffer } = await import("./selling/reliability.js");
  assert.equal(detectLowballOffer("would you take $60?", 90), 60);
  assert.equal(detectLowballOffer("I'll pay $90, sounds good", 90), undefined);
  assert.equal(detectLowballOffer("$86 for it?", 90), undefined); // within 5%
  assert.equal(detectLowballOffer("no numbers here", 90), undefined);
});

test("queueFor: known flakes sink below reliable buyers", async () => {
  const { recordReliability } = await import("./selling/reliability.js");
  const { queueFor } = await import("./selling/queue.js");
  const doc = seedDocument(NOW);
  // Make Buyer 2 (queuePosition 1 on chair listing) a known flake.
  const d = recordReliability(recordReliability(doc, "Buyer 2", "buyer-2-chair-thread", "ghost", NOW), "Buyer 2", "buyer-2-chair-thread", "ghost", NOW);
  const q = queueFor(d, "chair").filter((l) => ["new", "contacted"].includes(l.status));
  assert.ok(q.length >= 2);
  assert.notEqual(q[0].name, "Buyer 2", "flake should not lead the queue");
  assert.ok(q.findIndex((l) => l.name === "Buyer 2") > q.findIndex((l) => l.name === "Buyer 3"));
});

// ---------- stale-listing detection ----------

test("detectStaleListings: flags quiet listings, suggests a 10% price-drop", async () => {
  const { detectStaleListings } = await import("./selling/health.js");
  const doc = seedDocument(NOW);
  // Push all lead contact times 10 days back; the chair listing goes quiet.
  const old = new Date(new Date(NOW).getTime() - 10 * 24 * 3600_000).toISOString();
  const quiet: TrackerDocument = {
    ...doc,
    listings: doc.listings.map((l) => (l.id === "chair" ? { ...l, createdAt: old } : l)),
    leads: doc.leads.map((l) => ({ ...l, lastContactAt: old, lastNudgeAt: undefined })),
  };
  const stale = detectStaleListings(quiet, NOW);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].listingId, "chair");
  assert.equal(stale[0].action, "price-drop");
  assert.equal(stale[0].suggestedPrice, 80); // 10% under $90, rounded to $5
});

test("detectStaleListings: recent activity means no suggestion", async () => {
  const { detectStaleListings } = await import("./selling/health.js");
  const doc = seedDocument(NOW); // seed leads were seen 2026-09-26 00:xx, NOW is 05:00Z
  assert.deepEqual(detectStaleListings(doc, NOW), []);
});

test("retireMissingListings: retires listings absent from my-listings", async () => {
  const { retireMissingListings } = await import("./selling/health.js");
  const doc = seedDocument(NOW);
  const d0: TrackerDocument = {
    ...doc,
    listings: doc.listings.map((l) => (l.id === "chair" ? { ...l, fbListingId: "FB-CHAIR-1" } : l)),
  };
  const runner = async () => JSON.stringify([{ listing_id: "OTHER" }]);
  const { doc: d1, retired } = await retireMissingListings(d0, runner, NOW);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].id, "chair");
  assert.equal(d1.listings.find((l) => l.id === "chair")!.status, "sold");
});

test("retireMissingListings: network failure retires nothing", async () => {
  const { retireMissingListings } = await import("./selling/health.js");
  const doc = seedDocument(NOW);
  const runner = async () => { throw new Error("offline"); };
  const { doc: d1, retired } = await retireMissingListings(doc, runner, NOW);
  assert.deepEqual(retired, []);
  assert.equal(d1, doc);
});

// ---------- nudge cadence ----------

test("dueNudges: escalating levels at 24h / 72h / 7d; final-call retires the lead", async () => {
  const { dueNudges, sendDueNudges } = await import("./selling/nudge.js");
  const doc = seedDocument(NOW);
  const ago = (h: number) => new Date(new Date(NOW).getTime() - h * 3600_000).toISOString();
  const mkLead = (id: string, hoursSilent: number, nudgeLevel: number, status: "new" | "contacted" = "new"): TrackerDocument["leads"][number] => ({
    id, listingId: "chair", name: `Buyer-${id}`, threadId: `t-${id}`, channel: "messenger",
    status, queuePosition: 9, firstSeenAt: ago(hoursSilent + 1), lastContactAt: ago(hoursSilent),
    needsAgentFollowUp: true, awaiting: "them", nudgeLevel, notes: [],
  });
  const d: TrackerDocument = { ...doc, leads: [mkLead("a", 30, 0), mkLead("b", 80, 1), mkLead("c", 200, 2), mkLead("d", 200, 3), mkLead("e", 30, 0, "dead" as never)] };
  const due = dueNudges(d, NOW);
  assert.equal(due.length, 3);
  assert.deepEqual(due.map((x) => x.template), ["nudge-final", "nudge-firm", "nudge-gentle"]);
  const { doc: d2, staged } = sendDueNudges(d, NOW);
  assert.equal(staged.length, 3);
  assert.equal(d2.outbox.length, 3);
  // final-call (level 3) retires the lead
  assert.equal(d2.leads.find((l) => l.id === "c")!.status, "dead");
  assert.equal(d2.leads.find((l) => l.id === "c")!.nudgeLevel, 3);
  // re-running stages nothing new (outbox dedup + nudgeLevel advanced)
  const again = sendDueNudges(d2, NOW);
  assert.equal(again.staged.length, 0);
});

test("dueNudges: skips awaiting-us threads and owner-handled threads", async () => {
  const { dueNudges } = await import("./selling/nudge.js");
  const doc = seedDocument(NOW);
  const ago = new Date(new Date(NOW).getTime() - 30 * 3600_000).toISOString();
  const base = { listingId: "chair", name: "X", threadId: "tx", channel: "messenger" as const, status: "new" as const, queuePosition: 9, firstSeenAt: ago, lastContactAt: ago, notes: [] as readonly string[] };
  const d: TrackerDocument = {
    ...doc,
    leads: [
      { ...base, id: "u1", awaiting: "us", nudgeLevel: 0, needsAgentFollowUp: true },
      { ...base, id: "u2", awaiting: "them", nudgeLevel: 0, needsAgentFollowUp: false },
    ],
  };
  assert.deepEqual(dueNudges(d, NOW), []);
});

// ---------- comp-based pricing ----------

test("analyzeComps: median of comps, rounded to $5", async () => {
  const { analyzeComps } = await import("./selling/comps.js");
  const runner = async () => JSON.stringify([
    { title: "Office chair", price: 80 }, { title: "Gaming chair", price: 100 },
    { title: "Ergo chair", price: 90 }, { title: "Chair", price: 110 },
  ]);
  const a = await analyzeComps("office chair", runner);
  assert.equal(a.comps.length, 4);
  assert.equal(a.suggestedPrice, 95); // median of 80,90,100,110 = 95
  assert.ok(a.basis.includes("median of 4 comps"));
});

test("analyzeComps: empty results fall back to sidecar price, never a guess", async () => {
  const { analyzeComps } = await import("./selling/comps.js");
  const { resolveIntakePrice } = await import("./selling/intake.js");
  const empty = await analyzeComps("q", async () => JSON.stringify([]));
  assert.equal(empty.suggestedPrice, undefined);
  const sidecar: IntakeSidecar = {
    item: "Office chair", condition: "used_good", flaws: [],
    suggestedTitle: "Chair", suggestedDescription: "Nice chair", suggestedPrice: 75, compBasis: "sidecar estimate",
  };
  const r = await resolveIntakePrice(sidecar, async () => JSON.stringify([]));
  assert.equal(r.price, 75);
  assert.equal(r.fromComps, false);
});
