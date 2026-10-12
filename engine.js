// Deterministic paper ledger. All prices and clocks are supplied by the caller.
export const ASSETS = ['BTC', 'LINK'];
const iso = t => new Date(t).toISOString();
const finite = x => typeof x === 'number' && Number.isFinite(x);
const defaults = { initialCash: 1000, horizonMs: 420000, feeBps: 2, slippageBps: 2,
  bufferBps: 10, model: 'trend', mode: 'replay', durationMs: 48*3600000, maxQuoteAgeMs: 60000,
  maxOutcomeLatenessMs: 30000, lookbackIntervals: 7, allocationFraction: .5, stopLossBps: 0,
  maxDrawdownBps: 0, dailyLossBps: 0, cashYieldBps: 0 };
const DAY = 86400000, YEAR = 365*DAY;

export function createAccount(config = {}) {
  if (!config || typeof config!=='object' || Array.isArray(config)) throw new Error('Invalid configuration');
  for (const key of Object.keys(config)) if (!Object.hasOwn(defaults,key)) throw new Error(`Unknown configuration field: ${key}`);
  const c = {...defaults, ...config};
  for (const key of ['initialCash','horizonMs','durationMs','maxQuoteAgeMs'])
    if (!finite(c[key]) || c[key] <= 0) throw new Error(`Invalid ${key}`);
  if (!finite(c.maxOutcomeLatenessMs) || c.maxOutcomeLatenessMs < 0) throw new Error('Invalid maxOutcomeLatenessMs');
  for (const key of ['feeBps','slippageBps','bufferBps'])
    if (!finite(c[key]) || c[key] < 0 || c[key] >= 10000) throw new Error(`Invalid ${key}`);
  if (!['trend','same-price'].includes(c.model) || !['live','replay'].includes(c.mode)) throw new Error('Invalid model or mode');
  const maxima={initialCash:1e9,horizonMs:31*86400000,durationMs:366*86400000,maxQuoteAgeMs:86400000,maxOutcomeLatenessMs:86400000,feeBps:1000,slippageBps:1000,bufferBps:1000};
  for (const [key,max] of Object.entries(maxima)) if (c[key]>max) throw new Error(`${key} exceeds supported maximum`);
  if (!Number.isInteger(c.lookbackIntervals)||c.lookbackIntervals<1||c.lookbackIntervals>240) throw new Error('lookbackIntervals must be an integer from 1 to 240');
  if (!finite(c.allocationFraction)||c.allocationFraction<0||c.allocationFraction>.5) throw new Error('allocationFraction must be between 0 and 0.5');
  for (const key of ['stopLossBps','maxDrawdownBps','dailyLossBps'])
    if (!finite(c[key])||c[key]<0||c[key]>9999) throw new Error(`${key} must be between 0 and 9999`);
  if (!finite(c.cashYieldBps)||c.cashYieldBps<0||c.cashYieldBps>2000) throw new Error('cashYieldBps must be between 0 and 2000');
  return {config:c,cash:c.initialCash,positions:{BTC:{qty:0,costBasis:0},LINK:{qty:0,costBasis:0}},ledger:[],forecasts:[],equity:[],
    startedAt:null,endsAt:null,lastDecisionAt:null,lastFrameAt:null,lastValidFrameAt:null,status:'ready',
    baseline:{cash:c.initialCash,positions:{BTC:{qty:0,costBasis:0},LINK:{qty:0,costBasis:0}}},sequence:0};
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
    book.positions[asset].costBasis=(book.positions[asset].costBasis??0)+total;
  } else {
    // Sell dollars denotes desired net proceeds, capped by the existing position.
    qty=Math.min(book.positions[asset].qty,dollars/(p.sell*(1-p.fee)));
    if (!(qty>1e-14)) return;
    notional=qty*p.sell;fee=notional*p.fee;total=notional-fee;
    const remaining=1-qty/book.positions[asset].qty;
    book.positions[asset].costBasis=(book.positions[asset].costBasis??0)*remaining;
    book.positions[asset].qty-=qty;book.cash+=total;
  }
  book.cash=Math.max(0,book.cash);
  if (book.positions[asset].qty<1e-14) {book.positions[asset].qty=0;book.positions[asset].costBasis=0;}
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

// Idle cash earns the configured annual yield, compounded continuously over the
// elapsed time since the previous valid frame, including unobserved gaps.
function growth(a,ms) {
  return Math.exp((a.config.cashYieldBps||0)/10000*ms/YEAR);
}

function accrue(a,frame) {
  if (!a.config.cashYieldBps||a.lastValidFrameAt===null||!(frame.time>a.lastValidFrameAt)||!(a.cash>0)) return;
  const earned=a.cash*(growth(a,frame.time-a.lastValidFrameAt)-1);
  a.cash+=earned;a.interest=(a.interest??0)+earned;
}

