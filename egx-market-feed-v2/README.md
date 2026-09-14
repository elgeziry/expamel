# EGX Market Feed v2 — 7.2.1

Netlify-only API for Egyptian Exchange screening and portfolio monitoring. Version 7.2 adds a single-request access layer, strict execution gates, retries, and a validated same-source snapshot. It does not use a Vercel or external market-data fallback.

## Endpoints
- `/ping.txt` — static hostname/CDN probe
- `/api/diagnostics` — source, schema, session and freshness gates
- `/api/execution-bundle?symbols=MASR,EGAL` — market, screen and requested stocks in one request
- `/data/latest-execution.json` — latest validated snapshot produced by this deployment
- `/api/health`
- `/api/market`
- `/api/screen`
- `/api/stock?symbol=SWDY`

## Fetch order

1. Probe `/ping.txt` on the production and branch aliases. Both aliases point to the same Netlify project.
2. Read `/data/latest-execution.json` first. The scheduled warmer refreshes it every 15 minutes during the EGX session.
3. If the snapshot is missing or rejected, call `/api/execution-bundle` for a fresh bundle.
4. Act only when `source_id`, `version`, fingerprint and `execution_usable` all pass.

The reusable client is in `client/execution-fetch.mjs`.

## Failure controls

- Retries network, timeout, 408, 425, 429 and 5xx failures with bounded exponential backoff.
- Keeps optional technical, fundamental and update-mode layers isolated from the base price layer.
- Blocks execution during a live-session mismatch or when `update_mode` cannot be verified.
- Rejects live snapshots older than 20 minutes, wrong-session snapshots, source/version mismatches and invalid fingerprints.
- Preserves the last valid snapshot when a scheduled refresh fails.
- Reports the distinction between hostname/CDN failure, upstream failure, schema degradation and stale data.

## Added analysis
- SMA50 / EMA50 / SMA200 / EMA200 when available
- Relative volume and demand-confirmation score
- Long-term trend and distance from SMA200
- Event-risk flag for upcoming earnings/dividend dates when available
- EPS, P/E, revenue, FCF, debt/equity and analyst targets when available
- Early-movement scan for exceptional price/volume momentum

The API keeps base price data alive if optional TradingView fields fail, but the execution gate can still close when live-session integrity is insufficient. `retrieved_at` remains retrieval time because the upstream fields used here do not expose an authoritative exchange quote timestamp.

## Local verification

```bash
npm install
npm run check
npm test
npx netlify dev
```
