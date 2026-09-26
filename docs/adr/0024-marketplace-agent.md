---
status: accepted
---

# Marketplace Agent v2: two mechanisms, hard stops, and autonomous operation

The owner (Toozy) runs Facebook Marketplace threads on both sides: SELLING
(listings, buyer queues, holds, confirmations, rentals) and BUYING (hunts,
outreach, negotiation up to a ceiling). The agent works the threads
autonomously inside a policy box; the box's edges are two hard stops where
it MUST surface and wait. The operating surface is the repo CLI, used
identically by Muse and Claude Code sessions against the same state file.

**Two mechanisms, one CLI.** `marketplace selling …` manages listings,
queues, holds, confirmations, sold state, rentals, and photo-first intake.
`marketplace buying …` manages hunt intake (item + max price + criteria),
negotiation progression up to the ceiling, offer history, pause/cancel,
and templated close-outs. Runtime state lives in
`.orchestrator/marketplace/state.json` — written atomically, gitignored.
One document holds listings, leads, campaigns, constraints, authority
grants, the outbox, bookings, buyer scores, watermarks, summaries, and a
capped activity log. The seed carries his live threads (chair at $90 firm
with one buyer confirmed 2:30 PM Sat 2026-09-26 and others queued as backups;
BISSELL rental terms; both hunts cancelled) — placeholders for thread ids
that were never real are never used for sends.

**Authority is declarative.** `policy.ts` holds the action table
(`canAutonomous` / `needsApproval` / `assertAutonomous`); `state.ts` seeds
the grants he actually gave (chair: reply/confirm/hold/advance/nudge/mark-sold;
BISSELL: reply/hold/nudge, bookings need his tap). Autonomous commands
throw `AuthorityError` outside their grant. Publishing a listing is a
public write and always needs his one-tap approval, as does any price
change, money movement, pickup commitment, or "I'll take it."

**The two hard stops (notification policy: exception-only pings).**
Real-time pings exist only for these plus scam flags; everything else
compresses into the daily digest (`marketplace digest`).
- SELLING hard stop: a buyer accepts the listed/firm price AND asks for
  address/pickup time. The agent stages a warm holding reply ("let me lock
  in the pickup details, back to you shortly"), escalates with buyer, item,
  price, and proposed time — and NEVER discloses an address, locks a time,
  or finalizes logistics. Default recommendation: Highland Village public
  meetup (never his street address).
- BUYING hard stop: a seller agrees at or below the predetermined ceiling.
  Surface seller, exact item, agreed price, pickup/delivery plan — no money
  movement, no pickup commitment, no "I'll take it." Ping framing: "Seller
  said yes at your price — here's the deal, want it?"

**Owner-message reconciliation.** His Facebook id is read from the
`OWNER_FB_ID` environment variable (never committed; with it unset,
reconciliation does nothing) and recognized in managed threads: when he
handles a thread himself the agent
syncs state and stands down instead of double-messaging. Routine stand-downs
are quiet; only meaningful commitment conflicts escalate.

**Unified inbound, scam-screened.** `channels.ts` normalizes Messenger
marketplace threads (`hatch_messenger_cli`), Google Voice SMS forwarded to
Gmail (`from:voice-noreply@google.com label:Voice`), and AgentMail listing
mail into one event stream. Voice is read-only triage: outbound SMS stays
drafts through fixed templates, scam screen first, his tap required; never
relay verification codes to strangers, never place calls. Scam screening
covers verification-code requests, overpay/shipping schemes, PayPal-email
phishing, and QR-payment prompts. Pickup templates append the
carry constraint automatically and reject address-like text.

**Autonomy improvements (v2.1).**
1. *Auto-nudge cadence* (`selling/nudge.ts`): every thread carries
   awaiting-them/awaiting-us turn-state. Stale awaiting-them threads get
   escalating nudges — gentle (24h) → firm (72h) → final-call (7d), after
   which the lead retires. He never says "nudge them" again.
2. *Comp-based auto-pricing* (`selling/comps.ts` + intake): live comps via
   `facebook-cli marketplace search` propose the list price (median, rounded
   to $5) with the comp basis printed on the approval summary. Empty comps
   fall back to the sidecar price — never a guess.
3. *Buyer reliability scoring* (`selling/reliability.ts`): ghost/lowball/flake
   signals feed a 0–100 score; queue ordering deprioritizes flakes
   automatically, and below 30 the agent firmly declines without asking.
   The just-expired lead never re-advances in the same pass.
4. *Self-healing listings* (`selling/health.ts`): zero inquiries in 7 days
   triggers a one-tap price-drop suggestion; listings missing from
   `my-listings` are retired (delisted/sold elsewhere).

**Efficiency.** Watermark-based incremental reads: last-read event id per
thread; polls fetch thread-list deltas only — full histories are never
re-read. One shared sweep window (`marketplace sweep`) does poll → advance →
nudge → stale check in a single pass instead of per-listing polling;
event-driven hooks are preferred wherever the runtime offers them.

**Token usage.** Rolling thread summaries (`summarize.ts`): state keeps a
living summary per thread; raw messages are summarized once (cheap tier)
then dropped. State stores ids, statuses, timestamps, and summaries only —
never full message bodies; poller bodies are truncated to 280 chars at the
boundary. Tiered model routing: cheap/fast tier handles triage, deltas,
summaries, and the scam screen; the strong tier handles negotiation,
judgment calls, and pricing. Runaway guards: outbox dedup (same body to
the same thread is never staged twice while pending), max 200 events per
poll, max 50 threads per sweep, threads older than 60 days age out of the
nudge loop.

**Tone.** The agent acts as Karen to Toozy (addressing him as "sir") and
keeps buyer/seller replies friendly, brief, casual, authentic — aggressive
and authentic on his FB posts, never "sir" with buyers.

Not built: automatic sending of anything (every send is staged → flushed
in 5-minute spurts → his approval-card tap), event-driven message hooks
(where the runtime doesn't offer them), and live comp-sold data (active
listings only).
