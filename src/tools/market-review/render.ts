import { formatPercent, formatUsd } from "../public-trading/decimal";
import type { AnalysisFlag, ContractAnalysis } from "./analysis";
import { SIZING_DISCLAIMER, type SizedRecommendation } from "./recommend";
import { reviewSeverity, type MarketReview } from "./review";
import { SLOT_TARGET_ET, type CatalystFlag, type CheckInSlot } from "./types";

/**
 * Rendering a check-in as Markdown.
 *
 * The four slots print different reports because they answer different
 * questions. Rather than four near-identical templates, each slot supplies a
 * heading, a purpose line, and an ordered section list; the section bodies are
 * shared. Adding a slot means adding a row to `SLOT_PLAN`, not another renderer.
 *
 * Two things print unconditionally, whatever the slot: the sizing disclaimer
 * (it is the agreed mitigation for sizing not being checked against buying
 * power — see `recommend.ts`) and the separation note about the other
 * Public.com Agents trading the same account.
 */

type SectionId =
  | "failure"
  | "clock"
  | "volatility"
  | "deltas"
  | "catalysts"
  | "positions"
  | "candidates"
  | "contracts"
  | "recommendations"
  | "notes";

interface SlotPlan {
  readonly title: string;
  readonly purpose: string;
  readonly sections: readonly SectionId[];
}

/**
 * What each slot is for. The ordering within each is the reading order that
 * makes sense at that time of day: pre-open leads with catalysts because
 * nothing has traded yet, while pre-close leads with the clock because minutes
 * remaining is the binding constraint on anything expiring today.
 */
const SLOT_PLAN: Readonly<Record<CheckInSlot, SlotPlan>> = {
  "pre-open": {
    title: "Pre-open plan",
    purpose:
      "Thirty minutes before the bell: what is scheduled today, what the account already holds into it, and " +
      "which names are worth watching. Prices here are pre-open reference values, not tradeable quotes.",
    sections: ["failure", "clock", "volatility", "catalysts", "positions", "candidates", "contracts", "recommendations", "notes"],
  },
  opening: {
    title: "Opening-move confirmation",
    purpose:
      "Five minutes after the bell: whether the pre-open read survived contact with a live market. First " +
      "quotes of the day are real but thin — spreads are at their widest in these minutes.",
    sections: ["failure", "clock", "volatility", "deltas", "contracts", "recommendations", "catalysts", "notes"],
  },
  midday: {
    title: "Midday drift",
    purpose:
      "Noon: what has changed since the open, and whether anything has invalidated the morning's reasoning. " +
      "The quietest part of the session, and the cheapest time to reconsider.",
    sections: ["failure", "clock", "volatility", "deltas", "contracts", "recommendations", "catalysts", "notes"],
  },
  "pre-close": {
    title: "Pre-close decision point",
    purpose:
      "Thirty minutes to the close: anything expiring today resolves to intrinsic value in minutes, not hours. " +
      "Decay and time remaining dominate every other consideration here.",
    sections: ["failure", "clock", "contracts", "recommendations", "deltas", "volatility", "positions", "notes"],
  },
};

const SEVERITY_ICON: Readonly<Record<AnalysisFlag["severity"], string>> = {
  BLOCK: "⛔",
  WARN: "⚠️",
  INFO: "ℹ️",
};

function renderFlags(flags: readonly AnalysisFlag[], heading?: string): string[] {
  if (flags.length === 0) return [];
  const lines = heading === undefined ? [] : [`**${heading}**`, ""];
  // Deduplicate by code+message: the same wide-spread warning on three strikes
  // is one thing to know, not three.
  const seen = new Set<string>();
  const order: Record<AnalysisFlag["severity"], number> = { BLOCK: 0, WARN: 1, INFO: 2 };
  for (const flag of [...flags].sort((a, b) => order[a.severity] - order[b.severity])) {
    const key = `${flag.code}:${flag.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${SEVERITY_ICON[flag.severity]} **${flag.code}** — ${flag.message}`);
  }
  lines.push("");
  return lines;
}

function renderFailure(review: MarketReview): string[] {
  if (review.incomplete === undefined) return [];
  return [
    "## ⛔ This run did not complete",
    "",
    review.incomplete.reason,
    "",
    ...review.incomplete.details.map((detail) => `- ${detail}`),
    "",
    "Everything below, if anything, is partial. Do not read an absent section as an absence of risk.",
    "",
  ];
}

