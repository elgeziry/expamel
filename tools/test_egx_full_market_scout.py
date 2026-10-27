#!/usr/bin/env python3
"""Tests proving that daily discoveries are global, gated, nonexecuting and deduped."""
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
import egx_full_market_scout as scout

SESSION="2026-10-27"


def stock(symbol, rank, score=76, sharia=True, complete=True, quote=19.8, zone=None):
    if zone is None:
        zone=[19.2,20.0]
    return {
        "symbol":symbol,"name":symbol,"rank":rank,"score":score,"reference_close":quote,
        "action":"WAIT_ENTRY","execution_ready":True,
        "execution_plan":{"entry_zone":zone,"invalidation":17.9},
        "market_row":{"liquidity_score":8},
        "components":{"fundamental_quality":8.5,"valuation":8.2},
        "research":{"sharia_pass":sharia,"sharia_verified":sharia,
                    "sharia_source_conflict":False,"fundamentals_verified":complete,
                    "valuation_verified":complete},
        "corporate_action":{"technical_history_gate":True},
    }


def alert(symbol, state="WATCH_REVERSAL", fall=False, cycle=6, entry=7, rr=7):
    return {"symbol":symbol,"state":state,"quality_score_10":8.1,
            "cycle_strength":cycle,"entry_quality":entry,
            "risk_reward":rr,"falling_knife_risk":fall}


class MarketScoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.now=dt.datetime.now(dt.timezone.utc).isoformat()
        self.rows=[stock("N%03d"%i,i+1,score=32,complete=False) for i in range(255)]
        self.rows[239]=stock("NEWCO",240,score=78)
        self.rows[1]=stock("EGAL",2,score=76)
        self.rows[2]=stock("ORWE",3,score=75,quote=21.3,zone=[19.2,20.0])
        self.alerts=[alert(z["symbol"]) for z in self.rows]
        self.docs={
            "contract.json":{"retrieved_at":self.now,"expected_reference_session_date":SESSION,
                             "bridge_gate":"pass","execution_usable":True},
            "decision-intelligence-v6.json":{"reference_session":SESSION,"generated_at":self.now,
                "data_gates":{"pass":True},"all_ranked":self.rows},
            "capital-recovery-alerts-v1.json":{"reference_session":SESSION,"generated_at":self.now,
                "all_alerts":self.alerts,"buy_triggers":[],
                "market_gate":{"new_buy_orders_allowed":False}},
            "independent-quote-audit.json":{"session":SESSION,"checked_at_utc":self.now,
                "quotes":{"NEWCO":{"verified":True,"price_egp":19.8,
                                   "observation_time_cairo":"2026-10-27T12:45:00+03:00"},
                          "EGAL":{"verified":True,"price_egp":19.8,
                                  "observation_time_cairo":"2026-10-27T12:45:00+03:00"}}},
        }

    def tearDown(self):
        self.tmp.cleanup()

    def run_scout(self):
        for name,obj in self.docs.items():
            (self.root/name).write_text(json.dumps(obj),encoding="utf-8")
        return scout.scan(self.root)

    def find(self, report, symbol):
        return next((r for r in report["shortlist"] if r["symbol"]==symbol), None)

    def test_all_255_scanned_and_new_symbol_beats_old_watchlist(self):
        r=self.run_scout()
        self.assertEqual(r["summary"]["scanned"],255)
        self.assertEqual(len(r["all_stock_states"]),255)
        self.assertTrue(r["all_295_stocks_evaluated"])
        self.assertEqual(r["shortlist"][0]["symbol"],"NEWCO")
        self.assertEqual(r["shortlist"][0]["state"],"WATCH_PRICE_CONFIRMED")
        self.assertFalse(r["new_events"]) # bootstrap does not spam

    def test_newly_emerging_stock_yields_once_only_alert(self):
        r=self.run_scout()
        r["state_by_symbol"]["NEWCO"]="WAIT_PRICE"
        self.docs["previous-market-opportunity-scout.json"]=r
        nxt=self.run_scout()
        self.assertEqual(nxt["new_events"][0]["symbol"],"NEWCO")
        self.assertTrue(nxt["new_events"][0]["not_an_order"])
        self.assertEqual(nxt["orders_placed"],0)
        self.docs["previous-market-opportunity-scout.json"]=nxt
        repeated=self.run_scout()
        self.assertEqual(repeated["new_events"],[])
        self.assertEqual(repeated["recent_events"][0]["event_id"],
                         nxt["new_events"][0]["event_id"])

    def test_unverified_independent_quote_is_watch_only(self):
        self.docs["independent-quote-audit.json"]["quotes"]["NEWCO"]["verified"]=False
        r=self.run_scout()
        x=self.find(r,"NEWCO")
        self.assertEqual(x["state"],"WATCH_QUOTE_PENDING")
        self.assertFalse(x["auto_execute"])

    def test_buy_needs_all_recovery_and_independent_gates(self):
        a=self.docs["capital-recovery-alerts-v1.json"]
        a["market_gate"]["new_buy_orders_allowed"]=True
        a["buy_triggers"]=[{"symbol":"NEWCO"}]
        for item in a["all_alerts"]:
            if item["symbol"]=="NEWCO":
                item["state"]="BUY_TRIGGER"
        self.rows[239]["action"]="ACCUMULATE"
        r=self.run_scout()
        x=self.find(r,"NEWCO")
        self.assertEqual(x["state"],"BUY_CANDIDATE_FINAL_CHECK")
        self.assertFalse(x["auto_execute"])
        self.docs["independent-quote-audit.json"]["quotes"]["NEWCO"]["verified"]=False
        r2=self.run_scout()
        self.assertEqual(self.find(r2,"NEWCO")["state"],"WATCH_QUOTE_PENDING")

    def test_noncompliant_or_incomplete_cannot_buy(self):
        self.rows[239]["research"]["sharia_pass"]=False
        self.rows[1]["research"]["valuation_verified"]=False
        r=self.run_scout()
        states={x["symbol"]:x["state"] for x in r["all_stock_states"]}
        self.assertEqual(states["NEWCO"],"EXCLUDED")
        self.assertEqual(states["EGAL"],"RESEARCH_REQUIRED")
        self.assertFalse(any(x["symbol"] in ("NEWCO","EGAL")
                             for x in r["new_events"]))

    def test_stale_session_fails_closed(self):
        self.docs["contract.json"]["expected_reference_session_date"]="2026-10-26"
        r=self.run_scout()
        self.assertEqual(r["health"],"BLOCKED")
        self.assertEqual(r["new_events"],[])
        self.assertEqual(r["orders_placed"],0)

    def test_extra_equity_research_is_not_discovery_boundary(self):
        self.rows[239]["research"]["fundamentals_verified"]=False
        r=self.run_scout()
        self.assertEqual(r["summary"]["scanned"],255)
        self.assertTrue(any(x["symbol"]=="NEWCO" for x in r["research_queue"]))
        self.assertFalse(any(x["symbol"]=="NEWCO" and x["state"].startswith("BUY")
                             for x in r["shortlist"]))


if __name__=="__main__":
    unittest.main()
