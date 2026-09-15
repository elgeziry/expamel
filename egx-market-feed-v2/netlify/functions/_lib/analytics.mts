export {};

const num = (value: any): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value: number, min = 0, max = 10) => Math.min(max, Math.max(min, value));
const round = (value: number | null, digits = 2) => value == null || !Number.isFinite(value)
  ? null : Number(value.toFixed(digits));

export type CompactBar = {
  date: string; close: number; open: number | null; high: number | null; low: number | null;
  volume: number | null; value: number | null; change: number | null;
};

export type MarketHistory = {
  schema_version: string;
  updated_at: string;
  sessions: Array<{ date: string; observed_at: string; bars: Record<string, Omit<CompactBar, 'date'>> }>;
};

function cairoParts(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).reduce<Record<string,string>>((out, part) => {
    if (part.type !== 'literal') out[part.type] = part.value;
    return out;
  }, {});
}

export function sessionProgress(now = new Date()) {
  const p = cairoParts(now);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return round(clamp((minutes - 600) / 270, 0, 1), 4);
}

export function adjustedRelativeVolume(row: any, now = new Date()) {
  const raw = num(row.relative_volume_10d_raw ?? row.relative_volume_10d_calc ?? row.relative_volume_10d);
  if (raw == null) return { raw: null, adjusted: null, session_progress: sessionProgress(now), method: 'unavailable' };
  const progress = sessionProgress(now) ?? 1;
  const session = String(row.current_session ?? row.session_status ?? '').toLowerCase();
  const live = ['market', 'continuous', 'open', 'live'].includes(session) && progress > 0 && progress < 1;
  // A 15% floor prevents unstable extrapolation during the opening minutes.
  const adjusted = live ? clamp(raw / Math.max(progress, 0.15), 0, 20) : raw;
  return {
    raw: round(raw), adjusted: round(adjusted), session_progress: progress,
    method: live ? 'elapsed_session_adjusted_with_opening_floor' : 'raw_full_session'
  };
}

export function adjustedTradedValue(value: any, now = new Date(), currentSession = 'market') {
  const raw = num(value);
  if (raw == null) return { raw: null, adjusted: null };
  const progress = sessionProgress(now) ?? 1;
  const session = String(currentSession || '').toLowerCase();
  const live = ['market', 'continuous', 'open', 'live'].includes(session) && progress > 0 && progress < 1;
  return { raw: round(raw), adjusted: round(live ? raw / Math.max(progress, 0.15) : raw) };
}

function performanceScore(value: number | null) {
  if (value == null) return null;
  return clamp(5 + value * 0.28);
}

function rvolScore(value: number | null) {
  if (value == null) return null;
  if (value < 0.35) return 1;
  if (value < 0.7) return 3;
  if (value < 1) return 4.5;
  if (value < 1.5) return 6.5;
  if (value < 2) return 8;
  if (value < 3) return 9;
  return 10;
}

function rsiScore(value: number | null) {
  if (value == null) return null;
  if (value < 30) return 1.5;
  if (value < 40) return 3;
  if (value < 50) return 4.5;
  if (value < 60) return 6;
  if (value < 70) return 8;
  if (value <= 80) return 10;
  return Math.max(7, 10 - (value - 80) * 0.2);
}

function maScore(row: any) {
  const c = num(row.close), m20 = num(row.SMA20 ?? row.EMA20), m50 = num(row.SMA50 ?? row.EMA50);
  if (c == null || m20 == null || m50 == null) return null;
  if (c > m20 && m20 > m50) return 10;
  if (c > m20 && c > m50) return 7.5;
  if (c > m50) return 5.5;
  if (c > m20) return 4.5;
  return 2;
}

function seriesFor(symbol: string, history: MarketHistory | null, row: any, now = new Date()): CompactBar[] {
  const past = (history?.sessions || []).map(session => {
    const bar = session.bars?.[symbol];
    return bar ? { date: session.date, ...bar } : null;
  }).filter(Boolean) as CompactBar[];
  const p = cairoParts(now);
  const date = `${p.year}-${p.month}-${p.day}`;
  const current: CompactBar = {
    date, close: num(row.close)!, open: num(row.open), high: num(row.high), low: num(row.low),
    volume: num(row.volume), value: num(row.value), change: num(row.change)
  };
  return [...past.filter(bar => bar.date !== date), current]
    .filter(bar => bar.close != null).sort((a, b) => a.date.localeCompare(b.date));
}

