import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustedRelativeVolume, enrichAnalytics, mergeHistory, sessionProgress
} from '../netlify/functions/_lib/analytics.mts';

function row(overrides = {}) {
  return {
    symbol: 'TEST', close: 112, open: 110, high: 113, low: 109, volume: 1_100_000,
    value: 123_000_000, change: 1.8, current_session: 'market', relative_volume_10d_raw: 0.25,
    close_location_in_day: 0.75, RSI: 66, SMA20: 108, EMA20: 108.5, SMA50: 101,
    price_target_average: 125, demand_confirmation_score: 7,
    decision_support: { liquidity_score: 9, chase_risk: 'low' }, 'Perf.W': 7,
    ...overrides
  };
}

function history() {
  const sessions = [];
  for (let i = 0; i < 15; i++) {
    const close = 90 + i * 1.45 + (i % 4 === 0 ? -0.8 : 0);
    sessions.push({
      date: `2026-08-${String(i + 20).padStart(2, '0')}`,
      observed_at: `2026-08-${String(i + 20).padStart(2, '0')}T11:40:00Z`,
      bars: { TEST: { close, open: close - 0.5, high: close + 1.2, low: close - 1.1,
        volume: 900_000 + i * 20_000, value: close * (900_000 + i * 20_000), change: 1 } }
    });
  }
  return { schema_version: 'daily-bars-v1', updated_at: '2026-09-14T12:00:00Z', sessions };
}

test('relative volume is adjusted for elapsed session time with an opening floor', () => {
  const now = new Date('2026-09-15T08:00:00Z'); // 11:00 Cairo, 22.2% through the session.
  assert.equal(sessionProgress(now), 0.2222);
  const result = adjustedRelativeVolume(row(), now);
  assert.ok(result.adjusted > 1.1 && result.adjusted < 1.14);
  assert.equal(result.raw, 0.25);
});

test('continuous session status receives the same elapsed-time adjustment', () => {
  const now = new Date('2026-09-15T09:00:00.000Z'); // noon Cairo, 44.4% through session
  const result = adjustedRelativeVolume({ relative_volume_10d: 0.5, current_session: 'continuous' }, now);
  assert.equal(result.method, 'elapsed_session_adjusted_with_opening_floor');
  assert.ok(result.adjusted > result.raw);
});

test('analytics are explicitly provisional when historical structure is missing', () => {
  const [result] = enrichAnalytics([row()], null, new Date('2026-09-15T08:00:00Z'));
  assert.equal(result.analytics.momentum.execution_eligible, false);
  assert.equal(result.analytics.cycle_quality.execution_eligible, false);
  assert.equal(result.analytics.execution_readiness.execution_eligible, false);
  assert.match(result.analytics.momentum.status, /^provisional/);
  assert.equal(result.analytics.cycle_quality.score, null);
  assert.equal(result.analytics.entry_quality.score, null);
  assert.equal(result.analytics.execution_readiness.classification, 'provisional');
});

test('complete history produces bounded momentum, cycle, gap and entry scores', () => {
  const [result] = enrichAnalytics([row()], history(), new Date('2026-09-15T08:00:00Z'));
  for (const metric of [result.analytics.momentum, result.analytics.cycle_quality, result.analytics.entry_quality]) {
    assert.equal(metric.status, 'complete');
    assert.ok(metric.score >= 0 && metric.score <= 10);
  }
  assert.ok(result.analytics.cycle_gap.value >= -10 && result.analytics.cycle_gap.value <= 10);
  assert.ok(result.analytics.execution_readiness.score >= 0 && result.analytics.execution_readiness.score <= 100);
  assert.equal(result.analytics.execution_metrics_eligible, true);
});

test('history merge keeps the newer or materially larger same-day observation', () => {
  const oldRows = [row({ volume: 1_000_000 })];
  const newerRows = [row({ volume: 2_000_000 })];
  const first = mergeHistory(null, oldRows, new Date('2026-09-15T08:00:00Z'));
  const second = mergeHistory(first, newerRows, new Date('2026-09-15T09:00:00Z'));
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].bars.TEST.volume, 2_000_000);
});