function mark(a,frame) {
  const point={time:frame.time,at:iso(frame.time),value:liquidation(a,a,frame),
    buyHoldValue:liquidation(a,a.baseline,frame),cashValue:a.config.initialCash*growth(a,frame.time-a.startedAt)};
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
  const lookback=a.config.lookbackIntervals;
  if (rows.length<lookback+1) return null;
  const last=rows.at(-1),past=rows.at(-(lookback+1)),elapsed=last[0]-past[0];
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

function stopPositions(a,frame) {
  const stopped=new Set();
  if (!a.config.stopLossBps) return stopped;
  for (const asset of ASSETS) {
    const position=a.positions[asset],p=prices(a,frame.quotes[asset]);
    const net=position.qty*p.sell*(1-p.fee);
    if (position.qty>0&&position.costBasis>0&&net<=position.costBasis*(1-a.config.stopLossBps/10000)) {
      event(a,'stop_loss',frame.time,{actor:'auto',asset,netLiquidation:net,costBasis:position.costBasis,
        thresholdBps:a.config.stopLossBps,quoteObservedAt:frame.quotes[asset].observedAt,
        reason:'Observed bid less modeled slippage and exit fee breached loss from fee-inclusive entry cost; no intraminute execution assumed'});
      fill(a,a,asset,'sell',Number.MAX_VALUE,frame,'auto');stopped.add(asset);
      position.lastStoppedAt=frame.time;
    }
  }
  return stopped;
}

// Account-level hard limits, checked at observed frames before decisions. A breach
// closes positions at modeled exit costs and blocks new entries; forecasts continue.
// Risk state exists only when a limit is configured.
function haltReason(a) {
  return a.risk?.killedAt!=null?'max_drawdown':a.risk?.haltedUntil!=null?'daily_loss':null;
}

function enforceLimits(a,frame) {
  const drawdown=a.config.maxDrawdownBps||0,daily=a.config.dailyLossBps||0;
  if (!drawdown&&!daily) return;
  const r=a.risk??={peakValue:a.config.initialCash,dayStart:null,dayOpenValue:null,killedAt:null,haltedUntil:null};
  const value=liquidation(a,a,frame),day=Math.floor(frame.time/DAY)*DAY;
  if (r.haltedUntil!==null&&frame.time>=r.haltedUntil) {
    event(a,'risk_resume',frame.time,{actor:'auto',limit:'daily_loss',reason:'New UTC day; daily loss halt lifted'});
    r.haltedUntil=null;
  }
  if (r.dayStart!==day) {r.dayStart=day;r.dayOpenValue=value;}
  r.peakValue=Math.max(r.peakValue,value);
  if (r.killedAt!==null||r.haltedUntil!==null) return;
  let breach=null;
  if (drawdown&&value<=r.peakValue*(1-drawdown/10000))
    breach={limit:'max_drawdown',thresholdBps:drawdown,referenceValue:r.peakValue,
      reason:'Net liquidation value fell from its observed peak by at least the drawdown limit; no new entries for the rest of the session'};
  else if (daily&&value<=r.dayOpenValue*(1-daily/10000))
    breach={limit:'daily_loss',thresholdBps:daily,referenceValue:r.dayOpenValue,resumesAt:day+DAY,
      resumeAt:iso(day+DAY),reason:'Net liquidation value fell from the UTC day opening value by at least the daily loss limit; no new entries until the next UTC day'};
  if (!breach) return;
  event(a,'risk_halt',frame.time,{actor:'auto',netLiquidation:value,...breach});
  close(a,frame,'auto');
  if (breach.limit==='max_drawdown') r.killedAt=frame.time; else r.haltedUntil=breach.resumesAt;
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
  accrue(a,frame);
  if (a.config.mode==='live'&&a.lastValidFrameAt!==null&&frame.time-a.lastValidFrameAt>Math.min(a.config.horizonMs,120000))
    event(a,'gap',frame.time,{actor:'system',gapMs:frame.time-a.lastValidFrameAt,
      reason:'No intervening fills simulated; resumed at observed quotes'});
  settle(a,frame);
  const stopped=stopPositions(a,frame);
  enforceLimits(a,frame);
  const blockedBy=haltReason(a);
  if (frame.time>=a.endsAt) {
    close(a,frame,'auto');a.status='completed';event(a,'complete',frame.time,{actor:'system',lateByMs:frame.time-a.endsAt});
  } else if (a.lastDecisionAt===null||frame.time-a.lastDecisionAt>=a.config.horizonMs) {
    close(a,frame,'auto');
    const budget=a.cash*a.config.allocationFraction;
    for (const asset of ASSETS) {
      if (stopped.has(asset)) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Stop loss: no same-frame reentry'});continue;}
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
      // A halted decision still records what the rule would have done.
      event(a,'decision',frame.time,{actor:'auto',asset,forecastId:f.id,action:buy&&!blockedBy?'buy':'cash',
        expectedNetRatio,requiredNetRatio:1+a.config.bufferBps/10000,...(blockedBy?{blockedBy,wouldBuy:buy}:{})});
      if (buy&&!blockedBy) fill(a,a,asset,'buy',budget,frame,'auto');
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
  if (side==='buy'&&a.positions[asset].lastStoppedAt===frame.time) throw new Error('Stopped asset cannot reenter in the same frame');
  if (side==='buy'&&haltReason(a)) throw new Error(haltReason(a)==='max_drawdown'?'Drawdown limit reached: new entries are stopped for this session':'Daily loss limit reached: new entries resume next UTC day');
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
    buyHoldReturnPct:100*((last?.buyHoldValue??initial)/initial-1),cashBenchmark:last?.cashValue??initial,interestEarned:a.interest??0,
    drawdownPct:dd,maxDrawdownPct:maxDD,fees:trades.reduce((s,t)=>s+t.fee,0),tradeCount:trades.length,
    forecastCount:a.forecasts.length,settledForecasts:done.length,
    pendingForecasts:a.forecasts.filter(f=>f.status==='pending').length,
    expiredForecasts:a.forecasts.filter(f=>f.status==='expired').length,
    mae:avg(done,'absoluteError'),samePriceMae:avg(done,'baselineAbsoluteError'),
    perAsset:Object.fromEntries(ASSETS.map(s=>{const fs=done.filter(f=>f.asset===s);return [s,{count:fs.length,
      mae:avg(fs,'absoluteError'),samePriceMae:avg(fs,'baselineAbsoluteError'),qty:a.positions[s].qty}];})),
    riskHalts:a.ledger.filter(e=>e.type==='risk_halt').length,tradingHalted:haltReason(a),
    valuationAt:last?.time??null,valuationIsNetLiquidation:true};
}
