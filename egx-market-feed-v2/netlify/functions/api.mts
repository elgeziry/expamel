const TV_URL = 'https://scanner.tradingview.com/egypt/scan';

const BASE_COLUMNS = [
  'name','description','close','open','high','low','volume','change','market_cap_basic',
  'RSI','EMA20','SMA20','Perf.W','Perf.1M','average_volume_10d_calc','current_session'
];
const TECH_COLUMNS = ['SMA50','EMA50','SMA200','EMA200','relative_volume_10d_calc'];
const FUND_COLUMNS = [
  'earnings_per_share_diluted_ttm','price_earnings_current','eps_diluted_growth_percent_fq',
  'eps_diluted_growth_percent_fy','total_revenue_ttm','free_cash_flow_ttm','debt_to_equity_fq',
  'earnings_release_next_date','dividend_ex_date_upcoming','price_target_average','price_target_high','price_target_low'
];

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const round = (v, d = 4) => v != null && Number.isFinite(v) ? Number(v.toFixed(d)) : null;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function error(message, detail, status = 502) {
  return json({ status: 'error', message, ...(detail ? { detail: String(detail) } : {}), retrieved_at: new Date().toISOString() }, status);
}

function relativeVolume(row) {
  const direct = num(row.relative_volume_10d_calc);
  if (direct != null && direct >= 0) return direct;
  const volume = num(row.volume);
  const avg = num(row.average_volume_10d_calc);
  return volume != null && avg != null && avg > 0 ? volume / avg : null;
}

function relativeVolumeLabel(rv) {
  if (rv == null) return 'unavailable';
  if (rv < 1) return 'weak_or_normal';
  if (rv < 1.5) return 'moderate_interest';
  if (rv < 2) return 'strong_demand_candidate';
  return 'exceptional_activity';
}

function closeLocation(row) {
  const c = num(row.close), h = num(row.high), l = num(row.low);
  if (c == null || h == null || l == null || h <= l) return null;
  return clamp((c - l) / (h - l), 0, 1);
}

function longTermTrend(row) {
  const c = num(row.close), s200 = num(row.SMA200);
  if (c == null || s200 == null || s200 === 0) {
    const e20 = num(row.EMA20), s20 = num(row.SMA20);
    if (c != null && e20 != null && s20 != null) {
      if (c > e20 && c > s20) return { state: 'short_term_positive_sma200_unavailable', distance_from_sma200_pct: null };
      if (c < e20 && c < s20) return { state: 'short_term_weak_sma200_unavailable', distance_from_sma200_pct: null };
    }
    return { state: 'sma200_unavailable', distance_from_sma200_pct: null };
  }
  const distance = (c / s200 - 1) * 100;
  const state = Math.abs(distance) <= 3 ? 'decision_zone_near_sma200' : distance > 3 ? 'long_term_uptrend' : 'below_sma200';
  return { state, distance_from_sma200_pct: round(distance, 2) };
}

function liquidityPoints(value) {
  if (value == null || value <= 0) return 0;
  if (value >= 100_000_000) return 2;
  if (value >= 50_000_000) return 1.7;
  if (value >= 20_000_000) return 1.3;
  if (value >= 5_000_000) return 0.8;
  return 0.3;
}

function demandConfirmationScore(row) {
  const rv = relativeVolume(row);
  const loc = closeLocation(row);
  const change = num(row.change);
  const close = num(row.close);
  const volume = num(row.volume);
  const value = num(row.value) ?? (close != null && volume != null ? close * volume : null);
  const e20 = num(row.EMA20), s20 = num(row.SMA20), s200 = num(row.SMA200);
  const w = num(row['Perf.W']), m = num(row['Perf.1M']);
  let score = 0;
  if (rv != null) score += rv >= 2 ? 3 : rv >= 1.5 ? 2.4 : rv >= 1 ? 1.5 : 0.7;
  if (loc != null) {
    if ((change ?? 0) > 0 && loc >= 0.7) score += 2.5;
    else if ((change ?? 0) >= 0 && loc >= 0.5) score += 1.8;
    else if ((change ?? 0) < 0 && loc <= 0.3) score += 0.2;
    else score += 1.0;
  }
  score += liquidityPoints(value);
  if (close != null) {
    if (s200 != null && close > s200) score += 0.8;
    if (e20 != null && s20 != null && close > e20 && close > s20) score += 0.7;
    else if (e20 != null && close > e20) score += 0.35;
  }
  if ((w ?? 0) > 0 && (m ?? 0) > 0) score += 1;
  else if ((w ?? 0) > 0 || (m ?? 0) > 0) score += 0.5;
  return round(clamp(score, 0, 10), 1);
}

