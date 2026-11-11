# Authorized EGX.news independent quote feed

## What this solves

The scanner continues to cover all V6 symbols through its existing full-market
source. Independent quote checks are now selected dynamically and can use
**EGX Live by EGX.news via its published RapidAPI interface**, with timestamped
Mubasher as a fallback. No HTML scraping, automatic orders, or fabricated
market timestamps. The source gate remains closed if no real trade timestamp
can be validated.

**Important distinction:** The free public EGX.news stock pages do not establish
a timestamped API right. EGX.news Terms of Use prohibit automated page
scraping without explicit permission. This integration uses the documented
subscribed API only.

## One-time account permission

1. Go to https://rapidapi.com/manwilbahaa/api/egx-live .
2. Review the BASIC plan allowance, overages and billing terms.
3. Subscribe explicitly if acceptable, then use the portal's example request
   to obtain the exact `X-RapidAPI-Host` and your own `X-RapidAPI-Key`.
4. In GitHub repository `elgeziry/expamel` set:
   - **Actions secret** `EGX_RAPIDAPI_KEY` = private key.
   - **Actions variable** `EGX_RAPIDAPI_HOST` = exact host from the portal
     (must be a `*.p.rapidapi.com` host).
   - **Actions variable** `EGX_RAPIDAPI_MAX_PER_RUN` = initially `1` only
     after you have checked the billing cap, because V5 runs repeatedly.
5. The module defaults to **0 billable requests** when the variable is not
   set or is zero; saving a secret alone never starts paid requests.
6. Validate in `EGX independent provider integration validation`, then
   inspect `egx-live/independent-quote-audit.json` for
   `authorized_api_attempted_symbols`, `provider_failures`, the provider's
   actual explicit trade timestamp and `verified` state.

Do not paste keys into public issues, README files, logs, or chat.

## Market-data safety

- Endpoint: published GET `/api/price/{symbol}` (only the API host is configured).
- Price and previous close must both be numeric and positive.
- The exchange quote must include an explicit last-*trade* timestamp with UTC
  offset/epoch. Generic `updated_at`, generated-at, and HTTP Date are not
  treated as quote time.
- Source symbol and EGP currency must be consistent.
- Quote must match the primary source and the previous close.
- Live freshness limit remains **75 minutes** from the source trade time.
- No new buys after closing or from the previous session.
- No API key, invalid response, quota exhaustion or source mismatch:
  try timestamped Mubasher; if both fail, only observation is allowed.
- This module cannot connect to a brokerage account or place orders.
- Even validated quotes remain subject to final **broker confirmation**,
  market, macro, valuation, and Sharia gates.

## Limitation

The exact EGX Live API response schema and production entitlement cannot
be verified without an authorized account. The adapter deliberately rejects
unrecognized payloads instead of guessing timestamps. A passing offline CI
test is not evidence that the external subscription is active. Inspect the
provider's first actual response and the API quota before raising the rate.
