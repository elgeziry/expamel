import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'out';
const MIN_VALUE = 1_000_000;
const INSTITUTIONAL_VALUE_FLOOR = 25_000_000;
const LARGE_CAP_FLOOR = 2_000_000_000;
const MAX_DYNAMIC_FOCUS = 90;
const REPO = process.env.GITHUB_REPOSITORY || 'elgeziry/expamel';

const num = (v: any) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v: number, lo = 0, hi = 10) => Math.min(hi, Math.max(lo, v));
const symbolOf = (r: any) => String(r?.symbol || r?.name || '').toUpperCase();
const valueOf = (r: any) => num(r?.value_session_adjusted ?? r?.value ?? ((num(r?.close) ?? 0) * (num(r?.volume) ?? 0))) ?? 0;
const marketCapOf = (r: any) => num(r?.market_cap_basic) ?? 0;
const relVolOf = (r: any) => num(r?.relative_volume_10d ?? r?.relative_volume_10d_calc) ?? 0;
const closeLocationOf = (r: any) => num(r?.close_location_in_day) ?? 0.5;

function rvScore(row: any) {
  const rv = num(row?.relative_volume_10d ?? row?.relative_volume_10d_calc);
  if (rv == null) return 0;
  return clamp((rv / 2.5) * 10);
}

function trendScore(row: any) {
  const trend = String(row?.long_term_trend || '');
  if (trend === 'long_term_uptrend') return 10;
  if (trend === 'decision_zone_near_sma200') return 7;
  if (trend.startsWith('short_term_positive')) return 6;
  if (trend === 'below_sma200') return 2;
  return 4;
}

function sizeLiquidityScore(row: any) {
  const value = valueOf(row);
  const cap = marketCapOf(row);
  let score = 0;
  if (value >= 250_000_000) score += 5;
  else if (value >= 100_000_000) score += 4;
  else if (value >= 40_000_000) score += 3;
  else if (value >= 10_000_000) score += 2;
  else if (value >= MIN_VALUE) score += 1;
  if (cap >= 100_000_000_000) score += 5;
  else if (cap >= 30_000_000_000) score += 4;
  else if (cap >= 10_000_000_000) score += 3;
  else if (cap >= LARGE_CAP_FLOOR) score += 2;
  else if (cap > 0) score += 1;
  return clamp(score);
}

function discoveryScore(row: any) {
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liquidity = num(row?.decision_support?.liquidity_score) ?? 0;
  const rv = rvScore(row);
  const trend = trendScore(row);
  const size = sizeLiquidityScore(row);
  const change = num(row?.change) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');

  // V2 deliberately gives size/liquidity a permanent weight so large institutional-quality
  // names cannot disappear merely because they are quiet before a move.
  let score = 0.28 * setup + 0.20 * demand + 0.14 * liquidity + 0.10 * rv + 0.10 * trend + 0.13 * size;
  if (change >= -2 && change <= 4.5) score += 0.7;
  else if (change > 4.5 && change <= 7) score += 0.35;
  if (chase === 'high') score -= 1.1;
  else if (chase === 'medium') score -= 0.4;
  if (change >= 10) score -= 0.9;
  if (change >= 15) score -= 0.5;
  return Number(clamp(score).toFixed(2));
}

function eligible(row: any) {
  const close = num(row?.close);
  return close != null && close > 0 && valueOf(row) >= MIN_VALUE;
}

function opportunityStage(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = relVolOf(row);
  const chase = String(row?.decision_support?.chase_risk || 'low');
  if (change >= 10 || chase === 'high') return 'extended_no_chase';
  if (change >= 2 || rv >= 1.35) return 'confirming';
  return 'pre_move_watch';
}

function withRadar(row: any) {
  return {
    ...row,
    discovery: {
      score: discoveryScore(row),
      stage: opportunityStage(row),
      source: 'full_market_universe_scan_v2',
      not_a_buy_signal: true,
    },
  };
}

function sortByDiscovery(rows: any[]) {
  return [...rows].sort((a, b) =>
    (b.discovery?.score ?? discoveryScore(b)) - (a.discovery?.score ?? discoveryScore(a)) ||
    valueOf(b) - valueOf(a)
  );
}

function laneEarlyBuildUp(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = relVolOf(row);
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');
  const trend = String(row?.long_term_trend || '');
  return eligible(row) && change >= -3 && change <= 7 && rv >= 0.85 && rv <= 2.8 &&
    setup >= 6.5 && demand >= 6 && liq >= 6 && chase !== 'high' && trend !== 'below_sma200';
}