function renderClock(review: MarketReview): string[] {
  const lines = [
    `## Session clock`,
    "",
    `| | |`,
    `|---|---|`,
    `| Slot | ${review.slot} (targets ${SLOT_TARGET_ET[review.slot]} ET) |`,
    `| Ran at | ${review.clock.etTime} ET on ${review.clock.etDate} (${review.runAt}) |`,
    `| Session | ${review.clock.session} |`,
    `| Minutes to close | ${review.minutesToClose} |`,
    "",
  ];
  const runFlags = review.flags.filter(
    (flag) => flag.code === "NON_TRADING_DAY" || flag.code === "SLOT_TIME_DRIFT",
  );
  return [...lines, ...renderFlags(runFlags)];
}

function renderVolatility(review: MarketReview): string[] {
  if (review.vix === undefined) {
    return ["## Volatility", "", "VIX was not available for this run.", ""];
    }
  const vix = review.vix;
  const change = vix.dayChangeRatio === undefined ? "n/a" : formatPercent(vix.dayChangeRatio, 2, true);
  return [
    "## Volatility",
    "",
    `**VIX ${vix.last.toFixed(2)}** (${change} on the day${
      vix.previousClose === undefined ? "" : `, prior close ${vix.previousClose.toFixed(2)}`
    })`,
    "",
    "VIX is the primary volatility gauge for this report. Any per-contract implied volatility below is " +
      "secondary context — a single chain's IV is far more prone to stale or artifact values than the index.",
    "",
  ];
}

function renderDeltas(review: MarketReview): string[] {
  if (review.deltas.length === 0) {
    return [
      "## Change since the last check-in",
      "",
      review.prior === undefined
        ? "No previous run was available, so there is nothing to compare against."
        : "No overlapping symbols between this run and the previous one.",
      "",
    ];
  }
  const priorLabel =
    review.prior === undefined ? "the previous run" : `${review.prior.slot} at ${review.prior.runAt}`;
  return [
    "## Change since the last check-in",
    "",
    `Compared against ${priorLabel}.`,
    "",
    "| Symbol | Then | Now | Change |",
    "|---|---|---|---|",
    ...review.deltas.map(
      (delta) =>
        `| ${delta.symbol} | ${formatUsd(delta.priorPrice)} | ${formatUsd(delta.currentPrice)} | ` +
        `${formatPercent(delta.changeRatio, 2, true)} |`,
    ),
    "",
  ];
}

function renderCatalystRows(catalysts: readonly CatalystFlag[]): string[] {
  return catalysts.map(
    (catalyst) =>
      `| ${catalyst.symbol} | ${catalyst.kind} | ${catalyst.date} | ${catalyst.tradingDaysAway} | ${catalyst.detail} |`,
  );
}

function renderCatalysts(review: MarketReview): string[] {
  const lines = ["## Catalysts in the window", ""];

  if (review.macroCatalysts.length === 0 && review.symbolCatalysts.length === 0) {
    lines.push("No earnings, dividends, splits or macro events were found inside the window checked.", "");
    lines.push(
      "That is an absence of *found* events, not a guarantee of a quiet window — the calendar coverage " +
        "available here is per-ticker, so an unscheduled or unlisted event would not appear.",
      "",
    );
    return lines;
  }

  if (review.macroCatalysts.length > 0) {
    lines.push(
      "**Macro — these move the whole book, not one position:**",
      "",
      "| Symbol | Kind | Date | Trading days away | Detail |",
      "|---|---|---|---|---|",
      ...renderCatalystRows(review.macroCatalysts),
      "",
    );
  }

  if (review.symbolCatalysts.length > 0) {
    lines.push(
      "**Per name:**",
      "",
      "| Symbol | Kind | Date | Trading days away | Detail |",
      "|---|---|---|---|---|",
      ...renderCatalystRows(review.symbolCatalysts),
      "",
      "A long option bought into an earnings print is the worst documented case for retail " +
        "[VERIFIED — de Silva/So/Smith: 5–9% average loss, 10–14% where expected volatility is highest]. " +
        "Proximity to one of these dates counts against a premium-buying idea, not for it.",
      "",
    );
  }

  return lines;
}

function renderPositions(review: MarketReview): string[] {
  const snapshot = review.snapshot;
  if (snapshot === undefined) return [];

  const held = [...snapshot.positions].sort((a, b) => b.currentValue - a.currentValue);
  return [
    "## Account",
    "",
    `| | |`,
    `|---|---|`,
    `| Total value | ${formatUsd(snapshot.totalAccountValue)} |`,
    `| Cash | ${formatUsd(snapshot.cash)} |`,
    `| Buying power | ${formatUsd(snapshot.buyingPower)} |`,
    `| Positions | ${snapshot.positions.length} |`,
    `| Open orders | ${snapshot.openOrders.length} |`,
    "",
    ...(held.length === 0
      ? []
      : [
          "| Symbol | Type | Value | % of account |",
          "|---|---|---|---|",
          ...held
            .slice(0, 15)
            .map(
              (position) =>
                `| ${position.symbol} | ${position.instrumentType} | ${formatUsd(position.currentValue)} | ` +
                `${formatPercent(position.percentOfPortfolio, 1)} |`,
            ),
          "",
          ...(held.length > 15 ? [`_${held.length - 15} smaller position(s) not listed._`, ""] : []),
        ]),
    "This account is also traded by the existing Public.com Agents (PROJECT-REGISTRY.md §8). Positions " +
      "above may be theirs; this system reports what the record shows and draws no conclusion about which " +
      "agent opened what.",
    "",
  ];
}

