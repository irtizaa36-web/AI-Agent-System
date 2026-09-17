import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { formatUsd } from "../tools/public-trading/decimal";
import { normalisePortfolio } from "../tools/public-trading/client";
import { normaliseChain, normaliseUnderlyingQuote, unwrapMcpResult } from "../tools/market-review/client";
import { analyseContract, checkIvTermStructure } from "../tools/market-review/analysis";
import { rankRecommendations } from "../tools/market-review/recommend";
import { buildMarketReview, parseCheckInSlot, reviewSeverity } from "../tools/market-review/review";
import {
  DEFAULT_LOG_PATH,
  DEFAULT_REVIEW_DIR,
  appendLogEntries,
  logEntriesFor,
  readLogEntries,
  readPriorReference,
  writeMarketReview,
  type LogEntry,
  type OutcomeLogEntry,
} from "../tools/market-review/store";
import {
  DEFAULT_EXTERNAL_SIGNAL_LOG_PATH,
  appendExternalSignalEntries,
  readExternalSignalEntries,
  splitExternalSignalLog,
} from "../tools/market-review/external-signals-store";
import {
  gradeAllSignals,
  summariseBySource,
  validateExternalSignal,
  type ExternalSignal,
  type ExternalSignalOutcome,
} from "../tools/market-review/external-signals";
import type { CliDeps } from "./index";
import type { ContractAnalysis, IvTermCheck } from "../tools/market-review/analysis";
import type { Conviction, Direction, SizedRecommendation } from "../tools/market-review/recommend";
import type {
  Candidate,
  CatalystFlag,
  ChainLeg,
  ChainSnapshot,
  UnderlyingQuote,
} from "../tools/market-review/types";
import type { FailureReport } from "../tools/market-review/review";

/**
 * `orchestrator market-review …` — the four daily check-ins and the
 * close-the-loop step.
 *
 * Same split as the sibling Public.com command: the MCP connector lives in the
 * Claude session, not in this process, so the session pulls quotes, chains and
 * Greeks, decides the day's theses from live news, and pipes the whole lot in as
 * JSON; this command does the assembly, rendering, file writing and logging
 * deterministically. Every number in a report is therefore reproducible from a
 * saved input file, and the connector's credentials never enter this process.
 *
 * It writes report files and log rows. It cannot place an order: the module it
 * calls exposes no method that could.
 */

const USAGE = [
  "Usage:",
  "  orchestrator market-review check-in --slot <slot> --input <file|-> [--dir <path>] [--log <path>]",
  "  orchestrator market-review close-loop --input <file|-> [--log <path>]",
  "  orchestrator market-review log [--log <path>] [--limit N]",
  "  orchestrator market-review external-signal add --input <file|-> [--log <path>]",
  "  orchestrator market-review external-signal outcome --input <file|-> [--log <path>]",
  "  orchestrator market-review external-signal stats [--log <path>] [--source <name>]",
  "",
  "  --slot    One of: pre-open, opening, midday, pre-close",
  "  --input   JSON the session assembled for this run, or '-' to read stdin. See",
  "            docs/operations/market-review.md for the full shape.",
  `  --dir     Where reports are written (default: ${DEFAULT_REVIEW_DIR})`,
  `  --log     Append-only prediction log (default: ${DEFAULT_LOG_PATH})`,
  "",
  "external-signal tracks a NAMED THIRD-PARTY SOURCE's stated calls (e.g. a",
  "YouTube channel) and grades them against what actually happened. It is a",
  "separate log from this system's own predictions and is never treated as",
  `evidence — see docs/operations/market-review.md. Default log: ${DEFAULT_EXTERNAL_SIGNAL_LOG_PATH}`,
].join("\n");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function readInput(value: string): Promise<unknown> {
  const text = value === "-" ? await readStdin() : await readFile(value, "utf-8");
  return JSON.parse(text);
}

/**
 * The JSON a session hands `check-in`.
 *
 * Deliberately **raw connector responses plus judgement**, not computed
 * numbers. The session's job is to fetch (quotes, chains, portfolio) and to
 * decide (which names, which theses, what the news says); every derived figure —
 * breakeven, theta per contract, required moves, IV comparisons, scores, sizes —
 * is computed here by the tested module. If the session pre-computed those, the
 * maths would live in an agent's head instead of under test, which is exactly
 * the arrangement that produced a 100× theta error once already.
 */
