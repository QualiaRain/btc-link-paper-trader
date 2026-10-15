import {it} from 'node:test';
import assert from 'node:assert/strict';
import {coverageLine} from '../src/run-panels.ts';

it('partial or non-finite imported coverage stays unavailable instead of crashing or displaying a number', () => {
  for (const coverage of [{BTC: {}, LINK: {}}, {BTC: {expectedCount: 1, observedCount: 1, missingCount: 0}, LINK: {}},
    {BTC: {expectedCount: 1, observedCount: NaN, missingCount: 0}, LINK: {expectedCount: 1, observedCount: 1, missingCount: 0}}]) {
    const text = coverageLine({kind: 'historical', mode: 'replay', coverage: coverage as any, receiptCount: 0,
      summary: {gapEvents: null, invalidFrames: null}});
    assert.match(text, /^Minute coverage not recorded for this run/);
    assert.match(text, /gap and invalid-frame counts not recorded/);
    assert.doesNotMatch(text, /NaN|undefined/);
  }
});