function tradingDaysUntil(unixSeconds, from = new Date()) {
  if (!unixSeconds) return null;
  const target = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(target.getTime())) return null;
  const a = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const b = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  if (b < a) return 0;
  let days = 0;
  for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 5 && dow !== 6) days++;
  }
  return days;
}

function eventRisk(row, now = new Date()) {
  const events = [];
  const earnings = num(row.earnings_release_next_date);
  const dividend = num(row.dividend_ex_date_upcoming);
  if (earnings) events.push({ type: 'earnings', at: earnings, trading_days: tradingDaysUntil(earnings, now) });
  if (dividend) events.push({ type: 'dividend_ex_date', at: dividend, trading_days: tradingDaysUntil(dividend, now) });
  const future = events.filter(e => e.trading_days != null && e.trading_days >= 0).sort((a,b) => a.trading_days-b.trading_days);
  if (!future.length) return { level: 'unknown_or_low', next_event: null };
  const e = future[0];
  return { level: e.trading_days <= 3 ? 'high' : e.trading_days <= 7 ? 'medium' : 'low', next_event: e };
}

function technicalScore(row) {
  const close = num(row.close), rsi = num(row.RSI), e20 = num(row.EMA20), s20 = num(row.SMA20), s200 = num(row.SMA200);
  let s = 5;
  if (close != null && e20 != null) s += close >= e20 ? 1 : -0.7;
  if (close != null && s20 != null) s += close >= s20 ? 1 : -0.7;
  if (close != null && s200 != null) s += close >= s200 ? 0.8 : -0.5;
  if (rsi != null) {
    if (rsi >= 45 && rsi <= 70) s += 1.2;
    else if (rsi > 80) s -= 0.8;
    else if (rsi < 30) s -= 0.4;
  }
  return round(clamp(s, 0, 10), 1);
}

function liquidityScore(row) {
  const close = num(row.close), volume = num(row.volume);
  const value = num(row.value) ?? (close != null && volume != null ? close * volume : null);
  if (value == null) return 0;
  if (value >= 100_000_000) return 10;
  if (value >= 50_000_000) return 9;
  if (value >= 20_000_000) return 8;
  if (value >= 10_000_000) return 7;
  if (value >= 5_000_000) return 6;
  if (value >= 1_000_000) return 4.5;
  return 2.5;
}

function chaseRisk(row) {
  const rsi = num(row.RSI), m = num(row['Perf.1M']), w = num(row['Perf.W']);
  if ((rsi ?? 0) >= 80 || (m ?? 0) >= 35 || (w ?? 0) >= 25) return 'high';
  if ((rsi ?? 0) >= 72 || (m ?? 0) >= 20 || (w ?? 0) >= 15) return 'medium';
  return 'low';
}

function enrichRow(row) {
  const close = num(row.close), volume = num(row.volume);
  const value = num(row.value) ?? (close != null && volume != null ? close * volume : null);
  const rv = relativeVolume(row);
  const trend = longTermTrend(row);
  const target = num(row.price_target_average);
  const upside = close != null && target != null && close !== 0 ? (target / close - 1) * 100 : null;
  const technical = technicalScore(row);
  const liquidity = liquidityScore(row);
  const demand = demandConfirmationScore(row);
  return {
    ...row,
    value: value == null ? null : round(value, 2),
    relative_volume_10d: rv == null ? null : round(rv, 2),
    relative_volume_label: relativeVolumeLabel(rv),
    close_location_in_day: closeLocation(row) == null ? null : round(closeLocation(row), 3),
    long_term_trend: trend.state,
    distance_from_sma200_pct: trend.distance_from_sma200_pct,
    demand_confirmation_score: demand,
    event_risk: eventRisk(row),
    upside_to_analyst_target_pct: upside == null ? null : round(upside, 2),
    decision_support: {
      technical_score: technical,
      liquidity_score: liquidity,
      setup_score: round(0.55 * (technical ?? 0) + 0.25 * liquidity + 0.20 * (demand ?? 0), 1),
      chase_risk: chaseRisk(row)
    }
  };
}

function headers() {
  return {
    accept: 'application/json,text/plain,*/*',
    'content-type': 'text/plain;charset=UTF-8',
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/',
    'user-agent': 'Mozilla/5.0 (compatible; EGXMarketFeed/7.1)'
  };
}

