#!/usr/bin/env python3
"""EGX opportunity watch: audited, non-executing alerts for EGAL and ORWE.

Uses latest V6 entry zones, independent-price quality, and final recovery-engine
execution gates. Price-only entry never authorizes a buy. External EGX30,
foreign-flow, macro and broker quotes must be checked by the alert agent.
"""
import argparse
import datetime as dt
import json
import math
from pathlib import Path

TARGETS = {
    "EGAL": {"priority": 1, "name_ar": "مصر للألومنيوم", "start_fraction": .28, "end_fraction": .60,
             "initial_tactical_zone": [289, 293], "initial_as_of": "2026-10-27", "allocation_egp": 3000},
    "ORWE": {"priority": 2, "name_ar": "النساجون الشرقيون", "start_fraction": .37, "end_fraction": .80,
             "initial_tactical_zone": [23.40, 23.70], "initial_as_of": "2026-10-27", "allocation_egp": 3000},
}
TOTAL_ADDITIONAL_EGP = 15000
FIRST_TRANCHE_CAP_EGP = 6000
FEE_RESERVE_RATIO = .01


def load(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        if fallback is not None:
            return fallback
        raise


def price(v):
    try:
        x = float(v)
        return x if math.isfinite(x) and x > 0 else None
    except (TypeError, ValueError):
        return None


def build(root):
    contract = load(root / "contract.json")
    decision = load(root / "decision-intelligence-v6.json")
    alerts = load(root / "capital-recovery-alerts-v1.json")
    independent = load(root / "independent-quote-audit.json")
    previous = load(root / "previous-opportunity-watch.json", {})
    session = contract.get("expected_reference_session_date")
    same_session = bool(session and session == decision.get("reference_session")
                        and session == alerts.get("reference_session")
                        and session == independent.get("session"))
    valid_feed = contract.get("bridge_gate") == "pass" and contract.get("execution_usable") is True and same_session
    ranked = {x.get("symbol"): x for x in (decision.get("all_ranked") or [])}
    alert_rows = {x.get("symbol"): x for x in (alerts.get("all_alerts") or [])}
    buy_symbols = {x.get("symbol") for x in (alerts.get("buy_triggers") or [])}
    prev_rows = {x.get("symbol"): x for x in (previous.get("targets") or [])}
    rows, events = [], []

    for symbol, cfg in TARGETS.items():
        stock = ranked.get(symbol, {})
        recovery = alert_rows.get(symbol, {})
        source = independent.get("quotes", {}).get(symbol, {})
        anchor = price(stock.get("reference_close"))
        zone = (stock.get("execution_plan") or {}).get("entry_zone") or []
        if len(zone) == 2 and price(zone[0]) and price(zone[1]) and zone[0] <= zone[1]:
            low, high = map(float, zone)
            tactical = [round(low + (high-low)*cfg["start_fraction"], 2),
                        round(low + (high-low)*cfg["end_fraction"], 2)]
        else:
            low, high, tactical = None, None, None

        research = stock.get("research") or {}
        verified_research = all([
            research.get("sharia_verified") is True,
            research.get("sharia_pass") is True,
            research.get("fundamentals_verified") is True,
            research.get("valuation_verified") is True,
            (stock.get("corporate_action") or {}).get("technical_history_gate") is True,
        ])
        sharia_conflict = research.get("sharia_source_conflict") is True
        verified_quote = source.get("verified") is True and independent.get("session") == session
        in_zone = bool(tactical and anchor and tactical[0] <= anchor <= tactical[1])
        invalidation = price((stock.get("execution_plan") or {}).get("invalidation"))
        invalidated = bool(anchor and invalidation and anchor <= invalidation)
        trend_ok = (recovery.get("falling_knife_risk") is False
                    and (recovery.get("cycle_strength") or 0) >= 5
                    and (recovery.get("entry_quality") or 0) >= 6.2)
        buy_confirmed_by_engine = (symbol in buy_symbols and recovery.get("state") == "BUY_TRIGGER"
                                   and stock.get("action") in ("BUY","STRONG_BUY","ACCUMULATE")
                                   and stock.get("execution_ready") is True
                                   and (alerts.get("market_gate") or {}).get("new_buy_orders_allowed") is True)
        if not valid_feed or not verified_research or sharia_conflict:
            state = "NO_ALERT_DATA_OR_RESEARCH_BLOCKED"
        elif invalidated:
            state = "INVALIDATED"
        elif not in_zone:
            state = "WAIT_PRICE"
        elif not trend_ok:
            state = "WAIT_REVERSAL"
        elif not verified_quote:
            # Make the price-area crossing visible to the watch, but NEVER allow a buy.
            # The real-time quote is primary-only; it must be rechecked at the broker.
            state = "WATCH_ZONE_SOURCE_PENDING"
        elif buy_confirmed_by_engine:
            state = "BUY_CANDIDATE_MACRO_CHECK_REQUIRED"
        else:
            state = "WATCH_ZONE_NO_BUY_ORDER"

        qty = (math.floor(cfg["allocation_egp"]*(1-FEE_RESERVE_RATIO) / anchor)
               if anchor and state == "BUY_CANDIDATE_MACRO_CHECK_REQUIRED" else 0)
        row = {
            "symbol": symbol, "name_ar": cfg["name_ar"], "priority": cfg["priority"],
            "reference_price_egp": anchor, "engine_entry_zone": [low,high] if low else None,
            "watch_zone_egp": tactical, "initial_watch_zone_20261027_egp": cfg["initial_tactical_zone"],
            "watch_zone_method": "dynamic_fraction_of_latest_v6_entry_zone",
            "invalidation_egp": invalidation,
            "engine_action": stock.get("action"), "recovery_state": recovery.get("state"),
            "verified_research": verified_research, "sharia_source_conflict": sharia_conflict,
            "independent_quote_verified": verified_quote,
            "independent_source_time": source.get("observation_time_cairo"),
            "independent_quote_age_minutes": source.get("age_minutes"),
            "engine_buy_trigger": buy_confirmed_by_engine,
            "price_in_watch_zone": in_zone, "reversal_confirmed": trend_ok,
            "state": state, "can_place_order_automatically": False,
            "requires_egx30_foreign_flow_and_macro_check": True,
            "max_planned_budget_egp": cfg["allocation_egp"],
            "suggested_quantity_after_final_checks": qty,
            "suggested_notional_before_fees_egp": round(qty*anchor,2) if anchor and qty else 0,
            "order_status": "NOT_PLACED",
        }
        old_state = (prev_rows.get(symbol) or {}).get("state")
        watch_states = ("WATCH_ZONE_SOURCE_PENDING","WATCH_ZONE_NO_BUY_ORDER",
                        "BUY_CANDIDATE_MACRO_CHECK_REQUIRED")
        old_is_watch = old_state in watch_states
        if state in watch_states and (not old_is_watch or
                                      (state == "BUY_CANDIDATE_MACRO_CHECK_REQUIRED" and
                                       old_state != state)):
            # Alert once on first zone entry, and once again only on promotion to
            # a confirmed engine candidate. No repetitive stale-source messages.
            if previous.get("session") or state == "BUY_CANDIDATE_MACRO_CHECK_REQUIRED":
                events.append({"symbol":symbol, "kind":state,
                               "needs_external_macro_validation": True,
                               "requires_broker_price_confirmation": True,
                               "message":"Watch-only candidate; not a placed or authorized buy order"})
        if old_state in watch_states and state == "INVALIDATED":
            events.append({"symbol":symbol,"kind":"CANCEL_SETUP","message":"Technical setup invalidated; do not buy"})
        rows.append(row)

    # The market publisher refreshes every few minutes, while ChatGPT alerts
    # check hourly. Retain pending events so a transient crossing cannot vanish.
    # Use stable IDs across republishes for deduplication by the alert task.
    utc_now = dt.datetime.now(dt.timezone.utc)
    lookback_hours = 8
    recent = []
    for old in previous.get("recent_events", []):
        if old.get("session") != session or not old.get("event_id"):
            continue
        try:
            seen = dt.datetime.fromisoformat(old["occurred_at_utc"].replace("Z", "+00:00"))
            if seen.tzinfo and dt.timedelta(0) <= utc_now-seen <= dt.timedelta(hours=lookback_hours):
                recent.append(old)
        except (KeyError, ValueError, TypeError):
            continue
    for event in events:
        event["session"] = session
        event["occurred_at_utc"] = utc_now.isoformat()
        event["event_id"] = f"{session}:{event['symbol']}:{event['kind']}:{utc_now.strftime('%H%M%S%f')}"
        recent.append(event)
    recent = list({event["event_id"]: event for event in recent}.values())[-100:]

    result = {
        "schema":"egx-opportunity-watch-v1", "generated_at":dt.datetime.now(dt.timezone.utc).isoformat(),
        "session":session, "source_sessions_consistent":same_session, "bridge_usable":valid_feed,
        "source_files":["contract.json","decision-intelligence-v6.json",
                        "capital-recovery-alerts-v1.json","independent-quote-audit.json"],
        "capital_limit_egp":TOTAL_ADDITIONAL_EGP, "first_tranche_limit_egp":FIRST_TRANCHE_CAP_EGP,
        "per_stock_max_egp":3000, "reserved_cash_at_least_egp":9000,
        "no_auto_execution":True,
        "candidate_always_requires_external_egx30_foreign_flow_broker_validation":True,
        "targets":rows, "new_events":events, "new_event_count":len(events),
        "recent_events":recent, "recent_events_count":len(recent),
        "event_history_retention_hours":lookback_hours,
        "notes":"Watch levels derive from each fresh V6 dynamic entry zone; original 27 Oct levels are historical reference only. Source delay never implies current tradable price."
    }
    (root / "opportunity-watch-v1.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"session":session,"states":{x["symbol"]:x["state"] for x in rows},
                      "new_events":len(events)},ensure_ascii=False))
    return result


if __name__ == "__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--root",default=".")
    args=ap.parse_args()
    build(Path(args.root))
