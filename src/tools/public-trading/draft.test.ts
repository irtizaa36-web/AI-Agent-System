import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicTradingClient } from "./client";
import { orderNotional, proposeDrafts, ROUND_TRIP_COST_BASELINE, type DraftCandidate } from "./draft";
import { draftingEnabled, validateSignalEvidence, VALIDATED_SIGNALS, type ValidatedSignal } from "./signals";
import type { PortfolioSnapshot, PreflightResult } from "./types";

const SNAPSHOT: PortfolioSnapshot = {
  accountId: "5OI24720",
  accountType: "BROKERAGE",
  buyingPower: 14.91,
  cash: 146.6,
  totalAccountValue: 367.1,
  equity: [],
  positions: [],
  openOrders: [],
};

function stubClient(preflight: Partial<PreflightResult> = {}): PublicTradingClient & { preflightCalls: number } {
  const client = {
    preflightCalls: 0,
    async getPortfolio() {
      throw new Error("not used");
    },
    async getHistory() {
      return [];
    },
    async getQuotes() {
      return [];
    },
    async getPriceHistory() {
      return [];
    },
    async preflightOrder(): Promise<PreflightResult> {
      client.preflightCalls += 1;
      return {
        accepted: true,
        estimatedCommission: 0,
        estimatedRegulatoryFees: 0,
        orderValue: 5,
        buyingPowerRequired: 5,
        raw: {},
        ...preflight,
      };
    },
  };
  return client as unknown as PublicTradingClient & { preflightCalls: number };
}

const GOOD_SIGNAL: ValidatedSignal = {
  id: "test-signal",
  symbol: "DOT",
  description: "test only",
  validatedOn: "2026-09-09",
  expectedEdgePerTrade: 0.03,
  evidence: {
    source: "docs/research/test.md",
    mechanism: "test",
    causalVariableAvailable: true,
    tradeCount: 40,
    meanReturnAfterCosts: 0.02,
    roundTripCostAssumed: 0.0075,
    beatsRandomBaselineFraction: 0.9,
    configurationsTested: 12,
    configurationsProfitable: 9,
    walkForwardValidated: true,
  },
};

function candidate(overrides: Partial<DraftCandidate["order"]> = {}, signal = GOOD_SIGNAL): DraftCandidate {
  return {
    signal,
    rationale: "test rationale",
    order: { symbol: "DOT", instrumentType: "CRYPTO", side: "BUY", orderType: "LIMIT", amount: 5, limitPrice: 1.2, ...overrides },
  };
}

test("the production registry is empty, so the system monitors and reports only", () => {
  assert.deepEqual(VALIDATED_SIGNALS, []);
  assert.equal(draftingEnabled(), false);
});

test("proposeDrafts suppresses everything while no signal is validated", async () => {
  const client = stubClient();
  const outcome = await proposeDrafts([candidate()], { accountId: "acct", snapshot: SNAPSHOT, client });

  assert.deepEqual(outcome.drafts, []);
  assert.ok(outcome.suppressedReason?.includes("No validated signal"));
  // No preflight call either: nothing should touch the connector when drafting is off.
  assert.equal(client.preflightCalls, 0);
});

test("proposeDrafts drafts a candidate that clears every gate", async () => {
  const client = stubClient();
  const outcome = await proposeDrafts([candidate()], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client,
    signals: [GOOD_SIGNAL],
  });

  assert.equal(outcome.drafts.length, 1);
  assert.equal(outcome.rejected.length, 0);
  const draft = outcome.drafts[0]!;
  assert.equal(draft.expectedCostDrag, ROUND_TRIP_COST_BASELINE);
  assert.ok(Math.abs(draft.expectedNetEdge - 0.0225) < 1e-6);
  assert.equal(draft.buyingPowerAtDraft, 14.91);
});

test("proposeDrafts refuses an order larger than buying power — the check the audit found missing", async () => {
  const client = stubClient();
  const outcome = await proposeDrafts([candidate({ amount: 50 })], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client,
    signals: [GOOD_SIGNAL],
  });

  assert.equal(outcome.drafts.length, 0);
  assert.ok(outcome.rejected[0]!.reasons[0]!.includes("exceeds buying power"));
  // Rejected on arithmetic before spending a network call.
  assert.equal(client.preflightCalls, 0);
});

