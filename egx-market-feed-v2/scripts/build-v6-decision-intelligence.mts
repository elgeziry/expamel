import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'out';
const num = (v:any) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v:number, lo=0, hi=10) => Math.min(hi, Math.max(lo, v));
const round = (v:number, d=2) => Number(v.toFixed(d));
const sym = (r:any) => String(r?.symbol || r?.name || '').toUpperCase();
const avg = (xs:(number|null)[]) => { const a=xs.filter((x):x is number=>x!=null&&Number.isFinite(x)); return a.length?a.reduce((s,x)=>s+x,0)/a.length:null; };
const median = (xs:number[]) => { const a=xs.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const value = (r:any) => num(r?.value_session_adjusted ?? r?.value ?? ((num(r?.close)||0)*(num(r?.volume)||0))) || 0;

async function jsonOr(path:string, fallback:any){ try{return JSON.parse(await readFile(path,'utf8'));}catch{return fallback;} }
function ten(v:any, fallback=5){ const n=num(v); return n==null?fallback:clamp(n); }
function liquidityScore(r:any){ const ds=num(r?.decision_support?.liquidity_score); if(ds!=null)return clamp(ds); const v=value(r); return v>=250e6?10:v>=100e6?9:v>=40e6?7.5:v>=10e6?6:v>=2e6?4:2; }
function trendScore(r:any){ const t=String(r?.long_term_trend||''); if(t==='long_term_uptrend')return 8.5; if(t==='decision_zone_near_sma200')return 6.8; if(t.startsWith('short_term_positive'))return 6; if(t==='below_sma200')return 3; return 5; }
function chasePenalty(r:any){ const ch=String(r?.decision_support?.chase_risk||'low'); const c=num(r?.change)||0; let p=ch==='high'?2.2:ch==='medium'?0.8:0; if(c>=8)p+=0.8; if(c>=12)p+=1.2; if(c>=18)p+=1.2; return Math.min(4.5,p); }
function peScore(pe:number|null){ if(pe==null||pe<=0)return 5; if(pe<=8)return 8.5; if(pe<=14)return 8; if(pe<=20)return 7; if(pe<=28)return 5.5; if(pe<=40)return 4; return 2.5; }
function targetScore(up:number|null){ if(up==null)return 5; if(up>=35)return 9.5; if(up>=25)return 8.5; if(up>=15)return 7.5; if(up>=7)return 6.5; if(up>=0)return 5; if(up>=-10)return 3.5; return 2; }
function growthScore(r:any){ const fy=num(r?.eps_diluted_growth_percent_fy), fq=num(r?.eps_diluted_growth_percent_fq); const g=avg([fy,fq]); if(g==null)return 5; if(g>=35)return 9.5; if(g>=20)return 8.5; if(g>=10)return 7.5; if(g>=0)return 6; if(g>=-10)return 4.5; if(g>=-25)return 3; return 1.5; }
function sectorModel(r:any){ const d=String(r?.description||'').toLowerCase(); if(/bank|banque/.test(d))return 'bank_proxy'; if(/housing|real estate|development|properties/.test(d))return 'real_estate_proxy'; if(/telecom/.test(d))return 'telecom_proxy'; if(/fertil|petrochem|chemical/.test(d))return 'commodity_industrial_proxy'; return 'generic_equity_proxy'; }
function quantFundamental(r:any){
  const g=growthScore(r); const fcf=num(r?.free_cash_flow_ttm); const de=num(r?.debt_to_equity_fq); const model=sectorModel(r);
  let cash=fcf==null?5:fcf>0?7.5:3.5; let leverage=5;
  if(model==='bank_proxy') leverage=5; else if(de!=null) leverage=de<=0.6?8:de<=1.2?6.5:de<=2?5:de<=3?3.5:2;
  return round(clamp(g*0.5+cash*0.25+leverage*0.25));
}
function quantValuation(r:any){ const pe=peScore(num(r?.price_earnings_current)); const up=targetScore(num(r?.upside_to_analyst_target_pct)); return round(clamp(pe*0.55+up*0.45)); }
function earningsQuality(r:any){ const g=growthScore(r); const fcf=num(r?.free_cash_flow_ttm); let q=g; if(fcf!=null) q=clamp(q+(fcf>0?0.8:-1.0)); return round(q); }
function institutionalProxy(r:any){ const rv=Math.min(10,Math.max(0,(num(r?.relative_volume_10d??r?.relative_volume_10d_calc)||1)*3)); const demand=ten(r?.demand_confirmation_score); const liq=liquidityScore(r); const loc=clamp((num(r?.close_location_in_day)??0.5)*10); const cap=num(r?.market_cap_basic)||0; const size=cap>=100e9?10:cap>=30e9?8:cap>=10e9?7:cap>=2e9?5:3; return round(clamp(rv*.28+demand*.27+liq*.22+loc*.13+size*.10)); }
function discoveryScore(r:any){ const setup=ten(r?.decision_support?.setup_score); const demand=ten(r?.demand_confirmation_score); const liq=liquidityScore(r); const rv=Math.min(10,Math.max(0,(num(r?.relative_volume_10d??r?.relative_volume_10d_calc)||1)*3)); const trend=trendScore(r); const loc=clamp((num(r?.close_location_in_day)??0.5)*10); return round(clamp(setup*.28+demand*.22+liq*.14+rv*.14+trend*.14+loc*.08-chasePenalty(r))); }
function entryQuality(r:any, cycle:number){ const setup=ten(r?.decision_support?.setup_score); const demand=ten(r?.demand_confirmation_score); const loc=clamp((num(r?.close_location_in_day)??0.5)*10); const trend=trendScore(r); return round(clamp(setup*.36+demand*.22+loc*.12+trend*.15+cycle*.15-chasePenalty(r)*1.25)); }
function rrProxy(r:any){ const up=targetScore(num(r?.upside_to_analyst_target_pct)); const close=num(r?.close), sma50=num(r?.SMA50??r?.EMA50); let support=5; if(close&&sma50&&sma50>0){ const d=((close/sma50)-1)*100; support=d<=3?8:d<=8?7:d<=15?5.5:d<=25?4:2.5; } return round(clamp(up*.55+support*.45-chasePenalty(r))); }
function catalystProxy(r:any){ const event=r?.event_risk?.next_event; const up=num(r?.upside_to_analyst_target_pct); let s=5; if(event?.type==='earnings')s+=0.6; if(up!=null&&up>15)s+=0.7; if((num(r?.['Perf.W'])||0)>5&&(num(r?.['Perf.1M'])||0)>8)s+=0.5; return round(clamp(s)); }
function sourceCount(x:any){ return Array.isArray(x?.sources)?x.sources.length:0; }
function shariaStatus(x:any){ return String(x?.sharia_status||'pending_verification').toLowerCase(); }
function verifiedResearch(x:any){
  const sh=shariaStatus(x); const shariaVerified=x?.sharia_verified===true; const shariaPass=shariaVerified&&['compliant','purification_required'].includes(sh);
  return { sharia_status:sh, sharia_verified:shariaVerified, sharia_pass:shariaPass, fundamentals_verified:x?.fundamentals_verified===true, valuation_verified:x?.valuation_verified===true, source_count:sourceCount(x), research_as_of:x?.updated_at||x?.fundamentals_as_of||x?.valuation_as_of||x?.sharia_as_of||null };
}
function marketRegime(stocks:any[]){
  const changes=stocks.map(x=>num(x?.change)).filter((x):x is number=>x!=null); const up=changes.filter(x=>x>0.05).length, down=changes.filter(x=>x<-0.05).length, flat=changes.length-up-down;
  const med=median(changes)||0; const above=stocks.filter(x=>{const c=num(x?.close),s=num(x?.SMA200);return c!=null&&s!=null&&c>=s;}).length; const withSma=stocks.filter(x=>num(x?.close)!=null&&num(x?.SMA200)!=null).length;
  const abovePct=withSma?above/withSma*100:50; const breadth=changes.length?(up-down)/changes.length:0; const highChase=stocks.filter(x=>String(x?.decision_support?.chase_risk)==='high').length;
  const score=clamp(5 + breadth*3.2 + med*0.22 + (abovePct-50)*0.025 - (highChase/Math.max(1,stocks.length))*1.2);
  const label=score>=7.5?'risk_on':score>=6.1?'selective_bull':score>=4.7?'neutral_rotation':score>=3.3?'weak':'risk_off';
  const sizeMult=label==='risk_on'?1:label==='selective_bull'?0.85:label==='neutral_rotation'?0.70:label==='weak'?0.50:0.25;
  return {score:round(score),label,position_size_multiplier:sizeMult,breadth:{up,down,flat,up_minus_down:up-down,median_change_pct:round(med),pct_above_sma200:round(abovePct),high_chase_count:highChase},turnover_egp:round(stocks.reduce((s,x)=>s+value(x),0),0),external_macro_context:{status:'not_supplied_by_market_feed',rule:'final human/assistant decision may overlay verified macro and geopolitical context; repository engine never invents it'}};
}
function historySeries(history:any, symbol:string){ const out:any[]=[]; for(const sess of history?.sessions||[]){ const row=(sess?.stocks||[]).find((x:any)=>sym(x)===symbol); const c=num(row?.close); if(c!=null)out.push({date:sess?.date,close:c,source:row?.history_source||sess?.source||null}); } return out; }
function corporateAudit(history:any, symbol:string, research:any){
  const series=historySeries(history,symbol).slice(-30); const anomalies:any[]=[];
  for(let i=1;i<series.length;i++){ const p=series[i-1].close, c=series[i].close; if(!p||!c)continue; const ratio=c/p; if(ratio>=1.45||ratio<=0.69) anomalies.push({date:series[i].date,previous_close:p,close:c,ratio:round(ratio,4)}); }
  const verifiedAdjusted=research?.corporate_action_adjusted===true; const suspected=anomalies.length>0&&!verifiedAdjusted;
  return {status:suspected?'suspected_unadjusted_event':verifiedAdjusted?'verified_adjusted':'no_large_gap_detected',technical_history_gate:!suspected,anomalies,lookback_sessions:series.length,verified_adjustment_override:verifiedAdjusted};
}
function redTeam(r:any, research:any, corp:any, cycle:any){ const flags:string[]=[]; const pe=num(r?.price_earnings_current), fcf=num(r?.free_cash_flow_ttm), de=num(r?.debt_to_equity_fq), g=avg([num(r?.eps_diluted_growth_percent_fy),num(r?.eps_diluted_growth_percent_fq)]); const model=sectorModel(r); if(fcf!=null&&fcf<0)flags.push('negative_free_cash_flow_ttm'); if(model!=='bank_proxy'&&de!=null&&de>2.5)flags.push('high_leverage_proxy'); if(g!=null&&g<-15)flags.push('earnings_contraction'); if(pe!=null&&pe>40)flags.push('high_pe_proxy'); if((num(r?.upside_to_analyst_target_pct)||0)<-8)flags.push('price_above_analyst_target_proxy'); if(String(r?.decision_support?.chase_risk)==='high')flags.push('high_chase_risk'); if(corp?.technical_history_gate===false)flags.push('suspected_corporate_action_distortion'); if((cycle?.confidence_pct||0)<85)flags.push('history_confidence_below_85'); if(research?.sharia_verified!==true)flags.push('sharia_not_verified'); if(research?.fundamentals_verified!==true)flags.push('fundamentals_not_verified'); if(research?.valuation_verified!==true)flags.push('valuation_not_verified'); if(Array.isArray(research?.risk_flags))flags.push(...research.risk_flags.map(String)); return [...new Set(flags)]; }
function penaltyFromFlags(flags:string[]){ let p=0; for(const f of flags){ if(f==='suspected_corporate_action_distortion')p+=18; else if(f==='high_chase_risk')p+=9; else if(['negative_free_cash_flow_ttm','high_leverage_proxy','earnings_contraction','high_pe_proxy','price_above_analyst_target_proxy'].includes(f))p+=3; } return Math.min(30,p); }
function decisionFor(x:any, regime:any){
  if(x.research.sharia_verified&&x.research.sharia_status==='non_compliant')return 'AVOID';
  if(!x.research.sharia_verified)return 'RESEARCH_SHARIA';
  if(!x.research.fundamentals_verified||!x.research.valuation_verified)return 'DEEP_RESEARCH';
  if(!x.corporate_action.technical_history_gate)return 'BLOCKED_CORPORATE_ACTION';
  if(String(x.market_row?.decision_support?.chase_risk)==='high'||x.entry_quality<5)return 'NO_CHASE';
  if(!x.execution_ready)return 'WATCH';
  if(x.score>=90&&regime.label!=='risk_off'&&regime.label!=='weak')return 'STRONG_BUY';
  if(x.score>=80)return 'BUY';
  if(x.score>=70)return 'ACCUMULATE';
  if(x.score>=60)return 'HOLD_WATCH';
  return 'AVOID';
}

const [universe,radar,history,contract,health,capital,execution,researchFile]=await Promise.all([
  jsonOr(OUT+'/universe.json',{}),jsonOr(OUT+'/radar.json',{}),jsonOr(OUT+'/history.json',{}),jsonOr(OUT+'/contract.json',{}),jsonOr(OUT+'/health.json',{}),jsonOr(OUT+'/capital-allocation.json',{}),jsonOr(OUT+'/execution-engine.json',{}),jsonOr('research-overrides.json',{})
]);
if(contract?.bridge_gate!=='pass'||contract?.execution_usable!==true)throw new Error('V6_FAIL_CLOSED:bridge_not_execution_usable');
const stocks:any[]=universe?.stocks||[];
const universeTarget=Number(universe?.roster_target_count||296);
const quarantinedSymbols=Array.isArray(universe?.quarantined_symbols)?universe.quarantined_symbols:[];
const universeOperational=universe?.universe_operational===true||stocks.length>=universeTarget;
if(!universeOperational)throw new Error('V6_FAIL_CLOSED:universe_not_operational');
if(stocks.length+quarantinedSymbols.length<universeTarget)throw new Error('V6_FAIL_CLOSED:universe_target_not_accounted');
if(history?.schema!=='egx-session-history-v4'||(history?.sessions||[]).length<6)throw new Error('V6_FAIL_CLOSED:history_not_usable');
if(radar?.radar_version!==2)throw new Error('V6_FAIL_CLOSED:radar_v2_missing');
const regime=marketRegime(stocks); const cycleMap=new Map((history?.cycle_quality||[]).map((x:any)=>[sym(x),x])); const execMap=new Map((execution?.ranked||[]).map((x:any)=>[sym(x),x?.execution_plan||null])); const researchMap=researchFile?.stocks||{};
const rows=stocks.filter(x=>sym(x)).map((r:any)=>{
  const symbol=sym(r), vr=researchMap[symbol]||{}, research=verifiedResearch(vr), cycle:any=cycleMap.get(symbol)||{}, corp=corporateAudit(history,symbol,vr);
  const fundamental=vr?.fundamentals_verified===true?ten(vr?.fundamental_score):quantFundamental(r); const valuation=vr?.valuation_verified===true?ten(vr?.valuation_score):quantValuation(r); const earnings=ten(vr?.earnings_quality_score,earningsQuality(r)); const catalyst=ten(vr?.catalyst_score,catalystProxy(r)); const transmission=ten(vr?.catalyst_transmission_score,clamp(catalyst*.72+liquidityScore(r)*.18+trendScore(r)*.10)); const institutional=ten(vr?.institutional_flow_score,institutionalProxy(r)); const cycleScore=ten(cycle?.score,trendScore(r)); const entry=entryQuality(r,cycleScore); const liq=liquidityScore(r); const portfolioFit=5; const disc=discoveryScore(r); const rr=rrProxy(r);
  const components={fundamental_quality:round(fundamental),valuation:round(valuation),earnings_quality:round(earnings),catalyst:round(catalyst),catalyst_transmission:round(transmission),institutional_intelligence:round(institutional),cycle_relative_strength:round(cycleScore),entry_quality:round(entry),liquidity:round(liq),portfolio_fit_neutral:portfolioFit,risk_reward_proxy:round(rr),discovery:disc};
  const weighted=(fundamental/10)*18+(valuation/10)*14+(earnings/10)*8+(catalyst/10)*12+(transmission/10)*8+(institutional/10)*10+(cycleScore/10)*8+(entry/10)*10+(liq/10)*4+(portfolioFit/10)*8;
  const flags=redTeam(r,vr,corp,cycle); const penalty=penaltyFromFlags(flags); const score=Math.max(0,Math.min(100,weighted-penalty));
  const executionReady=contract.execution_usable===true&&research.sharia_pass&&research.fundamentals_verified&&research.valuation_verified&&corp.technical_history_gate&&['complete','usable_provisional'].includes(String(cycle?.status||''));
  const evidenceCoverage=Math.round(((research.sharia_verified?1:0)+(research.fundamentals_verified?1:0)+(research.valuation_verified?1:0)+(research.source_count>=2?1:0)+(cycle?.confidence_pct>=85?1:0)+(corp.technical_history_gate?1:0))/6*100);
  const capitalEfficiency=round(clamp((score/10)*.55+rr*.20+liq*.15+entry*.10)*regime.position_size_multiplier);
  const base:any={symbol,name:r?.description||r?.name||symbol,reference_close:num(r?.close),score:round(score),pre_penalty_score:round(weighted),red_team_penalty:penalty,discovery_score:disc,capital_efficiency_score:capitalEfficiency,components,research:{...research,verified_fundamental_score:vr?.fundamentals_verified===true?num(vr?.fundamental_score):null,verified_valuation_score:vr?.valuation_verified===true?num(vr?.valuation_score):null,method:research.fundamentals_verified||research.valuation_verified?'verified_override_plus_market_quant':'market_quant_research_priority_only'},corporate_action:corp,history_cycle:{status:cycle?.status||'missing',confidence_pct:cycle?.confidence_pct??0,score:cycle?.score??null,sessions_available:cycle?.sessions_available??0,provenance:cycle?.provenance??null},institutional_confidence:vr?.institutional_flow_verified===true?'confirmed':'proxy_only',portfolio_overlay:{required:true,score_used:portfolioFit,note:'Private holdings/cash are intentionally not stored in this public repository.'},red_team_flags:flags,evidence_coverage_pct:evidenceCoverage,execution_ready:executionReady,execution_plan:execMap.get(symbol)||null,market_row:{change:num(r?.change),liquidity_score:liq,decision_support:r?.decision_support||null}};
  base.entry_quality=entry; base.action=decisionFor(base,regime); delete base.entry_quality; return base;
}).sort((a:any,b:any)=>b.score-a.score||b.capital_efficiency_score-a.capital_efficiency_score);
rows.forEach((x:any,i:number)=>x.rank=i+1);
const executable=rows.filter((x:any)=>x.execution_ready&&['STRONG_BUY','BUY','ACCUMULATE'].includes(x.action));
const researchQueue=rows.filter((x:any)=>!x.execution_ready&&x.action!=='AVOID').sort((a:any,b:any)=>b.discovery_score-a.discovery_score||b.score-a.score).slice(0,30).map((x:any,i:number)=>({priority:i+1,symbol:x.symbol,score:x.score,discovery_score:x.discovery_score,action:x.action,missing:[...(!x.research.sharia_verified?['sharia']:[]),...(!x.research.fundamentals_verified?['fundamentals']:[]),...(!x.research.valuation_verified?['valuation']:[])],red_team_flags:x.red_team_flags.slice(0,6),why_now:{cycle:x.components.cycle_relative_strength,institutional_proxy:x.components.institutional_intelligence,entry:x.components.entry_quality,rr_proxy:x.components.risk_reward_proxy}}));
const replacements=rows.filter((x:any)=>x.action!=='AVOID'&&x.corporate_action.technical_history_gate).slice(0,20).map((x:any,i:number)=>({rank:i+1,symbol:x.symbol,action:x.action,score:x.score,capital_efficiency_score:x.capital_efficiency_score,execution_ready:x.execution_ready,portfolio_overlay_required:true,rule:'Compare against each existing holding after loading private portfolio state; never auto-sell from public-repo data alone.'}));
const corpAudit={engine:'EGX Corporate Action Anomaly Guard',version:1,generated_at:new Date().toISOString(),reference_session:contract?.expected_reference_session_date||null,method:'detect >45% up-gap or >31% down-gap across retained closes unless explicitly verified adjusted',flagged:rows.filter((x:any)=>!x.corporate_action.technical_history_gate).map((x:any)=>({symbol:x.symbol,...x.corporate_action})),scanned:rows.length,universe_target:universeTarget,quarantined_unscanned:quarantinedSymbols,full_universe_accounted:rows.length+quarantinedSymbols.length>=universeTarget};
const packet={engine:'EGX Decision Intelligence',version:6,generated_at:new Date().toISOString(),reference_session:contract?.expected_reference_session_date||null,architecture:['V5_resilient_data_core','corporate_action_anomaly_guard','market_regime_engine','full_296_discovery','deep_research_confidence_gates','sharia_fail_closed','catalyst_transmission','institutional_intelligence','red_team','master_ranking','portfolio_replacement_challengers','capital_efficiency','execution_overlay','performance_learning'],data_gates:{bridge_gate:contract?.bridge_gate,execution_usable:contract?.execution_usable===true,current_universe_count:stocks.length,universe_target:universeTarget,universe_operational:universeOperational,coverage_mode:universe?.quality?.coverage_mode||'complete',quarantined_symbols:quarantinedSymbols,history_sessions:(history?.sessions||[]).length,radar_v2:radar?.radar_version===2,pass:true},market_regime:regime,methodology:{full_universe_reaches_master_ranking:true,universe_target:universeTarget,missing_symbols_quarantined_not_fabricated:true,sharia_fail_closed:true,unknown_research_never_becomes_execution:true,institutional_proxy_never_claimed_as_confirmed:true,corporate_action_anomaly_can_block_technical_execution:true,private_portfolio_never_published:true,external_macro_not_invented:true,score_weights_pct:{fundamental_quality:18,valuation:14,earnings_quality:8,catalyst:12,catalyst_transmission:8,institutional_intelligence:10,cycle_relative_strength:8,entry_quality:10,liquidity:4,portfolio_fit:8}},health:{source_health:health?.status||null,full_universe_ranked:rows.length,full_universe_accounted:rows.length+quarantinedSymbols.length>=universeTarget,quarantined_count:quarantinedSymbols.length,executable_count:executable.length,research_queue_count:researchQueue.length,corporate_action_flags:corpAudit.flagged.length,v5_capital_engine_seen:capital?.version===3,v5_execution_engine_seen:execution?.version===1},top_opportunities:rows.slice(0,25),executable_queue:executable.slice(0,12),research_queue:researchQueue,replacement_challengers:replacements,all_ranked:rows,quarantined_unranked:quarantinedSymbols,note:'V6 ranks every fresh market row and explicitly quarantines any missing target symbol without fabricating a price. Execution remains fail-closed until Sharia, fundamentals and valuation are explicitly verified; market-only metrics can prioritize research but cannot authorize a trade.'};
await Promise.all([
  writeFile(OUT+'/decision-intelligence-v6.json',JSON.stringify(packet,null,2)),
  writeFile(OUT+'/market-regime-v6.json',JSON.stringify({engine:'EGX Market Regime Engine',version:1,generated_at:packet.generated_at,reference_session:packet.reference_session,...regime},null,2)),
  writeFile(OUT+'/research-queue-v6.json',JSON.stringify({engine:'EGX V6 Research Queue',version:1,generated_at:packet.generated_at,reference_session:packet.reference_session,queue:researchQueue},null,2)),
  writeFile(OUT+'/corporate-action-audit-v6.json',JSON.stringify(corpAudit,null,2)),
  writeFile(OUT+'/replacement-challengers-v6.json',JSON.stringify({engine:'EGX Portfolio Replacement Challengers',version:1,generated_at:packet.generated_at,reference_session:packet.reference_session,private_portfolio_required:true,challengers:replacements},null,2))
]);
console.log(JSON.stringify({engine:packet.engine,version:packet.version,universe:rows.length,regime:regime.label,executable:executable.length,research_queue:researchQueue.length,corporate_flags:corpAudit.flagged.length,top:rows.slice(0,5).map((x:any)=>[x.symbol,x.score,x.action])}));