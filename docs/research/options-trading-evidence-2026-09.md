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
