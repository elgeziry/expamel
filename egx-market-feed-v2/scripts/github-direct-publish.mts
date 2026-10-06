import { mkdir, writeFile } from 'node:fs/promises';
import { fetchMarket } from '../netlify/functions/api.mts';
import { buildExecutionBundle } from '../netlify/functions/_lib/access.mts';

const SOURCE_ID = 'egx-market-feed-v2';
const EXPECTED_UNIVERSE_FLOOR = 296;
const MAX_QUARANTINED_SYMBOLS = 1;
const LIVE_MAX_AGE_SECONDS = 600;
const STAGNATION_MAX_SECONDS = 1200;
const FOCUS = (process.env.FOCUS_SYMBOLS || 'EFIH,ICFC,EFID,EGAL,AMOC,JUFO,ORWE,SVCE,MASR,ORAS,BONY,MFPC,ABUK,ETEL,ORHD,HELI,TMGH,VLMRA,KABO,ATQA,MPCO,SWDY')
  .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const REPO = process.env.GITHUB_REPOSITORY || 'elgeziry/expamel';
const now = new Date();

function ageSeconds(iso: string | null | undefined) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 1000) : null;
}

async function fetchJson(url: string, attempts = 2) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'EGX-Direct-Bridge-V5/1.0', 'cache-control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}

async function readPreviousContract() {
  try {
    const stamp = Date.now();
    return await fetchJson(`https://raw.githubusercontent.com/${REPO}/egx-live/contract.json?ts=${stamp}`, 1);
  } catch {
    return null;
  }
}

async function readPreviousUniverse() {
  try {
    const stamp = Date.now();
    return await fetchJson(`https://raw.githubusercontent.com/${REPO}/egx-live/universe.json?ts=${stamp}`, 1);
  } catch {
    return null;
  }
}

function symbolSet(rows: any[]) {
  return new Set((rows || []).map((x: any) => String(x?.symbol || '').toUpperCase()).filter(Boolean));
}

function assertBundle(bundle: any, universeFloor = EXPECTED_UNIVERSE_FLOOR) {
  const reasons: string[] = [];
  if (!bundle || typeof bundle !== 'object') reasons.push('not_object');
  if (bundle?.source_id !== SOURCE_ID) reasons.push('source_identity_mismatch');
  if (bundle?.execution_usable !== true) reasons.push('execution_not_usable');
  if ((bundle?.blockers || []).length) reasons.push(`blockers:${(bundle.blockers || []).join(',')}`);
  const q = bundle?.quality || {};
  if ((q.row_count || 0) < universeFloor) reasons.push(`incomplete_universe:${q.row_count || 0}`);
  if ((q.close_coverage_pct || 0) < 90) reasons.push('low_close_coverage');
  if ((q.volume_coverage_pct || 0) < 80) reasons.push('low_volume_coverage');
  if (q.live_session_consistent !== true) reasons.push('session_inconsistent');
  const returned = new Set((bundle?.stocks || []).map((x: any) => String(x?.symbol || '').toUpperCase()));
  const missing = FOCUS.filter(s => !returned.has(s));
  if (missing.length) reasons.push(`focus_missing:${missing.join(',')}`);
  if (!/^[a-f0-9]{64}$/.test(bundle?.data_fingerprint_sha256 || '')) reasons.push('invalid_fingerprint');
  if (reasons.length) throw new Error(`FAIL_CLOSED:${reasons.join('|')}`);
}

const [previous, previousUniverse] = await Promise.all([readPreviousContract(), readPreviousUniverse()]);
const market = await fetchMarket(null, now);
const currentSymbols = symbolSet(market.rows || []);
const previousTargetRows = Array.isArray(previousUniverse?.roster_target_symbols) && previousUniverse.roster_target_symbols.length >= EXPECTED_UNIVERSE_FLOOR
  ? previousUniverse.roster_target_symbols.map((symbol: string) => ({ symbol }))
  : (previousUniverse?.stocks || []);
const targetSymbols = symbolSet(previousTargetRows);
const missingSymbols = [...targetSymbols].filter(symbol => !currentSymbols.has(symbol)).sort();
const addedSymbols = [...currentSymbols].filter(symbol => targetSymbols.size > 0 && !targetSymbols.has(symbol)).sort();
const missingFocusSymbols = missingSymbols.filter(symbol => FOCUS.includes(symbol));
const adaptiveCoverageAllowed =
  targetSymbols.size >= EXPECTED_UNIVERSE_FLOOR &&
  market.rows.length >= EXPECTED_UNIVERSE_FLOOR - MAX_QUARANTINED_SYMBOLS &&
  missingSymbols.length <= MAX_QUARANTINED_SYMBOLS &&
  missingFocusSymbols.length === 0;
