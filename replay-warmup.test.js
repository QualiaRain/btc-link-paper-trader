import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchHistoricalRange} from './replay.js';
import {createAccount,ingest} from './engine.js';
const M=60000,S=Date.UTC(2024,0,2),missing=new Set([S-2*M,S-3*M,S-4*M]);
function fixture(){return async url=>{
  const u=new URL(url),link=u.pathname.includes('LINK-USD'),rows=[];
  for(let t=Date.parse(u.searchParams.get('start'));t<=Date.parse(u.searchParams.get('end'));t+=M){
    if(link&&missing.has(t+M))continue;
    rows.push([t/M*60,99,101,100,100,1]);
  }
  return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(rows)};
};}
test('insufficient causal warmup fails explicitly rather than skipping the only LINK decision',async()=>{
  const old=globalThis.fetch;globalThis.fetch=fixture();
  try{await assert.rejects(fetchHistoricalRange({start:S,end:S+M,warmupMinutes:62,historyLimit:61,requiredHistory:61}),/LINK.*60.*61/);}
  finally{globalThis.fetch=old;}
});
test('bounded warmup slack supplies both initial forecasts without changing scored boundaries',async()=>{
  const old=globalThis.fetch;globalThis.fetch=fixture();
  try{
    const r=await fetchHistoricalRange({start:S,end:S+M,warmupMinutes:130,historyLimit:61,requiredHistory:61});
    assert.equal(r.scoreStart,S);assert.equal(r.scoreEnd,S+M);
    for(const asset of ['BTC','LINK']){
      assert.equal(r.frames[0].history[asset].length,61);
      assert.ok(r.frames[0].history[asset].every(x=>x.time<=S));
    }
    const account=createAccount({horizonMs:M,durationMs:M,lookbackIntervals:60});
    for(const f of r.frames)ingest(account,f);
    assert.equal(account.forecasts.filter(f=>f.asset==='BTC').length,1);
    assert.equal(account.forecasts.filter(f=>f.asset==='LINK').length,1);
    assert.equal(account.startedAt,S);
  }finally{globalThis.fetch=old;}
});