function percentChange(current: number, previous: number | null) {
  return previous && previous !== 0 ? (current / previous - 1) * 100 : null;
}

function trueRange(bar: CompactBar, previousClose: number | null) {
  if (bar.high == null || bar.low == null) return null;
  return Math.max(bar.high - bar.low,
    previousClose == null ? 0 : Math.abs(bar.high - previousClose),
    previousClose == null ? 0 : Math.abs(bar.low - previousClose));
}

function atr(series: CompactBar[], length = 14) {
  if (series.length < Math.min(6, length + 1)) return null;
  const sample = series.slice(-(length + 1));
  const ranges = sample.slice(1).map((bar, index) => trueRange(bar, sample[index].close)).filter(v => v != null) as number[];
  return ranges.length >= 5 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
}

function continuityScore(series: CompactBar[]) {
  if (series.length < 4) return null;
  const closes = series.slice(-4).map(bar => bar.close);
  const returns = closes.slice(1).map((close, i) => percentChange(close, closes[i]) ?? 0);
  const positive = returns.filter(v => v > 0).length;
  const acceleration = returns[2] - returns[1];
  return clamp(2 + positive * 2.2 + (acceleration > 0 ? 1.4 : acceleration < -2 ? -1 : 0));
}

function component(name: string, score: number | null, weight: number, raw: any) {
  return { name, score: round(score, 1), weight, raw, available: score != null };
}

export function momentum(row: any, history: MarketHistory | null, now = new Date()) {
  const series = seriesFor(row.symbol, history, row, now);
  const close = num(row.close)!;
  const perf3 = series.length >= 4 ? percentChange(close, series[series.length - 4].close) : null;
  const week = num(row['Perf.W']);
  const perf = perf3 == null ? null : (performanceScore(perf3)! + (performanceScore(week) ?? performanceScore(perf3)!)) / 2;
  const rv = adjustedRelativeVolume(row, now);
  const loc = num(row.close_location_in_day);
  const locationScore = loc == null ? null : clamp(loc * 10 + ((num(row.change) ?? 0) > 0 ? 0.5 : -0.5));
  const components = [
    component('three_sessions_and_week', perf, 0.30, { performance_3_sessions_pct: round(perf3), performance_week_pct: week }),
    component('relative_volume_10d', rvolScore(rv.adjusted), 0.20, rv),
    component('close_location', locationScore, 0.15, loc),
    component('rsi', rsiScore(num(row.RSI)), 0.15, num(row.RSI)),
    component('ma20_50', maScore(row), 0.10, { close, ma20: num(row.SMA20), ma50: num(row.SMA50) }),
    component('continuity_acceleration', continuityScore(series), 0.10, { sessions_available: series.length })
  ];
  const availableWeight = components.filter(c => c.available).reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.filter(c => c.available).reduce((sum, c) => sum + c.score! * c.weight, 0);
  const complete = components.every(c => c.available);
  return {
    score: round(availableWeight ? weighted / availableWeight : null, 1),
    status: complete ? 'complete' : 'provisional_not_execution_eligible',
    confidence_pct: Math.round(availableWeight * 100),
    execution_eligible: complete,
    missing_components: components.filter(c => !c.available).map(c => c.name),
    components
  };
}

function pivots(series: CompactBar[]) {
  const highs: Array<{ index: number; value: number }> = [];
  const lows: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i].high != null && series[i - 1].high != null && series[i + 1].high != null &&
      series[i].high! >= series[i - 1].high! && series[i].high! > series[i + 1].high!) highs.push({ index: i, value: series[i].high! });
    if (series[i].low != null && series[i - 1].low != null && series[i + 1].low != null &&
      series[i].low! <= series[i - 1].low! && series[i].low! < series[i + 1].low!) lows.push({ index: i, value: series[i].low! });
  }
  return { highs, lows };
}

function effortResult(row: any, adjustedRvolValue: number | null) {
  const loc = num(row.close_location_in_day), change = num(row.change);
  if (adjustedRvolValue == null || loc == null || change == null) return null;
  if (adjustedRvolValue >= 1.5 && change <= 0.5 && loc < 0.35) return 2;
  if (adjustedRvolValue >= 1.2 && change > 0 && loc > 0.65) return 9;
  if (adjustedRvolValue < 0.8 && change < 0 && loc > 0.35) return 7;
  return clamp(5 + change * 0.25 + (loc - 0.5) * 4);
}