interface CheckInPayload {
  readonly runAt?: string;
  readonly accountId?: string;
  /** Raw `get_portfolio` response. */
  readonly portfolio?: unknown;
  /** Raw `get_quotes` response for VIX (instrument_type INDEX). */
  readonly vix?: unknown;
  /** Raw `get_quotes` response for the underlyings this run priced. */
  readonly underlyings?: unknown;
  /** Raw `get_option_chain` responses, one per expiration pulled. */
  readonly chains?: readonly unknown[];
  /** Which contracts to analyse, by OSI symbol. Each must appear in one of `chains`. */
  readonly contracts?: readonly {
    readonly osiSymbol: string;
    /** Override the premium the maths uses; defaults to the ask. */
    readonly entryPrice?: number;
  }[];
  /** Two expirations to compare IV across, both of which must be in `chains`. */
  readonly ivTermCheck?: { readonly near: string; readonly far: string };
  readonly candidates?: readonly Candidate[];
  readonly catalysts?: readonly CatalystFlag[];
  /** The session's directional views. A thesis with no mechanism is rejected. */
  readonly theses?: readonly {
    readonly symbol: string;
    readonly direction: Direction;
    readonly conviction: Conviction;
    readonly mechanism: string;
    readonly sources?: readonly string[];
    /** Which analysed contract this view is about, when it is an options idea. */
    readonly osiSymbol?: string;
  }[];
  readonly sizing?: { readonly riskBudgetUsd?: number; readonly maxContracts?: number };
  readonly notes?: readonly string[];
  readonly incomplete?: FailureReport;
}

/** Accepts a raw `get_quotes` response (array, wrapped, or single row) and normalises it. */
function readQuotes(raw: unknown): readonly UnderlyingQuote[] {
  if (raw === undefined || raw === null) return [];
  const unwrapped = unwrapMcpResult(raw);
  const rows = Array.isArray(unwrapped)
    ? unwrapped
    : typeof unwrapped === "object" && unwrapped !== null && Array.isArray((unwrapped as { quotes?: unknown }).quotes)
      ? ((unwrapped as { quotes: unknown[] }).quotes)
      : [unwrapped];
  return rows.map(normaliseUnderlyingQuote);
}

/** Finds a leg by OSI symbol across every pulled chain. */
function findLeg(chains: readonly ChainSnapshot[], osiSymbol: string): ChainLeg | undefined {
  const wanted = osiSymbol.trim().toUpperCase();
  for (const chain of chains) {
    for (const row of chain.rows) {
      if (row.call?.quote.osiSymbol === wanted) return row.call;
      if (row.put?.quote.osiSymbol === wanted) return row.put;
    }
  }
  return undefined;
}

