// Tests for research/stats.mjs. The answer sheets are independent of the code under test: closed forms and
// textbook t tables, an exact finite series for the t distribution (NBS Handbook of Mathematical Functions,
// 26.7.3 and 26.7.4), hand-solved examples, a slow literal transcription of the protocol's reality-check
// paragraph, and calibration by simulation. Every random number comes from a seeded generator, so each run of
// this file is identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mean, sampleSd, tStat, studentTCdf, tTestGreaterP, ols, mulberry32, realityCheck, signTestPValue} from './stats.mjs';
import {signTestPValue as appSignTest} from '../report-card.js';

const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} (tolerance ${tolerance})`);
// Standard normal draws from pairs of uniform draws (the log and cosine transform).
const gaussian = random => () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

test('mean, sampleSd and tStat match hand values and the stated conventions', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  near(sampleSd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7), 1e-15);   // squared deviations sum to 32
  near(tStat([1, 2, 3]), 2 * Math.sqrt(3), 1e-15);                      // mean 2, sd 1, n 3
  near(tStat(Float64Array.of(-1, -2, -3)), -2 * Math.sqrt(3), 1e-15);
  // n - 1 denominator: two values a and b have sd |a - b| / sqrt(2).
  near(sampleSd([10, 14]), 4 / Math.SQRT2, 1e-15);
  // Fewer than two values: sd 0 and T 0. An empty mean is NaN.
  assert.equal(sampleSd([]), 0); assert.equal(sampleSd([5]), 0);
  assert.equal(tStat([]), 0); assert.equal(tStat([5]), 0);
  assert.ok(Number.isNaN(mean([]))); assert.equal(mean([5]), 5);
  // Identical values: sd is exactly 0 (summing 0.1 three times does not give 0.3), so T is 0, not huge.
  assert.equal(sampleSd([0.1, 0.1, 0.1]), 0); assert.equal(tStat([0.1, 0.1, 0.1]), 0); assert.equal(mean([0.1, 0.1, 0.1]), 0.1);
  // A missing value is an error, never silently skipped.
  for (const bad of [NaN, Infinity, -Infinity, undefined, '1'])
    for (const f of [mean, sampleSd, tStat, tTestGreaterP]) assert.throws(() => f([1, bad, 3]), TypeError);
});

test('mulberry32 is deterministic, stays in [0, 1) and matches reference arithmetic modulo 2^32', () => {
  // The published definition written with BigInt, independent of Math.imul and signed 32-bit wraparound.
  const reference = seed => {
    const M = 1n << 32n;
    let a = BigInt(seed);
    return () => {
      a = (a + 0x6D2B79F5n) % M;
      let t = ((a ^ (a >> 15n)) * (a | 1n)) % M;
      t ^= (t + ((t ^ (t >> 7n)) * (t | 61n)) % M) % M;
      return Number(t ^ (t >> 14n)) / 4294967296;
    };
  };
  for (const seed of [0, 1, 20261118, 0xFFFFFFFF]) {
    const ours = mulberry32(seed), theirs = reference(seed);
    for (let i = 0; i < 2000; i++) {
      const value = ours();
      assert.equal(value, theirs());
      assert.ok(value >= 0 && value < 1);
    }
  }
  assert.deepEqual(Array.from({length: 3}, mulberry32(1)), [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  assert.deepEqual(Array.from({length: 2}, mulberry32(20261118)), [0.02845785580575466, 0.23895404138602316]);
  // Roughly uniform: mean 1/2 and variance 1/12 over 200,000 draws.
  const draws = Float64Array.from({length: 200000}, mulberry32(42));
  near(mean(draws), 0.5, 0.003); near(sampleSd(draws) ** 2, 1 / 12, 0.001);
});

// Exact for integer df (NBS Handbook of Mathematical Functions 26.7.3, 26.7.4), with theta = atan(t / sqrt(df)):
//   odd df:  P(|T| <= t) = (2/pi) (theta + sin(theta) (cos + (2/3) cos^3 + ... up to cos^(df-2)))
//   even df: P(|T| <= t) = sin(theta) (1 + (1/2) cos^2 + (1*3)/(2*4) cos^4 + ... up to cos^(df-2))
function seriesCdf(t, df) {
  const theta = Math.atan(t / Math.sqrt(df)), cos2 = Math.cos(theta) ** 2;
  let term = df % 2 ? Math.cos(theta) : 1, sum = df === 1 ? 0 : term;
  for (let k = df % 2 ? 3 : 2; k <= df - 2; k += 2) { term *= (k - 1) / k * cos2; sum += term; }
  return (1 + (df % 2 ? 2 / Math.PI * (theta + Math.sin(theta) * sum) : Math.sin(theta) * sum)) / 2;
}

test('studentTCdf: known quantiles for df 24, 49 and 1', () => {
  // Textbook upper quantiles to four decimals; rounding the quantile moves the cdf by less than 1e-5.
  const table = {
    24: [[1.7109, 0.95], [2.0639, 0.975], [2.4922, 0.99], [2.7969, 0.995]],
    49: [[1.6766, 0.95], [2.0096, 0.975], [2.4049, 0.99], [2.6800, 0.995]],
    1: [[6.3138, 0.95], [12.7062, 0.975], [31.8205, 0.99], [63.6567, 0.995]],
  };
  for (const [df, rows] of Object.entries(table))
    for (const [t, p] of rows) {
      near(studentTCdf(t, +df), p, 1e-5, `df ${df} t ${t}`);
      near(studentTCdf(-t, +df), 1 - p, 1e-5, `df ${df} t ${-t}`);
    }
  // df 1 has the closed form cdf = 1/2 + atan(t)/pi, so its quantiles are tan(pi (p - 1/2)) exactly.
  for (const p of [0.6, 0.75, 0.9, 0.95, 0.975, 0.99, 0.995, 0.9999])
    near(studentTCdf(Math.tan(Math.PI * (p - 0.5)), 1), p, 1e-13, `df 1 p ${p}`);
  assert.equal(studentTCdf(0, 24), 0.5); assert.equal(studentTCdf(0, 49), 0.5);
});

test('studentTCdf agrees with closed forms to far better than 1e-10', () => {
  for (let t = -40; t <= 40; t += 0.173) {
    near(studentTCdf(t, 1), 0.5 + Math.atan(t) / Math.PI, 1e-14, `df 1 t ${t}`);
    near(studentTCdf(t, 2), 0.5 + t / (2 * Math.sqrt(2 + t * t)), 1e-14, `df 2 t ${t}`);
  }
  // Integer df against the exact finite series, including every df the protocol can produce (n <= 74 windows).
  for (const df of [...Array.from({length: 100}, (_, i) => i + 1), 250, 501, 1000, 10000])
    for (let t = -40; t <= 40; t += 0.0613) near(studentTCdf(t, df), seriesCdf(t, df), df > 100 ? 1e-11 : 1e-13, `df ${df} t ${t}`);
  // Far tails keep relative accuracy (a small p-value is not rounded away): df 1 and 2 in closed form.
  for (const t of [1e2, 1e4, 1e8, 1e12]) {
    const one = Math.atan(1 / t) / Math.PI, two = 1 / (Math.sqrt(2 + t * t) * (t + Math.sqrt(2 + t * t)));
    near(studentTCdf(-t, 1) / one, 1, 1e-12, `df 1 tail ${t}`);
    near(studentTCdf(-t, 2) / two, 1, 1e-12, `df 2 tail ${t}`);
  }
});

test('studentTCdf: non-integer df, symmetry, monotonicity, limits and invalid df', () => {
  // With t = sqrt(df) tan(theta) the density is proportional to cos(theta)^(df - 1), so the cdf is a ratio of two
  // plain integrals, here by the composite three-point (parabolic) rule: no gamma function involved.
  const integrate = (f, from, to, steps = 20000) => {
    const h = (to - from) / steps;
    let sum = f(from) + f(to);
    for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * f(from + i * h);
    return sum * h / 3;
  };
  for (const df of [3.5, 7.25, 12.5]) {
    const density = theta => Math.cos(theta) ** (df - 1), whole = integrate(density, -Math.PI / 2, Math.PI / 2);
    for (const t of [-3.1, -0.4, 0.9, 2.2, 6])
      near(studentTCdf(t, df), integrate(density, -Math.PI / 2, Math.atan(t / Math.sqrt(df))) / whole, 1e-9, `df ${df} t ${t}`);
  }
  for (const df of [0.3, 1, 2.5, 24, 49, 73, 1e5]) {
    let previous = 0;
    for (let t = -30; t <= 30; t += 0.25) {
      const p = studentTCdf(t, df);
      // The lower tail never rounds to 0 (at df 1e5, t = -30 it is near 1e-196); the upper side may round to 1.
      assert.ok(p >= previous && p > 0 && p <= 1, `monotone df ${df} t ${t}`);
      near(p + studentTCdf(-t, df), 1, 1e-15, `symmetry df ${df} t ${t}`);
      previous = p;
    }
    assert.equal(studentTCdf(0, df), 0.5);
    assert.equal(studentTCdf(Infinity, df), 1); assert.equal(studentTCdf(-Infinity, df), 0);
    assert.ok(Number.isNaN(studentTCdf(NaN, df)));
  }
  // Many degrees of freedom approach the normal distribution by the classical expansion in 1/df:
  // cdf = Phi(t) - phi(t) (t (t^2 + 1) / (4 df) + t (3 t^6 - 7 t^4 - 5 t^2 - 3) / (96 df^2) + ...).
  for (const [t, Phi] of [[1.96, 0.9750021048517795], [0.5, 0.6914624612740131]])
    for (const df of [1e3, 1e4, 1e5, 1e6]) {
      const phi = Math.exp(-t * t / 2) / Math.sqrt(2 * Math.PI);
      const terms = t * (t * t + 1) / (4 * df) + t * (3 * t ** 6 - 7 * t ** 4 - 5 * t * t - 3) / (96 * df * df)
        + t * (t ** 10 - 11 * t ** 8 + 14 * t ** 6 + 6 * t ** 4 - 3 * t * t - 15) / (384 * df ** 3);
      near(studentTCdf(t, df), Phi - phi * terms, 5e-12, `normal limit t ${t} df ${df}`);
    }
  // Beyond 1e6 the function refuses rather than lose accuracy.
  for (const df of [0, -1, NaN, Infinity, undefined, 1e6 + 1]) assert.throws(() => studentTCdf(1, df), RangeError);
});

// A sample of n values with mean t / sqrt(n) and sd exactly 1 by construction, so its t statistic is t:
// k = floor(n/2) values at mean - d, k at mean + d and the rest at the mean, with d = sqrt((n - 1) / (2k)).
function sampleWithT(n, t) {
  const k = Math.floor(n / 2), d = Math.sqrt((n - 1) / (2 * k)), centre = t / Math.sqrt(n);
  return Array.from({length: n}, (_, i) => centre + (i < k ? -d : i < 2 * k ? d : 0));
}

test('tTestGreaterP matches hand values and its conventions', () => {
  // [0, 2]: mean 1, sd sqrt(2), t = 1 with 1 df: P(T > 1) = 1/2 - atan(1)/pi = 1/4.
  near(tTestGreaterP([0, 2]), 0.25, 1e-15);
  // [1, 3]: t = 2 with 1 df: 1/2 - atan(2)/pi.
  near(tTestGreaterP([1, 3]), 0.5 - Math.atan(2) / Math.PI, 1e-15);
  near(tTestGreaterP([-1, -3]), 0.5 + Math.atan(2) / Math.PI, 1e-15);
  // [1, 2, 3]: t = 2 sqrt(3) with 2 df: 1/2 - t / (2 sqrt(2 + t^2)) = 1/2 - sqrt(3/14).
  near(tTestGreaterP([1, 2, 3]), 0.5 - Math.sqrt(3 / 14), 1e-15);
  near(tTestGreaterP([-1, 0, 1]), 0.5, 1e-15);
  // Textbook critical values: n = 25 with t = 2.0639 is p = 0.025; n = 50 with t = 1.6766 is p = 0.05.
  near(tStat(sampleWithT(25, 2.0639)), 2.0639, 1e-12);
  near(tTestGreaterP(sampleWithT(25, 2.0639)), 0.025, 1e-6);
  near(tTestGreaterP(sampleWithT(50, 1.6766)), 0.05, 1e-5);
  near(tTestGreaterP(sampleWithT(50, -1.6766)), 0.95, 1e-5);
  near(tTestGreaterP(sampleWithT(24, 2.5)), 1 - seriesCdf(2.5, 23), 1e-13);
  // It is the upper tail of studentTCdf at tStat with n - 1 degrees of freedom.
  const xs = [0.3, -1.2, 2.5, 0.8, -0.1, 1.9, 0.4];
  near(tTestGreaterP(xs), 1 - studentTCdf(tStat(xs), xs.length - 1), 1e-15);
  // Conventions: nothing can be shown with fewer than two values; identical values take the limit of the test.
  assert.equal(tTestGreaterP([]), 1); assert.equal(tTestGreaterP([5]), 1);
  assert.equal(tTestGreaterP([2, 2, 2]), 0);
  assert.equal(tTestGreaterP([0, 0]), 1); assert.equal(tTestGreaterP([-1, -1, -1]), 1);
});

test('ols matches a hand-solved example and its conventions', () => {
  // x = 1..5, y = 2, 4, 5, 4, 5: means 3 and 4, Sxx = 10, Sxy = 6, Syy = 6, so slope 0.6 and intercept 2.2.
  // Residuals -0.8, 0.6, 1.0, -0.6, -0.2 have squares summing to 2.4: r2 = 1 - 2.4/6, variance 2.4/3 = 0.8,
  // seSlope = sqrt(0.8/10), seIntercept = sqrt(0.8 (1/5 + 9/10)) = sqrt(0.88), t = 2.2 / sqrt(0.88) = sqrt(5.5).
  const fit = ols([2, 4, 5, 4, 5], [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(fit), ['n', 'intercept', 'slope', 'seIntercept', 'seSlope', 'tIntercept', 'pInterceptGreater', 'r2']);
  assert.equal(fit.n, 5);
  near(fit.slope, 0.6, 1e-14); near(fit.intercept, 2.2, 1e-14); near(fit.r2, 0.6, 1e-14);
  near(fit.seSlope, Math.sqrt(0.08), 1e-14); near(fit.seIntercept, Math.sqrt(0.88), 1e-14);
  near(fit.tIntercept, Math.sqrt(5.5), 1e-13);
  // 3 df in closed form: P(T > t) = 1/2 - (atan(q) + q / (1 + q^2)) / pi with q = t / sqrt(3), q^2 = 11/6.
  const q = Math.sqrt(11 / 6);
  near(fit.pInterceptGreater, 0.5 - (Math.atan(q) + q / (1 + q * q)) / Math.PI, 1e-14);
  // Shifting y moves only the intercept; a negative intercept has a one-sided p above 1/2.
  const shifted = ols([2, 4, 5, 4, 5].map(v => v - 5), Float64Array.of(1, 2, 3, 4, 5));
  near(shifted.slope, 0.6, 1e-14); near(shifted.intercept, -2.8, 1e-14); near(shifted.seIntercept, Math.sqrt(0.88), 1e-14);
  near(shifted.pInterceptGreater, studentTCdf(2.8 / Math.sqrt(0.88), 3), 1e-14);
  assert.ok(shifted.pInterceptGreater > 0.5);
  // Undefined quantities are NaN, not a guess.
  const constantX = ols([1, 2, 3], [4, 4, 4]);
  assert.equal(constantX.n, 3);
  for (const key of Object.keys(constantX)) if (key !== 'n') assert.ok(Number.isNaN(constantX[key]), key);
  assert.ok(Number.isNaN(ols([1], [1]).slope)); assert.equal(ols([], []).n, 0);
  const twoPoints = ols([1, 3], [0, 1]);
  assert.equal(twoPoints.slope, 2); assert.equal(twoPoints.intercept, 1); assert.equal(twoPoints.r2, 1);
  assert.ok(Number.isNaN(twoPoints.seSlope) && Number.isNaN(twoPoints.tIntercept) && Number.isNaN(twoPoints.pInterceptGreater));
  // A perfect fit: standard errors 0, T 0 by convention, p from the intercept's sign. A constant y has no r2.
  const perfect = ols([3, 5, 7, 9], [0, 1, 2, 3]);
  assert.deepEqual([perfect.intercept, perfect.slope, perfect.seIntercept, perfect.tIntercept, perfect.pInterceptGreater, perfect.r2], [3, 2, 0, 0, 0, 1]);
  assert.equal(ols([-3, -5, -7, -9], [0, 1, 2, 3]).pInterceptGreater, 1);
  const flat = ols([2, 2, 2, 2], [0, 1, 2, 3]);
  assert.deepEqual([flat.intercept, flat.slope], [2, 0]); assert.ok(Number.isNaN(flat.r2));
  assert.throws(() => ols([1, 2], [1, 2, 3]), RangeError);
  assert.throws(() => ols([1, NaN, 3], [1, 2, 3]), TypeError);
  assert.throws(() => ols([1, 2, 3], [1, Infinity, 3]), TypeError);
});

test('signTestPValue is the app\'s own function', () => {
  assert.equal(signTestPValue, appSignTest);
  near(signTestPValue(10, 0), 2 / 1024, 1e-15);
});

// The protocol paragraph transcribed as literally and slowly as possible: draw the windows of each resample one by
// one, then for every eligible setting average the drawn windows that are valid for it.
function slowRealityCheck({returns, eligible, resamples, seed}) {
  const windows = returns[0].length, random = mulberry32(seed);
  const full = eligible.map(c => {
    const valid = Array.from(returns[c]).filter(v => !Number.isNaN(v));
    return {c, n: valid.length, mean: mean(valid), sd: sampleSd(valid), t: tStat(valid)};
  });
  let observedMax = -Infinity, argmax = -1;
  for (const s of full) if (s.t > observedMax) { observedMax = s.t; argmax = s.c; }
  let reached = 0;
  for (let b = 0; b < resamples; b++) {
    // Sorted only so that a resample which redraws every valid window exactly once adds the same numbers in the
    // same order as the full-sample mean: that exact tie (statistic 0) must not depend on rounding.
    const drawn = Array.from({length: windows}, () => Math.floor(random() * windows)).sort((a, b) => a - b);
    let max = -Infinity;
    for (const s of full) {
      if (s.sd === 0) continue;
      const picked = drawn.map(w => returns[s.c][w]).filter(v => !Number.isNaN(v));
      if (picked.length < 2) continue;
      const total = picked.reduce((sum, v) => sum + v, 0);
      max = Math.max(max, (total / picked.length - s.mean) / (s.sd / Math.sqrt(s.n)));
    }
    if (max >= observedMax || max === -Infinity) reached++;
  }
  return {observedMax, argmax, p: reached / resamples, resamples, seed};
}

// Random returns with every kind of row the protocol can produce: complete rows, rows with invalid windows (some
// sharing a pattern), a window invalid for every setting, a row with one valid window, an all-invalid row and a
// row of identical values.
function messyReturns(seed, settings = 14, windows = 9) {
  const random = mulberry32(seed), normal = gaussian(random);
  const returns = Array.from({length: settings}, (_, c) =>
    Float64Array.from({length: windows}, () => (c % 3 - 1) * 0.4 + (1 + c % 4) * normal()));
  for (let c = 0; c < settings; c++) {
    returns[c][4] = NaN;                                             // invalid for every setting
    if (c % 3 === 0) returns[c][0] = NaN;                            // a shared pattern
    if (c % 5 === 1) returns[c][Math.floor(random() * windows)] = NaN;
  }
  returns[settings - 3].fill(NaN); returns[settings - 3][2] = 1.5;   // one valid window
  returns[settings - 2].fill(NaN);                                   // none
  returns[settings - 1].fill(0.25); returns[settings - 1][4] = NaN;  // identical values: sd 0
  return returns;
}

test('realityCheck equals the slow literal transcription, with invalid windows of every kind', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const returns = messyReturns(seed), all = returns.map((_, c) => c);
    for (const eligible of [all, all.filter(c => c % 2), all.slice(3, 8), all.slice().reverse(), [returns.length - 4, returns.length - 1]]) {
      const options = {returns, eligible, resamples: 3000, seed: 77 + seed};
      const fast = realityCheck(options);
      assert.deepEqual(fast, slowRealityCheck(options));
      // The observed maximum is tStat of the argmax setting's valid windows, to the last bit.
      assert.equal(fast.observedMax, tStat(returns[fast.argmax].filter(v => !Number.isNaN(v))));
      assert.ok(eligible.includes(fast.argmax) && fast.p >= 0 && fast.p <= 1);
    }
  }
  // Wider than 255 windows (the draw counts then need more than a byte) and a pattern unique to each setting.
  const wide = Array.from({length: 4}, (_, c) => Float64Array.from({length: 300}, gaussian(mulberry32(90 + c))));
  wide.forEach((row, c) => { row[c] = NaN; });
  const options = {returns: wide, eligible: [0, 1, 2, 3], resamples: 400, seed: 3};
  assert.deepEqual(realityCheck(options), slowRealityCheck(options));
});

test('realityCheck on a hand-solved case: one setting, three windows', () => {
  // Returns 1, 2, 6: mean 3, so T = 3 / se. A resample reaches T only when mean* - 3 >= 3, that is when all three
  // draws are the window holding 6: probability (1/3)^3 = 1/27. The tie is exact, so this also checks ">=".
  const returns = [Float64Array.of(1, 2, 6)], resamples = 200000;
  const result = realityCheck({returns, eligible: [0], resamples, seed: 11});
  near(result.observedMax, 3 / (Math.sqrt(7) / Math.sqrt(3)), 1e-15);
  assert.equal(result.argmax, 0);
  near(result.p, 1 / 27, 5 * Math.sqrt(1 / 27 * 26 / 27 / resamples));   // five standard errors
  // Mirrored returns -1, -2, -6: T = -3 / se, and no resample mean is below -6, so every resample reaches it.
  assert.equal(realityCheck({returns: [Float64Array.of(-1, -2, -6)], eligible: [0], resamples: 2000}).p, 1);
});

test('realityCheck is deterministic and records its defaults', () => {
  const returns = messyReturns(21, 30, 12), eligible = returns.map((_, c) => c);
  const first = realityCheck({returns, eligible}), again = realityCheck({returns, eligible});
  assert.deepEqual(first, again);
  assert.deepEqual(Object.keys(first), ['observedMax', 'argmax', 'p', 'resamples', 'seed']);
  assert.equal(first.resamples, 10000); assert.equal(first.seed, 20261118);
  assert.deepEqual(realityCheck({returns, eligible, resamples: 10000, seed: 20261118}), first);
  // The inputs are not modified, and plain arrays give the same answer as typed arrays.
  assert.deepEqual(returns, messyReturns(21, 30, 12));
  assert.deepEqual(realityCheck({returns: returns.map(row => Array.from(row)), eligible}), first);
  // Another seed draws other windows: the observed side is unchanged, the p-value moves a little.
  const other = realityCheck({returns, eligible, seed: 5});
  assert.equal(other.observedMax, first.observedMax); assert.equal(other.argmax, first.argmax);
  assert.notEqual(other.p, first.p); near(other.p, first.p, 0.03);
});

test('realityCheck: one draw shared by every setting, and only eligible settings count', () => {
  const normal = gaussian(mulberry32(8));
  const returns = Array.from({length: 40}, () => Float64Array.from({length: 20}, normal));
  const all = returns.map((_, c) => c), options = {resamples: 4000, seed: 9};
  const pooled = realityCheck({returns, eligible: all, ...options});
  const family = all.filter(c => c % 4 === pooled.argmax % 4);   // the "family" holding the pooled best setting
  const alone = realityCheck({returns, eligible: family, ...options});
  // The same windows are resampled in both calls, so each pooled resample maximum is at least the family's: with
  // the same observed maximum the pooled p-value cannot be smaller (guaranteed only because the draws are shared).
  assert.equal(alone.observedMax, pooled.observedMax); assert.equal(alone.argmax, pooled.argmax);
  assert.ok(pooled.p >= alone.p, `${pooled.p} < ${alone.p}`);
  assert.ok(pooled.p > alone.p, 'searching four times as many settings should cost something here');
  assert.equal(alone.p, slowRealityCheck({returns, eligible: family, ...options}).p);
  // A setting that is not eligible cannot be selected or move the p-value, however good it looks.
  const others = all.filter(c => c !== pooled.argmax);
  const withStar = returns.map((row, c) => c === pooled.argmax ? row.map(v => v + 100) : row);
  assert.deepEqual(realityCheck({returns: withStar, eligible: others, ...options}), realityCheck({returns, eligible: others, ...options}));
  // Listing a setting twice, or adding an exact copy of a setting, changes nothing but the tie order.
  assert.deepEqual(realityCheck({returns, eligible: [...all, ...all], ...options}), pooled);
  // Rescaling one setting's returns (here by 4, exact in binary) changes neither its T nor any resample statistic.
  const rescaled = returns.map((row, c) => c % 3 ? row : row.map(v => 4 * v));
  assert.deepEqual(realityCheck({returns: rescaled, eligible: all, ...options}), pooled);
  // Ties go to the earliest entry of `eligible`.
  const twins = [returns[3], returns[5], returns[3]];
  assert.equal(realityCheck({returns: twins, eligible: [2, 0], resamples: 10}).argmax, 2);
  assert.equal(realityCheck({returns: twins, eligible: [0, 2], resamples: 10}).argmax, 0);
});

test('realityCheck conventions for settings and resamples that cannot be evaluated', () => {
  const none = realityCheck({returns: [Float64Array.of(1, 2, 3)], eligible: [], resamples: 50});
  assert.deepEqual(none, {observedMax: -Infinity, argmax: -1, p: 1, resamples: 50, seed: 20261118});
  assert.deepEqual(realityCheck({returns: [], eligible: [], resamples: 50}), none);
  // Only settings with sd 0 (identical values, one valid window, none): T is 0 and nothing can be resampled, so p is 1.
  const flat = [Float64Array.of(2, 2, 2, 2), Float64Array.of(NaN, 7, NaN, NaN), new Float64Array(4).fill(NaN)];
  assert.deepEqual(realityCheck({returns: flat, eligible: [0, 1, 2], resamples: 50}), {observedMax: 0, argmax: 0, p: 1, resamples: 50, seed: 20261118});
  // A flat setting's T of 0 is the observed maximum when every other setting is below zero; the resamples then
  // contain only the other setting, which reaches 0 about half the time.
  const mixed = [Float64Array.of(-3, -1, -2, -6, -4), Float64Array.of(0, 0, 0, 0, 0)];
  const result = realityCheck({returns: mixed, eligible: [0, 1], resamples: 4000});
  assert.equal(result.observedMax, 0); assert.equal(result.argmax, 1);
  assert.ok(result.p > 0.35 && result.p < 0.65, `p ${result.p}`);
  // Two valid windows (1 and 3) among five: T = 2, which needs mean* >= 4 and so is never reached. A resample
  // draws fewer than two valid windows with probability 0.6^5 + 5 (0.4) 0.6^4 = 0.337 and then cannot be
  // evaluated; those count as reaching the observed maximum, so p is overstated (0.337) rather than understated (0).
  const sparse = {returns: [Float64Array.of(NaN, 1, NaN, 3, NaN)], eligible: [0], resamples: 4000, seed: 2};
  assert.deepEqual(realityCheck(sparse), slowRealityCheck(sparse));
  near(realityCheck(sparse).p, 0.6 ** 5 + 5 * 0.4 * 0.6 ** 4, 0.04);   // five standard errors
  // Invalid input is refused, never guessed at. Infinity is not a marker for anything.
  const good = [Float64Array.of(1, 2, 3), Float64Array.of(2, 1, 5)];
  assert.throws(() => realityCheck({returns: [good[0], Float64Array.of(1, 2)], eligible: [0]}), RangeError);
  assert.throws(() => realityCheck({returns: [Float64Array.of(1, Infinity, 3)], eligible: [0]}), TypeError);
  // A returns table that went through JSON has null where it had NaN: refused, not read as a return of 0.
  assert.throws(() => realityCheck({returns: JSON.parse(JSON.stringify([[1, NaN, 3]])), eligible: [0]}), /Setting 0, window 1/);
  assert.throws(() => realityCheck({returns: [[1, '2', 3]], eligible: [0]}), TypeError);
  for (const eligible of [[2], [-1], [0.5], ['0'], [NaN]]) assert.throws(() => realityCheck({returns: good, eligible}), RangeError);
  for (const resamples of [0, -5, 2.5, Infinity, '100']) assert.throws(() => realityCheck({returns: good, eligible: [0], resamples}), RangeError);
  for (const seed of [-1, 1.5, 2 ** 32, NaN, '7']) assert.throws(() => realityCheck({returns: good, eligible: [0], seed}), RangeError);
  assert.throws(() => realityCheck({returns: good}), TypeError);
  assert.throws(() => realityCheck({returns: Float64Array.of(1, 2, 3), eligible: [0]}), TypeError);
});

// Simulated null returns: `settings` settings x 50 windows, every true mean zero, in groups of `groupSize`.
// Standard deviations cycle through 0.5, 1, 2, 4 and 8. In every second group the settings are strongly correlated
// (pairwise 0.9, through a shared group factor); in the other groups they are independent.
function nullReturns(normal, settings, groupSize, windows = 50) {
  const returns = [];
  let factor;
  for (let c = 0; c < settings; c++) {
    if (c % groupSize === 0) factor = Float64Array.from({length: windows}, normal);
    const shared = Math.floor(c / groupSize) % 2 ? Math.sqrt(0.9) : 0, own = Math.sqrt(1 - shared * shared);
    const sigma = 0.5 * 2 ** (c % 5);
    returns.push(Float64Array.from({length: windows}, (_, w) => sigma * (shared * factor[w] + own * normal())));
  }
  return returns;
}

// Over `datasets` simulated datasets: the share with a reality-check p below 0.05, and how often `target` was the argmax.
function simulate(datasets, make, target = -1, resamples = 500) {
  let below = 0, found = 0;
  for (let d = 0; d < datasets; d++) {
    const returns = make(gaussian(mulberry32(1000 + d)));
    const result = realityCheck({returns, eligible: returns.map((_, c) => c), resamples, seed: 5000 + d});
    if (result.p < 0.05) below++;
    if (result.argmax === target) found++;
  }
  return {share: below / datasets, found: found / datasets};
}

test('calibration: with a handful of null settings the share of p < 0.05 is close to 0.05', () => {
  // Six settings (three independent, three strongly correlated), 1,000 datasets. With few settings the protocol's
  // statistic is close to calibrated: 0.0645 (standard error 0.0025) over 10,000 datasets of this design. The
  // range below is about +-3 standard errors of a 1,000-dataset share around that, inside [0.01, 0.10].
  const {share} = simulate(1000, normal => nullReturns(normal, 6, 3));
  assert.ok(share >= 0.04 && share <= 0.09, `share of p < 0.05 under the null: ${share}`);
});

// Calibration test (a): 500 null settings x 50 windows, 200 datasets, 500 resamples each. Run once, used twice.
// The larger samples quoted in the comments below come from this same function with more datasets, for example
// simulate(2000, normal => nullReturns(normal, 500, 25)) (about 45 s).
let null500;
const nullShare500 = () => null500 ??= simulate(200, normal => nullReturns(normal, 500, 25)).share;

test('calibration (a): 500 null settings; the protocol\'s statistic rejects more often than its nominal 0.05', () => {
  // The implementation is the protocol's paragraph to the letter (see the transcription test above). The
  // statistic itself over-rejects when hundreds of settings are searched over only 50 windows: the observed T
  // has the heavy tails of a t distribution (each setting's sd is estimated from its 50 windows), while the
  // resampled statistic reuses that same sd and has lighter, near-normal tails. Measured over 2,000 datasets of
  // this design the share of p < 0.05 is 0.132 (standard error 0.008), not 0.05; with 12,720 settings of the
  // same structure it is 0.31 (150 datasets). The range below is about +-3 standard errors of a 200-dataset
  // share around 0.132: it pins the behaviour, so a change of statistic in either direction fails here.
  const share = nullShare500();
  assert.ok(share >= 0.06 && share <= 0.22, `share of p < 0.05 under the null: ${share}`);
});

test('calibration (a) as specified: the share of p < 0.05 under the null lies in [0.01, 0.10]',
  {todo: 'Not met by the protocol\'s statistic as written: the true share for this null is about 0.13 (see the test above)'}, () => {
    const share = nullShare500();
    assert.ok(share >= 0.01 && share <= 0.10, `share of p < 0.05 under the null: ${share}`);
  });

test('calibration (b): one setting with a strong true mean is found in most datasets', () => {
  // The same 500 settings; setting 7 gets a true mean of one standard deviation per window (T near 7).
  const strong = normal => {
    const returns = nullReturns(normal, 500, 25);
    returns[7] = returns[7].map(v => v + 0.5 * 2 ** (7 % 5));
    return returns;
  };
  const {share, found} = simulate(60, strong, 7);
  assert.ok(share >= 0.9, `share of p < 0.05 with a real effect: ${share}`);
  assert.ok(found >= 0.9, `share of datasets whose argmax is the real effect: ${found}`);
});

test('realityCheck handles the full search width fast enough', () => {
  // 12,720 settings x 50 windows with a tenth of the protocol's resamples. Cost is linear in resamples, so the
  // limit of 6 s here means under a minute for all 10,000 (measured: about 9 s).
  const normal = gaussian(mulberry32(3));
  const returns = Array.from({length: 12720}, (_, c) => {
    const row = Float64Array.from({length: 50}, normal);
    if (c % 3 === 0) row[c % 7] = NaN;
    return row;
  });
  const started = performance.now();
  const result = realityCheck({returns, eligible: returns.map((_, c) => c), resamples: 1000});
  const elapsed = performance.now() - started;
  assert.ok(result.observedMax > 2.5 && result.observedMax < 7 && result.p > 0 && result.p <= 1, JSON.stringify(result));
  assert.ok(elapsed < 6000, `${elapsed.toFixed(0)} ms for 1,000 resamples`);
});
