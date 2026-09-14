import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionBundle, fingerprintRows, marketCalendar, normalizeSymbols, validateSnapshot } from '../netlify/functions/_lib/access.mts';
import { scan } from '../netlify/functions/api.mts';

function rows(count = 60) {
  return Array.from({ length: count }, (_, i) => ({
    symbol: i === 0 ? 'MASR' : i === 1 ? 'EFIH' : `S${i}`,
    symbol_full: i === 0 ? 'EGX:MASR' : i === 1 ? 'EGX:EFIH' : `EGX:S${i}`,
    close: 10 + i / 10, open: 10, high: 11, low: 9,
    volume: 100_000 + i, value: 2_000_000 + i,
    change: i % 2 ? 1 : -1, current_session: 'market', update_mode: 'streaming',
    relative_volume_10d: 1.2, decision_support: { setup_score: 6 }
  }));
}

test('calendar identifies an EGX continuous session', () => {
  const calendar = marketCalendar(new Date('2026-09-13T08:00:00Z'));
  assert.equal(calendar.market_calendar_phase, 'continuous');
  assert.equal(calendar.expected_reference_session_date, '2026-09-13');
});

test('fingerprint is stable when row order changes', async () => {
  const a = rows();
  const b = [...a].reverse();
  assert.equal(await fingerprintRows(a), await fingerprintRows(b));
});

test('execution bundle opens the gate only after integrity checks', async () => {
  const data = {
    rows: rows(), count: 60, total_count: 60,
    capabilities: { base: true, advanced_technicals: true, fundamentals_events: true, update_mode: true },
    upstream: { duration_ms: 120, layers: {} }
  };
  const bundle = await buildExecutionBundle(data, {
    symbols: ['MASR', 'EFIH'], now: new Date('2026-09-13T08:00:00Z')
  });
  assert.equal(bundle.execution_usable, true);
  assert.equal(bundle.quality.basic_integrity_ok, true);
  assert.equal(bundle.stocks.length, 2);
  assert.match(bundle.data_fingerprint_sha256, /^[a-f0-9]{64}$/);
});

test('snapshot gate rejects a live-session snapshot older than twenty minutes', async () => {
  const data = {
    rows: rows(), count: 60, total_count: 60,
    capabilities: { base: true, advanced_technicals: true, fundamentals_events: true, update_mode: true },
    upstream: { duration_ms: 120, layers: {} }
  };
  const snapshot = await buildExecutionBundle(data, { now: new Date('2026-09-13T08:00:00Z') });
  const validation = validateSnapshot(snapshot, new Date('2026-09-13T08:21:00Z'));
  assert.equal(validation.usable, false);
  assert.ok(validation.blockers.includes('snapshot_too_old'));
});

test('symbol normalization removes duplicates and rejects malformed values', () => {
  assert.deepEqual(normalizeSymbols(['egx:masr', 'MASR', '../bad', 'EFIH']), ['MASR', 'EFIH']);
});

test('upstream scan retries a transient server error', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('temporary', { status: 503, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ totalCount: 1, data: [{ s: 'EGX:MASR', d: ['MASR', 8.15] }] }), { status: 200 });
  };
  try {
    const result = await scan(['name', 'close'], ['MASR'], [0, 1], 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.rows[0].symbol, 'MASR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
