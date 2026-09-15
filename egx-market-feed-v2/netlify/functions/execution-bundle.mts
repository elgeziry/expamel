import { fetchMarket } from './api.mts';
import {
  buildExecutionBundle, normalizeSymbols, readHistory, readSnapshot, updateHistory, validateSnapshot, writeSnapshot
} from './_lib/access.mts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async (req: Request) => {
  if (req.method !== 'GET') return json({ status: 'error', message: 'Method not allowed' }, 405);
  const url = new URL(req.url);
  const rawSymbols = url.searchParams.get('symbols');
  const symbols = normalizeSymbols(rawSymbols ? rawSymbols.split(',') : null);
  try {
    const now = new Date();
    const [data, history] = await Promise.all([fetchMarket(null, now), readHistory()]);
    const bundle: any = await buildExecutionBundle(data, { symbols, now, history });
    bundle.delivery_mode = 'fresh';
    if (!bundle.execution_usable) {
      try {
        const snapshot: any = await readSnapshot();
        const validation = validateSnapshot(snapshot);
        if (validation.usable) {
          return json({
            ...snapshot,
            delivery_mode: 'validated_snapshot_after_fresh_gate_closed',
            execution_usable: true,
            stale_risk: 'controlled',
            warnings: [...new Set([...(snapshot?.warnings || []), `fresh_gate_closed:${bundle.blockers.join(',')}`])],
            snapshot_validation: validation
          });
        }
      } catch { /* Return the fresh blocked result below. */ }
      bundle.warnings.push('snapshot_not_updated_execution_gate_closed');
      return json(bundle, 503);
    }
    try {
      await Promise.all([writeSnapshot(bundle), updateHistory(data.rows, now)]);
    } catch (snapshotError: any) {
      bundle.warnings.push(`persistence_write_failed:${String(snapshotError?.message || snapshotError)}`);
      if (bundle.status === 'ok') bundle.status = 'degraded';
    }
    return json(bundle);
  } catch (freshError: any) {
    try {
      const snapshot: any = await readSnapshot();
      const validation = validateSnapshot(snapshot);
      return json({
        ...snapshot,
        delivery_mode: 'validated_snapshot',
        execution_usable: validation.usable,
        stale_risk: validation.usable ? 'controlled' : 'high',
        blockers: [...new Set([...(snapshot?.blockers || []), ...validation.blockers])],
        warnings: [...new Set([...(snapshot?.warnings || []), `fresh_fetch_failed:${String(freshError?.message || freshError)}`])],
        snapshot_validation: validation
      }, validation.usable ? 200 : 503);
    } catch (snapshotError: any) {
      return json({
        status: 'blocked', execution_usable: false, delivery_mode: 'unavailable', stale_risk: 'high',
        blockers: ['fresh_fetch_failed', 'snapshot_unavailable'],
        detail: {
          fresh_fetch: String(freshError?.message || freshError),
          snapshot: String(snapshotError?.message || snapshotError)
        },
        retrieved_at: new Date().toISOString()
      }, 503);
    }
  }
};

export const config = { path: '/api/execution-bundle' };
