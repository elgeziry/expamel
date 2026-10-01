import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'out';
const MIN_VALUE = 1_000_000;
const MAX_DYNAMIC_FOCUS = 90;

const num = (v: any) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v: number, lo = 0, hi = 10) => Math.min(hi, Math.max(lo, v));
const symbolOf = (r: any) => String(r?.symbol || r?.name || '').toUpperCase();

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

function discoveryScore(row: any) {
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liquidity = num(row?.decision_support?.liquidity_score) ?? 0;
  const rv = rvScore(row);
  const trend = trendScore(row);
  const change = num(row?.change) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');

  // Reward quality + demand + liquidity, but penalize late/chasing moves so the radar
  // surfaces build-ups before they become obvious one-day spikes.
  let score = 0.35 * setup + 0.25 * demand + 0.15 * liquidity + 0.10 * rv + 0.10 * trend;
  if (change >= -2 && change <= 5) score += 0.5;
  else if (change > 5 && change <= 8) score += 0.2;
  if (chase === 'high') score -= 1.0;
  else if (chase === 'medium') score -= 0.35;
  if (change >= 12) score -= 0.8;
  return Number(clamp(score).toFixed(2));
}

function eligible(row: any) {
  const close = num(row?.close);
  const value = num(row?.value_session_adjusted ?? row?.value ?? ((num(row?.close) ?? 0) * (num(row?.volume) ?? 0)));
  return close != null && close > 0 && value != null && value >= MIN_VALUE;
}

function withRadar(row: any) {
  return {
    ...row,
    discovery: {
      score: discoveryScore(row),
      source: 'full_market_universe_scan',
      not_a_buy_signal: true,
    },
  };
}

function sortByDiscovery(rows: any[]) {
  return [...rows].sort((a, b) =>
    (b.discovery?.score ?? discoveryScore(b)) - (a.discovery?.score ?? discoveryScore(a)) ||
    (num(b.value_session_adjusted ?? b.value) ?? 0) - (num(a.value_session_adjusted ?? a.value) ?? 0)
  );
}

function laneEarlyBuildUp(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = num(row?.relative_volume_10d ?? row?.relative_volume_10d_calc) ?? 0;
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');
  const trend = String(row?.long_term_trend || '');
  return eligible(row) && change >= -3 && change <= 7 && rv >= 0.9 && rv <= 2.6 &&
    setup >= 6.8 && demand >= 6.2 && liq >= 6 && chase !== 'high' && trend !== 'below_sma200';
}