async function runCheckIn(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { slot?: string; input?: string; dir?: string; log?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        slot: { type: "string" },
        input: { type: "string" },
        dir: { type: "string" },
        log: { type: "string" },
      },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  if (values.slot === undefined || values.input === undefined) {
    deps.stderr(`Both --slot and --input are required.\n${USAGE}`);
    return 1;
  }

  let slot;
  try {
    slot = parseCheckInSlot(values.slot);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }

  let payload: CheckInPayload;
  try {
    payload = (await readInput(values.input)) as CheckInPayload;
  } catch (error) {
    deps.stderr(`Could not read --input: ${(error as Error).message}`);
    return 1;
  }

  // A risk budget is required rather than defaulted: sizing is arithmetic
  // against a number the operator chose, and inventing one here would put a
  // fabricated figure in front of a reader as though it were a decision.
  const riskBudgetUsd = payload.sizing?.riskBudgetUsd;
  if (riskBudgetUsd === undefined || !Number.isFinite(riskBudgetUsd) || riskBudgetUsd <= 0) {
    deps.stderr(
      'Input needs "sizing": {"riskBudgetUsd": <positive number>} — the per-idea risk budget sizing is ' +
        "computed against. This command will not invent one.",
    );
    return 1;
  }

  const logPath = values.log ?? DEFAULT_LOG_PATH;
  const dir = values.dir ?? DEFAULT_REVIEW_DIR;

  const runAt = payload.runAt ?? new Date().toISOString();
  const sizing = {
    riskBudgetUsd,
    ...(payload.sizing?.maxContracts === undefined ? {} : { maxContracts: payload.sizing.maxContracts }),
  };

  let written;
  let review;
  try {
    const underlyings = readQuotes(payload.underlyings);
    const vixQuotes = readQuotes(payload.vix);
    const chains = (payload.chains ?? []).map((chain) => normaliseChain(unwrapMcpResult(chain)));

    // Analyse each requested contract from the chain the session pulled, pairing
    // it with its underlying's price from the same run.
    const contractAnalyses: ContractAnalysis[] = [];
    for (const request of payload.contracts ?? []) {
      const leg = findLeg(chains, request.osiSymbol);
      if (leg === undefined) {
        deps.stderr(
          `Contract ${request.osiSymbol} was requested but appears in none of the ${chains.length} chain(s) ` +
            "supplied. Pull its expiration's chain, or drop the contract.",
        );
        return 1;
      }
      const underlying = underlyings.find((quote) => quote.symbol === leg.contract.underlying);
      if (underlying === undefined) {
        deps.stderr(
          `Contract ${request.osiSymbol} needs a quote for its underlying (${leg.contract.underlying}), which ` +
            "this run did not include. The option and the underlying must be priced from the same moment.",
        );
        return 1;
      }
      contractAnalyses.push(
        analyseContract(leg, underlying.last, runAt, request.entryPrice),
      );
    }

    const ivTermChecks: IvTermCheck[] = [];
    if (payload.ivTermCheck !== undefined) {
      const near = chains.find((chain) => chain.expiration === payload.ivTermCheck?.near);
      const far = chains.find((chain) => chain.expiration === payload.ivTermCheck?.far);
      if (near === undefined || far === undefined) {
        deps.stderr(
          `The IV term-structure check named ${payload.ivTermCheck.near} and ${payload.ivTermCheck.far}, but ` +
            "both expirations' chains must be supplied in `chains`.",
        );
        return 1;
      }
      ivTermChecks.push(checkIvTermStructure(near, far));
    }

    // Rank the session's theses against the analysis and that symbol's catalysts.
    const catalysts = payload.catalysts ?? [];
    const recommendations: readonly SizedRecommendation[] = rankRecommendations(
      (payload.theses ?? []).map((thesis) => {
        const analysis =
          thesis.osiSymbol === undefined
            ? contractAnalyses.find((candidate) => candidate.contract.underlying === thesis.symbol)
            : contractAnalyses.find((candidate) => candidate.contract.osiSymbol === thesis.osiSymbol);
        return {
          thesis: {
            symbol: thesis.symbol,
            direction: thesis.direction,
            conviction: thesis.conviction,
            mechanism: thesis.mechanism,
            ...(thesis.sources === undefined ? {} : { sources: thesis.sources }),
          },
          ...(analysis === undefined ? {} : { analysis }),
          catalysts: catalysts.filter((catalyst) => catalyst.symbol === thesis.symbol),
        };
      }),
      { sizing },
    );

    const prior = await readPriorReference(logPath);
    review = buildMarketReview({
      runAt,
      slot,
      accountId: payload.accountId ?? "unknown",
      ...(payload.portfolio === undefined
        ? {}
        : { snapshot: normalisePortfolio(unwrapMcpResult(payload.portfolio)) }),
      ...(vixQuotes[0] === undefined ? {} : { vix: vixQuotes[0] }),
      underlyings,
      ...(payload.candidates === undefined ? {} : { candidates: payload.candidates }),
      catalysts,
      contractAnalyses,
      ivTermChecks,
      recommendations,
      sizing,
      ...(prior === undefined ? {} : { prior }),
      ...(payload.notes === undefined ? {} : { notes: payload.notes }),
      ...(payload.incomplete === undefined ? {} : { incomplete: payload.incomplete }),
    });
    written = await writeMarketReview(review, dir);
    await appendLogEntries(logEntriesFor(review), logPath);
  } catch (error) {
    deps.stderr(`Could not build the check-in: ${(error as Error).message}`);
    return 1;
  }

  deps.stdout(`Wrote ${written.path}`);
  deps.stdout(
    `${review.slot} check-in at ${review.clock.etTime} ET — ${review.candidates.length} candidate(s), ` +
      `${review.contractAnalyses.length} contract(s) analysed, ${review.recommendations.length} recommendation(s), ` +
      `risk budget ${formatUsd(review.sizing.riskBudgetUsd)}/idea.`,
  );

  if (review.incomplete !== undefined) {
    deps.stdout(`⛔ Run marked incomplete: ${review.incomplete.reason}`);
  }
  const severity = reviewSeverity(review);
  if (severity === "BLOCK") {
    for (const flag of review.flags.filter((candidate) => candidate.severity === "BLOCK")) {
      deps.stdout(`⛔ ${flag.code} — ${flag.message}`);
    }
  } else if (severity === "WARN") {
    deps.stdout(`⚠️  ${review.flags.filter((flag) => flag.severity === "WARN").length} warning(s) in the report.`);
  }
  if (review.recommendations.length > 0) {
    deps.stdout("Suggested sizes are NOT checked against live buying power — verify before acting.");
  }

  return 0;
}

