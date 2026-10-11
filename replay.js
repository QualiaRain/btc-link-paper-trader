// Public historical replay only. No orders, credentials, or interpolated prices.
const MINUTE=60000,MAX_DAYS=31,ASSETS=['BTC','LINK'];
const DOC='https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles';
const abort=()=>new DOMException('Request cancelled','AbortError');
function cancelled(signal){if(signal?.aborted)throw abort();}
function wait(ms,signal){return new Promise((resolve,reject)=>{
  cancelled(signal);const end=()=>{signal?.removeEventListener('abort',stop);resolve();};
  const timer=setTimeout(end,ms);function stop(){clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(abort());}
  signal?.addEventListener('abort',stop,{once:true});
});}
function stamp(value){
  if(typeof value==='string'&&!/(Z|\+00:00)$/.test(value))throw new Error('Use explicit UTC date/time');
  const t=typeof value==='number'?value:Date.parse(value);
  if(!Number.isSafeInteger(t)||t%MINUTE)throw new Error('Range endpoints must be UTC minute-close timestamps');
  return t;
}
const iso=t=>new Date(t).toISOString();
async function sha(text){
  const bytes=new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
async function request(url,signal){
  for(let attempt=0;attempt<3;attempt++){
    cancelled(signal);
    const controller=new AbortController();let timedOut=false;
    const stop=()=>controller.abort();signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},15000);
    try{
      const response=await fetch(url,{signal:controller.signal,credentials:'omit',cache:'no-store'});
      const raw=await response.text();
      if(!response.ok){const e=new Error(`Coinbase HTTP ${response.status}`);e.retryable=response.status===429||response.status>=500;throw e;}
      return {rows:JSON.parse(raw),receipt:{url,receivedAt:Date.now(),httpDate:response.headers.get('date'),sha256:await sha(raw),attempts:attempt+1}};
    }catch(error){
      cancelled(signal);
      if(attempt===2||error.retryable===false||error instanceof SyntaxError)throw error;
      if(error.name==='AbortError'&&!timedOut)throw error;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
    await wait(500*2**attempt,signal);
  }
}

