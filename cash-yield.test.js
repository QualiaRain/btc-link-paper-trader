import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest,manualTrade,getSummary} from './engine.js';
const T=Date.UTC(2026,0,1),DAY=86400000;
// Quotes only; the same-price rule never trades, so cash stays idle unless a test buys.
function frame(time,price=100){const q={bid:price-.1,ask:price+.1,mid:price,observedAt:time};
  return {time,quotes:{BTC:{...q},LINK:{...q}},history:{BTC:[],LINK:[]}};}
const near=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('zero yield leaves cash, the cash line and the account shape unchanged',()=>{
  const a=createAccount({model:'same-price',durationMs:366*DAY});
  ingest(a,frame(T));ingest(a,frame(T+30*DAY));
  assert.equal(a.config.cashYieldBps,0);assert.equal(a.cash,1000);assert.equal('interest' in a,false);
  assert.equal(a.equity.at(-1).cashValue,1000);
  const s=getSummary(a);assert.equal(s.cashBenchmark,1000);assert.equal(s.interestEarned,0);
});

test('idle cash compounds continuously over elapsed time, including unobserved gaps',()=>{
  const a=createAccount({model:'same-price',durationMs:366*DAY,cashYieldBps:500});
  ingest(a,frame(T));ingest(a,frame(T+DAY));ingest(a,frame(T+365*DAY)); // a 364-day gap
  near(a.cash,1000*Math.exp(.05));near(a.interest,1000*(Math.exp(.05)-1));
  near(a.equity.at(-1).cashValue,1000*Math.exp(.05));
  const s=getSummary(a);near(s.cashBenchmark,1000*Math.exp(.05));near(s.equity,1000*Math.exp(.05));
});

test('invested money earns nothing and completed sessions stop accruing',()=>{
  const a=createAccount({model:'same-price',durationMs:10*DAY,horizonMs:20*DAY,cashYieldBps:1000}); // no decision closes the buy early
  ingest(a,frame(T));manualTrade(a,'BTC','buy',1e9,frame(T));
  assert.equal(a.cash,0);ingest(a,frame(T+5*DAY));assert.equal(a.cash,0);assert.equal('interest' in a,false);
  ingest(a,frame(T+10*DAY));assert.equal(a.status,'completed');
  const cash=a.cash;ingest(a,frame(T+20*DAY));assert.equal(a.cash,cash);
});

test('yield is validated and older saved configs without it run at zero',()=>{
  assert.throws(()=>createAccount({cashYieldBps:-1}),/cashYieldBps/);
  assert.throws(()=>createAccount({cashYieldBps:2001}),/cashYieldBps/);
  const old=createAccount({model:'same-price',durationMs:366*DAY});delete old.config.cashYieldBps;
  ingest(old,frame(T));ingest(old,frame(T+DAY));assert.equal(old.cash,1000);assert.equal(old.equity.at(-1).cashValue,1000);
});
