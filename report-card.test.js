import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest,getSummary} from './engine.js';
import {signTestPValue,gradeAsset,reportCard,MIN_FORECASTS} from './report-card.js';

const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const stats=(wins,losses,{ties=0,mae=1,samePriceMae=1}={})=>({count:wins+losses+ties,modelCloser:wins,samePriceCloser:losses,ties,mae,samePriceMae});

test('sign test matches exact binomial tails',()=>{
  near(signTestPValue(10,0),2/1024);
  near(signTestPValue(0,10),2/1024);
  near(signTestPValue(5,5),1);
  near(signTestPValue(0,0),1);
  // 20 of 30: two-sided exact p = 0.0987...
  near(signTestPValue(20,10),0.09873714670538902,1e-12);
});

test('same-price runs are the baseline and are never graded',()=>{
  assert.equal(gradeAsset(stats(40,0,{mae:.5}),'same-price').verdict,'baseline');
});

test('no forecasts and too few decided forecasts are not judged',()=>{
  assert.equal(gradeAsset(stats(0,0),'trend').verdict,'none');
  const g=gradeAsset(stats(MIN_FORECASTS-1,0,{ties:50,mae:.5}),'trend');
  assert.equal(g.verdict,'too_few');assert.equal(g.pValue,null);assert.equal(g.decided,MIN_FORECASTS-1);
});

test('a lopsided split with smaller misses is better, the reverse is worse',()=>{
  const better=gradeAsset(stats(25,5,{mae:.8,samePriceMae:1}),'trend');
  assert.equal(better.verdict,'better');assert.ok(better.pValue<.05);near(better.maeChangePct,-20);
  assert.equal(gradeAsset(stats(5,25,{mae:1.2,samePriceMae:1}),'trend').verdict,'worse');
});

test('a split coin flips easily produce is no clear difference, even with smaller misses',()=>{
  const g=gradeAsset(stats(20,10,{mae:.5,samePriceMae:1}),'trend');
  assert.equal(g.verdict,'unclear');assert.ok(g.pValue>.05);
});

test('closer more often but larger average misses is mixed',()=>{
  assert.equal(gradeAsset(stats(25,5,{mae:1.5,samePriceMae:1}),'trend').verdict,'mixed');
  assert.equal(gradeAsset(stats(5,25,{mae:.5,samePriceMae:1}),'trend').verdict,'mixed');
});

test('summary counts which forecast landed closer, with equal errors as ties',()=>{
  const T=1700000000000,minute=60000;
  const frame=(time,price,hist)=>({time,
    quotes:Object.fromEntries(['BTC','LINK'].map(s=>[s,{bid:price-.01,ask:price+.01,mid:price,observedAt:time,source:'fixture'}])),
    history:{BTC:hist,LINK:hist.map(r=>({...r,price:100}))}});
  // BTC history rises, so its trend forecast is above 100; LINK history is flat, so its forecast equals the baseline.
  const hist=Array.from({length:8},(_,i)=>({time:T-(7-i)*minute,price:100*Math.exp(i*.0005)}));
  const a=createAccount({model:'trend',horizonMs:7*minute,lookbackIntervals:7,durationMs:60*minute});
  ingest(a,frame(T,100,hist));
  const issued=a.forecasts.length;assert.equal(issued,2);
  ingest(a,frame(T+7*minute,101,hist));
  const s=getSummary(a);
  assert.deepEqual([s.perAsset.BTC.modelCloser,s.perAsset.BTC.samePriceCloser,s.perAsset.BTC.ties],[1,0,0]);
  assert.deepEqual([s.perAsset.LINK.modelCloser,s.perAsset.LINK.samePriceCloser,s.perAsset.LINK.ties],[0,0,1]);
  const card=reportCard(s,'trend');
  assert.equal(card.BTC.verdict,'too_few');assert.equal(card.LINK.decided,0);
});