function laneAcceleration(row: any) {
  const change = num(row?.change) ?? 0;
  const rv = num(row?.relative_volume_10d ?? row?.relative_volume_10d_calc) ?? 0;
  const demand = num(row?.demand_confirmation_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const chase = String(row?.decision_support?.chase_risk || 'low');
  return eligible(row) && change >= 2 && change <= 12 && rv >= 1.35 && demand >= 6.8 && liq >= 6 && chase !== 'high';
}

function laneQualityPullback(row: any) {
  const change = num(row?.change) ?? 0;
  const rsi = num(row?.RSI);
  const setup = num(row?.decision_support?.setup_score) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  const trend = String(row?.long_term_trend || '');
  return eligible(row) && trend === 'long_term_uptrend' && change >= -6 && change <= 1.5 &&
    setup >= 6.2 && liq >= 6 && (rsi == null || (rsi >= 35 && rsi <= 68));
}

function laneUnusualActivity(row: any) {
  const change = Math.abs(num(row?.change) ?? 0);
  const rv = num(row?.relative_volume_10d ?? row?.relative_volume_10d_calc) ?? 0;
  const liq = num(row?.decision_support?.liquidity_score) ?? 0;
  return eligible(row) && liq >= 6 && (rv >= 2 || change >= 8);
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

const [focusRaw, universeRaw, contractRaw, healthRaw, latestRaw] = await Promise.all([
  readFile(`${OUT}/focus.json`, 'utf8'),
  readFile(`${OUT}/universe.json`, 'utf8'),
  readFile(`${OUT}/contract.json`, 'utf8'),
  readFile(`${OUT}/health.json`, 'utf8'),
  readFile(`${OUT}/latest.json`, 'utf8'),
]);

const focus = JSON.parse(focusRaw);
const universe = JSON.parse(universeRaw);
const contract = JSON.parse(contractRaw);
const health = JSON.parse(healthRaw);
const latest = JSON.parse(latestRaw);

const universeRows = (universe.stocks || []).filter(eligible).map(withRadar);
const allRanked = sortByDiscovery(universeRows);
const earlyBuildUp = sortByDiscovery(universeRows.filter(laneEarlyBuildUp)).slice(0, 35);
const acceleration = sortByDiscovery(universeRows.filter(laneAcceleration)).slice(0, 30);
const qualityPullback = sortByDiscovery(universeRows.filter(laneQualityPullback)).slice(0, 30);
const unusualActivity = sortByDiscovery(universeRows.filter(laneUnusualActivity)).slice(0, 30);
const topDiscovery = allRanked.slice(0, 40);

const baseRows = focus.stocks || [];
const baseSymbols = new Set(baseRows.map(symbolOf));
const enrichedScreenRows = uniqueRows([
  ...(focus?.screen?.top_setup || []),
  ...(focus?.screen?.early_movement || []),
]);
const enrichedBySymbol = new Map(enrichedScreenRows.map((r: any) => [symbolOf(r), r]));

const promotionPool = uniqueRows([
  ...earlyBuildUp.slice(0, 25),
  ...acceleration.slice(0, 20),
  ...qualityPullback.slice(0, 20),
  ...unusualActivity.slice(0, 15),
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
      discovery: r.discovery,
    };
  });

const combinedFocus = uniqueRows([
  ...baseRows.map((r: any) => ({ ...r, dynamic_focus: false, permanent_focus: true })),
  ...promotedRows,
]);

const promotedSymbols = promotedRows.map(symbolOf);
const discovery = {
  mode: 'full_universe_first_dynamic_focus_second',
  universe_scanned_each_cycle: true,
  universe_count: universe.stocks?.length ?? 0,
  eligible_liquid_count: universeRows.length,
  permanent_focus_count: baseRows.length,
  dynamic_promoted_count: promotedRows.length,
  dynamic_promoted_symbols: promotedSymbols,
  lanes: {
    early_build_up: earlyBuildUp.map(symbolOf),
    acceleration: acceleration.map(symbolOf),
    quality_pullback: qualityPullback.map(symbolOf),
    unusual_activity: unusualActivity.map(symbolOf),
  },
  rule: 'Focus is monitoring depth only; discovery always starts from the full EGX universe.',
};

focus.base_requested_symbols = focus.requested_symbols || [];
focus.dynamic_promoted_symbols = promotedSymbols;
focus.discovery = discovery;
focus.stocks = combinedFocus;

contract.quality = {
  ...(contract.quality || {}),
  discovery_full_market_scanned: true,
  discovery_universe_count: universe.stocks?.length ?? 0,
  permanent_focus_count: baseRows.length,
  dynamic_focus_promoted_count: promotedRows.length,
  effective_focus_count: combinedFocus.length,
};

health.discovery = {
  full_market_scan_ok: (universe.stocks?.length ?? 0) >= 296,
  dynamic_focus_enabled: true,
  dynamic_promoted_count: promotedRows.length,
};

latest.data = latest.data || {};
latest.data.discovery = discovery;
latest.data.stocks = combinedFocus;

const radar = {
  retrieved_at: focus.retrieved_at,
  session_status: focus.session_status,
  expected_reference_session_date: focus.expected_reference_session_date,
  execution_usable: focus.execution_usable,
  source: 'EGX V5 full-universe discovery radar',
  discovery,
  top_discovery: topDiscovery,
  lanes: {
    early_build_up: earlyBuildUp,
    acceleration,
    quality_pullback: qualityPullback,
    unusual_activity: unusualActivity,
  },
};

await Promise.all([
  writeFile(`${OUT}/focus.json`, JSON.stringify(focus, null, 2)),
  writeFile(`${OUT}/contract.json`, JSON.stringify(contract, null, 2)),
  writeFile(`${OUT}/health.json`, JSON.stringify(health, null, 2)),
  writeFile(`${OUT}/latest.json`, JSON.stringify(latest, null, 2)),
  writeFile(`${OUT}/radar.json`, JSON.stringify(radar, null, 2)),
]);

console.log(JSON.stringify({
  radar: 'dynamic-full-universe-v1',
  universe: universe.stocks?.length ?? 0,
  eligible_liquid: universeRows.length,
  permanent_focus: baseRows.length,
  dynamic_promoted: promotedRows.length,
  effective_focus: combinedFocus.length,
  early_build_up: earlyBuildUp.length,
  acceleration: acceleration.length,
  quality_pullback: qualityPullback.length,
  unusual_activity: unusualActivity.length,
}));
