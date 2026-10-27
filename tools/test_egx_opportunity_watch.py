#!/usr/bin/env python3
"""Safe alert-state regression tests for the EGAL/ORWE opportunity watch."""
import json
import tempfile
import unittest
from pathlib import Path

import egx_opportunity_watch as engine


class OpportunityWatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.docs = {
            "contract.json":{"expected_reference_session_date":"2026-10-27","bridge_gate":"pass","execution_usable":True},
            "decision-intelligence-v6.json":{"reference_session":"2026-10-27","all_ranked":[
                {"symbol":"EGAL","reference_close":291.0,"action":"WAIT_ENTRY","execution_ready":True,
                 "execution_plan":{"entry_zone":[285.57,297.83],"invalidation":272.72},
                 "research":{"sharia_verified":True,"sharia_pass":True,"fundamentals_verified":True,"valuation_verified":True},
                 "corporate_action":{"technical_history_gate":True}},
                {"symbol":"ORWE","reference_close":23.6,"action":"WAIT_ENTRY","execution_ready":True,
                 "execution_plan":{"entry_zone":[23.14,23.84],"invalidation":22.1},
                 "research":{"sharia_verified":True,"sharia_pass":True,"fundamentals_verified":True,"valuation_verified":True},
                 "corporate_action":{"technical_history_gate":True}},
            ]},
            "capital-recovery-alerts-v1.json":{"reference_session":"2026-10-27","buy_triggers":[],
                "market_gate":{"new_buy_orders_allowed":False},
                "all_alerts":[
                    {"symbol":"EGAL","state":"WATCH_REVERSAL","falling_knife_risk":False,"cycle_strength":5.8,"entry_quality":6.8},
                    {"symbol":"ORWE","state":"WATCH_REVERSAL","falling_knife_risk":True,"cycle_strength":2.6,"entry_quality":5.43},
                ]},
            "independent-quote-audit.json":{"session":"2026-10-27","quotes":{
                "EGAL":{"verified":True,"age_minutes":14.0,"observation_time_cairo":"2026-10-27T12:40:00+03:00"},
                "ORWE":{"verified":True,"age_minutes":15.0,"observation_time_cairo":"2026-10-27T12:40:00+03:00"},
            }},
        }

    def tearDown(self):
        self.tmp.cleanup()

    def make(self):
        for name, content in self.docs.items():
            (self.root / name).write_text(json.dumps(content), encoding="utf-8")
        return engine.build(self.root)

    def stocks(self, report):
        return {x["symbol"]:x for x in report["targets"]}

    def test_price_zone_alone_does_not_create_buy_order(self):
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"WATCH_ZONE_NO_BUY_ORDER")
        self.assertEqual(self.stocks(report)["ORWE"]["state"],"WAIT_REVERSAL")
        self.assertFalse(report["new_events"])
        self.assertEqual(self.stocks(report)["EGAL"]["suggested_quantity_after_final_checks"],0)

    def test_independent_stale_quote_allows_watch_only_not_buy(self):
        self.docs["independent-quote-audit.json"]["quotes"]["EGAL"]["verified"]=False
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"WATCH_ZONE_SOURCE_PENDING")
        self.assertFalse(self.stocks(report)["EGAL"]["can_place_order_automatically"])
        self.assertEqual(report["new_events"],[])

    def test_zone_entry_with_stale_independent_quote_notifies_once_without_order(self):
        self.docs["independent-quote-audit.json"]["quotes"]["EGAL"]["verified"]=False
        self.docs["previous-opportunity-watch.json"]={"session":"2026-10-26",
            "targets":[{"symbol":"EGAL","state":"WAIT_PRICE"}]}
        first=self.make()
        self.assertEqual(first["new_events"][0]["kind"],"WATCH_ZONE_SOURCE_PENDING")
        self.assertTrue(first["new_events"][0]["requires_broker_price_confirmation"])
        self.docs["previous-opportunity-watch.json"]=first
        second=self.make()
        self.assertEqual(second["new_events"],[])

    def test_pending_watch_does_not_repeat_alert_when_independent_recovers(self):
        self.docs["previous-opportunity-watch.json"]={"session":"2026-10-26",
            "targets":[{"symbol":"EGAL","state":"WATCH_ZONE_SOURCE_PENDING"}]}
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"WATCH_ZONE_NO_BUY_ORDER")
        self.assertEqual(report["new_events"],[])

    def test_buy_candidate_remains_non_executable_until_macro_check(self):
        a=self.docs["capital-recovery-alerts-v1.json"]
        a["buy_triggers"]=[{"symbol":"EGAL"}]
        a["market_gate"]["new_buy_orders_allowed"]=True
        a["all_alerts"][0]["state"]="BUY_TRIGGER"
        d=self.docs["decision-intelligence-v6.json"]["all_ranked"][0]
        d["action"]="ACCUMULATE"
        report=self.make()
        row=self.stocks(report)["EGAL"]
        self.assertEqual(row["state"],"BUY_CANDIDATE_MACRO_CHECK_REQUIRED")
        self.assertTrue(report["new_events"])
        self.assertFalse(row["can_place_order_automatically"])
        self.assertEqual(row["order_status"],"NOT_PLACED")
        self.assertLessEqual(row["suggested_notional_before_fees_egp"],2970)

    def test_repeat_state_has_no_duplicate_new_event(self):
        a=self.docs["capital-recovery-alerts-v1.json"]
        a["buy_triggers"]=[{"symbol":"EGAL"}]
        a["market_gate"]["new_buy_orders_allowed"]=True
        a["all_alerts"][0]["state"]="BUY_TRIGGER"
        self.docs["decision-intelligence-v6.json"]["all_ranked"][0]["action"]="BUY"
        first=self.make()
        (self.root / "previous-opportunity-watch.json").write_text(json.dumps(first))
        second=self.make()
        self.assertEqual(second["new_events"],[])

    def test_price_below_invalidation_cancels_setup(self):
        self.docs["decision-intelligence-v6.json"]["all_ranked"][0]["reference_close"]=270.0
        self.docs["previous-opportunity-watch.json"]={"session":"2026-10-26","targets":[{"symbol":"EGAL","state":"WATCH_ZONE_NO_BUY_ORDER"}]}
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"INVALIDATED")
        self.assertTrue(any(x["kind"]=="CANCEL_SETUP" for x in report["new_events"]))

    def test_noncompliant_research_never_authorizes_buy(self):
        self.docs["decision-intelligence-v6.json"]["all_ranked"][0]["research"]["sharia_pass"]=False
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"NO_ALERT_DATA_OR_RESEARCH_BLOCKED")

    def test_outside_zone_waits_and_dynamic_levels_recalculate(self):
        self.docs["decision-intelligence-v6.json"]["all_ranked"][0]["reference_close"]=310.0
        report=self.make()
        self.assertEqual(self.stocks(report)["EGAL"]["state"],"WAIT_PRICE")
        self.assertEqual(self.stocks(report)["EGAL"]["watch_zone_egp"],[289.0,292.93])


if __name__=="__main__":
    unittest.main()
