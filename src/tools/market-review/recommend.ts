import { roundTo } from "../public-trading/decimal";
import { worstSeverity, type AnalysisFlag, type ContractAnalysis } from "./analysis";
import { describeContract } from "./osi";
import type { CatalystFlag } from "./types";

/**
 * Ranking, directional calls, and position sizing.
 *
 * This module produces the thing the operator asked for and the rest of the
 * repo deliberately avoids: a ranked list with a direction and a suggested
 * contract count. Three structural constraints keep that honest.
 *
 * 1. **The direction is an input, never a derivation.** Nothing here predicts
 *    anything. A call arrives from the caller — the session that read the news
 *    and the trend — carrying its own stated mechanism, and this module refuses
 *    to emit a recommendation whose mechanism is empty. That mirrors the
 *    procedure's first step in `.agents/skills/options-trading-eval/SKILL.md`
 *    ("State the mechanism first"): an idea whose only support is "it's moving"
 *    does not get to become a numbered recommendation.
 *
 * 2. **Sizing is arithmetic against a stated risk budget, not conviction.** The
 *    contract count is `floor(riskBudget / premiumPerContract)`. There is no
 *    model translating "HIGH conviction" into a bigger position, because no
 *    evidence in this project supports one.
 *
 * 3. **Sizing is not checked against live buying power, by explicit
 *    instruction.** That was a deliberate operator decision, made after the
 *    conflict was raised, and it is a real gap: a suggested size can exceed what
 *    the account could actually buy. Every rendered recommendation therefore
 *    carries `SIZING_DISCLAIMER` verbatim. The disclaimer is the mitigation, so
 *    it is not optional and not summarised away.
 */

export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";

export type Conviction = "LOW" | "MEDIUM" | "HIGH";

/** The standing disclaimer that must appear with any sized recommendation. */
export const SIZING_DISCLAIMER =
  "Suggested size is arithmetic against a stated risk budget and is **not** checked against this " +
  "account's live buying power — a size shown here may exceed what the account can actually buy. " +
  "Verify buying power before acting. Nothing here is an order; placing one is a separate, explicit step.";

/** A caller-supplied view on a name. The mechanism is mandatory and load-bearing. */
export interface Thesis {
  readonly symbol: string;
  readonly direction: Direction;
  readonly conviction: Conviction;
  /**
   * Why this should pay — the causal reason, not the observation. "Momentum" and
   * "it's up on volume" are observations; this field is rejected if it is empty
   * and should be rejected by a human reader if it is only an observation.
   */
  readonly mechanism: string;
  /** Where the view came from: headlines, filings, prints. Rendered for audit. */
  readonly sources?: readonly string[];
}

/** How many dollars one idea may put at risk. */
export interface SizingPolicy {
  /** Maximum premium to commit to a single idea, in dollars. */
  readonly riskBudgetUsd: number;
  /** Hard ceiling on contracts regardless of budget arithmetic. */
  readonly maxContracts?: number;
}

/** A transparent, inspectable breakdown of how a rank was reached. */
export interface ScoreComponent {
  readonly label: string;
  readonly delta: number;
  readonly why: string;
}

export interface SizedRecommendation {
  readonly rank: number;
  readonly symbol: string;
  readonly direction: Direction;
  readonly conviction: Conviction;
  readonly mechanism: string;
  readonly sources: readonly string[];
  /** The contract this recommendation is about, when it is an options idea. */
  readonly contractLabel?: string;
  /**
   * That contract's OSI symbol — its identity, carried alongside the human
   * label so downstream consumers match on the contract rather than guessing
   * from the underlying. Matching by underlying silently attached a call's
   * breakeven to a put recommendation once; the identity closes that hole.
   */
  readonly osiSymbol?: string;
  readonly premiumPerContract?: number;
  readonly contracts?: number;
  readonly totalPremium?: number;
  /**
   * The whole premium, for a long option. Stated separately from
   * `totalPremium` because they are the same number for a different reason:
   * one is what you pay, the other is what you can lose.
   */
  readonly maxLossUsd?: number;
  readonly score: number;
  readonly scoreComponents: readonly ScoreComponent[];
  readonly risks: readonly AnalysisFlag[];
  /** Evidence-derived caveats, each traceable to the options-trading-eval skill. */
  readonly evidenceCaveats: readonly string[];
  /** True when a BLOCK-severity flag means the numbers should not be acted on. */
  readonly blocked: boolean;
}