interface CloseLoopPayload {
  readonly recordedAt?: string;
  readonly outcomes?: readonly {
    readonly forRunAt: string;
    readonly symbol: string;
    readonly osiSymbol?: string;
    readonly asOf: string;
    readonly referenceLabel?: string;
    readonly underlyingPrice?: number;
    readonly optionMark?: number;
    readonly theoreticalEntry?: number;
    readonly note?: string;
  }[];
}

/**
 * Records what actually happened, at a reference moment the operator names.
 *
 * `asOf` and `referenceLabel` are both required per outcome because "marked to
 * market" is meaningless without saying when: a 0DTE contract at 15:30 and the
 * same contract at the 16:00 close are different numbers, and the log has to say
 * which one it holds.
 */
async function runCloseLoop(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { input?: string; log?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { input: { type: "string" }, log: { type: "string" } },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  if (values.input === undefined) {
    deps.stderr(`--input is required.\n${USAGE}`);
    return 1;
  }

  let payload: CloseLoopPayload;
  try {
    payload = (await readInput(values.input)) as CloseLoopPayload;
  } catch (error) {
    deps.stderr(`Could not read --input: ${(error as Error).message}`);
    return 1;
  }

  const outcomes = payload.outcomes ?? [];
  if (outcomes.length === 0) {
    deps.stderr('Input needs an "outcomes" array with at least one entry.');
    return 1;
  }

  const recordedAt = payload.recordedAt ?? new Date().toISOString();
  const entries: OutcomeLogEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.asOf === undefined || outcome.asOf.trim() === "") {
      deps.stderr(`Outcome for ${outcome.symbol} is missing "asOf" — a mark with no reference time is not a mark.`);
      return 1;
    }
    const theoreticalPl =
      outcome.optionMark === undefined || outcome.theoreticalEntry === undefined
        ? undefined
        : Math.round((outcome.optionMark - outcome.theoreticalEntry) * 100) / 100;

    entries.push({
      kind: "OUTCOME",
      recordedAt,
      forRunAt: outcome.forRunAt,
      symbol: outcome.symbol,
      ...(outcome.osiSymbol === undefined ? {} : { osiSymbol: outcome.osiSymbol }),
      asOf: outcome.asOf,
      referenceLabel: outcome.referenceLabel ?? outcome.asOf,
      ...(outcome.underlyingPrice === undefined ? {} : { underlyingPrice: outcome.underlyingPrice }),
      ...(outcome.optionMark === undefined ? {} : { optionMark: outcome.optionMark }),
      ...(outcome.theoreticalEntry === undefined ? {} : { theoreticalEntry: outcome.theoreticalEntry }),
      ...(theoreticalPl === undefined ? {} : { theoreticalPlPerContract: theoreticalPl }),
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    });
  }

  const logPath = values.log ?? DEFAULT_LOG_PATH;
  try {
    await appendLogEntries(entries, logPath);
  } catch (error) {
    deps.stderr(`Could not append to the log: ${(error as Error).message}`);
    return 1;
  }

  deps.stdout(`Appended ${entries.length} outcome row(s) to ${logPath}`);
  for (const entry of entries) {
    const pl =
      entry.theoreticalPlPerContract === undefined
        ? "no mark"
        : `${formatUsd(entry.theoreticalPlPerContract * 100, true)} per contract vs theoretical entry`;
    deps.stdout(`  ${entry.symbol} @ ${entry.referenceLabel}: ${pl}`);
  }
  return 0;
}

