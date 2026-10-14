import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pickHoldoutWindows} from './scripts/pick-holdout-windows.mjs';

const DAY=86400000;
const base={seed:'contract-test',from:'2026-01-01',to:'2026-10-01',days:28,count:3,exclude:['2026-10-10/2026-10-12']};

test('the same inputs always give the same windows, in date order',()=>{
  const a=pickHoldoutWindows(base),b=pickHoldoutWindows({...base});
  assert.deepEqual(a,b);
  assert.equal(a.windows.length,3);
  for(let i=1;i<a.windows.length;i++)assert.ok(a.windows[i].start>a.windows[i-1].start);
  // Pinned so a silent change to the draw procedure fails here rather than reshuffling a frozen contract.
  assert.deepEqual(a.windows.map(w=>w.start),['2026-02-20T00:00','2026-04-11T00:00','2026-06-09T00:00']);
});

test('a different seed gives different windows',()=>{
  const a=pickHoldoutWindows(base),b=pickHoldoutWindows({...base,seed:'another seed'});
  assert.notDeepEqual(a.windows,b.windows);
});

test('windows are whole UTC days of the requested length, inside the range, non-overlapping, and avoid exclusions',()=>{
  const exclude=['2026-03-01/2026-04-15','2026-07-04'];
  const out=pickHoldoutWindows({seed:'s',from:'2026-01-01',to:'2026-10-01',days:31,count:4,exclude});
  const from=Date.parse('2026-01-01T00:00Z'),to=Date.parse('2026-10-01T00:00Z');
  const spans=out.windows.map(w=>[Date.parse(w.start+':00Z'),Date.parse(w.end+':00Z')]);
  for(const [s,e] of spans){
    assert.equal(e-s,31*DAY);
    assert.ok(s>=from&&e<=to);
    assert.equal(s%DAY,0);
    for(const [a,b] of [[Date.parse('2026-03-01T00:00Z'),Date.parse('2026-04-15T00:00Z')],[Date.parse('2026-07-04T00:00Z'),Date.parse('2026-07-05T00:00Z')]])
      assert.ok(e<=a||s>=b,`window ${s}-${e} overlaps an excluded interval`);
  }
  for(let i=0;i<spans.length;i++)for(let j=i+1;j<spans.length;j++)
    assert.ok(spans[i][1]<=spans[j][0]||spans[j][1]<=spans[i][0],'windows overlap');
});

test('rejects impossible or invalid requests instead of guessing',()=>{
  assert.throws(()=>pickHoldoutWindows({...base,days:32}),/1 to 31/);
  assert.throws(()=>pickHoldoutWindows({...base,seed:''}),/seed/);
  assert.throws(()=>pickHoldoutWindows({...base,from:'2026-02-30'}),/Invalid UTC date/);
  assert.throws(()=>pickHoldoutWindows({...base,from:'2026-09-20',to:'2026-10-01'}),/Only 0 non-overlapping/);
  assert.throws(()=>pickHoldoutWindows({...base,count:50}),/non-overlapping/);
});

test('the command line prints the same JSON as the module',()=>{
  const stdout=execFileSync(process.execPath,['scripts/pick-holdout-windows.mjs','--seed',base.seed,'--from',base.from,'--to',base.to,
    '--days',String(base.days),'--count',String(base.count),'--exclude',base.exclude.join(',')],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(stdout),pickHoldoutWindows(base));
});
