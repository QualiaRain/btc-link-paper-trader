import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest,getSummary} from './engine.js';
import {signTestPValue,detectableEdgePts,gradeAsset,reportCard,MIN_FORECASTS} from './report-card.js';

const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const stats=(hits,misses,{flat=0,mae=1,samePriceMae=1}={})=>({count:hits+misses+flat,directionHits:hits,directionMisses:misses,directionFlat:flat,mae,samePriceMae});

test('sign test matches exact binomial tails',()=>{
  near(signTestPValue(10,0),2/1024);
  near(signTestPValue(0,10),2/1024);
  near(signTestPValue(5,5),1);
  near(signTestPValue(0,0),1);
  // 20 of 30: two-sided exact p = 0.0987..., cross-checked with BigInt binomial sums.
  near(signTestPValue(20,10),0.09873714670538902,1e-12);
});

test('sign test stays fast and finite for month-long runs',()=>{
  const started=performance.now(),p=signTestPValue(16000,15000);
  assert.ok(performance.now()-started<50);
  assert.ok(p>0&&p<1e-6);
});

test('detectable edge shrinks with more forecasts',()=>{
  near(detectableEdgePts(100),9.8);
  assert.ok(detectableEdgePts(400)<detectableEdgePts(100));
  assert.equal(detectableEdgePts(0),null);
});

test('same-price runs are the baseline and are never graded',()=>{
  assert.equal(gradeAsset(stats(40,0),'same-price').verdict,'baseline');
});

test('no forecasts and too few directional forecasts are not judged',()=>{
  assert.equal(gradeAsset(stats(0,0),'trend').verdict,'none');
  const flatOnly=gradeAsset(stats(0,0,{flat:50}),'trend');
  assert.equal(flatOnly.verdict,'too_few');assert.equal(flatOnly.hitRatePct,null);
  const g=gradeAsset(stats(MIN_FORECASTS-1,0,{flat:50}),'trend');
  assert.equal(g.verdict,'too_few');assert.equal(g.pValue,null);assert.equal(g.decided,MIN_FORECASTS-1);
});

test('a lopsided direction record is better or worse; a near-even one is unclear',()=>{
  const better=gradeAsset(stats(25,5),'trend');
  assert.equal(better.verdict,'better');assert.ok(better.pValue<.025);near(better.hitRatePct,100*25/30);
  assert.equal(gradeAsset(stats(5,25),'trend').verdict,'worse');
  assert.equal(gradeAsset(stats(20,10),'trend').verdict,'unclear');
});

test('per-asset bar is stricter than 5%: p between 0.025 and 0.05 is unclear',()=>{
  const g=gradeAsset(stats(40,22),'trend');
  assert.ok(g.pValue>.025&&g.pValue<.05,`p=${g.pValue}`);
  assert.equal(g.verdict,'unclear');
});

test('summary counts direction hits, misses and flat outcomes',()=>{
  const T=1700000000000,minute=60000;
  const frame=(time,btc,link,hist)=>({time,
    quotes:{BTC:{bid:btc-.01,ask:btc+.01,mid:btc,observedAt:time,source:'fixture'},
      LINK:{bid:link-.01,ask:link+.01,mid:link,observedAt:time,source:'fixture'}},
    history:{BTC:hist,LINK:hist}});
  // Rising history: both forecasts predict a rise from 100.
  const hist=Array.from({length:8},(_,i)=>({time:T-(7-i)*minute,price:100*Math.exp(i*.0005)}));
  const a=createAccount({model:'trend',horizonMs:7*minute,lookbackIntervals:7,durationMs:60*minute});
  ingest(a,frame(T,100,100,hist));
  assert.equal(a.forecasts.length,2);
  // BTC rises (hit); LINK is unchanged (flat outcome).
  ingest(a,frame(T+7*minute,101,100,hist));
  const s=getSummary(a);
  assert.deepEqual([s.perAsset.BTC.directionHits,s.perAsset.BTC.directionMisses,s.perAsset.BTC.directionFlat],[1,0,0]);
  assert.deepEqual([s.perAsset.LINK.directionHits,s.perAsset.LINK.directionMisses,s.perAsset.LINK.directionFlat],[0,0,1]);
  const card=reportCard(s,'trend');
  assert.equal(card.BTC.verdict,'too_few');assert.equal(card.LINK.decided,0);
});

test('on pure random walks the card does not claim skill',()=>{
  // No rule can predict a random walk, so verdicts other than "unclear" should be rare
  // (about 5% of grades by chance). A test that ignores this rate would grade every run "worse".
  let seed=1;const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
  const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());
  const verdicts={},trials=20;
  for (let trial=0;trial<trials;trial++) {
    const h={BTC:[],LINK:[]},p={BTC:60000,LINK:12},frames=[];
    for (let i=0;i<1800;i++) {
      const time=Date.UTC(2026,0,1)+i*60000,quotes={};
      for (const s of ['BTC','LINK']) {
        p[s]*=Math.exp(.0006*gauss());h[s].push({time,price:p[s]});if(h[s].length>20)h[s].shift();
        quotes[s]={bid:p[s]*.9997,ask:p[s]*1.0003,mid:p[s],observedAt:time};
      }
      frames.push({time,quotes,history:{BTC:h.BTC.slice(),LINK:h.LINK.slice()}});
    }
    const a=createAccount({horizonMs:420000,durationMs:frames.at(-1).time-frames[7].time});
    for (const f of frames.slice(7)) ingest(a,f);
    const card=reportCard(getSummary(a),'trend');
    for (const s of ['BTC','LINK']) verdicts[card[s].verdict]=(verdicts[card[s].verdict]??0)+1;
  }
  assert.ok((verdicts.unclear??0)>=2*trials-3,JSON.stringify(verdicts));
});
