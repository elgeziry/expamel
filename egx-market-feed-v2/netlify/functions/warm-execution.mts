import { fetchMarket } from './api.mts';
import { buildExecutionBundle, marketCalendar, readHistory, updateHistory, writeSnapshot } from './_lib/access.mts';
import { enforceLiveExecutionPolicy } from './_lib/live-policy.mts';

export default async () => {
  const now = new Date();
  const calendar = marketCalendar(now);
  if (!['auction', 'continuous', 'postclose'].includes(calendar.market_calendar_phase)) return;
  if (calendar.market_calendar_phase === 'postclose') {
    const [hour, minute] = calendar.cairo_time.split(':').map(Number);
    if (hour * 60 + minute > 885) return;
  }
  const [data, history] = await Promise.all([fetchMarket(null, now), readHistory()]);
  const bundle: any = enforceLiveExecutionPolicy(await buildExecutionBundle(data, { now, history }), now);
  bundle.delivery_mode = 'scheduled_fresh_v4';
  if (bundle.execution_usable) await Promise.all([writeSnapshot(bundle), updateHistory(data.rows, now)]);
};

// Netlify cron uses UTC. 06:00-12:45 UTC covers the EGX auction, continuous
// session and the short post-close buffer across Cairo DST and winter time.
// Five-minute warming keeps the canonical snapshot inside the 10-minute live gate.
// The in-function marketCalendar + scanner consistency gates are fail-closed.
export const config = { schedule: '*/5 6-12 * * 0-4' };
