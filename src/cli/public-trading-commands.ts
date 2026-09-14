import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { normalisePortfolio, normaliseTransaction } from "../tools/public-trading/client";
import { buildReview } from "../tools/public-trading/review";
import { DEFAULT_REVIEW_DIR, readLatestWatermark, writeReview } from "../tools/public-trading/review-store";
import { unwrapMcpResult } from "../tools/public-trading/mcp-client";
import { formatPercent, formatUsd } from "../tools/public-trading/decimal";
import type { CliDeps } from "./index";
import type { Transaction } from "../tools/public-trading/types";

/**
 * `orchestrator public-trading review` — the daily monitoring run.
 *
 * The MCP connector lives in the Claude session, not in this Node process, so
 * the split is: the session calls the four read tools, pipes their raw
 * responses in as JSON, and this command does the analysis, the watermark
 * continuity and the file writing deterministically. That keeps every number in
 * a review reproducible from a saved input, and keeps the connector's
 * credentials out of this process entirely.
 *
 * It writes a review file and nothing else. It cannot place an order: the
 * module it calls exposes no method that could.
 */

const USAGE = [
  "Usage:",
  "  orchestrator public-trading review --input <file|-> [--dir <path>] [--run-at <iso>]",
  "",
  "  --input   JSON with the raw Public MCP responses, or '-' to read stdin:",
  '            {"accountId": "...", "portfolio": <get_portfolio result>,',
  '             "history": <get_history result | array of transactions>}',
  `  --dir     Where reviews are written (default: ${DEFAULT_REVIEW_DIR})`,
  "  --run-at  ISO timestamp for the run (default: now)",
].join("\n");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Accepts history either as a full `get_history` response or as a bare array of
 * transactions, since a session may have already unwrapped one page or stitched
 * several together.
 */
function extractTransactions(raw: unknown): readonly Transaction[] {
  const unwrapped = unwrapMcpResult(raw);
  const rows = Array.isArray(unwrapped)
    ? unwrapped
    : Array.isArray((unwrapped as { transactions?: unknown })?.transactions)
      ? ((unwrapped as { transactions: unknown[] }).transactions as unknown[])
      : [];
  return rows.map(normaliseTransaction);
}

export async function runPublicTradingCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand !== "review") {
    deps.stderr(USAGE);
    return 1;
  }

  let values: { input?: string; dir?: string; "run-at"?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        input: { type: "string" },
        dir: { type: "string" },
        "run-at": { type: "string" },
      },
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

  let payload: { accountId?: string; portfolio?: unknown; history?: unknown };
  try {
    const text = values.input === "-" ? await readStdin() : await readFile(values.input, "utf-8");
    payload = JSON.parse(text) as typeof payload;
  } catch (error) {
    deps.stderr(`Could not read --input: ${(error as Error).message}`);
    return 1;
  }

  if (payload.portfolio === undefined) {
    deps.stderr('Input is missing "portfolio" (the raw get_portfolio result).');
    return 1;
  }

  const dir = values.dir ?? DEFAULT_REVIEW_DIR;
  const runAt = values["run-at"] ?? new Date().toISOString();

  let review;
  try {
    const snapshot = normalisePortfolio(unwrapMcpResult(payload.portfolio));
    const transactions = extractTransactions(payload.history ?? []);
    const previousWatermark = await readLatestWatermark(dir);

    review = buildReview({
      runAt,
      accountId: payload.accountId ?? snapshot.accountId,
      snapshot,
      transactions,
      ...(previousWatermark === undefined ? {} : { previousWatermark }),
      // No validated signal is registered, so no candidate can exist and this
      // run monitors and reports only. See tools/public-trading/signals.ts.
      drafts: {
        drafts: [],
        rejected: [],
        suppressedReason:
          "No validated signal is registered, so this run monitors and reports only. Zero signals have cleared " +
          "the backtest plus random-entry baseline bar in .agents/skills/crypto-signal-eval/SKILL.md. Until one " +
          "does, proposing a trade would be acting on a hypothesis.",
      },
    });
  } catch (error) {
    deps.stderr(`Could not build the review: ${(error as Error).message}`);
    return 1;
  }

  const written = await writeReview(review, dir);

  deps.stdout(`Wrote ${written.path}`);
  deps.stdout(
    `Account ${formatUsd(review.snapshot.totalAccountValue)}, buying power ${formatUsd(review.snapshot.buyingPower)}, ` +
      `${review.closedSinceLastRunSummary.count} round trip(s) closed since last run ` +
      `(${formatUsd(review.closedSinceLastRunSummary.totalRealisedPl, true)}).`,
  );
  if (review.costDrag.sampleSize > 0) {
    deps.stdout(
      `Realised cost drag ${formatPercent(review.costDrag.realisedRoundTrip)} vs ` +
        `${formatPercent(review.costDrag.baseline)} baseline.`,
    );
  }
  for (const flag of review.concentration.flags) deps.stdout(`⚠️  ${flag}`);
  if (review.orderFeasibility.infeasible) {
    for (const note of review.orderFeasibility.notes) deps.stdout(`⚠️  ${note}`);
  }
  deps.stdout("No trades drafted — monitoring only until a signal clears the evidence bar.");

  return 0;
}