export function cycleQuality(row: any, history: MarketHistory | null, now = new Date()) {
  const series = seriesFor(row.symbol, history, row, now);
  const { highs, lows } = pivots(series);
  const rv = adjustedRelativeVolume(row, now);
  const close = num(row.close)!;
  let weeklyStructure: number | null = null;
  if (highs.length >= 2 && lows.length >= 2) {
    weeklyStructure = clamp(5 + (highs.at(-1)!.value > highs.at(-2)!.value ? 2.5 : -2) +
      (lows.at(-1)!.value > lows.at(-2)!.value ? 2.5 : -2));
  } else if (series.length >= 10) {
    const previous = series.slice(-10, -5), recent = series.slice(-5);
    const previousHigh = Math.max(...previous.map(bar => bar.high ?? bar.close));
    const recentHigh = Math.max(...recent.map(bar => bar.high ?? bar.close));
    const previousLow = Math.min(...previous.map(bar => bar.low ?? bar.close));
    const recentLow = Math.min(...recent.map(bar => bar.low ?? bar.close));
    weeklyStructure = clamp(5 + (recentHigh > previousHigh ? 2.5 : -2) + (recentLow > previousLow ? 2.5 : -2));
  }
  const fallbackPriorHigh = series.length >= 6
    ? Math.max(...series.slice(-10, -2).map(bar => bar.high ?? bar.close)) : null;
  const priorHigh = highs.filter(p => p.index < series.length - 1).at(-1)
    ?? (fallbackPriorHigh == null ? undefined : { index: Math.max(0, series.length - 3), value: fallbackPriorHigh });
  const breakoutDistance = priorHigh ? (close / priorHigh.value - 1) * 100 : null;
  const breakoutStrength = priorHigh == null ? null : clamp(5 + (breakoutDistance! > 0 ? 2 : -1.5) +
    ((num(row.close_location_in_day) ?? 0.5) - 0.5) * 4 + ((num(row.change) ?? 0) > 0 ? 1 : 0));
  const volumeAsymmetry = effortResult(row, rv.adjusted);
  const atrValue = atr(series);
  const ma20 = num(row.SMA20 ?? row.EMA20);
  const distanceFromValueAtr = atrValue && ma20 != null ? (close - ma20) / atrValue : null;
  const retest = priorHigh == null || atrValue == null ? null : clamp(8 - Math.abs(close - priorHigh.value) / atrValue * 2 +
    (rv.adjusted != null && rv.adjusted < 1 && (num(row.change) ?? 0) <= 0 ? 1.5 : 0));
  let higherLow: number | null = null;
  if (lows.length >= 2) higherLow = lows.at(-1)!.value > lows.at(-2)!.value ? 9 : 2;
  else if (series.length >= 10) {
    const previousLow = Math.min(...series.slice(-10, -5).map(bar => bar.low ?? bar.close));
    const recentLow = Math.min(...series.slice(-5).map(bar => bar.low ?? bar.close));
    higherLow = recentLow > previousLow ? 9 : 2;
  }

  const components = [
    component('weekly_structure', weeklyStructure, 0.25, { pivots_high: highs.length, pivots_low: lows.length }),
    component('breakout_strength', breakoutStrength, 0.20, { prior_pivot_high: priorHigh?.value ?? null, distance_pct: round(breakoutDistance) }),
    component('volume_asymmetry', volumeAsymmetry, 0.20, rv),
    component('retest_quality', retest, 0.20, { atr: round(atrValue), distance_from_value_atr: round(distanceFromValueAtr) }),
    component('higher_low', higherLow, 0.15, { recent_pivot_lows: lows.slice(-2).map(p => round(p.value)) })
  ];
  const availableWeight = components.filter(c => c.available).reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.filter(c => c.available).reduce((sum, c) => sum + c.score! * c.weight, 0);
  const complete = components.every(c => c.available) && series.length >= 10;
  let score = round(availableWeight ? weighted / availableWeight : null, 1);
  let integrity = 'not_confirmed';
  if (priorHigh && close < priorHigh.value && (rv.adjusted ?? 0) >= 1.5 && (num(row.change) ?? 0) < -1) integrity = 'broken_failed_breakout';
  if (lows.length >= 2 && lows.at(-1)!.value < lows.at(-2)!.value && close < lows.at(-1)!.value) integrity = 'broken_lower_low';
  if (integrity.startsWith('broken')) score = Math.min(score ?? 4, 4);
  const phase = priorHigh == null ? 'foundation_or_unconfirmed' : breakoutDistance! > 0
    ? (distanceFromValueAtr != null && distanceFromValueAtr > 2 ? 'late_extension' : 'breakout_or_resume')
    : (Math.abs(breakoutDistance!) <= 3 ? 'digestion_or_retest' : 'foundation_or_repair');
  return {
    score, status: complete ? 'complete' : 'provisional_not_execution_eligible',
    confidence_pct: Math.min(100, Math.round(availableWeight * 100 * Math.min(1, series.length / 10))),
    execution_eligible: complete, integrity, phase,
    sessions_available: series.length,
    missing_components: components.filter(c => !c.available).map(c => c.name), components
  };
}

