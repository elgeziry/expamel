const DEFAULT_ORIGINS = [
  'https://egx-market-feed-v2.netlify.app',
  'https://master--egx-market-feed-v2.netlify.app'
];

const timeout = (ms) => AbortSignal.timeout(ms);

function validPayload(data) {
  return data?.source_id === 'egx-market-feed-v2'
    && data?.version === '7.2.0'
    && /^[a-f0-9]{64}$/.test(data?.data_fingerprint_sha256 || '');
}

async function jsonFetch(url, ms) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`, {
    cache: 'no-store', signal: timeout(ms), headers: { accept: 'application/json' }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`${url}: HTTP ${res.status}`);
  return data;
}

async function reachable(origin) {
  const res = await fetch(`${origin}/ping.txt?ts=${Date.now()}`, {
    cache: 'no-store', signal: timeout(3500)
  });
  if (!res.ok || !(await res.text()).startsWith('EGX-V2-ONLINE')) throw new Error(`${origin}: ping failed`);
  return origin;
}

export async function fetchExecutionBundle({ origins = DEFAULT_ORIGINS, symbols = [] } = {}) {
  const unique = [...new Set(origins.map(x => x.replace(/\/$/, '')))];
  const probes = await Promise.allSettled(unique.map(reachable));
  const ready = probes.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!ready.length) throw new AggregateError(
    probes.filter(x => x.status === 'rejected').map(x => x.reason),
    'No hostname for the Netlify V2 deployment is reachable'
  );

  const errors = [];
  for (const origin of ready) {
    try {
      const snapshot = await jsonFetch(`${origin}/data/latest-execution.json`, 6500);
      if (validPayload(snapshot) && snapshot.execution_usable === true) return { origin, data: snapshot };
    } catch (e) { errors.push(e); }
    try {
      const query = symbols.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : '';
      const fresh = await jsonFetch(`${origin}/api/execution-bundle${query}`, 25000);
      if (!validPayload(fresh)) throw new Error(`${origin}: identity or fingerprint validation failed`);
      if (fresh.execution_usable !== true) throw new Error(`${origin}: execution gate is closed`);
      return { origin, data: fresh };
    } catch (e) { errors.push(e); }
  }
  throw new AggregateError(errors, 'Netlify V2 responded, but no execution-safe payload was available');
}

export { DEFAULT_ORIGINS };
