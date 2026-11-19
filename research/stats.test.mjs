// Tests for research/stats.mjs and research/calibration.mjs. The answer sheets are independent of the code under
// test: closed forms and textbook t tables, an exact finite series for the t distribution (NBS Handbook of
// Mathematical Functions, 26.7.3 and 26.7.4), hand-solved examples, a slow literal transcription of the
// protocol's two paragraphs, the same paragraphs in exact integer arithmetic, enumeration of every possible
// resample, and calibration by simulation. Every random number comes from a seeded generator, so each run of
// this file is identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mean, sampleSd, tStat, lag1Autocorrelation, autocorrelationFactor, score, skewness, studentTCdf,
  tTestGreaterP, ols, mulberry32, searchAdjustedP, confirmationP, signTestPValue} from './stats.mjs';
import * as statistics from './stats.mjs';
import {SEED, SEARCH, CONFIRMATION, ROWS, STRONG_SETTING, LIMITS, gaussian, shapeOf, skewnessOf, driverCoefficient,
  simulatedReturns, simulatedStudy, streamSeed, makeStudy, makeNominee, retiredRealityCheck, retiredConfirmationP,
  runTask, share, calibrate, formatCalibration} from './calibration.mjs';
import {signTestPValue as appSignTest} from '../report-card.js';