function renderCandidates(review: MarketReview): string[] {
  if (review.candidates.length === 0) return [];
  return [
    "## Candidates reviewed",
    "",
    "| Symbol | Source | % of account | Note |",
    "|---|---|---|---|",
    ...review.candidates.map(
      (candidate) =>
        `| ${candidate.symbol} | ${candidate.sources.join(" + ")} | ` +
        `${candidate.portfolioWeight === undefined ? "—" : formatPercent(candidate.portfolioWeight, 1)} | ` +
        `${candidate.note ?? "—"} |`,
    ),
    "",
  ];
}

function renderContractAnalysis(analysis: ContractAnalysis, slot: CheckInSlot): string[] {
  const { contract } = analysis;
  const strike = Number.isInteger(contract.strike) ? String(contract.strike) : contract.strike.toFixed(2);
  const lines = [
    `### ${contract.underlying} $${strike} ${contract.side.toLowerCase()} — exp ${contract.expiration}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Underlying | ${formatUsd(analysis.underlyingPrice)} |`,
    `| Premium (${analysis.entryBasis.toLowerCase()}) | ${formatUsd(analysis.entryPrice)} per share = ${formatUsd(
      analysis.entryPricePerContract,
    )} per contract |`,
    `| Breakeven at expiration | ${formatUsd(analysis.breakeven)} (${formatPercent(
      analysis.breakevenMoveRatio,
      2,
      true,
    )} move needed) |`,
    `| Doubles at | ${formatUsd(analysis.priceFor2x)} (${formatPercent(analysis.moveRatioFor2x, 2, true)}) |`,
    `| Worthless at or beyond | ${formatUsd(analysis.priceForWorthless)} (${formatPercent(
      analysis.moveRatioForWorthless,
      2,
      true,
    )}) |`,
  ];

  if (analysis.delta !== undefined) {
    lines.push(`| Delta | ${analysis.delta.toFixed(4)} (rough in-the-money proxy, **not** probability of profit) |`);
  }
  if (analysis.thetaPerContractPerDay !== undefined) {
    const share =
      analysis.thetaShareOfPremium === undefined
        ? ""
        : ` — ${formatPercent(analysis.thetaShareOfPremium, 1)} of premium per day`;
    lines.push(`| Theta | ${formatUsd(analysis.thetaPerContractPerDay, true)} per contract per day${share} |`);
  }
  if (analysis.impliedVolatility !== undefined) {
    lines.push(`| Implied volatility | ${formatPercent(analysis.impliedVolatility, 1)} (secondary to VIX above) |`);
  }
  if (analysis.spread !== undefined) {
    const share =
      analysis.spreadShareOfMid === undefined ? "" : ` (${formatPercent(analysis.spreadShareOfMid, 1)} of mid)`;
    lines.push(`| Bid/ask spread | ${formatUsd(analysis.spread)}${share} |`);
  }
  lines.push("");

  if (slot === "pre-close" && analysis.thetaShareOfPremium !== undefined) {
    lines.push(
      "At this hour the relevant question is not the daily decay rate but whether the required move can " +
        "happen in the minutes remaining. If it cannot, the position resolves to intrinsic value.",
      "",
    );
  }

  return [...lines, ...renderFlags(analysis.flags, "Flags")];
}

function renderContracts(review: MarketReview): string[] {
  if (review.contractAnalyses.length === 0) return [];
  const lines = ["## Contract analysis", ""];
  for (const analysis of review.contractAnalyses) {
    lines.push(...renderContractAnalysis(analysis, review.slot));
  }
  for (const check of review.ivTermChecks) {
    if (check.flags.length === 0) continue;
    lines.push(
      `**IV term-structure check — ${check.nearExpiration} vs ${check.farExpiration}:**`,
      "",
      ...renderFlags(check.flags),
    );
  }
  return lines;
}

