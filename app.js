import {createAccount, ingest, getSummary, manualTrade} from './engine.js';
import {loadSample, fetchLiveMarket, fetchHistoricalRange} from './market.js';
import {makeRunRecord, saveRun, listRuns, getRun, exportAllRuns, exportRun} from './history.js';
import {normalizeSettings, utcMinute} from './configuration.js';
import {reportCard, MIN_FORECASTS} from './report-card.js';

const $ = id => document.getElementById(id);
const money = (n,digits=2) => Number(n).toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits});
const signed = n => `${n>=0?'+':'−'}${money(Math.abs(n))}`;
const utc = n => n==null?'—':new Date(n).toISOString().replace('T',' ').replace('.000Z',' UTC');
const shortTime = n => new Date(n).toISOString().slice(11,19);
const esc = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CHECKPOINT = 'paper-trail.current.v2';
const FORM_IDS = ['initial-cash','horizon','model','lookback','buffer','allocation','stop-loss','max-drawdown','daily-loss','fee','slippage','live-duration','cash-yield','replay-source','range-start','range-end','half-spread'];
let account=null, dataset=null, frame=null, cursor=0, timer=null, active=false, busy=false, readOnly=false;
let runId=null, runName='', runSettings=null, runKind=null, storageError=false, generation=0, fetchController=null;
let saveChain=Promise.resolve(), lastAutoSave=0, cachedSample=null, currentView='run';
let importedTimingLimits={};