const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} (tolerance ${tolerance})`);
const isValid = v => !Number.isNaN(v);
// A plain integral by the composite three-point (parabolic) rule.
function integrate(f, from, to, steps = 20000) {
  const h = (to - from) / steps;
  let sum = f(from) + f(to);
  for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * f(from + i * h);
  return sum * h / 3;
}

test('the module exports the amended statistics and no longer the retired reality check', () => {
  assert.deepEqual(Object.keys(statistics).sort(), ['autocorrelationFactor', 'confirmationP', 'lag1Autocorrelation', 'mean',
    'mulberry32', 'ols', 'sampleSd', 'score', 'searchAdjustedP', 'signTestPValue', 'skewness', 'studentTCdf', 'tStat', 'tTestGreaterP']);
});

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
  // Values meant to be equal that differ in the last bits are also "sd is 0": 0.1 + 0.2 is not 0.3 in binary, and
  // without this rule the two would give T = 7.6e15. A spread just above rounding size is computed as written.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(sampleSd([0.3, 0.1 + 0.2]), 0); assert.equal(tStat([0.3, 0.1 + 0.2]), 0); near(mean([0.3, 0.1 + 0.2]), 0.3, 1e-16);
  assert.equal(tStat([1e-200, 2e-200]), 0);   // the squares underflow: sd is 0, not a division by zero
  assert.equal(tStat([1, 1 + 1e-13]), 0);
  // 1 and 1 + 2^-30: mean 1 + 2^-31, sd 2^-30 / sqrt(2), so T = (1 + 2^-31) 2^31 = 2^31 + 1.
  near(tStat([1, 1 + 2 ** -30]), 2 ** 31 + 1, 1e-3);
  near(sampleSd([-1e-6, 1e-6]), 1e-6 * Math.SQRT2, 1e-21);
});

test('NaN marks an invalid window and is ignored; any other malformed input is a TypeError', () => {
  // Amended contract: n counts the valid entries. (The first version threw on NaN; this test replaces that one.)
  assert.equal(mean([1, NaN, 3]), 2); near(sampleSd([NaN, 10, NaN, 14]), 4 / Math.SQRT2, 1e-15);
  assert.equal(tStat([NaN, 1, 2, NaN, 3]), tStat([1, 2, 3]));
  assert.equal(tStat(Float64Array.of(NaN, NaN)), 0); assert.ok(Number.isNaN(mean([NaN])));
  assert.equal(tTestGreaterP([1, NaN, 2, 3]), tTestGreaterP([1, 2, 3]));
  assert.equal(skewness([0, NaN, 0, 0, 4]), skewness([0, 0, 0, 4]));
  const functions = [mean, sampleSd, tStat, tTestGreaterP, lag1Autocorrelation, autocorrelationFactor, score, skewness, confirmationP];
  // Only NaN is a marker. Infinity, a hole, null (what JSON makes of NaN) or a string is an error.
  for (const bad of [Infinity, -Infinity, undefined, null, '1', 1n, [1]])
    for (const f of functions) assert.throws(() => f([1, bad, 3]), TypeError, `${f.name} with ${String(bad)}`);
  // A wrong shape is refused, never read as "no data".
  for (const bad of [5, {}, {length: 3}, null, undefined, 'abc', new DataView(new ArrayBuffer(16)), new Set([1, 2])])
    for (const f of functions) assert.throws(() => f(bad), TypeError, `${f.name} with ${Object.prototype.toString.call(bad)}`);
  assert.throws(() => mean([1, null, 3]), /window 1: null is not a finite number/);
  assert.throws(() => tStat(5), /expected an array or typed array/);
  for (const f of functions) assert.throws(() => f(BigInt64Array.of(1n, 2n)), TypeError);
  // Every numeric typed array is a series.
  assert.equal(mean(Int8Array.of(1, 2, 3)), 2); assert.equal(mean(Float32Array.of(1.5, 2.5)), 2);
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
  // plain integrals: no gamma function involved.
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
  // It is the upper tail of studentTCdf at tStat with n - 1 degrees of freedom: no autocorrelation factor.
  const xs = [0.3, -1.2, 2.5, 0.8, -0.1, 1.9, 0.4];
  near(tTestGreaterP(xs), 1 - studentTCdf(tStat(xs), xs.length - 1), 1e-15);
  const runs = [1, 1.2, 1.1, 3, 3.2, 3.1];
  assert.ok(autocorrelationFactor(runs) < 1);
  near(tTestGreaterP(runs), 1 - studentTCdf(tStat(runs), 5), 1e-15);
  // Conventions: nothing can be shown with fewer than two values, and a sample without spread is never evidence.
  // (The first version returned p = 0 for identical positive values; the amended convention is p = 1.)
  assert.equal(tTestGreaterP([]), 1); assert.equal(tTestGreaterP([5]), 1);
  assert.equal(tTestGreaterP([2, 2, 2]), 1); assert.equal(tTestGreaterP([0.4, 0.4, 0.4]), 1);
  assert.equal(tTestGreaterP([0.3, 0.1 + 0.2]), 1); assert.equal(tTestGreaterP([1e-200, 2e-200]), 1);
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
  // A window invalid in either series drops the pair (amended convention; the first version threw on NaN).
  assert.deepEqual(ols([2, NaN, 4, 5, 9, 4, 5], [1, 7, 2, 3, NaN, 4, 5]), fit);
  // Undefined quantities are NaN, not a guess.
  const constantX = ols([1, 2, 3], [4, 4, 4]);
  assert.equal(constantX.n, 3);
  for (const key of Object.keys(constantX)) if (key !== 'n') assert.ok(Number.isNaN(constantX[key]), key);
  assert.ok(Number.isNaN(ols([1], [1]).slope)); assert.equal(ols([], []).n, 0); assert.equal(ols([NaN, 1], [1, NaN]).n, 0);
  const twoPoints = ols([1, 3], [0, 1]);
  assert.equal(twoPoints.slope, 2); assert.equal(twoPoints.intercept, 1); assert.equal(twoPoints.r2, 1);
  assert.ok(Number.isNaN(twoPoints.seSlope) && Number.isNaN(twoPoints.tIntercept) && Number.isNaN(twoPoints.pInterceptGreater));
  // A fit without residual has standard errors 0 and, like every sample without spread here, T 0 and p 1
  // whatever the sign of the intercept. (The first version gave p = 0 for a positive intercept.)
  const perfect = ols([3, 5, 7, 9], [0, 1, 2, 3]);
  assert.deepEqual([perfect.intercept, perfect.slope, perfect.seIntercept, perfect.tIntercept, perfect.pInterceptGreater, perfect.r2], [3, 2, 0, 0, 1, 1]);
  assert.equal(ols([-3, -5, -7, -9], [0, 1, 2, 3]).pInterceptGreater, 1);
  // The same when the fit is exact only up to rounding: 0.1 + 0.2 x leaves residuals near 1e-17, not 0.
  const rounding = ols([1, 2, 3, 4, 5, 6, 7].map(v => 0.1 + 0.2 * v), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([rounding.seIntercept, rounding.seSlope, rounding.tIntercept, rounding.pInterceptGreater, rounding.r2], [0, 0, 0, 1, 1]);
  near(rounding.intercept, 0.1, 1e-15); near(rounding.slope, 0.2, 1e-15);
  // A constant y has no r2.
  const flat = ols([2, 2, 2, 2], [0, 1, 2, 3]);
  assert.deepEqual([flat.intercept, flat.slope], [2, 0]); assert.ok(Number.isNaN(flat.r2));
  assert.throws(() => ols([1, 2], [1, 2, 3]), RangeError);
  assert.throws(() => ols([1, Infinity, 3], [1, 2, 3]), TypeError);
  assert.throws(() => ols([1, 2, 3], [1, null, 3]), TypeError);
  assert.throws(() => ols([1, 2, 3], 3), TypeError); assert.throws(() => ols({}, [1, 2, 3]), TypeError);
});

test('signTestPValue is the app\'s own function', () => {
  assert.equal(signTestPValue, appSignTest);
  near(signTestPValue(10, 0), 2 / 1024, 1e-15);
});

test('lag1Autocorrelation, autocorrelationFactor and score match hand values', () => {
  // 1, 2, 6: mean 3, deviations -2, -1, 3. Adjacent products 2 - 3 = -1, squares 14: a = -1/14, floored to 0.
  near(lag1Autocorrelation([1, 2, 6]), -1 / 14, 1e-16);
  assert.equal(autocorrelationFactor([1, 2, 6]), 1); assert.equal(score([1, 2, 6]), tStat([1, 2, 6]));
  // 1, 2, 3, 4: mean 2.5, deviations -1.5, -0.5, 0.5, 1.5. Products 0.75 - 0.25 + 0.75 = 1.25, squares 5: a = 1/4.
  // Factor sqrt(0.75 / 1.25) = sqrt(0.6). t = 2.5 / (sqrt(5/3) / 2) = sqrt(15), so T = sqrt(15) sqrt(0.6) = 3.
  assert.equal(lag1Autocorrelation([1, 2, 3, 4]), 0.25);
  near(autocorrelationFactor([1, 2, 3, 4]), Math.sqrt(0.6), 1e-16);
  near(tStat([1, 2, 3, 4]), Math.sqrt(15), 1e-15); near(score([1, 2, 3, 4]), 3, 1e-15);
  // An invalid window breaks adjacency: in 1, 2, NaN, 3, 4 the pairs are (1, 2) and (3, 4) only, so the products
  // are 0.75 + 0.75 = 1.5 over the same squares: a = 0.3, not 0.25. Invalid windows at the ends change nothing.
  near(lag1Autocorrelation([1, 2, NaN, 3, 4]), 0.3, 1e-16);
  near(score([1, 2, NaN, 3, 4]), Math.sqrt(15) * Math.sqrt(0.7 / 1.3), 1e-15);
  assert.equal(lag1Autocorrelation([NaN, 1, 2, 3, 4, NaN]), 0.25);
  assert.equal(lag1Autocorrelation([1, NaN, 2, NaN, 3, NaN, 4]), 0);   // no adjacent valid pair at all
  // A step 0, 0, 1, 1 (good and bad windows in runs): deviations -.5, -.5, .5, .5, products .25 - .25 + .25, squares 1.
  // t = 0.5 / (sqrt(1/3) / 2) = sqrt(3), T = sqrt(3) sqrt(0.6) = sqrt(1.8).
  assert.equal(lag1Autocorrelation([0, 0, 1, 1]), 0.25); near(score([0, 0, 1, 1]), Math.sqrt(1.8), 1e-15);
  // A longer step, five 0 then five 1: a = (2k - 3) / (2k) = 0.7 with k = 5, factor sqrt(0.3 / 1.7).
  const step = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
  near(lag1Autocorrelation(step), 0.7, 1e-15); near(autocorrelationFactor(step), Math.sqrt(0.3 / 1.7), 1e-15);
  near(score(step), tStat(step) * Math.sqrt(0.3 / 1.7), 1e-15);
  // Alternating values: a = -3/4, floored at 0, so the score is the plain t statistic (0 here: mean 0).
  assert.equal(lag1Autocorrelation([1, -1, 1, -1]), -0.75); assert.equal(autocorrelationFactor([1, -1, 1, -1]), 1);
  assert.equal(score([1, -1, 1, -1]), 0);
  // The factor shrinks a negative score toward 0 as well: it multiplies, as the protocol writes it.
  near(score([-1, -2, -3, -4]), -3, 1e-15);
  // score is exactly tStat x autocorrelationFactor. Rescaling changes neither (by 4: exact in binary), and a
  // common shift does not change the autocorrelation.
  for (const xs of [[0.3, -1.2, 2.5, 0.8, -0.1, 1.9, 0.4], [5, 4, NaN, 4.5, 6, 7, NaN, 6.5], step]) {
    assert.equal(score(xs), tStat(xs) * autocorrelationFactor(xs));
    const a = Math.max(0, lag1Autocorrelation(xs));
    assert.equal(autocorrelationFactor(xs), Math.sqrt((1 - a) / (1 + a)));
    assert.equal(score(xs.map(v => 4 * v)), score(xs));
    near(lag1Autocorrelation(xs.map(v => v + 8)), lag1Autocorrelation(xs), 1e-14);
  }
  // The autocorrelation stays below 1, so the factor stays above 0, even for one long run.
  const longRun = Array.from({length: 74}, (_, w) => (w < 37 ? 0 : 1));
  near(lag1Autocorrelation(longRun), 71 / 74, 1e-15); assert.ok(autocorrelationFactor(longRun) > 0.14);
  // Without spread, or with fewer than two valid windows: a = 0, factor 1, score 0.
  for (const xs of [[], [5], [NaN, 5, NaN], [2, 2, 2], [0.3, 0.1 + 0.2, 0.3], [NaN, NaN]])
    assert.deepEqual([lag1Autocorrelation(xs), autocorrelationFactor(xs), score(xs)], [0, 1, 0]);
});

test('skewness matches hand values', () => {
  // 0, 0, 0, 4: mean 1, deviations -1, -1, -1, 3. m2 = 12/4 = 3, m3 = 24/4 = 6: g1 = 6 / 3^1.5 = 2/sqrt(3).
  near(skewness([0, 0, 0, 4]), 2 / Math.sqrt(3), 1e-15);
  near(skewness([0, 0, 0, -4]), -2 / Math.sqrt(3), 1e-15);
  // 1, 2, 3, 4, 10: mean 4, deviations -3, -2, -1, 0, 6. m2 = 50/5 = 10, m3 = 180/5 = 36: g1 = 3.6 / sqrt(10).
  near(skewness([1, 2, 3, 4, 10]), 3.6 / Math.sqrt(10), 1e-15);
  // k of n values at the upper of two levels: g1 = (1 - 2p) / sqrt(p (1 - p)) with p = k / n.
  for (const [n, k] of [[10, 1], [10, 3], [24, 2], [24, 23]]) {
    const p = k / n, xs = Array.from({length: n}, (_, i) => (i < k ? 7.5 : -2));
    near(skewness(xs), (1 - 2 * p) / Math.sqrt(p * (1 - p)), 1e-13, `${k} of ${n}`);
  }
  // Symmetric samples have none; two values always have none; scale and shift do not matter; NaN is ignored.
  assert.equal(skewness([1, 2, 3]), 0); assert.equal(skewness([-5, 0, 5, 10, 15]), 0); assert.equal(skewness([3, 9]), 0);
  near(skewness([0, 0, 0, 4].map(v => 100 - 2.5 * v)), -2 / Math.sqrt(3), 1e-13);
  assert.equal(skewness([NaN, 0, 0, NaN, 0, 4]), skewness([0, 0, 0, 4]));
  // Undefined (no spread, or fewer than two valid entries) is reported as 0.
  for (const xs of [[], [5], [2, 2, 2], [0.3, 0.1 + 0.2], [NaN]]) assert.equal(skewness(xs), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The protocol's two paragraphs, transcribed as literally and slowly as possible with their own arithmetic.

const TIE = 1e-12, NO_SPREAD = 1e-12;   // the two conventions research/stats.mjs states for floating point
const slow = {
  mean: v => v.reduce((sum, x) => sum + x, 0) / v.length,
  sd(v) { const m = slow.mean(v); return Math.sqrt(v.reduce((sum, x) => sum + (x - m) ** 2, 0) / (v.length - 1)); },
  // "sd is 0": fewer than two values, or no spread beyond rounding.
  flat(v) {
    const low = v.reduce((a, b) => Math.min(a, b), Infinity), high = v.reduce((a, b) => Math.max(a, b), -Infinity);
    return v.length < 2 || high - low <= NO_SPREAD * Math.max(Math.abs(low), Math.abs(high));
  },
  // T(c) = mean / (sd / sqrt(n)) x sqrt((1 - a) / (1 + a)), a = lag-1 autocorrelation over adjacent valid windows.
  score(row) {
    const v = Array.from(row).filter(isValid);
    if (slow.flat(v)) return 0;
    const m = slow.mean(v);
    let products = 0, squares = 0;
    for (let w = 0; w < row.length; w++) {
      if (isValid(row[w])) squares += (row[w] - m) ** 2;
      if (w > 0 && isValid(row[w - 1]) && isValid(row[w])) products += (row[w - 1] - m) * (row[w] - m);
    }
    const a = Math.max(0, products / squares);
    return m / (slow.sd(v) / Math.sqrt(v.length)) * Math.sqrt((1 - a) / (1 + a));
  },
  reaches: (statistic, observed) => statistic >= observed - TIE * Math.max(1, Math.abs(observed)),
};

// "Search-adjusted p-value": draw the windows of each resample one by one, the same draw for every setting; for
// every eligible setting take mean*, sd* and m* over the drawn windows valid for it; take the maximum.
function slowSearchAdjustedP({returns, eligible, resamples, seed}) {
  const windows = returns[0].length, random = mulberry32(seed);
  const settings = Array.from(eligible, c => ({c, row: returns[c], valid: Array.from(returns[c]).filter(isValid)})).filter(s => s.valid.length);
  let observedMax = -Infinity, argmax = -1;
  for (const s of settings) {
    s.mean = slow.mean(s.valid);
    const T = slow.score(s.row);
    if (T > observedMax) { observedMax = T; argmax = s.c; }
  }
  let reached = 0;
  for (let b = 0; b < resamples; b++) {
    const drawn = Array.from({length: windows}, () => Math.floor(random() * windows));
    let max = -Infinity;
    for (const s of settings) {
      const star = drawn.map(w => s.row[w]).filter(isValid);
      if (slow.flat(star)) continue;   // fewer than two such windows, or sd* of 0
      max = Math.max(max, (slow.mean(star) - s.mean) / (slow.sd(star) / Math.sqrt(star.length)));
    }
    if (max === -Infinity || slow.reaches(max, observedMax)) reached++;   // nothing evaluated counts as reached
  }
  return {observedMax, argmax, p: settings.length ? reached / resamples : 1, resamples, seed};
}

// "Confirmation": the resample half of the confirmation p-value.
function slowConfirmationResampleP(xs, resamples, seed) {
  const v = Array.from(xs).filter(isValid), n = v.length, random = mulberry32(seed);
  if (slow.flat(v)) return 1;
  const m = slow.mean(v), T = slow.score(xs);
  let reached = 0;
  for (let b = 0; b < resamples; b++) {
    const star = Array.from({length: n}, () => v[Math.floor(random() * n)]);
    if (slow.flat(star) || slow.reaches((slow.mean(star) - m) / (slow.sd(star) / Math.sqrt(n)), T)) reached++;
  }
  return reached / resamples;
}

// Random returns with every kind of row the protocol can produce: complete rows, rows with invalid windows (some
// sharing a pattern), a window invalid for every setting, rows with ties and with exact zeros (windows without a
// trade), an exact copy, a row with one valid window, an all-invalid row, a row of identical values and a row of
// values equal up to rounding.
function messyReturns(seed, settings = 16, windows = 9) {
  const random = mulberry32(seed), normal = gaussian(random);
  const returns = Array.from({length: settings}, (_, c) =>
    Float64Array.from({length: windows}, () => (c % 3 - 1) * 0.4 + (1 + c % 4) * normal()));
  for (let c = 0; c < settings; c++) {
    if (c % 4 === 2) returns[c] = returns[c].map(v => Math.round(v) / 10);      // decimal values, many ties
    if (c % 7 === 3) returns[c] = returns[c].map(v => (random() < 0.5 ? 0 : v));   // half the windows idle
    returns[c][4] = NaN;                                                         // invalid for every setting
    if (c % 3 === 0) returns[c][0] = NaN;                                        // a shared pattern
    if (c % 5 === 1) returns[c][Math.floor(random() * windows)] = NaN;
  }
  returns[settings - 5] = returns[1].slice();                                    // an exact copy
  returns[settings - 4].fill(NaN); returns[settings - 4][2] = 1.5;               // one valid window
  returns[settings - 3].fill(NaN);                                               // none
  returns[settings - 2].fill(0.25); returns[settings - 2][4] = NaN;              // identical values: sd 0
  returns[settings - 1] = returns[settings - 1].map((_, w) => (w % 2 ? 0.3 : 0.1 + 0.2));   // equal up to rounding
  return returns;
}

test('searchAdjustedP equals the slow literal transcription, with invalid windows, ties and degenerate rows', () => {
  let below = 0, calls = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const returns = messyReturns(seed), all = returns.map((_, c) => c);
    for (const eligible of [all, all.filter(c => c % 2), all.slice(3, 9), all.slice().reverse(), [returns.length - 6, returns.length - 2],
      all.slice(-4), Int32Array.from(all.slice(0, 5))]) {
      const options = {returns, eligible, resamples: 1500, seed: 77 + seed};
      const fast = searchAdjustedP(options);
      assert.deepEqual(fast, slowSearchAdjustedP(options));
      // The observed maximum is score() of the argmax setting, to the last bit.
      if (fast.argmax >= 0) assert.equal(fast.observedMax, score(returns[fast.argmax]));
      assert.ok(fast.p >= 0 && fast.p <= 1 && (fast.argmax === -1 || Array.from(eligible).includes(fast.argmax)));
      calls++; if (fast.p < 0.5) below++;
    }
  }
  assert.ok(below > calls / 5 && below < calls, `p-values on both sides of 0.5 are exercised: ${below} of ${calls}`);
  // The size the study runs at: 50 windows, here 150 near-identical or skewed settings of two simulated studies,
  // a third of them with an invalid first window (as the warmup rule produces) and a few with scattered gaps.
  for (const [row, index] of [[0, 0], [7, 1]]) {
    const returns = makeStudy(row, index).slice(0, 150).map(series => Float64Array.from(series));
    returns.forEach((series, c) => { if (c % 3 === 0) series[0] = NaN; if (c % 41 === 0) series[c % 50] = NaN; });
    const options = {returns, eligible: returns.map((_, c) => c), resamples: 250, seed: 20261118};
    assert.deepEqual(searchAdjustedP(options), slowSearchAdjustedP(options));
  }
  // More than 255 and more than 65,535 windows (wider counters), with a pattern unique to each setting.
  for (const [windows, resamples] of [[255, 60], [256, 60], [300, 200], [65537, 2]]) {
    const wide = Array.from({length: 4}, (_, c) => Float64Array.from({length: windows}, gaussian(mulberry32(90 + c))));
    wide.forEach((row, c) => { row[c] = NaN; });
    const options = {returns: wide, eligible: [0, 1, 2, 3], resamples, seed: 3};
    assert.deepEqual(searchAdjustedP(options), slowSearchAdjustedP(options));
  }
});

test('confirmationP equals the slow literal transcription on the same kinds of series', () => {
  const larger = {pT: 0, pResample: 0};
  for (const seed of [11, 12, 13, 14]) {
    for (const row of [...messyReturns(seed), ...messyReturns(seed, 12, 24)]) {
      const options = {resamples: 800, seed: 500 + seed}, result = confirmationP(row, options);
      const v = Array.from(row).filter(isValid), n = v.length, flat = slow.flat(v);
      assert.deepEqual(Object.keys(result), ['n', 'mean', 'sd', 't', 'lag1', 'factor', 'score', 'skewness', 'pT', 'pResample', 'p']);
      assert.equal(result.n, n);
      assert.equal(result.score, slow.score(row));
      assert.equal(result.pResample, slowConfirmationResampleP(row, options.resamples, options.seed));
      // Its parts are the exported functions of the same series.
      assert.deepEqual([result.mean, result.sd, result.t, result.lag1, result.factor, result.score, result.skewness],
        [mean(row), sampleSd(row), tStat(row), lag1Autocorrelation(row), autocorrelationFactor(row), score(row), skewness(row)]);
      // pT is the upper tail of Student's t at the SCORE with n - 1 degrees of freedom; p is the larger.
      if (flat) assert.deepEqual([result.score, result.pT, result.pResample, result.p], [0, 1, 1, 1]);
      else {
        near(result.pT, 1 - studentTCdf(result.score, n - 1), 1e-15);
        assert.equal(result.p, Math.max(result.pT, result.pResample));
        larger[result.pT >= result.pResample ? 'pT' : 'pResample']++;
      }
    }
  }
  assert.ok(larger.pT > 10 && larger.pResample > 10, `each p-value is the larger one in some cases: ${JSON.stringify(larger)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// The same two paragraphs in exact integer arithmetic, for tables of whole numbers. Every statistic here is a
// signed square root of a fraction, sign * sqrt(num / den), so "at least" is decided without rounding.

const sign = v => (v > 0n ? 1 : v < 0n ? -1 : 0);
// x >= y for x, y of the form sign * sqrt(num / den) with den > 0.
function atLeast(x, y) {
  if (x.sign >= 0 && y.sign <= 0) return true;
  if (x.sign <= 0 && y.sign >= 0) return false;
  const difference = x.num * y.den - y.num * x.den;   // x^2 - y^2 up to a positive factor
  return x.sign > 0 ? difference >= 0n : difference <= 0n;
}
// The score of a row of whole numbers (NaN = invalid). With S and Q the sum and the sum of squares of the n valid
// values: t^2 = S^2 (n - 1) / (n Q - S^2); a = A / B with A = sum over adjacent valid windows of
// (n x[w] - S)(n x[w+1] - S) and B = n (n Q - S^2); the factor squared is (B - A) / (B + A) when A > 0.
function exactScore(row) {
  const v = Array.from(row).filter(isValid).map(BigInt), n = BigInt(v.length);
  const S = v.reduce((sum, x) => sum + x, 0n), spread = n * v.reduce((sum, x) => sum + x * x, 0n) - S * S;
  if (spread === 0n) return {row, v, n, S, flat: true, sign: 0, num: 0n, den: 1n};   // includes n < 2
  let A = 0n;
  for (let w = 1; w < row.length; w++)
    if (isValid(row[w - 1]) && isValid(row[w])) A += (n * BigInt(row[w - 1]) - S) * (n * BigInt(row[w]) - S);
  const B = n * spread, shrink = A > 0n;
  return {row, v, n, S, flat: false, sign: sign(S), num: S * S * (n - 1n) * (shrink ? B - A : 1n), den: spread * (shrink ? B + A : 1n)};
}
// (mean* - mean) / (sd* / sqrt(m)) for drawn whole numbers `star` against a setting with n valid values summing
// to S: with S* and Q* the drawn sum and sum of squares and D = n S* - m S, it is
// sign(D) sqrt(D^2 (m - 1) / (n^2 (m Q* - S*^2))). null when m < 2 or sd* is 0.
function exactStatistic(star, {n, S}) {
  const m = BigInt(star.length), sum = star.reduce((total, x) => total + x, 0n);
  const spread = m * star.reduce((total, x) => total + x * x, 0n) - sum * sum;
  if (m < 2n || spread === 0n) return null;
  const D = n * sum - m * S;
  return {sign: sign(D), num: D * D * (m - 1n), den: n * n * spread};
}
// The search: the eligible settings with a valid window, the one holding the observed maximum (the earliest on
// a tie), and whether one resample (a list of drawn window indices) reaches it. strict: only ABOVE it, which
// is not the protocol and is used to count the resamples sitting exactly at the maximum.
function exactSearch(returns, eligible) {
  const settings = Array.from(eligible, c => ({c, ...exactScore(returns[c])})).filter(s => s.n > 0n);
  let top = null;
  for (const s of settings) if (!top || !atLeast(top, s)) top = s;
  const reaches = (drawn, strict = false) => {
    const statistics = settings.map(s => exactStatistic(drawn.map(w => s.row[w]).filter(isValid).map(BigInt), s)).filter(Boolean);
    return !statistics.length || statistics.some(s => atLeast(s, top) && !(strict && atLeast(top, s)));
  };
  return {top, reaches};
}
// The confirmation resample: n values drawn from the n valid ones; sd* of 0 counts as reaching the score.
function exactConfirmation(xs) {
  const observed = exactScore(xs);
  const reaches = indices => {
    const statistic = exactStatistic(indices.map(i => observed.v[i]), observed);
    return !statistic || atLeast(statistic, observed);
  };
  return {observed, reaches};
}
// With the draws of research/stats.mjs: floor(u x count) for consecutive u of one mulberry32(seed) stream.
const drawsOf = (random, count) => Array.from({length: count}, () => Math.floor(random() * count));
function exactSearchAdjustedP({returns, eligible, resamples, seed, strict = false}) {
  const {top, reaches} = exactSearch(returns, eligible), random = mulberry32(seed);
  let reached = 0;
  for (let b = 0; b < resamples; b++) if (reaches(drawsOf(random, returns[0].length), strict)) reached++;
  return {top, p: top ? reached / resamples : 1};
}
function exactConfirmationResampleP(xs, resamples, seed) {
  const {observed, reaches} = exactConfirmation(xs), random = mulberry32(seed);
  if (observed.flat) return 1;
  let reached = 0;
  for (let b = 0; b < resamples; b++) if (reaches(drawsOf(random, observed.v.length))) reached++;
  return reached / resamples;
}
// Every possible resample of `count` draws, each equally likely: how many reach, out of count^count.
function enumerate(count, reaches) {
  let reached = 0;
  for (let code = 0; code < count ** count; code++)
    if (reaches(Array.from({length: count}, (_, i) => Math.floor(code / count ** i) % count))) reached++;
  return {reached, of: count ** count, p: reached / count ** count};
}

// Small tables of whole numbers from a narrow range: ties everywhere, in the scores and in the resamples.
function tieProneTable(random, offset = 0) {
  const windows = 3 + Math.floor(random() * 5), settings = 1 + Math.floor(random() * 4), span = 2 + Math.floor(random() * 5);
  const returns = Array.from({length: settings}, () => Array.from({length: windows}, () =>
    (random() < 0.12 ? NaN : offset + Math.floor(random() * span) - (span >> 1))));
  if (random() < 0.2) returns.push(returns[0].slice());                    // an exact copy
  if (random() < 0.2) returns.push(returns[0].map(v => 2 * v));            // the same shape at another scale
  if (random() < 0.15) returns.push(new Array(windows).fill(offset + 1));  // no spread
  return returns;
}

test('ties: both p-values equal exact integer arithmetic, also when the same table is written in decimals', () => {
  const random = mulberry32(4242);
  let tables = 0, ties = 0, differentIfStrict = 0;
  for (let i = 0; i < 260; i++) {
    const offset = i % 13 === 5 ? 97 : 0;   // some tables far from zero relative to their spread
    const whole = tieProneTable(random, offset), eligible = whole.map((_, c) => c), options = {resamples: 250, seed: 1000 + i};
    const exact = exactSearchAdjustedP({returns: whole, eligible, ...options});
    // The same table in whole numbers, in tenths (0.1, 0.2, ... as written), in tenths computed with rounding
    // noise (3 x 0.1 is not 0.3) and in thirds: as written they are one table, so one p-value.
    for (const scale of [v => v, v => v / 10, v => v * 0.1, v => v / 3]) {
      const returns = whole.map(row => row.map(scale)), fast = searchAdjustedP({returns, eligible, ...options});
      assert.equal(fast.p, exact.p, `table ${i}: ${JSON.stringify(whole)}`);
      if (exact.top) {
        assert.ok(atLeast(exactScore(whole[fast.argmax]), exact.top), `table ${i}: the argmax holds the largest score`);
        near(fast.observedMax, exact.top.sign * Math.sqrt(Number(exact.top.num) / Number(exact.top.den)), 1e-9 * (1 + Math.abs(fast.observedMax)));
      } else assert.deepEqual([fast.argmax, fast.observedMax, fast.p], [-1, -Infinity, 1]);
      returns.forEach((row, c) => assert.equal(confirmationP(row, options).pResample,
        exactConfirmationResampleP(whole[c], options.resamples, options.seed), `table ${i}, row ${c}`));
    }
    tables++;
    // How much the ties matter here: the same count with ">" in place of ">=".
    const strict = exactSearchAdjustedP({returns: whole, eligible, ...options, strict: true});
    if (strict.p !== exact.p) { differentIfStrict++; ties += Math.round((exact.p - strict.p) * options.resamples); }
  }
  // The tables do contain exact ties with the observed maximum: with ">" the answer would differ in many of them.
  assert.ok(differentIfStrict > tables / 10, `${differentIfStrict} of ${tables} tables have a resample exactly at the observed maximum (${ties} resamples)`);
});

test('searchAdjustedP on hand-solved cases, against every possible resample', () => {
  // One setting, returns 0 and 2: mean 1, sd sqrt(2), t = 1; a = -1/2 is floored, so T = 1. Of the four equally
  // likely resamples, (0, 0) and (2, 2) have sd* = 0: nothing can be evaluated, which counts as reaching T.
  // (0, 2) and (2, 0) have mean* = mean: statistic 0 < 1. So p = 1/2 exactly. (The retired statistic gave 1/4.)
  const two = searchAdjustedP({returns: [[0, 2]], eligible: [0], resamples: 200000, seed: 11});
  assert.deepEqual([two.observedMax, two.argmax], [1, 0]);
  assert.equal(enumerate(2, exactSearch([[0, 2]], [0]).reaches).p, 0.5);
  near(two.p, 0.5, 5 * Math.sqrt(0.25 / 200000));   // five standard errors
  // Returns 1, 2, 6: T = 3 / (sqrt(7) / sqrt(3)) = 1.964. Of the 27 resamples only the three constant ones count:
  // the best of the others is (6, 6, 2) with mean* 14/3, sd*^2 = 16/3 and statistic (5/3) / (4/3) = 1.25.
  const three = searchAdjustedP({returns: [Float64Array.of(1, 2, 6)], eligible: [0], resamples: 200000, seed: 11});
  near(three.observedMax, 3 / (Math.sqrt(7) / Math.sqrt(3)), 1e-15);
  assert.deepEqual(enumerate(3, exactSearch([[1, 2, 6]], [0]).reaches), {reached: 3, of: 27, p: 1 / 9});
  near(three.p, 1 / 9, 5 * Math.sqrt(1 / 9 * 8 / 9 / 200000));
  // Mirrored, -1, -2, -6: T is negative and nearly every resample reaches it.
  assert.ok(searchAdjustedP({returns: [[-1, -2, -6]], eligible: [0], resamples: 2000}).p > 0.9);

  // An exact tie. Returns 1, 2, 3, 4 have T = 3 (hand-solved above). Of the 256 resamples 18 reach it: the 4
  // constant ones, 10 above it, and the 4 orderings of (3, 3, 3, 4), whose mean* is 3.25 and sd* 0.5, so their
  // statistic is 0.75 / 0.25 = 3 exactly. "At least" counts them. In tenths (0.1, 0.2, 0.3, 0.4) the same tie is
  // 3 against 2.9999999999999996 or the like; the first version decided such ties by rounding (a verifier
  // measured 13/256 against 19/256 for one table written both ways). Both tables now give 18/256.
  const whole = [1, 2, 3, 4], tenths = [0.1, 0.2, 0.3, 0.4], search = exactSearch([whole], [0]);
  const all = enumerate(4, search.reaches), above = enumerate(4, drawn => search.reaches(drawn, true));
  assert.deepEqual([all.reached, above.reached, all.of], [18, 14, 256]);
  const options = {eligible: [0], resamples: 400000};
  const pWhole = searchAdjustedP({returns: [whole], ...options}).p, pTenths = searchAdjustedP({returns: [tenths], ...options}).p;
  assert.equal(pTenths, pWhole);
  near(pWhole, 18 / 256, 5 * Math.sqrt(18 / 256 * 238 / 256 / 400000));
  assert.ok(pWhole - 14 / 256 > 20 * Math.sqrt(14 / 256 * 242 / 256 / 400000), 'far from the answer that loses the ties');

  // Several settings, invalid windows, ONE draw shared by all: the p-value over 300,000 resamples matches the
  // enumeration of all 4^4, 5^5 or 6^6 draws. Drawing separately for each setting would give other numbers.
  const cases = [
    [[1, 2, 6, 3], [4, NaN, 1, 2], [0, 0, 3, NaN]],
    [[3, -1, 2, 2, 0], [-2, 1, 1, NaN, 4], [1, 1, 0, 3, -1], [NaN, 2, 5, 1, 1]],
    [[0, 1, 0, 2, -1, 1], [2, 0, -1, 1, 1, 0], [NaN, NaN, 3, 1, 2, 1]],
    [[5, 1, -2, 0], [5, 1, -2, 0], [-1, 0, 1, 2]],
  ];
  for (const returns of cases) {
    const eligible = returns.map((_, c) => c), exact = enumerate(returns[0].length, exactSearch(returns, eligible).reaches);
    const measured = searchAdjustedP({returns, eligible, resamples: 300000, seed: 5}).p;
    near(measured, exact.p, 5 * Math.sqrt(exact.p * (1 - exact.p) / 300000), JSON.stringify(returns));
    assert.ok(exact.p > 0.02 && exact.p < 0.98, `an informative case: ${exact.reached} of ${exact.of}`);
  }
});

test('searchAdjustedP is deterministic and records its defaults', () => {
  const returns = messyReturns(21, 30, 12), eligible = returns.map((_, c) => c);
  const first = searchAdjustedP({returns, eligible}), again = searchAdjustedP({returns, eligible});
  assert.deepEqual(first, again);
  assert.deepEqual(Object.keys(first), ['observedMax', 'argmax', 'p', 'resamples', 'seed']);
  assert.equal(first.resamples, 10000); assert.equal(first.seed, 20261118);
  assert.deepEqual(searchAdjustedP({returns, eligible, resamples: 10000, seed: 20261118}), first);
  // The inputs are not modified, and plain arrays give the same answer as typed arrays.
  assert.deepEqual(returns, messyReturns(21, 30, 12));
  assert.deepEqual(searchAdjustedP({returns: returns.map(row => Array.from(row)), eligible}), first);
  // Another seed draws other windows: the observed side is unchanged, the p-value moves a little.
  const other = searchAdjustedP({returns, eligible, seed: 5});
  assert.equal(other.observedMax, first.observedMax); assert.equal(other.argmax, first.argmax);
  assert.notEqual(other.p, first.p); near(other.p, first.p, 0.03);
  // Fewer resamples are the first resamples of the same stream.
  assert.equal(searchAdjustedP({returns, eligible, resamples: 700}).p, slowSearchAdjustedP({returns, eligible, resamples: 700, seed: 20261118}).p);
});

test('searchAdjustedP: one draw shared by every setting, and only eligible settings count', () => {
  const normal = gaussian(mulberry32(8));
  const returns = Array.from({length: 40}, () => Float64Array.from({length: 20}, normal));
  const all = returns.map((_, c) => c), options = {resamples: 4000, seed: 9};
  const pooled = searchAdjustedP({returns, eligible: all, ...options});
  const family = all.filter(c => c % 4 === pooled.argmax % 4);   // the "family" holding the pooled best setting
  const alone = searchAdjustedP({returns, eligible: family, ...options});
  // The same windows are resampled in both calls, so each pooled resample maximum is at least the family's: with
  // the same observed maximum the pooled p-value cannot be smaller (guaranteed only because the draws are shared).
  assert.equal(alone.observedMax, pooled.observedMax); assert.equal(alone.argmax, pooled.argmax);
  assert.ok(pooled.p > alone.p, `searching four times as many settings costs something here: ${pooled.p} against ${alone.p}`);
  assert.equal(alone.p, slowSearchAdjustedP({returns, eligible: family, ...options}).p);
  // A setting that is not eligible cannot be selected or move the p-value, however good it looks.
  const others = all.filter(c => c !== pooled.argmax);
  const withStar = returns.map((row, c) => (c === pooled.argmax ? row.map(v => v + 100) : row));
  assert.deepEqual(searchAdjustedP({returns: withStar, eligible: others, ...options}), searchAdjustedP({returns, eligible: others, ...options}));
  // Listing a setting twice changes nothing.
  assert.deepEqual(searchAdjustedP({returns, eligible: [...all, ...all], ...options}), pooled);
  // Rescaling one setting's returns (here by 4, exact in binary) changes neither its T nor any resample statistic.
  const rescaled = returns.map((row, c) => (c % 3 ? row : row.map(v => 4 * v)));
  assert.deepEqual(searchAdjustedP({returns: rescaled, eligible: all, ...options}), pooled);
  // Ties in the observed score go to the earliest entry of `eligible`.
  const twins = [returns[3], returns[5], returns[3]];
  assert.equal(searchAdjustedP({returns: twins, eligible: [2, 0], resamples: 10}).argmax, 2);
  assert.equal(searchAdjustedP({returns: twins, eligible: [0, 2], resamples: 10}).argmax, 0);
  // The observed maximum carries the autocorrelation factor; the resampled statistics do not. A setting whose
  // windows come in runs therefore gets a larger p-value than the same returns in an order without runs, although
  // mean, sd, the plain t and every resampled statistic are the same.
  const mixed = Float64Array.from({length: 20}, normal).map(v => v + 0.8), sorted = mixed.slice().sort();
  const shuffled = sorted.map((_, w) => sorted[w * 7 % 20]);   // one fixed reordering of the same 20 returns
  assert.ok(lag1Autocorrelation(sorted) > 0.5 && lag1Autocorrelation(shuffled) < 0.2);
  near(tStat(sorted), tStat(shuffled), 1e-12);
  const inRuns = searchAdjustedP({returns: [sorted], eligible: [0], ...options}), noRuns = searchAdjustedP({returns: [shuffled], eligible: [0], ...options});
  assert.ok(inRuns.observedMax < 0.6 * noRuns.observedMax && inRuns.p > 5 * noRuns.p, `${JSON.stringify(inRuns)} ${JSON.stringify(noRuns)}`);
});

test('searchAdjustedP conventions for settings and resamples that cannot be evaluated', () => {
  const nothing = {observedMax: -Infinity, argmax: -1, p: 1, resamples: 50, seed: 20261118};
  assert.deepEqual(searchAdjustedP({returns: [Float64Array.of(1, 2, 3)], eligible: [], resamples: 50}), nothing);
  assert.deepEqual(searchAdjustedP({returns: [], eligible: [], resamples: 50}), nothing);
  // A setting with no valid window is never the argmax and adds nothing to the maximum, even when every other
  // score is negative. (The first version returned it as argmax with an observed maximum of 0.)
  const empty = [NaN, NaN, NaN, NaN], losing = [-1, -2, -3, -2.5];
  const withEmpty = searchAdjustedP({returns: [empty, losing], eligible: [0, 1], resamples: 2000});
  assert.deepEqual(withEmpty, searchAdjustedP({returns: [empty, losing], eligible: [1], resamples: 2000}));
  assert.equal(withEmpty.argmax, 1); assert.equal(withEmpty.observedMax, score(losing)); assert.ok(withEmpty.observedMax < 0);
  assert.deepEqual(searchAdjustedP({returns: [empty, empty], eligible: [0, 1], resamples: 50}), nothing);
  // Settings without spread (identical values, values equal up to rounding, one valid window): T is 0 by the
  // protocol's rule, and since they can be evaluated in no resample the p-value is 1, never 0.
  const flat = [Float64Array.of(2, 2, 2, 2), Float64Array.of(NaN, 7, NaN, NaN), Float64Array.of(0.3, 0.1 + 0.2, 0.3, 0.3), new Float64Array(4).fill(NaN)];
  assert.deepEqual(searchAdjustedP({returns: flat, eligible: [0, 1, 2, 3], resamples: 50}), {observedMax: 0, argmax: 0, p: 1, resamples: 50, seed: 20261118});
  assert.equal(searchAdjustedP({returns: flat, eligible: [3, 2, 1], resamples: 50}).argmax, 2);
  // Such a setting's T of 0 is the observed maximum when every other setting is below zero; the resamples then
  // hold only the other setting, whose statistic reaches 0 about half the time.
  const mixed = [Float64Array.of(-3, -1, -2, -6, -4), Float64Array.of(0, 0, 0, 0, 0)];
  const result = searchAdjustedP({returns: mixed, eligible: [0, 1], resamples: 4000});
  assert.equal(result.observedMax, 0); assert.equal(result.argmax, 1);
  const exactMixed = enumerate(5, exactSearch(mixed.map(row => Array.from(row)), [0, 1]).reaches);
  near(result.p, exactMixed.p, 5 * Math.sqrt(exactMixed.p * (1 - exactMixed.p) / 4000));
  assert.ok(exactMixed.p > 0.35 && exactMixed.p < 0.65, `p ${exactMixed.p}`);
  // Two valid windows (1 and 3) among five: T = 2. A resample draws fewer than two valid windows, or the same one
  // twice or more and nothing else, and then cannot be evaluated; those count as reaching the maximum, so p is
  // overstated rather than understated. No resample that can be evaluated reaches 2.
  const sparse = {returns: [Float64Array.of(NaN, 1, NaN, 3, NaN)], eligible: [0], resamples: 4000, seed: 2};
  assert.deepEqual(searchAdjustedP(sparse), slowSearchAdjustedP(sparse));
  const exactSparse = enumerate(5, exactSearch([[NaN, 1, NaN, 3, NaN]], [0]).reaches);
  // Both windows drawn at least once: 1 - 2 (4/5)^5 + (3/5)^5 of the resamples, the only ones evaluated.
  near(exactSparse.p, 2 * 0.8 ** 5 - 0.6 ** 5, 1e-12);
  near(searchAdjustedP(sparse).p, exactSparse.p, 5 * Math.sqrt(exactSparse.p * (1 - exactSparse.p) / 4000));
});

test('searchAdjustedP refuses malformed input instead of reading it as no data', () => {
  const good = [Float64Array.of(1, 2, 3), Float64Array.of(2, 1, 5)];
  // A flat array where an array of rows is expected, as in the earlier finding: one setting's returns unwrapped.
  assert.throws(() => searchAdjustedP({returns: [1.2, 2.4, 1.3, 1.3, 0, 1.0, 1.8, 0.8, 4.6, 1.4], eligible: [0], resamples: 100}), /returns\[0\]: expected an array or typed array/);
  assert.throws(() => searchAdjustedP({returns: Float64Array.of(1, 2, 3), eligible: [0]}), TypeError);
  assert.throws(() => searchAdjustedP({returns: [good[0], null], eligible: [0]}), TypeError);
  assert.throws(() => searchAdjustedP({returns: [good[0], {length: 3}], eligible: [0]}), TypeError);
  assert.throws(() => searchAdjustedP({returns: {0: good[0], length: 1}, eligible: [0]}), TypeError);
  assert.throws(() => searchAdjustedP({returns: good}), TypeError);
  assert.throws(() => searchAdjustedP({returns: good, eligible: 0}), TypeError);
  assert.throws(() => searchAdjustedP({returns: [good[0], Float64Array.of(1, 2)], eligible: [0]}), RangeError);
  // Infinity is not a marker for anything, and a table that went through JSON has null where it had NaN.
  assert.throws(() => searchAdjustedP({returns: [Float64Array.of(1, Infinity, 3)], eligible: [0]}), TypeError);
  assert.throws(() => searchAdjustedP({returns: JSON.parse(JSON.stringify([[1, NaN, 3]])), eligible: [0]}), /Setting 0, window 1: null/);
  assert.throws(() => searchAdjustedP({returns: [[1, '2', 3]], eligible: [0]}), TypeError);
  for (const eligible of [[2], [-1], [0.5], ['0'], [NaN]]) assert.throws(() => searchAdjustedP({returns: good, eligible}), RangeError);
  for (const resamples of [0, -5, 2.5, Infinity, '100']) {
    assert.throws(() => searchAdjustedP({returns: good, eligible: [0], resamples}), RangeError);
    assert.throws(() => confirmationP([1, 2, 3], {resamples}), RangeError);
  }
  for (const seed of [-1, 1.5, 2 ** 32, NaN, '7']) {
    assert.throws(() => searchAdjustedP({returns: good, eligible: [0], seed}), RangeError);
    assert.throws(() => confirmationP([1, 2, 3], {seed}), RangeError);
  }
});

test('confirmationP on hand-solved cases, against every possible resample', () => {
  // 0, 2: score 1 (see above), one degree of freedom: pT = 1/2 - atan(1)/pi = 1/4. Resamples: two of the four
  // have sd* = 0 and count, the other two have statistic 0. pResample = 1/2 is the larger, so p = 1/2.
  const two = confirmationP([0, 2], {resamples: 200000});
  assert.deepEqual([two.n, two.mean, two.sd, two.t, two.lag1, two.factor, two.score, two.skewness], [2, 1, Math.SQRT2, 1, -0.5, 1, 1, 0]);
  near(two.pT, 0.25, 1e-15); near(two.pResample, 0.5, 5 * Math.sqrt(0.25 / 200000)); assert.equal(two.p, two.pResample);
  // 0, 0, 1, 1: a = 1/4, score sqrt(1.8) = 1.342 on 3 degrees of freedom, where
  // P(T > t) = 1/2 - (atan(q) + q / (1 + q^2)) / pi with q = t / sqrt(3) = sqrt(0.6): pT = 0.136.
  // Resamples by number of ones k: k = 0 or 4 (2 of 16) have sd* = 0 and count; k = 1, 2, 3 have statistics
  // -1, 0 and 1, all below the score. pResample = 1/8, so here pT is the larger.
  const step = confirmationP([0, 0, 1, 1], {resamples: 200000}), q = Math.sqrt(0.6);
  near(step.score, Math.sqrt(1.8), 1e-15); assert.equal(step.lag1, 0.25); near(step.t, Math.sqrt(3), 1e-15);
  near(step.pT, 0.5 - (Math.atan(q) + q / (1 + q * q)) / Math.PI, 1e-14);
  assert.deepEqual(enumerate(4, exactConfirmation([0, 0, 1, 1]).reaches), {reached: 32, of: 256, p: 1 / 8});
  near(step.pResample, 1 / 8, 5 * Math.sqrt(1 / 8 * 7 / 8 / 200000)); assert.equal(step.p, step.pT);
  // Without the autocorrelation factor the same four returns would have looked better: plain t-test p = 0.091.
  near(tTestGreaterP([0, 0, 1, 1]), 0.5 - (Math.atan(1) + 1 / 2) / Math.PI, 1e-14); assert.ok(step.p > tTestGreaterP([0, 0, 1, 1]) + 0.04);
  // The tie of the search test above, here with invalid windows around the four returns: 1, 2, 3, 4 has score 3
  // and 18 of the 4^4 resamples of its valid windows reach it, 4 of them exactly. Written in tenths: the same.
  const whole = [NaN, 1, 2, 3, 4, NaN], tenths = whole.map(v => v / 10), exact = enumerate(4, exactConfirmation(whole).reaches);
  assert.deepEqual(exact, {reached: 18, of: 256, p: 18 / 256});
  const pWhole = confirmationP(whole, {resamples: 300000}), pTenths = confirmationP(tenths, {resamples: 300000});
  assert.equal(pTenths.pResample, pWhole.pResample); assert.equal(pWhole.n, 4); near(pWhole.score, 3, 1e-15);
  near(pWhole.pResample, 18 / 256, 5 * Math.sqrt(18 / 256 * 238 / 256 / 300000));
  assert.ok(pWhole.pResample - 14 / 256 > 20 * Math.sqrt(14 / 256 * 242 / 256 / 300000), 'far from the answer that loses the ties');
  // Five windows, enumerated (5^5 resamples), for a rising and a falling series.
  for (const xs of [[1, 3, 2, 5, 4], [4, -1, 0, -2, -3], [0, 0, 0, 1, 5]]) {
    const all = enumerate(5, exactConfirmation(xs).reaches), measured = confirmationP(xs, {resamples: 300000, seed: 77});
    near(measured.pResample, all.p, 5 * Math.sqrt(all.p * (1 - all.p) / 300000), JSON.stringify(xs));
  }
});

test('confirmationP conventions, defaults and determinism', () => {
  const xs = [1.2, -0.4, NaN, 0.9, 2.1, 0.3, NaN, -0.2, 1.7, 0.8, 1.1, -0.9, 0.5];
  const first = confirmationP(xs);
  assert.deepEqual(first, confirmationP(xs)); assert.deepEqual(first, confirmationP(xs, {})); assert.deepEqual(first, confirmationP(xs, {resamples: 10000, seed: 20261118}));
  assert.deepEqual(first, confirmationP(Float64Array.from(xs)));
  assert.equal(first.n, 11);
  // Default: 10,000 resamples. Fewer resamples are the first ones of the same stream; another seed moves pResample a little.
  assert.equal(confirmationP(xs, {resamples: 500}).pResample, slowConfirmationResampleP(xs, 500, 20261118));
  assert.equal(first.pResample, slowConfirmationResampleP(xs, 10000, 20261118));
  const other = confirmationP(xs, {seed: 3});
  assert.equal(other.score, first.score); assert.equal(other.pT, first.pT); assert.notEqual(other.pResample, first.pResample);
  near(other.pResample, first.pResample, 0.02);
  // Invalid windows are dropped for the moments and the resampling, but they still break adjacency for the
  // autocorrelation: moving a NaN changes lag1 and nothing else about the sample.
  const packed = xs.filter(isValid), moved = [NaN, NaN, ...packed];
  assert.deepEqual([first.n, first.mean, first.sd, first.t, first.skewness], ['n', 'mean', 'sd', 't', 'skewness'].map(key => confirmationP(moved)[key]));
  assert.notEqual(confirmationP(moved).lag1, first.lag1);
  // No spread or fewer than two valid windows: score 0 and every p-value 1, whatever the sign of the mean.
  // (The first version's test returned p = 0 for identical positive returns, which the pass rule would confirm.)
  for (const flat of [[], [5], [NaN, 5, NaN], [0.4, 0.4, 0.4], [-2, -2], [0.3, 0.1 + 0.2, 0.3], [0, 0, 0, 0], [NaN, NaN]]) {
    const result = confirmationP(flat);
    assert.deepEqual([result.sd, result.t, result.lag1, result.factor, result.score, result.skewness, result.pT, result.pResample, result.p],
      [0, 0, 0, 1, 0, 0, 1, 1, 1], JSON.stringify(flat));
  }
  assert.ok(Number.isNaN(confirmationP([]).mean)); assert.equal(confirmationP([0.4, 0.4, 0.4]).mean, 0.4);
  // A negative mean: both p-values are above one half.
  const losing = confirmationP(xs.map(v => -v));
  assert.ok(losing.score < 0 && losing.pT > 0.5 && losing.pResample > 0.5 && losing.p >= losing.pT);
  // A strong, steady positive mean over 24 windows: far below any threshold the protocol uses (0.05 / k, k <= 5).
  const strong = confirmationP(Array.from({length: 24}, (_, w) => 2 + ((w * 7) % 5 - 2) / 2));
  assert.ok(strong.score > 10 && strong.p < 1e-4, JSON.stringify(strong));
});

// ---------------------------------------------------------------------------------------------------------------
// research/calibration.mjs: the simulated data, the retired statistics kept for contrast, and the size of both
// tests.

const correlation = (a, b) => {
  const ma = mean(a), mb = mean(b);
  return a.reduce((sum, v, i) => sum + (v - ma) * (b[i] - mb), 0) / ((a.length - 1) * sampleSd(a) * sampleSd(b));
};

test('calibration data: every row has mean 0 and the spread, skewness and autocorrelation it states', () => {
  assert.deepEqual(ROWS.map(row => [row.sigma, row.sign, row.rho, row.idle]), [[0, 1, 0, false], [0.3, -1, 0, false], [0.5, -1, 0, false],
    [0.3, 1, 0, false], [0, 1, 0, true], [0, 1, 0.2, false], [0.3, -1, 0.2, false], [0.5, -1, 0.2, false]]);
  // By construction: the lognormal's skewness, and a driver coefficient that puts the RETURNS' autocorrelation at rho.
  near(skewnessOf(ROWS[1]), -0.95, 0.001); near(skewnessOf(ROWS[2]), -1.75, 0.001); near(skewnessOf(ROWS[3]), 0.95, 0.001);
  assert.equal(driverCoefficient(ROWS[5]), 0.2); near(driverCoefficient(ROWS[6]), 0.2073, 0.0001); near(driverCoefficient(ROWS[7]), 0.2210, 0.0001);
  assert.equal(driverCoefficient(ROWS[2]), 0);
  for (const [r, row] of ROWS.entries()) {
    // One long series per row (200,000 windows): measured against the stated values.
    const xs = simulatedReturns(row, mulberry32(600 + r), 200000), zeros = xs.filter(v => v === 0).length;
    near(mean(xs), 0, 0.012, row.label);
    near(sampleSd(xs), row.idle ? Math.SQRT1_2 : 1, 0.02, row.label);
    near(skewness(xs), skewnessOf(row), row.sigma === 0.5 ? 0.15 : 0.04, row.label);
    near(lag1Autocorrelation(xs), row.rho, 0.01, row.label);
    assert.equal(zeros, row.idle ? 100000 : 0, row.label);   // idle: exactly half the windows return exactly 0
    // The shape itself, integrated against the standard normal density of its driver: mean exactly 0 (no skill),
    // variance 1 and the stated skewness.
    const shape = shapeOf(row), moment = power => integrate(x => shape(x) ** power * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI), -14, 14);
    near(moment(1), 0, 1e-10, row.label); near(moment(2), 1, 1e-10, row.label); near(moment(3), skewnessOf(row), 1e-9, row.label);
  }
  // A true mean is added to every window as it stands.
  const base = simulatedReturns(ROWS[1], mulberry32(5), 40), shifted = simulatedReturns(ROWS[1], mulberry32(5), 40, 0.5);
  assert.deepEqual(shifted, base.map(v => v + 0.5));
});

