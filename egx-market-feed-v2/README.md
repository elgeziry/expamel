# EGX Market Feed v2

Netlify API for Egyptian Exchange screening and portfolio monitoring.

## Endpoints
- `/api/health`
- `/api/market`
- `/api/screen`
- `/api/stock?symbol=SWDY`

## Added analysis
- SMA50 / EMA50 / SMA200 / EMA200 when available
- Relative volume and demand-confirmation score
- Long-term trend and distance from SMA200
- Event-risk flag for upcoming earnings/dividend dates when available
- EPS, P/E, revenue, FCF, debt/equity and analyst targets when available
- Early-movement scan for exceptional price/volume momentum

The API keeps base price data alive even if optional TradingView fields fail.
