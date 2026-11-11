#!/usr/bin/env python3
"""Read-only, dated secondary EGX closing references.

This deliberately cannot authorize a trade: AskBorsa's public page publishes
a delayed *session date* without a verifiable intraday trade timestamp.
The parser never infers a price timestamp from HTTP retrieval time and never
turns these observations into an executable quote.
"""
import datetime as dt
import email.utils
import html
import math
import re
import urllib.request
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
SOURCE = "AskBorsa (dated delayed reference)"
MONTHS = {
    "يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "ابريل": 4,
    "مايو": 5, "يونيو": 6, "يوليو": 7, "أغسطس": 8, "اغسطس": 8,
    "سبتمبر": 9, "أكتوبر": 10, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12,
}


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "svg"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "svg") and self.skip:
            self.skip -= 1

    def handle_data(self, value):
        if not self.skip:
            self.parts.append(value)


def parse(html_body, symbol, server_utc):
    if server_utc.tzinfo is None:
        raise ValueError("Missing timezone-aware HTTP server timestamp")
    symbol = symbol.upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{2,8}", symbol):
        raise ValueError("Invalid EGX symbol")
    parser = VisibleText()
    parser.feed(html_body)
    plain = " ".join(html.unescape(" ".join(parser.parts)).split())
    marker = re.search(r"\b" + re.escape(symbol) + r"\b", plain)
    if not marker:
        raise ValueError("Symbol absent from independent publication")
    nearby = plain[marker.end():marker.end()+1200]
    price_match = re.search(r"(?<!\d)(\d{1,6}(?:,\d{3})*(?:\.\d{1,4})?)\s*جنيه", nearby)
    date_match = re.search(r"مؤجل\s*[·•\-]\s*(\d{1,2})\s+([اأإآء-ي]+)", nearby)
    if not price_match or not date_match:
        raise ValueError("Dated delayed price is not visible")
    month = MONTHS.get(date_match.group(2))
    if not month:
        raise ValueError("Unknown Arabic delayed publication month")
    day = int(date_match.group(1))
    cairo_today = server_utc.astimezone(CAIRO).date()
    publication = dt.date(cairo_today.year, month, day)
    if publication > cairo_today:
        publication = dt.date(cairo_today.year-1, month, day)
    # Only explicit dated publications can be correlated with the target
    # session. No year is assumed forward and no trade time is invented.
    price = float(price_match.group(1).replace(",", ""))
    if not math.isfinite(price) or price <= 0:
        raise ValueError("Invalid delayed price")
    return {
        "symbol": symbol,
        "price_egp": price,
        "source_session_date": publication.isoformat(),
        "source_time_type": "dated_delayed_publication_only",
        "source_market_time": date_match.group(0),
    }


def fetch(symbol):
    url = "https://www.askborsa.com/company/" + symbol.upper()
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; EGXReferenceAudit/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
    })
    with urllib.request.urlopen(request, timeout=9) as response:
        raw = response.read(650000).decode("utf-8", "replace")
        server_header = response.headers.get("Date")
    if not server_header:
        raise ValueError("Missing source HTTP Date")
    server_utc = email.utils.parsedate_to_datetime(server_header).astimezone(dt.timezone.utc)
    parsed = parse(raw, symbol, server_utc)
    return {
        **parsed,
        "source": SOURCE,
        "source_url": url,
        "retrieved_at_utc": server_utc.isoformat(),
        "age_minutes": None,
        "observation_time_cairo": None,
        "previous_close_egp": None,
        "quote_valid_until_utc": None,
        "market_session_open_at_check": False,
        "verified": False,
        "execution_quote_valid": False,
        "source_delay_class": "DATED_EOD_NO_TRADE_TIME",
        "date_inference": "publisher_day_month_plus_http_server_year",
    }
