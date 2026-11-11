#!/usr/bin/env python3
"""Authorized EGX.news EGX Live quote adapter through RapidAPI.

No web-page scraping. This module only calls the published commercial API
when the owner has explicitly configured an API subscription. It NEVER sends
broker orders and NEVER treats request/HTTP time as last trade time.
"""
import datetime as dt
import email.utils
import json
import math
import os
import re
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
PROVIDER = "EGX.news / EGX Live via RapidAPI"
MAX_RESPONSE_BYTES = 200000

def enabled():
    return bool(os.environ.get("EGX_RAPIDAPI_KEY", "").strip()
                and os.environ.get("EGX_RAPIDAPI_HOST", "").strip())

def _positive(value):
    try:
        if isinstance(value, bool):
            return None
        v=float(str(value).replace(",", ""))
        return v if math.isfinite(v) and v>0 else None
    except (TypeError, ValueError):
        return None

def _parse_market_time(value):
    """Accept exchange trade timestamps only if UTC offset is explicit."""
    if isinstance(value, bool):
        raise ValueError("Invalid market timestamp")
    if isinstance(value, (int, float)):
        if value <= 0:
            raise ValueError("Invalid exchange epoch")
        # Support both seconds and milliseconds.
        seconds=value/1000 if value > 1e11 else value
        return dt.datetime.fromtimestamp(seconds, dt.timezone.utc)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Missing timestamp")
    parsed=dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Exchange quote timestamp lacks time zone")
    return parsed.astimezone(dt.timezone.utc)

def _candidate_objects(data):
    if not isinstance(data, dict):
        return []
    result=[data]
    for key in ("data", "result", "quote", "stock", "price", "payload"):
        val=data.get(key)
        if isinstance(val, dict):
            result.extend(_candidate_objects(val))
    return result

def parse_api_quote(data, symbol, retrieved_utc):
    """Fail closed when provider omits symbol, price, prior close or trade time.

    Only explicit timestamp fields with *trade* semantics are used.
    Generic HTTP Date, response generated_at and updated_at are excluded.
    """
    symbol=symbol.upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{2,8}", symbol):
        raise ValueError("Invalid symbol")
    if retrieved_utc.tzinfo is None:
        raise ValueError("Retrieval time has no time zone")
    if not isinstance(data, dict):
        raise ValueError("Unexpected API response")
    root_symbol = data.get("symbol") or data.get("ticker") or data.get("code")
    if root_symbol and str(root_symbol).strip().upper() != symbol:
        raise ValueError("API response belongs to another stock")
    price_keys=("last_price", "lastPrice", "last", "last_traded_price",
                "lastTradedPrice", "ltp", "price")
    prev_keys=("previous_close", "previousClose", "prev_close",
               "prevClose", "prior_close", "priorClose")
    time_keys=("last_trade_time", "lastTradeTime", "trade_timestamp",
               "tradeTimestamp", "last_trade_at", "lastTradeAt",
               "last_trade_timestamp", "lastTradeTimestamp",
               "exchange_trade_time", "exchangeTradeTime")
    for obj in _candidate_objects(data):
        quoted=obj.get("symbol") or obj.get("ticker") or obj.get("code")
        if quoted and str(quoted).strip().upper()!=symbol:
            continue
        price=next((_positive(obj.get(k)) for k in price_keys if _positive(obj.get(k)) is not None), None)
        prev=next((_positive(obj.get(k)) for k in prev_keys if _positive(obj.get(k)) is not None), None)
        raw_stamp=next((obj[k] for k in time_keys if obj.get(k) is not None), None)
        if price is None or prev is None or raw_stamp is None:
            continue
        quote_time=_parse_market_time(raw_stamp)
        age=(retrieved_utc.astimezone(dt.timezone.utc)-quote_time).total_seconds()/60
        if age < -5:
            raise ValueError("Exchange quote is dated in the future")
        local=quote_time.astimezone(CAIRO)
        currency=str(obj.get("currency") or data.get("currency") or "EGP").strip().upper()
        if currency!="EGP":
            raise ValueError("Quote currency is not EGP")
        return {
            "symbol":symbol, "source":PROVIDER,
            "price_egp":price, "previous_close_egp":prev,
            "observation_time_cairo":local.isoformat(),
            "source_market_time":local.isoformat(),
            "retrieved_at_utc":retrieved_utc.astimezone(dt.timezone.utc).isoformat(),
            "age_minutes":round(age,2),
            "source_delay_class":"API_EXPLICIT_EXCHANGE_TRADE_TIMESTAMP",
            "date_inference":"none; explicit exchange trade timestamp",
            "source_timestamp_verified":True,
        }
    raise ValueError("EGX Live API omitted explicit trade timestamp, price, or previous close")

def quote(symbol):
    key=os.environ.get("EGX_RAPIDAPI_KEY","").strip()
    host=os.environ.get("EGX_RAPIDAPI_HOST","").strip().lower()
    if not key or not host:
        raise RuntimeError("EGX Live RapidAPI subscription not configured")
    if not re.fullmatch(r"[a-z0-9-]+\.p\.rapidapi\.com",host):
        raise ValueError("Invalid RapidAPI host")
    if not re.fullmatch(r"[A-Z0-9]{2,8}",symbol.upper().strip()):
        raise ValueError("Invalid symbol")
    url="https://"+host+"/api/price/"+urllib.parse.quote(symbol.upper(),safe="")
    req=urllib.request.Request(url,headers={
        "x-rapidapi-key":key,
        "x-rapidapi-host":host,
        "Accept":"application/json",
        "User-Agent":"EGXPortfolioAuthorizedFeed/1.0",
    })
    with urllib.request.urlopen(req,timeout=9) as response:
        raw=response.read(MAX_RESPONSE_BYTES+1)
        server_header=response.headers.get("Date")
    if len(raw)>MAX_RESPONSE_BYTES:
        raise ValueError("Unexpectedly large quote response")
    data=json.loads(raw)
    # HTTP server time is ONLY request timing, never quote timing.
    received=dt.datetime.now(dt.timezone.utc)
    if server_header:
        server_time=email.utils.parsedate_to_datetime(server_header).astimezone(dt.timezone.utc)
        if abs((received-server_time).total_seconds())<180:
            received=server_time
    result=parse_api_quote(data,symbol,received)
    result["source_url"]=url
    return result