test("proposeDrafts refuses an edge that does not survive the cost baseline", async () => {
  const thinSignal = { ...GOOD_SIGNAL, expectedEdgePerTrade: 0.005 };
  const outcome = await proposeDrafts([candidate({}, thinSignal)], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client: stubClient(),
    signals: [thinSignal],
  });

  assert.equal(outcome.drafts.length, 0);
  assert.ok(outcome.rejected[0]!.reasons[0]!.includes("does not survive"));
});

test("proposeDrafts refuses a candidate whose signal is not in the registry", async () => {
  const outcome = await proposeDrafts([candidate({}, { ...GOOD_SIGNAL, id: "unregistered" })], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client: stubClient(),
    signals: [GOOD_SIGNAL],
  });

  assert.equal(outcome.drafts.length, 0);
  assert.ok(outcome.rejected[0]!.reasons[0]!.includes("not in the validated registry"));
});

test("proposeDrafts refuses when preflight rejects, and surfaces the broker's reason verbatim", async () => {
  const outcome = await proposeDrafts([candidate()], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client: stubClient({ accepted: false, message: "market closed" }),
    signals: [GOOD_SIGNAL],
  });

  assert.equal(outcome.drafts.length, 0);
  assert.ok(outcome.rejected[0]!.reasons[0]!.includes("market closed"));
});

test("proposeDrafts refuses when preflight's buying-power requirement exceeds what is available", async () => {
  const outcome = await proposeDrafts([candidate()], {
    accountId: "acct",
    snapshot: SNAPSHOT,
    client: stubClient({ buyingPowerRequired: 100 }),
    signals: [GOOD_SIGNAL],
  });

  assert.equal(outcome.drafts.length, 0);
  assert.ok(outcome.rejected[0]!.reasons[0]!.includes("buying-power requirement"));
});

test("orderNotional resolves an explicit amount or a quantity/limit pair, and 0 when neither", () => {
  assert.equal(orderNotional({ symbol: "DOT", instrumentType: "CRYPTO", side: "BUY", orderType: "LIMIT", amount: 5 }), 5);
  assert.equal(
    orderNotional({ symbol: "DOT", instrumentType: "CRYPTO", side: "BUY", orderType: "LIMIT", quantity: 10, limitPrice: 1.2 }),
    12,
  );
  assert.equal(orderNotional({ symbol: "DOT", instrumentType: "CRYPTO", side: "BUY", orderType: "MARKET" }), 0);
});

test("validateSignalEvidence accepts evidence that clears every criterion", () => {
  assert.deepEqual(validateSignalEvidence(GOOD_SIGNAL.evidence), []);
});

test("validateSignalEvidence rejects the volume-breakout finding on every count that killed it", () => {
  // The settled result from the skill: 6 trades, negative mean, beaten by 78%
  // of random draws, 0 of 27 configurations profitable, no causal variable.
  const rejections = validateSignalEvidence({
    source: ".agents/skills/crypto-signal-eval/SKILL.md",
    mechanism: "short squeeze proxied by a volume-expansion breakout",
    causalVariableAvailable: false,
    tradeCount: 6,
    meanReturnAfterCosts: -0.05,
    roundTripCostAssumed: 0.0075,
    beatsRandomBaselineFraction: 0.22,
    configurationsTested: 27,
    configurationsProfitable: 0,
    walkForwardValidated: false,
  });

  const reasons = rejections.map((rejection) => rejection.reason).join(" ");
  assert.ok(reasons.includes("causal variable"));
  assert.ok(reasons.includes("negative"));
  assert.ok(reasons.includes("random-entry draws"));
  assert.ok(reasons.includes("Too few"));
  assert.ok(reasons.includes("selection artifact"));
  assert.ok(reasons.includes("walk-forward"));
});

test("validateSignalEvidence rejects a zero-cost backtest and an unstated mechanism", () => {
  const rejections = validateSignalEvidence({ ...GOOD_SIGNAL.evidence, roundTripCostAssumed: 0, mechanism: "  " });
  const reasons = rejections.map((rejection) => rejection.reason).join(" ");
  assert.ok(reasons.includes("zero round-trip cost"));
  assert.ok(reasons.includes("No stated mechanism"));
});