async function runLogCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { log?: string; limit?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { log: { type: "string" }, limit: { type: "string" } },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  let entries: readonly LogEntry[];
  try {
    entries = await readLogEntries(values.log ?? DEFAULT_LOG_PATH);
  } catch (error) {
    deps.stderr(`Could not read the log: ${(error as Error).message}`);
    return 1;
  }

  if (entries.length === 0) {
    deps.stdout("No log rows yet.");
    return 0;
  }

  const limit = values.limit === undefined ? 20 : Number(values.limit);
  const shown = entries.slice(-Math.max(1, Number.isFinite(limit) ? limit : 20));
  const predictions = entries.filter((entry) => entry.kind === "PREDICTION").length;
  const withOutcomes = entries.filter((entry) => entry.kind === "OUTCOME").length;

  deps.stdout(`${entries.length} row(s): ${predictions} prediction(s), ${withOutcomes} outcome(s).`);
  for (const entry of shown) {
    if (entry.kind === "OUTCOME") {
      deps.stdout(
        `OUTCOME ${entry.symbol} for run ${entry.forRunAt} @ ${entry.referenceLabel}` +
          `${entry.theoreticalPlPerContract === undefined ? "" : ` — ${formatUsd(entry.theoreticalPlPerContract * 100, true)}/contract`}`,
      );
    } else {
      deps.stdout(
        `PREDICT ${entry.etDate} ${entry.slot} ${entry.symbol} ${entry.direction}` +
          `${entry.suggestedContracts === undefined ? "" : ` ×${entry.suggestedContracts}`}` +
          `${entry.blocked ? " [BLOCKED]" : ""} score ${entry.score}`,
      );
    }
  }
  return 0;
}

interface ExternalSignalAddPayload {
  readonly signals?: readonly ExternalSignal[];
}

