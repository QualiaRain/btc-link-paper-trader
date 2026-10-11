import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest,manualTrade,getSummary} from './engine.js';
const T=1700000000000;
function frame(time=T,price=100,trend=.001) {
  const q={bid:price-.1,ask:price+.1,mid:price,observedAt:time,source:'fixture'};
  const h=Array.from({length:8},(_,i)=>({time:time-(7-i)*60000,price:100*Math.exp(i*trend)}));
  return {time,quotes:{BTC:{...q},LINK:{...q}},history:{BTC:h,LINK:h}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('buy fills at ask plus slippage, total spend includes fees, liquidation includes sell costs',()=>{
  const a=createAccount({model:'same-price'}),f=frame();ingest(a,f);manualTrade(a,'BTC','buy',100,f);
  const qty=100/(1.001*100.1*1.0002);near(a.positions.BTC.qty,qty);near(a.cash,900);
  near(getSummary(a).equity,900+qty*99.9*.9998*.999);
  manualTrade(a,'BTC','sell',10000,f);near(a.positions.BTC.qty,0);near(a.cash,900+qty*99.9*.9998*.999);
});
test('manual orders cannot spend more cash or sell more than owned',()=>{
  const a=createAccount({model:'same-price'}),f=frame();manualTrade(a,'LINK','buy',1e9,f);near(a.cash,0);
  manualTrade(a,'LINK','sell',1e9,f);near(a.positions.LINK.qty,0);assert.ok(a.cash<1000&&a.cash>990);
  const prior=a.cash;manualTrade(a,'LINK','sell',1e9,f);near(a.cash,prior);
});
test('buy and hold uses same cost assumptions and 50/50 initial allocations',()=>{
  const a=createAccount({model:'same-price'});ingest(a,frame());
  near(a.baseline.cash,0);near(a.baseline.positions.BTC.qty,a.baseline.positions.LINK.qty);
  near(getSummary(a).buyHoldEquity,1000*(99.9*.9998*.999)/(100.1*1.0002*1.001));
  near(getSummary(a).equity,1000);
});
test('future history cannot affect frozen predictions',()=>{
  const a=createAccount(),b=createAccount(),f=frame(),g=frame();
  for(const s of ['BTC','LINK'])g.history[s].push({time:T+1,price:1e10});
  ingest(a,f);ingest(b,g);assert.deepEqual(a.forecasts,b.forecasts);
});
test('duplicate and out of order frames produce no fills or forecasts',()=>{
  const a=createAccount();ingest(a,frame());const snapshot=JSON.stringify(a);
  ingest(a,frame());ingest(a,frame(T-1000));assert.equal(JSON.stringify(a),snapshot);
});
test('forecasts pending until subsequent target observation, lateness exposed',()=>{
  const a=createAccount();ingest(a,frame());assert.equal(a.forecasts[0].status,'pending');
  ingest(a,frame(T+419999));assert.equal(a.forecasts[0].status,'pending');
  const f=frame(T+420001);f.quotes.BTC.observedAt=T+419999;ingest(a,f);assert.equal(a.forecasts[0].status,'pending');
  ingest(a,frame(T+421000));assert.equal(a.forecasts[0].latenessMs,1000);
});
test('stale quotes are rejected, live resume records gap without backfilled trades',()=>{
  const a=createAccount({mode:'live'});ingest(a,frame());
  const f=frame(T+60001);f.quotes.BTC.observedAt=T;const n=a.forecasts.length;ingest(a,f);assert.equal(a.forecasts.length,n);
  ingest(a,frame(T+3600000));assert.equal(a.forecasts.length,4);assert.ok(a.ledger.some(e=>e.type==='gap'));
});
test('sparse history scales actual elapsed time; insufficient history stays cash',()=>{
  const a=createAccount(),b=createAccount(),f=frame(),g=frame();
  for(const s of ['BTC','LINK'])g.history[s]=g.history[s].map(r=>({...r,time:T-(T-r.time)*2}));
  ingest(a,f);ingest(b,g);near(Math.log(a.forecasts[0].prediction/100),2*Math.log(b.forecasts[0].prediction/100));
  const c=createAccount();f.history={BTC:[],LINK:[]};ingest(c,f);near(c.cash,1000);assert.equal(c.forecasts.length,0);
});
test('duration closes positions once with actual observed prices and stops',()=>{
  const a=createAccount({durationMs:420000});ingest(a,frame());ingest(a,frame(T+421000));
  assert.equal(a.status,'completed');near(a.positions.BTC.qty,0);near(a.positions.LINK.qty,0);
  const n=a.ledger.length;ingest(a,frame(T+500000));assert.equal(a.ledger.length,n);
});
test('manual future frame cannot be followed by an earlier automated decision',()=>{
  const a=createAccount({model:'same-price'});ingest(a,frame());manualTrade(a,'BTC','buy',10,frame(T+1000));
  const saved=JSON.stringify(a);ingest(a,frame(T+500));assert.equal(JSON.stringify(a),saved);
});
test('completed session may resolve late final quote without reopening trading',()=>{
  const a=createAccount({durationMs:420000});ingest(a,frame());
  const f=frame(T+420000);f.quotes.BTC.observedAt=T+419999;ingest(a,f);
  assert.equal(a.status,'completed');assert.equal(a.forecasts[0].status,'pending');
  const equity=a.equity.at(-1).value,n=a.ledger.filter(e=>e.type==='trade').length;
  ingest(a,frame(T+421000));assert.equal(a.forecasts[0].status,'settled');
  near(a.equity.at(-1).value,equity);assert.equal(a.ledger.filter(e=>e.type==='trade').length,n);
});
test('late outcome expires without an actual or MAE score',()=>{
  const a=createAccount({horizonMs:60000,durationMs:48*3600000,model:'same-price'});
  ingest(a,frame());ingest(a,frame(T+24*3600000));
  const f=a.forecasts[0],s=getSummary(a);
  assert.equal(f.status,'expired');assert.equal(f.latenessMs,24*3600000-60000);
  assert.equal(f.actual,null);assert.equal(f.absoluteError,undefined);
  assert.equal(s.expiredForecasts,2);assert.equal(s.settledForecasts,0);
  assert.equal(s.pendingForecasts,2);assert.equal(s.mae,null);
  assert.ok(a.ledger.some(e=>e.type==='forecast_expired'));
});
test('missing next minute expires a minute forecast; tolerance boundary is inclusive',()=>{
  const a=createAccount({horizonMs:60000,model:'same-price'});
  ingest(a,frame());ingest(a,frame(T+120000));assert.equal(a.forecasts[0].status,'expired');
  const b=createAccount({horizonMs:60000,model:'same-price'});
  ingest(b,frame());ingest(b,frame(T+90000));assert.equal(b.forecasts[0].status,'settled');
});
test('manual newer frame first settles and processes due auto action exactly once',()=>{
  const a=createAccount({horizonMs:60000,model:'same-price'});ingest(a,frame());
  manualTrade(a,'BTC','buy',10,frame(T+60000));
  assert.equal(a.forecasts[0].status,'settled');assert.equal(a.forecasts.length,4);
  assert.equal(a.lastDecisionAt,T+60000);assert.equal(a.ledger.at(-1).actor,'manual');
  const before=JSON.stringify(a);ingest(a,frame(T+60000));assert.equal(JSON.stringify(a),before);
});
