import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const NETLIFY = process.env.EGX_NETLIFY_BASE || 'https://egx-market-feed-v2.netlify.app';
const TV_URL = 'https://scanner.tradingview.com/egypt/scan';
const OUT = process.env.EGX_BRIDGE_OUT || 'out/latest.json';
const HEALTH_OUT = process.env.EGX_BRIDGE_HEALTH_OUT || 'out/health.json';
const PREVIOUS_SNAPSHOT = process.env.EGX_PREVIOUS_SNAPSHOT || null;
const BRIDGE_VERSION = '1.2.0';
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

function cairoDate(now = new Date()) {
  const p = cairoParts(now);
  return `${p.year}-${p.month}-${p.day}`;
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

async function readPreviousSnapshot() {
  if (!PREVIOUS_SNAPSHOT) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(PREVIOUS_SNAPSHOT, 'utf8'));
    return parsed?.bridge?.name === 'EGX Resilient Bridge' ? parsed : null;
  } catch { return null; }
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

function priceBinSize(row) {
  const c=num(row.close), h=num(row.high), l=num(row.low);
  if (!(c>0)) return null;
  const pct = c * 0.0025;
  const range = h!=null && l!=null && h>l ? (h-l)/24 : 0;
  const raw = Math.max(pct, range, c<1?0.001:c<10?0.01:c<100?0.05:0.25);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function binKey(price, step) {
  if (!(price>0) || !(step>0)) return null;
  return round(Math.round(price/step)*step, 6);
}

function previousUniverseMap(previous) {
  if (!previous) return new Map();
  const rows = candidateRows(previous.data);
  return new Map(rows.map(r=>[String(r.symbol||'').toUpperCase(),r]));
}

function summarizeProfile({row, priorRow, now, sameSessionDate, activePhase}) {
  const close=num(row.close), currentVolume=num(row.volume);
  const priorProfile=priorRow?.analytics?.volume_profile;
  const reset = !sameSessionDate || !priorRow || !priorProfile || priorProfile.session_date !== cairoDate(now) || num(priorRow.volume)==null || currentVolume==null || currentVolume < num(priorRow.volume);
  const step=!reset && num(priorProfile?.bin_size)>0 ? num(priorProfile.bin_size) : priceBinSize(row);
  const bins = new Map();
  if (!reset && Array.isArray(priorProfile.bins)) {
    for (const b of priorProfile.bins) {
      const p=num(b.price), v=num(b.volume);
      if (p!=null && v!=null && v>=0) bins.set(p,v);
    }
  }

  let observations = reset ? 0 : Number(priorProfile?.observations || 0);
  let capturedVolume = reset ? 0 : Number(priorProfile?.captured_volume || 0);
  let firstSampleAt = reset ? null : priorProfile?.first_sample_at || null;
  let lastSampleAt = reset ? null : priorProfile?.last_sample_at || null;
  let deltaVolume = 0;
  const priorVolume=num(priorRow?.volume);
  const canObserve = activePhase && !reset && close!=null && step!=null && currentVolume!=null && priorVolume!=null;
  if (canObserve) {
    deltaVolume=Math.max(0,currentVolume-priorVolume);
    if (deltaVolume>0) {
      const k=binKey(close,step);
      bins.set(k,(bins.get(k)||0)+deltaVolume);
      capturedVolume+=deltaVolume;
      observations+=1;
      firstSampleAt ||= now.toISOString();
      lastSampleAt=now.toISOString();
    }
  }

  const sorted=[...bins.entries()].map(([price,volume])=>({price:num(price),volume:num(volume)})).filter(b=>b.price!=null&&b.volume>0).sort((a,b)=>a.price-b.price);
  const total=sorted.reduce((s,b)=>s+b.volume,0);
  const byVolume=[...sorted].sort((a,b)=>b.volume-a.volume);
  const poc=byVolume[0]?.price??null;
  const maxNodeVolume=byVolume[0]?.volume??0;
  let valueArea=[];
  if(total>0){let acc=0;for(const b of byVolume){valueArea.push(b);acc+=b.volume;if(acc>=total*0.70)break;}}
  const val=valueArea.length?Math.min(...valueArea.map(b=>b.price)):null;
  const vah=valueArea.length?Math.max(...valueArea.map(b=>b.price)):null;
  const highVolumeNodes=byVolume.slice(0,3).map(b=>({price:b.price,volume:b.volume,share_pct:round(b.volume/total*100,1)}));
  const positiveVolumes=sorted.map(b=>b.volume).filter(v=>v>0).sort((a,b)=>a-b);
  const q25=positiveVolumes.length?positiveVolumes[Math.floor((positiveVolumes.length-1)*0.25)]:null;
  const lowVolumeNodes=q25==null?[]:sorted.filter(b=>b.volume<=q25).sort((a,b)=>a.volume-b.volume).slice(0,3).map(b=>({price:b.price,volume:b.volume,share_pct:round(b.volume/total*100,1)}));
  const thinZones=[];
  for(let i=1;i<sorted.length;i++){
    const gap=sorted[i].price-sorted[i-1].price;
    if(step!=null && gap>=step*2.5) thinZones.push({from:sorted[i-1].price,to:sorted[i].price,gap_bins:round(gap/step,1)});
  }
  const capturedPct=currentVolume>0?clamp(capturedVolume/currentVolume*100,0,100):0;
  const uniqueBins=sorted.length;
  const confidencePct=round(clamp(observations*3 + capturedPct*0.65 + Math.min(uniqueBins,12)*1.5,0,100),0);
  let status='warming_up';
  if(observations>=24 && capturedPct>=65) status='high_confidence_proxy';
  else if(observations>=12 && capturedPct>=45) status='usable_proxy';
  else if(observations>=6 && capturedPct>=20) status='provisional_proxy';

  let acceptanceScore=null, acceptanceState='insufficient_data', position='unavailable';
  if(total>0 && close!=null && poc!=null && step!=null){
    const nearest=sorted.reduce((best,b)=>Math.abs(b.price-close)<Math.abs(best.price-close)?b:best,sorted[0]);
    const nodeStrength=maxNodeVolume>0?nearest.volume/maxNodeVolume:0;
    const distBins=Math.abs(close-poc)/step;
    const inValue=val!=null&&vah!=null&&close>=val-step*0.5&&close<=vah+step*0.5;
    position=close>vah+step*0.5?'above_value_area':close<val-step*0.5?'below_value_area':'inside_value_area';
    const persistence=Math.min(1,observations/18);
    acceptanceScore=round(clamp(nodeStrength*4 + (inValue?2.5:position==='above_value_area'&&nodeStrength>=0.5?2:0.6) + (distBins<=1?2:distBins<=2?1.2:0.4) + persistence*1.5,0,10),1);
    if(status==='warming_up') acceptanceState='insufficient_data';
    else if(acceptanceScore>=7.5) acceptanceState='accepted';
    else if(acceptanceScore>=5.5) acceptanceState='emerging_acceptance';
    else acceptanceState='rejected_or_thin';
  }

  return {
    method:'snapshot_volume_delta_by_last_price_proxy',
    is_true_exchange_volume_at_price:false,
    source_purity:'same_bridge_execution_source_only',
    purpose:'price_acceptance_and_liquidity_structure_support_not_standalone_execution_signal',
    session_date:cairoDate(now),
    status,
    confidence_pct:confidencePct,
    observations,
    first_sample_at:firstSampleAt,
    last_sample_at:lastSampleAt,
    bin_size:round(step,6),
    current_volume:currentVolume,
    captured_volume:round(capturedVolume,0),
    captured_volume_pct:round(capturedPct,1),
    last_delta_volume:round(deltaVolume,0),
    poc,
    value_area_low:val,
    value_area_high:vah,
    close_position:position,
    distance_to_poc_pct:poc&&close?round((close/poc-1)*100,2):null,
    high_volume_nodes:highVolumeNodes,
    low_volume_nodes:lowVolumeNodes,
    thin_zones:thinZones.slice(0,5),
    acceptance_quality:{score:acceptanceScore,state:acceptanceState},
    bins:sorted
  };
}

function attachVolumeProfiles(rows, previous, now) {
  const priorMap=previousUniverseMap(previous);
  const previousAt=previous?.bridge?.generated_at ? new Date(previous.bridge.generated_at) : null;
  const sameSessionDate=previousAt && !Number.isNaN(previousAt.getTime()) && cairoDate(previousAt)===cairoDate(now);
  const activePhase=['auction','continuous'].includes(marketPhase(now));
  return rows.map(row=>{
    const priorRow=priorMap.get(String(row.symbol||'').toUpperCase());
    const profile=summarizeProfile({row,priorRow,now,sameSessionDate,activePhase});
    return {...row,analytics:{...(row.analytics||{}),volume_profile:profile}};
  });
}

function acceptanceBreadth(rows) {
  const pairs=(rows||[]).map(row=>({row,profile:row.analytics?.volume_profile})).filter(x=>x.profile);
  const usable=pairs.filter(x=>['usable_proxy','high_confidence_proxy'].includes(x.profile.status));
  const accepted=usable.filter(x=>x.profile.acceptance_quality?.state==='accepted');
  const abovePoc=usable.filter(({row,profile})=>num(row.close)!=null && num(profile.poc)!=null && num(row.close)>=num(profile.poc));
  return {
    method:'snapshot_volume_delta_by_last_price_proxy',
    coverage_symbols:pairs.length,
    usable_symbols:usable.length,
    usable_pct:pairs.length?round(usable.length/pairs.length*100,1):0,
    accepted_symbols:accepted.length,
    accepted_pct:usable.length?round(accepted.length/usable.length*100,1):null,
    above_poc_pct:usable.length?round(abovePoc.length/usable.length*100,1):null,
    status:usable.length>=50?'usable':usable.length>=10?'partial':'warming_up'
  };
}

async function main(){
  const now=new Date();
  const previous=await readPreviousSnapshot();
  const [netlify,direct]=await Promise.all([netlifyPath(),directPath()]);
  const cross=compare(netlify,direct);
  let selected=null, mode=null;
  if(netlify.ok && netlify.data.execution_usable===true && (!cross.comparable || cross.agreement)){selected=netlify.data;mode='netlify_validated_by_direct';}
  else if(direct.ok){selected=direct.data;mode=netlify.ok?'direct_due_to_netlify_gate_or_disagreement':'direct_fallback';}
  else if(netlify.ok){selected=netlify.data;mode='netlify_only_degraded';}
  else throw new Error(`all_paths_failed | netlify=${netlify.error} | direct=${direct.error}`);

  selected = {...selected};
  if (direct.ok) {
    const profiledUniverse=attachVolumeProfiles(direct.data.rows,previous,now);
    selected.universe = profiledUniverse;
    selected.universe_count = direct.data.count;
    selected.universe_source = 'direct_tradingview_scanner';
    selected.universe_contract = {
      purpose:'full_symbol_lookup_and_stock_specific_analysis',
      symbol_key:'symbol',
      symbol_full_key:'symbol_full',
      note:'Use data.universe for named-stock lookup even when Netlify is the selected execution bundle.'
    };
    selected.market = {...(selected.market||direct.data.market), acceptance_breadth:acceptanceBreadth(profiledUniverse)};
    selected.analytics_capabilities = {
      ...(selected.analytics_capabilities||{}),
      volume_profile_proxy:{
        available:true,
        method:'snapshot_volume_delta_by_last_price_proxy',
        same_source_only:true,
        true_exchange_volume_at_price:false,
        fields:['poc','value_area_low','value_area_high','high_volume_nodes','low_volume_nodes','thin_zones','acceptance_quality'],
        caveat:'Built from incremental cumulative-volume deltas observed at each Bridge snapshot price. It is a sampling proxy, not exchange tick-by-tick volume-at-price.'
      }
    };
  }
  const symbolCoverage = coverage(selected.universe || candidateRows(selected));

  const canonical={
    bridge:{name:'EGX Resilient Bridge',version:BRIDGE_VERSION,generated_at:now.toISOString(),transport_independent:true,selected_mode:mode,market_phase:marketPhase(now),cross_check:cross,symbol_coverage:symbolCoverage,
      acceptance_map:{enabled:direct.ok,method:'snapshot_volume_delta_by_last_price_proxy',previous_snapshot_loaded:Boolean(previous),session_date:cairoDate(now)}},
    path_health:{netlify:{ok:netlify.ok,latency_ms:netlify.latency_ms,error:netlify.error??null,core_version:netlify.data?.version??null,execution_usable:netlify.data?.execution_usable??null},direct:{ok:direct.ok,latency_ms:direct.latency_ms,error:direct.error??null,row_count:direct.data?.count??null}},
    data:selected
  };
  const hash=crypto.createHash('sha256').update(JSON.stringify(canonical.data)).digest('hex');
  canonical.bridge.data_sha256=hash;
  await fs.mkdir(OUT.split('/').slice(0,-1).join('/')||'.',{recursive:true});
  await fs.writeFile(OUT,JSON.stringify(canonical,null,2));
  await fs.writeFile(HEALTH_OUT,JSON.stringify({bridge:canonical.bridge,path_health:canonical.path_health},null,2));
  console.log(JSON.stringify({selected_mode:mode,sha256:hash,netlify:canonical.path_health.netlify,direct:canonical.path_health.direct,cross_check:cross,symbol_coverage:symbolCoverage,acceptance_breadth:selected.market?.acceptance_breadth??null}));
}

main().catch(e=>{console.error(e);process.exit(1);});
