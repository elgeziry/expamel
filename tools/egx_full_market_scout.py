#!/usr/bin/env python3
"""Full-EGX opportunity scout: dynamic discovery, conservative entry and event journal.

Every V6 ranked stock is inspected. The limited Mubasher verification pool is
an execution gate, never a discovery boundary. It cannot place broker orders.
"""
import argparse
import datetime as dt
import json
import math
from collections import Counter
from pathlib import Path

MIN_UNIVERSE = 250
MAX_SHORTLIST = 18
MAX_RESEARCH_BACKLOG = 12
MAX_FRESH_NOTIFICATIONS = 5
EVENT_RETENTION_HOURS = 8
MAX_FIRST_TRANCHE = 6000
MAX_NEW_CAPITAL = 15000
MAX_POSITION_INITIAL = 3000
BUY_ACTIONS = {"BUY", "ACCUMULATE", "STRONG_BUY"}
BLOCKED_STATES = {"BLOCK_SHARIA", "BLOCK_VALUATION_RR",
                  "BLOCK_CORPORATE_ACTION", "BLOCKED_UNVERIFIED_EVIDENCE",
                  "BLOCK_EXTERNAL_QUOTE"}
INTERESTING = {"BUY_CANDIDATE_FINAL_CHECK", "WATCH_PRICE_CONFIRMED",
               "WATCH_QUOTE_PENDING", "NEAR_ENTRY", "RESEARCH_REQUIRED"}
POSITION_PRIORITY = {
    "BUY_CANDIDATE_FINAL_CHECK": 100,
    "WATCH_PRICE_CONFIRMED": 84,
    "WATCH_QUOTE_PENDING": 78,
    "NEAR_ENTRY": 66,
    "WAIT_REVERSAL": 45,
    "WAIT_PRICE": 30,
    "RESEARCH_REQUIRED": 20,
    "NOT_READY": 0,
    "EXCLUDED": -1,
}


