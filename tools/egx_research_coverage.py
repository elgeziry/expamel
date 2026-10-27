#!/usr/bin/env python3
"""Evidence coverage for the complete Egyptian equity universe.

A market-derived ratio is not an independently audited disclosure.
A reported EGX33 membership is not an automatic full AAOIFI audit.
This is a research expansion, NOT blanket trade authorization.
"""
import argparse
import datetime as dt
import json
import math
from collections import Counter
from pathlib import Path

MIN_MARKET=250
MAX_RESEARCH_PRIORITY=80
FIN_FIELDS=("price_earnings_current","eps_diluted_growth_percent_fy",
            "free_cash_flow_ttm","debt_to_equity_fq","total_revenue_ttm")


def read(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        if fallback is not None:
            return fallback
        raise


def valid(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def make(root, membership_file):
    contract=read(root/"contract.json")
    universe=read(root/"universe.json")
    v6=read(root/"decision-intelligence-v6.json")
    alerts=read(root/"capital-recovery-alerts-v1.json")
    membership=read(membership_file)
    session=contract.get("expected_reference_session_date")
    universe_stocks={str(r.get("symbol") or "").upper():r for r in universe.get("stocks",[])}
    candidates=v6.get("all_ranked") or []
    recovery={x.get("symbol"):x for x in alerts.get("all_alerts",[])}
    sharia_index=set(membership.get("symbols_reported") or [])
    if len(candidates)<MIN_MARKET or len(universe_stocks)<MIN_MARKET:
        raise ValueError("Full EGX universe missing; no successful evidence coverage audit")
    if session!=v6.get("reference_session") or session!=alerts.get("reference_session"):
        raise ValueError("Reference sessions disagree")
    rows=[]
    for stock in candidates:
        symbol=str(stock.get("symbol") or "").upper()
        raw=universe_stocks.get(symbol,{})
        research=stock.get("research") or {}
        state=recovery.get(symbol,{})
        price=stock.get("reference_close")
        point_scores=stock.get("components") or {}
        ratio_fields={key:raw.get(key) if valid(raw.get(key)) else None for key in FIN_FIELDS}
        available=[key for key,v in ratio_fields.items() if v is not None]
        gaps=[]
        sharia_verified=research.get("sharia_verified") is True and research.get("sharia_pass") is True
        independent_finance=research.get("fundamentals_verified") is True
        independent_valuation=research.get("valuation_verified") is True
        indexed=symbol in sharia_index
        source_conflict=research.get("sharia_source_conflict") is True
        if not sharia_verified:gaps.append("independent_sharia_verification")
        if source_conflict:gaps.append("sharia_source_conflict_resolution")
        if not independent_finance:gaps.append("company_financial_statements")
        if not independent_valuation:gaps.append("independent_valuation_evidence")
        if stock.get("corporate_action",{}).get("technical_history_gate") is False:
            gaps.append("corporate_action_normalization")
        if state.get("state")=="BLOCK_VALUATION_RR":
            gaps.append("insufficient_target_reward_risk")
        score=float(stock.get("score") or 0)
        liq=float(point_scores.get("liquidity") or 0)
        fund=float(point_scores.get("fundamental_quality") or 0)
        val=float(point_scores.get("valuation") or 0)
        entry=float(point_scores.get("entry_quality") or 0)
        risk=float(point_scores.get("risk_reward_proxy") or 0)
        cycle=float(point_scores.get("cycle_relative_strength") or 0)
        distance=state.get("entry_state",{}).get("distance_pct")
        near=(state.get("entry_state",{}).get("state")=="IN_ZONE" or
              (isinstance(distance,(int,float)) and 0<=distance<=4))
        sharia_known_fail=(research.get("sharia_verified") is True and
                           research.get("sharia_pass") is not True)
        ready=(sharia_verified and independent_finance and independent_valuation and
               not source_conflict and stock.get("execution_ready") is True
               and not sharia_known_fail)
        if sharia_known_fail:
            stage="SHARIA_NOT_ELIGIBLE"
        elif ready and state.get("state")=="BUY_TRIGGER":
            stage="MARKET_TRIGGER_REQUIRES_INDEPENDENT_PRICE_AND_MACRO"
        elif ready:
            stage="VERIFIED_RESEARCH_MONITOR_ENTRY"
        elif indexed:
            stage="INDEX_MEMBERSHIP_RESEARCH_PRIORITY"
        elif source_conflict:
            stage="CONFLICTING_SHARIA_RESEARCH_PRIORITY"
        else:
            stage="OPEN_RESEARCH_NOT_EXECUTABLE"
        # Discovery priority is deliberately independent of active holdings.
        urgency=round(score*.55 + liq*2 + fund*1.3 + val*1.2 + entry*1 +
                      risk*.7 + cycle*.6 + (10 if near else 0) +
                      (9 if indexed else 0) + len(available)*1.2 -
                      (30 if sharia_known_fail else 0),2)
        rows.append({
            "symbol":symbol,"name":stock.get("name"),"v6_rank":stock.get("rank"),
            "v6_score_100":round(score,2),"research_priority_score":urgency,
            "reference_price_egp":price,
            "sharia_index_membership_reported":indexed,
            "reported_membership_as_of":membership.get("published_on") if indexed else None,
            "reported_membership_source":membership.get("source_url") if indexed else None,
            "sharia_verified":sharia_verified,"sharia_conflicting_sources":source_conflict,
            "company_financials_independently_verified":independent_finance,
            "valuation_independently_verified":independent_valuation,
            "research_completion":sum([sharia_verified,independent_finance,independent_valuation]),
            "technical_cycle_score_10":cycle,
            "valuation_proxy_score_10":val,"fundamentals_proxy_score_10":fund,
            "market_data_ratios_unverified":ratio_fields,
            "market_data_ratio_fields_available":len(available),
            "market_data_is_not_audited_company_financials":True,
            "technical_near_entry":near,
            "recovery_state":state.get("state"),
            "current_action":stock.get("action"),
            "analysis_stage":stage,
            "missing_verified_evidence":gaps,
            "possible_to_recommend_for_watch":not sharia_known_fail and
               (score>=55 or indexed) and liq>=4,
            "purchase_authorized":False,
            "broker_price_required":True,
        })
    research_queue=sorted([r for r in rows if r["missing_verified_evidence"] and
                           r["analysis_stage"]!="SHARIA_NOT_ELIGIBLE"],
                          key=lambda z:(-z["research_priority_score"],z["symbol"]))
    proposed=[r for r in rows if r["possible_to_recommend_for_watch"]]
    known_good=[r for r in rows if r["analysis_stage"]=="VERIFIED_RESEARCH_MONITOR_ENTRY"]
    stages=Counter(r["analysis_stage"] for r in rows)
    result={
        "schema":"egx-market-wide-research-coverage-v1",
        "generated_at_utc":dt.datetime.now(dt.timezone.utc).isoformat(),
        "reference_session":session,
        "source_universe_total":len(universe_stocks),
        "scanned":len(rows),
        "full_market_audit_pass":len(rows)==len(candidates)>=MIN_MARKET,
        "source_v6":"decision-intelligence-v6.json",
        "reported_index_source":membership.get("source_url"),
        "index_membership_evidence_limitations":membership.get("count_discrepancy_note"),
        "source_provenance":{"market_ratios":"TradingView Egypt scanner (provisional and undated per underlying accounting period)",
                            "index_membership":"EGX33 reported list 2026-10-05; prioritization evidence only",
                            "verified_research":"V6 verifiedResearch; originals require company IR/EGX disclosure sources"},
        "safeguards":{"all_stocks_have_research_state":True,
                      "provisional_ratios_never_promoted_to_audited":True,
                      "index_presence_does_not_authorize_buy":True,
                      "no_inferred_sharia_fail_for_non_members":True,
                      "preserve_known_noncompliant":True,
                      "no_live_quote_without_timestamp":True},
        "summary":{
            "market_scanned":len(rows),
            "reported_egx33_members_in_market":sum(r["sharia_index_membership_reported"] for r in rows),
            "research_fully_verified":sum(r["research_completion"]==3 and not r["sharia_conflicting_sources"] for r in rows),
            "sharia_index_research_leads":sum(r["analysis_stage"]=="INDEX_MEMBERSHIP_RESEARCH_PRIORITY" for r in rows),
            "research_backlog":len(research_queue),
            "watch_analysis_candidates":len(proposed),
            "known_sharia_fail":sum(r["analysis_stage"]=="SHARIA_NOT_ELIGIBLE" for r in rows),
            "stage_counts":dict(stages),
        },
        "priority_research_queue":research_queue[:MAX_RESEARCH_PRIORITY],
        "verified_research_watch":sorted(known_good,key=lambda x:-x["research_priority_score"])[:30],
        "full_research_queue":research_queue,
        "all_coverage":sorted(rows,key=lambda x:(x["v6_rank"] or 9999,x["symbol"])),
        "non_trade_recommendation_policy":"All 295 can be discussed with tagged research quality, but no purchase without verified financial+Sharia+valuation, independent fresh quote, technical setup and broker/macro check",
    }
    (root/"research-coverage-v1.json").write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding="utf-8")
    print(json.dumps({"status":"PASS","scanned":len(rows),"summary":result["summary"],
                      "top_research":[r["symbol"] for r in research_queue[:12]]},ensure_ascii=False))
    return result


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",default=".")
    p.add_argument("--index",default="egx33-research-evidence-2026.json")
    args=p.parse_args()
    make(Path(args.root),Path(args.index))
