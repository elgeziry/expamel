#!/usr/bin/env python3
"""Independent, timestamp-aware EGX quote corroboration via Mubasher delayed quotes.

Never claim that retrieval time is trade time. Mubasher exposes market-local
update time but (on current-session pages) not a full dated trade timestamp;
the date is inferred and corroborated against prior-session close.
Unavailable or uncorroborated quotes CANNOT authorize buy alerts.
"""
import argparse
import datetime as dt
import email.utils
import json
import math
import re
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
PROVIDER = "Mubasher Egypt (delayed)"
FOCUS = ("MFPC", "EFID", "EGAL", "JUFO", "ETEL")
MAX_QUOTE_AGE_MIN = 75
MAX_PRICE_DIFF_PCT = 2.5
MAX_PREV_CLOSE_DIFF_PCT = 1.0


def load(root, name):
    return json.loads((root / name).read_text(encoding="utf-8"))


def number(value):
    try:
        result = float(str(value).replace(",", ""))
        return result if math.isfinite(result) and result > 0 else None
    except (TypeError, ValueError):
        return None


def quote(symbol):
    url = "https://www.mubasher.info/markets/EGX/stocks/" + symbol
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; EGXPortfolioAudit/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=18) as response:
        html = response.read().decode("utf-8", "replace")
        response_utc = email.utils.parsedate_to_datetime(response.headers["Date"]).astimezone(dt.timezone.utc)
    price_match = re.search(r'class=["\']market-summary__last-price[^"\']*["\'][^>]*>\s*([0-9,.]+)', html)
    time_match = re.search(r'آخر تحديث:\s*(\d{1,2}):(\d{2})\s*([صم])\s*بتوقيت السوق', html)
    prev_match = re.search(
        r'إغلاق سابق</span>\s*<span[^>]*>\s*([0-9,.]+)', html)
    if not price_match or not time_match or not prev_match:
        raise ValueError("No source price, prior close, or market update time")
    hour, minute = int(time_match[1]), int(time_match[2])
    if not 1 <= hour <= 12 or not 0 <= minute <= 59:
        raise ValueError("Invalid market-local source time")
    hour = hour % 12 + (12 if time_match[3] == "م" else 0)
    cairo_now = response_utc.astimezone(CAIRO)
    observed = cairo_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if observed > cairo_now + dt.timedelta(minutes=5):
        observed -= dt.timedelta(days=1)
    age = (response_utc - observed.astimezone(dt.timezone.utc)).total_seconds() / 60
    return {
        "symbol": symbol, "source": PROVIDER, "source_url": url,
        "price_egp": number(price_match[1]), "previous_close_egp": number(prev_match[1]),
        "source_market_time": time_match[0], "observation_time_cairo": observed.isoformat(),
        "retrieved_at_utc": response_utc.isoformat(), "age_minutes": round(age, 1),
        "source_delay_class": "DELAYED_15_MIN_REPORTED",
        "date_inference": "server_date_plus_source_local_time; corroborate_with_prior_close",
    }


