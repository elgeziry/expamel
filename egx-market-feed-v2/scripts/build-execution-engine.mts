import { readFile, writeFile } from 'node:fs/promises';
const OUT='out';
const num=(v:any)=>Number.isFinite(Number(v))?Number(v):null;
const pct=(a:number,b:number)=>b?((a/b)-1)*100:null;
const round=(v:number,d=2)=>Number(v.toFixed(d));
async function json(path:string){return JSON.parse(await readFile(path,'utf8'));}
const [capital,radar,universe,contract,history]=await Promise.all([json(`${OUT}/capital-allocation.json`),json(`${OUT}/radar.json`),json(`${OUT}/universe.json`),json(`${OUT}/contract.json`),json(`${OUT}/history.json`)]);
if(contract?.bridge_gate!=='pass'||contract?.execution_usable!==true) throw new Error('FAIL_CLOSED:bridge_not_execution_usable');
const currentUniverse=(universe?.stocks||[]).length;
const universeTarget=Number(universe?.roster_target_count||296);
const quarantinedSymbols=Array.isArray(universe?.quarantined_symbols)?universe.quarantined_symbols:[];
const universeOperational=universe?.universe_operational===true||currentUniverse>=universeTarget;
if(!universeOperational) throw new Error('FAIL_CLOSED:universe_not_operational');
if(currentUniverse+quarantinedSymbols.length<universeTarget) throw new Error('FAIL_CLOSED:universe_target_not_accounted');
if(radar?.radar_version!==2) throw new Error('FAIL_CLOSED:radar_v2_missing');
if((history?.sessions||[]).length<6) throw new Error('FAIL_CLOSED:history_missing');
const bySym=new Map((universe.stocks||[]).map((x:any)=>[String(x.symbol||'').toUpperCase(),x]));
function plan(c:any){
 const r:any=bySym.get(c.symbol)||{}; const close=num(r.close); const sma20=num(r.SMA20??r.EMA20); const sma50=num(r.SMA50??r.EMA50); const dayLow=num(r.low); const dayHigh=num(r.high); const change=num(r.change)||0;
 if(!close) return {...c,execution_plan:{status:'NO_ORDER',reason:'missing_reference_price'}};
 const chase=c.action==='NO_CHASE'||change>=8;
 const anchor=[sma20,sma50,dayLow].filter((x):x is number=>x!=null&&x>0&&x<=close*1.03).sort((a,b)=>b-a)[0]||close*0.97;
 let zHigh=Math.min(close,Math.max(anchor*1.015,close*0.985)); let zLow=Math.min(zHigh,Math.max(anchor*0.985,close*0.94));
 const invalid=Math.min(zLow*0.955,(sma50&&sma50<zLow?sma50*0.975:zLow*0.955));
 const riskPct=pct(zLow,invalid); const extension=dayHigh&&dayLow&&dayHigh>dayLow?(close-dayLow)/(dayHigh-dayLow):null;
 let status='WATCH'; if(c.gates?.execution_ready&&c.action==='ACT_NOW'&&!chase)status='BUY_ZONE'; else if(c.gates?.execution_ready&&c.action==='ACCUMULATE_ON_WEAKNESS')status='LIMIT_ON_WEAKNESS'; else if(chase)status='NO_CHASE';
 return {...c,execution_plan:{status,reference_close:round(close),entry_zone:[round(zLow),round(zHigh)],invalidation:round(invalid),risk_from_low_pct:riskPct==null?null:round(riskPct),day_extension:extension==null?null:round(extension,3),sizing:{probe_pct_of_target:status==='BUY_ZONE'?35:status==='LIMIT_ON_WEAKNESS'?25:0,core_add_pct:status==='BUY_ZONE'?40:status==='LIMIT_ON_WEAKNESS'?35:0,reserve_pct:status==='BUY_ZONE'?25:status==='LIMIT_ON_WEAKNESS'?40:100},rules:['do_not_chase_above_entry_zone','cancel_if_invalidation_breaks_on_confirmed_close','position_size_must_respect_portfolio_risk_budget']}};
}
const ranked=(capital.ranked||[]).map(plan);
const executable=ranked.filter((x:any)=>['BUY_ZONE','LIMIT_ON_WEAKNESS'].includes(x.execution_plan?.status));
const packet={engine:'EGX V5 Execution Engine',version:1,generated_at:new Date().toISOString(),reference_session:contract.expected_reference_session_date,architecture:['V5_resilient_data','history_cycle_quality','opportunity_sentinel_v2','capital_allocation_v3','execution_engine_v1'],fail_closed:true,universe_count:currentUniverse,universe_target:universeTarget,universe_operational:universeOperational,coverage_mode:universe?.quality?.coverage_mode||'complete',quarantined_symbols:quarantinedSymbols,history_sessions:(history.sessions||[]).length,executable_count:executable.length,execution_queue:executable.slice(0,10),ranked:ranked.slice(0,50),note:'Execution zones are systematic technical risk bands. Missing market symbols are quarantined, never price-filled. Portfolio quantities require confirmed current NAV/cash/holdings and are never invented.'};
await writeFile(`${OUT}/execution-engine.json`,JSON.stringify(packet,null,2));
console.log(JSON.stringify({engine:packet.engine,universe:packet.universe_count,history:packet.history_sessions,executable:packet.executable_count}));