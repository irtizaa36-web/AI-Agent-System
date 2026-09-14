---
name: options-trading-eval
description: Evaluate a proposed options trade against the evidence before it touches real money, and check it against the account's actual constraints. Use when the user proposes buying or selling an option, asks whether an options strategy is worth doing, or wants an options position reviewed. Produces draft recommendations only — never places orders.
---

# Options trade evaluation

## Prime directive

This skill **drafts and evaluates**. It does not execute. Placing an order requires the user's
specific authorization for the exact contract — symbol, expiration, strike, side, quantity, and
limit price — matching the repo's standing rule that reading and drafting are separate from
consequential execution (README safety principle 1, ADR 0004, `docs/BIG-BOSS-HANDOFF.md`).

Approval for one contract is not approval for the next one.

## Evidence status of this skill

Every substantive claim below carries a confidence label, inherited from
`docs/research/options-trading-evidence-2026-09.md`:

- **[VERIFIED]** — read against the primary source, figures confirmed.
- **[ABSTRACT-LEVEL]** — author, title and headline findings confirmed from the paper's own
  abstract; full text not parsed.
- **[SECONDARY]** — third-party write-up only.
- **[FIRST-PARTY]** — directly observed on this account's own fills, orders, or API responses.

**This skill was not built from video transcripts.** The research pass that produced it obtained
zero transcripts and performed no repetition weighting — see that file's "Method deviation"
section. Nothing here is weighted by how often it is repeated in retail options education, and
that is deliberate: at least one of the most-repeated claims in that space is directly
contradicted by peer-reviewed evidence (see below). Popularity is not evidence.

## The base rate you are arguing against

Every proposed options trade starts from a prior of "no edge." The strongest available result:

**[VERIFIED]** de Silva, So & Smith, "Losing is Optional: Retail Option Trading and Expected
Announcement Volatility," *Review of Finance* Vol. 30 Iss. 2 (2025-10-24). Individual-equity
options on Nasdaq, 2010-01-01 to 2021-02-28, across **32,791 earnings announcements**:

- Retail loses **5–9%** on average around earnings announcements.
- Losses worsen to **10–14%** where **expected volatility is highest** — retail does worst
  precisely where the anticipated move is biggest.
- Three mechanisms: overpaying relative to subsequently realised volatility (worst in
  media-covered firms); **bid-ask spreads costing 9–10% of the amount invested**; and slow exits
  — buying concentrated in the week before the announcement, then taking ~two weeks to close
  while volatility decays.

**[ABSTRACT-LEVEL]** Bogousslavsky & Muravyev, "An Anatomy of Retail Option Trading"
(SSRN 4682388), trader-level data on $15bn of retail trades: options are over a third of retail
trades, concentrated in few underlyings, **dominated by short-term purchases with almost no
covered calls or protective puts**. Option trades incur modest losses relative to the wide
bid-ask spreads paid, while stock trades roughly break even.

Note this paper also **complicates** the popular narrative: it finds little positive skewness in
realised dollar profits and states this contradicts gambling-driven explanations, describing
retail as "relatively sophisticated on average." Report that honestly rather than flattening it
into "retail are degenerates."

This is not a reason to refuse the work. It is the prior the evidence must overcome.

## Costs are the dominant loss mechanism — not bad picks

This is the load-bearing finding, and it is corroborated from two independent directions.

**[VERIFIED]** In the academic data, spreads and transaction costs — not directional error —
drive retail losses. de Silva/So/Smith put bid-ask costs at 9–10% of invested capital around
earnings. The 0DTE literature attributes retail losses primarily to spreads paid, not to being
wrong about direction.

**[FIRST-PARTY]** This account's own realised fills say the same thing. Measured per fill as the
gap between `principalAmount` (gross at the quoted price) and `netAmount` (cash that actually
moved), realised round-trip drag ran **2.07% dollar-weighted** against a **0.75%** assumption —
roughly 2.8× the modelled cost, with one AVAX leg giving up **2.45% on a single side**. That gap
appears even when the reported `fees` field reads `"0.00"`, because it is spread and markup
rather than a stated commission.