export function entryQuality(row: any, history: MarketHistory | null, now = new Date()) {
  const series = seriesFor(row.symbol, history, row, now);
  const close = num(row.close)!;
  const atrValue = atr(series);
  const { highs, lows } = pivots(series);
  const supportCandidates = [num(row.SMA20), num(row.EMA20), num(row.SMA50), lows.at(-1)?.value ?? null]
    .filter((v): v is number => v != null && v < close).sort((a, b) => b - a);
  const resistanceCandidates = [highs.at(-1)?.value ?? null, num(row.price_target_average)]
    .filter((v): v is number => v != null && v > close).sort((a, b) => a - b);
  const support = supportCandidates[0] ?? null;
  const resistance = resistanceCandidates[0] ?? null;
  const risk = support == null ? null : close - support;
  const reward = resistance == null ? null : resistance - close;
  const rr = risk != null && risk > 0 && reward != null ? reward / risk : null;
  const distanceAtr = atrValue && support != null ? (close - support) / atrValue : null;
  let liquidityRisk = 'unavailable';
  if (atrValue && lows.length >= 2) {
    liquidityRisk = Math.abs(lows.at(-1)!.value - lows.at(-2)!.value) <= atrValue * 0.25
      ? 'equal_lows_stop_hunt_zone' : 'normal';
  } else if (atrValue && series.length >= 10) {
    const previousLow = Math.min(...series.slice(-10, -5).map(bar => bar.low ?? bar.close));
    const recentLow = Math.min(...series.slice(-5).map(bar => bar.low ?? bar.close));
    liquidityRisk = Math.abs(recentLow - previousLow) <= atrValue * 0.25 ? 'equal_lows_stop_hunt_zone' : 'normal';
  }
  const distanceScore = distanceAtr == null ? null : clamp(9 - Math.abs(distanceAtr - 0.5) * 2.5);
  const rrScore = rr == null ? null : clamp(rr >= 3 ? 10 : rr >= 1.8 ? 8 : rr >= 1.2 ? 5 : 2);
  const chase = row.decision_support?.chase_risk;
  const chaseScore = chase === 'low' ? 8 : chase === 'medium' ? 5 : chase === 'high' ? 2 : null;
  const location = num(row.close_location_in_day);
  const liquidityScore = liquidityRisk === 'equal_lows_stop_hunt_zone' ? 4 : liquidityRisk === 'normal' ? 8 : null;
  const locationScore = location == null ? null : clamp(3 + location * 6);
  const parts = [
    component('distance_from_value_support', distanceScore, 0.30, { support: round(support), distance_atr: round(distanceAtr) }),
    component('risk_reward', rrScore, 0.30, { resistance: round(resistance), invalidation: round(support), rr: round(rr) }),
    component('liquidity_stop_hunt', liquidityScore, 0.20, liquidityRisk),
    component('chase_slippage', chaseScore, 0.10, chase),
    component('close_location', locationScore, 0.10, location)
  ];
  const weight = parts.filter(c => c.available).reduce((sum, c) => sum + c.weight, 0);
  const weighted = parts.filter(c => c.available).reduce((sum, c) => sum + c.score! * c.weight, 0);
  const complete = parts.every(c => c.available) && atrValue != null && series.length >= 10;
  return {
    score: round(weight ? weighted / weight : null, 1),
    status: complete ? 'complete' : 'provisional_not_execution_eligible',
    confidence_pct: Math.min(100, Math.round(weight * 100 * Math.min(1, series.length / 10))),
    execution_eligible: complete, liquidity_zone: liquidityRisk,
    support: round(support), resistance: round(resistance), invalidation: round(support), risk_reward: round(rr),
    missing_components: parts.filter(c => !c.available).map(c => c.name), components: parts
  };
}

