import {
  normaliseHistoryPage,
  normalisePortfolio,
  normalisePreflight,
  normaliseQuote,
  type HistoryQuery,
  type PriceHistoryQuery,
  type PublicTradingClient,
} from "./client";
import { parseOptionalDecimal } from "./decimal";
import type { DraftOrder, PortfolioSnapshot, PreflightResult, PriceBar, Quote, Transaction } from "./types";

/**
 * How this module reaches the Public MCP connector: the caller supplies one
 * function that invokes a named MCP tool and returns its raw result. Whoever
 * builds that function decides which tools are reachable at all — in the
 * coworker check-in the caller is a Claude session with the connector already
 * attached, and in a test it is a stub.
 *
 * The tool names below are the only ones this module ever passes. Every one is
 * read-only except `preflight_order`, which validates without executing.
 * `place_order` and its siblings are never named here, and `PublicTradingClient`
 * gives no method that could reach them.
 */
export type McpToolCall = (toolName: PublicReadToolName, args: Record<string, unknown>) => Promise<unknown>;

/** The exact allowlist of Public MCP tools this system uses. */
export type PublicReadToolName =
  | "get_portfolio"
  | "get_history"
  | "get_quotes"
  | "get_price_history"
  | "preflight_order";

export const PUBLIC_READ_TOOLS: readonly PublicReadToolName[] = [
  "get_portfolio",
  "get_history",
  "get_quotes",
  "get_price_history",
  "preflight_order",
];

/**
 * The connector wraps its JSON payload in `{"result": "<json string>"}` — the
 * body arrives as a *string*, not a nested object — so every response has to be
 * unwrapped and re-parsed before normalisation. Tolerates a plain object too,
 * in case a future connector version stops double-encoding.
 */
export function unwrapMcpResult(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (typeof raw === "object" && raw !== null && "result" in raw) {
    const inner = (raw as { result: unknown }).result;
    return typeof inner === "string" ? JSON.parse(inner) : inner;
  }
  return raw;
}

/** Guards against a runaway pagination loop if the connector ever returns a fixed cursor. */
const MAX_HISTORY_PAGES = 50;

/**
 * Binds an `McpToolCall` into the read-only client the rest of the module uses.
 */
export function createPublicTradingClient(call: McpToolCall): PublicTradingClient {
  return {
    async getPortfolio(accountId: string): Promise<PortfolioSnapshot> {
      return normalisePortfolio(unwrapMcpResult(await call("get_portfolio", { account_id: accountId })));
    },

    async getHistory(accountId: string, options: HistoryQuery = {}): Promise<readonly Transaction[]> {
      const collected: Transaction[] = [];
      const seen = new Set<string>();
      let nextToken: string | undefined;
      let pages = 0;

      // A page can come back holding fewer transactions than `page_size` and
      // still have more behind it: the page size counts raw account events
      // (order updates and the like), which the connector filters out of the
      // `transactions` array. So the loop follows `nextToken` to exhaustion
      // rather than stopping on a short page, which would silently truncate a
      // run's history and understate P/L.
      do {
        const page = normaliseHistoryPage(
          unwrapMcpResult(
            await call("get_history", {
              account_id: accountId,
              ...(options.start ? { start: options.start } : {}),
              ...(options.end ? { end: options.end } : {}),
              ...(options.pageSize ? { page_size: options.pageSize } : {}),
              ...(nextToken ? { next_token: nextToken } : {}),
            }),
          ),
        );
        for (const transaction of page.transactions) {
          if (transaction.id !== "" && seen.has(transaction.id)) continue;
          if (transaction.id !== "") seen.add(transaction.id);
          collected.push(transaction);
        }
        nextToken = page.nextToken;
        pages += 1;
      } while (nextToken !== undefined && pages < MAX_HISTORY_PAGES);

      return collected;
    },

    async getQuotes(
      accountId: string,
      symbols: readonly string[],
      instrumentType = "CRYPTO",
    ): Promise<readonly Quote[]> {
      if (symbols.length === 0) return [];
      const result = unwrapMcpResult(
        await call("get_quotes", {
          account_id: accountId,
          symbols: [...symbols],
          instrument_type: instrumentType,
        }),
      );
      const rows = Array.isArray(result)
        ? result
        : Array.isArray((result as { quotes?: unknown })?.quotes)
          ? ((result as { quotes: unknown[] }).quotes as unknown[])
          : [];
      return rows.map(normaliseQuote);
    },

    async getPriceHistory(
      accountId: string,
      symbol: string,
      options: PriceHistoryQuery = {},
    ): Promise<readonly PriceBar[]> {
      const result = unwrapMcpResult(
        await call("get_price_history", {
          account_id: accountId,
          symbol,
          ...(options.period ? { period: options.period } : {}),
          ...(options.interval ? { interval: options.interval } : {}),
          instrument_type: options.instrumentType ?? "CRYPTO",
        }),
      );
      const rows = Array.isArray(result)
        ? result
        : Array.isArray((result as { candles?: unknown })?.candles)
          ? ((result as { candles: unknown[] }).candles as unknown[])
          : Array.isArray((result as { bars?: unknown })?.bars)
            ? ((result as { bars: unknown[] }).bars as unknown[])
            : [];
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          date: String(record["date"] ?? record["timestamp"] ?? record["time"] ?? ""),
          open: parseOptionalDecimal(record["open"], 0),
          high: parseOptionalDecimal(record["high"], 0),
          low: parseOptionalDecimal(record["low"], 0),
          close: parseOptionalDecimal(record["close"], 0),
          volume: parseOptionalDecimal(record["volume"], 0),
        };
      });
    },

    async preflightOrder(accountId: string, order: DraftOrder): Promise<PreflightResult> {
      return normalisePreflight(
        unwrapMcpResult(
          await call("preflight_order", {
            account_id: accountId,
            symbol: order.symbol,
            instrument_type: order.instrumentType,
            order_side: order.side,
            order_type: order.orderType,
            time_in_force: order.timeInForce ?? "DAY",
            // The API treats amount and quantity as mutually exclusive.
            ...(order.amount !== undefined ? { amount: order.amount.toFixed(2) } : {}),
            ...(order.quantity !== undefined ? { quantity: String(order.quantity) } : {}),
            ...(order.limitPrice !== undefined ? { limit_price: order.limitPrice.toFixed(2) } : {}),
            ...(order.stopPrice !== undefined ? { stop_price: order.stopPrice.toFixed(2) } : {}),
          }),
        ),
      );
    },
  };
}
