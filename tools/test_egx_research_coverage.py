#!/usr/bin/env python3
"""Regression tests for full market research evidence and fail-closed trade rules."""
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
import egx_research_coverage as cov

SESSION="2026-10-27"
NOW=dt.datetime.now(dt.timezone.utc).isoformat()
class ResearchCoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.index=Path(self.tmp.name)/"index.json"
        self.index.write_text(json.dumps({"symbols_reported":["INDEX","KNOWNBAD"],
            "published_on":"2026-10-05","source_url":"https://example.org/published-index-list",
            "count_discrepancy_note":"Test-only mock data"}))
        self.stocks=[{"symbol":f"STK{i:03}","name":f"Stock {i}","rank":i+1,"score":50+i%12,
                "reference_close":10+i/100,"action":"RESEARCH_SHARIA","execution_ready":False,
                "components":{"liquidity":7,"fundamental_quality":7,"valuation":7,
                              "cycle_relative_strength":4,"entry_quality":6,"risk_reward_proxy":5},
                "research":{"sharia_verified":False,"sharia_pass":False,"fundamentals_verified":False,
                            "valuation_verified":False},
                "corporate_action":{"technical_history_gate":True}} for i in range(255)]
        self.stocks[254].update({"symbol":"INDEX","score":84})
        self.stocks[253].update({"symbol":"KNOWNBAD","score":82,"research":{
            "sharia_verified":True,"sharia_pass":False,"fundamentals_verified":True,"valuation_verified":True}})
        self.stocks[252].update({"symbol":"VALID","score":80,"execution_ready":True,"research":{
            "sharia_verified":True,"sharia_pass":True,"fundamentals_verified":True,"valuation_verified":True}})
        self.docs={
            "contract.json":{"expected_reference_session_date":SESSION},
            "universe.json":{"stocks":[{"symbol":x["symbol"],"close":x["reference_close"],
                      "price_earnings_current":12.5,"debt_to_equity_fq":0.2} for x in self.stocks]},
            "decision-intelligence-v6.json":{"reference_session":SESSION,"all_ranked":self.stocks},
            "capital-recovery-alerts-v1.json":{"reference_session":SESSION,"all_alerts":[]}
        }
    def tearDown(self):self.tmp.cleanup()
    def run_coverage(self):
        for file,obj in self.docs.items(): (self.root/file).write_text(json.dumps(obj))
        return cov.make(self.root,self.index)
    def test_covers_unverified_stocks_without_claiming_execution(self):
        r=self.run_coverage()
        self.assertEqual(r["scanned"],255)
        self.assertEqual(len(r["all_coverage"]),255)
        self.assertTrue(all(not x["purchase_authorized"] for x in r["all_coverage"]))
        self.assertEqual(len(r["full_research_queue"]),253)
    def test_index_presence_not_sharia_execution_approval(self):
        r=self.run_coverage()
        s=next(x for x in r["all_coverage"] if x["symbol"]=="INDEX")
        self.assertEqual(s["analysis_stage"],"INDEX_MEMBERSHIP_RESEARCH_PRIORITY")
        self.assertFalse(s["sharia_verified"])
        self.assertFalse(s["purchase_authorized"])
    def test_non_member_is_unknown_not_automatically_noncompliant(self):
        r=self.run_coverage()
        s=next(x for x in r["all_coverage"] if x["symbol"]=="STK120")
        self.assertEqual(s["analysis_stage"],"OPEN_RESEARCH_NOT_EXECUTABLE")
        self.assertFalse(s["sharia_index_membership_reported"])
    def test_known_sharia_fail_is_not_overridden_by_index(self):
        r=self.run_coverage()
        s=next(x for x in r["all_coverage"] if x["symbol"]=="KNOWNBAD")
        self.assertEqual(s["analysis_stage"],"SHARIA_NOT_ELIGIBLE")
        self.assertFalse(s["purchase_authorized"])
    def test_market_ratios_not_mislabeled_audited(self):
        r=self.run_coverage()
        s=next(x for x in r["all_coverage"] if x["symbol"]=="INDEX")
        self.assertEqual(s["market_data_ratios_unverified"]["price_earnings_current"],12.5)
        self.assertTrue(s["market_data_is_not_audited_company_financials"])
        self.assertFalse(s["company_financials_independently_verified"])
    def test_prioritization_is_not_fixed_symbol_limit(self):
        r=self.run_coverage()
        self.assertEqual(r["summary"]["market_scanned"],255)
        self.assertIn("INDEX",[x["symbol"] for x in r["priority_research_queue"][:20]])
        self.assertEqual(r["summary"]["research_backlog"],253)
    def test_session_mismatch_blocks_publication(self):
        self.docs["contract.json"]["expected_reference_session_date"]="2026-10-26"
        with self.assertRaisesRegex(ValueError,"sessions disagree"):
            self.run_coverage()

if __name__=="__main__":
    unittest.main()