test('calibration data: the search design is 12 clusters of 25 near-identical settings over 50 windows', () => {
  assert.deepEqual({...SEARCH}, {settings: 300, clusterSize: 25, windows: 50, correlation: 0.95, level: 0.05});
  assert.deepEqual({...CONFIRMATION, levels: [...CONFIRMATION.levels]}, {windows: 24, levels: [0.01, 0.05]});
  for (const [r, row] of ROWS.entries()) {
    let within = 0, across = 0, pairs = 0;
    for (let index = 0; index < 8; index++) {
      const study = makeStudy(r, index);
      assert.equal(study.length, 300); assert.ok(study.every(series => series instanceof Float64Array && series.length === 50));
      for (let k = 0; k < 12; k++) {
        within += correlation(study[25 * k], study[25 * k + 13]); across += correlation(study[25 * k], study[(25 * k + 25) % 300]); pairs++;
        // Idle windows are exact zeros, exactly half of the windows, and the same windows for a whole cluster.
        const idle = Array.from(study[25 * k], v => v === 0);
        assert.equal(idle.filter(Boolean).length, row.idle ? 25 : 0);
        for (let c = 25 * k; c < 25 * k + 25; c++) assert.deepEqual(Array.from(study[c], v => v === 0), idle);
      }
    }
    assert.ok(within / pairs > 0.93 && within / pairs < 0.96, `${row.label}: within-cluster correlation ${within / pairs}`);
    near(across / pairs, 0, 0.06, `${row.label}: correlation between clusters`);
  }
  // The same generator at another size (a study of 12 settings in clusters of 4 over 10 windows, idle row).
  const small = simulatedStudy(ROWS[4], mulberry32(9), {settings: 12, clusterSize: 4, windows: 10});
  assert.deepEqual(small, simulatedStudy(ROWS[4], mulberry32(9), {settings: 12, clusterSize: 4, windows: 10}));
  assert.deepEqual(small.map(series => [series.length, series.filter(v => v === 0).length]), new Array(12).fill([10, 5]));
  // One nominee: 24 windows; idle rows have exactly 12 zeros.
  for (const [r, row] of ROWS.entries()) {
    const xs = makeNominee(r, 3);
    assert.ok(xs instanceof Float64Array && xs.length === 24);
    assert.equal(xs.filter(v => v === 0).length, row.idle ? 12 : 0);
    assert.deepEqual(makeNominee(r, 3, 0.75), xs.map(v => v + 0.75));
  }
});