function payload(columns, symbols = null, range = [0, 500]) {
  return {
    filter: [{ left: 'exchange', operation: 'equal', right: 'EGX' }],
    options: { lang: 'en' }, markets: ['egypt'],
    symbols: symbols?.length ? { tickers: symbols.map(s => s.includes(':') ? s : `EGX:${s}`), query: { types: [] } } : { query: { types: ['stock'] }, tickers: [] },
    columns, range
  };
}

async function scan(columns, symbols = null, range = [0,500]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(TV_URL, { method: 'POST', headers: headers(), body: JSON.stringify(payload(columns, symbols, range)), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`TradingView ${res.status}: ${text.slice(0,300)}`);
    const raw = JSON.parse(text);
    const rows = (raw.data || []).map((item) => {
      const row = { symbol_full: item.s };
      columns.forEach((c, i) => row[c] = item.d?.[i] ?? null);
      row.symbol = String(item.s || '').split(':').pop();
      return row;
    });
    return { totalCount: raw.totalCount ?? rows.length, rows };
  } finally { clearTimeout(timer); }
}

function mergeRows(base, extra) {
  const map = new Map(base.map(r => [r.symbol_full, { ...r }]));
  for (const r of extra) map.set(r.symbol_full, { ...(map.get(r.symbol_full) || {}), ...r });
  return [...map.values()];
}

async function safeLayer(columns, symbols, range) {
  try { return { ok: true, ...(await scan(columns, symbols, range)), error: null }; }
  catch (e) { return { ok: false, totalCount: 0, rows: [], error: String(e?.message || e) }; }
}

async function fetchMarket(symbols = null) {
  const range = [0,500];
  const base = await safeLayer(BASE_COLUMNS, symbols, range);
  if (!base.ok) throw new Error(base.error || 'Base TradingView layer failed');
  const [tech, fund] = await Promise.all([
    safeLayer(['name', ...TECH_COLUMNS], symbols, range),
    safeLayer(['name', ...FUND_COLUMNS], symbols, range)
  ]);
  let rows = base.rows;
  if (tech.ok) rows = mergeRows(rows, tech.rows);
  if (fund.ok) rows = mergeRows(rows, fund.rows);
  rows = rows.map(enrichRow);
  return {
    count: rows.length, total_count: base.totalCount, rows,
    capabilities: {
      base: true,
      advanced_technicals: tech.ok,
      fundamentals_events: fund.ok,
      ...(tech.ok ? {} : { advanced_technicals_error: tech.error }),
      ...(fund.ok ? {} : { fundamentals_events_error: fund.error })
    }
  };
}

function sessionStatus(rows) {
  for (const r of rows) {
    const v = String(r.current_session || '').toLowerCase();
    if (['market','regular','continuous','open'].includes(v)) return 'continuous';
    if (v.includes('pre')) return 'auction';
    if (v.includes('post') || v.includes('closed')) return 'closed';
  }
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((o,p) => (o[p.type]=p.value,o), {});
  if (['Fri','Sat'].includes(parts.weekday)) return 'closed';
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (mins >= 570 && mins < 600) return 'auction';
  if (mins >= 600 && mins < 870) return 'continuous';
  return 'closed';
}

function earlyFlags(r) {
  const out = [];
  if (Number(r.change) >= 8) out.push('daily_move_ge_8pct');
  if (Number(r['Perf.W']) >= 20) out.push('weekly_move_ge_20pct');
  if (Number(r.relative_volume_10d) >= 2) out.push('relative_volume_ge_2x');
  if (Number(r['Perf.1M']) >= 20) out.push('monthly_momentum_ge_20pct');
  return out;
}

async function handleHealth() {
  const data = await fetchMarket(['BONY','EFID','EFIH']);
  return json({ status: 'ok', version: '7.1.0', checked_at: new Date().toISOString(), session_status: sessionStatus(data.rows), source: 'TradingView public scanner', timestamp_kind: 'retrieval_time_not_exchange_tick_time', capabilities: data.capabilities,
    probes: data.rows.map((r) => ({ symbol:r.symbol,last_price:r.close,change_percent:r.change,rsi:r.RSI,sma200:r.SMA200 ?? null,relative_volume_10d:r.relative_volume_10d,demand_confirmation_score:r.demand_confirmation_score,setup_score:r.decision_support?.setup_score,chase_risk:r.decision_support?.chase_risk })) });
}

