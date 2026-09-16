import type { PortfolioSnapshot } from "../public-trading/types";
import { isOsiSymbol } from "./osi";
import type { Candidate, CandidateSource } from "./types";

/**
 * Where the names in a check-in come from.
 *
 * Three sources merge into one list: the account's current holdings, a curated
 * watchlist kept in the repo, and whatever a market scan surfaced for the day.
 * A name appearing in more than one keeps every source, because "it is both a
 * holding and today's biggest mover" is the interesting case and collapsing it
 * to one label would lose that.
 *
 * The market-scan rows are supplied by the caller rather than fetched here. A
 * scan needs live news and mover data that arrives through the session's
 * connectors (and, for macro events, plain web search), and the moment this
 * module started fetching them the numbers in a report would stop being
 * reproducible from a saved input file. Everything in this file is pure.
 */

/** The curated watchlist file's on-disk shape. */
export interface WatchlistConfig {
  /** Tickers to review every run regardless of holdings or scan results. */
  readonly tickers: readonly string[];
  /**
   * Underlyings whose option chains are worth pulling. A name can be worth
   * watching as a stock without its options being liquid enough to analyse.
   */
  readonly optionUnderlyings?: readonly string[];
  /** Free-text note per ticker, surfaced in the report so the reason is never lost. */
  readonly notes?: Readonly<Record<string, string>>;
}

/** One row a market scan produced. Deliberately dumb: a symbol and why it showed up. */
export interface ScanHit {
  readonly symbol: string;
  readonly note: string;
}

export interface BuildCandidatesInput {
  readonly snapshot?: PortfolioSnapshot;
  readonly watchlist?: WatchlistConfig;
  readonly scanHits?: readonly ScanHit[];
  /**
   * Skip holdings below this share of the account. Defaults to 0 — every
   * holding is checked — because a small position can still carry an earnings
   * date, and silently dropping names is the kind of gap that is invisible in
   * the output.
   */
  readonly minPortfolioWeight?: number;
}

/** Normalises a symbol for comparison: upper case, trimmed. */
function normaliseSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Validates and normalises a watchlist read off disk.
 *
 * Rejects an OSI option symbol in the ticker list: the watchlist names
 * *underlyings*, and a specific contract slipped in there would silently fail
 * every quote and catalyst lookup that assumes a plain ticker.
 */