test('calibration data: every dataset is reproducible and reads its own stretch of the random stream', () => {
  assert.deepEqual(makeStudy(1, 5), makeStudy(1, 5)); assert.deepEqual(makeNominee(6, 9), makeNominee(6, 9));
  assert.notDeepEqual(makeStudy(1, 5), makeStudy(1, 6)); assert.notDeepEqual(makeStudy(1, 5), makeStudy(2, 5));
  assert.notDeepEqual(makeNominee(6, 9), makeNominee(6, 10)); assert.notDeepEqual(makeNominee(6, 9), makeNominee(5, 9));
  // A true mean goes to STRONG_SETTING only, on the same no-skill data.
  const plain = makeStudy(0, 4), strong = makeStudy(0, 4, {strongMean: 1});
  strong.forEach((series, c) => assert.deepEqual(series, c === STRONG_SETTING ? plain[c].map(v => v + 1) : plain[c]));
  // streamSeed(position) starts `position` draws into the stream of SEED: the generator's state advances by a
  // fixed step per draw (checked here with BigInt arithmetic, and by drawing).
  assert.equal(SEED, 20261118);
  for (const position of [0, 1, 65536, 2 ** 31, 2 ** 31 + 2 ** 30 + 123456 * 256, 2 ** 32 - 1])
    assert.equal(streamSeed(position), Number((BigInt(SEED) + BigInt(position) * 0x6D2B79F5n) % (1n << 32n)));
  const base = mulberry32(SEED), draws = Array.from({length: 3000}, base);
  for (const position of [0, 1, 257, 2990]) assert.deepEqual(Array.from({length: 10}, mulberry32(streamSeed(position))), draws.slice(position, position + 10));
  // The layout: the first 2^26 draws are left to the resampling in research/stats.mjs; nominees take 256 draws
  // each from 2^26 on, 65,536 to a row; studies take 128 draws per setting from 2^28 on, each row an eighth of
  // what is left of the cycle. So the stretches are disjoint, and a wider search leaves room for fewer studies.
  const rowSpan = Math.floor((2 ** 32 - 2 ** 28) / ROWS.length);
  assert.deepEqual(makeNominee(1, 2), simulatedReturns(ROWS[1], mulberry32(streamSeed(2 ** 26 + (65536 + 2) * 256)), 24));
  assert.deepEqual(makeStudy(0, 1), simulatedStudy(ROWS[0], mulberry32(streamSeed(2 ** 28 + 128 * 300))));
  assert.deepEqual(makeStudy(2, 3, {settings: 600}), simulatedStudy(ROWS[2], mulberry32(streamSeed(2 ** 28 + 2 * rowSpan + 3 * 128 * 600)), {settings: 600}));
  assert.equal(LIMITS.nominees, 65536); assert.ok(ROWS.length * 65536 * 256 <= 2 ** 28 - 2 ** 26);
  assert.deepEqual([LIMITS.studies(), LIMITS.studies(300), LIMITS.studies(3360), LIMITS.studies(13200)], [13107, 13107, 1170, 297]);
  for (const settings of [300, 3360, 13200]) assert.ok(LIMITS.studies(settings) * 128 * settings <= rowSpan);
  for (const index of [-1, 13107, 1.5]) assert.throws(() => makeStudy(0, index), RangeError);
  assert.throws(() => makeStudy(0, 297, {settings: 13200}), RangeError);
  for (const index of [-1, 65536, 0.5]) assert.throws(() => makeNominee(0, index), RangeError);
  makeStudy(7, 13106); makeNominee(7, 65535);   // the last stretches exist
  // A dataset that would read past its stretch is refused rather than share numbers with the next one.
  assert.throws(() => makeStudy(0, 0, {windows: 80}), /read past its stretch/);
});