**Practical consequence:** on a position this size, costs routinely exceed the entire
hypothetical edge. Any proposed trade must clear the cost it *actually* pays, not the cost a
backtest assumed.

## Claims already tested — do not re-derive, do not repeat

| Commonly taught claim | Status |
|---|---|
| "Buy options before earnings to catch the big move." | **Contradicted [VERIFIED].** This is exactly where retail loses most: 5–9% typically, 10–14% when expected volatility is highest. |
| "Covered calls are free income." | **Contradicted as stated [SECONDARY].** CBOE BXM roughly *matches* the S&P 500 (e.g. 11.77% vs 11.67% over an 18-year window) at ~30–33% lower volatility. The benefit is risk reduction; the cost is capped upside in rallies. Not free money. |
| "Selling options is a reliable edge — sellers win more often." | **Partially supported, badly framed [SECONDARY].** The variance risk premium is real (Carr & Wu 2009: implied has tended to exceed subsequent realised volatility), but it is compensation for crash risk that materialises in bad times. High win rate ≠ positive expectancy net of tails. Selling insurance, not collecting rent. |
| "0DTE is where the opportunity is." | **Contradicted for buyers [ABSTRACT-LEVEL].** >75% of retail SPX option volume is 0DTE; retail receives real price improvement and still loses on average, with spreads the primary driver. |
| "80% of options expire worthless." | **[UNVERIFIED] — refuse to repeat.** No primary source found. Strongly suspected to conflate positions closed before expiry with positions held to expiry. Do not use this number. |

**Unresolved, flagged rather than guessed:** retail 0DTE loss magnitudes conflict across sources
by more than an order of magnitude ($241k/day vs ~$3m/day vs $350k/day vs >$500k/day). The
direction is consistent; the magnitude is not. Cite the direction, never a single figure.

## Procedure

When the user proposes an options trade:

1. **State the mechanism first.** What is the causal reason this should pay? If the answer is
   only "it's been going up" or "there's a catalyst coming," that is momentum-chasing or the
   earnings trade the evidence above directly refutes. Say so.
2. **Pull live data — never quote stale numbers.** Fresh `get_quotes` on the contract *and* the
   underlying, plus `get_option_greek`. Prices move within a conversation; this account's IOVA
   underlying moved ~4% over the course of a single session.
3. **Compute breakeven explicitly, and state the required move as a percentage.** Strike +
   premium for a long call. Report it as "the stock must rise X% in N days," because that framing
   is what makes an improbable trade legible as improbable.
4. **Read delta honestly.** Delta is a rough proxy for "finishes in the money at all," not
   probability of profit. Probability of clearing *breakeven* is lower than delta implies,
   because breakeven sits beyond the strike.
5. **Check the spread before anything else about liquidity.** A 25%+ bid-ask spread is a
   guaranteed immediate loss on entry. A strike with **zero bid** is untradeable regardless of
   what its mid implies — this account's chain showed real strikes quoting `bid 0.00 / ask 0.75`.
6. **Check implied volatility against the situation.** High IV is not automatically bad, but it
   means you are paying up for a move the market already expects, and it exposes you to IV crush
   once the uncertainty resolves. Small biotechs in this account's chain showed IV of 80–195%.
7. **Preflight the exact order.** `preflight_order` (or the matching spread preflight) returns
   real cost, fees, and buying-power requirement without placing anything. Compare the
   requirement — not the order value — against available buying power; fees push it higher.
8. **Present the whole picture, then ask.** Cost, breakeven, required move, odds, max loss, what
   has to happen. Then get explicit confirmation of the exact contract before placing.

## Kill criteria

Kill the proposed trade, or say plainly that it is unlikely to profit, if any hold:

- The thesis is "it's moving, so it'll keep moving," with no causal mechanism.
- It is a long option bought into a known catalyst (earnings, FDA decision, Fed) — the
  [VERIFIED] worst case for retail.
- Breakeven requires a move the delta says is unlikely, and the position is sized as if it
  weren't.
