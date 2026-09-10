import type { PublicTradingClient } from "./client";
import { roundTo } from "./decimal";
import { draftingEnabled, type ValidatedSignal, VALIDATED_SIGNALS } from "./signals";
import type { DraftOrder, PortfolioSnapshot, PreflightResult } from "./types";

/**
 * The trade-drafting gate.
 *
 * Nothing here places an order — `PublicTradingClient` exposes no method that
 * could. A "draft" is a described order plus its preflight numbers and the
 * reasoning behind it, written into a review file for a human to accept or
 * reject. That matches the repo's standing rule that reading and drafting are
 * separate from consequential execution (README safety principle 1), and the
 * handoff rule that financial automation stays in research, simulation,
 * monitoring and draft recommendations unless a specific live action is
 * separately authorised (`docs/BIG-BOSS-HANDOFF.md`).
 *
 * While `VALIDATED_SIGNALS` is empty this path produces no drafts at all. It is
 * built, tested and gated now so that registering a signal later is a one-line
 * change to a reviewed list rather than a rushed build against live money.
 */

/**
 * The round-trip cost the account actually bears, from `BRIEFING.md`: the SOL
 * round trip moved -1.1% in price but cost the position 1.75%, leaving ~0.65
 * points of spread and slippage, which the backtest work rounds to 0.75%.
 *
 * Treat this as a floor to beat, not a fixed fee. `costDragBaseline` in a
 * review is recomputed from realised fills each run, so if the true drag is
 * higher this number should be revised upward — the briefing asks for exactly
 * that once more closed trades accumulate.
 */
export const ROUND_TRIP_COST_BASELINE = 0.0075;

/** A trade this system would propose, with every gate it had to clear recorded. */
export interface TradeDraft {
  readonly order: DraftOrder;
  readonly signalId: string;
  readonly rationale: string;
  readonly expectedEdgePerTrade: number;
  readonly expectedCostDrag: number;
  /** Edge left after cost drag. Must be positive for the draft to stand. */
  readonly expectedNetEdge: number;
  readonly preflight: PreflightResult;
  readonly buyingPowerAtDraft: number;
}

/** A trade that was considered and refused, with the reason kept for the review. */
export interface RejectedDraft {
  readonly order: DraftOrder;
  readonly signalId: string;
  readonly reasons: readonly string[];
}

export interface DraftOutcome {
  readonly drafts: readonly TradeDraft[];
  readonly rejected: readonly RejectedDraft[];
  /** Set when drafting was skipped wholesale rather than per-candidate. */
  readonly suppressedReason?: string;
}

/** A trade idea a registered signal produced, before any gate has run. */
export interface DraftCandidate {
  readonly signal: ValidatedSignal;
  readonly order: DraftOrder;
  readonly rationale: string;
}

export interface DraftOptions {
  readonly accountId: string;
  readonly snapshot: PortfolioSnapshot;
  readonly client: PublicTradingClient;
  /** Round-trip cost to charge against expected edge. Defaults to the briefing's baseline. */
  readonly costBaseline?: number;
  /** Overridable for tests; defaults to the empty production registry. */
  readonly signals?: readonly ValidatedSignal[];
}

/** The dollar value an order would consume, from an explicit amount or quantity times price. */
export function orderNotional(order: DraftOrder): number {
  if (order.amount !== undefined) return order.amount;
  if (order.quantity !== undefined && order.limitPrice !== undefined) return order.quantity * order.limitPrice;
  return 0;
}

/**
 * Runs every gate over a set of candidates and returns only those that pass.
 *
 * The gates, in the order requirement 4 of the brief lists them:
 *
 * 1. **Validated signal.** A candidate whose signal is not in the registry is
 *    refused outright — an unvalidated trigger is a hypothesis, not a signal.
 * 2. **Buying power.** The order's notional must fit inside `buyingPower`. This
 *    is the check the audit found missing: 16 buys totalling ~$57 were queued
 *    against $14.91 and most could not fill.
 * 3. **Cost drag.** Expected edge must survive the round-trip cost. At these
 *    position sizes the drag routinely exceeds the entire hypothetical edge,
 *    which is the mechanism behind the realised losses in the briefing.
 * 4. **Preflight.** `preflight_order` validates the exact order against the
 *    broker. A rejection, or a buying-power requirement above what is
 *    available, kills the draft.
 */
