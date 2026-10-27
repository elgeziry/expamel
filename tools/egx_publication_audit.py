#!/usr/bin/env python3
"""Audit EGX output freshness and execution consistency. No external dependencies."""
import argparse
import datetime as dt
import json
from pathlib import Path

FILES = ("decision-intelligence-v6.json", "capital-recovery-alerts-v1.json")

def check(root, session):
    issues, data = [], {}
    for name in FILES:
        try:
            obj = json.loads((root / name).read_text(encoding="utf-8"))
            data[name] = obj
            if obj.get("reference_session") != session:
                issues.append(f"{name}: stale reference_session={obj.get('reference_session')}")
            stamp = dt.datetime.fromisoformat(obj["generated_at"].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                issues.append(f"{name}: missing timestamp timezone")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            issues.append(f"{name}: unreadable or invalid ({exc})")
    if len(data) == 2:
        decision, recovery = (data[name] for name in FILES)
        if not decision.get("data_gates", {}).get("pass"):
            issues.append("decision engine data gate failed")
        gate = recovery.get("market_gate", {})
        if gate.get("new_buy_orders_allowed") is False and recovery.get("buy_triggers"):
            issues.append("buy triggers present while market gate prohibits buys")
    return {"status": "BLOCKED" if issues else "PASS",
            "reference_session": session, "issues": issues,
            "scope": "Output consistency only; does not verify external price authenticity or Sharia."}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--session", required=True, help="Verified latest completed EGX session YYYY-MM-DD")
    args = parser.parse_args()
    result = check(Path(args.root), args.session)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(bool(result["issues"]))
