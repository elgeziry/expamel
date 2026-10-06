import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const num=(v:any)=>Number.isFinite(Number(v))?Number(v):null;
const round=(v:number,d=2)=>Number(v.toFixed(d));
const clamp=(v:number,lo=0,hi=1)=>Math.min(hi,Math.max(lo,v));
const sym=(v:any)=>String(v||'').trim().toUpperCase();

const statePath=process.argv[2]||process.env.PRIVATE_PORTFOLIO_FILE;
const decisionPath=process.env.V6_DECISION_FILE||'out/decision-intelligence-v6.json';
const outputPath=process.env.PRIVATE_PORTFOLIO_OUTPUT||'/tmp/egx-private-portfolio-overlay.json';

if(!statePath) throw new Error('PRIVATE_OVERLAY_FAIL:missing_private_portfolio_file');
if(resolve(outputPath).includes(resolve(process.cwd())+'/out/')) throw new Error('PRIVATE_OVERLAY_FAIL:refuse_public_out_path');

const [stateRaw,decisionRaw]=await Promise.all([readFile(statePath,'utf8'),readFile(decisionPath,'utf8')]);
const state=JSON.parse(stateRaw), decision=JSON.parse(decisionRaw);

if(decision?.engine!=='EGX Decision Intelligence'||decision?.version!==6) throw new Error('PRIVATE_OVERLAY_FAIL:v6_decision_missing');
if(decision?.data_gates?.pass!==true||decision?.data_gates?.execution_usable!==true) throw new Error('PRIVATE_OVERLAY_FAIL:v6_not_execution_usable');

const cash=num(state?.cash_egp);
const holdings=Array.isArray(state?.holdings)?state.holdings:[];
const risk=state?.risk_policy||{};
const riskPerPos=num(risk?.risk_per_new_position_pct);
const maxPos=num(risk?.max_position_pct);
const reservePct=num(risk?.min_cash_reserve_pct);
const maxHeatPct=num(risk?.max_portfolio_heat_pct);
const maxNewOrders=Math.max(1,Math.floor(num(risk?.max_new_orders_per_session)??3));

const policyErrors:string[]=[];
if(cash==null||cash<0) policyErrors.push('cash_egp_missing_or_invalid');
for(const [k,v,min,max] of [
  ['risk_per_new_position_pct',riskPerPos,0.05,5],
  ['max_position_pct',maxPos,1,40],
  ['min_cash_reserve_pct',reservePct,0,80],
  ['max_portfolio_heat_pct',maxHeatPct,0.5,25],
] as any[]){
  if(v==null||v<min||v>max) policyErrors.push(k+'_missing_or_out_of_bounds');
}
if(!state?.as_of) policyErrors.push('as_of_missing');
if(policyErrors.length) throw new Error('PRIVATE_OVERLAY_FAIL:'+policyErrors.join('|'));

const ranked:any[]=decision?.all_ranked||[];
const bySymbol=new Map(ranked.map((x:any)=>[sym(x.symbol),x]));
const normalizedHoldings=holdings.map((h:any)=>{
  const symbol=sym(h?.symbol), shares=num(h?.shares), avgCost=num(h?.avg_cost), thesisInvalidation=num(h?.invalidation);
  if(!symbol||shares==null||shares<0||avgCost==null||avgCost<0) return {symbol,valid:false,issue:'invalid_holding_record'};
  const row:any=bySymbol.get(symbol);
  if(!row) return {symbol,shares,avg_cost:avgCost,invalidation:thesisInvalidation,valid:false,issue:'symbol_missing_from_current_v6'};
  const px=num(row?.reference_close);
  if(px==null||px<=0) return {symbol,shares,avg_cost:avgCost,invalidation:thesisInvalidation,valid:false,issue:'current_price_missing'};
  const value=shares*px, cost=shares*avgCost;
  const pnl=value-cost, pnlPct=cost>0?pnl/cost*100:null;
  const sharia=String(row?.research?.sharia_status||'pending_verification');
  let action='HOLD';
  let reason='current_position_retain_pending_portfolio_competition';
  if(row?.research?.sharia_verified===true&&sharia==='non_compliant'){action='SELL_REVIEW_SHARIA';reason='current_verified_sharia_status_non_compliant';}
  else if(row?.corporate_action?.technical_history_gate===false){action='HOLD_NO_ADD';reason='corporate_action_history_not_normalized';}
  else if(['AVOID','BLOCKED_CORPORATE_ACTION'].includes(String(row?.action))){action='REDUCE_REVIEW';reason='v6_current_action_'+String(row?.action).toLowerCase();}
  else if(['WAIT_ENTRY','WAIT_RISK_REWARD','NO_CHASE'].includes(String(row?.action))){action='HOLD_NO_ADD';reason='entry_or_risk_reward_not_currently_attractive';}
  else if(['STRONG_BUY','BUY','ACCUMULATE'].includes(String(row?.action))){action='HOLD_OR_ADD';reason='v6_current_action_'+String(row?.action).toLowerCase();}
  const riskPerShare=thesisInvalidation!=null&&thesisInvalidation<px?px-thesisInvalidation:null;
  const openRisk=riskPerShare!=null?shares*riskPerShare:null;
  return {symbol,valid:true,shares,avg_cost:avgCost,current_price:px,market_value_egp:round(value),cost_basis_egp:round(cost),pnl_egp:round(pnl),pnl_pct:pnlPct==null?null:round(pnlPct),thesis_invalidation:thesisInvalidation,open_risk_egp:openRisk==null?null:round(openRisk),v6_rank:row?.rank??null,v6_score:row?.score??null,v6_action:row?.action??null,sharia_status:sharia,action,reason};
});