def read(root, name, fallback=None):
    try:
        return json.loads((root / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        if fallback is not None:
            return fallback
        raise


def n(value):
    try:
        v = float(value)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def clean_date(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def classify(row, recovery, independent, session, global_healthy, buy_symbols,
             buy_market_allowed):
    symbol = str(row.get("symbol") or "").upper()
    research = row.get("research") or {}
    plan = row.get("execution_plan") or {}
    px = n(row.get("reference_close"))
    raw_zone = plan.get("entry_zone") or []
    lo, hi = (n(raw_zone[0]), n(raw_zone[1])) if len(raw_zone) == 2 else (None, None)
    valid_zone = bool(px and lo and hi and lo <= hi)
    score = n(row.get("score")) or 0
    cycle = n(recovery.get("cycle_strength")) or 0
    entry = n(recovery.get("entry_quality")) or 0
    rr = n(recovery.get("risk_reward")) or 0
    quality = n(recovery.get("quality_score_10")) or 0
    liquidity = n((row.get("market_row") or {}).get("liquidity_score")) or 0
    fundamental = n((row.get("components") or {}).get("fundamental_quality")) or 0
    valuation = n((row.get("components") or {}).get("valuation")) or 0
    verified = all([
        research.get("sharia_pass") is True,
        research.get("sharia_verified") is True,
        research.get("sharia_source_conflict") is not True,
        research.get("fundamentals_verified") is True,
        research.get("valuation_verified") is True,
        (row.get("corporate_action") or {}).get("technical_history_gate") is True,
    ])
    independent_ok = independent.get("verified") is True
    low_risk = (recovery.get("falling_knife_risk") is False and cycle >= 5
                and entry >= 6.2 and rr >= 6 and quality >= 7.4)
    no_chase = str(row.get("action") or "") in ("NO_CHASE", "AVOID")
    dist = (px / hi - 1) * 100 if valid_zone else None
    in_zone = bool(valid_zone and lo <= px <= hi)
    near = bool(valid_zone and dist is not None and 0 <= dist <= 3)
    invalidated = bool(px and n(plan.get("invalidation")) and
                       px <= n(plan.get("invalidation")))
    trigger = (symbol in buy_symbols and recovery.get("state") == "BUY_TRIGGER"
               and row.get("execution_ready") is True
               and row.get("action") in BUY_ACTIONS and buy_market_allowed)
    if not global_healthy:
        state = "NOT_READY"
        reason = "market_feed_or_session_not_consistent"
    elif research.get("sharia_verified") is True and research.get("sharia_pass") is not True:
        state, reason = "EXCLUDED", "sharia_failed"
    elif recovery.get("state") in ("BLOCK_SHARIA", "BLOCK_CORPORATE_ACTION"):
        state, reason = "EXCLUDED", "corporate_action_or_sharia_block"
    elif not verified:
        state = "RESEARCH_REQUIRED" if score >= 70 and liquidity >= 4 else "NOT_READY"
        reason = "financial_valuation_or_sharia_evidence_missing"
    elif recovery.get("state") == "BLOCK_VALUATION_RR":
        state, reason = "NOT_READY", "insufficient_expected_reward_vs_risk"
    elif invalidated:
        state, reason = "NOT_READY", "technical_invalidation"
    elif not valid_zone or score < 66 or quality < 7.1 or liquidity < 5 or fundamental < 7 or valuation < 6.5:
        state, reason = "NOT_READY", "below_quality_or_liquidity_threshold"
    elif trigger and in_zone and low_risk and independent_ok and not no_chase:
        state, reason = "BUY_CANDIDATE_FINAL_CHECK", "all_engine_gates_passed_broker_and_macro_still_required"
    elif in_zone and low_risk and not no_chase:
        state = "WATCH_PRICE_CONFIRMED" if independent_ok else "WATCH_QUOTE_PENDING"
        reason = "price_in_zone_reversal_ok_buy_engine_not_yet_confirmed"
    elif near and not no_chase and score >= 70 and cycle >= 4.5 and not recovery.get("falling_knife_risk"):
        state, reason = "NEAR_ENTRY", "within_three_percent_of_zone_watch_for_trigger"
    elif (in_zone or near) and score >= 70:
        state, reason = "WAIT_REVERSAL", "price_near_zone_but_trend_or_entry_not_confirmed"
    else:
        state, reason = "WAIT_PRICE", "quality_screened_wait_for_better_price"
    return {
        "symbol": symbol, "name": row.get("name"), "rank": row.get("rank"),
        "score_100": round(score, 2), "reference_price_egp": px,
        "entry_zone_egp": [lo, hi] if valid_zone else None,
        "distance_above_zone_pct": round(max(0, dist), 2) if dist is not None else None,
        "technical_invalidation_egp": n(plan.get("invalidation")),
        "quality_score_10": quality, "fundamental_score_10": fundamental,
        "valuation_score_10": valuation, "liquidity_score_10": liquidity,
        "cycle_score_10": cycle, "entry_quality_10": entry,
        "risk_reward_proxy_10": rr, "sharia_pass": research.get("sharia_pass") is True,
        "financial_and_sharia_verified": verified,
        "independent_quote_verified": independent_ok,
        "independent_quote_price_egp": independent.get("price_egp"),
        "independent_quote_time_cairo": independent.get("observation_time_cairo"),
        "independent_quote_age_minutes": independent.get("age_minutes"),
        "independent_quote_reason": independent.get("reason"),
        "engine_action": row.get("action"), "recovery_state": recovery.get("state"),
        "engine_buy_trigger": trigger, "falling_knife_risk": recovery.get("falling_knife_risk"),
        "state": state, "reason": reason,
        "rank_priority": POSITION_PRIORITY[state],
        "max_initial_budget_egp": MAX_POSITION_INITIAL,
        "order_status": "NOT_PLACED",
        "auto_execute": False,
        "requires_live_broker_quote": True,
        "requires_verified_egx30_foreign_flow_macro": True,
    }


def scan(root):
    now = dt.datetime.now(dt.timezone.utc)
    contract = read(root, "contract.json")
    v6 = read(root, "decision-intelligence-v6.json")
    recovery = read(root, "capital-recovery-alerts-v1.json")
    second = read(root, "independent-quote-audit.json")
    previous = read(root, "previous-market-opportunity-scout.json", {})
    session = contract.get("expected_reference_session_date")
    stocks = v6.get("all_ranked") or []
    recovery_by_symbol = {r.get("symbol"): r for r in (recovery.get("all_alerts") or [])}
    secondary_by_symbol = second.get("quotes") or {}
    stamps = [clean_date(contract.get("retrieved_at")), clean_date(v6.get("generated_at")),
              clean_date(recovery.get("generated_at")), clean_date(second.get("checked_at_utc"))]
    max_age = (now - stamps[0]).total_seconds() / 60 if stamps[0] else None
    globally_ok = bool(
        session and session == v6.get("reference_session") == recovery.get("reference_session") == second.get("session")
        and contract.get("bridge_gate") == "pass"
        and contract.get("execution_usable") is True
        and (v6.get("data_gates") or {}).get("pass") is True
        and len(stocks) >= MIN_UNIVERSE
        and all(stamps)
        and 0 <= max_age <= 20
    )
    allowed = (recovery.get("market_gate") or {}).get("new_buy_orders_allowed") is True
    buys = {z.get("symbol") for z in (recovery.get("buy_triggers") or [])}
    ranked = []
    for x in stocks:
        sym = str(x.get("symbol") or "").upper()
        ranked.append(classify(x, recovery_by_symbol.get(sym) or {},
                               secondary_by_symbol.get(sym) or {}, session,
                               globally_ok, buys, allowed))
    ranked.sort(key=lambda z: (-z["rank_priority"], -z["score_100"], z.get("rank") or 9999))
    watchable = [r for r in ranked if r["state"] in INTERESTING or r["state"] == "WAIT_REVERSAL"]
    promising = [r for r in ranked if r["financial_and_sharia_verified"] and r["state"] not in ("EXCLUDED","NOT_READY")]
    research = [r for r in ranked if r["state"] == "RESEARCH_REQUIRED"]
    # Snapshot states cover every symbol, not merely the top-watch shortlist.
    prev_states = previous.get("state_by_symbol") or {}
    bootstrap = not bool(previous.get("session"))
    events = []
    if globally_ok:
        for r in ranked:
            state = r["state"]
            sym = r["symbol"]
            prior = prev_states.get(sym)
            if state not in ("BUY_CANDIDATE_FINAL_CHECK", "WATCH_PRICE_CONFIRMED",
                             "WATCH_QUOTE_PENDING", "NEAR_ENTRY"):
                continue
            if state == "NEAR_ENTRY" and (r["score_100"] < 74 or
                                            r["cycle_score_10"] < 5):
                continue
            # Avoid duplicate alerts when a delayed source later catches up.
            prior_is_watch = prior in ("WATCH_PRICE_CONFIRMED","WATCH_QUOTE_PENDING")
            new_buy = state == "BUY_CANDIDATE_FINAL_CHECK" and prior != state
            new_zone = state in ("WATCH_PRICE_CONFIRMED","WATCH_QUOTE_PENDING") and not prior_is_watch
            new_near = state == "NEAR_ENTRY" and prior not in ("NEAR_ENTRY","WATCH_PRICE_CONFIRMED",
                                                                 "WATCH_QUOTE_PENDING","BUY_CANDIDATE_FINAL_CHECK")
            if not (new_buy or new_zone or new_near):
                continue
            if bootstrap and not new_buy:
                continue
            events.append({
                "symbol":sym,"kind":state,"previous_state":prior,
                "session":session,"observed_at_utc":now.isoformat(),
                "event_id":f"{session}:{sym}:{state}:{now.strftime('%H%M%S%f')}",
                "reference_price_egp":r["reference_price_egp"],
                "entry_zone_egp":r["entry_zone_egp"],
                "independent_quote_verified":r["independent_quote_verified"],
                "broker_and_macro_check_required":True,
                "not_an_order":True,
            })
    events.sort(key=lambda e: -POSITION_PRIORITY[e["kind"]])
    events = events[:MAX_FRESH_NOTIFICATIONS]
    recent=[]
    for old in previous.get("recent_events") or []:
        seen=clean_date(old.get("observed_at_utc"))
        if (old.get("session")==session and old.get("event_id") and seen
                and dt.timedelta(0) <= now-seen <= dt.timedelta(hours=EVENT_RETENTION_HOURS)):
            recent.append(old)
    recent.extend(events)
    recent = list({x["event_id"]:x for x in recent}.values())[-100:]
    summary = {
        "scanned":len(ranked),"v6_ranked":len(stocks),
        "research_fully_verified":sum(bool(r["financial_and_sharia_verified"]) for r in ranked),
        "research_incomplete":sum(r["state"]=="RESEARCH_REQUIRED" for r in ranked),
        "sharia_excluded":sum(r["state"]=="EXCLUDED" for r in ranked),
        "watchable":len(watchable),"eligible_quality_scanned":len(promising),
        "engine_confirmed_buy_triggers":len(buys),
        "new_events":len(events),"retained_recent_events":len(recent),
        "states":dict(Counter(r["state"] for r in ranked)),
    }
    report = {
        "schema":"egx-full-market-opportunity-scout-v1",
        "generated_at_utc":now.isoformat(),
        "session":session,"reference_source":"decision-intelligence-v6.json",
        "primary_retrieved_at_utc":contract.get("retrieved_at"),
        "primary_age_minutes":round(max_age,2) if max_age is not None else None,
        "independent_source_checked_at_utc":second.get("checked_at_utc"),
        "health":"PASS" if globally_ok else "BLOCKED",
        "all_295_stocks_evaluated":len(ranked)>=MIN_UNIVERSE and len(ranked)==len(stocks),
        "does_not_limit_discovery_to_fixed_symbols":True,
        "sharia_and_fundamentals_fail_closed":True,
        "max_additional_cash_egp":MAX_NEW_CAPITAL,
        "first_tranche_ceiling_egp":MAX_FIRST_TRANCHE,
        "maximum_initial_per_symbol_egp":MAX_POSITION_INITIAL,
        "orders_placed":0,
        "no_broker_connection_or_automatic_execution":True,
        "external_egx30_foreign_flow_currency_and_broker_verification_required":True,
        "summary":summary,
        "shortlist":watchable[:MAX_SHORTLIST],
        "research_queue":research[:MAX_RESEARCH_BACKLOG],
        "top_quality_waiting":promising[:15],
        "all_stock_states":[{"symbol":r["symbol"],"rank":r["rank"],
                             "score":r["score_100"],"state":r["state"],
                             "sharia_pass":r["sharia_pass"],
                             "research_complete":r["financial_and_sharia_verified"]}
                            for r in ranked],
        "state_by_symbol":{r["symbol"]:r["state"] for r in ranked},
        "new_events":events,"recent_events":recent,
        "recent_event_retention_hours":EVENT_RETENTION_HOURS,
        "events_are_preliminary_not_orders":True,
        "note":"Scans all V6 symbols. Independent provider quote checks are capped and stale sources never authorize buys; provisional zone alerts may prompt manual confirmation.",
    }
    (root/"market-opportunity-scout-v1.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"status":report["health"],"session":session,"scanned":len(ranked),
                      "shortlist":[(r["symbol"],r["state"]) for r in report["shortlist"]],
                      "new_events":events},ensure_ascii=False))
    return report


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",default=".")
    args=p.parse_args()
    x=scan(Path(args.root))
    raise SystemExit(0 if x["health"]=="PASS" else 1)
