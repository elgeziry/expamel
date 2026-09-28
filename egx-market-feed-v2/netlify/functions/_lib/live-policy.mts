import { marketCalendar } from './access.mts';

export function enforceLiveExecutionPolicy(bundle: any, now = new Date()) {
  const calendar = bundle?.market_calendar ?? marketCalendar(now);
  const livePhase = ['auction', 'continuous'].includes(calendar?.market_calendar_phase);
  const blockers = new Set<string>(bundle?.blockers || []);

  if (livePhase) {
    if (bundle?.session_status !== 'continuous') blockers.add('live_clock_without_live_scanner_session');
    if (bundle?.capabilities?.update_mode !== true) blockers.add('update_mode_unavailable_during_live_session');
    if (bundle?.expected_reference_session_date !== calendar?.expected_reference_session_date) {
      blockers.add('live_session_date_mismatch');
    }
    const ts = bundle?.retrieved_at ? new Date(bundle.retrieved_at).getTime() : NaN;
    const ageSeconds = Number.isFinite(ts) ? (now.getTime() - ts) / 1000 : Infinity;
    if (!Number.isFinite(ageSeconds) || ageSeconds < -60) blockers.add('invalid_live_retrieval_time');
    if (ageSeconds > 600) blockers.add('live_data_older_than_10_minutes');
  }

  bundle.blockers = [...blockers];
  if (bundle.blockers.length) {
    bundle.execution_usable = false;
    bundle.status = 'blocked';
    bundle.stale_risk = 'high';
  }
  bundle.live_policy = {
    version: 'v4-fail-closed-10m',
    live_phase: livePhase,
    quote_timestamp_available: false,
    freshness_semantics: 'retrieval_age_plus_session_consistency_not_exchange_quote_age',
    official_holiday_calendar_verified: false,
    holiday_safety_mode: 'fail_closed_when_market_clock_and_scanner_session_disagree'
  };
  return bundle;
}

export function enforceLiveSnapshotPolicy(snapshot: any, validation: any, now = new Date()) {
  const calendar = marketCalendar(now);
  const livePhase = ['auction', 'continuous'].includes(calendar.market_calendar_phase);
  const blockers = new Set<string>(validation?.blockers || []);

  if (livePhase) {
    if (snapshot?.session_status !== 'continuous') blockers.add('live_clock_without_live_scanner_session');
    if (snapshot?.capabilities?.update_mode !== true) blockers.add('update_mode_unavailable_during_live_session');
    if (snapshot?.expected_reference_session_date !== calendar.expected_reference_session_date) {
      blockers.add('live_session_date_mismatch');
    }
  }

  return {
    ...validation,
    usable: blockers.size === 0 && snapshot?.execution_usable === true,
    blockers: [...blockers],
    live_policy: 'v4-fail-closed-10m'
  };
}
