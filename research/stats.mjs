// Statistics for the exploration protocol (research/PROTOCOL.md, "Measures" and "Confirmation").
// Pure functions of their arguments: no Math.random, no clock, no I/O. Nothing here places or models an order.
//
// Conventions, stated once:
// - Inputs are arrays or typed arrays of finite numbers. mean, sampleSd, tStat, tTestGreaterP and ols THROW on a
//   NaN or infinite element instead of skipping it, so a missing value can never silently change n. Only
//   realityCheck reads NaN as data: there it marks a window that is invalid for that setting.
// - A series whose values are all identical has sd exactly 0 (never rounding noise), so the protocol's
//   "T is 0 when sd is 0" applies to it. Fewer than two values also give sd 0.
export {signTestPValue} from '../report-card.js';

// n, mean and sample standard deviation (n - 1 denominator) of xs[0 .. n).
function moments(xs, n = xs.length) {
  let sum = 0, constant = true;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (!Number.isFinite(v)) throw new TypeError(`Value ${i} is not a finite number; drop invalid entries first`);
    sum += v;
    if (v !== xs[0]) constant = false;
  }
  if (n < 2 || constant) return {n, mean: n ? xs[0] : NaN, sd: 0};
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) squares += (xs[i] - mean) ** 2;
  return {n, mean, sd: Math.sqrt(squares / (n - 1))};
}

// The protocol's score, T = mean / (sd / sqrt(n)); 0 when sd is 0 (which includes n < 2).
const score = ({n, mean, sd}) => sd === 0 ? 0 : mean / (sd / Math.sqrt(n));

// Arithmetic mean; NaN for an empty input.
export function mean(xs) { return moments(xs).mean; }

// Sample standard deviation, n - 1 denominator; 0 for n < 2.
export function sampleSd(xs) { return moments(xs).sd; }

// T = mean / (sd / sqrt(n)), defined as 0 when sd is 0 or n < 2.
export function tStat(xs) { return score(moments(xs)); }

// ln Gamma(z) for z > 0 by the usual nine-term series (g = 7), relative error near 1e-15.
const GAMMA_TERMS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);   // reflection
  z -= 1;
  let series = GAMMA_TERMS[0];
  for (let i = 1; i < GAMMA_TERMS.length; i++) series += GAMMA_TERMS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

// ln B(a, 1/2) = ln Gamma(1/2) - (ln Gamma(a + 1/2) - ln Gamma(a)), with Gamma(1/2) = sqrt(pi). For large a the
// two ln Gamma values are huge and nearly cancel, so their difference comes from its asymptotic series instead
// (next term about 0.0012 / a^7: below 1e-16 from a = 100).
function lnBetaHalf(a) {
  return 0.5 * Math.log(Math.PI) - (a < 100 ? lnGamma(a + 0.5) - lnGamma(a)
    : 0.5 * Math.log(a) - 1 / (8 * a) + 1 / (192 * a ** 3) - 1 / (640 * a ** 5));
}

// Continued fraction of the incomplete beta function, evaluated front to back with a guard against zero
// denominators. It converges quickly for x < (a + 1) / (a + b + 2), which is the only place it is called.
function betaFraction(a, b, x) {
  const TINY = 1e-300, guard = v => Math.abs(v) < TINY ? TINY : v;
  let c = 1, d = 1 / guard(1 - (a + b) * x / (a + 1)), h = d;
  for (let m = 1; m <= 100000; m++) {
    const even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / guard(1 + even * d); c = guard(1 + even / c); h *= d * c;
    const odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / guard(1 + odd * d); c = guard(1 + odd / c);
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) return h;
  }
  throw new Error('Incomplete beta continued fraction did not converge');
}

// P(T > t) for the t distribution with df degrees of freedom, through the regularized incomplete beta function I:
// P(|T| > |t|) = I_x(df/2, 1/2) at x = df / (df + t^2). For x near 1 (small |t|) the complement
// 1 - I_y(1/2, df/2), y = 1 - x, is used, with x and y each computed without cancellation. Working on the upper
// tail keeps small p-values accurate in relative terms. |t| so large that t^2/df overflows is treated as infinite.
// df above 1e6 is refused: there x is too close to 1 for the fraction to stay accurate, and no use here needs it.
function tUpperTail(t, df) {
  if (!(df > 0) || df > 1e6) throw new RangeError('df must be positive and at most 1e6');
  if (Number.isNaN(t)) return NaN;
  const u = t * t / df;
  if (u === Infinity) return t > 0 ? 0 : 1;
  const a = df / 2, b = 0.5, x = 1 / (1 + u), y = u / (1 + u);
  // x^a * y^b / B(a, b), with ln x = -log1p(u) and ln y = -log1p(1/u).
  const front = Math.exp(-lnBetaHalf(a) - a * Math.log1p(u) - b * Math.log1p(1 / u));
  const twoSided = x < (a + 1) / (a + b + 2) ? front * betaFraction(a, b, x) / a : 1 - front * betaFraction(b, a, y) / b;
  return t > 0 ? twoSided / 2 : 1 - twoSided / 2;
}

