import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest} from './engine.js';

const T=1700000000000,minute=60000;
const quote=(price,observedAt)=>({bid:price-.01,ask:price+.01,mid:price,observedAt,source:'fixture'});
const hist=time=>Array.from({length:8},(_,i)=>({time:time-(7-i)*minute,price:100*Math.exp(i*.0005)}));
// LINK's quote can lag behind the frame time; BTC's is always fresh.
const frame=(time,linkObservedAt=time)=>({time,quotes:{BTC:quote(100,time),LINK:quote(100,linkObservedAt)},
  history:{BTC:hist(time),LINK:hist(Math.min(time,linkObservedAt))}});

test('a forecast held pending by a stale quote settles later, after newer forecasts settled past it',()=>{
  const a=createAccount({horizonMs:minute,lookbackIntervals:7,durationMs:60*minute,maxQuoteAgeMs:10*minute,maxOutcomeLatenessMs:10*minute});
  ingest(a,frame(T));
  const [btc0,link0]=a.forecasts;
  assert.equal(link0.asset,'LINK');
  // LINK's quote stays at T for three minutes, so its first target (T+1m) has no qualifying observation.
  for (const m of [1,2,3]) ingest(a,frame(T+m*minute,T));
  assert.equal(btc0.status,'settled');
  assert.equal(link0.status,'pending');
  assert.ok(a.forecasts.some(f=>f.asset==='BTC'&&f.issuedAt>T&&f.status==='settled'),'newer BTC forecasts settled past it');
  // A fresh LINK quote arrives; the held forecast settles with its lateness recorded.
  ingest(a,frame(T+4*minute));
  assert.equal(link0.status,'settled');
  assert.equal(link0.latenessMs,3*minute);
  const order=a.ledger.filter(e=>e.type==='forecast_settled').map(e=>e.forecastId);
  assert.equal(new Set(order).size,order.length,'each forecast settles once');
});

test('restoring an account from saved JSON keeps settling correctly',()=>{
  const a=createAccount({horizonMs:minute,lookbackIntervals:7,durationMs:60*minute,maxQuoteAgeMs:10*minute,maxOutcomeLatenessMs:10*minute});
  ingest(a,frame(T));ingest(a,frame(T+minute,T));
  const restored=JSON.parse(JSON.stringify(a));
  for (const acct of [a,restored]) {ingest(acct,frame(T+2*minute,T));ingest(acct,frame(T+3*minute));}
  assert.deepEqual(restored,JSON.parse(JSON.stringify(a)));
  assert.ok(restored.forecasts.filter(f=>f.asset==='LINK'&&f.issuedAt===T)[0].status==='settled');
});
