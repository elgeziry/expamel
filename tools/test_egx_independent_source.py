#!/usr/bin/env python3
"""Regression tests for fail-closed independent EGX quote gate."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import egx_independent_source as gate

SESSION = "2026-10-27"


class IndependentSourceGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        docs = {
            "contract.json": {"expected_reference_session_date": SESSION},
            "universe.json": {"stocks": [{"symbol": "MFPC", "close": 45.2}]},
            "history.json": {"sessions": [
                {"date": "2026-10-26", "stocks": [{"symbol": "MFPC", "close": 44.6}]},
                {"date": SESSION, "stocks": [{"symbol": "MFPC", "close": 45.2}]},
            ]},
            "capital-recovery-alerts-v1.json": {
                "buy_triggers": [{"symbol": "MFPC", "state": "BUY_TRIGGER", "reason": "test"}],
                "summary": {"buy_triggers": 1, "total_scanned": 295},
                "market_gate": {"new_buy_orders_allowed": True},
                "verified_recovery_ranking": [{"symbol": "MFPC", "state": "BUY_TRIGGER", "reason": "test"}],
                "all_alerts": [{"symbol": "MFPC", "state": "BUY_TRIGGER", "reason": "test"}],
            },
        }
        for name, doc in docs.items():
            (self.root / name).write_text(json.dumps(doc))

    def tearDown(self):
        self.temp.cleanup()

    def sample_quote(self, **updates):
        doc = {
            "symbol": "MFPC", "source": gate.PROVIDER,
            "source_url": "https://www.mubasher.info/markets/EGX/stocks/MFPC",
            "price_egp": 45.19, "previous_close_egp": 44.6,
            "observation_time_cairo": "2026-10-27T12:35:00+03:00",
            "retrieved_at_utc": "2026-10-27T09:45:00+00:00",
            "source_market_time": "12:35 م", "age_minutes": 10.0,
        }
        doc.update(updates)
        return doc

    def run_case(self, quote):
        def mock_quote(symbol):
            if symbol != "MFPC":
                raise ValueError("no feed for this symbol")
            return quote
        with patch.object(gate, "quote", side_effect=mock_quote):
            report = gate.scan(self.root)
        alerts = json.loads((self.root / "capital-recovery-alerts-v1.json").read_text())
        return report, alerts

    def test_fresh_correlated_price_keeps_buy_trigger(self):
        report, alerts = self.run_case(self.sample_quote())
        self.assertEqual(report["buy_triggers_after"], 1)
        self.assertEqual(alerts["buy_triggers"][0]["symbol"], "MFPC")
        self.assertTrue(report["quotes"]["MFPC"]["verified"])
        self.assertTrue(alerts["market_gate"]["new_buy_orders_allowed"])
        self.assertEqual(alerts["verified_recovery_ranking"][0]["state"], "BUY_TRIGGER")

    def test_two_hour_old_quote_blocks_buy_trigger(self):
        report, alerts = self.run_case(self.sample_quote(age_minutes=110))
        self.assertEqual(report["buy_triggers_after"], 0)
        self.assertEqual(report["buy_triggers_blocked"], 1)
        self.assertEqual(alerts["all_alerts"][0]["state"], "BLOCKED_UNVERIFIED_EVIDENCE")
        self.assertEqual(alerts["verified_recovery_ranking"][0]["state"], "BLOCKED_UNVERIFIED_EVIDENCE")
        self.assertFalse(alerts["market_gate"]["new_buy_orders_allowed"])

    def test_postclose_same_session_reference_is_analysis_only(self):
        report, alerts = self.run_case(self.sample_quote(
            retrieved_at_utc="2026-10-27T12:15:00+00:00",
            observation_time_cairo="2026-10-27T13:29:00+03:00",
            age_minutes=106))
        q = report["quotes"]["MFPC"]
        self.assertEqual(q["status"], "CLOSING_REFERENCE_ONLY")
        self.assertTrue(q["reference_verified"])
        self.assertFalse(q["verified"])
        self.assertFalse(q["execution_quote_valid"])
        self.assertEqual(report["buy_triggers_after"], 0)
        self.assertFalse(alerts["market_gate"]["new_buy_orders_allowed"])

    def test_postclose_early_source_timestamp_remains_rejected(self):
        report, _ = self.run_case(self.sample_quote(
            retrieved_at_utc="2026-10-27T12:15:00+00:00",
            observation_time_cairo="2026-10-27T11:08:00+03:00",
            age_minutes=247))
        q = report["quotes"]["MFPC"]
        self.assertFalse(q["reference_verified"])
        self.assertEqual(report["buy_triggers_after"], 0)

    def test_price_mismatch_blocks_buy_trigger(self):
        report, _ = self.run_case(self.sample_quote(price_egp=38.0))
        self.assertEqual(report["buy_triggers_after"], 0)
        self.assertEqual(report["quotes"]["MFPC"]["reason"], "independent_source_price_mismatch")

    def test_unverified_session_blocks_buy_trigger(self):
        report, _ = self.run_case(self.sample_quote(observation_time_cairo="2026-10-26T12:35:00+03:00"))
        self.assertEqual(report["buy_triggers_after"], 0)

    def test_corporate_action_or_prior_close_mismatch_blocks_buy_trigger(self):
        report, _ = self.run_case(self.sample_quote(previous_close_egp=34.0))
        self.assertEqual(report["buy_triggers_after"], 0)

    def test_network_failure_blocks_buy_trigger(self):
        with patch.object(gate, "quote", side_effect=ConnectionError("provider offline")):
            report = gate.scan(self.root)
        self.assertEqual(report["buy_triggers_after"], 0)
        self.assertEqual(report["quotes"]["MFPC"]["status"], "UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
