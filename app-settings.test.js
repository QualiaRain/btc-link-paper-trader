import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeSettings} from './configuration.js';

// Exercise the actual app's form bridge without running its browser startup.
// This does not establish real DOM, IndexedDB or browser loading behavior.
function formBridge() {
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const elements=new Map();
  const $=id=>{
    if(!elements.has(id)) {
      let value='';
      elements.set(id,{get value(){return value;},set value(next){value=String(next);}});
    }
    return elements.get(id);
  };
  const start=source.indexOf('function numeric('),end=source.indexOf('function rangeVisibility(');
  assert.ok(start>=0&&end>start);
  const context=vm.createContext({$,normalizeSettings,rangeVisibility(){}});
  // Include only the candidate's persisted form fields; the baseline has none.
  const state=source.match(/^let importedTimingLimits=.*;$/m)?.[0]??'';
  vm.runInContext(state+'\n'+source.slice(start,end),context);
  return context;
}

test('imported timing limits survive form application and new-run read',()=>{
  const bridge=formBridge();
  const settings=normalizeSettings({config:{maxQuoteAgeMs:5000,maxOutcomeLatenessMs:500}});
  bridge.applySettings(settings);
  const effective=bridge.readSettings('replay');
  assert.equal(effective.config.maxQuoteAgeMs,5000);
  assert.equal(effective.config.maxOutcomeLatenessMs,500);
});

test('copying a saved config preserves timings while supported form values change',()=>{
  const bridge=formBridge();
  const settings=normalizeSettings({config:{maxQuoteAgeMs:9000,maxOutcomeLatenessMs:1500,bufferBps:12}});
  bridge.applySettings(settings);
  bridge.$('buffer').value='7';
  const effective=bridge.readSettings('live');
  assert.equal(effective.config.maxQuoteAgeMs,9000);
  assert.equal(effective.config.maxOutcomeLatenessMs,1500);
  assert.equal(effective.config.bufferBps,7);
  assert.equal(effective.config.mode,'live');
});
