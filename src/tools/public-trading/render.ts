import { formatPercent, formatUsd, roundTo } from "./decimal";
import type { Review } from "./review";
import type { RoundTrip } from "./round-trips";

/**
 * Renders a `Review` as the Markdown file committed under
 * `docs/operations/public-trading/`.
 *
 * The file opens with YAML frontmatter carrying the run's watermark and
 * headline numbers. That is what makes "closed P/L since last run" work: the
 * next run reads the previous file's `watermark` and counts only round trips
 * closed after it, with no separate state file to fall out of sync with the
 * reviews themselves.
 */

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderFrontmatter(review: Review): string {
  const lines = [
    "---",
    `runAt: ${yamlString(review.runAt)}`,
    `accountId: ${yamlString(review.accountId)}`,
  ];
  if (review.watermark !== undefined) lines.push(`watermark: ${yamlString(review.watermark)}`);
  if (review.previousWatermark !== undefined) {
    lines.push(`previousWatermark: ${yamlString(review.previousWatermark)}`);
  }
  lines.push(
    `totalAccountValue: ${roundTo(review.snapshot.totalAccountValue, 2)}`,
    `buyingPower: ${roundTo(review.snapshot.buyingPower, 2)}`,
    `closedSinceLastRun: ${review.closedSinceLastRunSummary.count}`,
    `realisedPlSinceLastRun: ${roundTo(review.closedSinceLastRunSummary.totalRealisedPl, 2)}`,
    `realisedCostDrag: ${roundTo(review.costDrag.realisedRoundTrip, 6)}`,
    `costDragBaseline: ${roundTo(review.costDrag.baseline, 6)}`,
    `draftedTrades: ${review.drafts.drafts.length}`,
    `concentrationFlags: ${review.concentration.flags.length}`,
    `openBuyOrdersInfeasible: ${review.orderFeasibility.infeasible}`,
    "---",
  );
  return lines.join("\n");
}

function renderRoundTripTable(trips: readonly RoundTrip[]): string {
  if (trips.length === 0) return "_None._";
  const header = [
    "| Symbol | Closed | Held | In | Out | Realised P/L | Price move | Cost drag |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const rows = trips.map((trip) =>
    [
      trip.symbol,
      trip.closedAt.slice(0, 16).replace("T", " "),
      `${trip.holdHours.toFixed(1)}h`,
      formatUsd(trip.costIn),
      formatUsd(trip.proceedsOut),
      `${formatUsd(trip.realisedPl, true)} (${formatPercent(trip.realisedPlRatio, 2, true)})`,
      formatPercent(trip.priceMoveRatio, 2, true),
      formatPercent(trip.costDragRatio),
    ].join(" | "),
  );
  return [...header, ...rows.map((row) => `| ${row} |`)].join("\n");
}

function renderPositions(review: Review): string {
  if (review.concentration.positions.length === 0) return "_No open positions._";
  const header = ["| Symbol | Type | Value | % of account | Cost basis | Unrealised |", "|---|---|---|---|---|---|"];
  const bySymbol = new Map(review.snapshot.positions.map((position) => [position.symbol, position]));
  const rows = review.concentration.positions.map((entry) => {
    const position = bySymbol.get(entry.symbol);
    const flag = entry.flagged ? " ⚠️" : "";
    return (
      `| ${entry.symbol}${flag} | ${entry.instrumentType} | ${formatUsd(entry.value)} | ` +
      `${formatPercent(entry.shareOfAccount, 1)} | ${formatUsd(position?.totalCost ?? 0)} | ` +
      `${formatUsd(position?.unrealisedGain ?? 0, true)} (${formatPercent(position?.unrealisedGainRatio ?? 0, 2, true)}) |`
    );
  });
  return [...header, ...rows].join("\n");
}