export function enrichAnalytics(rows: any[], history: MarketHistory | null, now = new Date()) {
  return rows.map(row => {
    const mom = momentum(row, history, now);
    const cycle = cycleQuality(row, history, now);
    const entry = entryQuality(row, history, now);
    const gap = mom.score != null && cycle.score != null ? round(mom.score - cycle.score, 1) : null;
    const gapClass = gap == null ? 'unavailable' : gap > 2 ? 'fragile_acceleration' : gap < -2 ? 'latent_setup' : 'aligned';
    const executionEligible = mom.execution_eligible && cycle.execution_eligible && entry.execution_eligible;
    const demand = num(row.demand_confirmation_score);
    const liquidity = num(row.decision_support?.liquidity_score);
    const readinessParts = [
      { score: cycle.score, weight: 0.30 }, { score: entry.score, weight: 0.25 },
      { score: demand, weight: 0.20 }, { score: mom.score, weight: 0.15 },
      { score: liquidity, weight: 0.10 }
    ];
    const readinessWeight = readinessParts.filter(part => part.score != null).reduce((sum, part) => sum + part.weight, 0);
    let readiness = readinessWeight ? readinessParts.filter(part => part.score != null)
      .reduce((sum, part) => sum + part.score! * 10 * part.weight, 0) / readinessWeight : null;
    const hardVeto = cycle.integrity.startsWith('broken') || (gap != null && gap > 2 && cycle.phase === 'late_extension');
    if (hardVeto && readiness != null) readiness = Math.min(readiness, 49);
    return {
      ...row,
      analytics: {
        momentum: mom,
        cycle_quality: cycle,
        cycle_gap: { value: gap, classification: gapClass, status: executionEligible ? 'complete' : 'provisional_not_execution_eligible' },
        entry_quality: entry,
        re_acceleration_trigger: cycle.phase === 'digestion_or_retest' && (row.demand_confirmation_score ?? 0) >= 6
          ? 'forming' : 'not_present',
        execution_readiness: {
          score: round(readiness, 1),
          status: executionEligible ? 'complete' : 'provisional_not_execution_eligible',
          execution_eligible: executionEligible && !hardVeto,
          hard_veto: hardVeto,
          classification: readiness == null ? 'unavailable' : readiness >= 75 ? 'high' : readiness >= 65 ? 'conditional' : 'wait'
        },
        execution_metrics_eligible: executionEligible && !hardVeto
      }
    };
  });
}

export function compactSession(rows: any[], now = new Date()) {
  const p = cairoParts(now);
  const date = `${p.year}-${p.month}-${p.day}`;
  const bars: Record<string, Omit<CompactBar, 'date'>> = {};
  for (const row of rows) {
    const close = num(row.close);
    if (!row.symbol || close == null) continue;
    bars[row.symbol] = {
      close, open: num(row.open), high: num(row.high), low: num(row.low), volume: num(row.volume),
      value: num(row.value), change: num(row.change)
    };
  }
  return { date, observed_at: now.toISOString(), bars };
}

export function mergeHistory(history: MarketHistory | null, rows: any[], now = new Date()): MarketHistory {
  const current = compactSession(rows, now);
  const existingCurrent = (history?.sessions || []).find(session => session.date === current.date);
  const totalVolume = (session: { bars: Record<string, Omit<CompactBar, 'date'>> }) => Object.values(session.bars || {})
    .reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  const keepExisting = existingCurrent && (
    existingCurrent.observed_at > current.observed_at || totalVolume(existingCurrent) > totalVolume(current) * 1.02
  );
  const sessions = (history?.sessions || []).filter(session => session.date !== current.date);
  sessions.push(keepExisting ? existingCurrent : current);
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { schema_version: 'daily-bars-v1', updated_at: now.toISOString(), sessions: sessions.slice(-90) };
}