test('the retired statistics kept in calibration.mjs are the first version\'s', () => {
  // The first version's own hand-solved case: returns 1, 2, 6 have T = 3 / se, and a resample reaches it only when
  // all three draws are the 6, because it divides by the FULL-sample sd: 1/27. (The amended statistic: 1/9.)
  const three = retiredRealityCheck({returns: [Float64Array.of(1, 2, 6)], resamples: 200000, seed: 11});
  near(three.observedMax, 3 / (Math.sqrt(7) / Math.sqrt(3)), 1e-15);
  near(three.p, 1 / 27, 5 * Math.sqrt(1 / 27 * 26 / 27 / 200000));
  // No autocorrelation factor: the observed maximum is the plain t statistic.
  const runs = [Float64Array.of(1, 2, 3, 4)];
  near(retiredRealityCheck({returns: runs, resamples: 10}).observedMax, Math.sqrt(15), 1e-15);
  near(searchAdjustedP({returns: runs, eligible: [0], resamples: 10}).observedMax, 3, 1e-15);
  // Values produced by the first version's code itself (git show 41d384d:research/stats.mjs) on three simulated
  // studies and nominees of this file: the copy here reproduces them to the last digit.
  const golden = [
    [0, 0, {observedMax: 2.540777931331677, argmax: 62, p: 0.15, resamples: 400, seed: 20261118}, 0.26553475809054733],
    [2, 5, {observedMax: 2.3788812400386687, argmax: 205, p: 0.165, resamples: 400, seed: 20261118}, 0.062385239273745174],
    [7, 11, {observedMax: 2.506498643106086, argmax: 94, p: 0.115, resamples: 400, seed: 20261118}, 0.4356387158478581],
  ];
  for (const [row, index, search, confirmation] of golden) {
    assert.deepEqual(retiredRealityCheck({returns: makeStudy(row, index), resamples: 400}), search);
    assert.equal(retiredConfirmationP(makeNominee(row, index)), confirmation);
    assert.equal(retiredConfirmationP(makeNominee(row, index)), tTestGreaterP(makeNominee(row, index)));
  }
  // It is kept for complete tables only.
  assert.throws(() => retiredRealityCheck({returns: [Float64Array.of(1, NaN, 3)], resamples: 10}), TypeError);
});