function renderRecommendation(recommendation: SizedRecommendation): string[] {
  const lines = [
    `### ${recommendation.rank}. ${recommendation.symbol} — ${recommendation.direction} (${recommendation.conviction} conviction)` +
      `${recommendation.blocked ? " ⛔ BLOCKED" : ""}`,
    "",
    `**Mechanism:** ${recommendation.mechanism}`,
    "",
  ];

  if (recommendation.contractLabel !== undefined) {
    lines.push(`**Contract:** ${recommendation.contractLabel}`, "");
  }

  if (recommendation.contracts !== undefined && recommendation.premiumPerContract !== undefined) {
    lines.push(
      `| | |`,
      `|---|---|`,
      `| Suggested size | ${recommendation.contracts} contract(s) |`,
      `| Premium per contract | ${formatUsd(recommendation.premiumPerContract)} |`,
      `| Total premium | ${formatUsd(recommendation.totalPremium ?? 0)} |`,
      `| Maximum loss | ${formatUsd(recommendation.maxLossUsd ?? 0)} (the entire premium, for a long option) |`,
      "",
    );
    if (recommendation.contracts === 0) {
      lines.push(
        "Size rounds to zero: one contract costs more than the stated risk budget for this run.",
        "",
      );
    }
  }

  lines.push(`**Score ${recommendation.score}** — built only from measurable mechanics, never from a prediction:`, "");
  if (recommendation.scoreComponents.length === 0) {
    lines.push("- No penalties applied; nothing measurable counted against this contract.", "");
  } else {
    for (const component of recommendation.scoreComponents) {
      lines.push(`- ${component.delta > 0 ? "+" : ""}${component.delta} ${component.label} — ${component.why}`);
    }
    lines.push("");
  }

  if (recommendation.sources.length > 0) {
    lines.push("**Sources:**", "", ...recommendation.sources.map((source) => `- ${source}`), "");
  }

  if (recommendation.evidenceCaveats.length > 0) {
    lines.push("**Evidence caveats:**", "", ...recommendation.evidenceCaveats.map((caveat) => `- ${caveat}`), "");
  }

  return [...lines, ...renderFlags(recommendation.risks, "Risks")];
}

function renderRecommendations(review: MarketReview): string[] {
  const lines = ["## Recommendations", ""];

  if (review.recommendations.length === 0) {
    lines.push("No candidate reached a stated thesis this run, so nothing is recommended.", "");
    return lines;
  }

  lines.push(
    `Risk budget for this run: **${formatUsd(review.sizing.riskBudgetUsd)} per idea**` +
      `${review.sizing.maxContracts === undefined ? "" : `, capped at ${review.sizing.maxContracts} contract(s)`}.`,
    "",
    `> ${SIZING_DISCLAIMER}`,
    "",
  );

  for (const recommendation of review.recommendations) {
    lines.push(...renderRecommendation(recommendation));
  }

  return lines;
}

function renderNotes(review: MarketReview): string[] {
  if (review.notes.length === 0) return [];
  return ["## Notes from this run", "", ...review.notes.map((note) => `- ${note}`), ""];
}

const SECTION_RENDERERS: Readonly<Record<SectionId, (review: MarketReview) => string[]>> = {
  failure: renderFailure,
  clock: renderClock,
  volatility: renderVolatility,
  deltas: renderDeltas,
  catalysts: renderCatalysts,
  positions: renderPositions,
  candidates: renderCandidates,
  contracts: renderContracts,
  recommendations: renderRecommendations,
  notes: renderNotes,
};

/** YAML frontmatter, so a later run (or a human) can read a run's headline facts without parsing prose. */
function renderFrontmatter(review: MarketReview): string[] {
  const severity = reviewSeverity(review);
  return [
    "---",
    `runAt: "${review.runAt}"`,
    `slot: "${review.slot}"`,
    `etDate: "${review.clock.etDate}"`,
    `etTime: "${review.clock.etTime}"`,
    `session: "${review.clock.session}"`,
    `accountId: "${review.accountId}"`,
    `minutesToClose: ${review.minutesToClose}`,
    `candidates: ${review.candidates.length}`,
    `contractsAnalysed: ${review.contractAnalyses.length}`,
    `recommendations: ${review.recommendations.length}`,
    `riskBudgetUsd: ${review.sizing.riskBudgetUsd}`,
    `worstSeverity: ${severity === undefined ? "null" : `"${severity}"`}`,
    `complete: ${review.incomplete === undefined}`,
    "---",
    "",
  ];
}

/** Renders one check-in as a Markdown document. */
export function renderMarketReview(review: MarketReview): string {
  const plan = SLOT_PLAN[review.slot];
  const lines = [
    ...renderFrontmatter(review),
    `# ${plan.title} — ${review.clock.etDate} ${review.clock.etTime} ET`,
    "",
    plan.purpose,
    "",
    "Generated by the market-review system (`src/tools/market-review/`). It reads and drafts only: the client " +
      "interface it uses exposes no method that could place, modify, or cancel an order. Every number below is " +
      "for human review, and acting on any of it is a separate, explicit step.",
    "",
  ];

  for (const section of plan.sections) {
    lines.push(...SECTION_RENDERERS[section](review));
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
