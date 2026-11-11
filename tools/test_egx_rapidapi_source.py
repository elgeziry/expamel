#!/usr/bin/env python3
"""Offline evidence tests for the authorized EGX.news RapidAPI source."""
import datetime as dt
import unittest
from unittest.mock import patch
import egx_rapidapi_source as feed

UTC = dt.timezone.utc
DATE = dt.datetime(2026, 11, 11, 8, 25, tzinfo=UTC)
GOOD = {
    "symbol":"EGAL",
    "lastPrice":321.01,
    "previousClose":314.5,
    "currency":"EGP",
    "lastTradeTime":"2026-11-11T08:15:00Z",
}


class AuthorizedFeedTests(unittest.TestCase):
    def test_exact_exchange_timestamp_and_delayed_age(self):
        q=feed.parse_api_quote(GOOD,"EGAL",DATE)
        self.assertEqual(q["price_egp"],321.01)
        self.assertEqual(q["previous_close_egp"],314.5)
        self.assertEqual(q["observation_time_cairo"],"2026-11-11T10:15:00+02:00")
        self.assertEqual(q["age_minutes"],10)
        self.assertTrue(q["source_timestamp_verified"])

    def test_generic_response_timestamp_never_authorizes_price(self):
        d={k:v for k,v in GOOD.items() if k!="lastTradeTime"}
        d["updated_at"]="2026-11-11T08:24:59Z"
        d["timestamp"]="2026-11-11T08:24:59Z"
        with self.assertRaises(ValueError):
            feed.parse_api_quote(d,"EGAL",DATE)

    def test_other_symbol_must_not_be_falsely_accepted(self):
        with self.assertRaises(ValueError):
            feed.parse_api_quote(GOOD,"ORWE",DATE)

    def test_future_and_naive_timestamps_rejected(self):
        with self.assertRaises(ValueError):
            feed.parse_api_quote({**GOOD,"lastTradeTime":"2026-11-11T09:00:00Z"},"EGAL",DATE)
        with self.assertRaises(ValueError):
            feed.parse_api_quote({**GOOD,"lastTradeTime":"2026-11-11T08:15:00"},"EGAL",DATE)

    def test_wrong_currency_rejected(self):
        with self.assertRaises(ValueError):
            feed.parse_api_quote({**GOOD,"currency":"USD"},"EGAL",DATE)

    def test_nested_quote_and_epoch_seconds(self):
        nested={"data":{"quote":{**GOOD, "lastTradeTime":1794384900}}}
        q=feed.parse_api_quote(nested,"EGAL",DATE)
        self.assertEqual(q["source_delay_class"],"API_EXPLICIT_EXCHANGE_TRADE_TIMESTAMP")
        self.assertEqual(q["price_egp"],321.01)

    def test_no_key_no_request(self):
        with patch.dict("os.environ",{},clear=True):
            self.assertFalse(feed.enabled())
            with self.assertRaises(RuntimeError):
                feed.quote("EGAL")

    def test_reject_non_rapidapi_host(self):
        with patch.dict("os.environ",{"EGX_RAPIDAPI_KEY":"test","EGX_RAPIDAPI_HOST":"localhost"},clear=True):
            with self.assertRaises(ValueError):
                feed.quote("EGAL")


if __name__=="__main__":
    unittest.main()
