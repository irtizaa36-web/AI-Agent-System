/**
 * Standalone Public.com monitoring and trade-drafting system.
 *
 * Reads portfolio state, positions and history through the Public MCP
 * connector; reports realised P/L, cost drag, concentration and open-order
 * feasibility into a per-run review file; and — once a signal has cleared the
 * evidence bar in `.agents/skills/crypto-signal-eval/SKILL.md` — drafts trades
 * for a human to approve.
 *
 * **It cannot place an order.** `PublicTradingClient` exposes the four read
 * tools plus `preflight_order` and nothing else, so that property is enforced
 * by the type system rather than by a runtime guard.
 *
 * **It is separate from the existing Public.com Agent** (PROJECT-REGISTRY.md
 * §8). It does not read that agent's configuration, pause it, or attempt to
 * control it, and keeps its own logic and logs distinct so the two can be
 * compared over the same weeks. See `BRIEFING.md`, "Relationship to the
 * existing Public.com Agent".
 */
export { type PublicTradingClient, type HistoryQuery, type PriceHistoryQuery } from "./client";
export {
  normaliseHistoryPage,
  normaliseOpenOrder,
  normalisePortfolio,
  normalisePreflight,
  normaliseQuote,
  normaliseTransaction,
  normalisePosition,
} from "./client";
export { createPublicTradingClient, unwrapMcpResult, PUBLIC_READ_TOOLS } from "./mcp-client";
export type { McpToolCall, PublicReadToolName } from "./mcp-client";
export { formatPercent, formatUsd, parseDecimal, parseOptionalDecimal, roundTo } from "./decimal";
export {
  fillCost,
  matchRoundTrips,
  roundTripsClosedAfter,
  summariseRoundTrips,
  type Fill,
  type RoundTrip,
  type RoundTripSummary,
} from "./round-trips";
export {
  analyseConcentration,
  analyseOrderFeasibility,
  DEFAULT_CONCENTRATION_THRESHOLDS,
  type ConcentrationEntry,
  type ConcentrationReport,
  type ConcentrationThresholds,
  type OrderFeasibilityReport,
} from "./portfolio-analysis";
export {
  draftingEnabled,
  validateSignalEvidence,
  VALIDATED_SIGNALS,
  type SignalEvidence,
  type SignalRejection,
  type ValidatedSignal,
} from "./signals";
export {
  orderNotional,
  proposeDrafts,
  ROUND_TRIP_COST_BASELINE,
  type DraftCandidate,
  type DraftOptions,
  type DraftOutcome,
  type RejectedDraft,
  type TradeDraft,
} from "./draft";
export { buildReview, runReview, type BuildReviewInput, type CostDragReport, type Review, type RunReviewOptions } from "./review";
export { parseWatermark, renderReview } from "./render";
export {
  DEFAULT_REVIEW_DIR,
  readLatestWatermark,
  reviewFileName,
  writeReview,
  type WrittenReview,
} from "./review-store";
export { writePriceHistoryCsv } from "./price-history";
export type {
  DraftOrder,
  EquityBucket,
  InstrumentType,
  OpenOrder,
  OrderSide,
  PortfolioSnapshot,
  Position,
  PreflightResult,
  PriceBar,
  Quote,
  Transaction,
} from "./types";
