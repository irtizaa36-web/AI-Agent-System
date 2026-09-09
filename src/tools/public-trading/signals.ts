/**
 * The register of signals that have cleared the evidence bar in
 * `.agents/skills/crypto-signal-eval/SKILL.md`.
 *
 * **It is empty, and that is the current, correct state of the world.** No
 * signal has passed the backtest plus random-entry baseline test yet, so this
 * system monitors and reports; it does not propose trades. Requirement 3 of the
 * build brief and BRIEFING.md ("Currently zero validated signals exist") both
 * say so directly.
 *
 * Encoding that as an empty registry rather than a comment or a disabled flag
 * is deliberate: `proposeDrafts` cannot return a draft while this array is
 * empty, so the monitor-only posture holds by construction. Turning drafting on
 * means adding an entry here, which is a reviewable diff that has to state the
 * evidence — and `validateSignalEvidence` below refuses an entry that does not
 * meet the skill's own kill criteria.
 */

/** Evidence required before a signal may be registered. Mirrors the skill's "Interpreting results". */
export interface SignalEvidence {
  /** Where the numbers come from — a committed results file, not a chat message. */
  readonly source: string;
  /** Causal story for why this should predict returns, stated before any backtest. */
  readonly mechanism: string;
  /** True when the data actually contains the causal variable, not a price proxy for it. */
  readonly causalVariableAvailable: boolean;
  readonly tradeCount: number;
  /** Mean return per trade after costs, as a ratio. Must be positive. */
  readonly meanReturnAfterCosts: number;
  /** Round-trip cost the backtest charged. Never zero. */
  readonly roundTripCostAssumed: number;
  /** Fraction of random-entry draws this signal beat, same exit rules. */
  readonly beatsRandomBaselineFraction: number;
  /** Configurations swept, and how many were profitable — a lone winner is a selection artifact. */
  readonly configurationsTested: number;
  readonly configurationsProfitable: number;
  /** True once parameters have been tested on data they were not chosen on. */
  readonly walkForwardValidated: boolean;
}

export interface ValidatedSignal {
  readonly id: string;
  readonly symbol: string;
  readonly description: string;
  readonly validatedOn: string;
  readonly evidence: SignalEvidence;
  /** Expected edge per round trip, as a ratio, used to size against cost drag. */
  readonly expectedEdgePerTrade: number;
}

/**
 * Signals cleared for drafting. Empty by design — see the file comment.
 *
 * Do not add the volume-expansion breakout here. It was tested across 27
 * configurations on 365 daily DOT bars; every one lost money after costs, and
 * it ranked worse than 78% of 2000 random-entry draws. The skill records that
 * as settled and explicitly warns against resurrecting it by adding parameters.
 */
export const VALIDATED_SIGNALS: readonly ValidatedSignal[] = [];

/** Why a candidate signal was refused. */
export interface SignalRejection {
  readonly reason: string;
}

/**
 * Applies the skill's kill criteria to a candidate signal's evidence.
 *
 * A signal that survives this is a *candidate*, not a conclusion — the skill is
 * explicit that the next step is walk-forward validation, not deployment, which
 * is why `walkForwardValidated` is checked last and separately.
 */
export function validateSignalEvidence(evidence: SignalEvidence): readonly SignalRejection[] {
  const rejections: SignalRejection[] = [];

  if (!evidence.causalVariableAvailable) {
    rejections.push({
      reason:
        "The data does not contain the signal's causal variable. Public's connector returns OHLCV only — no funding " +
        "rate, no open interest, no liquidation data — so a positioning-driven signal built on it is missing its " +
        "cause and is measuring the effect after the fact.",
    });
  }
  if (evidence.roundTripCostAssumed <= 0) {
    rejections.push({ reason: "Backtested at zero round-trip cost. Costs are the dominant term at this position size." });
  }
  if (evidence.meanReturnAfterCosts <= 0) {
    rejections.push({ reason: "Mean return per trade is negative or zero after costs." });
  }
  if (evidence.beatsRandomBaselineFraction <= 0.5) {
    rejections.push({
      reason:
        `Beats only ${(evidence.beatsRandomBaselineFraction * 100).toFixed(0)}% of random-entry draws with the same ` +
        "exit rules — no edge distinguishable from noise.",
    });
  }
  if (evidence.tradeCount < 30) {
    rejections.push({
      reason: `Only ${evidence.tradeCount} trades. Too few to separate skill from luck; the skill's floor is ~30.`,
    });
  }
  if (evidence.configurationsTested > 1 && evidence.configurationsProfitable <= 1) {
    rejections.push({
      reason:
        `${evidence.configurationsProfitable} of ${evidence.configurationsTested} swept configurations were ` +
        "profitable. A single winner among many losers is a selection artifact, not an edge.",
    });
  }
  if (!evidence.walkForwardValidated) {
    rejections.push({
      reason: "Not walk-forward validated. Parameters have only been tested on the data they were chosen on.",
    });
  }
  if (evidence.mechanism.trim() === "") {
    rejections.push({ reason: "No stated mechanism. A signal justified only by backtest results is an overfitting risk." });
  }

  return rejections;
}

/** True when at least one signal has cleared the bar and drafting is therefore possible at all. */
export function draftingEnabled(signals: readonly ValidatedSignal[] = VALIDATED_SIGNALS): boolean {
  return signals.length > 0;
}
