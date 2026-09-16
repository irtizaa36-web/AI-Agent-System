import { parseDecimal, parseOptionalDecimal } from "../public-trading/decimal";
// The portfolio shape and its normaliser are identical here — same connector,
// same response — so they are imported rather than duplicated. `PortfolioSnapshot`
// is a data type and `normalisePortfolio` is a pure function; neither carries
// any capability, so reusing them does not widen this module's reach.
import { normalisePortfolio } from "../public-trading/client";
import type { PortfolioSnapshot } from "../public-trading/types";
import { parseOsiSymbol } from "./osi";
import type {
  ChainLeg,
  ChainRow,
  ChainSnapshot,
  Greeks,
  OptionQuote,
  UnderlyingQuote,
} from "./types";

/**
 * The port this system talks to the Public.com connector through.
 *
 * **The safety boundary is the shape of this interface.** Every method reads.
 * There is no `placeOrder`, no `cancelOrder`, no `preflightOrder` — this module
 * does not even validate an order against the broker, because it never proposes
 * one as an executable action — and no generic `call(toolName, …)` escape hatch.
 * "It cannot place, modify, or cancel an order" is therefore enforced by the
 * type system at compile time rather than by a runtime guard a later edit could
 * quietly drop, matching the repo's standing rule that reading and drafting are
 * separate from consequential execution (README safety principle 1, ADR 0004).
 *
 * This module also does not read, pause, or control the existing Public.com
 * Agents in `docs/registry/PROJECT-REGISTRY.md` §8. It observes the same account
 * those agents trade in, and says so wherever it reports a position.
 */
export interface MarketReviewClient {
  /**
   * Quotes for underlyings: stocks, ETFs, and indices. VIX is reachable here
   * with `instrumentType: "INDEX"` — verified against the live connector, so
   * the volatility gauge is the index itself rather than an ETF proxy.
   */
  getUnderlyingQuotes(symbols: readonly string[], instrumentType?: string): Promise<readonly UnderlyingQuote[]>;
  /** Quotes for specific contracts, by OSI symbol. */
  getOptionQuotes(osiSymbols: readonly string[]): Promise<readonly OptionQuote[]>;
  /** Every listed expiration for an underlying, ascending. */
  getOptionExpirations(underlying: string): Promise<readonly string[]>;
  /** A full chain for one expiration, Greeks included (the vendor returns them inline). */
  getOptionChain(underlying: string, expiration: string): Promise<ChainSnapshot>;
  /** Greeks for specific contracts, when pulling a whole chain would be wasteful. */
  getGreeks(osiSymbols: readonly string[]): Promise<readonly Greeks[]>;
  /** The account snapshot, for holdings-based candidates and catalyst checks. */
  getPortfolio(): Promise<PortfolioSnapshot>;
}

/** The exact allowlist of Public MCP tools this module uses. Every one is read-only. */
export type MarketReadToolName =
  | "get_quotes"
  | "get_option_expirations"
  | "get_option_chain"
  | "get_option_greeks"
  | "get_portfolio";

export const MARKET_READ_TOOLS: readonly MarketReadToolName[] = [
  "get_quotes",
  "get_option_expirations",
  "get_option_chain",
  "get_option_greeks",
  "get_portfolio",
];

/**
 * How this module reaches the connector: the caller supplies one function that
 * invokes a named tool. The name type above is the allowlist — a call to
 * anything else does not type-check.
 */
export type McpToolCall = (toolName: MarketReadToolName, args: Record<string, unknown>) => Promise<unknown>;

/**
 * The connector wraps its payload in `{"result": "<json string>"}` — the body
 * arrives as a *string* — so every response is unwrapped and re-parsed before
 * normalisation. Tolerates a plain object too, in case that changes.
 */