export async function fetchHistoricalRange({start,end,halfSpreadBps=2,warmupMinutes=60,historyLimit=8,signal,onProgress=()=>{}}={}){
  const s=stamp(start),e=stamp(end),now=Date.now();
  if(e<=s||e-s>MAX_DAYS*86400000)throw new Error('Choose a positive range of at most 31 days');
  if(e>Math.floor(now/MINUTE)*MINUTE)throw new Error('End must be a completed UTC minute');
  if(!Number.isInteger(warmupMinutes)||warmupMinutes<1||warmupMinutes>1440)throw new Error('warmupMinutes must be 1 to 1440');
  if(!Number.isInteger(historyLimit)||historyLimit<2||historyLimit>241)throw new Error('historyLimit must be 2 to 241');
  if(warmupMinutes<historyLimit-1)throw new Error('Warmup must span at least historyLimit minus one minutes');
  if(typeof halfSpreadBps!=='number'||!Number.isFinite(halfSpreadBps)||halfSpreadBps<0||halfSpreadBps>1000)throw new Error('Invalid assumed half-spread');
  cancelled(signal);
  const began=Date.now(),first=s-warmupMinutes*MINUTE;
  const chunks=[];for(let t=first-MINUTE;t<e;t+=299*MINUTE)chunks.push([t,Math.min(t+299*MINUTE,e)]);
  const total=chunks.length*2,series={},coverage={},provenance=[],rawReceipts=[];
  let completed=0;
  onProgress({phase:'fetch',completed,total,message:'Fetching completed UTC minutes'});
  for(const asset of ASSETS){
    const seen=new Map();let duplicates=0;
    for(const [startTime,endTime]of chunks){
      if(completed)await wait(350,signal);
      const url=`https://api.exchange.coinbase.com/products/${asset}-USD/candles?`+new URLSearchParams({granularity:'60',start:iso(startTime),end:iso(endTime)});
      const {rows,receipt}=await request(url,signal);cancelled(signal);
      if(!Array.isArray(rows))throw new Error(`${asset}: invalid candle response`);
      for(const row of rows){
        if(!Array.isArray(row)||row.length!==6)throw new Error(`${asset}: invalid candle row`);
        const [bucket,low,high,open,close,volume]=row;
        if(!Number.isSafeInteger(bucket)||bucket%60||![low,high,open,close,volume].every(v=>typeof v==='number'&&Number.isFinite(v))||Math.min(low,high,open,close)<=0||volume<0||low>Math.min(open,close)||high<Math.max(open,close))throw new Error(`${asset}: invalid candle values`);
        const time=bucket*1000+MINUTE;
        if(time<first||time>e)continue;
        if(seen.has(time)){
          duplicates++;
          if(JSON.stringify(seen.get(time).raw)!==JSON.stringify(row))throw new Error(`${asset}: conflicting duplicate candle`);
        }else seen.set(time,{time,price:close,raw:row});
      }
      provenance.push({asset,...receipt});rawReceipts.push({asset,...receipt,rows});
      completed++;onProgress({phase:'fetch',completed,total,asset,message:`${asset}: ${completed}/${total} batches`});
    }
    const values=[...seen.values()].sort((a,b)=>a.time-b.time);
    series[asset]=values.map(({time,price})=>({time,price}));
    const missing=[];for(let t=s;t<=e;t+=MINUTE)if(!seen.has(t))missing.push(t);
    coverage[asset]={expectedCount:(e-s)/MINUTE+1,observedCount:(e-s)/MINUTE+1-missing.length,
      missingCount:missing.length,missingTimes:missing,missingFraction:missing.length/((e-s)/MINUTE+1),
      startPresent:seen.has(s),endPresent:seen.has(e),warmupObservedCount:values.filter(r=>r.time<s).length,duplicateRows:duplicates};
  }
  cancelled(signal);
  if(ASSETS.some(a=>!coverage[a].startPresent||!coverage[a].endPresent)){
    const error=new Error('Exact start/end close missing for one or both assets; boundaries were not changed');
    error.coverage=coverage;throw error;
  }
  const maps=Object.fromEntries(ASSETS.map(a=>[a,new Map(series[a].map((r,i)=>[r.time,i]))]));
  const frames=[],half=halfSpreadBps/10000;
  // Store each history observation once. Lazy views avoid duplicating up to241
  // rows per asset per frame in memory; do not JSON-export the entire frames array.
  for(const row of series.BTC){
    if(row.time<s||row.time>e||!maps.LINK.has(row.time))continue;
    const indices={BTC:maps.BTC.get(row.time),LINK:maps.LINK.get(row.time)},quotes={};
    for(const a of ASSETS){const mid=series[a][indices[a]].price;quotes[a]={bid:mid*(1-half),ask:mid*(1+half),mid,
      observedAt:row.time,source:`Historical Coinbase close with ASSUMED ${halfSpreadBps} bps half-spread`,simulatedQuote:true};}
    const frame={time:row.time,quotes};
    Object.defineProperty(frame,'history',{enumerable:true,get:()=>Object.fromEntries(ASSETS.map(a=>[a,series[a].slice(Math.max(0,indices[a]-historyLimit+1),indices[a]+1)]))});
    frames.push(frame);
  }
  onProgress({phase:'complete',completed,total,message:`${frames.length} shared scored minutes`});
  return {source:'Coinbase Exchange public historical one-minute candles',capturedAt:iso(Date.now()),
    periodStart:s,periodEnd:e,scoreStart:s,scoreEnd:e,frames,coverage,provenance,
    assumptions:{halfSpreadBps,spread:'Assumed historical bid/ask; not observed executable quotes',
      missingMinutes:'Only shared observed close timestamps are scored; per-asset histories retain separate observed minutes, never filled.',
      timestamps:'Candle bucket start +60 seconds; actual publication latency not modeled.',
      warmup:'Only frame.history includes pre-start observations; eight observations needed for default trend, 241 for maximum lookback.',
      execution:'Hypothetical fills omit latency, market impact, liquidity and queue position.'},
    documentation:{candles:DOC},
    evidence:{requestedStart:s,requestedEnd:e,warmupMinutes,historyLimit,retrievalElapsedMs:Date.now()-began,
      sharedCount:frames.length,prices:series,rawResponses:rawReceipts,
      storage:'Compact prices and raw responses preserve source evidence. Frames expose lazy history views; export evidence instead of JSON-stringifying all frames.'}};
}