function renderDrafts(review: Review): string {
  const { drafts } = review;
  const sections: string[] = [];

  if (drafts.suppressedReason !== undefined) {
    sections.push(`**No trades drafted.** ${drafts.suppressedReason}`);
  }

  if (drafts.drafts.length > 0) {
    sections.push(
      drafts.drafts
        .map((draft) => {
          const order = draft.order;
          const size =
            order.amount !== undefined
              ? formatUsd(order.amount)
              : order.quantity !== undefined
                ? `${order.quantity} units`
                : "unspecified size";
          return [
            `#### Draft — ${order.side} ${order.symbol} (${size})`,
            "",
            `- **Signal:** \`${draft.signalId}\``,
            `- **Order:** ${order.orderType} ${order.side} ${order.symbol}` +
              (order.limitPrice !== undefined ? ` @ ${formatUsd(order.limitPrice)}` : "") +
              `, ${order.timeInForce ?? "DAY"}`,
            `- **Expected edge:** ${formatPercent(draft.expectedEdgePerTrade)} per round trip`,
            `- **Cost drag charged:** ${formatPercent(draft.expectedCostDrag)}`,
            `- **Net expected edge:** ${formatPercent(draft.expectedNetEdge, 2, true)}`,
            `- **Buying power at draft:** ${formatUsd(draft.buyingPowerAtDraft)}`,
            `- **Preflight:** accepted; order value ${formatUsd(draft.preflight.orderValue)}, ` +
              `buying power required ${formatUsd(draft.preflight.buyingPowerRequired)}, ` +
              `commission ${formatUsd(draft.preflight.estimatedCommission)}, ` +
              `regulatory fees ${formatUsd(draft.preflight.estimatedRegulatoryFees)}`,
            `- **Rationale:** ${draft.rationale}`,
            "",
            "> This is a draft only. Nothing was placed. Approving it means placing the order yourself,",
            "> or authorising a specific order in a separate, explicit step.",
          ].join("\n");
        })
        .join("\n\n"),
    );
  }

  if (drafts.rejected.length > 0) {
    sections.push(
      [
        "#### Considered and rejected",
        "",
        ...drafts.rejected.map(
          (rejection) =>
            `- **${rejection.order.side} ${rejection.order.symbol}** (\`${rejection.signalId}\`): ` +
            rejection.reasons.join(" "),
        ),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/** Renders the full review file, frontmatter included. */
export function renderReview(review: Review): string {
  const summary = review.closedSinceLastRunSummary;
  const window = review.windowSummary;
  const snapshot = review.snapshot;

  const sinceLabel =
    review.previousWatermark === undefined
      ? "since the beginning of the history window (first run — no previous watermark)"
      : `since the last run (${review.previousWatermark.slice(0, 16).replace("T", " ")} UTC)`;

  const sections = [
    renderFrontmatter(review),
    "",
    `# Public.com monitoring review — ${review.runAt.slice(0, 10)}`,
    "",
    `Run at ${review.runAt} UTC against account \`${review.accountId}\`.`,
    "",
    "Generated by the standalone Public.com monitoring system (`src/tools/public-trading/`).",
    "This system reads and drafts only; it holds no ability to place an order. It is separate from,",
    "and does not observe the internals of, control, or interfere with, the existing Public.com Agent",
    "described in `docs/registry/PROJECT-REGISTRY.md` §8.",
    "",
    "## 1. Portfolio snapshot",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Total account value | ${formatUsd(snapshot.totalAccountValue)} |`,
    `| Cash | ${formatUsd(snapshot.cash)} |`,
    `| Buying power | ${formatUsd(snapshot.buyingPower)} |`,
    `| Open positions | ${snapshot.positions.length} |`,
    `| Open orders | ${snapshot.openOrders.length} |`,
    "",
    snapshot.equity.length > 0
      ? [
          "Equity by asset class:",
          "",
          "| Class | Value | % of account |",
          "|---|---|---|",
          ...snapshot.equity.map(
            (bucket) => `| ${bucket.type} | ${formatUsd(bucket.value)} | ${formatPercent(bucket.percentOfPortfolio, 1)} |`,
          ),
        ].join("\n")
      : "",
    "",
    "## 2. Closed-trade P/L " + sinceLabel,
    "",
    renderRoundTripTable(review.closedSinceLastRun),
    "",
    summary.count > 0
      ? `**${summary.count} round trip(s) closed:** ${summary.wins} win / ${summary.losses} loss ` +
        `(${formatPercent(summary.winRate, 0)} win rate), net ${formatUsd(summary.totalRealisedPl, true)}, ` +
        `mean ${formatPercent(summary.meanRealisedPlRatio, 2, true)} per trade, ` +
        `median hold ${summary.medianHoldHours.toFixed(1)}h.`
      : "**No round trips closed in this period.**",
    "",
    `Across the whole ${review.historyWindow.start?.slice(0, 10) ?? "history"} window: ` +
      (window.count > 0
        ? `${window.count} closed round trip(s), net ${formatUsd(window.totalRealisedPl, true)}, ` +
          `${formatPercent(window.winRate, 0)} win rate.`
        : "no closed round trips."),
    "",
    "## 3. Cost drag",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Baseline assumption (BRIEFING.md) | ${formatPercent(review.costDrag.baseline)} round trip |`,
    `| Realised, dollar-weighted | ${review.costDrag.sampleSize > 0 ? formatPercent(review.costDrag.realisedRoundTrip) : "n/a"} |`,
    `| Realised cost paid | ${formatUsd(review.costDrag.realisedDollars)} |`,
    `| Sample size | ${review.costDrag.sampleSize} closed round trip(s) |`,
    `| Delta vs baseline | ${review.costDrag.sampleSize > 0 ? formatPercent(review.costDrag.deltaVsBaseline, 2, true) : "n/a"} |`,
    "",
    review.costDrag.note,
    "",
    "Drag is measured per fill as the gap between `principalAmount` (gross at the quoted execution",
    "price) and `netAmount` (cash that actually moved). That gap appears even when the reported `fees`",
    "are zero, because it is spread and markup rather than a stated commission.",
    "",
    "## 4. Concentration",
    "",
    renderPositions(review),
    "",
    `Top two positions combined: **${formatPercent(review.concentration.topTwoCombinedShare, 1)}** of account value.`,
    "",
    review.concentration.flags.length > 0
      ? ["**Flags:**", "", ...review.concentration.flags.map((flag) => `- ⚠️ ${flag}`)].join("\n")
      : "No concentration thresholds breached.",
    "",
    "## 5. Open-order feasibility",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Buying power | ${formatUsd(review.orderFeasibility.buyingPower)} |`,
    `| Open buy orders | ${review.orderFeasibility.openBuyOrderCount} |`,
    `| Committed notional | ${formatUsd(review.orderFeasibility.committedNotional)} |`,
    `| Shortfall | ${formatUsd(review.orderFeasibility.shortfall)} |`,
    "",
    review.orderFeasibility.notes.length > 0
      ? review.orderFeasibility.notes.map((note) => `- ${review.orderFeasibility.infeasible ? "⚠️ " : ""}${note}`).join("\n")
      : "No open buy orders.",
    "",
    "These orders belong to the account, not to this system — this system places none. Where they came",
    "from is not visible over the API, so this section reports the arithmetic and draws no conclusion",
    "about which agent queued them or why.",
    "",
    "## 6. Drafted trades",
    "",
    renderDrafts(review),
    "",
  ];

  // The `""` entries above are deliberate blank-line separators — Markdown
  // needs one before a heading and around a table — so they are joined in
  // rather than filtered out, and only runs of three or more newlines (from a
  // section that rendered empty) are collapsed.
  return `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trimStart()}\n`;
}

/** Reads the `watermark` out of a previously rendered review's frontmatter. */
export function parseWatermark(markdown: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (frontmatter === null) return undefined;
  const match = /^watermark:\s*"(.*)"\s*$/m.exec(frontmatter[1] as string);
  return match === null ? undefined : (match[1] as string).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