export function unwrapMcpResult(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (typeof raw === "object" && raw !== null && "result" in raw) {
    const inner = (raw as { result: unknown }).result;
    return typeof inner === "string" ? JSON.parse(inner) : inner;
  }
  return raw;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected an object for ${context}, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Reads an optional numeric field, returning undefined rather than a misleading zero. */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The API reports percentages as whole numbers ("5.45" meaning 5.45%). Ratios everywhere inside. */
function percentToRatio(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === undefined ? undefined : parsed / 100;
}

export function normaliseUnderlyingQuote(raw: unknown): UnderlyingQuote {
  const record = asRecord(raw, "quote");
  const instrument = asRecord(record["instrument"] ?? {}, "quote.instrument");
  const oneDayChange = asRecord(record["oneDayChange"] ?? {}, "quote.oneDayChange");
  const bid = optionalNumber(record["bid"]);
  const ask = optionalNumber(record["ask"]);
  const previousClose = optionalNumber(record["previousClose"]);
  const dayChangeRatio = percentToRatio(oneDayChange["percentChange"]);
  const dayHigh = optionalNumber(record["high"] ?? record["dayHigh"]);
  const dayLow = optionalNumber(record["low"] ?? record["dayLow"]);
  const timestamp = record["lastTimestamp"];

  return {
    symbol: asString(instrument["symbol"], asString(record["symbol"])),
    last: parseDecimal(record["last"] ?? record["lastPrice"] ?? record["price"], "quote.last"),
    ...(bid === undefined ? {} : { bid }),
    ...(ask === undefined ? {} : { ask }),
    ...(previousClose === undefined ? {} : { previousClose }),
    ...(dayChangeRatio === undefined ? {} : { dayChangeRatio }),
    ...(dayHigh === undefined ? {} : { dayHigh }),
    ...(dayLow === undefined ? {} : { dayLow }),
    ...(typeof timestamp === "string" ? { timestamp } : {}),
  };
}

/**
 * Normalises one option quote row.
 *
 * `last` is parsed as optional-with-zero-fallback rather than required,
 * because a contract that has never traded really does report `"last": "0.00"`
 * with a stale timestamp. That zero is faithful to the source and must not be
 * mistaken for a price — `analysis.ts` prefers bid/ask over `last` and flags
 * stale prints, rather than this function inventing a value.
 */
export function normaliseOptionQuote(raw: unknown): OptionQuote {
  const record = asRecord(raw, "option quote");
  const instrument = asRecord(record["instrument"] ?? {}, "option quote.instrument");
  const bid = optionalNumber(record["bid"]);
  const ask = optionalNumber(record["ask"]);
  const volume = optionalNumber(record["volume"]);
  const openInterest = optionalNumber(record["openInterest"]);
  const timestamp = record["lastTimestamp"];

  return {
    osiSymbol: asString(instrument["symbol"], asString(record["symbol"])),
    last: parseOptionalDecimal(record["last"], 0),
    ...(bid === undefined ? {} : { bid }),
    ...(ask === undefined ? {} : { ask }),
    ...(volume === undefined ? {} : { volume }),
    ...(openInterest === undefined ? {} : { openInterest }),
    ...(typeof timestamp === "string" ? { timestamp } : {}),
  };
}

/**
 * Normalises a Greeks block.
 *
 * Values are kept exactly as reported, including the `impliedVolatility: 0`
 * that deep-in-the-money strikes return alongside `delta: ±1`. That zero is a
 * vendor artifact, not a real reading — but correcting it here would hide it,
 * so it survives into `analysis.ts`, which excludes such rows from any IV
 * comparison and says why.
 */
export function normaliseGreeks(osiSymbol: string, raw: unknown): Greeks {
  const record = asRecord(raw, "greeks");
  return {
    osiSymbol,
    delta: parseOptionalDecimal(record["delta"], 0),
    gamma: parseOptionalDecimal(record["gamma"], 0),
    theta: parseOptionalDecimal(record["theta"], 0),
    vega: parseOptionalDecimal(record["vega"], 0),
    rho: parseOptionalDecimal(record["rho"], 0),
    impliedVolatility: parseOptionalDecimal(record["impliedVolatility"], 0),
  };
}

/** Maps a raw `get_option_greeks` response onto one `Greeks` per contract. */
export function normaliseGreeksResponse(raw: unknown): readonly Greeks[] {
  const record = asRecord(raw, "greeks response");
  return asArray(record["greeks"]).map((row) => {
    const entry = asRecord(row, "greeks entry");
    return normaliseGreeks(asString(entry["symbol"]), entry["greeks"] ?? {});
  });
}

/** Maps one raw chain row (a call or a put) onto a `ChainLeg`. */
export function normaliseChainLeg(raw: unknown): ChainLeg {
  const record = asRecord(raw, "chain leg");
  const quote = normaliseOptionQuote(record);
  const details = asRecord(record["optionDetails"] ?? {}, "chain leg.optionDetails");
  const midPrice = optionalNumber(details["midPrice"]);
  const greeksRaw = details["greeks"];

  return {
    contract: parseOsiSymbol(quote.osiSymbol),
    quote,
    ...(greeksRaw === undefined || greeksRaw === null
      ? {}
      : { greeks: normaliseGreeks(quote.osiSymbol, greeksRaw) }),
    ...(midPrice === undefined ? {} : { midPrice }),
  };
}

/**
 * Maps a raw `get_option_chain` response onto a `ChainSnapshot`.
 *
 * Calls and puts arrive as two flat arrays; they are joined on strike here so
 * every downstream consumer reads one row per strike. The strike comes from the
 * parsed OSI symbol rather than `optionDetails.strikePrice`, because the OSI
 * symbol is the contract's identity and the two must agree — if they ever
 * disagree, trusting the identity is the safer of the two.
 */
export function normaliseChain(raw: unknown): ChainSnapshot {
  const record = asRecord(raw, "chain");
  const byStrike = new Map<number, { call?: ChainLeg; put?: ChainLeg }>();

  for (const rawLeg of asArray(record["calls"])) {
    const leg = normaliseChainLeg(rawLeg);
    const existing = byStrike.get(leg.contract.strike) ?? {};
    byStrike.set(leg.contract.strike, { ...existing, call: leg });
  }
  for (const rawLeg of asArray(record["puts"])) {
    const leg = normaliseChainLeg(rawLeg);
    const existing = byStrike.get(leg.contract.strike) ?? {};
    byStrike.set(leg.contract.strike, { ...existing, put: leg });
  }

  const rows: ChainRow[] = [...byStrike.entries()]
    .sort(([a], [b]) => a - b)
    .map(([strike, sides]) => ({
      strike,
      ...(sides.call === undefined ? {} : { call: sides.call }),
      ...(sides.put === undefined ? {} : { put: sides.put }),
    }));

  // Expiration comes from the contracts themselves rather than the request, so
  // a snapshot is self-describing even when read back from a saved input file.
  const firstLeg = rows[0]?.call ?? rows[0]?.put;

  return {
    underlying: asString(record["baseSymbol"]),
    expiration: firstLeg?.contract.expiration ?? asString(record["expirationDate"]),
    rows,
  };
}

/** Maps a raw `get_option_expirations` response onto ascending YYYY-MM-DD strings. */
export function normaliseExpirations(raw: unknown): readonly string[] {
  const record = asRecord(raw, "expirations");
  return asArray(record["expirations"])
    .filter((value): value is string => typeof value === "string")
    .slice()
    .sort();
}

/** Binds an `McpToolCall` into the read-only client the rest of the module uses. */
export function createMarketReviewClient(call: McpToolCall, accountId: string): MarketReviewClient {
  return {
    async getUnderlyingQuotes(symbols, instrumentType = "EQUITY") {
      if (symbols.length === 0) return [];
      const result = unwrapMcpResult(
        await call("get_quotes", {
          account_id: accountId,
          symbols: [...symbols],
          instrument_type: instrumentType,
        }),
      );
      const rows = Array.isArray(result) ? result : asArray(asRecord(result, "quotes")["quotes"]);
      return rows.map(normaliseUnderlyingQuote);
    },

    async getOptionQuotes(osiSymbols) {
      if (osiSymbols.length === 0) return [];
      const result = unwrapMcpResult(
        await call("get_quotes", {
          account_id: accountId,
          symbols: [...osiSymbols],
          instrument_type: "OPTION",
        }),
      );
      const rows = Array.isArray(result) ? result : asArray(asRecord(result, "quotes")["quotes"]);
      return rows.map(normaliseOptionQuote);
    },

    async getOptionExpirations(underlying) {
      return normaliseExpirations(
        unwrapMcpResult(await call("get_option_expirations", { account_id: accountId, symbol: underlying })),
      );
    },

    async getOptionChain(underlying, expiration) {
      return normaliseChain(
        unwrapMcpResult(
          await call("get_option_chain", {
            account_id: accountId,
            symbol: underlying,
            expiration_date: expiration,
          }),
        ),
      );
    },

    async getGreeks(osiSymbols) {
      if (osiSymbols.length === 0) return [];
      return normaliseGreeksResponse(
        unwrapMcpResult(await call("get_option_greeks", { account_id: accountId, osi_symbols: [...osiSymbols] })),
      );
    },

    async getPortfolio() {
      return normalisePortfolio(unwrapMcpResult(await call("get_portfolio", { account_id: accountId })));
    },
  };
}
