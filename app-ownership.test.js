import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createAccount,ingest,manualTrade} from './engine.js';
import {normalizeSettings} from './configuration.js';
const S=Date.UTC(2024,0,1),M=60000;
function frame(time){return {time,quotes:Object.fromEntries(['BTC','LINK'].map(asset=>[asset,{mid:100,bid:99.98,ask:100.02,observedAt:time}])),history:Object.fromEntries(['BTC','LINK'].map(asset=>[asset,[{time:time-M,price:100},{time,price:100}]]))};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function harness(){
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const initial=frame(S),owner=createAccount({mode:'live',model:'same-price'});ingest(owner,initial);
  const snapshot=createAccount({mode:'live',model:'same-price'});ingest(snapshot,initial);
  const record={account:snapshot,config:snapshot.config,market:{settings:normalizeSettings({config:snapshot.config})},name:'saved'},quote=deferred(),sample=deferred(),saved=deferred(),writes=[],applied=[];
  const context=vm.createContext({account:owner,dataset:{frames:[initial]},frame:initial,cursor:0,
    busy:false,active:false,readOnly:false,generation:0,runId:'original',runName:'original',
    runSettings:null,runKind:'live',storageError:false,fetchController:null,cachedSample:null,
    createAccount,ingest,manualTrade,normalizeSettings,fetchLiveMarket:()=>quote.promise,
    loadSample:()=>sample.promise,getRun:async()=>record,
    trimLive:x=>x,$:()=>({value:'test',hidden:false}),crypto:{randomUUID:()=> 'new-id'},
    utc:x=>String(x),numeric:()=>0,rangeVisibility(){},notify(){},setView(){},render(){},rememberCurrent(){},
    setBusy(value){context.busy=value;},pauseClock(){context.generation++;context.active=false;},
    async pause(){context.pauseClock();},async persist(){writes.push(context.account);},
    startLive(){},installRecord(r,readOnly){context.account=r.account;context.readOnly=readOnly;},
    readSettings:()=>normalizeSettings({config:{lookbackIntervals:1,horizonMs:M}}),
    applySettings:s=>applied.push(s),CHECKPOINT:'test-checkpoint',
    localStorage:{removeItem(){}},refreshHistory:async()=>{},
  });
  const sections=[['async function order(','async function exportCurrent('],
    ['async function start(','function ingestNext('],
    ['async function openSaved(','async function copySavedSettings('],
    ['async function copySavedSettings(','function setView('],
    ['async function archive(','function settingsExport(']];
  for(const [first,last] of sections){const start=source.indexOf(first),end=source.indexOf(last,start);assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),context);}
  return {context,owner,snapshot,record,quote,sample,saved,writes,applied};
}
test('History opening during a pending manual quote cannot mutate a saved snapshot',async()=>{
  const h=harness(),before=structuredClone(h.snapshot);
  const buying=h.context.order('BTC','buy');
  await h.context.openSaved('saved');
  h.quote.resolve(frame(S+10000));await buying;
  assert.deepEqual(h.snapshot,before);
  assert.equal(h.context.account,h.owner);
  assert.equal(h.owner.ledger.filter(e=>e.type==='trade'&&e.actor==='manual').length,1);
  assert.ok(h.writes.every(account=>account===h.owner));
});
test('stale manual quote completion leaves a replacement read-only account unchanged',async()=>{
  const h=harness(),before=structuredClone(h.snapshot),original=structuredClone(h.owner);
  const buying=h.context.order('BTC','buy');
  h.context.account=h.snapshot;h.context.readOnly=true;h.context.generation++;
  h.quote.resolve(frame(S+10000));await buying;
  assert.deepEqual(h.snapshot,before);assert.deepEqual(h.owner,original);assert.equal(h.writes.length,0);
});
test('stale replay loading cannot overwrite a replacement snapshot',async()=>{
  const h=harness();h.context.account=null;h.context.dataset=null;
  const starting=h.context.start('replay');
  h.context.account=h.snapshot;h.context.readOnly=true;h.context.generation++;
  h.sample.resolve({frames:[frame(S),frame(S+M),frame(S+2*M)],assumptions:{}});await starting;
  assert.equal(h.context.account,h.snapshot);assert.equal(h.context.readOnly,true);assert.equal(h.writes.length,0);
});
test('History load marks itself busy so a competing manual order cannot begin',async()=>{
  const h=harness();h.context.getRun=()=>h.saved.promise;
  const opening=h.context.openSaved('saved');
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.context.busy,true);
  let calls=0;h.context.fetchLiveMarket=()=>{calls++;throw new Error('unexpected quote');};
  await h.context.order('BTC','buy');assert.equal(calls,0);
  h.saved.resolve(h.record);await opening;
  assert.equal(h.context.account,h.snapshot);assert.equal(h.context.readOnly,true);assert.equal(h.context.busy,false);
});
test('stale settings-copy read cannot archive a replacement read-only snapshot',async()=>{
  const h=harness();h.context.getRun=()=>h.saved.promise;
  const copying=h.context.copySavedSettings('saved');
  h.context.account=h.snapshot;h.context.readOnly=true;h.context.generation++;
  h.saved.resolve(h.record);await copying;
  assert.equal(h.context.account,h.snapshot);assert.equal(h.context.readOnly,true);
  assert.equal(h.applied.length,0);assert.equal(h.writes.length,0);
});
test('ordinary settings copy archives its own run and leaves the form ready',async()=>{
  const h=harness();await h.context.copySavedSettings('saved');
  assert.equal(h.context.account,null);assert.equal(h.context.busy,false);
  assert.equal(h.applied.length,1);assert.equal(h.applied[0].config.mode,'live');
  assert.equal(h.writes.length,1);assert.equal(h.writes[0],h.owner);
});
test('ordinary replay start still installs and saves a new account',async()=>{
  const h=harness();h.context.account=null;
  const starting=h.context.start('replay');
  h.sample.resolve({frames:[frame(S),frame(S+M),frame(S+2*M)],assumptions:{}});await starting;
  assert.notEqual(h.context.account,h.snapshot);assert.equal(h.context.account.config.mode,'replay');
  assert.equal(h.context.readOnly,false);assert.equal(h.context.busy,false);assert.equal(h.writes.length,1);
});
