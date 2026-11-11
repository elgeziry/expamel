#!/usr/bin/env python3
"""No network necessary: tests of dates, prices, symbols and safety properties."""
import datetime as dt
import unittest
import egx_reference_fallback as fallback

UTC = dt.timezone.utc
HTML = """<html><head><script>var x = 'untrusted 999 جنيه';</script></head><body>
<h1>مصر للألومنيوم</h1><strong>EGAL</strong><div>آخر قوائم: 2026</div>
<div class='price'>321.01 جنيه</div><small>مؤجل · 10 نوفمبر</small>
<h2>صافي الربح 10.19 مليار</h2></body></html>"""


class DatedSecondaryReferenceTests(unittest.TestCase):
    def test_explicit_session_date_and_price(self):
        q = fallback.parse(HTML, "EGAL", dt.datetime(2026, 11, 11, 7, 0, tzinfo=UTC))
        self.assertEqual(q["source_session_date"], "2026-11-10")
        self.assertEqual(q["price_egp"], 321.01)
        self.assertEqual(q["source_time_type"], "dated_delayed_publication_only")

    def test_reject_unstamped_or_other_symbol(self):
        with self.assertRaises(ValueError):
            fallback.parse(HTML.replace("مؤجل · 10 نوفمبر", "مؤجل"), "EGAL",
                           dt.datetime(2026, 11, 11, tzinfo=UTC))
        with self.assertRaises(ValueError):
            fallback.parse(HTML, "ORWE", dt.datetime(2026, 11, 11, tzinfo=UTC))

    def test_reject_future_year_roll_forward(self):
        q = fallback.parse(HTML, "EGAL", dt.datetime(2026, 2, 2, tzinfo=UTC))
        self.assertEqual(q["source_session_date"], "2025-11-10")

    def test_never_confuse_http_date_with_trade_time(self):
        q = fallback.parse(HTML, "EGAL", dt.datetime(2026, 11, 11, tzinfo=UTC))
        self.assertNotIn("observation_time_cairo", q)
        self.assertNotIn("verified", q)


if __name__ == "__main__":
    unittest.main()
