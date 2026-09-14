"""
Signal backtest engine. See SKILL.md for established findings.

We have OHLCV only. No funding rates, no open interest, no liquidation data.
So the actual squeeze precondition (crowded shorts) is NOT observable here.
What we can test is the *confirmation* leg: an expansion-volume breakout
above recent highs, which is what a squeeze looks like on a price chart.

Treat results as an upper bound on a price-only version of the idea.
"""

import json
import statistics as stats

ROUND_TRIP_COST = 0.0075  # 0.75%: matches the slippage observed on the
                          # user's own SOL/BTC round trips in Public


def load(path):
    rows = []
    with open(path) as f:
        next(f)
        for line in f:
            p = line.strip().split(",")
            if len(p) < 6:
                continue
            rows.append({
                "date": p[0],
                "open": float(p[1]),
                "high": float(p[2]),
                "low": float(p[3]),
                "close": float(p[4]),
                "volume": float(p[5]),
            })
    return rows


def signals(bars, lookback, vol_mult, vol_window):
    """Bar i triggers if close > prior `lookback` highs AND volume spike."""
    out = []
    start = max(lookback, vol_window)
    for i in range(start, len(bars)):
        prior_high = max(b["high"] for b in bars[i - lookback:i])
        med_vol = stats.median(b["volume"] for b in bars[i - vol_window:i])
        if bars[i]["close"] > prior_high and bars[i]["volume"] >= vol_mult * med_vol:
            out.append(i)
    return out


def run(bars, entries, hold, stop_pct, target_pct):
    """Enter next bar's open. Exit on stop, target, or after `hold` bars."""
    trades = []
    for i in entries:
        if i + 1 >= len(bars):
            continue
        entry = bars[i + 1]["open"]
        stop = entry * (1 - stop_pct)
        target = entry * (1 + target_pct) if target_pct else None
        exit_px, reason, held = None, None, 0

        for j in range(i + 1, min(i + 1 + hold, len(bars))):
            held = j - i
            if bars[j]["low"] <= stop:
                exit_px, reason = stop, "stop"
                break
            if target and bars[j]["high"] >= target:
                exit_px, reason = target, "target"
                break
        if exit_px is None:
            k = min(i + hold, len(bars) - 1)
            exit_px, reason, held = bars[k]["close"], "time", k - i

        gross = (exit_px - entry) / entry
        trades.append({
            "date": bars[i]["date"],
            "entry": entry,
            "exit": exit_px,
            "ret": gross - ROUND_TRIP_COST,
            "gross": gross,
            "reason": reason,
            "held": held,
        })
    return trades


def summarize(trades):
    if not trades:
        return None
    rets = [t["ret"] for t in trades]
    wins = [r for r in rets if r > 0]
    eq = 1.0
    peak, mdd = 1.0, 0.0
    for r in rets:
        eq *= (1 + r)
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    mean = sum(rets) / len(rets)
    sd = stats.stdev(rets) if len(rets) > 1 else 0.0
    return {
        "n": len(trades),
        "win_rate": len(wins) / len(trades),
        "mean": mean,
        "median": stats.median(rets),
        "best": max(rets),
        "worst": min(rets),
        "total": eq - 1,
        "mdd": mdd,
        "sharpe_per_trade": (mean / sd) if sd else 0.0,
    }


def buy_hold(bars):
    return bars[-1]["close"] / bars[0]["close"] - 1


def pct(x):
    return f"{x * 100:+.1f}%"


if __name__ == "__main__":
    bars = load("dot_daily.csv")
    print(f"DOT daily bars: {len(bars)}  ({bars[0]['date']} to {bars[-1]['date']})")
    print(f"Buy and hold over window: {pct(buy_hold(bars))}")
    print(f"Round-trip cost assumed:  {ROUND_TRIP_COST * 100:.2f}%")
    print()

    configs = []
    for lookback in (10, 20, 30):
        for vol_mult in (1.5, 2.0, 3.0):
            for hold in (3, 5, 10):
                configs.append((lookback, vol_mult, hold))

    rows = []
    for lookback, vol_mult, hold in configs:
        ents = signals(bars, lookback, vol_mult, vol_window=20)
        tr = run(bars, ents, hold, stop_pct=0.08, target_pct=None)
        s = summarize(tr)
        if s:
            rows.append((lookback, vol_mult, hold, s))

    print(f"{'look':>5} {'vol':>5} {'hold':>5} {'n':>4} {'win%':>6} {'mean':>8} {'total':>9} {'maxDD':>8}")
    print("-" * 60)
    for lb, vm, hd, s in rows:
        print(f"{lb:>5} {vm:>5.1f} {hd:>5} {s['n']:>4} "
              f"{s['win_rate'] * 100:>5.0f}% {pct(s['mean']):>8} "
              f"{pct(s['total']):>9} {pct(s['mdd']):>8}")

    print()
    print("Trade-by-trade for the config closest to the Sept 7-8 setup")
    print("(20-day breakout, 2x volume, 5-day hold, 8% stop):")
    print()
    ents = signals(bars, 20, 2.0, 20)
    tr = run(bars, ents, 5, 0.08, None)
    print(f"{'date':>12} {'entry':>8} {'exit':>8} {'net':>8} {'why':>7} {'days':>5}")
    for t in tr:
        print(f"{t['date']:>12} {t['entry']:>8.3f} {t['exit']:>8.3f} "
              f"{pct(t['ret']):>8} {t['reason']:>7} {t['held']:>5}")
    s = summarize(tr)
    print()
    print(f"n={s['n']}  win={s['win_rate'] * 100:.0f}%  mean={pct(s['mean'])}  "
          f"median={pct(s['median'])}  total={pct(s['total'])}  maxDD={pct(s['mdd'])}")
    print(f"best={pct(s['best'])}  worst={pct(s['worst'])}  "
          f"sharpe/trade={s['sharpe_per_trade']:.2f}")
