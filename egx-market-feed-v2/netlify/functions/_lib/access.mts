import { getDeployStore, getStore } from '@netlify/blobs';
import { CORE_VERSION, sessionStatus } from '../api.mts';

declare const Netlify: any;

export const SOURCE_ID = 'egx-market-feed-v2';
export const SCHEMA_VERSION = '2026-09-14';
const SNAPSHOT_STORE = 'egx-market-feed-v2';
const SNAPSHOT_KEY = 'latest-execution.json';
export const DEFAULT_SYMBOLS = [
  'EFIH', 'EFID', 'ORWE', 'BONY', 'JUFO', 'AMOC', 'SVCE', 'EGAL', 'MASR', 'MICH'
];

function cairoParts(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now).reduce<Record<string,string>>((out, part) => {
    if (part.type !== 'literal') out[part.type] = part.value;
    return out;
  }, {});
}

function previousTradingDate(date: Date) {
  const d = new Date(date);
  do d.setUTCDate(d.getUTCDate() - 1); while ([5, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

export function marketCalendar(now = new Date()) {
  const p = cairoParts(now);
  const localDate = `${p.year}-${p.month}-${p.day}`;
  const localMidnight = new Date(`${localDate}T00:00:00Z`);
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const tradingDay = !['Fri', 'Sat'].includes(p.weekday);
  let phase = 'closed';
  if (tradingDay && mins < 570) phase = 'preopen';
  else if (tradingDay && mins < 600) phase = 'auction';
  else if (tradingDay && mins < 870) phase = 'continuous';
  else if (tradingDay) phase = 'postclose';
  const expectedReferenceSessionDate = tradingDay && mins >= 600
    ? localDate
    : previousTradingDate(localMidnight);
  return {
    timezone: 'Africa/Cairo', cairo_date: localDate,
    cairo_time: `${p.hour}:${p.minute}:${p.second}`, weekday: p.weekday,
    market_calendar_phase: phase,
    expected_reference_session_date: expectedReferenceSessionDate,
    expected_reference_session_date_kind: 'calendar_derived_not_exchange_timestamp',
    official_holiday_calendar_verified: false
  };
}

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce<Record<string,any>>((out, key) => {
      if (value[key] !== undefined) out[key] = normalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

export async function fingerprintRows(rows: any[]) {
  const stable = rows.map(row => ({
    symbol: row.symbol, close: row.close, change: row.change, high: row.high,
    low: row.low, volume: row.volume, current_session: row.current_session,
    update_mode: row.update_mode ?? null
  })).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  const bytes = new TextEncoder().encode(JSON.stringify(normalize(stable)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeSymbols(raw?: string[] | null) {
  const source = raw?.length ? raw : DEFAULT_SYMBOLS;
  return [...new Set(source.map(s => String(s).trim().toUpperCase().replace(/^EGX:/, '')))]
    .filter(s => /^[A-Z0-9._-]{1,16}$/.test(s)).slice(0, 80);
}

function earlyFlags(row: any) {
  const out: string[] = [];
  if (Number(row.change) >= 8) out.push('daily_move_ge_8pct');
  if (Number(row['Perf.W']) >= 20) out.push('weekly_move_ge_20pct');
  if (Number(row.relative_volume_10d) >= 2) out.push('relative_volume_ge_2x');
  if (Number(row['Perf.1M']) >= 20) out.push('monthly_momentum_ge_20pct');
  return out;
}

function screen(rows: any[]) {
  const ranked = rows.filter(r => Number(r.value) >= 1_000_000 && Number(r.close) > 0)
    .map(r => ({ ...r, early_movement_flags: earlyFlags(r) }))
    .sort((a, b) => (b.decision_support?.setup_score ?? 0) - (a.decision_support?.setup_score ?? 0));
  return {
    top_setup: ranked.slice(0, 40),
    early_movement: ranked.filter(r => r.early_movement_flags.length)
      .sort((a, b) => (b.demand_confirmation_score ?? 0) - (a.demand_confirmation_score ?? 0)).slice(0, 40)
  };
}

export async function buildExecutionBundle(data: any, options: { symbols?: string[], now?: Date } = {}) {
  const now = options.now ?? new Date();
  const requested = normalizeSymbols(options.symbols);
  const bySymbol = new Map(data.rows.map((r: any) => [r.symbol, r]));
  const missingSymbols = requested.filter(s => !bySymbol.has(s));
  const calendar = marketCalendar(now);
  const scannerSession = sessionStatus(data.rows, now);
  const rowCount = data.rows.length;
  const uniqueSymbols = new Set(data.rows.map((r: any) => r.symbol)).size;
  const closeCoverage = rowCount ? data.rows.filter((r: any) => Number.isFinite(Number(r.close))).length / rowCount : 0;
  const volumeCoverage = rowCount ? data.rows.filter((r: any) => Number.isFinite(Number(r.volume))).length / rowCount : 0;
  const basicIntegrity = rowCount >= 50 && uniqueSymbols === rowCount && closeCoverage >= 0.9 && volumeCoverage >= 0.8;
  const liveSessionConsistent = calendar.market_calendar_phase !== 'continuous' || scannerSession === 'continuous';
  const liveExecutionUsable = basicIntegrity && liveSessionConsistent && data.capabilities?.update_mode === true;
  const executionUsable = calendar.market_calendar_phase === 'continuous' ? liveExecutionUsable : basicIntegrity;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (rowCount < 50) blockers.push('insufficient_row_count');
  if (uniqueSymbols !== rowCount) blockers.push('duplicate_symbols');
  if (closeCoverage < 0.9) blockers.push('low_close_coverage');
  if (volumeCoverage < 0.8) blockers.push('low_volume_coverage');
  if (!liveSessionConsistent) blockers.push('calendar_vs_scanner_session_mismatch');
  if (calendar.market_calendar_phase === 'continuous' && !data.capabilities?.update_mode) blockers.push('update_mode_unavailable_during_live_session');
  if (!data.capabilities?.advanced_technicals) warnings.push('advanced_technicals_degraded');
  if (!data.capabilities?.fundamentals_events) warnings.push('fundamentals_events_degraded');
  if (missingSymbols.length) warnings.push(`missing_requested_symbols:${missingSymbols.join(',')}`);
  warnings.push('official_holiday_calendar_not_verified');

  const advancers = data.rows.filter((r: any) => Number(r.change) > 0).length;
  const decliners = data.rows.filter((r: any) => Number(r.change) < 0).length;
  const unchanged = rowCount - advancers - decliners;
  const positivePct = rowCount ? advancers / rowCount * 100 : 0;
  return {
    status: executionUsable ? (warnings.length ? 'degraded' : 'ok') : 'blocked',
    source_id: SOURCE_ID, source: 'TradingView public scanner', version: CORE_VERSION,
    schema_version: SCHEMA_VERSION, retrieved_at: now.toISOString(),
    timestamp_kind: 'retrieval_time_not_exchange_quote_time',
    execution_usable: executionUsable,
    stale_risk: calendar.market_calendar_phase === 'continuous'
      ? (executionUsable ? 'medium_quote_timestamp_not_exposed' : 'high')
      : (executionUsable ? 'medium_reference_date_calendar_derived' : 'high'),
    blockers, warnings,
    data_fingerprint_sha256: await fingerprintRows(data.rows),
    session_status: scannerSession,
    market_calendar: calendar,
    expected_reference_session_date: calendar.expected_reference_session_date,
    strict_market_data_policy: {
      execution_prices_volumes_technicals_source: 'EGX Market Feed v2 only',
      external_market_price_fallback_allowed: false,
      external_sources_allowed_for: ['filings', 'fundamentals', 'sharia', 'catalysts'],
      external_sources_must_not_override_execution_market_data: true
    },
    capabilities: data.capabilities, upstream: data.upstream,
    quality: {
      row_count: rowCount, upstream_total_count: data.total_count,
      unique_symbols: uniqueSymbols,
      close_coverage_pct: Number((closeCoverage * 100).toFixed(1)),
      volume_coverage_pct: Number((volumeCoverage * 100).toFixed(1)),
      basic_integrity_ok: basicIntegrity, live_session_consistent: liveSessionConsistent,
      live_execution_usable: liveExecutionUsable
    },
    market: {
      regime: positivePct >= 55 ? 'strong' : positivePct >= 45 ? 'mixed' : 'weak',
      breadth: { advancers, decliners, unchanged, positive_pct: Number(positivePct.toFixed(1)) }
    },
    screen: screen(data.rows),
    stocks: requested.map(s => bySymbol.get(s)).filter(Boolean),
    missing_symbols: missingSymbols
  };
}

function blobStore() {
  const context = globalThis.Netlify?.context?.deploy?.context ?? globalThis.Netlify?.env?.get('CONTEXT');
  return context === 'production'
    ? getStore({ name: SNAPSHOT_STORE, consistency: 'strong' })
    : getDeployStore(SNAPSHOT_STORE);
}

export async function writeSnapshot(bundle: any) {
  await blobStore().setJSON(SNAPSHOT_KEY, bundle);
}

export async function readSnapshot() {
  return blobStore().get(SNAPSHOT_KEY, { type: 'json' });
}

export function validateSnapshot(snapshot: any, now = new Date()) {
  const blockers: string[] = [];
  if (!snapshot || typeof snapshot !== 'object') blockers.push('snapshot_missing');
  if (snapshot?.source_id !== SOURCE_ID) blockers.push('source_identity_mismatch');
  if (snapshot?.version !== CORE_VERSION) blockers.push('unsupported_version');
  if (!/^[a-f0-9]{64}$/.test(snapshot?.data_fingerprint_sha256 || '')) blockers.push('invalid_fingerprint');
  const age = snapshot?.retrieved_at ? (now.getTime() - new Date(snapshot.retrieved_at).getTime()) / 1000 : Infinity;
  const calendar = marketCalendar(now);
  const maxAge = calendar.market_calendar_phase === 'continuous' ? 1200 : 345600;
  if (!Number.isFinite(age) || age < -60) blockers.push('invalid_snapshot_time');
  if (age > maxAge) blockers.push('snapshot_too_old');
  if (snapshot?.expected_reference_session_date !== calendar.expected_reference_session_date) blockers.push('session_date_mismatch');
  return {
    usable: blockers.length === 0 && snapshot?.execution_usable === true,
    blockers, age_seconds: Number.isFinite(age) ? Math.max(0, Math.round(age)) : null,
    max_age_seconds: maxAge,
    expected_reference_session_date: calendar.expected_reference_session_date
  };
}