const effectiveUniverseFloor = market.rows.length >= EXPECTED_UNIVERSE_FLOOR
  ? EXPECTED_UNIVERSE_FLOOR
  : (adaptiveCoverageAllowed ? market.rows.length : EXPECTED_UNIVERSE_FLOOR);
const bundle = await buildExecutionBundle(market, {
  symbols: FOCUS,
  now,
  history: null,
  expectedUniverseFloor: effectiveUniverseFloor,
});
assertBundle(bundle, effectiveUniverseFloor);
const coverageComplete = market.rows.length >= EXPECTED_UNIVERSE_FLOOR;
const coverageOperational = coverageComplete || adaptiveCoverageAllowed;
const quarantine = coverageComplete ? [] : missingSymbols;
const rosterTargetSymbols = targetSymbols.size >= EXPECTED_UNIVERSE_FLOOR
  ? [...targetSymbols].sort()
  : [...currentSymbols].sort();

const fingerprint = bundle.data_fingerprint_sha256;
const sameSession = previous?.expected_reference_session_date === bundle.expected_reference_session_date;
const sameFingerprint = sameSession && previous?.data_fingerprint_sha256 === fingerprint;
const continuous = String(bundle.session_status || '').toLowerCase() === 'continuous';
let fingerprintFirstSeenAt = now.toISOString();
if (continuous && sameFingerprint) {
  fingerprintFirstSeenAt = previous?.liveness?.fingerprint_first_seen_at || previous?.retrieved_at || now.toISOString();
}
const stagnationSeconds = continuous && sameFingerprint
  ? Math.max(0, (now.getTime() - new Date(fingerprintFirstSeenAt).getTime()) / 1000)
  : 0;
if (continuous && stagnationSeconds > STAGNATION_MAX_SECONDS) {
  throw new Error(`FAIL_CLOSED:market_data_stagnant_${Math.round(stagnationSeconds)}s`);
}

const liveAge = ageSeconds(bundle.retrieved_at);
if (continuous && (liveAge == null || liveAge > LIVE_MAX_AGE_SECONDS)) {
  throw new Error(`FAIL_CLOSED:stale_bundle_${liveAge == null ? 'unknown' : Math.round(liveAge)}s`);
}

const alias: Record<string,string> = { BNYN: 'BONY', IFCM: 'ICFC' };
const focusRows = (bundle.stocks || []).map((row: any) => {
  const r = { ...row };
  const sym = String(r.symbol || '').toUpperCase();
  r.canonical_symbol = alias[sym] || sym;
  if (sym === 'BONY') r.symbol_aliases = ['BONY','BNYN'];
  if (sym === 'ICFC') r.symbol_aliases = ['ICFC','IFCM'];
  return r;
});

const quality = {
  ...(bundle.quality || {}),
  bridge_live_age_seconds: liveAge == null ? null : Number(liveAge.toFixed(1)),
  bridge_gate: 'pass',
  expected_universe_target: EXPECTED_UNIVERSE_FLOOR,
  effective_universe_floor: effectiveUniverseFloor,
  current_universe_count: market.rows.length,
  universe_coverage_pct: Number(((market.rows.length / EXPECTED_UNIVERSE_FLOOR) * 100).toFixed(2)),
  full_market_fresh: coverageComplete,
  universe_operational: coverageOperational,
  coverage_mode: coverageComplete ? 'complete' : 'degraded_selective_quarantine',
  missing_symbols: quarantine,
  added_symbols_vs_target: addedSymbols,
  quarantined_symbols: quarantine,
  selective_execution_only: !coverageComplete,
  focus_requested: FOCUS.length,
  focus_returned: focusRows.length,
  focus_complete: focusRows.length === FOCUS.length,
};

const warnings = [
  ...(bundle.warnings || []),
  ...(!coverageComplete ? [`degraded_universe_quarantine:${quarantine.join(',')}`] : []),
  'transport_netlify_independent',
  'quote_timestamp_not_exposed_liveness_guard_enabled',
];

const liveness = {
  method: 'full_market_fingerprint_heartbeat',
  fingerprint_first_seen_at: fingerprintFirstSeenAt,
  stagnation_seconds: Math.round(stagnationSeconds),
  max_stagnation_seconds: STAGNATION_MAX_SECONDS,
  passed: !continuous || stagnationSeconds <= STAGNATION_MAX_SECONDS,
};

