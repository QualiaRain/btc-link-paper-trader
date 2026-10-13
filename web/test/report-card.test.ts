// The TypeScript report card (src/report-card.ts) must return exactly what the ROOT report-card.js returns:
// every verdict branch, the sign-test p-value, detectable edge, hit rate and average-miss change, compared with
// strict deep equality (numbers bit for bit) over a broad set of summaries.
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import * as ts from '../src/report-card.ts';
import {repo} from './server.ts';

type Json = any; // the root modules are untyped JavaScript
interface RootCard {
  MIN_FORECASTS: number;
  SIGNIFICANCE: number;
  signTestPValue(hits: number, misses: number): number;
  detectableEdgePts(n: number): number | null;
  gradeAsset(stats: Json, model: string): Json;
  reportCard(summary: Json, model: string): Json;
}
interface RootEngine { createAccount(config: object): Json; ingest(a: Json, frame: Json): Json; getSummary(a: Json): Json }

const root = async (): Promise<RootCard> => await import(repo('report-card.js')) as RootCard;
const stats = (hits: number, misses: number, {flat = 0, mae = 1 as number | null, samePriceMae = 1 as number | null} = {}) =>
  ({count: hits + misses + flat, directionHits: hits, directionMisses: misses, directionFlat: flat, mae, samePriceMae});
const MODELS = ['trend', 'same-price'];

