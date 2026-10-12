// Seeded, clock-free inputs for the evidence parity tests. Regenerate: node parity/evidence/generate-inputs.mjs
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const M = 60000, out = fileURLToPath(new URL('./inputs/', import.meta.url));
mkdirSync(out, {recursive: true});
const mulberry = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const START = Date.UTC(2024, 2, 9, 12, 0);
const write = (name, kind, scenarios) => { writeFileSync(out + `${name}.json`, JSON.stringify({name, kind, scenarios}) + '\n'); console.log(name, scenarios.length); };

// ---------------------------------------------------------------- pack / unpack of hand-built markets
const r = (time, price, extra = {}) => ({time, price, ...extra});
const quote = mid => ({bid: mid * 0.9998, ask: mid * 1.0002, mid, observedAt: 0, simulatedQuote: true, source: 'x'});
const frame = (time, btc, link) => {
  const f = {time, quotes: {BTC: quote(10), LINK: quote(2)}};
  if (btc !== undefined || link !== undefined) f.history = {...(btc ? {BTC: btc} : {}), ...(link ? {LINK: link} : {})};
  return f;
};
const A = r(1000, 100.5), B = r(2000, 101.25), C = r(3000, 99.75), D = r(4000, 100), E = r(5000, 0.1 + 0.2);
const market = frames => ({kind: 'sample', dataset: {source: 's', scoreStart: 1000, scoreEnd: 5000, frames}, cursor: 1,
  lastObservedFrame: frames[1], scoreStart: 1000, scoreEnd: 5000, settings: {format: 'paper-trail-settings-v2'}});
const pack = [
  {name: 'growing-contiguous-histories', market: market([frame(1000, [A], [A]), frame(2000, [A, B], [A, B]), frame(3000, [A, B, C], [B, C]), frame(4000, [B, C, D], [C, D])])},
  {name: 'sparse-histories-use-indices', market: market([frame(1000, [A, B, C], [A]), frame(2000, [B, C, D], [A, B]), frame(3000, [A, C, D], [B]), frame(4000, [D, C, B, A], [A, A, B])])},
  {name: 'empty-and-missing-history', market: market([frame(1000), frame(2000, [], []), {...frame(3000, [A]), history: null}, frame(4000, [A, B]), {...frame(5000), history: {}}])},
  {name: 'asset-only-in-some-frames', market: market([frame(1000, [A]), frame(2000, [A, B], [A]), frame(3000, undefined, [B, C])])},
  {name: 'key-order-and-extra-fields', market: market([frame(1000, [{price: 100.5, time: 1000}], [A]), frame(2000, [A, {time: 2000, price: 101.25, note: 'x'}, {note: 'x', price: 101.25, time: 2000}], [B])])},
  {name: 'number-formatting-variants', market: market([frame(1000, [r(1, 1e21), r(2, 1e-7), r(3, 123456789012345680000), r(4, 5e-324), r(5, 100), r(6, 0.1 + 0.2), r(7, 1.7976931348623157e308)], [r(1, 1e21)]), frame(2000, [r(1, 1e21), r(2, 1e-7)], [A])])},
  {name: 'non-object-history-entries', market: market([frame(1000, [null, 5, 'x', [1, 2], A], [A]), frame(2000, [5, 'x', null], [A])])},
  {name: 'unicode-keys-and-values', market: market([frame(1000, [{time: 1, price: 2, 'é': 'ü', 'z': '\u{1F600}', 'A': ' '}], [A])])},
  {name: 'market-that-is-itself-a-dataset', market: {source: 'direct', frames: [frame(1000, [A]), frame(2000, [A, B])], scoreStart: 1000}},
  {name: 'dataset-and-top-level-frames-both-present', market: {kind: 'x', frames: [frame(1000, [A])], dataset: {frames: [frame(1000, [B]), frame(2000, [B, C])]}}},
  {name: 'dataset-without-frames', market: {kind: 'live', dataset: {source: 'x', frames: 'none'}}},
  {name: 'dataset-null', market: {kind: 'live', dataset: null, cursor: 0}},
  {name: 'empty-market-object', market: {}},
  {name: 'market-null', market: null},
  {name: 'already-packed-is-unchanged', market: {kind: 'sample', dataset: {historyEncoding: 'history-catalog-v1', historyCatalog: {BTC: [A, B]}, frames: [{time: 1, historyRefs: {BTC: {start: 0, length: 2}}}]}}},
  {name: 'frame-history-not-rows', market: market([{time: 1, history: {BTC: 5}}])},
  {name: 'frame-history-string-value', market: market([{time: 1, history: {BTC: 'abc'}}])},
  {name: 'many-frames-same-rows', market: market(Array.from({length: 40}, (_, i) => frame(1000 + i, [r(i, 100 + i), r(i + 1, 101 + i), r(i + 2, 102 + i)], [r(i, 1 + i / 10)])))},
];
write('pack-market', 'pack-market', pack);

const packed = (refs, catalog = {BTC: [A, B, C]}, extra = {}) => ({kind: 'sample', dataset: {historyEncoding: 'history-catalog-v1', historyCatalog: catalog,
  frames: [{time: 1, quotes: {}, historyRefs: refs}], ...extra}});
