import { readFile, writeFile } from 'node:fs/promises';

const OUT='out';
const num=(v:any)=>Number.isFinite(Number(v))?Number(v):null;
const round=(v:number,d=2)=>Number(v.toFixed(d));
const clamp=(v:number,lo=0,hi=10)=>Math.min(hi,Math.max(lo,v));
const BUY_ACTIONS=new Set(['ACCUMULATE','BUY','STRONG_BUY']);
const WAIT_ACTIONS=new Set(['WAIT_ENTRY','WAIT_RISK_REWARD','NO_CHASE','HOLD_WATCH','DEEP_RESEARCH']);
const sym=(v:any)=>String(v||'').trim().toUpperCase();

async function json(path:string){return JSON.parse(await readFile(path,'utf8'));}

const [v6,radar,regime,contract]=await Promise.all([
  json(`${OUT}/decision-intelligence-v6.json`),
  json(`${OUT}/radar.json`),
  json(`${OUT}/market-regime-v6.json`),
  json(`${OUT}/contract.json`)
]);

if(v6?.engine!=='EGX Decision Intelligence'||v6?.version!==6) throw new Error('RECOVERY_ALERT_FAIL:v6_missing');
if(v6?.data_gates?.pass!==true||v6?.data_gates?.execution_usable!==true) throw new Error('RECOVERY_ALERT_FAIL:v6_not_usable');
if(v6?.data_gates?.history_current_session!==true) throw new Error('RECOVERY_ALERT_FAIL:history_not_current');
if(contract?.bridge_gate!=='pass'||contract?.execution_usable!==true) throw new Error('RECOVERY_ALERT_FAIL:bridge_not_usable');

const regimeScore=num(regime?.score)??0;
const breadth=regime?.breadth||{};
const up=num(breadth?.up)??0, down=num(breadth?.down)??0;
const medianChange=num(breadth?.median_change_pct)??0;
const above200=num(breadth?.pct_above_sma200)??0;
const breadthRatio=down>0?up/down:(up>0?10:0);

const panicBlock = regimeScore<2.5 || medianChange<=-3 || breadthRatio<0.20;
const selectiveRisk = !panicBlock && regimeScore<4.5;
const marketState = panicBlock?'PANIC_BLOCK':selectiveRisk?'SELECTIVE_RISK':'NORMAL_RISK';

const radarBySym=new Map((radar?.pre_move_sentinel||[]).map((x:any)=>[sym(x?.symbol),x]));

function qualityScore(c:any){
  const x=c?.components||{};
  return round(clamp(
    (num(x.fundamental_quality)??5)*0.24+
    (num(x.valuation)??5)*0.16+
    (num(x.earnings_quality)??5)*0.12+
    (num(x.catalyst)??5)*0.12+
    (num(x.catalyst_transmission)??5)*0.10+
    (num(x.institutional_intelligence)??5)*0.08+
    (num(x.cycle_relative_strength)??5)*0.08+
    (num(x.entry_quality)??5)*0.05+
    (num(x.risk_reward_proxy)??5)*0.05
  ));
}

function entryState(c:any){
  const px=num(c?.reference_close);
  const zone=c?.execution_plan?.entry_zone;
  if(px==null||!Array.isArray(zone)||zone.length<2) return {state:'NO_ZONE',distance_pct:null,zone_low:null,zone_high:null};
  const lo=num(zone[0]), hi=num(zone[1]);
  if(lo==null||hi==null||lo<=0||hi<=0) return {state:'NO_ZONE',distance_pct:null,zone_low:lo,zone_high:hi};
  if(px>=lo&&px<=hi) return {state:'IN_ZONE',distance_pct:0,zone_low:round(lo),zone_high:round(hi)};
  if(px>hi) return {state:'ABOVE_ZONE',distance_pct:round((px/hi-1)*100),zone_low:round(lo),zone_high:round(hi)};
  return {state:'BELOW_ZONE',distance_pct:round((px/lo-1)*100),zone_low:round(lo),zone_high:round(hi)};
}