/**
 * Contract count from a risk budget.
 *
 * Floors rather than rounds: rounding up would commit more than the stated
 * budget, which is the one direction the arithmetic must never drift.
 */
export function suggestContracts(premiumPerContract: number, policy: SizingPolicy): number {
  if (!Number.isFinite(premiumPerContract) || premiumPerContract <= 0) return 0;
  if (!Number.isFinite(policy.riskBudgetUsd) || policy.riskBudgetUsd <= 0) return 0;
  const byBudget = Math.floor(policy.riskBudgetUsd / premiumPerContract);
  const capped = policy.maxContracts === undefined ? byBudget : Math.min(byBudget, policy.maxContracts);
  return Math.max(0, capped);
}

/**
 * Evidence caveats attached from the skill's settled findings.
 *
 * These are not general disclaimers; each one fires on a specific, checkable
 * condition and carries the confidence label the research review assigned it.
 * The earnings case is deliberately a penalty rather than a highlight: buying a
 * long option into a known catalyst is the single worst documented case for
 * retail, not the opportunity it is usually taken for.
 */
export function evidenceCaveatsFor(
  analysis: ContractAnalysis | undefined,
  catalysts: readonly CatalystFlag[],
): readonly string[] {
  const caveats: string[] = [];

  const earnings = catalysts.find((catalyst) => catalyst.kind === "EARNINGS");
  if (earnings !== undefined && analysis !== undefined) {
    caveats.push(
      `Long option into an earnings window (${earnings.date}, ${earnings.tradingDaysAway} trading day(s) away). ` +
        "[VERIFIED] de Silva/So/Smith: retail loses 5–9% on average around earnings announcements, worsening to " +
        "10–14% where expected volatility is highest — the worst documented case for retail options buyers, not the best.",
    );
  }

  const macro = catalysts.find((catalyst) => catalyst.kind === "MACRO");
  if (macro !== undefined && analysis !== undefined) {
    caveats.push(
      `Macro event inside the window (${macro.detail}, ${macro.date}). The same catalyst finding applies: ` +
        "premium is priced for the move the market already expects, and IV crush follows resolution.",
    );
  }

  if (analysis?.spreadShareOfMid !== undefined && analysis.spreadShareOfMid >= 0.05) {
    caveats.push(
      "[VERIFIED] Costs, not directional error, are the dominant loss mechanism: roughly 60% of 0DTE retail " +
        "daily losses are transaction costs. This contract's spread is a material share of its premium before " +
        "any thesis plays out.",
    );
  }

  if (analysis?.thetaShareOfPremium !== undefined && analysis.thetaShareOfPremium >= 0.1) {
    caveats.push(
      `Theta alone removes ${(analysis.thetaShareOfPremium * 100).toFixed(1)}% of the premium per day, so the ` +
        "thesis has to resolve faster than decay, in the direction predicted, by more than the breakeven move.",
    );
  }

  if (analysis !== undefined && analysis.delta !== undefined) {
    caveats.push(
      `Delta ${analysis.delta.toFixed(2)} is a rough proxy for finishing in the money at all — not the ` +
        "probability of profit, which is lower because breakeven sits beyond the strike.",
    );
  }

  return caveats;
}

export interface RankInput {
  readonly thesis: Thesis;
  readonly analysis?: ContractAnalysis;
  readonly catalysts?: readonly CatalystFlag[];
}

export interface RankOptions {
  readonly sizing: SizingPolicy;
}

/**
 * Scores an idea from measurable properties only.
 *
 * Every component is a penalty against a neutral 100 for something observable —
 * a wide spread, heavy decay, a blocking data problem, a catalyst in the window.
 * Nothing in the score claims the idea will work; a high score means "the
 * mechanics of this contract are least likely to work against you," which is a
 * different and much weaker claim than "this will pay." Conviction is recorded
 * but deliberately does not move the score: it is the caller's confidence, not
 * evidence.
 */
