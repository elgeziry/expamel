import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const NETLIFY = process.env.EGX_NETLIFY_BASE || 'https://egx-market-feed-v2.netlify.app';
const TV_URL = 'https://scanner.tradingview.com/egypt/scan';
const OUT = process.env.EGX_BRIDGE_OUT || 'out/latest.json';
const HEALTH_OUT = process.env.EGX_BRIDGE_HEALTH_OUT || 'out/health.json';
const BRIDGE_VERSION = '1.1.0';
const EXPECTED_CORE = process.env.EGX_EXPECTED_CORE || null;
const REQUIRED_SYMBOLS = String(process.env.EGX_REQUIRED_SYMBOLS || 'SWDY,EFIH,EFID,BONY,ORWE,MASR,EGAL,JUFO,AMOC,SVCE,ORAS')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const COLUMNS = [
  'name','description','close','open','high','low','volume','change','market_cap_basic',
  'RSI','EMA20','SMA20','Perf.W','Perf.1M','average_volume_10d_calc','current_session',
  'SMA50','EMA50','SMA200','EMA200','relative_volume_10d_calc',
  'earnings_per_share_diluted_ttm','price_earnings_current','eps_diluted_growth_percent_fq',
  'eps_diluted_growth_percent_fy','total_revenue_ttm','free_cash_flow_ttm','debt_to_equity_fq',
  'earnings_release_next_date','dividend_ex_date_upcoming','price_target_average','price_target_high','price_target_low'
];

const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const round = (v,d=4) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d));

function cairoParts(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
  }).formatToParts(now).reduce((o,p) => { if (p.type !== 'literal') o[p.type]=p.value; return o; },{});
}