write('unpack-market', 'unpack-market', [
  {name: 'valid-range-and-indices', market: packed({BTC: {start: 1, length: 2}, LINK: {indices: [0, 0, 1]}}, {BTC: [A, B, C], LINK: [D, E]})},
  {name: 'zero-length-ignores-start', market: packed({BTC: {start: 99, length: 0}})},
  {name: 'empty-indices', market: packed({BTC: {indices: []}})},
  {name: 'float-integral-indices-and-start', market: packed({BTC: {indices: [2.0, 0]}, LINK: {start: 1.0, length: 1.0}}, {BTC: [A, B, C], LINK: [D, E]})},
  {name: 'frame-without-refs', market: {dataset: {historyEncoding: 'history-catalog-v1', historyCatalog: {}, frames: [{time: 1}, {time: 2, historyRefs: null}]}}},
  {name: 'top-level-packed', market: {historyEncoding: 'history-catalog-v1', historyCatalog: {BTC: [A]}, frames: [{time: 1, historyRefs: {BTC: {start: 0, length: 1}}}], source: 'direct'}},
  {name: 'not-packed-passes-through', market: {kind: 'live', dataset: {frames: [{time: 1, history: {BTC: [A]}}]}}},
  {name: 'missing-catalog', market: {dataset: {historyEncoding: 'history-catalog-v1', frames: []}}},
  {name: 'frames-not-array', market: {dataset: {historyEncoding: 'history-catalog-v1', historyCatalog: {}, frames: 'x'}}},
  {name: 'asset-catalog-missing', market: packed({LINK: {start: 0, length: 1}})},
  {name: 'asset-catalog-not-array', market: packed({BTC: {start: 0, length: 1}}, {BTC: {a: 1}})},
  {name: 'range-past-catalog', market: packed({BTC: {start: 2, length: 2}})},
  {name: 'negative-start', market: packed({BTC: {start: -1, length: 1}})},
  {name: 'negative-length', market: packed({BTC: {start: 0, length: -1}})},
  {name: 'fractional-start', market: packed({BTC: {start: 0.5, length: 1}})},
  {name: 'missing-length', market: packed({BTC: {start: 0}})},
  {name: 'neither-range-nor-indices', market: packed({BTC: {}})},
  {name: 'index-out-of-range', market: packed({BTC: {indices: [0, 3]}})},
  {name: 'negative-index', market: packed({BTC: {indices: [-1]}})},
  {name: 'fractional-index', market: packed({BTC: {indices: [1.5]}})},
  {name: 'string-index', market: packed({BTC: {indices: ['1']}})},
  {name: 'null-index', market: packed({BTC: {indices: [null]}})},
  {name: 'boolean-start', market: packed({BTC: {start: true, length: 1}})},
  {name: 'market-null', market: null},
]);

// ---------------------------------------------------------------- app-style snapshots (sample and range datasets)
const sampleSettings = (half, lookback, extra = {}) => ({config: {lookbackIntervals: lookback, horizonMs: 300000, bufferBps: 0, feeBps: 1, slippageBps: 0, initialCash: 1000, ...extra}, replay: {source: 'sample', halfSpreadBps: half}});
function candles(spanMinutes, warm, holesBtc, holesLink, seed) {
  const rnd = mulberry(seed), build = (base, holes) => { let p = base; const rows = [];
    for (let t = START - warm * M; t <= START + spanMinutes * M; t += M) {
      p = Math.round(p * (1 + (rnd() - 0.5) * 0.003) * 100) / 100;
      const k = (t - START) / M;
      if (!holes.some(h => typeof h === 'number' ? h === k : (k >= h[0] && k <= h[1]) || (h[2] && k > 0 && k < spanMinutes && k % h[2] === 0))) rows.push({time: t, price: p});
    } return rows; };
  return {BTC: build(61000.5, holesBtc), LINK: build(18.37, holesLink)};
}
const rangeSettings = (span, lookback, half) => ({config: {lookbackIntervals: lookback, horizonMs: 300000, bufferBps: 0, feeBps: 1, slippageBps: 0, initialCash: 1000},
  replay: {source: 'range', start: '2024-03-09T12:00', end: new Date(START + span * M).toISOString().slice(0, 16), halfSpreadBps: half}});
const CLOCK = Date.UTC(2024, 2, 10);
const range = (name, span, lookback, half, holesBtc, holesLink, cursors, seed) => ({name, settings: rangeSettings(span, lookback, half),
  dataset: {source: 'range', clockBase: CLOCK, candles: candles(span, Math.max(60, 2 * lookback + 10), holesBtc, holesLink, seed)}, cursors});
write('app-snapshots', 'app-snapshot', [
  {name: 'sample-full', settings: sampleSettings(2, 7), dataset: {source: 'sample'}, cursors: [7, -1], skipFramesHash: true},
  {name: 'sample-140-frames-half-spread-fraction', settings: sampleSettings(0.5, 7), dataset: {source: 'sample', frameLimit: 140}, cursors: [7, 8, 40, 100, -1]},
  {name: 'sample-lookback-30-zero-spread', settings: sampleSettings(0, 30), dataset: {source: 'sample', frameLimit: 200}, cursors: [30, 31, 120, -1]},
  {name: 'sample-sparse-histories', settings: sampleSettings(3.25, 7), dataset: {source: 'sample', frameLimit: 200, thinEvery: 5}, cursors: [7, 50, -1]},
  range('range-complete', 120, 7, 3.5, [], [], [0, 30, -1], 11),
  range('range-gapped-both-assets', 180, 7, 2, [5, 6, [40, 44], -20, -3, 100], [6, 50, [90, 91], -10, 179 - 1], [0, 60, -1], 12),
  range('range-sparse-every-7th-and-11th', 150, 7, 1.25, [[1, 0, 7]], [[1, 0, 11]], [0, 17, 75, -1], 13),
  range('range-lookback-20-warmup-70', 100, 20, 0.5, [[10, 12], -30], [-5, [70, 71]], [0, 50, -1], 14),
]);

// ---------------------------------------------------------------- existing browser-saved runs
write('fixtures', 'fixture', ['browser-run-completed', 'browser-run-partial-manual', 'browser-run-live-partial']
  .map(name => ({name, path: `../fixtures/${name}.json`})));
