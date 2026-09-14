import { readSnapshot, validateSnapshot } from './_lib/access.mts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async (req: Request) => {
  if (req.method !== 'GET') return json({ status: 'error', message: 'Method not allowed' }, 405);
  try {
    const snapshot: any = await readSnapshot();
    if (!snapshot) return json({ status: 'blocked', execution_usable: false, blockers: ['snapshot_missing'] }, 404);
    const validation = validateSnapshot(snapshot);
    return json({
      ...snapshot,
      delivery_mode: 'validated_snapshot',
      execution_usable: validation.usable,
      stale_risk: validation.usable ? 'controlled' : 'high',
      snapshot_validation: validation
    }, validation.usable ? 200 : 503);
  } catch (e: any) {
    return json({
      status: 'blocked', execution_usable: false, blockers: ['snapshot_unavailable'],
      detail: String(e?.message || e), retrieved_at: new Date().toISOString()
    }, 503);
  }
};

export const config = { path: '/data/latest-execution.json' };
