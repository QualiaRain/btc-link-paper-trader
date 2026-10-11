// Deterministic paper ledger. All prices and clocks are supplied by the caller.
export const ASSETS = ['BTC', 'LINK'];
const iso = t => new Date(t).toISOString();
const finite = x => typeof x === 'number' && Number.isFinite(x);
const defaults = { initialCash: 1000, horizonMs: 420000, feeBps: 10, slippageBps: 2,
  bufferBps: 10, model: 'trend', mode: 'replay', durationMs: 48*3600000, maxQuoteAgeMs: 60000,
  maxOutcomeLatenessMs: 30000 };

export function createAccount(config = {}) {
  const c = {...defaults, ...config};
  for (const key of ['initialCash','horizonMs','durationMs','maxQuoteAgeMs'])
    if (!finite(c[key]) || c[key] <= 0) throw new Error(`Invalid ${key}`);
  if (!finite(c.maxOutcomeLatenessMs) || c.maxOutcomeLatenessMs < 0) throw new Error('Invalid maxOutcomeLatenessMs');
  for (const key of ['feeBps','slippageBps','bufferBps'])
    if (!finite(c[key]) || c[key] < 0 || c[key] >= 10000) throw new Error(`Invalid ${key}`);
  if (!['trend','same-price'].includes(c.model) || !['live','replay'].includes(c.mode)) throw new Error('Invalid model or mode');
  return {config:c,cash:c.initialCash,positions:{BTC:{qty:0},LINK:{qty:0}},ledger:[],forecasts:[],equity:[],
    startedAt:null,endsAt:null,lastDecisionAt:null,lastFrameAt:null,lastValidFrameAt:null,status:'ready',
    baseline:{cash:c.initialCash,positions:{BTC:{qty:0},LINK:{qty:0}}},sequence:0};
}

function event(a,type,time,details={}) {
  a.ledger.push({id:++a.sequence,type,time,at:iso(time),...details});
}

function quoteOK(a,q,time) {
  return q && ['bid','ask','mid','observedAt'].every(k=>finite(q[k])) && q.bid>0 &&
    q.ask>=q.bid && q.mid>=q.bid && q.mid<=q.ask && q.observedAt<=time &&
    time-q.observedAt<=a.config.maxQuoteAgeMs;
}

function validFrame(a,f) {
  return f && finite(f.time) && ASSETS.every(s=>quoteOK(a,f.quotes?.[s],f.time));
}

function prices(a,q) {
  const s=a.config.slippageBps/10000, f=a.config.feeBps/10000;
  return {buy:q.ask*(1+s),sell:q.bid*(1-s),fee:f};
}

function fill(a,book,asset,side,dollars,frame,actor) {
  const q=frame.quotes[asset], p=prices(a,q);
  let qty,notional,fee,total;
  if (side==='buy') {
    total=Math.min(dollars,book.cash);
    if (!(total>1e-10)) return;
    notional=total/(1+p.fee);qty=notional/p.buy;fee=total-notional;
    book.cash-=total;book.positions[asset].qty+=qty;
  } else {
    // Sell dollars denotes desired net proceeds, capped by the existing position.
    qty=Math.min(book.positions[asset].qty,dollars/(p.sell*(1-p.fee)));
    if (!(qty>1e-14)) return;
    notional=qty*p.sell;fee=notional*p.fee;total=notional-fee;
    book.positions[asset].qty-=qty;book.cash+=total;
  }
  book.cash=Math.max(0,book.cash);
  if (book.positions[asset].qty<1e-14) book.positions[asset].qty=0;
  event(a,'trade',frame.time,{actor,asset,side,qty,price:side==='buy'?p.buy:p.sell,
    fee,notional,cashDelta:side==='buy'?-total:total,quoteObservedAt:q.observedAt,
    quoteAt:iso(q.observedAt),source:q.source??'unspecified'});
}

function liquidation(a,book,frame) {
  return book.cash+ASSETS.reduce((sum,s)=>{
    const p=prices(a,frame.quotes[s]);return sum+book.positions[s].qty*p.sell*(1-p.fee);
  },0);
}

function start(a,frame) {
  if (a.startedAt!==null) return;
  a.startedAt=frame.time;a.endsAt=frame.time+a.config.durationMs;a.status='running';
  event(a,'start',frame.time,{actor:'system',mode:a.config.mode,config:{...a.config}});
  const budget=a.config.initialCash/2;
  for (const s of ASSETS) fill(a,a.baseline,s,'buy',budget,frame,'benchmark');
}