test('calibrate: the table does not depend on the number of threads and reports every row with standard errors', async () => {
  const options = {datasets: 4, nominees: 12, resamples: 60};
  const inline = await calibrate({...options, threads: 1}), threaded = await calibrate({...options, threads: 2});
  assert.deepEqual(threaded, inline);
  assert.deepEqual(inline.options, {datasets: 4, nominees: 12, resamples: 60, settings: 300, confirmationResamples: 10000, seed: 20261118});
  assert.deepEqual(inline.rows.map(row => row.label), ROWS.map(row => row.label));
  for (const row of inline.rows) {
    for (const cell of [row.search.amended, row.search.retired]) assert.equal(cell.total, 4);
    assert.deepEqual(row.confirmation.map(c => [c.level, c.amended.total, c.retired.total]), [[0.01, 12, 12], [0.05, 12, 12]]);
    // At any level below one half the amended confirmation test rejects only where the plain t-test does: its
    // score is the t statistic shrunk toward 0 and its p-value is at least the t-test's at that score.
    for (const c of row.confirmation) assert.ok(c.amended.count <= c.retired.count);
  }
  assert.deepEqual(inline.detection.map(d => [d.mean, d.search.detected.total, d.confirmation[0].detected.total]), [[0.3, 1, 3], [0.5, 1, 3], [0.75, 1, 3], [1, 1, 3]]);
  // share(): a count out of a total with the binomial standard error.
  assert.deepEqual(share(8, 32), {count: 8, total: 32, share: 0.25, se: Math.sqrt(0.25 * 0.75 / 32)});
  // The printed table names every row and both versions.
  const text = formatCalibration(inline);
  for (const row of ROWS) assert.ok(text.includes(row.label), row.label);
  for (const word of ['amended', 'RETIRED', 'every true mean exactly 0', '300 settings in clusters of 25', '4 studies per row', '12 nominees per row', '60 resamples per study', '±'])
    assert.ok(text.includes(word), word);
  assert.equal(formatCalibration(threaded), text);
  // Another search width: the same rows, studies of 50 settings.
  const narrow = await calibrate({...options, settings: 50, threads: 1});
  assert.equal(narrow.options.settings, 50); assert.ok(formatCalibration(narrow).includes('50 settings in clusters of 25'));
  assert.deepEqual(narrow.rows.map(row => row.confirmation), inline.rows.map(row => row.confirmation));   // the nominees do not depend on it
  await assert.rejects(calibrate({datasets: 3}), RangeError); await assert.rejects(calibrate({datasets: 13108}), RangeError);
  await assert.rejects(calibrate({datasets: 298, settings: 13200}), RangeError); await assert.rejects(calibrate({datasets: 8, settings: 24}), RangeError);
  await assert.rejects(calibrate({datasets: 8, nominees: 70000}), RangeError); await assert.rejects(calibrate({datasets: 8, resamples: 0}), RangeError);
});