export function parseWatchlistConfig(raw: unknown): WatchlistConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Watchlist config must be an object, got ${JSON.stringify(raw)}`);
  }
  const record = raw as Record<string, unknown>;
  const rawTickers = record["tickers"];
  if (!Array.isArray(rawTickers)) {
    throw new Error('Watchlist config needs a "tickers" array.');
  }

  const tickers: string[] = [];
  for (const entry of rawTickers) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`Watchlist tickers must be non-empty strings, got ${JSON.stringify(entry)}`);
    }
    const symbol = normaliseSymbol(entry);
    if (isOsiSymbol(symbol)) {
      throw new Error(
        `Watchlist tickers name underlyings, not contracts: ${symbol} is an OSI option symbol. ` +
          "Put the underlying (e.g. SPY) here instead.",
      );
    }
    if (!tickers.includes(symbol)) tickers.push(symbol);
  }

  const rawUnderlyings = record["optionUnderlyings"];
  const optionUnderlyings = Array.isArray(rawUnderlyings)
    ? rawUnderlyings.filter((value): value is string => typeof value === "string").map(normaliseSymbol)
    : undefined;

  const rawNotes = record["notes"];
  const notes =
    typeof rawNotes === "object" && rawNotes !== null
      ? Object.fromEntries(
          Object.entries(rawNotes as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [normaliseSymbol(key), value as string]),
        )
      : undefined;

  return {
    tickers,
    ...(optionUnderlyings === undefined ? {} : { optionUnderlyings }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Merges holdings, watchlist and scan hits into one candidate list.
 *
 * Ordering is deliberate and stable: holdings first (they carry real exposure
 * right now), then watchlist names, then scan-only names. Within a group,
 * holdings sort by weight descending so the largest exposure is never buried,
 * and the rest sort alphabetically so two runs over the same inputs produce
 * byte-identical output.
 */
export function buildCandidates(input: BuildCandidatesInput): readonly Candidate[] {
  const minWeight = input.minPortfolioWeight ?? 0;
  interface CandidateAccumulator {
    sources: CandidateSource[];
    portfolioWeight?: number;
    notes: string[];
  }
  const bySymbol = new Map<string, CandidateAccumulator>();

  const ensure = (symbol: string): CandidateAccumulator => {
    const existing = bySymbol.get(symbol);
    if (existing !== undefined) return existing;
    const created: CandidateAccumulator = { sources: [], notes: [] };
    bySymbol.set(symbol, created);
    return created;
  };

  for (const position of input.snapshot?.positions ?? []) {
    // Option positions are reported against their own OSI symbol; the catalyst
    // and quote work needs the underlying, and the holding that matters for
    // exposure is the underlying's.
    if (isOsiSymbol(position.symbol)) continue;
    if (position.percentOfPortfolio < minWeight) continue;

    const entry = ensure(normaliseSymbol(position.symbol));
    if (!entry.sources.includes("HOLDING")) entry.sources.push("HOLDING");
    entry.portfolioWeight = position.percentOfPortfolio;
  }

  for (const ticker of input.watchlist?.tickers ?? []) {
    const symbol = normaliseSymbol(ticker);
    const entry = ensure(symbol);
    if (!entry.sources.includes("WATCHLIST")) entry.sources.push("WATCHLIST");
    const note = input.watchlist?.notes?.[symbol];
    if (note !== undefined && !entry.notes.includes(note)) entry.notes.push(note);
  }

  for (const hit of input.scanHits ?? []) {
    const symbol = normaliseSymbol(hit.symbol);
    const entry = ensure(symbol);
    if (!entry.sources.includes("MARKET_SCAN")) entry.sources.push("MARKET_SCAN");
    if (!entry.notes.includes(hit.note)) entry.notes.push(hit.note);
  }

  const rank = (sources: readonly CandidateSource[]): number => {
    if (sources.includes("HOLDING")) return 0;
    if (sources.includes("WATCHLIST")) return 1;
    return 2;
  };

  return [...bySymbol.entries()]
    .map(([symbol, entry]) => ({
      symbol,
      sources: entry.sources,
      ...(entry.portfolioWeight === undefined ? {} : { portfolioWeight: entry.portfolioWeight }),
      ...(entry.notes.length === 0 ? {} : { note: entry.notes.join("; ") }),
    }))
    .sort((a, b) => {
      const byRank = rank(a.sources) - rank(b.sources);
      if (byRank !== 0) return byRank;
      const weightDelta = (b.portfolioWeight ?? 0) - (a.portfolioWeight ?? 0);
      if (weightDelta !== 0) return weightDelta;
      return a.symbol.localeCompare(b.symbol);
    });
}

/**
 * Which candidates are worth pulling an option chain for.
 *
 * A chain pull is the most expensive call in a run, so this narrows to the
 * explicit `optionUnderlyings` list when one exists. With no list configured it
 * returns nothing rather than every candidate: pulling chains for two dozen
 * names would be slow, would bury the report, and is never what a check-in
 * needs — the underlyings whose options matter are a deliberate choice, not a
 * side effect of holding a stock.
 */
export function optionUnderlyingsFor(
  candidates: readonly Candidate[],
  watchlist: WatchlistConfig | undefined,
): readonly string[] {
  const allowed = watchlist?.optionUnderlyings;
  if (allowed === undefined || allowed.length === 0) return [];
  const candidateSymbols = new Set(candidates.map((candidate) => candidate.symbol));
  // Keep the configured order: it reflects the priority the human assigned.
  return allowed.filter((symbol) => candidateSymbols.has(symbol));
}