function marketPhase(now = new Date()) {
  const p = cairoParts(now); const mins = Number(p.hour)*60+Number(p.minute);
  const trading = !['Fri','Sat'].includes(p.weekday);
  if (!trading) return 'closed';
  if (mins < 570) return 'preopen';
  if (mins < 600) return 'auction';
  if (mins < 870) return 'continuous';
  return 'postclose';
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, {...options, signal:c.signal});
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${text.slice(0,200)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

async function netlifyPath() {
  const started = Date.now();
  try {
    const d = await fetchJson(`${NETLIFY}/api/execution-bundle`, {headers:{accept:'application/json'}}, 18000);
    if (!d || !Array.isArray(d.screen?.top_setup) || !d.market) throw new Error('invalid_bundle_shape');
    if (EXPECTED_CORE && d.version !== EXPECTED_CORE) throw new Error(`unexpected_core_version:${d.version}`);
    return {ok:true, latency_ms:Date.now()-started, data:d};
  } catch (e) {
    return {ok:false, latency_ms:Date.now()-started, error:String(e?.message || e)};
  }
}

function tvPayload() {
  return {
    filter:[{left:'exchange',operation:'equal',right:'EGX'}],
    options:{lang:'en'}, markets:['egypt'], symbols:{query:{types:['stock']},tickers:[]},
    columns:COLUMNS, range:[0,500]
  };
}

function enrich(row) {
  const c=num(row.close), v=num(row.volume), avg=num(row.average_volume_10d_calc);
  const value=c!=null&&v!=null?c*v:null;
  const rv=num(row.relative_volume_10d_calc) ?? (v!=null&&avg>0?v/avg:null);
  const rsi=num(row.RSI), e20=num(row.EMA20), s20=num(row.SMA20), s200=num(row.SMA200);
  let technical=5;
  if(c!=null&&e20!=null) technical += c>=e20?1:-0.7;
  if(c!=null&&s20!=null) technical += c>=s20?1:-0.7;
  if(c!=null&&s200!=null) technical += c>=s200?0.8:-0.5;
  if(rsi!=null) technical += rsi>=45&&rsi<=70?1.2:rsi>80?-0.8:rsi<30?-0.4:0;
  technical=round(clamp(technical,0,10),1);
  const liquidity=value>=100e6?10:value>=50e6?9:value>=20e6?8:value>=10e6?7:value>=5e6?6:value>=1e6?4.5:2.5;
  const loc=c!=null&&num(row.high)!=null&&num(row.low)!=null&&num(row.high)>num(row.low)?clamp((c-num(row.low))/(num(row.high)-num(row.low)),0,1):null;
  let demand=0;
  if(rv!=null) demand += rv>=2?3:rv>=1.5?2.4:rv>=1?1.5:0.7;
  if(loc!=null) demand += (num(row.change)??0)>0&&loc>=0.7?2.5:(num(row.change)??0)>=0&&loc>=0.5?1.8:1;
  demand += value>=100e6?2:value>=50e6?1.7:value>=20e6?1.3:value>=5e6?0.8:0.3;
  if(c!=null&&s200!=null&&c>s200) demand+=0.8;
  if(c!=null&&e20!=null&&s20!=null&&c>e20&&c>s20) demand+=0.7;
  if((num(row['Perf.W'])??0)>0&&(num(row['Perf.1M'])??0)>0) demand+=1;
  demand=round(clamp(demand,0,10),1);
  const setup=round(0.55*technical+0.25*liquidity+0.20*demand,1);
  return {...row,value:round(value,2),relative_volume_10d:round(rv,2),demand_confirmation_score:demand,
    decision_support:{technical_score:technical,liquidity_score:liquidity,setup_score:setup,
      chase_risk:(rsi??0)>=80||(num(row['Perf.1M'])??0)>=35||(num(row['Perf.W'])??0)>=25?'high':(rsi??0)>=72||(num(row['Perf.1M'])??0)>=20||(num(row['Perf.W'])??0)>=15?'medium':'low'}};
}

async function directPath() {
  const started=Date.now();
  try {
    const raw=await fetchJson(TV_URL,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8','origin':'https://www.tradingview.com','referer':'https://www.tradingview.com/','user-agent':`Mozilla/5.0 (compatible; EGXResilientBridge/${BRIDGE_VERSION})`},body:JSON.stringify(tvPayload())},18000);
    const rows=(raw.data||[]).map(item=>{const r={symbol_full:item.s};COLUMNS.forEach((c,i)=>r[c]=item.d?.[i]??null);r.symbol=String(item.s||'').split(':').pop();return enrich(r);});
    if(rows.length<50) throw new Error(`insufficient_rows:${rows.length}`);
    const unique=new Set(rows.map(r=>r.symbol)); if(unique.size!==rows.length) throw new Error('duplicate_symbols');
    const top=[...rows].filter(r=>num(r.close)>0&&num(r.value)>=1e6).sort((a,b)=>(b.decision_support?.setup_score??0)-(a.decision_support?.setup_score??0));
    const adv=rows.filter(r=>(num(r.change)??0)>0).length, dec=rows.filter(r=>(num(r.change)??0)<0).length;
    const positive=rows.length?adv/rows.length*100:0;
    return {ok:true,latency_ms:Date.now()-started,data:{status:'ok',source_id:'tradingview-direct-github',source:'TradingView public scanner',version:'direct-bridge',retrieved_at:new Date().toISOString(),session_status:marketPhase(),market:{regime:positive>=55?'strong':positive>=45?'mixed':'weak',breadth:{advancers:adv,decliners:dec,unchanged:rows.length-adv-dec,positive_pct:round(positive,1)}},screen:{top_setup:top.slice(0,40),early_movement:top.filter(r=>(num(r.change)??0)>=8||(num(r['Perf.W'])??0)>=20||(num(r.relative_volume_10d)??0)>=2||(num(r['Perf.1M'])??0)>=20).slice(0,40)},rows,count:rows.length,total_count:raw.totalCount??rows.length}};
  } catch(e) { return {ok:false,latency_ms:Date.now()-started,error:String(e?.message||e)}; }
}

function candidateRows(data) {
  if (!data) return [];
  const pools = [data.rows, data.universe, data.stocks, data.screen?.top_setup];
  return pools.find(Array.isArray) || [];
}

function compare(a,b){
  if(!a?.ok||!b?.ok) return {comparable:false};
  const ar=candidateRows(a.data);
  const br=candidateRows(b.data);
  const bm=new Map(br.map(r=>[String(r.symbol||'').toUpperCase(),Number(r.close)])); let compared=0,maxDiff=0;
  for(const r of ar){const x=Number(r.close),y=bm.get(String(r.symbol||'').toUpperCase());if(Number.isFinite(x)&&Number.isFinite(y)&&y!==0){compared++;maxDiff=Math.max(maxDiff,Math.abs(x/y-1)*100);}}
  return {comparable:compared>=10,compared_symbols:compared,max_close_diff_pct:round(maxDiff,4),agreement:compared>=10&&maxDiff<=0.05};
}

function coverage(universe) {
  const present = new Set((universe||[]).map(r=>String(r.symbol||'').toUpperCase()));
  const missing = REQUIRED_SYMBOLS.filter(s=>!present.has(s));
  return {required_symbols:REQUIRED_SYMBOLS,present_count:REQUIRED_SYMBOLS.length-missing.length,missing_symbols:missing,complete:missing.length===0};
}

async function main(){
  const now=new Date();
  const [netlify,direct]=await Promise.all([netlifyPath(),directPath()]);
  const cross=compare(netlify,direct);
  let selected=null, mode=null;
  if(netlify.ok && netlify.data.execution_usable===true && (!cross.comparable || cross.agreement)){selected=netlify.data;mode='netlify_validated_by_direct';}
  else if(direct.ok){selected=direct.data;mode=netlify.ok?'direct_due_to_netlify_gate_or_disagreement':'direct_fallback';}
  else if(netlify.ok){selected=netlify.data;mode='netlify_only_degraded';}
  else throw new Error(`all_paths_failed | netlify=${netlify.error} | direct=${direct.error}`);

  selected = {...selected};
  if (direct.ok) {
    selected.universe = direct.data.rows;
    selected.universe_count = direct.data.count;
    selected.universe_source = 'direct_tradingview_scanner';
    selected.universe_contract = {
      purpose:'full_symbol_lookup_and_stock_specific_analysis',
      symbol_key:'symbol',
      symbol_full_key:'symbol_full',
      note:'Use data.universe for named-stock lookup even when Netlify is the selected execution bundle.'
    };
  }
  const symbolCoverage = coverage(selected.universe || candidateRows(selected));

  const canonical={
    bridge:{name:'EGX Resilient Bridge',version:BRIDGE_VERSION,generated_at:now.toISOString(),transport_independent:true,selected_mode:mode,market_phase:marketPhase(now),cross_check:cross,symbol_coverage:symbolCoverage},
    path_health:{netlify:{ok:netlify.ok,latency_ms:netlify.latency_ms,error:netlify.error??null,core_version:netlify.data?.version??null,execution_usable:netlify.data?.execution_usable??null},direct:{ok:direct.ok,latency_ms:direct.latency_ms,error:direct.error??null,row_count:direct.data?.count??null}},
    data:selected
  };
  const hash=crypto.createHash('sha256').update(JSON.stringify(canonical.data)).digest('hex');
  canonical.bridge.data_sha256=hash;
  await fs.mkdir(OUT.split('/').slice(0,-1).join('/')||'.',{recursive:true});
  await fs.writeFile(OUT,JSON.stringify(canonical,null,2));
  await fs.writeFile(HEALTH_OUT,JSON.stringify({bridge:canonical.bridge,path_health:canonical.path_health},null,2));
  console.log(JSON.stringify({selected_mode:mode,sha256:hash,netlify:canonical.path_health.netlify,direct:canonical.path_health.direct,cross_check:cross,symbol_coverage:symbolCoverage}));
}

main().catch(e=>{console.error(e);process.exit(1);});
