import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSettings,utcMinute} from './configuration.js';

test('settings round trip keeps every chosen rule and UTC replay boundary without mutation',()=>{
  const input={config:{mode:'replay',initialCash:2500,horizonMs:300000,model:'trend',lookbackIntervals:23,
    bufferBps:42,allocationFraction:.3,stopLossBps:180,maxDrawdownBps:900,dailyLossBps:300,cashYieldBps:425,feeBps:12,slippageBps:5,durationMs:7200000,
    maxQuoteAgeMs:60000,maxOutcomeLatenessMs:30000},replay:{source:'range',start:'2026-10-09T12:00',end:'2026-10-09T13:00',halfSpreadBps:3.5}};
  const before=structuredClone(input),settings=normalizeSettings(input);
  assert.deepEqual(input,before);
  assert.deepEqual(settings.config,input.config);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(settings))),settings);
});

test('settings typos and numeric strings fail instead of silently using defaults',()=>{
  assert.throws(()=>normalizeSettings({config:{lookbackInterval:20}}),/Unknown configuration field/);
  assert.throws(()=>normalizeSettings({config:{initialCash:'1000'}}),/initialCash/);
  assert.throws(()=>normalizeSettings({config:{allocationFraction:.51}}),/allocationFraction/);
  assert.throws(()=>normalizeSettings({config:{lookbackIntervals:1.5}}),/lookbackIntervals/);
  assert.throws(()=>normalizeSettings({config:{maxDrawdownBps:-1}}),/maxDrawdownBps/);
  assert.throws(()=>normalizeSettings({config:{dailyLossBps:10000}}),/dailyLossBps/);
  assert.throws(()=>normalizeSettings({config:{cashYieldBps:2001}}),/cashYieldBps/);
  assert.throws(()=>normalizeSettings({config:{horizonMs:1234}}),/supported forecast horizons/);
  assert.throws(()=>normalizeSettings({config:{},replay:{halfSpreadBps:-1}}),/half-spread/);
});

test('UTC minute parsing rejects local offsets, rollover dates, seconds and invalid ranges',()=>{
  assert.equal(utcMinute('2026-10-09T12:30'),Date.UTC(2026,9,9,12,30));
  for(const value of ['2026-02-30T12:00','2026-10-09T12:30Z','2026-10-09T12:30:00','2026-10-09T12:30-04:00'])assert.throws(()=>utcMinute(value));
  const config={horizonMs:60000};
  assert.throws(()=>normalizeSettings({config,replay:{source:'range',start:'2026-10-09T13:00',end:'2026-10-09T12:00'}}),/increasing UTC range/);
  assert.throws(()=>normalizeSettings({config,replay:{source:'range',start:'2026-01-01T00:00',end:'2026-02-02T00:00'}}),/31 days/);
  assert.throws(()=>normalizeSettings({config,replay:{source:'range',start:'2999-01-01T00:00',end:'2999-01-02T00:00'}}),/completed minute/);
});
