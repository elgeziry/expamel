import { CORE_VERSION, fetchMarket } from './api.mts';
import {
  buildExecutionBundle, readHistory, readSnapshot, SCHEMA_VERSION, SOURCE_ID, validateSnapshot
} from './_lib/access.mts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function diagnosticPayload(bundle: any, deliveryMode: string, snapshotValidation: any = null) {
  return {
    status: bundle.execution_usable ? (bundle.status === 'ok' ? 'ok' : 'degraded') : 'blocked',
    source_id: SOURCE_ID, version: CORE_VERSION, core_version_expected: CORE_VERSION,
    diagnostics_version: '2.1.0', schema_version: SCHEMA_VERSION,
    retrieved_at: bundle.retrieved_at,
    execution_usable: bundle.execution_usable,
    delivery_mode: deliveryMode,
    session_status: bundle.session_status,
    market_calendar_phase: bundle.market_calendar?.market_calendar_phase ?? null,
    market_calendar: bundle.market_calendar ?? null,
    expected_reference_session_date: bundle.expected_reference_session_date,
    stale_risk: bundle.stale_risk,
    blockers: bundle.blockers || [],
    warnings: bundle.warnings || [],
    data_fingerprint_sha256: bundle.data_fingerprint_sha256,
    strict_market_data_policy: bundle.strict_market_data_policy,
    capabilities: bundle.capabilities,
    upstream: bundle.upstream,
    quality: bundle.quality,
    analytics: {
      history_sessions: bundle.capabilities?.daily_history_sessions ?? 0,
      complete_count: bundle.quality?.analytics_complete_count ?? 0,
      provisional_count: bundle.quality?.analytics_provisional_count ?? 0
    },
    probes: (bundle.stocks || []).filter((r: any) => ['EFIH', 'MASR', 'EGAL'].includes(r.symbol)).map((r: any) => ({
      symbol: r.symbol, last_price: r.close, volume: r.volume,
      change_percent: r.change, current_session: r.current_session,
      update_mode: r.update_mode ?? null
    })),
    ...(snapshotValidation ? { snapshot_validation: snapshotValidation } : {})
  };
}

export default async (req: Request) => {
  if (req.method !== 'GET') return json({ status: 'error', message: 'Method not allowed' }, 405);
  const now = new Date();

  // Normal path: validate the already-warmed trusted snapshot. This keeps
  // diagnostics as a real trust gate without paying for a second full-market
  // upstream fetch before /api/execution-bundle performs the fresh fetch.
  try {
    const snapshot: any = await readSnapshot();
    const validation = validateSnapshot(snapshot, now);
    if (validation.usable) {
      return json(diagnosticPayload(snapshot, 'validated_snapshot_diagnostic', validation));
    }
  } catch { /* Fall through to a fresh diagnostic only when the snapshot gate cannot be used. */ }

  // Recovery path: preserve standalone diagnostics if the warm snapshot is
  // missing, stale, or invalid.
  try {
    const [data, history] = await Promise.all([fetchMarket(null, now), readHistory()]);
    const bundle: any = await buildExecutionBundle(data, { symbols: ['EFIH', 'MASR', 'EGAL'], now, history });
    return json(diagnosticPayload(bundle, 'fresh_diagnostic_recovery'), bundle.execution_usable ? 200 : 503);
  } catch (freshError: any) {
    try {
      const snapshot: any = await readSnapshot();
      const validation = validateSnapshot(snapshot, now);
      return json({
        status: validation.usable ? 'degraded' : 'blocked',
        source_id: SOURCE_ID, version: snapshot?.version ?? null, core_version_expected: CORE_VERSION,
        diagnostics_version: '2.1.0', schema_version: SCHEMA_VERSION,
        execution_usable: validation.usable,
        delivery_mode: 'snapshot_diagnostic_recovery',
        stale_risk: validation.usable ? 'controlled' : 'high',
        blockers: validation.blockers,
        warnings: [`fresh_probe_failed:${String(freshError?.message || freshError)}`],
        snapshot_validation: validation,
        retrieved_at: snapshot?.retrieved_at ?? new Date().toISOString(),
        data_fingerprint_sha256: snapshot?.data_fingerprint_sha256 ?? null,
        session_status: snapshot?.session_status ?? null,
        market_calendar_phase: snapshot?.market_calendar?.market_calendar_phase ?? null,
        market_calendar: snapshot?.market_calendar ?? null,
        expected_reference_session_date: snapshot?.expected_reference_session_date ?? null,
        quality: snapshot?.quality ?? null
      }, validation.usable ? 200 : 503);
    } catch (snapshotError: any) {
      return json({
        status: 'blocked', source_id: SOURCE_ID, core_version_expected: CORE_VERSION,
        diagnostics_version: '2.1.0', schema_version: SCHEMA_VERSION,
        execution_usable: false, stale_risk: 'high',
        blockers: ['fresh_probe_failed', 'snapshot_unavailable'],
        detail: {
          fresh_probe: String(freshError?.message || freshError),
          snapshot: String(snapshotError?.message || snapshotError)
        },
        retrieved_at: new Date().toISOString()
      }, 503);
    }
  }
};

export const config = { path: '/api/diagnostics' };
