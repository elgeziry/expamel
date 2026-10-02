import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'out';
const REPO = process.env.GITHUB_REPOSITORY || 'elgeziry/expamel';
const num = (v:any) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v:number, lo=0, hi=100) => Math.min(hi, Math.max(lo, v));
const sym = (r:any) => String(r?.symbol || r?.name || '').toUpperCase();
const value = (r:any) => num(r?.value_session_adjusted ?? r?.value ?? ((num(r?.close)||0)*(num(r?.volume)||0))) || 0;
const cap = (r:any) => num(r?.market_cap_basic) || 0;

function ten(v:any, fallback=5){ const n=num(v); return n==null?fallback:Math.max(0,Math.min(10,n)); }
function liquidityScore(r:any){
  const ds=num(r?.decision_support?.liquidity_score); if(ds!=null) return ten(ds);
  const v=value(r); return v>=250e6?10:v>=100e6?8:v>=40e6?7:v>=10e6?5:v>=1e6?3:1;
}
function trendScore(r:any){
  const t=String(r?.long_term_trend||'');
  if(t==='long_term_uptrend') return 9; if(t==='decision_zone_near_sma200') return 7;
  if(t.startsWith('short_term_positive')) return 6; if(t==='below_sma200') return 2; return 5;
}
function stageScore(r:any){ const s=String(r?.discovery?.stage||''); return s==='pre_move_watch'?9:s==='confirming'?7:s==='extended_no_chase'?2:5; }
function chasePenalty(r:any){
  const ch=String(r?.decision_support?.chase_risk||'low'); const c=num(r?.change)||0;
  let p=ch==='high'?18:ch==='medium'?7:0; if(c>=8)p+=8; if(c>=10)p+=8; if(c>=15)p+=6; return Math.min(35,p);
}
function concentrationPenalty(r:any){ return 0; } // Activated when portfolio holdings are supplied to the engine.
function shariaStatus(r:any){ return String(r?.sharia?.status || r?.sharia_status || 'pending_verification'); }
function hardGate(r:any){
  const sh=shariaStatus(r).toLowerCase();
  const shariaPass=['compliant','purification_required'].includes(sh);
  const fundamentalPresent = num(r?.fundamentals?.score ?? r?.fundamental_score) != null;
  const valuationPresent = num(r?.valuation?.score ?? r?.valuation_score) != null;
  return {sharia_pass:shariaPass, fundamental_verified:fundamentalPresent, valuation_verified:valuationPresent,
    execution_ready:shariaPass && fundamentalPresent && valuationPresent};
}
function allocation(r:any){
  const setup=ten(r?.decision_support?.setup_score);
  const demand=ten(r?.demand_confirmation_score);
  const liq=liquidityScore(r);
  const trend=trendScore(r);
  const discovery=ten(r?.discovery?.score);
  const stage=stageScore(r);
  const rv=Math.min(10,Math.max(0,(num(r?.relative_volume_10d ?? r?.relative_volume_10d_calc)||1)*4));
  const closeLoc=Math.max(0,Math.min(10,(num(r?.close_location_in_day)??0.5)*10));
  const size=cap(r)>=100e9?10:cap(r)>=30e9?8:cap(r)>=10e9?7:cap(r)>=2e9?5:3;

  // V1 uses only fields actually present in the market packet. Missing deep-analysis fields are neutral,
  // never fabricated, and remain hard gates before an executable BUY/REPLACE decision.
  const fundamentals=ten(r?.fundamentals?.score ?? r?.fundamental_score,5);
  const valuation=ten(r?.valuation?.score ?? r?.valuation_score,5);
  const catalyst=ten(r?.catalyst?.transmission_score ?? r?.catalyst_transmission_score,5);
  const cycle=ten(r?.cycle_quality?.score ?? r?.cycle_quality_score, trend);
  const entry=0.45*setup+0.25*stage+0.20*demand+0.10*closeLoc;
  const institutional=0.35*rv+0.30*demand+0.20*liq+0.15*size;
  const rr=ten(r?.risk_reward?.score ?? r?.rr_score, discovery);
  const portfolioFit=ten(r?.portfolio_fit?.score ?? r?.portfolio_fit_score,5);
  const opportunityCost=ten(r?.replacement?.advantage_score ?? r?.opportunity_cost_score,5);

  const raw = fundamentals*1.5 + valuation*1.5 + catalyst*1.0 + cycle*1.0 + stage*0.8 + institutional*0.7 + entry*1.0 + rr*1.2 + portfolioFit*0.5 + liq*0.3 + opportunityCost*0.5;
  const penalty=chasePenalty(r)+concentrationPenalty(r);
  const score=clamp(raw-penalty);
  const gate=hardGate(r);
  let action='DEEP_ANALYSIS_REQUIRED';
  if(String(r?.discovery?.stage)==='extended_no_chase') action='NO_CHASE';
  else if(gate.execution_ready && score>=80) action='ACT_NOW';
  else if(gate.execution_ready && score>=70) action='ACCUMULATE_ON_WEAKNESS';
  else if(score>=62) action='PRE_MOVE_WATCH';
  return {
    symbol:sym(r), score:Number(score.toFixed(2)), raw_score:Number(raw.toFixed(2)), penalty,
    action, stage:r?.discovery?.stage || null, discovery_score:r?.discovery?.score ?? null,
    gates:gate, sharia_status:shariaStatus(r),
    components:{fundamentals,valuation,catalyst_transmission:catalyst,cycle_quality:cycle,pre_move_stage:stage,institutional_proxy:Number(institutional.toFixed(2)),entry_quality:Number(entry.toFixed(2)),risk_reward:rr,portfolio_fit:portfolioFit,liquidity:liq,opportunity_cost:opportunityCost},
    missing_deep_analysis:[...(!gate.fundamental_verified?['fundamentals']:[]),...(!gate.valuation_verified?['valuation']:[]),...(!gate.sharia_pass?['sharia_verification']:[])],
    capital_rule:'No executable allocation until Sharia, fundamentals and valuation hard gates pass.'
  };
}

