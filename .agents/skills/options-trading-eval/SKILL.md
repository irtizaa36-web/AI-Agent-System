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

**[VERIFIED]** Bogousslavsky & Muravyev, "An Anatomy of Retail Option Trading" (SSRN 4682388,
August 2024 version, read in full), trader-level broker data: **5,182 traders, 2.4M parent
trades, ~$15bn, 2020–2022.** Options are over a third of all trades, concentrated in few
underlyings, dominated by short-term purchases, with covered calls and protective puts **jointly
under 0.3% of trades even at the 90th percentile of accounts**.

**Average option-trade return: −0.9%** (889,967 option parent trades; Table 3 baseline −0.93%,
t = −3.57), **including broker commissions and bid-ask spread crossing.** Small traders lose more,
**−3.4% per trade.** Stock trades roughly break even. The paper's own framing matters here: it
argues −0.9% is *small relative to costs*, not large — roughly half of it is plain commission
(~0.4% from a $0.65/contract round trip on an average 6-contract trade), and typical bid-ask
spreads run 5–10%, implying retail is largely using limit orders rather than crossing the spread.

Dollar P&L skewness is **slightly negative** (−0.25 stock, −0.14 option) for multi-day traders —
which the authors say contradicts a pure gambling explanation. **One correction on how to use
this paper:** it also describes its traders as "relatively sophisticated on average," but says so
about a sample of **trading-journal users**, and names that as the study's main limitation —
*"more active and sophisticated retail traders are more likely to use a trading journal... our
findings should be extrapolated to the full universe of retail traders... with caution."* That
line is a caveat about this sample's generalisability, not a finding about retail traders as a
population. Cite the skewness result; do not cite "retail is sophisticated" as if it applied
broadly.

**This paper explicitly disputes the earnings-window magnitude above**, in its own words: *"Our
profitability estimates contrast with Bryzgalova et al. (2022) and de Silva et al. (2023), who
report losses of 3% to 9% per trade based on aggregate retail proxies. The difference arises from
the proxy limitations, differences in analysis units, endogenous holding periods, and investor
sophistication."* Trader-level broker data says −0.9%; aggregate exchange-proxy methods say 3–9%.
**This is a live, unresolved methodological dispute about how to measure retail losses, not two
independent confirmations of the same number** — see "A live methodological dispute" below before
treating either figure as the settled one.

This is not a reason to refuse the work. It is the prior the evidence must overcome — and the
prior is contested on magnitude even where it is not contested on direction.

## Costs are the dominant loss mechanism — not bad picks

This is the load-bearing finding, and it is corroborated from two independent directions.

**[VERIFIED]** In the academic data, spreads and transaction costs — not directional error —
drive retail losses. de Silva/So/Smith put bid-ask costs at 9–10% of invested capital around
earnings. Bogousslavsky & Muravyev find roughly **half** of their smaller −0.9% figure is plain
commission. The 0DTE literature is explicit: *"roughly 60% of daily losses are the result of
transaction costs"* [VERIFIED, Beckmeyer/Branger/Gayda] — not being wrong about direction.

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
| "0DTE is where the opportunity is." | **Contradicted for buyers, more nuanced for spreads [VERIFIED].** >75% of retail SPX option volume is 0DTE; full-sample retail loses **$241k/day** (Feb 2021–Sep 2023), **$350k/day** since daily expirations began (16 May 2022), with **~60% of the loss from transaction costs** and **~60% from put buying** specifically. But **many multi-leg 0DTE strategies show positive margin-adjusted returns** (median put-spread +3%, call-spread +3.3%), and multi-leg net losses have been flat since early 2023. Do not blanket-condemn 0DTE; condemn 0DTE single-leg buying. |
| "80% of options expire worthless." | **False as stated [ABSTRACT-LEVEL/VERIFIED].** No primary source for 80% exists anywhere — every trail dead-ends in an unsourced "CBOE" attribution. The measured, auditable figure is the opposite emphasis: **~74.5% of retail-proxy opening positions are closed before expiration; only ~25.5% are held to expiry** [VERIFIED, Cboe SLIM data, Jan 2020–Jun 2023]. Options Industry Council states 72% closed / 22% expire worthless / 6% exercised [ABSTRACT-LEVEL, undated, no underlying dataset]. Use the 25.5%-held-to-expiry figure, or the 22% OIC figure with its provenance weakness noted — never "80%." |

**Resolved, was previously flagged as conflicting — it wasn't really:** the 0DTE loss figures
above ($241k, $350k, and peak months >$500k/day, e.g. $680k/day in Sep 2022) all come from two
dated versions of the same paper. The one number that could not be substantiated anywhere in the
primary text — "~$3 million/day" — is almost certainly a truncation artifact of "$350,000/day."
Every real figure sits in a $184k–$680k/day band. See "A unit error caught before it could
propagate" below for a related, more serious correction to a per-contract figure that *was*
wrong.

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

## A unit error caught before it could propagate

A round of primary-source verification (2026-09-14) found that a secondary source had misread a
table by a factor of **~100,000×**, and that misreading was in this skill's first draft. Recorded
here rather than silently fixed, because the failure mode is worth encoding: **check the units
printed in the table, not just the numbers.**

**[VERIFIED]** Beckmeyer, Branger & Gayda, Table 2 Panel B, is *aggregate daily dollars across all
retail 0DTE trades, in units of $100,000* — not a per-contract figure. Confirmed internally: the
table's "All Options" row of −3.50 is the paper's own **$350,000/day** headline figure. So:

- Retail **debit (long)** 0DTE trades: **≈ −$805,000/day in aggregate** (post-16-May-2022), not
  "−$8.05/contract."
- Retail **credit (short)** 0DTE trades: **≈ +$455,000/day in aggregate**, not "+$4.55/contract."

**Never state these as a per-contract expectancy.** A trader cannot read "−$8.05" as their
expected loss on one contract — that number does not exist in the source.

The *direction* does survive, independently, in the paper's own prose: *"long positions in
options lose money on average, short positions are profitable."* But it is not a stable edge —
the same debit/credit split flipped sign month to month (e.g. +$3.34M/day in Jan-22 vs
−$2.90M/day in Dec-22). Cite the direction as a data point about retail behaviour in aggregate,
never as an expected value for a specific trade.

## A live methodological dispute — do not pick a side

**[VERIFIED]** Amaya, Garcia-Ares, Pearson & Vasquez, "New Evidence on the Performance of Customer
Options Trades" (Cboe, 2025-04-07), is a direct rebuttal of Bryzgalova, Pavlova & Sikorskaya
(2023, *Journal of Finance*) — one of the papers underlying the "retail loses on options"
consensus, including the aggregate-proxy estimates that this skill's "base rate" section leans on.

Two concrete methodological attacks: BPS priced options *held to expiration* at the NBBO midpoint
instead of actual expiration value (systematically inflating apparent losses — *"the estimate of
the profitability of options held to expiration changes from negative to positive"* using the
same data once corrected), and BPS's buy/sell-direction inference rule **misclassifies 42.4% of
trades**. Using true directions and true expiration values on Cboe customer SLIM data
(Jan 2020 – Jun 2023), Amaya et al. get **+$0.34M/day net** (t = 0.29) against BPS's **−$1.63M/day
to −$5.03M/day**.

**Two disclosures that must travel with any citation of this paper:**

- **Funding conflict.** The paper states it *"was supported by a data research grant from The
  Options Institute, the educational division of Cboe Global Markets"* — the exchange whose
  retail volume is at stake. The methodological critiques are specific and checkable, which is
  why the finding is recorded at all, but the funding source must be disclosed every time.
- **The authors do not claim retail is profitable.** Their own words: *"our performance estimates
  are not statistically significant at conventional significance levels"* and *"no evidence that
  Cboe customer SLIM trades are unprofitable."* That is absence of evidence of loss, not evidence
  of profit. Citing this as "retail options traders make money" overstates it exactly the way the
  secondary sources overstated the loss-side papers.

**Do not encode either side's magnitude as settled.** This is a live proxy-construction dispute
between peer-reviewed-grade work, not a resolved number. **Bryzgalova/Pavlova/Sikorskaya has not
been read directly** — only through Amaya et al.'s rebuttal of it. Reading one side of a dispute
through the opposing side's summary is the exact failure this skill exists to avoid; treat the
BPS-side magnitude as unverified until BPS itself is read.

**What this means for the "base rate" section above:** the de Silva/So/Smith earnings-window
result (5–9%, 10–14%) is a *different, narrower* claim — retail behaviour specifically around
earnings announcements — and is not directly contradicted by the Amaya/BPS dispute, which concerns
0DTE and aggregate-proxy loss estimation generally. But Bogousslavsky & Muravyev's trader-level
−0.9% (see below) and this Cboe-funded rebuttal both push against treating "retail loses on
options, full stop" as a settled, undisputed magnitude. Hold the earnings-window finding with
confidence; hold the general magnitude claim with less.

## Open questions

Unresolved in the evidence base; do not paper over them:

- **Bryzgalova, Pavlova & Sikorskaya has not been read directly** — see above. Read it before
  encoding either side of that dispute with more confidence than the other.
- **SSRN 4682388's current (Feb 2025) full text.** A newer abstract circulates ($20bn dataset,
  "nearly half" of 2022 trades) that could not be matched to a readable version. Every
  Bogousslavsky & Muravyev figure in this skill is verified against the **August 2024** version
  and may have since been revised.
- **No auditable primary source exists for any "% of options expire worthless" figure.** Two
  mutually inconsistent "official" breakdowns circulate (OIC's undated 72/22/6 vs. a 10/55-60/30-35
  split attributed to CBOE that could not be traced to any CBOE publication). See the corrected
  claim in the table above — cite the 25.5%-held-to-expiry figure, or cite nothing.
- Carr & Wu (2009) and the CBOE BXM covered-call figures remain **[SECONDARY]** — not read
  against primary text.

## Files and references

- `docs/research/options-trading-evidence-2026-09.md` — full evidence review with source list,
  access status, and confidence labels, including a "Verification round 2" section
  (2026-09-14) that re-checked several claims against primary-source full text and caught the
  unit error and sophistication misattribution corrected above, and a 2026-09-17 addendum
  explaining why a named YouTube channel's videos were not incorporated as skill content.
  **Read this before adding any claim to this skill.**
- `src/tools/market-review/external-signals.ts` and `docs/operations/market-review.md`
  ("External signal tracking") — where a third-party source's dated calls are tracked and
  graded against outcomes, if you want to know whether a specific channel is worth listening
  to. **Never treat a tracked source's calls as evidence for this skill** — even a strong hit
  rate would describe that source's own track record, not a general options-trading truth,
  and would need its own confidence label and sample-size caveats before citing.
- `.agents/skills/crypto-signal-eval/SKILL.md` — sibling skill; same evidence-first posture,
  and the source of the backtest + random-baseline bar that any *systematic* options signal
  would also have to clear before it could justify a trade.