function laneQuietAccumulation(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = relVolOf(row);
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const closeLoc = closeLocationOf(row);
  const chase = String(row?.decision_support?.chase_risk || 'low');
  return eligible(row) && change >= -2.5 && change <= 4.5 && rv >= 1.0 && rv <= 2.4 &&
    demand >= 6 && liq >= 6 && closeLoc >= 0.58 && chase !== 'high';
}

function laneAcceleration(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = relVolOf(row);
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');
  return eligible(row) && change >= 2 && change <= 10 && rv >= 1.3 && demand >= 6.5 && liq >= 6 && chase !== 'high';
}

function laneQualityPullback(row: any) {
  const change = num(row?.change) ?? 0;
  const rsi = num(row?.RSI);
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const trend = String(row?.long_term_trend || '');
  return eligible(row) && trend === 'long_term_uptrend' && change >= -6 && change <= 1.5 &&
    setup >= 6 && liq >= 6 && (rsi == null || (rsi >= 34 && rsi <= 70));
}

function laneUnusualActivity(row: any) {
  const change = Math.abs(num(row?.change) ?? 0);
  const rv = relVolOf(row);
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  return eligible(row) && liq >= 6 && (rv >= 2 || change >= 8);
}

function laneInstitutionalProxy(row: any) {
  const rv = relVolOf(row);
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const closeLoc = closeLocationOf(row);
  return eligible(row) && valueOf(row) >= INSTITUTIONAL_VALUE_FLOOR && marketCapOf(row) >= LARGE_CAP_FLOOR &&
    rv >= 1.0 && demand >= 5.5 && closeLoc >= 0.55;
}

function laneNearValue(row: any) {
  const close = num(row?.close) ?? 0;
  const ma20 = num(row?.SMA20 ?? row?.EMA20);
  const ma50 = num(row?.SMA50 ?? row?.EMA50);
  const trend = String(row?.long_term_trend || '');
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  if (!eligible(row) || close <= 0 || liq < 6 || trend === 'below_sma200') return false;
  const distances = [ma20, ma50].filter((x): x is number => x != null && x > 0).map(x => Math.abs(close / x - 1));
  return distances.length > 0 && Math.min(...distances) <= 0.035;
}

function uniqueRows(rows: any[]) {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const sym = symbolOf(row);
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(row);
  }
  return out;
}

