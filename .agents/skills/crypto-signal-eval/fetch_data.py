"""
Pull OHLCV from the Public MCP connector into the CSV the backtest expects.

Run this from a Claude Code session that has the Public connector enabled.
Write to disk; never read the raw response into context.

    public:get_price_history(symbol="DOT", period="YEAR",
                             instrument_type="CRYPTO")

then pass the response dict to save():
"""

import json


def save(response, path):
    """response: the get_price_history dict. path: output CSV."""
    if isinstance(response, str):
        response = json.loads(response)
    bars = response["regularMarket"]["bars"]
    with open(path, "w") as f:
        f.write("date,open,high,low,close,volume\n")
        for b in bars:
            f.write("{},{},{},{},{},{}\n".format(
                b["timestamp"][:10],
                b["open"], b["high"], b["low"], b["close"], b["volume"],
            ))
    return len(bars)


if __name__ == "__main__":
    import sys
    with open(sys.argv[1]) as f:
        n = save(json.load(f), sys.argv[2])
    print(f"wrote {n} bars to {sys.argv[2]}")