async function handleMarket() {
  const data = await fetchMarket();
  const advancers = data.rows.filter((r) => Number(r.change) > 0).length;
  const decliners = data.rows.filter((r) => Number(r.change) < 0).length;
  const unchanged = data.rows.length - advancers - decliners;
  const positivePct = data.rows.length ? advancers / data.rows.length * 100 : 0;
  return json({ status:'ok',version:'7.1.0',count:data.count,total_count:data.total_count,retrieved_at:new Date().toISOString(),session_status:sessionStatus(data.rows),market:{regime:positivePct>=55?'strong':positivePct>=45?'mixed':'weak',breadth:{advancers,decliners,unchanged,positive_pct:Number(positivePct.toFixed(1))}},capabilities:data.capabilities,source:'TradingView public scanner',timestamp_kind:'retrieval_time_not_exchange_tick_time',data:data.rows });
}

async function handleScreen() {
  const data = await fetchMarket();
  const ranked = data.rows.filter((r) => Number(r.value) >= 1_000_000 && Number(r.close) > 0).map((r) => ({ ...r, early_movement_flags: earlyFlags(r) })).sort((a,b) => (b.decision_support?.setup_score ?? 0)-(a.decision_support?.setup_score ?? 0));
  return json({ status:'ok',version:'7.1.0',retrieved_at:new Date().toISOString(),session_status:sessionStatus(data.rows),capabilities:data.capabilities,top_setup:ranked.slice(0,40),early_movement:ranked.filter((r) => r.early_movement_flags.length).sort((a,b)=>(b.demand_confirmation_score??0)-(a.demand_confirmation_score??0)).slice(0,40),methodology:{note:'Technical/demand pre-screen only. Sharia, fundamentals, valuation and catalyst checks remain required before execution.',demand_score_components:['relative_volume','price_direction_and_close_location','traded_value','moving_average_trend','relative_performance']} });
}

async function handleStock(url) {
  const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase().replace(/^EGX:/, '');
  if (!/^[A-Z0-9._-]{1,16}$/.test(symbol)) return error('Invalid or missing symbol', null, 400);
  const data = await fetchMarket([symbol]);
  const r = data.rows.find((x) => x.symbol === symbol) || data.rows[0];
  if (!r) return error(`Symbol ${symbol} not found`, null, 404);
  return json({ symbol,name:r.description||r.name||symbol,status:'ok',last_price:r.close,session_open:r.open,session_high:r.high,session_low:r.low,volume:r.volume,change_percent:r.change,value:r.value,market_cap:r.market_cap_basic,
    technical:{rsi:r.RSI,ema20:r.EMA20,sma20:r.SMA20,sma50:r.SMA50??null,ema50:r.EMA50??null,sma200:r.SMA200??null,ema200:r.EMA200??null,performance_1w_pct:r['Perf.W'],performance_1m_pct:r['Perf.1M'],avg_volume_10d:r.average_volume_10d_calc,relative_volume_10d:r.relative_volume_10d,long_term_trend:r.long_term_trend,distance_from_sma200_pct:r.distance_from_sma200_pct,close_location_in_day:r.close_location_in_day},
    fundamentals:{eps_diluted_ttm:r.earnings_per_share_diluted_ttm??null,pe_current:r.price_earnings_current??null,eps_growth_fq_pct:r.eps_diluted_growth_percent_fq??null,eps_growth_fy_pct:r.eps_diluted_growth_percent_fy??null,revenue_ttm:r.total_revenue_ttm??null,free_cash_flow_ttm:r.free_cash_flow_ttm??null,debt_to_equity_fq:r.debt_to_equity_fq??null,analyst_target_average:r.price_target_average??null,analyst_target_high:r.price_target_high??null,analyst_target_low:r.price_target_low??null,upside_to_analyst_target_pct:r.upside_to_analyst_target_pct},
    event_risk:r.event_risk,demand_confirmation_score:r.demand_confirmation_score,bid_ask_valid:false,source:'TradingView public scanner',source_timestamp:new Date().toISOString(),timestamp_kind:'retrieval_time_not_exchange_tick_time',session_status:sessionStatus(data.rows),decision_support:r.decision_support,capabilities:data.capabilities });
}

export default async (req) => {
  if (req.method !== 'GET') return error('Method not allowed', null, 405);
  const url = new URL(req.url);
  try {
    if (url.pathname === '/api/health') return await handleHealth();
    if (url.pathname === '/api/market') return await handleMarket();
    if (url.pathname === '/api/screen') return await handleScreen();
    if (url.pathname === '/api/stock') return await handleStock(url);
    return error('Not found', null, 404);
  } catch (e) {
    return error('Market source unavailable', e?.message || e, 502);
  }
};

export const config = { path: ['/api/health','/api/market','/api/screen','/api/stock'] };