// The ranges below are honest in this sense: each is the value measured by `node research/calibration.mjs`
// (1,600 studies or 16,000 nominees per row, quoted in the comment) give or take about three to three and a half
// standard errors of a share from the smaller number of datasets used here. They pin the behaviour of the tests,
// not a wish.

test('size of the search test: with no skill anywhere, p < 0.05 in about 5% of studies', () => {
  // Bell-shaped no-skill data, 300 settings in 12 clusters, 50 windows. Measured: 4.9% (standard error 0.5).
  // 240 studies here have a standard error of 1.4 points.
  const tally = runTask({test: 'search', row: 0, from: 0, to: 240, resamples: 500});
  const size = tally.amended[0] / tally.datasets;
  assert.ok(size >= 0.01 && size <= 0.10, `share of no-skill studies with search-adjusted p < 0.05: ${size}`);
  // "found" counts the studies where p < 0.05 AND the best score belongs to the setting that carries the mean
  // in the detection table. With no skill that setting is the best one in about 1 study of 300.
  assert.ok(tally.found <= 2 && tally.found < tally.amended[0], `found in ${tally.found} no-skill studies`);
});

test('a setting with a strong true mean is found by the search test and confirmed by the confirmation test', () => {
  // One setting of the 300 gains one standard deviation per window. Measured: detected and found in 100% of 400.
  const search = runTask({test: 'search', row: 0, from: 0, to: 40, mean: 1, resamples: 500});
  assert.ok(search.amended[0] >= 36 && search.found >= 36, `of 40 studies: p < 0.05 in ${search.amended[0]}, the true setting holds the best score in ${search.found}`);
  // The same mean over 24 confirmation windows. Measured: p < 0.01 for 96.9% of 4,000 nominees (standard error 0.3).
  const confirmation = runTask({test: 'confirmation', row: 0, from: 0, to: 300, mean: 1});
  assert.ok(confirmation.amended[0] >= 280, `of 300 nominees, confirmation p < 0.01 for ${confirmation.amended[0]}`);
});

