const TV_URL = 'https://scanner.tradingview.com/egypt/scan';
const CORE_VERSION = '7.1.0';
const DIAGNOSTICS_VERSION = '1.0.0';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function headers() {
  return {
    accept: 'application/json,text/plain,*/*',
    'content-type': 'text/plain;charset=UTF-8',
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/',
    'user-agent': 'Mozilla/5.0 (compatible; EGXMarketFeedDiagnostics/1.0)'
  };
}

function cairoClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now).reduce<Record<string,string>>((o, p) => {
    if (p.type !== 'literal') o[p.type] = p.value;
    return o;
  }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second)
  };
}

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function previousTradingDate(y: number, m: number, d: number) {
  const x = new Date(Date.UTC(y, m - 1, d));
  do {
    x.setUTCDate(x.getUTCDate() - 1);
  } while ([5, 6].includes(x.getUTCDay())); // EGX weekend: Friday/Saturday
  return ymd(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

function calendarContext(now = new Date()) {
  const c = cairoClock(now);
  const mins = c.hour * 60 + c.minute;
  const tradingDay = !['Fri','Sat'].includes(c.weekday);
  let phase = 'closed';
  if (tradingDay && mins >= 570 && mins < 600) phase = 'auction';
  else if (tradingDay && mins >= 600 && mins < 870) phase = 'continuous';
  else if (tradingDay && mins < 570) phase = 'preopen';
  else if (tradingDay) phase = 'postclose';
  const today = ymd(c.year, c.month, c.day);
  const expectedReferenceSessionDate = tradingDay && mins >= 600
    ? today
    : previousTradingDate(c.year, c.month, c.day);
  return {
    cairo_date: today,
    cairo_time: `${String(c.hour).padStart(2,'0')}:${String(c.minute).padStart(2,'0')}:${String(c.second).padStart(2,'0')}`,
    weekday: c.weekday,
    market_calendar_phase: phase,
    expected_reference_session_date: expectedReferenceSessionDate,
    expected_reference_session_date_kind: 'calendar_derived_not_exchange_timestamp'
  };
}

function payload(columns: string[]) {
  return {
    filter: [{ left: 'exchange', operation: 'equal', right: 'EGX' }],
    options: { lang: 'en' },
    markets: ['egypt'],
    symbols: { query: { types: ['stock'] }, tickers: [] },
    columns,
    range: [0, 500]
  };
}

async function scan(columns: string[]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(TV_URL, {
      method: 'POST', headers: headers(), body: JSON.stringify(payload(columns)), signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`TradingView ${res.status}: ${text.slice(0, 300)}`);
    const raw = JSON.parse(text);
    const rows = (raw.data || []).map((item: any) => {
      const row: Record<string, any> = { symbol_full: item.s };
      columns.forEach((c, i) => row[c] = item.d?.[i] ?? null);
      row.symbol = String(item.s || '').split(':').pop();
      return row;
    });
    return { total_count: raw.totalCount ?? rows.length, rows };
  } finally {
    clearTimeout(timer);
  }
}

function scannerSession(rows: any[]) {
  const values = rows.map(r => String(r.current_session || '').toLowerCase()).filter(Boolean);
  if (values.some(v => ['market','regular','continuous','open'].includes(v))) return 'continuous';
  if (values.some(v => v.includes('pre'))) return 'auction';
  if (values.some(v => v.includes('post') || v.includes('closed'))) return 'closed';
  return 'unknown';
}

function counts(values: any[]) {
  return values.reduce<Record<string,number>>((o, v) => {
    const k = String(v ?? 'null');
    o[k] = (o[k] || 0) + 1;
    return o;
  }, {});
}

async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export default async (req: Request) => {
  if (req.method !== 'GET') return json({ status: 'error', message: 'Method not allowed' }, 405);
  const retrievedAt = new Date();
  const calendar = calendarContext(retrievedAt);
  const baseColumns = ['name','description','close','open','high','low','volume','change','current_session'];
  let rows: any[] = [];
  let totalCount = 0;
  let updateModeAvailable = true;
  let updateModeError: string | null = null;

  try {
    try {
      const result = await scan([...baseColumns, 'update_mode']);
      rows = result.rows;
      totalCount = result.total_count;
    } catch (e: any) {
      updateModeAvailable = false;
      updateModeError = String(e?.message || e);
      const result = await scan(baseColumns);
      rows = result.rows;
      totalCount = result.total_count;
    }

    const rowCount = rows.length;
    const uniqueSymbols = new Set(rows.map(r => r.symbol)).size;
    const closeCount = rows.filter(r => Number.isFinite(Number(r.close))).length;
    const volumeCount = rows.filter(r => Number.isFinite(Number(r.volume))).length;
    const closeCoverage = rowCount ? closeCount / rowCount : 0;
    const volumeCoverage = rowCount ? volumeCount / rowCount : 0;
    const sourceSession = scannerSession(rows);
    const updateModes = updateModeAvailable ? counts(rows.map(r => r.update_mode)) : {};
    const currentSessions = counts(rows.map(r => r.current_session));
    const sample = rows.slice(0, 30).sort((a,b) => String(a.symbol).localeCompare(String(b.symbol)));
    const fingerprintInput = sample.map(r => `${r.symbol}:${r.close}:${r.volume}:${r.change}:${r.current_session}:${r.update_mode ?? ''}`).join('|');
    const fingerprint = await sha256(fingerprintInput);

    const basicIntegrity = rowCount >= 50 && uniqueSymbols === rowCount && closeCoverage >= 0.9 && volumeCoverage >= 0.8;
    const liveSessionConsistent = calendar.market_calendar_phase !== 'continuous' || sourceSession === 'continuous';
    const referenceCloseUsable = basicIntegrity;
    const liveExecutionUsable = basicIntegrity && liveSessionConsistent && updateModeAvailable;
    const executionUsable = calendar.market_calendar_phase === 'continuous' ? liveExecutionUsable : referenceCloseUsable;
    const staleRisk = calendar.market_calendar_phase === 'continuous'
      ? (!liveExecutionUsable ? 'high' : 'medium_quote_timestamp_not_exposed')
      : (!referenceCloseUsable ? 'high' : 'medium_reference_date_calendar_derived');

    const blockers: string[] = [];
    if (rowCount < 50) blockers.push('insufficient_row_count');
    if (uniqueSymbols !== rowCount) blockers.push('duplicate_symbols');
    if (closeCoverage < 0.9) blockers.push('low_close_coverage');
    if (volumeCoverage < 0.8) blockers.push('low_volume_coverage');
    if (!liveSessionConsistent) blockers.push('calendar_vs_scanner_session_mismatch');
    if (calendar.market_calendar_phase === 'continuous' && !updateModeAvailable) blockers.push('update_mode_unavailable_during_live_session');

    return json({
      status: executionUsable ? 'ok' : 'degraded',
      core_version_expected: CORE_VERSION,
      diagnostics_version: DIAGNOSTICS_VERSION,
      strict_market_data_policy: {
        execution_prices_volumes_technicals_source: 'EGX Market Feed v2 only',
        external_market_price_fallback_allowed: false,
        external_sources_allowed_for: ['filings','fundamentals','sharia','catalysts'],
        external_sources_must_not_override_execution_market_data: true
      },
      retrieved_at: retrievedAt.toISOString(),
      timestamp_semantics: {
        retrieved_at: 'api_fetch_time_not_exchange_quote_time',
        authoritative_exchange_quote_timestamp_available: false,
        note: 'TradingView public scanner does not expose an authoritative quote/session timestamp in the fields used by the core feed.'
      },
      calendar,
      upstream: {
        name: 'TradingView public scanner',
        reachable: true,
        scanner_session_status: sourceSession,
        update_mode_available: updateModeAvailable,
        update_mode_error: updateModeError,
        update_mode_counts: updateModes,
        current_session_counts: currentSessions
      },
      quality: {
        row_count: rowCount,
        upstream_total_count: totalCount,
        unique_symbols: uniqueSymbols,
        close_coverage_pct: Number((closeCoverage * 100).toFixed(1)),
        volume_coverage_pct: Number((volumeCoverage * 100).toFixed(1)),
        basic_integrity_ok: basicIntegrity,
        live_session_consistent: liveSessionConsistent,
        reference_close_usable: referenceCloseUsable,
        live_execution_usable: liveExecutionUsable,
        execution_usable: executionUsable,
        stale_risk: staleRisk,
        blockers,
        data_fingerprint_sha256: fingerprint
      },
      sample: sample.slice(0, 8).map(r => ({
        symbol: r.symbol,
        last_price: r.close,
        volume: r.volume,
        change_percent: r.change,
        current_session: r.current_session,
        update_mode: r.update_mode ?? null
      }))
    });
  } catch (e: any) {
    return json({
      status: 'error',
      core_version_expected: CORE_VERSION,
      diagnostics_version: DIAGNOSTICS_VERSION,
      retrieved_at: retrievedAt.toISOString(),
      calendar,
      strict_market_data_policy: {
        execution_prices_volumes_technicals_source: 'EGX Market Feed v2 only',
        external_market_price_fallback_allowed: false
      },
      message: 'Primary market upstream unavailable',
      detail: String(e?.message || e)
    }, 502);
  }
};

export const config = { path: '/api/diagnostics' };
