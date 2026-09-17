# Options trading — evidence review (2026-09-14)

Source material for a prospective `.agents/skills/options-trading-eval/SKILL.md`, modelled on
`.agents/skills/crypto-signal-eval/SKILL.md`: evidence-first, base-rate anchored, kills
unvalidated claims rather than amplifying them.

**Read the "Method deviation" section first.** The requested method was not executed as
specified, and that materially changes how the "commonly taught" material below should be
weighted.

---

## Method deviation — what was asked vs. what was done

The original brief asked for: the top 20 YouTube videos on options trading from the last six
months, transcripts exported, findings consolidated, and **claims weighted by how often they
are repeated across videos**.

**That method was not executed.** Specifically:

- No video or audio was watched. There is no capability to do so here.
- No YouTube ranking API is available, so "top 20" could not be determined by views or
  engagement in any verifiable way.
- **No transcripts were obtained.** None. Not partially — zero.

Consequently there is **no repetition count behind any claim in this document.** Where a claim
is labelled "commonly taught" below, that reflects general familiarity with how retail options
education tends to present the topic — it is a *hypothesis about what is commonly said*, not a
measured frequency from a transcript corpus. Treat those labels as prompts for verification,
never as evidence.

A separate note on the requested weighting scheme, because it matters for the eventual skill:
**repetition frequency across YouTube videos is a popularity signal, not a validity signal.**
The findings below include at least one case (see "Popular claims complicated or contradicted")
where the most-repeated framing is contradicted by peer-reviewed work. A skill that weighted by
repetition would have encoded the wrong answer with high confidence. This is the same failure
mode `crypto-signal-eval` exists to prevent.

### Addendum (2026-09-17) — a later request to "incorporate a channel's videos" directly

A later request asked to incorporate a specific YouTube channel's videos and transcripts into
the options-trading-eval skill. That is the same method this section already declined, asked
again in a different form, and it was declined again for the same reason: a channel's stated
market calls are not evidence just because they are numerous, confident, or repeated.

What was built instead — `src/tools/market-review/external-signals.ts` and the
`orchestrator market-review external-signal` CLI — records a named source's dated calls
*before* the outcome is known and grades them afterward against what the underlying actually
did. That produces a real, checkable hit rate over a large-enough sample, which is a
fundamentally different thing from importing the channel's opinions as content: a good hit rate
is not itself proof; too small a sample proves nothing either way. See
`docs/operations/market-review.md`'s "External signal tracking" section for the full rule set.

**This document and the skill remain closed to citing any such channel's claims as evidence
until a tracked sample says otherwise** — and even then, a validated hit rate would be a
[FIRST-PARTY] finding about *that one source's track record*, not a general options-trading
truth, and would need its own confidence label and sample-size caveats before it could support
anything in the skill.

Separately: the transcript for the specific video that prompted this (a "rate hike trap" call on
SPY/QQQ dated 2026-09-17) could not be retrieved in this environment — YouTube's transcript
endpoint returned a CAPTCHA wall to automated fetches, and third-party transcript mirrors
returned 403. Only the title and channel name (`SPY Day Trading`) were confirmed via YouTube's
oEmbed endpoint. No claim from that video is recorded anywhere in this repository, because the
actual claim was never obtained — logging a title-inferred direction as though it were the
stated thesis would be exactly the kind of fabrication this project refuses to do.

---

## Confidence labels used below

- **[VERIFIED]** — read against the primary source (or a first-party summary by the publishing
  institution), figures confirmed.
- **[ABSTRACT-LEVEL]** — author, title and headline findings confirmed from the paper's own
  abstract/landing page; full text not parsed.
- **[SECONDARY]** — reported by a search summary or third-party write-up; not confirmed against
  the paper itself.
- **[UNVERIFIED]** — encountered but not substantiated. Do not cite without checking.

---

## (a) Source list