describe('TypeScript report card equals the root report-card.js', () => {
  it('exports the same thresholds, p-values and detectable edges', async () => {
    const js = await root();
    assert.equal(ts.MIN_FORECASTS, js.MIN_FORECASTS);
    assert.equal(ts.SIGNIFICANCE, js.SIGNIFICANCE);
    for (let n = 0; n <= 300; n++) {
      assert.equal(ts.detectableEdgePts(n), js.detectableEdgePts(n), `detectable ${n}`);
      for (let hits = 0; hits <= n; hits++) assert.equal(ts.signTestPValue(hits, n - hits), js.signTestPValue(hits, n - hits), `p ${hits}/${n}`);
    }
    for (const [h, m] of [[16000, 15000], [15000, 16000], [5000, 5000], [50000, 49000], [1, 100000], [0, 1]] as const) {
      assert.equal(ts.signTestPValue(h, m), js.signTestPValue(h, m), `p ${h}/${m}`);
      assert.equal(ts.detectableEdgePts(h + m), js.detectableEdgePts(h + m));
    }
  });

  it('grades every hit/miss split up to 160 decided forecasts, with and without flat ones, identically', async () => {
    const js = await root();
    const verdicts = new Map<string, number>();
    const nearThreshold = {below: 0, above: 0};
    for (let decided = 0; decided <= 160; decided++) {
      for (let hits = 0; hits <= decided; hits++) {
        for (const flat of [0, 3]) {
          for (const model of MODELS) {
            const s = stats(hits, decided - hits, {flat});
            const got = ts.gradeAsset(s, model), want = js.gradeAsset(s, model);
            assert.deepStrictEqual(got, want, `${model} ${hits}/${decided} flat ${flat}`);
            verdicts.set(got.verdict, (verdicts.get(got.verdict) ?? 0) + 1);
            if (got.pValue !== null && got.pValue > 0.02 && got.pValue < 0.03) nearThreshold[got.pValue < ts.SIGNIFICANCE ? 'below' : 'above']++;
          }
        }
      }
    }
    assert.deepEqual([...verdicts.keys()].sort(), ['baseline', 'better', 'none', 'too_few', 'unclear', 'worse']);
    assert.ok(nearThreshold.below > 5 && nearThreshold.above > 5, JSON.stringify(nearThreshold));
  });

  it('agrees on p-values on either side of 0.025 and at the minimum forecast count', async () => {
    const js = await root();
    const cases: [number, number][] = [];
    for (let n = 29; n <= 400; n++) {
      for (let hits = 0; hits <= n; hits++) {
        const p = js.signTestPValue(hits, n - hits);
        if (Math.abs(p - 0.025) < 0.0015) cases.push([hits, n - hits]);
      }
    }
    assert.ok(cases.length > 50, `${cases.length} near-threshold splits`);
    for (const [hits, misses] of [...cases, [40, 22], [25, 5], [5, 25], [20, 10], [30, 0], [0, 30], [29, 0], [15, 15]] as [number, number][]) {
      const s = stats(hits, misses);
      const got = ts.gradeAsset(s, 'trend');
      assert.deepStrictEqual(got, js.gradeAsset(s, 'trend'), `${hits}/${misses}`);
    }
    const g = ts.gradeAsset(stats(40, 22), 'trend'); // report-card.test.js: between 0.025 and 0.05 is unclear
    assert.ok(g.pValue! > 0.025 && g.pValue! < 0.05 && g.verdict === 'unclear');
  });

  it('agrees on edge cases: nothing decided, flat only, missing or null fields, odd errors and summaries', async () => {
    const js = await root();
    const odd: Json[] = [
      undefined, null, {}, {count: 0}, {count: 5}, {count: 50, directionFlat: 50}, stats(0, 0), stats(0, 0, {flat: 50}),
      stats(29, 0, {flat: 50}), stats(30, 0), stats(0, 30), {count: 40, directionHits: 35}, {count: 40, directionMisses: 35},
      {count: 40, directionHits: null, directionMisses: null, directionFlat: null},
      {count: 40, mae: 1, samePriceMae: 1}, // a summary saved before the counts existed
      stats(31, 9, {mae: null}), stats(31, 9, {samePriceMae: 0}), stats(31, 9, {samePriceMae: null}), stats(31, 9, {mae: 0, samePriceMae: 3}),
      stats(31, 9, {mae: 2.5, samePriceMae: 1e-9}), stats(31, 9, {mae: 1e-12, samePriceMae: 7}), stats(31, 9, {samePriceMae: -1}),
      {...stats(31, 9), count: 0}, {...stats(31, 9), count: null},
    ];
    for (const s of odd) for (const model of [...MODELS, 'other']) assert.deepStrictEqual(ts.gradeAsset(s, model), js.gradeAsset(s, model), JSON.stringify(s));
    const summaries: Json[] = [undefined, null, {}, {perAsset: null}, {perAsset: {}}, {perAsset: {BTC: stats(40, 10), LINK: stats(0, 0, {flat: 9})}},
      {perAsset: {BTC: null, LINK: {count: 3}, DOGE: stats(100, 120)}}];
    for (const s of summaries) for (const model of MODELS) assert.deepStrictEqual(ts.reportCard(s, model), js.reportCard(s, model), JSON.stringify(s));
  });

  it('agrees on real engine summaries, including the random-walk control (no claimed skill)', async () => {
    const js = await root();
    const engine = await import(repo('engine.js')) as RootEngine;
    let seed = 1;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const verdicts: Record<string, number> = {};
    const trials = 8;
    for (let trial = 0; trial < trials; trial++) {
      const h: Record<string, Json[]> = {BTC: [], LINK: []}, p: Record<string, number> = {BTC: 60000, LINK: 12}, frames: Json[] = [];
      for (let i = 0; i < 1800; i++) {
        const time = Date.UTC(2026, 0, 1) + i * 60000, quotes: Json = {};
        for (const s of ['BTC', 'LINK']) {
          p[s]! *= Math.exp(.0006 * gauss()); h[s]!.push({time, price: p[s]}); if (h[s]!.length > 20) h[s]!.shift();
          quotes[s] = {bid: p[s]! * .9997, ask: p[s]! * 1.0003, mid: p[s], observedAt: time};
        }
        frames.push({time, quotes, history: {BTC: h['BTC']!.slice(), LINK: h['LINK']!.slice()}});
      }
      for (const model of MODELS) {
        const a = engine.createAccount({model, horizonMs: trial % 2 ? 60000 : 420000, durationMs: frames.at(-1).time - frames[7].time});
        for (const f of frames.slice(7)) engine.ingest(a, f);
        const summary = engine.getSummary(a);
        const card = ts.reportCard(summary, model);
        assert.deepStrictEqual(card, js.reportCard(summary, model));
        if (model === 'trend') for (const s of ['BTC', 'LINK']) verdicts[card[s]!.verdict] = (verdicts[card[s]!.verdict] ?? 0) + 1;
      }
    }
    assert.ok((verdicts['unclear'] ?? 0) >= 2 * trials - 2, JSON.stringify(verdicts));
  });
});