def scan(root):
    contract = load(root, "contract.json")
    universe = load(root, "universe.json")
    history = load(root, "history.json")
    alerts = load(root, "capital-recovery-alerts-v1.json")
    session = contract.get("expected_reference_session_date")
    current = {str(row.get("symbol", "")).upper(): row for row in universe.get("stocks", [])}
    prior_sessions = [s for s in history.get("sessions", []) if s.get("date", "") < str(session)]
    previous = {str(row.get("symbol", "")).upper(): row for row in prior_sessions[-1].get("stocks", [])} if prior_sessions else {}
    records = {}
    for symbol in FOCUS:
        try:
            q = quote(symbol)
            reference = number(current.get(symbol, {}).get("close"))
            past = number(previous.get(symbol, {}).get("close"))
            prev = q["previous_close_egp"]
            q["primary_price_egp"] = reference
            q["historical_previous_close_egp"] = past
            q["price_difference_pct"] = round(abs(reference - q["price_egp"]) / q["price_egp"] * 100, 3) if reference and q["price_egp"] else None
            q["previous_close_difference_pct"] = round(abs(past - prev) / past * 100, 3) if past and prev else None
            q["same_session_correlated"] = q["observation_time_cairo"][:10] == session and q["previous_close_difference_pct"] is not None and q["previous_close_difference_pct"] <= MAX_PREV_CLOSE_DIFF_PCT
            q["verified"] = (q["same_session_correlated"] and 0 <= q["age_minutes"] <= MAX_QUOTE_AGE_MIN
                             and q["price_difference_pct"] is not None and q["price_difference_pct"] <= MAX_PRICE_DIFF_PCT)
            q["status"] = "VERIFIED_DELAYED" if q["verified"] else "UNVERIFIED"
            if q["age_minutes"] > MAX_QUOTE_AGE_MIN:
                q["reason"] = "delayed_quote_beyond_freshness_window"
            elif not q["same_session_correlated"]:
                q["reason"] = "observation_date_or_previous_close_not_corroborated"
            elif q["price_difference_pct"] is None or q["price_difference_pct"] > MAX_PRICE_DIFF_PCT:
                q["reason"] = "independent_source_price_mismatch"
            records[symbol] = q
        except Exception as exc:
            records[symbol] = {"symbol": symbol, "source": PROVIDER, "verified": False,
                               "status": "UNAVAILABLE", "reason": str(exc)[:200]}
    initial = list(alerts.get("buy_triggers") or [])
    accepted, blocked = [], []
    for item in initial:
        symbol = str(item.get("symbol", "")).upper()
        evidence = records.get(symbol, {"verified": False, "reason": "symbol_not_independently_checked"})
        if evidence.get("verified") is True:
            item["independent_quote_evidence"] = {"source": PROVIDER,
                "source_market_time": evidence["observation_time_cairo"],
                "age_minutes": evidence["age_minutes"],
                "primary_independent_difference_pct": evidence["price_difference_pct"]}
            accepted.append(item)
        else:
            item["state"] = "BLOCK_EXTERNAL_QUOTE"
            item["reason"] = "independent_timestamped_quote_not_verified"
            item["independent_quote_evidence"] = {"reason": evidence.get("reason", "unverified")}
            blocked.append(item)
    blocked_symbols = {str(x.get("symbol", "")).upper() for x in blocked}
    for item in alerts.get("all_alerts", []):
        if str(item.get("symbol", "")).upper() in blocked_symbols:
            item["state"] = "BLOCK_EXTERNAL_QUOTE"
            item["reason"] = "independent_timestamped_quote_not_verified"
    alerts["buy_triggers"] = accepted
    alerts.setdefault("summary", {})["buy_triggers"] = len(accepted)
    alerts["blocked_independent_quotes"] = blocked
    alerts["independent_source_gate"] = {
        "provider": PROVIDER,
        "as_of": "market_local_update_time_date_inferred_and_correlated",
        "checked_symbols": len(records),
        "verified_symbols": sorted(k for k, v in records.items() if v.get("verified")),
        "blocked_buy_triggers": len(blocked),
        "enforces_buy_trigger_gate": True,
    }
    (root / "capital-recovery-alerts-v1.json").write_text(json.dumps(alerts, ensure_ascii=False, indent=2))
    report = {
        "schema": "egx-independent-quote-audit-v1",
        "session": session,
        "provider": PROVIDER,
        "checked_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "maximum_quote_age_minutes": MAX_QUOTE_AGE_MIN,
        "max_independent_price_difference_pct": MAX_PRICE_DIFF_PCT,
        "timestamp_limitation": "Provider displays time but not always the date; date corroborated using prior close.",
        "fully_independent_provider": True,
        "source_quotes_are_delayed": True,
        "execution_price_must_be_confirmed_at_broker": True,
        "quotes": records,
        "buy_triggers_before": len(initial),
        "buy_triggers_after": len(accepted),
        "buy_triggers_blocked": len(blocked),
    }
    (root / "independent-quote-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"session": session, "provider": PROVIDER,
        "verified": sorted(k for k, v in records.items() if v.get("verified")),
        "failures": {k: v.get("reason") for k, v in records.items() if not v.get("verified")},
        "buy_before": len(initial), "buy_after": len(accepted)}, ensure_ascii=False))
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", default=".")
    a = p.parse_args()
    scan(Path(a.root))