export async function proposeDrafts(
  candidates: readonly DraftCandidate[],
  options: DraftOptions,
): Promise<DraftOutcome> {
  const signals = options.signals ?? VALIDATED_SIGNALS;
  const costBaseline = options.costBaseline ?? ROUND_TRIP_COST_BASELINE;

  if (!draftingEnabled(signals)) {
    return {
      drafts: [],
      rejected: [],
      suppressedReason:
        "No validated signal is registered, so this run monitors and reports only. Zero signals have cleared the " +
        "backtest plus random-entry baseline bar in .agents/skills/crypto-signal-eval/SKILL.md. Until one does, " +
        "proposing a trade would be acting on a hypothesis.",
    };
  }

  const drafts: TradeDraft[] = [];
  const rejected: RejectedDraft[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    const registered = signals.find((signal) => signal.id === candidate.signal.id);

    if (registered === undefined) {
      rejected.push({
        order: candidate.order,
        signalId: candidate.signal.id,
        reasons: [
          `Signal "${candidate.signal.id}" is not in the validated registry. An unvalidated trigger is a hypothesis, ` +
            "not a signal, and is not eligible to produce a draft.",
        ],
      });
      continue;
    }

    const notional = orderNotional(candidate.order);
    if (notional <= 0) {
      reasons.push("Order notional could not be determined — no amount, and no quantity/limit-price pair.");
    } else if (notional > options.snapshot.buyingPower) {
      reasons.push(
        `Order notional $${notional.toFixed(2)} exceeds buying power $${options.snapshot.buyingPower.toFixed(2)}. ` +
          "It could not fill, so it is not drafted.",
      );
    }

    const expectedNetEdge = registered.expectedEdgePerTrade - costBaseline;
    if (expectedNetEdge <= 0) {
      reasons.push(
        `Expected edge ${(registered.expectedEdgePerTrade * 100).toFixed(2)}% does not survive the ` +
          `${(costBaseline * 100).toFixed(2)}% round-trip cost baseline (net ` +
          `${(expectedNetEdge * 100).toFixed(2)}%).`,
      );
    }

    if (reasons.length > 0) {
      rejected.push({ order: candidate.order, signalId: registered.id, reasons });
      continue;
    }

    // Preflight last: it is the only gate that costs a network call, so the
    // cheap arithmetic gates run first and a hopeless candidate never reaches it.
    const preflight = await options.client.preflightOrder(options.accountId, candidate.order);
    if (!preflight.accepted) {
      rejected.push({
        order: candidate.order,
        signalId: registered.id,
        reasons: [`preflight_order rejected the order: ${preflight.message ?? "no reason given by the broker"}.`],
      });
      continue;
    }
    if (preflight.buyingPowerRequired > options.snapshot.buyingPower) {
      rejected.push({
        order: candidate.order,
        signalId: registered.id,
        reasons: [
          `preflight_order reports a buying-power requirement of $${preflight.buyingPowerRequired.toFixed(2)} ` +
            `against $${options.snapshot.buyingPower.toFixed(2)} available.`,
        ],
      });
      continue;
    }

    drafts.push({
      order: candidate.order,
      signalId: registered.id,
      rationale: candidate.rationale,
      expectedEdgePerTrade: registered.expectedEdgePerTrade,
      expectedCostDrag: costBaseline,
      expectedNetEdge: roundTo(expectedNetEdge, 6),
      preflight,
      buyingPowerAtDraft: options.snapshot.buyingPower,
    });
  }

  return { drafts, rejected };
}