function mark(a,frame) {
  const point={time:frame.time,at:iso(frame.time),value:liquidation(a,a,frame),
    buyHoldValue:liquidation(a,a.baseline,frame),cashValue:a.config.initialCash};
  if (a.equity.at(-1)?.time===frame.time) a.equity[a.equity.length-1]=point;
  else a.equity.push(point);
}

function prediction(a,asset,frame) {
  const anchor=frame.quotes[asset].mid;
  if (a.config.model==='same-price') return {anchor,prediction:anchor,historyEnd:null};
  // Each history timestamp is a completed minute's availability time. Conflicting
  // duplicate timestamps are rejected; sparse observations use real elapsed time.
  const seen=new Map();
  for (const row of frame.history?.[asset]??[]) {
    if (!finite(row.time)||row.time>frame.time||!finite(row.price)||row.price<=0) continue;
    if (seen.has(row.time)&&seen.get(row.time)!==row.price) return null;
    seen.set(row.time,row.price);
  }
  const rows=[...seen].sort((x,y)=>x[0]-y[0]);
  if (rows.length<8) return null;
  const last=rows.at(-1),past=rows.at(-8),elapsed=last[0]-past[0];
  if (!(elapsed>0) || frame.time-last[0]>Math.max(120000,a.config.maxQuoteAgeMs)) return null;
  const drift=Math.max(-.03,Math.min(.03,Math.log(last[1]/past[1])*a.config.horizonMs/elapsed));
  return {anchor,prediction:anchor*Math.exp(drift),historyEnd:last[0]};
}

function settle(a,frame) {
  for (const f of a.forecasts) {
    const q=frame.quotes[f.asset];
    if (f.status!=='pending'||frame.time<=f.issuedAt||frame.time<f.targetAt||q.observedAt<f.targetAt) continue;
    const lateness=q.observedAt-f.targetAt;
    if (lateness>a.config.maxOutcomeLatenessMs) {
      f.status='expired';f.observedAt=q.observedAt;f.observationAt=iso(q.observedAt);
      f.processedAt=frame.time;f.latenessMs=lateness;
      f.reason='First eligible observation exceeded the preconfigured outcome lateness tolerance';
      event(a,'forecast_expired',frame.time,{actor:'system',forecastId:f.id,asset:f.asset,
        targetAt:f.targetAt,observedAt:f.observedAt,latenessMs:lateness,
        maxOutcomeLatenessMs:a.config.maxOutcomeLatenessMs,reason:f.reason});
      continue;
    }
    f.status='settled';f.observedAt=q.observedAt;f.observationAt=iso(q.observedAt);
    f.processedAt=frame.time;f.actual=q.mid;f.latenessMs=q.observedAt-f.targetAt;
    f.absoluteError=Math.abs(f.prediction-f.actual);f.baselineAbsoluteError=Math.abs(f.anchor-f.actual);
    event(a,'forecast_settled',frame.time,{actor:'system',forecastId:f.id,asset:f.asset,
      targetAt:f.targetAt,observedAt:f.observedAt,latenessMs:f.latenessMs});
  }
}

function close(a,frame,actor) {
  for (const s of ASSETS) fill(a,a,s,'sell',Number.MAX_VALUE,frame,actor);
}