test('regression: left-skewed no-skill data no longer makes the search test reject far too often', () => {
  // Skewness -1.75 (occasional larger losses), every true mean 0. The retired statistic divided each resampled
  // mean by the full-sample sd and found "p < 0.05" in 40.8% of such studies (standard error 1.2); the amended
  // one re-studentizes inside each resample: 3.3% (0.4). 120 studies here: standard errors 4.5 and 1.6 points.
  const tally = runTask({test: 'search', row: 2, from: 0, to: 120, resamples: 500});
  const amended = tally.amended[0] / tally.datasets, retired = tally.retired[0] / tally.datasets;
  assert.ok(retired >= 0.25, `the retired statistic's failure is present in this data: ${retired}`);
  assert.ok(amended <= 0.09, `the amended statistic does not have it: ${amended}`);
});

test('size of the confirmation test: bell-shaped and left-skewed no-skill nominees', () => {
  // Bell-shaped, 24 windows. Measured over all 65,536 nominees this row can make: p < 0.01 for 0.68% (standard
  // error 0.03) and p < 0.05 for 3.87% (0.08); the default table's first 16,000 show 0.77% and 3.81%. Stricter
  // than nominal, because the p-value is the larger of two. 2,000 nominees here have standard errors of 0.18
  // and 0.43 points.
  const bell = runTask({test: 'confirmation', row: 0, from: 0, to: 2000});
  const [bell01, bell05] = bell.amended.map(count => count / bell.datasets);
  assert.ok(bell01 >= 0.0015 && bell01 <= 0.013, `no-skill share with confirmation p < 0.01: ${bell01}`);
  assert.ok(bell05 >= 0.026 && bell05 <= 0.053, `no-skill share with confirmation p < 0.05: ${bell05}`);
  // The plain t-test is exact for such data, which checks the simulation itself: 1% and 5% of 2,000, give or
  // take three and a half standard errors (4.4 and 9.7 nominees).
  assert.ok(bell.retired[0] >= 5 && bell.retired[0] <= 35 && bell.retired[1] >= 66 && bell.retired[1] <= 134, JSON.stringify(bell.retired));
  // Skewness -1.75. Measured: the t-test alone (retired) passes 3.21% (0.14) at the 1% level; the amended test
  // passes 1.54% (0.10). It is still about one and a half times too lenient there, and the range says so.
  const skewed = runTask({test: 'confirmation', row: 2, from: 0, to: 2000});
  const amended = skewed.amended[0] / skewed.datasets, retired = skewed.retired[0] / skewed.datasets;
  assert.ok(retired >= 0.02, `the t-test alone on left-skewed no-skill nominees, share with p < 0.01: ${retired}`);
  assert.ok(amended >= 0.007 && amended <= 0.025, `the amended test on the same nominees: ${amended}`);
  // At any level below one half the amended test rejects only where the t-test alone does.
  for (const tally of [bell, skewed]) for (const i of [0, 1]) assert.ok(tally.amended[i] <= tally.retired[i]);
});

test('searchAdjustedP handles the full search width fast enough', () => {
  // 13,200 settings x 50 windows with a tenth of the protocol's resamples; a third of the settings have an
  // invalid window. Cost is linear in resamples, so the limit of 6 s here means under a minute for all 10,000
  // (measured: about 1 s here, about 10 s for 10,000).
  const normal = gaussian(mulberry32(3));
  const returns = Array.from({length: 13200}, (_, c) => {
    const row = Float64Array.from({length: 50}, normal);
    if (c % 3 === 0) row[c % 7] = NaN;
    return row;
  });
  const started = performance.now();
  const result = searchAdjustedP({returns, eligible: returns.map((_, c) => c), resamples: 1000});
  const elapsed = performance.now() - started;
  assert.ok(result.observedMax > 2.5 && result.observedMax < 7 && result.p > 0 && result.p <= 1, JSON.stringify(result));
  assert.equal(result.observedMax, score(returns[result.argmax]));
  assert.ok(elapsed < 6000, `${elapsed.toFixed(0)} ms for 1,000 resamples`);
});
