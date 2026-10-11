import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchHistoricalRange} from './market.js';
const S=Date.UTC(2024,0,1,1),M=60000;
function mockedFetch({gapAsset,gapAt,missingBoundary=false,conflict=false}={}){
  let count=0;
  const fetch=async url=>{
    count++;const u=new URL(url),asset=u.pathname.includes('BTC-USD')?'BTC':'LINK';
    const start=Date.parse(u.searchParams.get('start')),end=Date.parse(u.searchParams.get('end')),rows=[];
    assert.ok((end-start)/M<=299);
    for(let t=start;t<=end;t+=M){
      if((asset===gapAsset&&t+M===gapAt)||(missingBoundary&&asset==='LINK'&&t+M===S))continue;
      rows.push([t/1000,99,101,100,100,1]);
    }
    if(conflict)rows.push([rows[0][0],98,102,100,101,1]);
    return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(rows)};
  };
  return {fetch,get count(){return count;}};
}
test('date range uses exact boundaries, warmup only in causal history, no gap fill',async()=>{
  const mock=mockedFetch({gapAsset:'LINK',gapAt:S+M}),prior=globalThis.fetch;globalThis.fetch=mock.fetch;
  try{
    const r=await fetchHistoricalRange({start:S,end:S+3*M,warmupMinutes:8,historyLimit:8});
    assert.deepEqual(r.frames.map(f=>f.time),[S,S+2*M,S+3*M]);
    assert.equal(r.coverage.LINK.missingCount,1);assert.equal(r.coverage.BTC.missingCount,0);
    assert.equal(r.frames[0].history.BTC.length,8);assert.ok(r.frames[0].history.BTC[0].time<S);
    for(const f of r.frames)for(const a of ['BTC','LINK'])assert.ok(f.history[a].every(row=>row.time<=f.time));
    assert.equal(r.evidence.prices.BTC.length,r.evidence.prices.LINK.length+1);
    assert.equal(r.provenance.length,2);assert.match(r.provenance[0].sha256,/^[a-f0-9]{64}$/);
    assert.equal(r.frames[0].quotes.BTC.bid,99.98);
  }finally{globalThis.fetch=prior;}
});
test('missing endpoint errors without moving the requested boundary',async()=>{
  const prior=globalThis.fetch;globalThis.fetch=mockedFetch({missingBoundary:true}).fetch;
  try{await assert.rejects(fetchHistoricalRange({start:S,end:S+M}),/Exact start\/end/);}finally{globalThis.fetch=prior;}
});
test('bad range and cancelled request make no network call',async()=>{
  const prior=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw new Error('unexpected');};
  try{
    for(const opts of [{start:S,end:S},{start:S,end:S+32*86400000},{start:S+1,end:S+M},{start:'2024-01-01T00:00:00',end:S},{start:S,end:S+M,historyLimit:242}])await assert.rejects(fetchHistoricalRange(opts));
    const controller=new AbortController();controller.abort();await assert.rejects(fetchHistoricalRange({start:S,end:S+M,signal:controller.signal}),{name:'AbortError'});
    assert.equal(calls,0);
  }finally{globalThis.fetch=prior;}
});
test('pagination stays within 300 buckets and progress supports mid-fetch cancellation',async()=>{
  const prior=globalThis.fetch,mock=mockedFetch();globalThis.fetch=mock.fetch;
  try{
    const seen=[];const r=await fetchHistoricalRange({start:S,end:S+300*M,warmupMinutes:8,onProgress:p=>seen.push(p)});
    assert.equal(mock.count,4);assert.equal(r.frames.length,301);assert.equal(seen.at(-1).phase,'complete');
    const controller=new AbortController();const before=mock.count;
    await assert.rejects(fetchHistoricalRange({start:S,end:S+M,signal:controller.signal,onProgress:p=>{if(p.completed===1)controller.abort();}}),{name:'AbortError'});
    assert.equal(mock.count-before,1);
  }finally{globalThis.fetch=prior;}
});
test('conflicting duplicates fail rather than silently selecting a price',async()=>{
  const prior=globalThis.fetch;globalThis.fetch=mockedFetch({conflict:true}).fetch;
  try{await assert.rejects(fetchHistoricalRange({start:S,end:S+M}),/conflicting duplicate/);}finally{globalThis.fetch=prior;}
});