function notify(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function pauseClock(){clearInterval(timer);timer=null;active=false;generation++;}
function setBusy(value){busy=value;document.body.classList.toggle('busy',value);render();}
function numeric(id){const value=$(id).value.trim();if(!value)throw new Error('Complete every numeric configuration field.');const n=Number(value);if(!Number.isFinite(n))throw new Error('Configuration values must be finite numbers.');return n;}
function readSettings(mode='replay'){
  return normalizeSettings({config:{...importedTimingLimits,mode,initialCash:numeric('initial-cash'),horizonMs:numeric('horizon'),model:$('model').value,
    lookbackIntervals:numeric('lookback'),bufferBps:numeric('buffer'),allocationFraction:numeric('allocation')/100,
    stopLossBps:numeric('stop-loss'),maxDrawdownBps:numeric('max-drawdown'),dailyLossBps:numeric('daily-loss'),feeBps:numeric('fee'),slippageBps:numeric('slippage'),durationMs:numeric('live-duration')*3600000,cashYieldBps:numeric('cash-yield')*100},
    replay:{source:$('replay-source').value,start:$('range-start').value,end:$('range-end').value,halfSpreadBps:numeric('half-spread')}});
}
function applySettings(settings){
  const s=normalizeSettings(settings),c=s.config;
  importedTimingLimits={maxQuoteAgeMs:c.maxQuoteAgeMs,maxOutcomeLatenessMs:c.maxOutcomeLatenessMs};
  for(const [id,key] of [['initial-cash','initialCash'],['horizon','horizonMs'],['model','model'],['lookback','lookbackIntervals'],['buffer','bufferBps'],['stop-loss','stopLossBps'],['max-drawdown','maxDrawdownBps'],['daily-loss','dailyLossBps'],['fee','feeBps'],['slippage','slippageBps']])$(id).value=c[key];
  $('allocation').value=c.allocationFraction*100;$('live-duration').value=c.durationMs/3600000;$('cash-yield').value=c.cashYieldBps/100;
  $('replay-source').value=s.replay.source;$('range-start').value=s.replay.start;$('range-end').value=s.replay.end;$('half-spread').value=s.replay.halfSpreadBps;
  rangeVisibility();return s;
}
function rangeVisibility(){$('range-settings').hidden=$('replay-source').value!=='range';for(const id of ['start-replay','config-start-replay'])$(id).textContent=$('replay-source').value==='range'?'Fetch & start replay':'Try market replay ↗';}
function download(payload,name){const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function filename(suffix='run'){return `paper-trail-${runId??'settings'}-${suffix}.json`;}
function marketSnapshot(){return {kind:runKind,dataset,cursor,lastObservedFrame:frame,scoreStart:dataset?.scoreStart??account?.startedAt,scoreEnd:dataset?.scoreEnd??account?.endsAt,settings:runSettings};}
async function currentRecord(){if(!account)throw new Error('No current run.');return makeRunRecord({id:runId,name:runName,account:structuredClone(account),market:marketSnapshot()});}
function rememberCurrent(){try{localStorage.setItem(CHECKPOINT,JSON.stringify({version:2,id:runId,readOnly}));}catch{storageError=true;notify('Run saved in History, but this browser cannot remember the current run across reloads. Export it to keep a separate copy.',true);}}
async function updateHistoryCount(){try{$('history-count').textContent=(await listRuns()).length;}catch{$('history-count').textContent='—';}}
async function persist(reason='snapshot'){
  if(!account||readOnly)return null;
  const owner=account,id=runId,name=runName,snapshot=structuredClone(account),market=marketSnapshot();
  const recordPromise=makeRunRecord({id,name,account:snapshot,market});
  recordPromise.catch(()=>{});
  const job=saveChain.catch(()=>{}).then(async()=>{
    const record=await recordPromise;
    await saveRun(record);updateHistoryCount();
    if(account===owner&&runId===id){storageError=false;rememberCurrent();lastAutoSave=Date.now();}
    return record;
  });
  saveChain=job;
  try{return await job;}catch(error){storageError=true;notify(`Could not save ${reason}: ${error.message}. Your run is still open; use Export run to download it.`,true);throw error;}
}
async function pause(message='Paused. No further paper trades are being simulated.'){
  pauseClock();render();try{await persist('paused run');if(!storageError)notify(message);}catch{}render();
}
function trimLive(next){for(const asset of ['BTC','LINK'])next.history[asset]=next.history[asset].slice(-(account?.config.lookbackIntervals??runSettings.config.lookbackIntervals)-1);return next;}
async function start(mode){
  if(busy||account)return;
  const version=generation;
  setBusy(true);notify(mode==='live'?'Loading fresh Coinbase quotes…':'Loading historical market data…');
  let nextSettings,nextDataset,nextFrame,nextCursor=0,kind;
  try{
    nextSettings=readSettings(mode);setView('run');const config={...nextSettings.config};
    if(mode==='live'){
      nextFrame=await fetchLiveMarket(config.horizonMs);
      for(const asset of ['BTC','LINK'])nextFrame.history[asset]=nextFrame.history[asset].slice(-config.lookbackIntervals-1);
      kind='live';nextDataset={source:nextFrame.source,documentation:nextFrame.documentation,assumptions:nextFrame.assumptions,frames:[nextFrame]};
    }else if(nextSettings.replay.source==='range'){
      kind='historical';fetchController=new AbortController();$('fetch-state').hidden=false;
      nextDataset=await fetchHistoricalRange({start:utcMinute(nextSettings.replay.start),end:utcMinute(nextSettings.replay.end),halfSpreadBps:nextSettings.replay.halfSpreadBps,
        warmupMinutes:Math.max(60,2*config.lookbackIntervals+10),historyLimit:config.lookbackIntervals+1,
        requiredHistory:config.model==='trend'?config.lookbackIntervals+1:0,signal:fetchController.signal,
        onProgress:p=>{$('fetch-label').textContent=p.message??`${p.asset??''} ${p.phase??'Fetching'} · ${p.completed??0}/${p.total??'?'}`;$('fetch-progress').max=p.total||1;$('fetch-progress').value=p.completed||0;}});
      if(fetchController.signal.aborted)throw new Error('Historical fetch canceled.');
      nextFrame=nextDataset.frames[0];
    }else{
      kind='sample';if(!cachedSample)cachedSample=await loadSample();
      const half=nextSettings.replay.halfSpreadBps/10000;
      const frames=cachedSample.frames.map(f=>({...f,quotes:Object.fromEntries(['BTC','LINK'].map(asset=>{const q=f.quotes[asset];return [asset,{...q,bid:q.mid*(1-half),ask:q.mid*(1+half),source:`Historical Coinbase candle close with ASSUMED ${nextSettings.replay.halfSpreadBps} bps half-spread`}];}))}));
      nextCursor=config.lookbackIntervals;
      if(nextCursor>=frames.length-1)throw new Error('The included sample is too short for this lookback.');
      nextDataset={...cachedSample,frames,scoreStart:frames[nextCursor].time,scoreEnd:frames.at(-1).time,
        assumptions:{...cachedSample.assumptions,halfSpreadBps:nextSettings.replay.halfSpreadBps},warmupFrameCount:nextCursor};
      nextFrame=frames[nextCursor];
    }
    if(mode==='replay'){
      if(!nextDataset.frames.length||nextFrame.time!==nextDataset.scoreStart||nextDataset.frames.at(-1).time!==nextDataset.scoreEnd)throw new Error('Historical data is missing an exact scored boundary. No run was created.');
      config.durationMs=nextDataset.scoreEnd-nextDataset.scoreStart;
      if(config.durationMs<config.horizonMs)throw new Error('The scored date range must be at least one forecast horizon long.');
    }
    if(generation!==version||account)return;
    const created=createAccount(config);ingest(created,nextFrame);
    account=created;dataset=nextDataset;frame=nextFrame;cursor=nextCursor;runSettings=nextSettings;runKind=kind;
    runId=crypto.randomUUID();runName=$('run-name').value.trim().slice(0,100)||`${kind==='live'?'Live':kind==='sample'?'Sample':'UTC replay'} · ${utc(account.startedAt)}`;
    $('run-name').value=runName;readOnly=false;
    try{await persist('new run');}catch{}
    if(account!==created||generation!==version)return;
    setView('run');render();
    if(!storageError)notify(mode==='live'?'Live paper account started. Fresh quotes update while this tab is visible.':`Replay ready: scored ${utc(dataset.scoreStart)} → ${utc(dataset.scoreEnd)}. Warmup is excluded. Press Play or Finish replay.`);
    if(mode==='live')startLive();
  }catch(error){notify(error.name==='AbortError'?'Historical fetch canceled. No run was created.':error.message,true);}
  finally{fetchController=null;$('fetch-state').hidden=true;setBusy(false);}
}
function ingestNext(){if(!dataset||cursor>=dataset.frames.length-1)return false;frame=dataset.frames[++cursor];ingest(account,frame);return true;}
async function replayWork(kind){
  if(!account||account.config.mode!=='replay'||readOnly||busy)return;
  pauseClock();active=true;const version=generation,owner=account;
  const target=kind==='step'?(account.lastDecisionAt??frame.time)+account.config.horizonMs:Infinity;
  render();notify(kind==='finish'?'Finishing replay in responsive batches…':'Replaying recorded observations…');
  let finished=false;
  try{
    while(active&&generation===version&&account===owner){
      const until=performance.now()+20;let processed=0;
      while(processed<(kind==='play'?8:250)&&performance.now()<until){
        if(!ingestNext()){finished=true;break;}
        processed++;
        if(account.status==='completed'||cursor>=dataset.frames.length-1){finished=true;break;}
        if(kind==='step'&&frame.time>=target){finished=true;break;}
      }
      render();
      if(finished)break;
      await new Promise(resolve=>setTimeout(resolve,kind==='play'?100:0));
    }
    if(account!==owner||generation!==version)return;
    pauseClock();render();
    try{await persist(account.status==='completed'?'completed replay':'paused replay');}catch{}
    if(!storageError)notify(account.status==='completed'?'Replay complete at the exact final close. Positions were closed with modeled exit costs.':`Replay paused at ${utc(frame.time)}.`);
  }catch(error){pauseClock();notify(error.message,true);}finally{render();}
}
async function play(){if(!account||readOnly)return;if(active){await pause();return;}if(busy)return;if(account.status==='completed')return;if(account.config.mode==='live')startLive();else await replayWork('play');}
async function liveTick(){
  if(busy||!account||account.config.mode!=='live'||!active||readOnly)return;
  const owner=account,version=generation;setBusy(true);
  try{
    const next=trimLive(await fetchLiveMarket(account.config.horizonMs));
    if(!active||account!==owner||generation!==version)return;
    frame=next;dataset.frames.push(next);ingest(account,next);render();
    if(account.status==='completed'){pauseClock();await persist('completed live run');if(!storageError)notify('Live session completed at the observed quote. Trading is finished.');}
    else if(Date.now()-lastAutoSave>30000){await persist('live snapshot');}
    if(active&&!storageError)notify(`Live quote received ${utc(frame.time)}. Next decision ${utc((account.lastDecisionAt??frame.time)+account.config.horizonMs)}.`);
  }catch(error){if(account===owner&&generation===version)notify(`${error.message}. Trading waits for a fresh quote.`,true);}
  finally{setBusy(false);}
}
function startLive(){if(!account||readOnly||account.status==='completed')return;pauseClock();active=true;timer=setInterval(liveTick,10000);render();notify('Live paper session running while this tab is visible. Gaps do not invent intervening trades.');if(!busy)liveTick();}
function chart(){if(!account?.equity.length)return;const points=account.equity, width=700,height=215,left=49,right=8,top=14,bottom=29;const vals=points.flatMap(p=>[p.value,p.buyHoldValue,p.cashValue]);let lo=Infinity,hi=-Infinity;for(const value of vals){lo=Math.min(lo,value);hi=Math.max(hi,value);}const pad=Math.max((hi-lo)*.13,1);lo-=pad;hi+=pad;const first=points[0].time,last=points.at(-1).time;const x=t=>left+(t-first)/Math.max(1,last-first)*(width-left-right),y=v=>top+(hi-v)/(hi-lo)*(height-top-bottom);const sampled=points.filter((p,i)=>i%Math.max(1,Math.floor(points.length/450))===0||i===points.length-1);const path=key=>sampled.map((p,i)=>`${i?'L':'M'}${x(p.time).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');let grid='';for(let i=0;i<4;i++){const val=lo+(hi-lo)*i/3,py=y(val);grid+=`<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" stroke="#edf1ed"/><text x="${left-9}" y="${py+3}" text-anchor="end" fill="#85928b" font-size="9">${money(val,0)}</text>`;}$('chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Paper account ${money(points.at(-1).value)}, buy-and-hold ${money(points.at(-1).buyHoldValue)}, cash ${money(account.config.initialCash)}"><title>Net account value after modeled exit costs</title>${grid}<path d="${path('cashValue')}" fill="none" stroke="#b4bdb9" stroke-width="1.3" stroke-dasharray="4 4"/><path d="${path('buyHoldValue')}" fill="none" stroke="#6489b3" stroke-width="1.7"/><path d="${path('value')}" fill="none" stroke="#1a6a52" stroke-width="2.5"/><circle cx="${x(last)}" cy="${y(points.at(-1).value)}" r="3.5" fill="#1a6a52"/><text x="${left}" y="${height-5}" fill="#85928b" font-size="9">${shortTime(first)} UTC</text><text x="${width-right}" y="${height-5}" text-anchor="end" fill="#85928b" font-size="9">${shortTime(last)} UTC</text></svg>`;}
const chance = p => p<0.001?'less than 0.1%':`${(100*p).toFixed(p<0.01?1:0)}%`;
function reportCardPanel(summary){
  const panel=$('report-card');panel.hidden=!account;if(!account)return;
  const grades=reportCard(summary,account.config.model);
  const tone={better:'good',worse:'bad',mixed:'warn'};
  const rows=['BTC','LINK'].map(asset=>{const g=grades[asset],m=summary.perAsset[asset],digits=asset==='BTC'?2:4,lines=[];
    if(g.verdict==='baseline')lines.push('This run uses the same-price rule, which is the comparison itself. Choose the trend rule in Config to grade it.');
    else if(g.verdict==='none')lines.push('Forecasts are graded once their target time arrives.');
    else{
      lines.push(`Closer to the actual price in <strong>${g.wins} of ${g.decided}</strong> forecasts (${Math.round(100*g.wins/g.decided)}%)${g.ties?` · ${g.ties} tied`:''}.`);
      if(g.maeChangePct!=null)lines.push(`Average miss ${money(m.mae,digits)} vs ${money(m.samePriceMae,digits)} for “no change” (${Math.abs(g.maeChangePct).toFixed(1)}% ${g.maeChangePct<=0?'smaller':'larger'}).`);
      if(g.verdict==='too_few')lines.push(`Needs at least ${MIN_FORECASTS} forecasts that weren’t ties before judging; has ${g.decided}.`);
      else if(g.pValue!=null)lines.push(`Pure coin flips would give a split at least this lopsided ${chance(g.pValue)} of the time.${g.verdict==='mixed'?' It was closer more often, but its misses averaged the other way.':''}`);
    }
    return `<div class="report-row"><div class="report-head"><strong>${asset}</strong><span class="report-verdict ${tone[g.verdict]??''}">${g.label}</span></div>${lines.map(l=>`<p class="report-line">${l}</p>`).join('')}</div>`;}).join('');
  panel.innerHTML=`<div class="panel-top"><div><h2 id="report-card-title">Forecast report card</h2><p class="muted">Did the rule predict the price better than simply guessing it won’t move?</p></div></div><div class="report-grid">${rows}</div><p class="muted small">Accuracy only: a rule can forecast better and still lose money after costs. One date range is not proof.</p>`;
}
function assetCards(summary){$('assets').innerHTML=['BTC','LINK'].map(asset=>{const q=frame?.quotes[asset],f=account?.forecasts.filter(f=>f.asset===asset).at(-1),decision=account?.ledger.filter(e=>(e.type==='decision'||e.type==='decision_skipped')&&e.asset===asset).at(-1),m=summary?.perAsset[asset],price=q?money(q.mid,asset==='BTC'?2:4):'—';const signal=decision?.type==='decision_skipped'?'WAIT':decision?.blockedBy?'HALTED':decision?.action==='buy'?'BUY':'KEEP CASH';const late=account?.forecasts.filter(f=>f.asset===asset&&f.latenessMs>0)??[];return `<section class="panel asset-card"><div class="asset-top"><div class="asset-title"><span class="coin ${asset==='LINK'?'link':''}">${asset==='BTC'?'₿':'⬡'}</span>${asset}<span class="muted small">/ USD</span></div><span class="status-pill">${f?signal:'Awaiting data'}</span></div><div class="asset-price">${price}</div><span class="asset-caption">${q?(q.simulatedQuote?'Recorded close · assumed spread':'Observed bid/ask midpoint'):'Market price'}</span><div class="forecast-row"><div><span>Forecast</span><strong>${f?money(f.prediction,asset==='BTC'?2:4):'—'}</strong></div><div><span>Target · UTC</span><strong class="small">${f?new Date(f.targetAt).toISOString().slice(5,16).replace('T',' '):'—'}</strong></div></div><p class="asset-metrics">Position: ${(m?.qty??0).toFixed(asset==='BTC'?6:3)} ${asset} · ${m?.count??0} scored</p><p class="asset-metrics">Mean absolute error: ${m?.mae==null?'pending':money(m.mae,4)} · Same-price: ${m?.samePriceMae==null?'pending':money(m.samePriceMae,4)}</p>${late.length?`<p class="asset-metrics">${late.length} late observation${late.length===1?'':'s'} · max ${(Math.max(...late.map(f=>f.latenessMs))/1000).toFixed(1)}s after target · over ${account.config.maxOutcomeLatenessMs/1000}s excluded</p>`:''}<div class="manual-buttons"><button data-asset="${asset}" data-side="buy" ${!account||readOnly||active||busy||account.status==='completed'?'disabled':''}>Paper buy $100</button><button data-asset="${asset}" data-side="sell" ${!account||readOnly||active||busy||!(m?.qty>0)||account.status==='completed'?'disabled':''}>Paper sell position</button></div></section>`;}).join('');}
function ledger(){if(!account)return;const filter=$('ledger-filter').value;let rows=account.ledger.filter(e=>e.actor!=='benchmark'&&(filter==='all'||filter==='trades'&&e.type==='trade'||filter==='decisions'&&e.type==='decision'));const total=rows.length;rows=rows.slice(-80).reverse();$('ledger').innerHTML=rows.map(e=>{let title=e.type.replaceAll('_',' '),detail=e.reason??'';if(e.type==='trade'){title=`${e.actor==='manual'?'Manual ':''}${e.side}`;detail=`${e.qty.toFixed(e.asset==='BTC'?6:3)} @ ${money(e.price,e.asset==='BTC'?2:4)} · fee ${money(e.fee)}`;}else if(e.type==='decision'){title=e.action==='buy'?'Buy signal':'Keep cash';detail=`Expected net ${((e.expectedNetRatio-1)*100).toFixed(3)}% · hurdle ${((e.requiredNetRatio-1)*100).toFixed(2)}%${e.blockedBy?` · blocked by ${e.blockedBy==='max_drawdown'?'drawdown':'daily loss'} limit${e.wouldBuy?'; rule would buy':''}`:''}`;}else if(e.type==='risk_halt'){title=e.limit==='max_drawdown'?'Drawdown halt':'Daily loss halt';detail=`Net ${money(e.netLiquidation)} vs ${money(e.referenceValue)} ${e.limit==='max_drawdown'?'peak':'day open'} · limit ${e.thresholdBps} bps · ${e.resumesAt?`entries resume ${utc(e.resumesAt)}`:'no new entries this session'}`;}else if(e.type==='forecast_settled'){title='Forecast scored';detail=`${e.forecastId} · ${Math.round(e.latenessMs/1000)}s late`;}else if(e.type==='start'){detail=`Rules frozen · ${money(account.config.initialCash)} simulated cash`;}else if(e.type==='gap'){detail=`${(e.gapMs/60000).toFixed(1)} min without observations · no intervening fills`;}return `<tr><td>${shortTime(e.time)}</td><td><span class="activity-tag ${e.actor==='manual'?'manual':''}">${esc(title)}</span></td><td>${esc(e.asset??'—')}</td><td>${esc(detail)}</td><td class="numeric ${e.cashDelta>0?'positive':e.cashDelta<0?'negative':''}">${e.cashDelta==null?'—':signed(e.cashDelta)}</td></tr>`;}).join('')||'<tr><td colspan="5" class="empty-row">No matching activity.</td></tr>';$('ledger-note').textContent=`Showing ${rows.length} of ${total} events. Benchmark trades are separate. Export includes the full ledger, frozen forecasts, rules and source evidence.`;}
function render(){
  const locked=!!account||busy;
  for(const id of FORM_IDS)$(id).disabled=locked;
  $('run-name').disabled=readOnly||busy;
  $('import-settings').disabled=locked;$('rules-state').textContent=account?'FROZEN':'EDITABLE';
  $('launch').hidden=!!account;for(const id of ['start-replay','start-live','config-start-replay','config-start-live'])$(id).disabled=busy||!!account;
  $('new-account').hidden=!account;$('new-account').disabled=busy&&!active;
  $('new-account').textContent=readOnly?'Close snapshot & configure a run':'Save & start another';
  $('export').disabled=!account;$('run-controls').hidden=!account;
  const s=account?getSummary(account):null;
  if(account){
    $('equity').textContent=money(s.equity);$('pnl').textContent=`${signed(s.equity-account.config.initialCash)} (${s.returnPct.toFixed(2)}%)`;
    $('pnl').className=s.returnPct>=0?'positive':'negative';$('cash').textContent=money(s.cash);$('buyhold').textContent=money(s.buyHoldEquity);
    $('drawdown').textContent=`${s.maxDrawdownPct.toFixed(2)}%`;$('fees').textContent=money(s.fees);$('cash-legend').textContent=`${money(account.config.initialCash,0)} cash${account.config.cashYieldBps?` at ${account.config.cashYieldBps/100}%/yr`:''}`;
    $('mode-badge').textContent=`${account.config.mode==='live'?'Live paper':runKind==='sample'?'Sample replay':'UTC replay'} · ${readOnly?'read-only snapshot':active?'running':account.status==='completed'?'complete':'paused / partial'}`;
    $('account-label').textContent=runName;$('clock').textContent=utc(frame?.time);
    $('run-detail').textContent=`${s.tradeCount} fills · ${account.config.model} · ${account.config.horizonMs/60000} min horizon · ${utc(account.startedAt)} → ${utc(account.endsAt)}${s.tradingHalted?` · entries halted by ${s.tradingHalted==='max_drawdown'?'drawdown':'daily loss'} limit`:''}`;
    const coverage=dataset?.coverage;
    $('coverage-note').textContent=account.config.mode==='replay'?`Scored range excludes warmup. ${Math.max(0,cursor-(dataset.warmupFrameCount??0))+1} shared frames processed${coverage?'; missing source minutes are reported in the export':''}.`:'Quote times are local receipt times. Closing the tab stops observations.';
    $('forecast-count').textContent=`${s.settledForecasts} scored · ${s.pendingForecasts} pending · ${s.expiredForecasts??0} missed`;
    $('play').textContent=readOnly?'Read-only snapshot':active?'Pause':account.config.mode==='live'?'Resume live':'Play replay';
    $('play').disabled=readOnly||account.status==='completed'||busy&&!active;
    for(const id of ['step','finish']){$(id).hidden=account.config.mode!=='replay'||readOnly;$(id).disabled=busy||active||account.status==='completed';}
    $('save-run').disabled=readOnly||busy;
    $('progress').hidden=account.config.mode!=='replay';$('progress').max=Math.max(1,(dataset?.frames.length??1)-1-(dataset?.warmupFrameCount??0));$('progress').value=Math.max(0,cursor-(dataset?.warmupFrameCount??0));
    $('saved-note').textContent=storageError?'Storage failed. Export this run before leaving.':readOnly?'Saved snapshot. Copy its settings in History to start a separate run.':'Snapshots save on pause, completion and export. Reload restores paused.';
    if(account.ledger.some(e=>e.type==='trade'&&e.actor==='manual'))$('saved-note').textContent+=' Manual orders are included; this is a modified strategy run.';
    chart();ledger();
  }else{
    const initial=Number($('initial-cash').value)||1000;
    for(const id of ['equity','cash','buyhold'])$(id).textContent=money(initial);
    $('pnl').textContent='$0.00 (0.00%)';$('pnl').className='';$('drawdown').textContent='0.00%';$('fees').textContent='$0.00';$('cash-legend').textContent=`${money(initial,0)} cash`;
    $('mode-badge').textContent='Not started';$('account-label').textContent='YOUR PAPER ACCOUNT';$('forecast-count').textContent='0 forecasts scored';
    $('chart').innerHTML='<p class="chart-empty">Your account’s performance will appear here.</p>';
    $('ledger').innerHTML='<tr><td colspan="5" class="empty-row">No activity yet. Choose settings and start a run.</td></tr>';
    $('ledger-note').textContent='Nothing is sent to an exchange.';$('saved-note').textContent='No account connected. No API key needed.';
  }
  assetCards(s);reportCardPanel(s);rangeVisibility();
}
async function order(asset,side){
  if(busy||active||!account||readOnly)return;
  const owner=account,version=generation;
  setBusy(true);
  try{
    if(owner.config.mode==='live'){
      const next=await fetchLiveMarket(owner.config.horizonMs);
      if(account!==owner||generation!==version||readOnly)return;
      frame=trimLive(next);dataset.frames.push(frame);ingest(account,frame);
    }
    if(account!==owner||generation!==version||readOnly)return;
    manualTrade(account,asset,side,side==='buy'?100:Number.MAX_VALUE,frame);
    await persist('manual order snapshot');notify(`Manual paper ${side} recorded. This run now includes manual changes.`);
  }catch(error){notify(error.message,true);}finally{setBusy(false);}
}
async function exportCurrent(){
  if(!account||busy)return;
  pauseClock();setBusy(true);
  try{
    const recordPromise=currentRecord();let record;
    if(!readOnly){
      const write=saveChain.catch(()=>{}).then(async()=>{const captured=await recordPromise;await saveRun(captured);updateHistoryCount();return captured;});
      saveChain=write;
      try{record=await write;storageError=false;rememberCurrent();}
      catch(error){record=await recordPromise;storageError=true;notify(`Export downloaded, but browser history could not be saved: ${error.message}`,true);}
    }else record=await recordPromise;
    download(record,filename());if(!storageError)notify('Run exported with frozen settings, full results, source evidence and hashes.');
  }catch(error){notify(`Could not prepare export: ${error.message}. Your current run remains open.`,true);}finally{setBusy(false);}
}
async function archive(options){
  if(!account||busy&&options?.allowBusy!==true)return;
  const manageBusy=options?.allowBusy!==true;if(manageBusy)setBusy(true);
  try{
    pauseClock();render();
    if(!readOnly){try{await persist('run before starting another');}catch{return;}}
    try{localStorage.removeItem(CHECKPOINT);}catch{}
    account=null;dataset=null;frame=null;cursor=0;runId=null;runName='';readOnly=false;runKind=null;storageError=false;
    $('run-name').value='';setView('config');render();notify('Previous run is available in History. Configure a new run.');await refreshHistory();
  }finally{if(manageBusy)setBusy(false);}
}
function settingsExport(){
  try{const settings=account?{...runSettings,config:{...account.config}}:readSettings();download(settings,filename('settings'));notify('Settings exported. They can be imported before starting a new run.');}catch(error){notify(error.message,true);}
}
async function importSettings(file){
  if(account||busy||!file)return;
  try{
    if(file.size>1000000)throw new Error('Settings file is too large. Import a settings JSON file under 1 MB.');
    const parsed=JSON.parse(await file.text()),validated=normalizeSettings(parsed);
    applySettings(validated);render();notify('Settings validated and applied. No run has started.');
  }catch(error){notify(`Settings were not applied: ${error.message}`,true);}finally{$('settings-file').value='';}
}
function smallText(text,className='muted small'){const p=document.createElement('p');p.className=className;p.textContent=text;return p;}
function historyButton(label,action){const b=document.createElement('button');b.className='button secondary compact';b.textContent=label;b.addEventListener('click',()=>action().catch(e=>notify(e.message,true)));return b;}
async function refreshHistory(){
  try{
    const runs=await listRuns();$('history-count').textContent=runs.length;$('history-list').replaceChildren();
    $('history-status').textContent=runs.length?`${runs.length} saved run${runs.length===1?'':'s'}. Snapshots overwrite the same run ID; exports include the full evidence.`:'No saved runs yet. Start a run, then pause, finish or export it.';
    for(const record of runs){
      const card=document.createElement('article');card.className='panel history-card';
      const title=document.createElement('h3');title.textContent=record.name||'Unnamed run';card.append(title);
      const c=record.config,s=record.summary,manual=record.manualTradeCount>0;
      card.append(smallText(`${record.status==='completed'?'Complete':'Partial snapshot'} · ${c.mode} · ${manual?'manual changes · ':''}${s.riskHalts?`${s.riskHalts} risk halt${s.riskHalts===1?'':'s'} · `:''}saved ${utc(record.updatedAt)}`));
      const metrics=document.createElement('div');metrics.className='history-metrics';
      for(const [label,value] of [['Net value',money(s.equity)],['Return',`${s.returnPct.toFixed(2)}%`],['Buy & hold',money(s.buyHoldEquity)],['Drawdown',`${s.maxDrawdownPct.toFixed(2)}%`]]){const item=document.createElement('div');const span=document.createElement('span');span.textContent=label;const strong=document.createElement('strong');strong.textContent=value;item.append(span,strong);metrics.append(item);}card.append(metrics);
      card.append(smallText(`${money(c.initialCash,0)} cash · ${c.model} · ${c.horizonMs/60000} min horizon · ${c.lookbackIntervals} lookback · ${c.allocationFraction*100}% per asset · buffer ${c.bufferBps} bps · stop ${c.stopLossBps||'off'}${c.stopLossBps?' bps':''} · drawdown limit ${c.maxDrawdownBps||'off'}${c.maxDrawdownBps?' bps':''} · daily loss ${c.dailyLossBps||'off'}${c.dailyLossBps?' bps':''} · cash yield ${(c.cashYieldBps??0)/100}%/yr · fee/slippage ${c.feeBps}/${c.slippageBps} bps`));
      card.append(smallText(`${utc(record.scoreStart??record.summary.valuationAt)} → ${utc(record.scoreEnd)} · ${s.settledForecasts} scored, ${s.expiredForecasts??0} missed · ${record.source??'Source in export'}`));
      const actions=document.createElement('div');actions.className='history-actions';
      actions.append(historyButton('Open snapshot',()=>openSaved(record.id)),historyButton('Use settings',()=>copySavedSettings(record.id)),historyButton('Export run ↓',async()=>{const full=await getRun(record.id);download(exportRun(full),`paper-trail-${record.id}.json`);}),historyButton('Export settings ↓',async()=>{const full=await getRun(record.id);download({...full.market.settings,format:'paper-trail-settings-v2',config:full.config},`paper-trail-${record.id}-settings.json`);}));
      card.append(actions);$('history-list').append(card);
    }
  }catch(error){$('history-status').textContent=`History unavailable: ${error.message}. Current results can still be exported.`;notify(`Could not read browser run history: ${error.message}`,true);}
}
function installRecord(record,isReadOnly){
  if(!record?.account?.config||!record.market?.lastObservedFrame)throw new Error('Saved run is missing its account or final observed frame.');
  const restoredSettings=normalizeSettings({...record.market.settings,config:record.config});
  const restoredDataset=record.market.dataset,restoredCursor=record.market.cursor??0;
  if(record.config.mode==='replay'&&(!restoredDataset?.frames?.length||!restoredDataset.frames[restoredCursor]))throw new Error('Saved replay data cannot be restored.');
  account=record.account;dataset=restoredDataset;frame=record.market.lastObservedFrame;cursor=restoredCursor;
  runId=record.id;runName=record.name;runKind=record.market.kind??(account.config.mode==='live'?'live':'sample');
  runSettings=restoredSettings;readOnly=isReadOnly;active=false;storageError=false;
  applySettings(restoredSettings);$('run-name').value=runName;render();
}
async function openSaved(id){
  if(busy)return;
  const owner=account;setBusy(true);
  try{
    if(account&&!readOnly){await pause('Current run saved before opening a snapshot.');if(storageError)return;}
    if(account!==owner)return;
    const version=generation,record=await getRun(id);
    if(account!==owner||generation!==version)return;
    pauseClock();installRecord(record,true);rememberCurrent();setView('run');notify('Read-only snapshot opened. Its results will not change. Use History → Use settings for a new run.');
  }finally{setBusy(false);}
}
async function copySavedSettings(id){
  if(busy)return;
  const owner=account,version=generation;setBusy(true);
  try{
    const record=await getRun(id);
    if(account!==owner||generation!==version)return;
    const settings=normalizeSettings({...record.market.settings,config:record.config});
    if(account){await archive({allowBusy:true});if(account)return;}
    applySettings(settings);$('run-name').value=`${record.name} · new run`.slice(0,100);setView('config');render();notify('Saved settings copied. Starting a new run creates a separate ID and ledger.');
  }finally{setBusy(false);}
}
function setView(view){currentView=view;$('run-view').hidden=view!=='run';$('history-view').hidden=view!=='history';$('config-view').hidden=view!=='config';for(const value of ['run','config','history']){const b=$(`view-${value}`);b.classList.toggle('selected',view===value);if(view===value)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}}
async function showHistory(){if(active)await pause('Run paused while viewing History.');setView('history');await refreshHistory();}
async function exportAll(){try{if(account&&!readOnly){pauseClock();await persist('run before exporting history');render();}download(await exportAllRuns(),'paper-trail-all-runs.json');notify('All saved run snapshots exported.');}catch(error){notify(`Could not export history: ${error.message}. Export the current run separately if browser storage is unavailable.`,true);}}

$('start-replay').addEventListener('click',()=>start('replay'));
$('start-live').addEventListener('click',()=>start('live'));
$('config-start-replay').addEventListener('click',()=>start('replay'));
$('config-start-live').addEventListener('click',()=>start('live'));
$('config-back').addEventListener('click',()=>setView('run'));
$('view-config').addEventListener('click',async()=>{if(active)await pause('Run paused while viewing Config.');setView('config');});
$('play').addEventListener('click',()=>play().catch(e=>notify(e.message,true)));
$('step').addEventListener('click',()=>replayWork('step'));
$('finish').addEventListener('click',()=>replayWork('finish'));
$('save-run').addEventListener('click',()=>pause('Snapshot saved in History.'));
$('export').addEventListener('click',exportCurrent);
$('new-account').addEventListener('click',archive);
$('export-settings').addEventListener('click',settingsExport);
$('import-settings').addEventListener('click',()=>$('settings-file').click());
$('settings-file').addEventListener('change',()=>importSettings($('settings-file').files[0]));
$('replay-source').addEventListener('change',rangeVisibility);
$('initial-cash').addEventListener('input',()=>{if(!account)render();});
$('run-name').addEventListener('change',()=>{if(account&&!readOnly){runName=$('run-name').value.trim().slice(0,100)||runName;$('run-name').value=runName;render();}});
$('cancel-fetch').addEventListener('click',()=>{fetchController?.abort();$('fetch-label').textContent='Canceling fetch…';});
$('view-run').addEventListener('click',()=>setView('run'));
$('view-history').addEventListener('click',()=>showHistory().catch(e=>notify(e.message,true)));
$('refresh-history').addEventListener('click',refreshHistory);
$('export-all').addEventListener('click',exportAll);
$('ledger-filter').addEventListener('change',ledger);
$('assets').addEventListener('click',e=>{const b=e.target.closest('button[data-asset]');if(b)order(b.dataset.asset,b.dataset.side);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)pause('Paused because this tab went into the background. Resume explicitly.');});
window.addEventListener('pagehide',()=>{pauseClock();persist('page-close snapshot').catch(()=>{});});
async function restore(){
  setBusy(true);
  const end=Math.floor(Date.now()/60000)*60000-60000;$('range-end').value=new Date(end).toISOString().slice(0,16);$('range-start').value=new Date(end-86400000).toISOString().slice(0,16);
  try{
    const pointer=JSON.parse(localStorage.getItem(CHECKPOINT)??'null');
    if(pointer?.version===2&&pointer.id){const record=await getRun(pointer.id);installRecord(record,!!pointer.readOnly);notify(pointer.readOnly?'Saved read-only snapshot restored.':'Saved run restored and paused. Resume explicitly; no off-tab trades were simulated.');}
    else if(localStorage.getItem('paper-trail.account.v1'))notify('An older account remains in browser storage. The new run history uses a separate format; the older record has not been deleted.');
  }catch(error){notify(`Could not restore the current run: ${error.message}. Existing saved runs remain available in History.`,true);}
  setBusy(false);await refreshHistory();
}
restore();