export function ingest(a,frame) {
  if (!frame||!finite(frame.time)) throw new Error('Invalid frame time');
  if (a.lastFrameAt!==null&&frame.time<=a.lastFrameAt) return a;
  if (!validFrame(a,frame)) {
    event(a,'invalid_frame',frame.time,{actor:'system',reason:'Missing, stale, future or invalid quote; no fill or equity mark'});
    a.lastFrameAt=frame.time;return a;
  }
  if (a.status==='completed') {
    // A final target may not have a qualifying quote in the completion frame.
    // Resolve later evidence without reopening trading or revising final equity.
    settle(a,frame);a.lastFrameAt=frame.time;a.lastValidFrameAt=frame.time;return a;
  }
  start(a,frame);
  if (a.config.mode==='live'&&a.lastValidFrameAt!==null&&frame.time-a.lastValidFrameAt>Math.min(a.config.horizonMs,120000))
    event(a,'gap',frame.time,{actor:'system',gapMs:frame.time-a.lastValidFrameAt,
      reason:'No intervening fills simulated; resumed at observed quotes'});
  settle(a,frame);
  if (frame.time>=a.endsAt) {
    close(a,frame,'auto');a.status='completed';event(a,'complete',frame.time,{actor:'system',lateByMs:frame.time-a.endsAt});
  } else if (a.lastDecisionAt===null||frame.time-a.lastDecisionAt>=a.config.horizonMs) {
    close(a,frame,'auto');
    const budget=a.cash/2;
    for (const asset of ASSETS) {
      const pred=prediction(a,asset,frame);
      if (!pred) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Insufficient, stale or conflicting completed history'});continue;}
      const targetAt=frame.time+a.config.horizonMs;
      if (targetAt>a.endsAt) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Horizon extends past session end'});continue;}
      const f={id:`f${a.forecasts.length+1}`,asset,model:a.config.model,issuedAt:frame.time,
        issueAt:iso(frame.time),targetAt,targetTime:iso(targetAt),...pred,status:'pending',
        observedAt:null,actual:null,latenessMs:null};
      a.forecasts.push(f);
      const p=prices(a,frame.quotes[asset]);
      // Forecast applies to mid. Assume current bid/mid ratio at the future exit,
      // retaining spread, both slippage charges and both fees in the hurdle.
      const expectedNetRatio=(pred.prediction/pred.anchor)*(p.sell/p.buy)*(1-p.fee)/(1+p.fee);
      const buy=expectedNetRatio>1+a.config.bufferBps/10000;
      event(a,'decision',frame.time,{actor:'auto',asset,forecastId:f.id,action:buy?'buy':'cash',
        expectedNetRatio,requiredNetRatio:1+a.config.bufferBps/10000});
      if (buy) fill(a,a,asset,'buy',budget,frame,'auto');
    }
    a.lastDecisionAt=frame.time;
  }
  a.lastFrameAt=frame.time;a.lastValidFrameAt=frame.time;mark(a,frame);return a;
}

export function manualTrade(a,asset,side,dollars,frame) {
  if (!ASSETS.includes(asset)||!['buy','sell'].includes(side)||!finite(dollars)||dollars<=0) throw new Error('Invalid order');
  if (!validFrame(a,frame)||a.status==='completed'||(a.lastFrameAt!==null&&frame.time<a.lastFrameAt)) throw new Error('Unavailable or stale trading frame');
  // Process settlement and scheduled automatic actions before a newer manual
  // frame consumes the clock. A frame already ingested by the UI is reused.
  if (a.lastFrameAt===null||frame.time>a.lastFrameAt) ingest(a,frame);
  if (frame.time>=a.endsAt) throw new Error('Paper session has ended');
  fill(a,a,asset,side,dollars,frame,'manual');mark(a,frame);
  a.lastFrameAt=frame.time;a.lastValidFrameAt=frame.time;return a;
}

export function getSummary(a) {
  const last=a.equity.at(-1),initial=a.config.initialCash;
  let peak=initial,maxDD=0,dd=0;
  for (const p of a.equity) {peak=Math.max(peak,p.value);dd=100*(peak-p.value)/peak;maxDD=Math.max(maxDD,dd);}
  const done=a.forecasts.filter(f=>f.status==='settled'),avg=(xs,k)=>xs.length?xs.reduce((s,x)=>s+x[k],0)/xs.length:null;
  const trades=a.ledger.filter(e=>e.type==='trade'&&e.actor!=='benchmark');
  return {status:a.status,equity:last?.value??initial,cash:a.cash,
    returnPct:100*((last?.value??initial)/initial-1),buyHoldEquity:last?.buyHoldValue??initial,
    buyHoldReturnPct:100*((last?.buyHoldValue??initial)/initial-1),cashBenchmark:initial,
    drawdownPct:dd,maxDrawdownPct:maxDD,fees:trades.reduce((s,t)=>s+t.fee,0),tradeCount:trades.length,
    forecastCount:a.forecasts.length,settledForecasts:done.length,
    pendingForecasts:a.forecasts.filter(f=>f.status==='pending').length,
    expiredForecasts:a.forecasts.filter(f=>f.status==='expired').length,
    mae:avg(done,'absoluteError'),samePriceMae:avg(done,'baselineAbsoluteError'),
    perAsset:Object.fromEntries(ASSETS.map(s=>{const fs=done.filter(f=>f.asset===s);return [s,{count:fs.length,
      mae:avg(fs,'absoluteError'),samePriceMae:avg(fs,'baselineAbsoluteError'),qty:a.positions[s].qty}];})),
    valuationAt:last?.time??null,valuationIsNetLiquidation:true};
}