function alertFor(c:any){
  const symbol=sym(c?.symbol);
  const x=c?.components||{};
  const q=qualityScore(c);
  const entry=num(x.entry_quality)??0;
  const rr=num(x.risk_reward_proxy)??0;
  const cycle=num(x.cycle_relative_strength)??0;
  const inst=num(x.institutional_intelligence)??0;
  const change=num(c?.market_row?.change)??0;
  const rsSpread=change-medianChange;
  const rv=num(radarBySym.get(symbol)?.relative_volume_10d ?? c?.market_row?.relative_volume_10d) ?? null;
  const e=entryState(c);
  const research=c?.research||{};
  const corpPass=c?.corporate_action?.technical_history_gate===true;
  const verified=research?.sharia_pass===true&&research?.fundamentals_verified===true&&research?.valuation_verified===true&&corpPass;
  // Distinguish a statistical R/R proxy from real reward versus technical downside.
  // If an independently sourced analyst consensus exists, a low payoff must veto buy alerts.
  const price=num(c?.reference_close);
  const invalidation=num(c?.execution_plan?.invalidation);
  const analystTarget=research?.analyst_target_egp==null?null:num(research.analyst_target_egp);
  const downside=price!=null&&invalidation!=null&&price>invalidation?price-invalidation:null;
  const upside=price!=null&&analystTarget!=null?Math.max(0,analystTarget-price):null;
  const consensusRR=downside!=null&&downside>0&&upside!=null?upside/downside:null;
  const consensusRiskBlock=consensusRR!=null&&consensusRR<1.25;
  const fallingKnife=cycle<4 || entry<4.5 || change<=-8;
  const exceptionalRS=verified && q>=8 && entry>=7.5 && rr>=6.5 && inst>=7.5 && cycle>=6.5 && rsSpread>=4 && change>0;
  const buyAuthorized=BUY_ACTIONS.has(String(c?.action||'')) && c?.execution_ready===true && e.state==='IN_ZONE' && q>=7.4 && entry>=6.2 && rr>=6 && cycle>=5 && !fallingKnife && !consensusRiskBlock && (!panicBlock||exceptionalRS);
  const executablePlan=['BUY_ZONE','LIMIT_ON_WEAKNESS'].includes(String(c?.execution_plan?.status||''));
  const nearTrigger=verified && q>=7.4 && rr>=6 && entry>=5.3 && cycle>=5 && !fallingKnife && !consensusRiskBlock &&
    executablePlan && !['NO_CHASE','AVOID','BLOCKED_CORPORATE_ACTION'].includes(String(c?.action||'')) && (
    e.state==='IN_ZONE' || (e.state==='ABOVE_ZONE' && e.distance_pct!=null && e.distance_pct<=2.5)
  );
  let state='WAIT';
  let priority=0;
  let reason='no_current_recovery_trigger';
  if(research?.sharia_verified===true&&research?.sharia_pass!==true){state='BLOCK_SHARIA';reason='sharia_gate_failed';}
  else if(!corpPass){state='BLOCK_CORPORATE_ACTION';reason='technical_history_not_normalized';}
  else if(!verified){state='BLOCKED_UNVERIFIED_EVIDENCE';reason='evidence_incomplete_transaction_not_authorized';}
  else if(consensusRiskBlock){state='BLOCK_VALUATION_RR';priority=72;reason='verified_consensus_upside_insufficient_vs_technical_downside';}
  else if(buyAuthorized){state='BUY_TRIGGER';priority=100;reason=exceptionalRS&&panicBlock?'exceptional_relative_strength_overrides_market_panic':'all_execution_gates_passed';}
  else if(panicBlock){
    if(exceptionalRS){state='PREPARE_ORDER';priority=88;reason='exceptional_relative_strength_but_v6_buy_action_not_yet_confirmed';}
    else if(nearTrigger){state='ARMED_WAIT_MARKET';priority=80;reason='price_and_quality_ready_but_market_panic_gate_blocks_execution';}
    else {state='MARKET_BLOCKED';priority=50;reason='risk_off_panic_gate';}
  } else if(nearTrigger){state='PREPARE_ORDER';priority=85;reason='quality_and_price_near_trigger_waiting_for_v6_buy_confirmation';}
  else if(WAIT_ACTIONS.has(String(c?.action||''))){state='WATCH_REVERSAL';priority=60;reason='strong_candidate_waiting_for_entry_or_cycle_confirmation';}
  const recoveryScore=round(clamp(q*0.45+rr*0.20+entry*0.15+cycle*0.10+inst*0.10)*10);
  return {
    symbol,rank:c?.rank??null,v6_score:c?.score??null,v6_action:c?.action??null,reference_close:num(c?.reference_close),
    state,priority,reason,recovery_score_100:recoveryScore,quality_score_10:q,
    entry_state:e,entry_quality:entry,risk_reward:rr,cycle_strength:cycle,institutional_intelligence:inst,
    valuation_payoff_check:{analyst_target_egp:analystTarget,analyst_target_as_of:research?.analyst_target_as_of??null,
      analyst_target_source:research?.analyst_target_source??null,
      upside_to_consensus_pct:price!=null&&upside!=null?round(upside/price*100):null,
      downside_to_invalidation_pct:price!=null&&downside!=null?round(downside/price*100):null,
      actual_reward_risk_to_consensus:consensusRR!=null?round(consensusRR):null,
      minimum_required:1.25,execution_blocked:consensusRiskBlock,
      note:'Analyst consensus is not intrinsic value; this is a conservative price-only payoff veto, excluding uncertain future dividends.'},
    day_change_pct:round(change),relative_strength_vs_market_median_pct:round(rsSpread),
    falling_knife_risk:fallingKnife,exceptional_relative_strength:exceptionalRS,
    verified:{sharia:research?.sharia_pass===true,fundamentals:research?.fundamentals_verified===true,valuation:research?.valuation_verified===true,corporate_action:corpPass},
    execution_plan:c?.execution_plan||null,
    alert_rules:{
      buy_only_if:['v6_action_is_buy','price_inside_entry_zone','quality_score>=7.4','entry_quality>=6.2','risk_reward_proxy>=6','cycle>=5','not_falling_knife','if_analyst_target_verified_actual_reward_risk>=1.25','market_not_panic_or_exceptional_relative_strength'],
      average_down_rule:'Never average solely because price is below cost basis; require recovery trigger first.'
    }
  };
}