const holdingIssues=normalizedHoldings.filter((h:any)=>!h.valid);
const portfolioValue=normalizedHoldings.filter((h:any)=>h.valid).reduce((s:number,h:any)=>s+(h.market_value_egp||0),0);
const nav=(cash||0)+portfolioValue;
const reserveCash=nav*(reservePct!/100);
const deployableCash=Math.max(0,(cash||0)-reserveCash);
const heatKnown=normalizedHoldings.filter((h:any)=>h.valid&&h.open_risk_egp!=null).reduce((s:number,h:any)=>s+h.open_risk_egp,0);
const missingInvalidations=normalizedHoldings.filter((h:any)=>h.valid&&h.shares>0&&h.open_risk_egp==null).map((h:any)=>h.symbol);
const heatPct=nav>0?heatKnown/nav*100:null;
const regimeMult=clamp(num(decision?.market_regime?.position_size_multiplier)??0.5,0.1,1);
const sizingAuthorized=holdingIssues.length===0&&missingInvalidations.length===0&&heatPct!=null&&heatPct<maxHeatPct!;

const currentValueBySymbol=new Map(normalizedHoldings.filter((h:any)=>h.valid).map((h:any)=>[h.symbol,h.market_value_egp||0]));
const candidates=(decision?.executable_queue||[]).filter((x:any)=>['STRONG_BUY','BUY','ACCUMULATE'].includes(String(x?.action)));
let remainingCash=deployableCash;
let projectedHeat=heatKnown;
const orders:any[]=[];
for(const c of candidates){
  if(orders.length>=maxNewOrders) break;
  const symbol=sym(c?.symbol);
  const zone=c?.execution_plan?.entry_zone;
  const limit=Array.isArray(zone)?num(zone[0]):null;
  const invalid=num(c?.execution_plan?.invalidation);
  if(limit==null||invalid==null||limit<=invalid||limit<=0) continue;
  const existingValue=Number(currentValueBySymbol.get(symbol)||0);
  const riskPerShare=limit-invalid;
  const grossRiskBudget=nav*(riskPerPos!/100)*regimeMult;
  const heatRoom=Math.max(0,nav*(maxHeatPct!/100)-projectedHeat);
  const riskBudget=Math.min(grossRiskBudget,heatRoom);
  const maxTargetValue=Math.max(0,nav*(maxPos!/100)-existingValue);
  const qtyByRisk=Math.floor(riskBudget/riskPerShare);
  const qtyByWeight=Math.floor(maxTargetValue/limit);
  const qtyByCash=Math.floor(remainingCash/limit);
  const quantity=sizingAuthorized?Math.max(0,Math.min(qtyByRisk,qtyByWeight,qtyByCash)):null;
  const cost=quantity==null?null:quantity*limit;
  const orderRisk=quantity==null?null:quantity*riskPerShare;
  if(quantity!=null&&quantity>0){
    remainingCash-=cost!;
    projectedHeat+=orderRisk!;
  }
  orders.push({
    symbol,action:c.action,v6_rank:c.rank,v6_score:c.score,
    limit_price:round(limit),invalidation:round(invalid),risk_per_share:round(riskPerShare),
    regime_position_multiplier:regimeMult,
    risk_budget_egp:round(riskBudget),max_target_value_egp:round(maxTargetValue),
    quantity:quantity==null?null:quantity,estimated_cost_egp:cost==null?null:round(cost),planned_risk_egp:orderRisk==null?null:round(orderRisk),
    sizing_status:sizingAuthorized?(quantity&&quantity>0?'AUTHORIZED':'NO_CAPACITY'):'BLOCKED_RECONCILE_PORTFOLIO_RISK',
    rule:'Quantity is the minimum of risk-budget, max-position, and deployable-cash limits.'
  });
}