// P(T <= t) for the t distribution with 0 < df <= 1e6 degrees of freedom (df need not be an integer); t may be
// infinite. Checked to 1e-11 or better against closed forms, an exact finite series for integer df and the normal
// limit (research/stats.test.mjs); for the protocol's df (at most 73) the error is near 1e-14.
export function studentTCdf(t, df) { return tUpperTail(-t, df); }

// One-sided p-value of the t-test of "mean > 0": P(T >= observed t) with n - 1 degrees of freedom.
// Convention where the test is undefined: 1 when n < 2 (one value shows nothing); with sd exactly 0 (all values
// identical) the p-value is the limit of the test, 0 when the mean is > 0 and 1 when it is <= 0.
// Note tStat reports 0 for an sd of 0, so "p = 0 with T = 0" is possible for identical positive values.
export function tTestGreaterP(xs) {
  const m = moments(xs);
  if (m.n < 2) return 1;
  if (m.sd === 0) return m.mean > 0 ? 0 : 1;
  return tUpperTail(score(m), m.n - 1);
}

// Least-squares line y = intercept + slope * x. Standard errors use n - 2 residual degrees of freedom;
// pInterceptGreater is the one-sided p-value for "intercept > 0" (the protocol regresses a nominee's return r on
// the comparison return b and asks whether the intercept is more than a diluted share of buy-and-hold).
// Undefined quantities are NaN: everything but n when n < 2 or x is constant; the standard errors, tIntercept
// and pInterceptGreater when n < 3; r2 when y is constant. A perfect fit (seIntercept exactly 0) follows the
// conventions above: tIntercept 0, pInterceptGreater 0 if the intercept is > 0 and 1 otherwise.
export function ols(y, x) {
  if (y.length !== x.length) throw new RangeError('y and x must have the same length');
  const my = moments(y), mx = moments(x), n = my.n;   // also rejects non-finite values
  const result = {n, intercept: NaN, slope: NaN, seIntercept: NaN, seSlope: NaN, tIntercept: NaN,
    pInterceptGreater: NaN, r2: NaN};
  if (n < 2 || mx.sd === 0) return result;
  let sxx = 0, sxy = 0, syy = 0, residual = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx.mean, dy = y[i] - my.mean;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxy / sxx, intercept = my.mean - slope * mx.mean;
  for (let i = 0; i < n; i++) residual += (y[i] - intercept - slope * x[i]) ** 2;
  Object.assign(result, {intercept, slope, r2: syy > 0 ? 1 - residual / syy : NaN});
  if (n < 3) return result;
  const variance = residual / (n - 2), seIntercept = Math.sqrt(variance * (1 / n + mx.mean ** 2 / sxx));
  return Object.assign(result, {seIntercept, seSlope: Math.sqrt(variance / sxx),
    tIntercept: seIntercept === 0 ? 0 : intercept / seIntercept,
    pInterceptGreater: seIntercept === 0 ? (intercept > 0 ? 0 : 1) : tUpperTail(intercept / seIntercept, n - 2)});
}

