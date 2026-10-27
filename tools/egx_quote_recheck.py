#!/usr/bin/env python3
"""Validate published EGX price packet against independently fetched scanner snapshot.

This is a second network observation, NOT an independent market-data provider.
Never equate retrieval time with exchange trade time.
"""
import argparse
import datetime as dt
import json
import math
import sys
import urllib.request
from pathlib import Path

URL = "https://scanner.tradingview.com/egypt/scan"
FOCUS = ("EFID", "EGAL", "MFPC", "JUFO", "ETEL", "AMOC")

def verify(root: Path):
    contract = json.loads((root / "contract.json").read_text())
    universe = json.loads((root / "universe.json").read_text())
    recovery = json.loads((root / "capital-recovery-alerts-v1.json").read_text())
    decision = json.loads((root / "decision-intelligence-v6.json").read_text())
    problems = []
    session = contract.get("expected_reference_session_date")
    for name, doc in (("recovery", recovery), ("decision", decision)):
        if doc.get("reference_session") != session:
            problems.append(f"{name}: session mismatch")
    if contract.get("bridge_gate") != "pass" or contract.get("execution_usable") is not True:
        problems.append("market bridge is not usable")
    if recovery.get("market_gate", {}).get("new_buy_orders_allowed") is False and recovery.get("buy_triggers"):
        problems.append("buy trigger violates market gate")
    original = {str(x.get("symbol", "")).upper(): x for x in universe.get("stocks", [])}
    payload = json.dumps({"symbols": {"query": {"types": []}}, "columns": ["name", "close", "volume"], "range": [0, 500]}).encode()
    request = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json", "User-Agent": "EGX-Quote-Audit/1.0"}, method="POST")
    with urllib.request.urlopen(request, timeout=35) as response:
        snapshot = json.load(response)
    live = {}
    for item in snapshot.get("data", []):
        vals = item.get("d", [])
        if len(vals) >= 3 and vals[0]:
            live[str(vals[0]).upper()] = {"close": vals[1], "volume": vals[2]}
    results = []
    for symbol in FOCUS:
        old, fresh = original.get(symbol), live.get(symbol)
        if not old or not fresh:
            problems.append(f"{symbol}: missing in one observation")
            continue
        a, b = old.get("close"), fresh.get("close")
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (a, b)):
            problems.append(f"{symbol}: invalid close")
            continue
        deviation = abs(a - b) / b * 100
        results.append({"symbol": symbol, "published_close": a, "fresh_close": b, "difference_pct": round(deviation, 3)})
        if deviation > 1:
            problems.append(f"{symbol}: close changed by {deviation:.2f}% between observations")
    return {"status": "PASS" if not problems else "BLOCKED", "session": session,
            "checked_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "same_provider_recheck": True, "independent_provider_verified": False,
            "exchange_quote_timestamp_verified": False,
            "rows_checked": results, "issues": problems}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    try:
        result = verify(Path(args.root))
    except Exception as exc:
        result = {"status": "BLOCKED", "issues": [str(exc)], "independent_provider_verified": False}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "PASS" else 1)
