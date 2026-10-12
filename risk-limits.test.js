import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount,ingest,manualTrade,getSummary} from './engine.js';
const T=1700000000000,M=60000,NEXT_UTC_DAY=Date.UTC(2023,10,15);
// Same fixture shape as engine.test.js: a rising history makes the trend rule buy.
function frame(time=T,price=100,trend=.001) {
  const q={bid:price-.1,ask:price+.1,mid:price,observedAt:time,source:'fixture'};
  const h=Array.from({length:8},(_,i)=>({time:time-(7-i)*M,price:100*Math.exp(i*trend)}));
  return {time,quotes:{BTC:{...q},LINK:{...q}},history:{BTC:h,LINK:h}};
}
const events=(a,type)=>a.ledger.filter(e=>e.type===type);
const held=a=>a.positions.BTC.qty+a.positions.LINK.qty;

test('limits are off by default and leave account and decision shapes unchanged',()=>{
  const a=createAccount();ingest(a,frame());ingest(a,frame(T+M,90));
  assert.equal(a.config.maxDrawdownBps,0);assert.equal(a.config.dailyLossBps,0);
  assert.equal(a.risk,undefined);assert.ok(held(a)>0);
  assert.ok(events(a,'decision').every(e=>!('blockedBy' in e)&&!('wouldBuy' in e)));
  assert.equal(getSummary(a).riskHalts,0);assert.equal(getSummary(a).tradingHalted,null);
  // Accounts saved before these fields existed keep running with no limits.
  const old=createAccount();delete old.config.maxDrawdownBps;delete old.config.dailyLossBps;
  ingest(old,frame());ingest(old,frame(T+M,90));assert.equal(old.risk,undefined);assert.ok(held(old)>0);
});

test('drawdown breach at an observed frame closes positions and stops entries for the session',()=>{
  const a=createAccount({maxDrawdownBps:500});ingest(a,frame());
  assert.ok(held(a)>0,'fixture should open positions');
  ingest(a,frame(T+M,99));assert.equal(events(a,'risk_halt').length,0,'1% loss is inside a 5% limit');
  ingest(a,frame(T+2*M,90));
  const [halt]=events(a,'risk_halt');
  assert.equal(halt.limit,'max_drawdown');assert.equal(halt.referenceValue,1000);
  // Checked only at observations: the recorded loss can exceed the threshold.
  assert.ok(halt.netLiquidation<1000*(1-.05));
  assert.equal(held(a),0);assert.equal(a.risk.killedAt,T+2*M);
  assert.equal(getSummary(a).tradingHalted,'max_drawdown');
  assert.throws(()=>manualTrade(a,'BTC','buy',100,frame(T+3*M,90)),/Drawdown limit/);
  // Later decisions still issue scored forecasts, keep cash and record the blocked intent.
  const forecasts=a.forecasts.length,trades=events(a,'trade').length;
  ingest(a,frame(T+7*M,90));ingest(a,frame(NEXT_UTC_DAY+M,90));
  assert.equal(a.forecasts.length,forecasts+4);assert.equal(events(a,'trade').length,trades);
  const blocked=events(a,'decision').slice(-4);
  assert.ok(blocked.every(e=>e.action==='cash'&&e.blockedBy==='max_drawdown'&&e.wouldBuy===true));
  assert.equal(events(a,'risk_resume').length,0,'a drawdown halt does not lift on a new UTC day');
});

test('daily loss halt blocks entries until the next UTC day, then trading resumes',()=>{
  const a=createAccount({dailyLossBps:500});ingest(a,frame());ingest(a,frame(T+M,90));
  const [halt]=events(a,'risk_halt');
  assert.equal(halt.limit,'daily_loss');assert.equal(halt.resumesAt,NEXT_UTC_DAY);
  assert.equal(held(a),0);
  ingest(a,frame(T+7*M,90));
  assert.ok(events(a,'decision').slice(-2).every(e=>e.blockedBy==='daily_loss'&&e.action==='cash'));
  assert.throws(()=>manualTrade(a,'LINK','buy',100,frame(T+8*M,90)),/Daily loss limit/);
  const flat=a.cash;ingest(a,frame(NEXT_UTC_DAY+M,90));
  assert.equal(events(a,'risk_resume').length,1);assert.equal(a.risk.haltedUntil,null);
  assert.equal(a.risk.dayOpenValue,flat,'new day opens from the observed flat value');
  assert.ok(held(a)>0,'rule buys again after the halt lifts');
  assert.ok(events(a,'decision').slice(-2).every(e=>e.action==='buy'&&!('blockedBy' in e)));
  assert.equal(getSummary(a).riskHalts,1);assert.equal(getSummary(a).tradingHalted,null);
});

test('daily loss is measured from the UTC day opening value, not the session start',()=>{
  // A 24-hour horizon holds the manual position across midnight with no decision closing it.
  // Each day loses about 4% (inside 5%); the same 7.8% path inside one UTC day trips the limit.
  const run=times=>{
    const a=createAccount({dailyLossBps:500,model:'same-price',horizonMs:86400000});
    ingest(a,frame());manualTrade(a,'BTC','buy',1000,frame());
    ingest(a,frame(times[0],96.4));ingest(a,frame(times[1],96.4));ingest(a,frame(times[2],92.6));
    return a;
  };
  const acrossDays=run([T+M,NEXT_UTC_DAY+M,NEXT_UTC_DAY+2*M]);
  assert.equal(events(acrossDays,'risk_halt').length,0);
  assert.ok(acrossDays.positions.BTC.qty>0&&getSummary(acrossDays).equity<0.93*1000);
  const sameDay=run([T+M,T+2*M,T+3*M]);
  assert.equal(events(sameDay,'risk_halt').length,1);assert.equal(sameDay.positions.BTC.qty,0);
});