const latest = {
  bridge: {
    name: 'EGX Resilient Bridge',
    version: '5.0-github-direct',
    generated_at: bundle.retrieved_at,
    publisher_generated_at: now.toISOString(),
    transport_independent: true,
    selected_mode: 'github_actions_direct_upstream',
    market_phase: bundle.session_status || 'unknown',
    data_sha256: fingerprint,
    live_max_age_seconds: LIVE_MAX_AGE_SECONDS,
    history_contract: 'egx-session-history-v4',
    cycle_quality_engine: 'decoupled_daily-v4',
  },
  path_health: {
    github_direct: { ok: true, execution_usable: true, live_age_seconds: liveAge, liveness },
    github_mirror: { ok: true, mode: 'normal_non_force_commit' },
    netlify: { ok: false, required: false, status: 'retired_from_primary_path' },
    vercel: { ok: false, required: false, status: 'optional_secondary_path' },
  },
  data: {
    execution_usable: true,
    retrieved_at: bundle.retrieved_at,
    session_status: bundle.session_status,
    expected_reference_session_date: bundle.expected_reference_session_date,
    stale_risk: continuous ? 'controlled_by_fingerprint_heartbeat' : bundle.stale_risk,
    blockers: [],
    warnings,
    quality,
    market: bundle.market || {},
    screen: bundle.screen || { top_setup: [], early_movement: [] },
    stocks: focusRows,
    cycle_quality: [],
    history: { contract: 'egx-session-history-v4', retention_sessions: 60, source: 'decoupled_daily_history' },
  },
};

const contract = {
  source_id: bundle.source_id,
  version: bundle.version,
  bridge_version: '5.0-github-direct',
  transport: 'github-actions-direct-upstream',
  retrieved_at: bundle.retrieved_at,
  session_status: bundle.session_status,
  expected_reference_session_date: bundle.expected_reference_session_date,
  execution_usable: true,
  live_age_seconds: liveAge,
  max_live_age_seconds: LIVE_MAX_AGE_SECONDS,
  stale_risk: latest.data.stale_risk,
  blockers: [],
  warnings,
  quality,
  data_fingerprint_sha256: fingerprint,
  bridge_gate: 'pass',
  liveness,
};

const health = {
  status: 'ok',
  bridge_version: '5.0-github-direct',
  checked_at: now.toISOString(),
  selected_base: 'direct://scanner.tradingview.com/egypt/scan',
  live_age_seconds: liveAge,
  execution_usable: true,
  focus_complete: focusRows.length === FOCUS.length,
  full_market_fresh: coverageComplete,
  universe_operational: coverageOperational,
  coverage_mode: quality.coverage_mode,
  quarantined_symbols: quarantine,
  liveness,
  provider_dependency: { netlify: false, vercel: false },
};

const transport = {
  transport: 'github-actions-v5-direct-source',
  market_source: 'TradingView public scanner via EGX Market Feed v2 core',
  source_url: 'https://scanner.tradingview.com/egypt/scan',
  mirrored_at: now.toISOString(),
  netlify_used: false,
  vercel_used: false,
  external_market_fallback_used: false,
  external_market_crosscheck_used: false,
};

const focusDoc = {
  retrieved_at: bundle.retrieved_at,
  session_status: bundle.session_status,
  expected_reference_session_date: bundle.expected_reference_session_date,
  execution_usable: true,
  live_age_seconds: liveAge,
  requested_symbols: FOCUS,
  canonical_aliases: alias,
  market: bundle.market || {},
  screen: bundle.screen || {},
  stocks: focusRows,
};

const universe = {
  retrieved_at: bundle.retrieved_at,
  session_status: bundle.session_status,
  expected_reference_session_date: bundle.expected_reference_session_date,
  universe_fresh: coverageComplete,
  universe_operational: coverageOperational,
  universe_complete: coverageComplete,
  roster_target_count: EXPECTED_UNIVERSE_FLOOR,
  roster_target_symbols: rosterTargetSymbols,
  quarantined_symbols: quarantine,
  missing_symbols: quarantine,
  added_symbols_vs_target: addedSymbols,
  quality,
  market: bundle.market || {},
  screen: bundle.screen || {},
  stocks: market.rows,
};

await mkdir('out', { recursive: true });
for (const [name, obj] of Object.entries({
  'latest.json': latest,
  'contract.json': contract,
  'health.json': health,
  'transport.json': transport,
  'focus.json': focusDoc,
  'universe.json': universe,
})) {
  await writeFile(`out/${name}`, JSON.stringify(obj, null, 2));
}

console.log(JSON.stringify({
  bridge: '5.0-github-direct',
  execution_usable: true,
  rows: market.rows.length,
  target_rows: EXPECTED_UNIVERSE_FLOOR,
  coverage_mode: quality.coverage_mode,
  quarantined_symbols: quarantine,
  focus: focusRows.length,
  session: bundle.session_status,
  reference_date: bundle.expected_reference_session_date,
  stagnation_seconds: Math.round(stagnationSeconds),
  fingerprint,
}));