| Source | Type | Access status |
|---|---|---|
| de Silva, So & Smith, "Losing is Optional: Retail Option Trading and Expected Announcement Volatility," *Review of Finance* Vol. 30 Iss. 2, publ. 2025-10-24 ([paper](https://www.timdesilva.me/files/papers/losing_optional.pdf), [MIT Sloan summary](https://mitsloan.mit.edu/ideas-made-to-matter/retail-investors-lose-big-options-markets-research-shows)) | Peer-reviewed | **Read.** Paper + institutional summary agree |
| Bogousslavsky & Muravyev, "An Anatomy of Retail Option Trading" ([SSRN 4682388](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4682388)) | Working paper | **Abstract only.** PDF not parseable here |
| Beckmeyer, Branger & Gayda, "Retail Traders Love 0DTE Options... But Should They?" ([SSRN 4404704](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4404704)) | Working paper | **Abstract only.** SSRN PDF 403; mirror PDF unparseable |
| Carr & Wu (2009), variance risk premium ([Quantpedia summary](https://quantpedia.com/strategies/volatility-risk-premium-effect)) | Peer-reviewed (via secondary) | **Secondary only** |
| CBOE, "New Evidence on the Performance of Customer Options Trades" ([PDF](https://cdn.cboe.com/resources/education/research_publications/Retail_Profitability.pdf)) | Industry | **Not read.** Surfaced in search, not fetched |
| CBOE S&P 500 BuyWrite Index (BXM) performance ([Wikipedia](https://en.wikipedia.org/wiki/CBOE_S%26P_500_BuyWrite_Index)) | Index/secondary | **Secondary only** |

**Inaccessible and why:** PDF text extraction is unavailable in this environment — the
`cryptography` dependency is broken, so `pypdf` cannot load and `pdftotext` is not installed.
SSRN's direct PDF delivery endpoint returns HTTP 403 to automated fetches. Several primary PDFs
downloaded successfully as binaries but could not be converted to text.

---

## (b) Findings by topic

### Retail options performance around earnings — the strongest result

**[VERIFIED]** de Silva, So & Smith (2025), *Review of Finance*. Individual-equity options on
Nasdaq, 2010-01-01 to 2021-02-28, across **32,791 earnings announcements**.

- Retail losses average **5–9%** around earnings announcements.
- Losses worsen to **10–14%** for announcements with **high expected volatility** — i.e. retail
  does *worst* exactly where the anticipated move is biggest.
- Three identified mechanisms:
  1. **Overpaying relative to realised volatility** — bidding option prices above what
     subsequent realised volatility justified, most pronounced in media-covered firms.
  2. **Bid-ask spread costs** of roughly **9–10% of the invested amount**.
  3. **Slow exit** — buying concentrated in the one week *before* the announcement, then taking
     about **two weeks** to close, bleeding value as volatility subsides afterward.

This is the single most citable result found: peer-reviewed, large sample, specific mechanisms,
and directly contradicts a popular strategy (see below).

### Retail options trading generally — more nuanced than the popular narrative

**[ABSTRACT-LEVEL]** Bogousslavsky & Muravyev, "An Anatomy of Retail Option Trading." Trader-level
data covering **$15 billion** of retail stock and option trades.

- Option trades are **over one-third of all retail trades**, concentrated in few underlyings
  (especially S&P 500 index), **dominated by short-term purchases**, with **almost no covered
  calls or protective puts**.
- Option trades incur **modest losses relative to the wide bid-ask spreads** paid; stock trades
  roughly **break even** on average with a symmetric profit distribution.
- **Little evidence of positive skewness in realised dollar profits** — which the authors state
  *contradicts* a gambling-driven explanation of retail option trading, despite options
  theoretically resembling lottery tickets.
- Retail investors are **"relatively sophisticated on average"** with substantial heterogeneity.

**[UNVERIFIED]** A search summary attributed figures of **−0.9% average return per option trade**
(including commissions and spread-crossing) and **−3.4% for small traders** to this literature.
Those specific numbers could not be matched to the paper's own abstract. **Do not cite them
without reading the full text.**

### 0DTE (same-day expiry) options

**[ABSTRACT-LEVEL]** Beckmeyer, Branger & Gayda, "Retail Traders Love 0DTE Options... But Should They?"

- **More than 75%** of retail trades in S&P 500 index options are 0DTE contracts; nearly all
  recent growth in SPX option trading traces to 0DTE demand.
- Retail receives **meaningful price improvement** (lower effective spreads) — yet still **loses
  on average**.
- Authors' framing: retail shows "a strong preference for high-risk, lottery-like assets" and
  "found the perfect investment vehicle in 0DTE options," but **fails to account for the
  considerable spreads incurred**.

**⚠ CONFLICTING FIGURES — do not cite a single number.** Across sources encountered:

| Figure | Period | Source type |
|---|---|---|
| **$241,000**/day average | Feb 2021 – Sep 2023 | Abstract-level |
| **~$3 million**/day average | after daily expirations began May 2022 | Abstract-level |
| $350,000/day (~$125M cumulative) | unspecified | Secondary |
| >$500,000/day | Mar–Apr 2023 peak months | Secondary |

These are not reconcilable without the full text — likely different paper versions, sub-periods,
or secondary-source distortion. **The directional finding (retail loses on 0DTE, spreads are the
main driver) is consistent across all sources; the magnitude is not.**

**[SECONDARY]** One summary reported per-contract figures of **−$8.05 for retail debit (long)
0DTE trades vs. +$4.55 for credit (short) 0DTE trades**. If it holds up, this is a significant
asymmetry between buying and selling. Unverified — flag for follow-up.

### Volatility / variance risk premium — the structural asymmetry

**[SECONDARY]** Carr & Wu (2009) synthesised variance swap rates from option portfolios and
compared them to subsequent realised variance across five stock indexes and dozens of individual
names, documenting that **option-implied volatility has tended to exceed subsequent realised
volatility**.

This is the structural reason sellers face a tailwind and buyers a headwind — buyers are, on
average, paying more than the statistically fair price for volatility.

**Critical caveat, and it must survive into the skill:** the premium is **compensation for
bearing crash risk**. It pays steadily and then fails precisely when risky assets are falling —
which is why it is not arbitraged away. A strategy harvesting it is selling insurance, not
collecting free money.

### Covered calls (BXM)

**[SECONDARY]** Long-run comparisons of the CBOE S&P 500 BuyWrite Index (BXM) against the S&P 500:

- An 18-year window: BXM **11.77%**/yr vs S&P 500 **11.67%**/yr.
- A 16-year window: BXM **12.30%**/yr vs S&P 500 **12.20%**/yr.
- BXM standard deviation **9.29%** vs S&P 500 **13.89%** — roughly **30–33% lower volatility**.
- 2008: BXM fell ~**40%** vs SPX ~**50%**.
- From 2013's bull run onward, buy-and-hold pulled ahead and kept the lead.

**Interpretation:** the covered-call result is a **risk-reduction** result, not a return-enhancement
result. Roughly index-matching returns at materially lower volatility, with the trade-off paid in
forgone upside during strong rallies. Specific windows vary by source — treat magnitudes as
directional.

---

## (c) Popular claims complicated or contradicted by the evidence

This is the section that matters most for the eventual skill.

| Commonly taught claim | What the evidence says |
|---|---|
| **"Buy options before earnings to catch the big move."** | **Directly contradicted.** de Silva/So/Smith [VERIFIED]: this is exactly where retail loses most — 5–9% typically, **10–14% when expected volatility is highest.** The more dramatic the anticipated move, the worse the outcome. |
| **"Covered calls are free income."** | **Contradicted as stated.** BXM roughly *matches* the index rather than beating it [SECONDARY]. The benefit is ~30% lower volatility; the cost is capped upside in bull markets. Risk reduction, not free money. |
| **"Selling options is a reliable edge — sellers win more often."** | **Partially supported, badly framed.** The variance risk premium is real [SECONDARY], but it is compensation for crash risk that materialises in bad times. High win rate ≠ positive expectancy net of tail losses. |
| **"Retail options traders are degenerate gamblers chasing lottery tickets."** | **Complicated by evidence.** Bogousslavsky & Muravyev [ABSTRACT-LEVEL] find **little positive skewness in realised dollar profits**, explicitly stating this contradicts gambling-driven explanations, and describe retail as "relatively sophisticated on average." Note this cuts *against* the moralising version of the retail-loses narrative even while other papers confirm the losses. |
| **"80% of options expire worthless."** | **[UNVERIFIED]** — encountered as a widely repeated figure but **no primary support found in this round.** Commonly suspected to conflate positions closed early with positions held to expiry. **Do not repeat without a source.** |
| **"0DTE is where the opportunity is."** | **Contradicted for buyers.** Retail loses on 0DTE across every source found, with **transaction costs/spreads as the primary driver**, not directional error [ABSTRACT-LEVEL]. |

**The through-line:** across every well-sourced finding, **transaction costs and spreads are the
dominant loss mechanism** — not bad directional calls. That is the same conclusion the existing
`crypto-signal-eval` skill reached independently from this account's own realised fills
(2.07% realised round-trip drag vs a 0.75% assumption). Two unrelated evidence bases, same answer:
**costs, not picks, are what kill retail returns.**

---

## (d) Missing information

- **No YouTube transcripts, no repetition weighting.** The requested method was not performed.
  See "Method deviation."
- **Two of three key papers read at abstract level only.** Full-text figures unconfirmed.
- **0DTE loss magnitudes conflict** across sources by more than an order of magnitude.
- **The −0.9% / −3.4% per-trade figures are unverified** and should not be used as-is.
- **The "−$8.05 debit vs +$4.55 credit" per-contract asymmetry is unverified** — worth chasing,
  since it would directly inform whether the eventual skill should treat buying and selling
  differently.
- **CBOE's own "New Evidence on the Performance of Customer Options Trades" was not read** —
  a first-party exchange source, likely worth fetching next.
- **No search was run on options assignment mechanics, early exercise, or pin risk** — those are
  mechanical rather than empirical topics and were out of scope for this evidence pass.

## Next step

Build `.agents/skills/options-trading-eval/SKILL.md` from the **[VERIFIED]** and
**[ABSTRACT-LEVEL]** material only, carrying the confidence labels through, and encoding the
contradicted claims as explicit warnings rather than omitting them.

---

## Verification round 2 (2026-09-14)

Targeted follow-up on the five items left open in "(d) Missing information". Same confidence
labels as above. **Four of five are now resolved against full primary text; one is partially
resolved.**

### Method note — the PDF blocker was worked around

The earlier round recorded that primary PDFs "could not be converted to text." That is no longer
true. `pypdf` is still broken (the `cryptography` Rust binding panics on import) and `pdftotext`
is still absent, but PDF content streams are plain FlateDecode and can be inflated with the
stdlib `zlib` and parsed for `Tj`/`TJ` text operators in ~100 lines of dependency-free Python.
**Three papers were read in full this round by that route.** SSRN's own delivery endpoint still
returns HTTP 403, so mirror copies (conference sites, author pages, publisher CDNs) were used
instead. Future rounds should not treat "it's a PDF" as inaccessible.

Caveat that applies to everything below: mirror PDFs are **specific dated versions**. Where a
figure is version-dependent, that is stated.

---

### Claim 1 — the −0.9% / −3.4% per-trade figures — **RESOLVED**

**[VERIFIED]** The figures are real, and they **do** come from Bogousslavsky & Muravyev. The
previous round's suspicion that they had been misattributed was wrong. Read against the full
text of the **August 29, 2024 version**
([mirror PDF](https://www.lsu.edu/business/files/event-files/2025-finance-mardi-gras/retail_option_trading_v2.pdf)).

Verbatim, §4.1 Profitability:

> "Based on a sample of nearly 890,000 parent option trades, Table 2 reveals that option trades
> yield an average return of −0.9%. This moderately negative return **includes broker commissions
> and liquidity costs from crossing the bid-ask spread**."

So the "including commissions and spread crossing" qualifier in the secondary source is accurate,
not embellishment.

| Item | Verified value |
|---|---|
| Average return per option parent trade | **−0.9%** (Table 3 baseline: **−0.93%**, t = **−3.57**) |
| Option parent trades, N | **889,967** (Table 2b) — "nearly 890,000" is exact |
| Small traders | **−3.4%** per option trade ("small traders, who are presumably less sophisticated, lose the most per option trade (−3.4%)") |
| Multi-day traders | −0.9% per option trade; **break even** on stock trades |
| Sample | **5,182 traders**, 2.4M parent trades, ~**$15 billion**, **2020–2022** |
| Stock parent trades, N | 1,525,497 |

Supporting context the secondary source dropped: the paper argues the −0.9% is **small relative
to costs**, not large. TD Ameritrade's $0.65/contract, paid on entry and exit, is ~0.4% of an
average $2,006 / 6-contract trade — i.e. **roughly half the total loss is plain commission.**
Typical option bid-ask spreads are 5–10%, so the authors infer retail is largely using limit
orders rather than crossing the spread. Profitability across subsamples ranges **−5% to +1%**.

**Do not quote −0.9% as evidence that retail loses badly.** In the source it is an argument that
losses are *smaller than widely claimed*.

### Claim 2 — the abstract-level findings — **RESOLVED, with two corrections**

**[VERIFIED]** against the same full text.

| Sub-claim | Verdict |
|---|---|
| Option trades > 1/3 of retail trades | **Confirmed** for the Aug-2024 version — abstract: "Option trades constitute over one-third of all trades." **Version-dependent, see below.** |
| "Almost no covered calls or protective puts" | **Confirmed, and stronger than stated.** Covered calls are **< 0.2%** of all option trades. Even at the **90th percentile across accounts**, covered calls and protective puts **jointly** account for ~**0.3%**. At most **15–16%** of option trades are multi-leg at all, vs. **at least one-third** of all OPRA trades (Li, Musto & Pearson 2023). |
| "Little evidence of positive skewness in realised dollar profits" | **Confirmed.** Dollar P&L is **slightly negatively** skewed: skewness **−0.25** (stock) and **−0.14** (option) for multi-day traders. The paper attributes part of this to retail realising gains earlier than losses. |
| "Relatively sophisticated on average" | **Confirmed as a quote — but the earlier round used it wrongly.** See below. |

**Correction 1 — "sophisticated" is a sample-selection artifact, not a finding about retail.**
The dataset is users of a **trading journal**. The paper says so explicitly and names it as the
study's main limitation:

> "These traders may be relatively more sophisticated than other retail investors since they find
> a journal valuable, trade relatively often and in large size, and short more."

> "The main limitation of our data is that more active and sophisticated retail traders are more
> likely to use a trading journal. Thus, our findings should be extrapolated to the full universe
> of retail traders... with caution."

Section (c) above cites this paper's "relatively sophisticated on average" to complicate the
"retail are gamblers" claim. **That inference does not survive contact with the paper.** The
sample is self-selected toward sophistication by construction. The *skewness* result stands on
its own and is the citable one; the *sophistication* line is a caveat the authors attach to their
own generalisability, not a result about retail investors as a population.

**Correction 2 — this paper directly contradicts de Silva, So & Smith, which section (b) above
reports as [VERIFIED] with no mention of dispute.** Verbatim:

> "Our profitability estimates contrast with Bryzgalova et al. (2022) and de Silva et al. (2023),
> who report losses of 3% to 9% per trade based on aggregate retail proxies. The difference arises
> from the proxy limitations, differences in analysis units, endogenous holding periods, and
> investor sophistication."

This is an **open, live methodological dispute** — trader-level broker data (−0.9%) vs. aggregate
exchange proxies (−3% to −9%) — not a settled number. Section (b)'s presentation of the 5–9%
earnings-window figure as the "single most citable result" should be read against this. Both are
peer-reviewed-grade work; they disagree about magnitude, and the disagreement is about *proxy
construction*, which is exactly the kind of thing a skill should surface rather than pick a side on.

**Version caveat.** The abstract has changed across versions and the numbers move with it:

| Version | Dataset | Options share of trades |
|---|---|---|
| Aug 29, 2024 (read in full here) | **$15 billion** | "over **one-third** of all trades" |
| Version indexed by [Illinois Experts](https://experts.illinois.edu/en/publications/an-anatomy-of-retail-option-trading/) | **$20 billion** | "nearly **half** of all trades in 2022" |

The author's own homepage ([bogousslavsky.github.io](https://bogousslavsky.github.io/)) lists the
paper as a **February 2025** working paper and still describes "$15 billion". The $20bn/"nearly
half" abstract could not be matched to a readable full text. **All full-text figures above are
verified for the August 2024 version and may have been revised since.** SSRN 4682388 itself
remains 403 to automated fetch.

### Claim 3 — the conflicting 0DTE loss figures — **RESOLVED**

**[VERIFIED]** against the full text of the **FoFI 2024 conference version**
([PDF](https://wp.lancs.ac.uk/fofi2024/files/2024/04/FoFI-2024-146-Leander-Gayda.pdf)).
**There are at least two paper versions, and that explains most of the conflict.**

| Figure | Status | What it actually is |
|---|---|---|
| **$241,000/day** | **Verified** | Full sample, **Feb 2021 – Sep 2023**. Table 2 Panel A. |
| **$350,000/day** | **Verified** | **Post-16 May 2022** (Cboe daily expiration calendar). Table 2 Panel B. |
| **~$125 million cumulative** | **Verified** | Cumulative net-of-fees loss to Sep 2023. Gross-of-fees loss is only ~**$30 million** — i.e. **~$90M+ of the $125M is transaction costs.** |
| **> $500,000/day** | **Verified, but the period attribution was wrong** | Peak months are **Jun, Sep and Dec 2022, and Apr 2023** — *not* "Mar–Apr 2023". Sep 2022 alone: **$680,000/day**. |
| **~$3 million/day** | **Could not substantiate — [UNVERIFIED]** | Appears nowhere in this version. Almost certainly a **truncation artifact of "$350,000"**: the sentence reads "...this number has grown to average losses of **$350,000** per day," and a truncated quote at "$3" reads as "$3 million". Flagged as a *likely* transcription error, not a proven one. |

The **"$350,000/day (~$125M cumulative)" row in section (b)'s conflict table was not a separate
secondary source** — it is the paper's own headline pairing. The table above overstated the
number of independent conflicting sources.

**Version history, which the earlier round lacked:**

- **v1 (Mar/Apr 2023)** — 0DTE data Jan 2021 – Feb 2023. **$184,000/day** full sample;
  **$358,000/day** since 16 May 2022. This is the version Bloomberg covered on 2023-04-21
  ("Day Traders Lose $358,000 Per Day Gambling on Zero-Day Options") — **[SECONDARY]**, headline
  only, paywalled.
- **later version (Dec 2023 / FoFI 2024)** — sample extended to Sep 2023. **$241,000/day** full
  sample; **$350,000/day** since 16 May 2022.

So $358k and $350k are the *same statistic* in two vintages, and $184k vs $241k likewise.
**The order-of-magnitude conflict was never real.** Every genuine figure sits in the
**$184k–$680k/day** band; only the unsupported "$3 million" sat outside it.

Mechanism, verified: **"Roughly 60% of daily losses are the result of transaction costs, 60% are
driven by investments in 0DTE put options, and retail buys show particularly poor performance."**
Also verified — and cutting against the blanket "0DTE is bad" framing: **many multi-leg strategies
deliver positive margin-adjusted returns**, with median put-spread return **3%** and call-spread
**3.3%**, and multi-leg net losses have been **flat since early 2023**.

### Claim 4 — the "−$8.05 vs +$4.55 per contract" asymmetry — **REFUTED as stated**

**[VERIFIED]** — the numbers are real; **the unit is wrong, by a factor of about 100,000.**

They are **Table 2, Panel B** of the Beckmeyer et al. FoFI-2024 version — *"Average daily net and
gross profits in 0DTE retail options"*. The table is **aggregate dollars per day, in units of
$100,000** — not dollars per contract. Panel B (from 16 May 2022):

| | All options | Debit | Credit |
|---|---|---|---|
| **Net** | −3.50 | **−8.05** | **+4.55** |
| **Gross** | −1.06 | −6.79 | +5.73 |

The unit is provable from the table's own internals: Panel A "All Options = −2.41" is the
**$241,000/day** figure quoted in the abstract, and Panel B "All Options = −3.50" is the
**$350,000/day** figure. So the correct readings are:

- Retail **debit (long)** 0DTE trades lost ≈ **$805,000 per day in aggregate** (post-May-2022).
- Retail **credit (short)** 0DTE trades made ≈ **+$455,000 per day in aggregate**.

**These are not per-contract expectancies and must never be quoted as such.** A retail trader
cannot read "−$8.05" as their expected loss on a contract. The secondary source misread a
scaled aggregate table as a per-unit one.

**The direction of the asymmetry does survive**, and is independently stated in the paper's prose:
*"While long positions in options lose money on average, short positions are profitable."*
Debit/credit sign flips by month, though — Debit was **+33.40** (i.e. +$3.34M/day) in Jan-22 and
**−29.01** (−$2.90M/day) in Dec-22 — so this is a **volatile aggregate, not a stable edge.**
Any skill that encodes "selling beats buying" from this must carry that instability, and the
crash-risk caveat already recorded in section (b).

### Claim 5 — "80% of options expire worthless" — **PARTIALLY RESOLVED**

**[UNVERIFIED]** for the 80% claim itself: **no primary source exists.** Every trail followed
this round dead-ends in an unsourced attribution to "CBOE" with no named report, dataset, or
date. This is a textbook circular-citation pattern — many apparently independent write-ups, one
un-locatable origin.

The prior recorded in the brief is **correct on mechanism**: the figure is a bad inference from a
real statistic. The real statistic is that **~10% of contracts are exercised**; the myth infers
that the other ~90% (softened to 80%) therefore expired worthless. That inference silently
discards the largest category — positions **closed in the secondary market before expiry**.

Best available sourced figures, by tier:

**(a) / (b) / (c) — first-party industry body.** The Options Industry Council (OIC, the
OCC-and-exchange-sponsored education arm) states on its Options Exercise FAQ
([optionseducation.org](https://www.optionseducation.org/referencelibrary/faq/options-exercise)):

> "Historically, more than **72%** of all option contracts are closed out in the market prior to
> expiration. Additionally, another **22%** expire without value while the remaining **6%** get
> exercised."

**[ABSTRACT-LEVEL]** — this is a first-party statement but carries **no date range and no
underlying dataset**, so it cannot be audited. Note it does **not** match the other commonly
circulated breakdown (~10% exercised / 55–60% closed / 30–35% worthless), which is attributed to
CBOE but which this round **could not trace to any CBOE publication** — the most careful
secondary write-up found ([MoneyShow, 2015](https://www.moneyshow.com/articles/optionsidea-43293/))
cites only a bare hyperlink, no report. **Two mutually inconsistent "official" breakdowns are in
circulation and neither is independently auditable.**

**(b) — measured, auditable, and the strongest number found.** Amaya, Garcia-Ares, Pearson &
Vasquez, using Cboe exchange data with opening/closing flags
([PDF](https://cdn.cboe.com/resources/education/research_publications/Retail_Profitability.pdf)),
Jan 2020 – Jun 2023:

> "42.4% (57.6%) of Cboe SLIM trades are closing (opening) trades... **These results imply that
> most options positions are not held to expiration.** ...only 14.6% = 57.3% − 42.7% of volume is
> due to opening trades that are held to expiration, and only **14.6%/57.3% = 25.5% of opening
> trades are held to expiration**."

**[VERIFIED]** — ~**25.5% of retail-proxy opening positions reach expiry; ~74.5% are closed
first.** This is a directly measured, reproducible figure from exchange data with true
opening/closing flags, and it is the single best support for the "closed before expiry" leg.
Scope limit: **Cboe SLIM (retail price-improvement auction) trades only**, not all options.

**Bottom line for the skill:** "80% of options expire worthless" is **[UNVERIFIED] and should be
treated as false as commonly stated.** The defensible replacement is: *most option positions are
closed before expiration rather than held to expiry* — ~74.5% of retail-proxy opening trades on
Cboe (Jan 2020 – Jun 2023) [VERIFIED], or ~72% of all contracts per OIC [ABSTRACT-LEVEL]. The
share **expiring worthless** is nowhere near 80%: OIC says **22%**, and no auditable primary
source for any figure in this category was located. **State the 22% with its provenance weakness
attached, or don't state a number at all.**

### Bonus — CBOE's "New Evidence on the Performance of Customer Options Trades" — **READ IN FULL**

**[VERIFIED]** Amaya, Garcia-Ares, Pearson & Vasquez, **April 7, 2025**
([PDF](https://cdn.cboe.com/resources/education/research_publications/Retail_Profitability.pdf)).
Read in full via the zlib route. This paper **materially destabilises the "retail loses" consensus**
and belongs in the evidence base.

It is a **direct rebuttal** of Bryzgalova, Pavlova & Sikorskaya (2023, *Journal of Finance*), whose
finding that retail options traders lose money is one of the load-bearing citations in this whole
literature. Two methodological attacks, both concrete:

1. **Wrong terminal value.** BPS compute the profit of options *held to expiration* using the NBBO
   bid-ask midpoint of the last trade rather than the **actual expiration value**. For a
   soon-to-expire OTM option quoted 0 / $0.20, that books a $0.10 value on a contract worth zero.
   Because offers are always ≥ 1 tick, this is **systematically biased**. *"The net effect of using
   the expiration values in place of the NBBO midpoints is that the estimate of the profitability of
   options held to expiration **changes from negative to positive**, using the same OPRA trade data
   that BPS use."*
2. **Wrong trade direction.** BPS infer buy/sell from a quote rule. Against Cboe's actual
   counterparty records, that rule **misclassifies 42.4% of trades and 42.6% of volume.**

Their own estimates, using true directions and true expiration values:

| Sample | Cboe customer SLIM net profit | t-stat |
|---|---|---|
| Jan 2020 – Jun 2023 | **+$0.34 million/day** | 0.29 |
| Jan 2020 – Jun 2021 | **+$2.07 million/day** | 1.19 |

vs. BPS's **−$5.03M/day** (10-day horizon) and **−$1.63M/day** (held to expiration).

**Two disclosures that must travel with this paper, both stated by the authors themselves:**

- **Conflict of interest.** *"This paper was supported by a data research grant from The Options
  Institute, the educational division of Cboe Global Markets."* The exchange operator whose retail
  volume is at stake funded the data access for a paper concluding retail does fine. That does not
  make it wrong — the methodological critiques are specific and checkable — but it is a funding
  interest aligned with the result and must be disclosed on every citation.
- **The authors do not claim a positive edge.** *"our performance estimates are not statistically
  significant at conventional significance levels."* They claim only: *"our results provide no
  evidence that Cboe customer SLIM trades are unprofitable."* **Absence of evidence of loss, not
  evidence of profit.** Anyone citing this as "retail options traders are profitable" is
  overstating it, in the same way the secondary sources overstated the papers above.

Also verified and consistent with the structural story in section (b): *"Purchases of calls and
sales of puts display positive performance during both sample periods, while purchases of puts and
sales of calls are not"* — with the authors noting this is what you'd expect mechanically, since
the S&P 500 rose **33%** and **38%** over the two sample windows. **That is a beta artifact, not
skill, and must not be read as a strategy result.**

---

### What this round changes about the document above

1. **Section (b)'s [UNVERIFIED] flag on −0.9% / −3.4% should be read as superseded** — both are
   [VERIFIED], with the "small relative to costs" framing attached.
2. **Section (b)'s and (c)'s use of "relatively sophisticated on average" to rebut the gambling
   narrative is not supported by the paper.** The skewness result rebuts it; the sophistication
   line is a self-selection caveat. Cite the skewness, drop the sophistication.
3. **The 0DTE "conflicting figures" table should be read as resolved**, not as live conflict —
   two paper vintages plus one likely truncation artifact, all within $184k–$680k/day.
4. **The "−$8.05 / +$4.55" per-contract asymmetry is refuted as stated** and must not be carried
   into the skill in per-contract form.
5. **Section (b) presents de Silva/So/Smith as the strongest result without noting it is
   contested.** Both Bogousslavsky & Muravyev and the Cboe-funded Amaya et al. paper attack the
   proxy-based loss estimates on method. The skill should encode this as **a live dispute about
   retail-proxy construction**, not a settled loss magnitude.
6. **"80% expire worthless" stays [UNVERIFIED] and should be marked false-as-stated**, with the
   ~25.5%-held-to-expiry figure offered as the sourced replacement.

### Still open after this round

- **SSRN 4682388's current (Feb 2025) full text.** The $20bn / "nearly half of 2022" abstract
  could not be matched to a readable version. The Aug-2024 full text is what is verified here.
- **No auditable primary source for any "% of options expiring worthless" figure.** OIC's
  72/22/6 is first-party but undated and datasetless; the 10/55–60/30–35 breakdown could not be
  traced to CBOE at all. **A genuine OCC exercise-and-expiration dataset was not located** —
  theocc.com's historical volume statistics pages returned HTTP 403 to automated fetch. Worth a
  manual look.
- **Bryzgalova, Pavlova & Sikorskaya (2023, *Journal of Finance*) has not been read directly** —
  only through Amaya et al.'s rebuttal of it. Reading one side of a dispute through the other
  side's summary is exactly the failure mode this document exists to avoid. **Read BPS directly
  before encoding either side.**
- **Carr & Wu (2009) and the BXM figures remain [SECONDARY]** — untouched this round.