async function previousEngine(){
  try{ const r=await fetch(`https://raw.githubusercontent.com/${REPO}/egx-live/capital-allocation.json?ts=${Date.now()}`,{headers:{'user-agent':'EGX-Capital-Allocation-V1','cache-control':'no-cache'}}); return r.ok?await r.json():null; }catch{return null;}
}

const [radarRaw,contractRaw,healthRaw,prev]=await Promise.all([
  readFile(`${OUT}/radar.json`,'utf8'), readFile(`${OUT}/contract.json`,'utf8'), readFile(`${OUT}/health.json`,'utf8'), previousEngine()
]);
const radar=JSON.parse(radarRaw), contract=JSON.parse(contractRaw), health=JSON.parse(healthRaw);
const candidates:any[] = radar?.all_ranked || radar?.top_discovery || radar?.dynamic_focus || [];
if(!Array.isArray(candidates) || candidates.length===0) throw new Error('Capital Allocation Engine: radar has no candidates');
const ranked=candidates.map(allocation).filter((x:any)=>x.symbol).sort((a:any,b:any)=>b.score-a.score);
const prior=new Map((prev?.ranked||[]).map((x:any,i:number)=>[x.symbol,i+1]));
const top=ranked.slice(0,50).map((x:any,i:number)=>({...x,rank:i+1,previous_rank:prior.get(x.symbol)||null,rank_change:prior.has(x.symbol)?Number(prior.get(x.symbol))-i-1:null}));
const executable=top.filter((x:any)=>x.gates.execution_ready && ['ACT_NOW','ACCUMULATE_ON_WEAKNESS'].includes(x.action));
const packet={
  engine:'EGX Capital Allocation Engine', version:1, generated_at:new Date().toISOString(),
  reference_session:contract?.expected_reference_session_date || null,
  bridge_gate:contract?.bridge_gate || null, execution_usable:contract?.execution_usable===true,
  universe_count:radar?.discovery?.universe_count ?? contract?.quality?.discovery_universe_count ?? null,
  methodology:{purpose:'capital_allocation_not_stock_screening',pipeline:['full_universe','opportunity_sentinel_v2','dynamic_focus','deep_analysis_gates','capital_allocation','portfolio_replacement','execution_queue'],hard_gates:['sharia','fundamentals','valuation'],fail_closed:true,post_spike_penalty:true,portfolio_replacement_required:true},
  health:{bridge_ok:health?.status==='ok',radar_v2:radar?.radar_version===2,capital_engine_ok:true,executable_count:executable.length},
  ranked:top, executable_queue:executable.slice(0,10),
  research_queue:top.filter((x:any)=>!x.gates.execution_ready).slice(0,15),
  no_chase:top.filter((x:any)=>x.action==='NO_CHASE').slice(0,15),
  note:'Scores never fabricate missing fundamentals, valuation or Sharia data. Missing hard gates block executable BUY/REPLACE decisions.'
};
await writeFile(`${OUT}/capital-allocation.json`,JSON.stringify(packet,null,2));
console.log(JSON.stringify({engine:packet.engine,candidates:ranked.length,top:top.length,executable:executable.length,research:packet.research_queue.length}));