- The bid-ask spread is a large fraction of the premium, or the strike has no bid.
- The order's buying-power requirement exceeds available buying power (check the preflight
  figure, not the notional).
- Expected edge does not survive the **realised** cost baseline — currently ~2% round trip on
  this account, not the 0.75% originally assumed.

A trade that survives all of this is still a *candidate*, not a recommendation. Say so.

## Account-specific constraints (Public.com, account `5OI24720`)

All **[FIRST-PARTY]**, observed directly. Re-verify rather than trusting these indefinitely.

- **Options approval is the entry tier.** The API rejects spreads outright:
  *"Your current options level doesn't permit spread strategies or strategies involving unlimited
  risk."* Credit/debit spreads, iron condors, and naked short calls are all blocked. Long calls
  and long puts are what is actually available. Raising the tier is a request the user makes in
  the Public app; it is not something this system can do.
- **Covered calls are impossible as the account is currently structured.** Every equity position
  is a *fraction* of one share, because the Autopilot buys in dollar amounts. A covered call
  needs 100 whole shares. At the time of writing the largest position was ~0.46 shares.
- **Minimum realistic covered-call capital is ~$1,000+**, not ~$100. $100 for 100 shares implies
  a sub-$1 stock, and listed, liquid options essentially do not exist at that price — exchanges
  gate options listing on minimum price and liquidity, so the sub-$1 names that have them are
  usually distressed.
- **Strike spacing sets a floor on spread risk.** A $0.50-wide spread is $50 of notional width
  before any credit — which can exceed available buying power outright on a small account.
- **Buying power has run very thin** (~$20 at times, because the Autopilot deploys nearly all
  cash). Always pull fresh buying power; do not assume last session's figure.

## Gotchas that produce 100× errors

- **Greeks are quoted per share; contracts are 100 shares.** A theta of `-0.0093` is **−$0.93 per
  contract per day**, not "about a penny." This error was made once in live conversation and
  caught; encode it rather than repeat it.
- **Option prices are per share too.** A `$0.20` ask is `$20.00` per contract.
- **Preflight's `buyingPowerRequirement` exceeds `orderValue`**, because regulatory fees land on
  top. Size against the requirement.
- **Fills can be better than the limit.** A $0.20 limit filled at $0.1798 on this account —
  always report the actual fill from `get_order`, never assume the limit price was paid.

## On stop-losses for long options

Buying a call or put already caps max loss at the premium paid — there is no unlimited downside
to protect against, unlike a short position. A stop-loss here is about *salvaging some premium on
the way down*, not preventing catastrophe.

It is also unreliable on thin books: a STOP becomes a market order into whatever bid exists
(possibly terrible), and a STOP_LIMIT may simply never fill, leaving the position held to expiry
anyway. And because theta bleeds the price down daily regardless of direction, a tight stop tends
to trigger on ordinary decay rather than on any real adverse signal.

A **time-based exit rule** ("if the thesis hasn't played out by date X, close for whatever
remains") is usually the more honest instrument for a cheap, short-dated long option.

## Open questions

Unresolved in the evidence base; do not paper over them:

- Whether retail **debit vs credit** 0DTE trades really diverge (a secondary source claims
  −$8.05/contract vs +$4.55/contract). If true, it would mean buying and selling have materially
  different expected outcomes and this skill should treat them asymmetrically.
- Actual per-trade retail return figures (−0.9% overall, −3.4% for small traders were attributed
  to this literature but could not be matched to the paper).
- The real, sourced figures behind "options expire worthless."
- CBOE's first-party "New Evidence on the Performance of Customer Options Trades" has not been
  read.

## Files and references

- `docs/research/options-trading-evidence-2026-09.md` — full evidence review with source list,
  access status, and confidence labels. **Read this before adding any claim to this skill.**
- `.agents/skills/crypto-signal-eval/SKILL.md` — sibling skill; same evidence-first posture,
  and the source of the backtest + random-baseline bar that any *systematic* options signal
  would also have to clear before it could justify a trade.