/** Records one or more third-party calls, before their outcome is known. */
async function runExternalSignalAdd(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { input?: string; log?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { input: { type: "string" }, log: { type: "string" } },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  if (values.input === undefined) {
    deps.stderr(`--input is required.\n${USAGE}`);
    return 1;
  }

  let payload: ExternalSignalAddPayload;
  try {
    payload = (await readInput(values.input)) as ExternalSignalAddPayload;
  } catch (error) {
    deps.stderr(`Could not read --input: ${(error as Error).message}`);
    return 1;
  }

  const signals = payload.signals ?? [];
  if (signals.length === 0) {
    deps.stderr('Input needs a "signals" array with at least one entry.');
    return 1;
  }

  try {
    for (const signal of signals) validateExternalSignal(signal);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }

  const logPath = values.log ?? DEFAULT_EXTERNAL_SIGNAL_LOG_PATH;
  try {
    await appendExternalSignalEntries(
      signals.map((signal) => ({ kind: "SIGNAL" as const, ...signal })),
      logPath,
    );
  } catch (error) {
    deps.stderr(`Could not append to the log: ${(error as Error).message}`);
    return 1;
  }

  deps.stdout(`Recorded ${signals.length} external signal(s) to ${logPath}`);
  for (const signal of signals) {
    deps.stdout(`  ${signal.sourceName}: ${signal.symbol} ${signal.direction} — ${signal.videoUrl}`);
  }
  deps.stdout(
    "This is a tracked, ungraded call from a third-party source — not evidence, and not a recommendation " +
      "from this system. It will be scored once an outcome is recorded.",
  );
  return 0;
}

interface ExternalSignalOutcomePayload {
  readonly outcomes?: readonly ExternalSignalOutcome[];
}

/** Records what actually happened for one or more previously-tracked calls. */
async function runExternalSignalOutcome(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { input?: string; log?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { input: { type: "string" }, log: { type: "string" } },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  if (values.input === undefined) {
    deps.stderr(`--input is required.\n${USAGE}`);
    return 1;
  }

  let payload: ExternalSignalOutcomePayload;
  try {
    payload = (await readInput(values.input)) as ExternalSignalOutcomePayload;
  } catch (error) {
    deps.stderr(`Could not read --input: ${(error as Error).message}`);
    return 1;
  }

  const outcomes = payload.outcomes ?? [];
  if (outcomes.length === 0) {
    deps.stderr('Input needs an "outcomes" array with at least one entry.');
    return 1;
  }
  for (const outcome of outcomes) {
    if (outcome.asOf === undefined || outcome.asOf.trim() === "") {
      deps.stderr(`Outcome for ${outcome.videoUrl} is missing "asOf" — a mark with no reference time is not a mark.`);
      return 1;
    }
  }

  const logPath = values.log ?? DEFAULT_EXTERNAL_SIGNAL_LOG_PATH;
  let graded;
  try {
    await appendExternalSignalEntries(
      outcomes.map((outcome) => ({ kind: "OUTCOME" as const, ...outcome })),
      logPath,
    );
    const { signals, outcomes: allOutcomes } = splitExternalSignalLog(await readExternalSignalEntries(logPath));
    graded = gradeAllSignals(signals, allOutcomes).filter((entry) =>
      outcomes.some((outcome) => outcome.videoUrl === entry.signal.videoUrl && outcome.symbol === entry.signal.symbol),
    );
  } catch (error) {
    deps.stderr(`Could not record the outcome: ${(error as Error).message}`);
    return 1;
  }

  deps.stdout(`Recorded ${outcomes.length} outcome(s) to ${logPath}`);
  for (const entry of graded) {
    deps.stdout(`  ${entry.signal.sourceName} ${entry.signal.symbol}: ${entry.grade} — ${entry.reason}`);
  }
  return 0;
}

/** Prints the hit-rate stats this tracking exists to produce. */
async function runExternalSignalStats(rest: readonly string[], deps: CliDeps): Promise<number> {
  let values: { log?: string; source?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { log: { type: "string" }, source: { type: "string" } },
      allowPositionals: false,
    }) as { values: typeof values });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  const logPath = values.log ?? DEFAULT_EXTERNAL_SIGNAL_LOG_PATH;
  let stats;
  try {
    const { signals, outcomes } = splitExternalSignalLog(await readExternalSignalEntries(logPath));
    const graded = gradeAllSignals(signals, outcomes);
    stats = summariseBySource(graded).filter(
      (entry) => values.source === undefined || entry.sourceName === values.source,
    );
  } catch (error) {
    deps.stderr(`Could not read the log: ${(error as Error).message}`);
    return 1;
  }

  if (stats.length === 0) {
    deps.stdout("No tracked signals yet.");
    return 0;
  }

  for (const entry of stats) {
    const rate = entry.hitRate === undefined ? "no graded calls yet" : `${(entry.hitRate * 100).toFixed(1)}% hit rate`;
    deps.stdout(
      `${entry.sourceName}: ${entry.totalCalls} call(s) — ${entry.hits} hit, ${entry.misses} miss, ` +
        `${entry.ungraded} ungraded — ${rate}`,
    );
  }
  deps.stdout(
    "This is a track record, not evidence: too few calls make a hit rate meaningless, and a good record on " +
      "one symbol says nothing about another. Do not cite this in the skill until the sample says otherwise.",
  );
  return 0;
}

async function runExternalSignalCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "add") return runExternalSignalAdd(rest, deps);
  if (action === "outcome") return runExternalSignalOutcome(rest, deps);
  if (action === "stats") return runExternalSignalStats(rest, deps);
  deps.stderr(USAGE);
  return 1;
}

export async function runMarketReviewCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "check-in") return runCheckIn(rest, deps);
  if (subcommand === "close-loop") return runCloseLoop(rest, deps);
  if (subcommand === "log") return runLogCommand(rest, deps);
  if (subcommand === "external-signal") return runExternalSignalCommand(rest, deps);

  deps.stderr(USAGE);
  return 1;
}
