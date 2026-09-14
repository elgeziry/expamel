import { fetchMarket } from './api.mts';
import { buildExecutionBundle, marketCalendar, writeSnapshot } from './_lib/access.mts';

export default async () => {
  const now = new Date();
  const calendar = marketCalendar(now);
  if (!['auction', 'continuous', 'postclose'].includes(calendar.market_calendar_phase)) return;
  if (calendar.market_calendar_phase === 'postclose') {
    const [hour, minute] = calendar.cairo_time.split(':').map(Number);
    if (hour * 60 + minute > 885) return;
  }
  const data = await fetchMarket();
  const bundle: any = await buildExecutionBundle(data, { now });
  bundle.delivery_mode = 'scheduled_fresh';
  if (bundle.execution_usable) await writeSnapshot(bundle);
};

export const config = { schedule: '*/15 * * * 0-4' };