const bestCandidate=(decision?.top_opportunities||[]).find((x:any)=>['STRONG_BUY','BUY','ACCUMULATE'].includes(String(x?.action)))||null;
const replacementReview=normalizedHoldings.filter((h:any)=>h.valid).map((h:any)=>{
  const challenger=bestCandidate;
  if(!challenger) return {held_symbol:h.symbol,review:'NO_EXECUTABLE_CHALLENGER'};
  const spread=(num(challenger.score)||0)-(num(h.v6_score)||0);
  let review='KEEP';
  if(h.action==='SELL_REVIEW_SHARIA') review='EXIT_SHARIA_PRIORITY';
  else if(h.action==='REDUCE_REVIEW'&&spread>=8) review='REPLACEMENT_CANDIDATE';
  else if(spread>=15&&['HOLD','HOLD_NO_ADD'].includes(h.action)) review='CAPITAL_EFFICIENCY_REVIEW';
  return {held_symbol:h.symbol,held_score:h.v6_score,held_action:h.action,challenger_symbol:challenger.symbol,challenger_score:challenger.score,score_spread:round(spread),review,note:'Replacement flag is a review trigger, not an automatic sell instruction.'};
});

const packet={
  engine:'EGX Private Portfolio Overlay',version:1,generated_at:new Date().toISOString(),
  portfolio_as_of:state.as_of,market_reference_session:decision.reference_session,
  privacy:{public_repository_state_used_for_market_only:true,private_holdings_written_to_public_repo:false,output_path:outputPath},
  policy:{...risk,max_new_orders_per_session:maxNewOrders,regime_position_size_multiplier:regimeMult},
  portfolio:{cash_egp:round(cash!),holdings_market_value_egp:round(portfolioValue),nav_egp:round(nav),cash_reserve_required_egp:round(reserveCash),deployable_cash_egp:round(deployableCash),known_open_risk_egp:round(heatKnown),known_portfolio_heat_pct:heatPct==null?null:round(heatPct),missing_invalidation_symbols:missingInvalidations,holding_data_issues:holdingIssues.map((x:any)=>({symbol:x.symbol,issue:x.issue})),sizing_authorized:sizingAuthorized},
  holdings:normalizedHoldings,
  replacement_review:replacementReview,
  proposed_orders:orders,
  projected:{remaining_cash_after_orders_egp:sizingAuthorized?round(remainingCash):null,projected_open_risk_egp:sizingAuthorized?round(projectedHeat):null,projected_heat_pct:sizingAuthorized&&nav>0?round(projectedHeat/nav*100):null},
  fail_closed_reasons:[...(holdingIssues.length?['holding_data_issues']:[]),...(missingInvalidations.length?['missing_existing_position_invalidations']:[]),...(heatPct!=null&&heatPct>=maxHeatPct!?['portfolio_heat_at_or_above_limit']:[])],
  note:'This overlay deliberately refuses final quantities unless current cash, every holding, risk policy, and thesis invalidations are complete. It is never executed by the public GitHub workflow.'
};
await writeFile(outputPath,JSON.stringify(packet,null,2));
console.log(JSON.stringify({engine:packet.engine,version:1,market_session:packet.market_reference_session,holdings:normalizedHoldings.length,sizing_authorized:sizingAuthorized,orders:orders.length,fail_closed_reasons:packet.fail_closed_reasons}));