const alerts=(v6?.all_ranked||[]).map(alertFor).sort((a:any,b:any)=>b.priority-a.priority||b.recovery_score_100-a.recovery_score_100||a.rank-b.rank);
const buyNow=alerts.filter((x:any)=>x.state==='BUY_TRIGGER');
const armed=alerts.filter((x:any)=>['PREPARE_ORDER','ARMED_WAIT_MARKET'].includes(x.state));
const verifiedRecovery=alerts.filter((x:any)=>x.verified.sharia&&x.verified.fundamentals&&x.verified.valuation&&x.verified.corporate_action)
  .sort((a:any,b:any)=>b.recovery_score_100-a.recovery_score_100).slice(0,20);
const noAverage=alerts.filter((x:any)=>x.falling_knife_risk||['BLOCK_SHARIA','BLOCK_CORPORATE_ACTION','BLOCKED_UNVERIFIED_EVIDENCE','BLOCK_VALUATION_RR'].includes(x.state)).slice(0,60);

const packet={
  engine:'EGX Capital Recovery Alert Engine',version:1,generated_at:new Date().toISOString(),reference_session:v6.reference_session,
  objective:'Recover capital through verified quality and timed entries, not indiscriminate averaging down.',
  market_gate:{
    state:marketState,regime_score:regimeScore,position_size_multiplier:regime?.position_size_multiplier??null,
    breadth:{up,down,up_down_ratio:round(breadthRatio,3),median_change_pct:medianChange,pct_above_sma200:above200},
    new_buy_orders_allowed:buyNow.length>0,
    rule:panicBlock?'No active buy orders unless a fully verified exceptional-relative-strength candidate also receives a V6 buy action.':'Selective execution permitted only through per-stock gates.'
  },
  summary:{buy_triggers:buyNow.length,armed_waiting:armed.length,verified_recovery_candidates:verifiedRecovery.length,total_scanned:alerts.length},
  buy_triggers:buyNow.slice(0,12),
  armed_waiting:armed.slice(0,20),
  verified_recovery_ranking:verifiedRecovery,
  no_average_down_watch:noAverage,
  all_alerts:alerts,
  methodology:{
    fail_closed:true,portfolio_cost_basis_not_used_in_public_engine:true,
    price_alert_alone_never_authorizes_trade:true,
    average_down_requires_quality_and_reversal_confirmation:true,
    panic_market_gate:true,exceptional_relative_strength_override_requires_v6_buy_action:true
  }
};
await writeFile(`${OUT}/capital-recovery-alerts-v1.json`,JSON.stringify(packet,null,2));
console.log(JSON.stringify({engine:packet.engine,session:packet.reference_session,market_state:marketState,buy_triggers:buyNow.length,armed:armed.length,top_verified:verifiedRecovery.slice(0,5).map((x:any)=>[x.symbol,x.recovery_score_100,x.state])}));