// mulberry32: a small seeded generator returning uniform doubles in [0, 1) with 32 bits of resolution.
// The same stream as research/synthetic.mjs for the same seed (the seed is read as an unsigned 32-bit integer).
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Search-adjusted p-value (research/PROTOCOL.md, "Search-adjusted p-value (reality check)").
//
// returns: one array (Float64Array) per setting, all aligned to the same list of design windows; NaN marks a
// window that is invalid for that setting. eligible: the setting indices to search over.
//
// Observed: the maximum over eligible settings of T(c) = mean(c) / (sd(c) / sqrt(n(c))) over that setting's valid
// windows, T being 0 when sd is 0 (exactly tStat of the valid values).
// Each resample draws as many window indices as there are windows, with replacement, ONE draw shared by every
// setting: window = floor(u * windows) for consecutive u from a single mulberry32(seed) stream, resample after
// resample. The draws do not depend on returns or eligible, so two calls with the same seed and window count
// (one family, then all families pooled) see the same resampled windows.
// For each eligible setting the resample statistic is (mean*(c) - mean(c)) / (sd(c) / sqrt(n(c))): mean* is the
// mean over the drawn windows that are valid for c (with multiplicity), and mean(c), sd(c), n(c) are the
// full-sample values. A setting is skipped in a resample that drew fewer than 2 of its valid windows, and in
// every resample when its sd is 0 (it still enters the observed maximum, with T = 0).
// p = share of resamples whose maximum is >= the observed maximum. Two cases the protocol does not define are
// resolved so that p can only be overstated: a resample in which no setting could be evaluated counts as
// reaching the observed maximum, and with nothing eligible the result is observedMax -Infinity, argmax -1, p 1.
// argmax is the setting index with the observed maximum (the earliest in `eligible` on a tie).
//
// KNOWN LIMIT OF THE STATISTIC (it is the protocol's, implemented to the letter): this p-value is too small when
// many settings are searched over about 50 windows. The observed T divides by an sd estimated from those windows
// and so has the heavier tails of a t distribution; the resampled statistic reuses that same sd and has lighter,
// near-normal tails. Simulated with every true mean zero (normal returns, 50 windows, the null design of
// research/stats.test.mjs), p < 0.05 occurred in 6.5% of 10,000 datasets with 6 settings, 13% of 2,000 with 500
// settings and 31% of 150 with 12,720 settings. So a p from this function understates how often a search this
// wide turns up a best setting this good by chance.
//
// Cost: settings x windows x resamples multiply-adds on typed arrays, with nothing allocated per resample
// (about 9 s for 12,720 x 50 x 10,000).
export function realityCheck({returns, eligible, resamples = 10000, seed = 20261118}) {
  if (!Array.isArray(returns)) throw new TypeError('returns must be an array with one array of returns per setting');
  if (!Array.isArray(eligible) && !ArrayBuffer.isView(eligible)) throw new TypeError('eligible must be an array of setting indices');
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('seed must be an unsigned 32-bit integer');
  const windows = returns.length ? returns[0].length : 0;
  for (const row of returns)
    if (row.length !== windows) throw new RangeError('Every setting needs one return per design window');

  // Full-sample statistics and the observed maximum. Settings that can be standardized (sd > 0) are grouped by
  // which windows are valid for them, because the number of valid drawn windows depends only on that pattern.
  const scratch = new Float64Array(windows), groups = new Map();
  let observedMax = -Infinity, argmax = -1;
  for (let e = 0; e < eligible.length; e++) {
    const c = eligible[e];
    if (!Number.isInteger(c) || c < 0 || c >= returns.length) throw new RangeError(`Eligible setting index out of range: ${c}`);
    const row = returns[c];
    let n = 0, pattern = '';
    for (let w = 0; w < windows; w++) {
      // Only NaN marks an invalid window. A null (what JSON makes of NaN) would otherwise be stored as a return of 0.
      if (typeof row[w] !== 'number') throw new TypeError(`Setting ${c}, window ${w}: not a number (NaN marks an invalid window)`);
      if (Number.isNaN(row[w])) pattern += '0';
      else { scratch[n++] = row[w]; pattern += '1'; }
    }
    const m = moments(scratch, n), t = score(m);
    if (t > observedMax) { observedMax = t; argmax = c; }
    if (m.sd === 0) continue;
    if (!groups.has(pattern)) groups.set(pattern, []);
    groups.get(pattern).push({c, mean: m.mean, se: m.sd / Math.sqrt(n)});
  }
  if (!groups.size) return {observedMax, argmax, p: 1, resamples, seed};

  // The draws, stored as how many times each resample drew each window.
  const Counts = windows < 256 ? Uint8Array : windows < 65536 ? Uint16Array : Uint32Array;
  const counts = new Counts(resamples * windows), random = mulberry32(seed);
  for (let b = 0; b < resamples; b++)
    for (let draw = 0; draw < windows; draw++) counts[b * windows + Math.floor(random() * windows)]++;

  const best = new Float64Array(resamples).fill(-Infinity);   // each resample's maximum so far
  const drawn = new Float64Array(resamples), valid = new Uint8Array(windows), row = new Float64Array(windows);
  for (const [pattern, members] of groups) {
    for (let w = 0; w < windows; w++) valid[w] = pattern[w] === '1' ? 1 : 0;
    for (let b = 0, k = 0; b < resamples; b++) {   // drawn[b]: resample b's windows that are valid for this pattern
      let total = 0;
      for (let w = 0; w < windows; w++, k++) total += counts[k] * valid[w];
      drawn[b] = total;
    }
    for (const {c, mean, se} of members) {
      for (let w = 0; w < windows; w++) row[w] = valid[w] ? returns[c][w] : 0;
      for (let b = 0, k = 0; b < resamples; b++) {
        let sum = 0;
        for (let w = 0; w < windows; w++, k++) sum += counts[k] * row[w];
        if (drawn[b] < 2) continue;
        const statistic = (sum / drawn[b] - mean) / se;
        if (statistic > best[b]) best[b] = statistic;
      }
    }
  }
  let reached = 0;
  for (let b = 0; b < resamples; b++) if (best[b] >= observedMax || best[b] === -Infinity) reached++;
  return {observedMax, argmax, p: reached / resamples, resamples, seed};
}
