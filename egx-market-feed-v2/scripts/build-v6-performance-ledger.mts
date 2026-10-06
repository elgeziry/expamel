import { readFile, writeFile } from 'node:fs/promises';

const OUT='out';
const REPO=process.env.GITHUB_REPOSITORY||'elgeziry/expamel';
const num=(v:any)=>Number.isFinite(Number(v))?Number(v):null;
const round=(v:number,d=2)=>Number(v.toFixed(d));
const sym=(r:any)=>String(r?.symbol||r?.name||'').toUpperCase();
async function json(path:string){return JSON.parse(await readFile(path,'utf8'));}
async function previous(){
  try{
    const r=await fetch('https://raw.githubusercontent.com/'+REPO+'/egx-live/performance-ledger-v6.json?ts='+Date.now(),{headers:{'user-agent':'EGX-V6-Performance-Ledger','cache-control':'no-cache'}});
    return r.ok?await r.json():null;
  }catch{return null;}
}
const [decision,universe,contract,prev]=await Promise.all([json(OUT+'/decision-intelligence-v6.json'),json(OUT+'/universe.json'),json(OUT+'/contract.json'),previous()]);
if(decision?.engine!=='EGX Decision Intelligence'||decision?.version!==6)throw new Error('LEDGER_FAIL:decision_v6_missing');
if(contract?.bridge_gate!=='pass'||contract?.execution_usable!==true)throw new Error('LEDGER_FAIL:bridge_not_usable');
const prices=new Map((universe?.stocks||[]).map((x:any)=>[sym(x),num(x?.close)]));
const session=decision?.reference_session||contract?.expected_reference_session_date||new Date().toISOString().slice(0,10);
const currentBySym=new Map((decision?.all_ranked||[]).map((x:any)=>[sym(x),x]));
const oldEntries=Array.isArray(prev?.entries)?prev.entries:[];
const entries=oldEntries.map((e:any)=>{
  const price=prices.get(String(e.symbol||'').toUpperCase());
  if(price==null||num(e.entry_price)==null)return e;
  const ret=(price/Number(e.entry_price)-1)*100;
  const curr:any=currentBySym.get(String(e.symbol||'').toUpperCase())||{};
  const hardFail=curr?.action==='AVOID'||curr?.research?.sharia_status==='non_compliant'||curr?.corporate_action?.technical_history_gate===false;
  const actionable=['STRONG_BUY','BUY','ACCUMULATE'].includes(String(curr?.action||''));
  const sameSessionSuperseded=String(e.first_session||'')===String(session)&&!actionable&&!hardFail;
  const nextStatus=hardFail?'invalidated_by_current_model':sameSessionSuperseded?'superseded_same_session':e.status||'open';
  return {...e,last_session:session,last_price:round(price),current_return_pct:round(ret),max_favorable_pct:round(Math.max(num(e.max_favorable_pct)??ret,ret)),max_adverse_pct:round(Math.min(num(e.max_adverse_pct)??ret,ret)),observations:(Number(e.observations)||0)+1,current_model_action:curr?.action||null,current_score:curr?.score??null,status:nextStatus};
});
const existingOpen=new Set(entries.filter((e:any)=>e.status==='open').map((e:any)=>String(e.symbol||'').toUpperCase()));
const newSignals=(decision?.executable_queue||[]).filter((x:any)=>['STRONG_BUY','BUY','ACCUMULATE'].includes(x.action)).slice(0,12);
for(const s of newSignals){
  if(existingOpen.has(s.symbol))continue;
  const price=num(s.reference_close); if(price==null)continue;
  entries.push({id:s.symbol+':'+session+':'+s.action,symbol:s.symbol,action:s.action,first_session:session,last_session:session,entry_price:round(price),last_price:round(price),initial_score:s.score,current_score:s.score,capital_efficiency_score:s.capital_efficiency_score,evidence_coverage_pct:s.evidence_coverage_pct,market_regime:decision?.market_regime?.label||null,status:'open',current_return_pct:0,max_favorable_pct:0,max_adverse_pct:0,observations:1,notional_only:true,note:'Model signal tracking only; not proof of a user trade or fill.'});
}
const trimmed=entries.slice(-500);
const open=trimmed.filter((e:any)=>e.status==='open');
const invalidated=trimmed.filter((e:any)=>e.status==='invalidated_by_current_model');
const superseded=trimmed.filter((e:any)=>e.status==='superseded_same_session');
const returns=open.map((e:any)=>num(e.current_return_pct)).filter((x):x is number=>x!=null);
const summary={total_entries:trimmed.length,open_entries:open.length,invalidated_entries:invalidated.length,superseded_same_session_entries:superseded.length,open_positive:returns.filter(x=>x>0).length,open_negative:returns.filter(x=>x<0).length,average_open_return_pct:returns.length?round(returns.reduce((a,b)=>a+b,0)/returns.length):null,best_open:[...open].sort((a:any,b:any)=>(num(b.current_return_pct)||0)-(num(a.current_return_pct)||0))[0]||null,worst_open:[...open].sort((a:any,b:any)=>(num(a.current_return_pct)||0)-(num(b.current_return_pct)||0))[0]||null};
const packet={engine:'EGX V6 Performance Learning Ledger',version:1,generated_at:new Date().toISOString(),reference_session:session,methodology:{purpose:'track model signals and adverse/favorable excursion over future runs',not_a_backtest:true,not_user_execution_log:true,never_rewrites_entry_price:true,hard_fail_can_invalidate_open_signal:true},summary,entries:trimmed};
await writeFile(OUT+'/performance-ledger-v6.json',JSON.stringify(packet,null,2));
console.log(JSON.stringify({engine:packet.engine,session,total:summary.total_entries,open:summary.open_entries,avg_open_return:summary.average_open_return_pct}));