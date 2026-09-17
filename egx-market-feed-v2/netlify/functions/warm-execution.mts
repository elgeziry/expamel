import { fetchMarket } from './api.mts';
import { buildExecutionBundle, marketCalendar, readHistory, updateHistory, writeSnapshot } from './_lib/access.mts';

export default async () => {
  const now = new Date();
  const calendar = marketCalendar(now);
  if (!['auction', 'continuous', 'postclose'].includes(calendar.market_calendar_phase)) return;
  if (calendar.market_calendar_phase === 'postclose') {
    const [hour, minute] = calendar.cairo_time.split(':').map(Number);
    if (hour * 60 + minute > 885) return;
  }
  const [data, history] = await Promise.all([fetchMarket(null, now), readHistory()]);
  const bundle: any = await buildExecutionBundle(data, { now, history });
  bundle.delivery_mode = 'scheduled_fresh';
  if (bundle.execution_usable) await Promise.all([writeSnapshot(bundle), updateHistory(data.rows, now)]);
};

// Netlify cron uses UTC. 06:00-12:45 UTC covers the EGX auction, continuous
// session and the short post-close buffer across Cairo DST and winter time.
// The in-function marketCalendar gate remains authoritative and exits early
// outside the actual Egyptian market window.
export const config = { schedule: '*/15 6-12 * * 0-4' };
