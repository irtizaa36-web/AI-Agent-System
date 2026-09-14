"""Does the signal beat a random entry with the same holding rules?"""
import random, statistics as stats
from backtest import load, signals, run, summarize, ROUND_TRIP_COST

bars = load("dot_daily.csv")
random.seed(7)

# signal performance
ents = signals(bars, 20, 2.0, 20)
sig = summarize(run(bars, ents, 5, 0.08, None))

# random entries, same count, same exit rules, 2000 draws
valid = range(20, len(bars) - 6)
means = []
for _ in range(2000):
    picks = sorted(random.sample(list(valid), len(ents)))
    s = summarize(run(bars, picks, 5, 0.08, None))
    if s:
        means.append(s["mean"])

means.sort()
better = sum(1 for m in means if m >= sig["mean"])
print(f"Signal mean per trade:      {sig['mean']*100:+.2f}%  (n={sig['n']})")
print(f"Random-entry mean (median): {stats.median(means)*100:+.2f}%")
print(f"Random 5th-95th pctile:     {means[100]*100:+.2f}% to {means[1900]*100:+.2f}%")
print(f"Random draws >= signal:     {better}/{len(means)} = {better/len(means)*100:.0f}%")
print()
print("Interpretation: if that last number is large, the signal is")
print("indistinguishable from picking entry dates at random.")