function scoreIdea(input: RankInput): { score: number; components: ScoreComponent[] } {
  const components: ScoreComponent[] = [];
  const analysis = input.analysis;
  const catalysts = input.catalysts ?? [];

  if (analysis?.spreadShareOfMid !== undefined) {
    const penalty = roundTo(Math.min(40, analysis.spreadShareOfMid * 200), 2);
    if (penalty > 0) {
      components.push({
        label: "Bid/ask spread",
        delta: -penalty,
        why: `Spread is ${(analysis.spreadShareOfMid * 100).toFixed(1)}% of mid — a cost paid before the thesis starts.`,
      });
    }
  }

  if (analysis?.thetaShareOfPremium !== undefined) {
    const penalty = roundTo(Math.min(30, analysis.thetaShareOfPremium * 100), 2);
    if (penalty > 0) {
      components.push({
        label: "Theta decay",
        delta: -penalty,
        why: `Decay removes ${(analysis.thetaShareOfPremium * 100).toFixed(1)}% of premium per day.`,
      });
    }
  }

  if (analysis !== undefined && Number.isFinite(analysis.breakevenMoveRatio)) {
    const required = Math.abs(analysis.breakevenMoveRatio);
    const penalty = roundTo(Math.min(30, required * 300), 2);
    if (penalty > 0) {
      components.push({
        label: "Required move",
        delta: -penalty,
        why: `Breakeven needs a ${(required * 100).toFixed(2)}% move in the underlying.`,
      });
    }
  }

  const earnings = catalysts.find((catalyst) => catalyst.kind === "EARNINGS");
  if (earnings !== undefined) {
    components.push({
      label: "Earnings in window",
      delta: -25,
      why:
        "Buying premium into an earnings print is the worst documented case for retail [VERIFIED], " +
        "so proximity counts against a long-option idea rather than for it.",
    });
  }

  const blockingFlags = (analysis?.flags ?? []).filter((flag) => flag.severity === "BLOCK");
  if (blockingFlags.length > 0) {
    components.push({
      label: "Blocking data problem",
      delta: -100,
      why: blockingFlags.map((flag) => flag.code).join(", "),
    });
  }

  const score = roundTo(
    components.reduce((total, component) => total + component.delta, 100),
    2,
  );
  return { score, components };
}

/**
 * Builds the ranked recommendation list.
 *
 * Throws on a thesis with no stated mechanism rather than emitting a blank one:
 * a recommendation whose reasoning field is empty is exactly what this repo's
 * evidence rules exist to prevent, and failing loudly at build time is better
 * than a report that looks complete and says nothing.
 */
export function rankRecommendations(
  inputs: readonly RankInput[],
  options: RankOptions,
): readonly SizedRecommendation[] {
  for (const input of inputs) {
    if (input.thesis.mechanism.trim() === "") {
      throw new Error(
        `Thesis for ${input.thesis.symbol} has no stated mechanism. A recommendation without a causal ` +
          "reason is not publishable — state why this should pay, or drop the idea.",
      );
    }
  }

  const scored = inputs.map((input) => {
    const { score, components } = scoreIdea(input);
    const analysis = input.analysis;
    const catalysts = input.catalysts ?? [];
    const premiumPerContract = analysis?.entryPricePerContract;
    const contracts =
      premiumPerContract === undefined ? undefined : suggestContracts(premiumPerContract, options.sizing);
    const totalPremium =
      contracts === undefined || premiumPerContract === undefined
        ? undefined
        : roundTo(contracts * premiumPerContract, 2);

    return {
      input,
      score,
      components,
      analysis,
      catalysts,
      premiumPerContract,
      contracts,
      totalPremium,
    };
  });

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.input.thesis.symbol.localeCompare(b.input.thesis.symbol);
    })
    .map((entry, index): SizedRecommendation => {
      const { input, analysis } = entry;
      const blocked = worstSeverity(analysis?.flags ?? []) === "BLOCK";

      return {
        rank: index + 1,
        symbol: input.thesis.symbol,
        direction: input.thesis.direction,
        conviction: input.thesis.conviction,
        mechanism: input.thesis.mechanism.trim(),
        sources: input.thesis.sources ?? [],
        ...(analysis === undefined
          ? {}
          : { contractLabel: describeContract(analysis.contract), osiSymbol: analysis.contract.osiSymbol }),
        ...(entry.premiumPerContract === undefined ? {} : { premiumPerContract: entry.premiumPerContract }),
        ...(entry.contracts === undefined ? {} : { contracts: entry.contracts }),
        ...(entry.totalPremium === undefined ? {} : { totalPremium: entry.totalPremium }),
        // For a long option the entire premium is at risk, so max loss equals
        // total premium. Named separately because readers reliably conflate
        // "what it costs" with "what I can lose" on multi-contract sizes.
        ...(entry.totalPremium === undefined ? {} : { maxLossUsd: entry.totalPremium }),
        score: entry.score,
        scoreComponents: entry.components,
        risks: analysis?.flags ?? [],
        evidenceCaveats: evidenceCaveatsFor(analysis, entry.catalysts),
        blocked,
      };
    });
}