async function fetchPreviousRadar() {
  try {
    const stamp = Date.now();
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/egx-live/radar.json?ts=${stamp}`, {
      headers: { 'user-agent': 'EGX-Radar-V2/1.0', 'cache-control': 'no-cache' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const [focusRaw, universeRaw, contractRaw, healthRaw, latestRaw, previousRadar] = await Promise.all([
  readFile(`${OUT}/focus.json`, 'utf8'),
  readFile(`${OUT}/universe.json`, 'utf8'),
  readFile(`${OUT}/contract.json`, 'utf8'),
  readFile(`${OUT}/health.json`, 'utf8'),
  readFile(`${OUT}/latest.json`, 'utf8'),
  fetchPreviousRadar(),
]);

const focus = JSON.parse(focusRaw);
const universe = JSON.parse(universeRaw);
const contract = JSON.parse(contractRaw);
const health = JSON.parse(healthRaw);
const latest = JSON.parse(latestRaw);

const universeRows = (universe.stocks || []).filter(eligible).map(withRadar);
const allRanked = sortByDiscovery(universeRows);
const earlyBuildUp = sortByDiscovery(universeRows.filter(laneEarlyBuildUp)).slice(0, 35);
const quietAccumulation = sortByDiscovery(universeRows.filter(laneQuietAccumulation)).slice(0, 35);
const acceleration = sortByDiscovery(universeRows.filter(laneAcceleration)).slice(0, 30);
const qualityPullback = sortByDiscovery(universeRows.filter(laneQualityPullback)).slice(0, 30);
const unusualActivity = sortByDiscovery(universeRows.filter(laneUnusualActivity)).slice(0, 30);
const institutionalProxy = sortByDiscovery(universeRows.filter(laneInstitutionalProxy)).slice(0, 35);
const nearValue = sortByDiscovery(universeRows.filter(laneNearValue)).slice(0, 30);
const largeCapWatch = [...universeRows].filter(r => marketCapOf(r) >= LARGE_CAP_FLOOR)
  .sort((a, b) => marketCapOf(b) - marketCapOf(a)).slice(0, 35);
const highLiquidityWatch = [...universeRows].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 35);
const topDiscovery = allRanked.slice(0, 50);

const baseRows = focus.stocks || [];
const baseSymbols = new Set(baseRows.map(symbolOf));
const enrichedScreenRows = uniqueRows([
  ...(focus?.screen?.top_setup || []),
  ...(focus?.screen?.early_movement || []),
]);
const enrichedBySymbol = new Map(enrichedScreenRows.map((r: any) => [symbolOf(r), r]));

const lanes: Record<string, any[]> = {
  quiet_accumulation: quietAccumulation,
  early_build_up: earlyBuildUp,
  quality_pullback: qualityPullback,
  institutional_proxy: institutionalProxy,
  near_value: nearValue,
  acceleration,
  unusual_activity: unusualActivity,
  large_cap_watch: largeCapWatch,
  high_liquidity_watch: highLiquidityWatch,
};

const reasonsBySymbol = new Map<string, string[]>();
for (const [lane, rows] of Object.entries(lanes)) {
  for (const row of rows) {
    const sym = symbolOf(row);
    const reasons = reasonsBySymbol.get(sym) || [];
    reasons.push(lane);
    reasonsBySymbol.set(sym, reasons);
  }
}

// Promotion order is deliberately pre-move first, then structural leaders, then confirmation.
// This is the key protection against missing a SWDY-like move just because it was outside the permanent list.
const promotionPool = uniqueRows([
  ...quietAccumulation.slice(0, 25),
  ...earlyBuildUp.slice(0, 25),
  ...qualityPullback.slice(0, 20),
  ...institutionalProxy.slice(0, 20),
  ...nearValue.slice(0, 20),
  ...largeCapWatch.slice(0, 25),
  ...highLiquidityWatch.slice(0, 20),
  ...acceleration.slice(0, 15),
  ...unusualActivity.slice(0, 10),
  ...topDiscovery.slice(0, 20),
]);

const promotedRows = promotionPool
  .filter(r => !baseSymbols.has(symbolOf(r)))
  .slice(0, MAX_DYNAMIC_FOCUS)
  .map(r => {
    const sym = symbolOf(r);
    const enriched = enrichedBySymbol.get(sym);
    return {
      ...(enriched || r),
      dynamic_focus: true,
      promotion_reasons: reasonsBySymbol.get(sym) || ['top_discovery'],
      discovery: r.discovery,
    };
  });

const combinedFocus = uniqueRows([
  ...baseRows.map((r: any) => ({ ...r, dynamic_focus: false, permanent_focus: true })),
  ...promotedRows,
]);

const promotedSymbols = promotedRows.map(symbolOf);
const previousPromoted = new Set<string>(previousRadar?.discovery?.dynamic_promoted_symbols || []);
const newlyPromotedSymbols = promotedSymbols.filter(s => !previousPromoted.has(s));

const previousTop = (previousRadar?.top_discovery || []).map(symbolOf);
const previousRank = new Map(previousTop.map((s: string, i: number) => [s, i + 1]));
const rankMovers = topDiscovery.map((r: any, i: number) => {
  const sym = symbolOf(r);
  const prev = previousRank.get(sym);
  return {
    symbol: sym,
    rank: i + 1,
    previous_rank: prev ?? null,
    rank_improvement: prev == null ? null : prev - (i + 1),
    score: r.discovery?.score ?? discoveryScore(r),
    stage: r.discovery?.stage ?? opportunityStage(r),
  };
}).filter((x: any) => x.previous_rank == null || x.rank_improvement >= 8).slice(0, 20);

const preMoveSentinel = sortByDiscovery(uniqueRows([
  ...quietAccumulation,
  ...earlyBuildUp,
  ...qualityPullback,
  ...nearValue,
  ...institutionalProxy,
  ...largeCapWatch,
])).filter(r => {
  const change = num(r?.change) ?? 0;
  const chase = String(r?.decision_support?.chase_risk || 'low');
  return change < 8 && chase !== 'high';
}).slice(0, 30).map((r: any) => ({
  ...r,
  sentinel_reasons: reasonsBySymbol.get(symbolOf(r)) || [],
}));

const extendedNoChase = uniqueRows([...unusualActivity, ...acceleration, ...topDiscovery])
  .filter(r => opportunityStage(r) === 'extended_no_chase').slice(0, 25);

const discovery = {
  version: 2,
  mode: 'full_universe_sentinel_then_dynamic_focus',
  universe_scanned_each_cycle: true,
  universe_count: universe.stocks?.length ?? 0,
  eligible_liquid_count: universeRows.length,
  permanent_focus_count: baseRows.length,
  dynamic_promoted_count: promotedRows.length,
  dynamic_promoted_symbols: promotedSymbols,
  newly_promoted_symbols: newlyPromotedSymbols,
  pre_move_sentinel_count: preMoveSentinel.length,
  rank_movers_count: rankMovers.length,
  lanes: Object.fromEntries(Object.entries(lanes).map(([k, rows]) => [k, rows.map(symbolOf)])),
  safeguards: {
    focus_is_not_discovery_boundary: true,
    full_universe_scanned_before_focus: true,
    large_cap_sentinel_enabled: true,
    high_liquidity_sentinel_enabled: true,
    quiet_accumulation_lane_enabled: true,
    institutional_flow_is_proxy_not_confirmed: true,
    extended_moves_marked_no_chase: true,
  },
  rule: 'Permanent focus is monitoring depth only. Opportunity discovery starts from the full EGX universe every cycle; pre-move and structural sentinels can promote names automatically.',
};

focus.base_requested_symbols = focus.requested_symbols || [];
focus.dynamic_promoted_symbols = promotedSymbols;
focus.newly_promoted_symbols = newlyPromotedSymbols;
focus.discovery = discovery;
focus.stocks = combinedFocus;

contract.quality = {
  ...(contract.quality || {}),
  discovery_full_market_scanned: true,
  discovery_universe_count: universe.stocks?.length ?? 0,
  permanent_focus_count: baseRows.length,
  dynamic_focus_promoted_count: promotedRows.length,
  effective_focus_count: combinedFocus.length,
  pre_move_sentinel_count: preMoveSentinel.length,
};
contract.discovery_version = 2;

health.discovery = {
  version: 2,
  full_market_scan_ok: (universe.stocks?.length ?? 0) >= 296,
  dynamic_focus_enabled: true,
  pre_move_sentinel_enabled: true,
  structural_large_cap_watch_enabled: true,
  dynamic_promoted_count: promotedRows.length,
  newly_promoted_count: newlyPromotedSymbols.length,
};

latest.data = latest.data || {};
latest.data.discovery = discovery;
latest.data.stocks = combinedFocus;

const radar = {
  radar_version: 2,
  retrieved_at: focus.retrieved_at,
  session_status: focus.session_status,
  expected_reference_session_date: focus.expected_reference_session_date,
  execution_usable: focus.execution_usable,
  source: 'EGX V5 full-universe opportunity sentinel',
  discovery,
  pre_move_sentinel: preMoveSentinel,
  rank_movers: rankMovers,
  newly_promoted: promotedRows.filter((r: any) => newlyPromotedSymbols.includes(symbolOf(r))),
  top_discovery: topDiscovery,
  extended_no_chase: extendedNoChase,
  lanes,
  institutional_proxy_note: 'This lane is a market-data proxy based on size, traded value, demand, relative volume and close location. It is not confirmed institution buy/sell flow.',
};

await Promise.all([
  writeFile(`${OUT}/focus.json`, JSON.stringify(focus, null, 2)),
  writeFile(`${OUT}/contract.json`, JSON.stringify(contract, null, 2)),
  writeFile(`${OUT}/health.json`, JSON.stringify(health, null, 2)),
  writeFile(`${OUT}/latest.json`, JSON.stringify(latest, null, 2)),
  writeFile(`${OUT}/radar.json`, JSON.stringify(radar, null, 2)),
]);

console.log(JSON.stringify({
  radar: 'dynamic-full-universe-v2',
  universe: universe.stocks?.length ?? 0,
  eligible_liquid: universeRows.length,
  permanent_focus: baseRows.length,
  dynamic_promoted: promotedRows.length,
  effective_focus: combinedFocus.length,
  newly_promoted: newlyPromotedSymbols.length,
  pre_move_sentinel: preMoveSentinel.length,
  rank_movers: rankMovers.length,
  quiet_accumulation: quietAccumulation.length,
  institutional_proxy: institutionalProxy.length,
  large_cap_watch: largeCapWatch.length,
  high_liquidity_watch: highLiquidityWatch.length,
}));
