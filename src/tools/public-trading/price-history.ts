import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PriceBar } from "./types";

/**
 * The disk sink for price history.
 *
 * `.agents/skills/crypto-signal-eval/SKILL.md` is explicit under "Token
 * efficiency": price history must never be read into an agent's context — a
 * year of daily bars is large, a month of hourly bars is larger — it goes to a
 * file that `backtest.py` and `baseline.py` read. This function is that sink,
 * and it emits exactly the CSV header those scripts expect
 * (`date,open,high,low,close,volume`).
 *
 * The review pipeline never calls this. It exists so that when a signal is
 * actually being evaluated, the correct path is the obvious one.
 */
export async function writePriceHistoryCsv(bars: readonly PriceBar[], path: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const header = "date,open,high,low,close,volume";
  const rows = bars.map((bar) =>
    [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume].join(","),
  );
  await writeFile(path, `${[header, ...rows].join("\n")}\n`, "utf-8");
  return bars.length;
}
