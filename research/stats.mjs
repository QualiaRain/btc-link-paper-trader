// Statistics for the exploration protocol as amended (research/PROTOCOL.md, "Measures" and "Confirmation").
// Pure functions of their arguments: no Math.random, no clock, no I/O. Nothing here places or models an order.
// The first version's realityCheck is retired (Amendment 1); research/calibration.mjs keeps a labelled copy
// only to measure it against its replacement.
//
// Conventions, stated once:
// - A series is an Array or a typed array aligned to a list of windows. NaN marks a window that is invalid for
//   that setting: it is ignored, and n counts the valid entries. Any other entry that is not a finite number
//   (Infinity, null, undefined, a string) throws a TypeError, and so does an argument of the wrong shape (a
//   number, an object, a flat array where rows are expected): a malformed input is never read as "no data".
// - "sd is 0" (PROTOCOL.md: "T is 0 when sd is 0") means the valid values do not differ beyond rounding: their
//   spread, max - min, is at most ZERO_SPREAD of their largest magnitude. Identical values therefore have sd
//   exactly 0 (adding 0.1 three times does not give 0.3), and so do values meant to be equal that differ in the
//   last bits (0.3 and 0.1 + 0.2). Fewer than two valid entries also give sd 0. Every other sample is computed
//   exactly as written.
// - A sample with sd 0 has score 0 and p-value 1 in every test here. It is never evidence of anything.
// - A resampled statistic "at least" the observed score is counted when it is within TIE_TOLERANCE of it
//   (relative to the score, absolute below a score of 1; the statistic has no unit). An exact tie is then not
//   lost to rounding, so ">=" behaves as written on decimal data, and the p-value can only be overstated. This
//   holds while a series' mean is within about a hundred of its standard deviations of zero; beyond that the
//   rounding of the returns themselves exceeds the tolerance. The same tolerance decides which of two settings
//   holds the larger score (searchAdjustedP): scores closer than that are a tie.
// - A series whose standard deviation is not finite (values beyond about 1e154, whose squares overflow) has no
//   score: score, the autocorrelation functions, searchAdjustedP, confirmationP and buyAndHoldReading throw a
//   RangeError for it instead of returning NaN.
export {signTestPValue} from '../report-card.js';

const ZERO_SPREAD = 1e-12, TIE_TOLERANCE = 1e-12;

const isSeries = xs => Array.isArray(xs) || (ArrayBuffer.isView(xs) && !(xs instanceof DataView));
const shown = v => (typeof v === 'number' ? String(v) : v === null ? 'null' : typeof v);

// The valid (non-NaN) entries of a series, in window order.
function validEntries(xs, label = 'Series') {
  if (!isSeries(xs)) throw new TypeError(`${label}: expected an array or typed array of numbers, got ${shown(xs)}`);
  const values = new Float64Array(xs.length);
  let n = 0;
  for (let w = 0; w < xs.length; w++) {
    const v = xs[w];
    if (typeof v !== 'number' || v === Infinity || v === -Infinity)
      throw new TypeError(`${label}, window ${w}: ${shown(v)} is not a finite number (only NaN marks an invalid window)`);
    if (v === v) values[n++] = v;
  }
  return values.subarray(0, n);
}

// n, mean and sample standard deviation (n - 1 denominator) of v[0 .. n), which holds valid entries only.
function moments(v, n = v.length) {
  if (n === 0) return {n, mean: NaN, sd: 0};
  let sum = 0, low = v[0], high = v[0];
  for (let i = 0; i < n; i++) {
    const x = v[i];
    sum += x;
    if (x < low) low = x; else if (x > high) high = x;
  }
  if (high - low <= ZERO_SPREAD * Math.max(Math.abs(low), Math.abs(high)))   // "sd is 0", see the conventions
    return {n, mean: low === high ? low : sum / n, sd: 0};
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) squares += (v[i] - mean) ** 2;
  return {n, mean, sd: Math.sqrt(squares / (n - 1))};
}

// mean / (sd / sqrt(n)); 0 when sd is 0 (which includes n < 2).
const tOf = ({n, mean, sd}) => (sd === 0 ? 0 : mean / (sd / Math.sqrt(n)));

// The moments of a series that can be scored: a standard deviation that is not finite is refused (conventions).
function finiteSd(m, label = 'Series') {
  if (!Number.isFinite(m.sd)) throw new RangeError(`${label}: the standard deviation is not finite (the squares of the values overflow)`);
  return m;
}

// PROTOCOL.md, Score: "the lag-1 autocorrelation of r in window order (sum of products of deviations over
// adjacent valid windows, divided by the sum of squared deviations)", and Reading 9: "The autocorrelation at lag
// j pairs valid windows exactly j places apart and divides by the same sum of squared deviations as lag 1".
// xs is already validated, m its moments.
function autocorrelationOf(xs, m, lag) {
  if (m.sd === 0) return 0;
  let products = 0, squares = 0;
  for (let w = 0; w < xs.length; w++) {
    const deviation = xs[w] - m.mean;
    if (deviation !== deviation) continue;                  // an invalid window enters nothing and pairs with nothing
    squares += deviation * deviation;
    const earlier = w < lag ? NaN : xs[w - lag] - m.mean;   // the deviation of window w - lag, NaN if invalid
    if (earlier === earlier) products += earlier * deviation;
  }
  return products / squares;
}

// PROTOCOL.md, Score: "sqrt((1 - a) / (1 + a)) ... a ... floored at 0". The lag-1 autocorrelation as defined
// above is always below 1, so the factor lies in (0, 1].
const factorOf = lag1 => { const a = Math.max(0, lag1); return Math.sqrt((1 - a) / (1 + a)); };

// Everything the protocol's score is made of, for one series aligned to its windows.
function describe(xs, label) {
  const values = validEntries(xs, label), m = finiteSd(moments(values), label);
  const t = tOf(m), lag1 = autocorrelationOf(xs, m, 1), factor = factorOf(lag1);
  return {values, n: m.n, mean: m.mean, sd: m.sd, t, lag1, factor, score: t * factor};
}

// Arithmetic mean of the valid entries; NaN when there is none.
export function mean(xs) { return moments(validEntries(xs)).mean; }

// Sample standard deviation of the valid entries, n - 1 denominator; 0 for n < 2.
export function sampleSd(xs) { return moments(validEntries(xs)).sd; }

// mean / (sd / sqrt(n)) over the valid entries; 0 when sd is 0 or n < 2. Without the autocorrelation factor.
export function tStat(xs) { return tOf(moments(validEntries(xs))); }

// a = (sum over ADJACENT VALID windows (w, w + 1) of (x[w] - m)(x[w+1] - m)) / (sum over valid w of (x[w] - m)^2),
// m the mean of the valid entries. An invalid window breaks adjacency: its two neighbours are not a pair.
// 0 when the denominator is 0 (sd is 0), which includes fewer than two valid entries.
export function lag1Autocorrelation(xs) { return describe(xs).lag1; }

// The same at lag `lag` (a positive integer), PROTOCOL.md Reading 9: the products are summed over the windows w
// for which x[w] and x[w + lag] are both valid (an invalid window between them changes nothing), and the
// denominator is the one of lag 1. Reported as computed: not floored at 0. autocorrelationAt(xs, 1) is
// lag1Autocorrelation(xs), by the same code.
export function autocorrelationAt(xs, lag) {
  if (!Number.isInteger(lag) || lag < 1) throw new RangeError('lag must be a positive integer');
  return autocorrelationOf(xs, finiteSd(moments(validEntries(xs))), lag);
}

// sqrt((1 - a) / (1 + a)) with a = max(0, lag1Autocorrelation(xs)): 1 for a series without positive lag-1
// autocorrelation, smaller when good and bad windows come in runs.
export function autocorrelationFactor(xs) { return describe(xs).factor; }

// The protocol's Score T(c) = tStat(xs) * autocorrelationFactor(xs); 0 when sd is 0 or n < 2.
export function score(xs) { return describe(xs).score; }

// Sample skewness g1 = m3 / m2^1.5 of the valid entries, with m2 and m3 the second and third central moments
// (both divided by n); 0 when it is undefined (sd is 0).
export function skewness(xs) {
  const values = validEntries(xs), m = moments(values);
  if (m.sd === 0) return 0;
  let m2 = 0, m3 = 0;
  for (let i = 0; i < m.n; i++) {
    const deviation = values[i] - m.mean;
    m2 += deviation * deviation; m3 += deviation ** 3;
  }
  return (m3 / m.n) / (m2 / m.n) ** 1.5;
}

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

// One-sided p-value of the plain t-test of "mean > 0" on the valid entries: P(T >= tStat(xs)) with n - 1 degrees
// of freedom, no autocorrelation factor. 1 when sd is 0 or n < 2. On its own this was the first version's
// confirmation test; the amended one is confirmationP below.
export function tTestGreaterP(xs) {
  const m = moments(validEntries(xs));
  return m.sd === 0 ? 1 : tUpperTail(tOf(m), m.n - 1);
}

// Least-squares line y = intercept + slope * x over the windows valid for both series (a NaN in either drops
// the pair). Standard errors use n - 2 residual degrees of freedom; pInterceptGreater is the one-sided p-value
// for "intercept > 0" (the protocol regresses a nominee's return r on the comparison return b and asks whether
// the intercept is more than a diluted share of buy-and-hold).
// Undefined quantities are NaN: everything but n when n < 2 or x is constant; the standard errors, tIntercept
// and pInterceptGreater when n < 3; r2 when y is constant. A fit with no residual beyond rounding (every
// residual within ZERO_SPREAD of the largest |y|) has standard errors 0 and follows the convention above:
// tIntercept 0 and pInterceptGreater 1.
export function ols(y, x) {
  if (!isSeries(y) || !isSeries(x)) throw new TypeError('ols(y, x): y and x must be arrays or typed arrays of numbers');
  if (y.length !== x.length) throw new RangeError('y and x must have the same length');
  const ys = new Float64Array(y.length), xs = new Float64Array(y.length);
  let n = 0, largest = 0;
  for (let w = 0; w < y.length; w++) {
    for (const v of [y[w], x[w]])
      if (typeof v !== 'number' || v === Infinity || v === -Infinity)
        throw new TypeError(`ols, window ${w}: ${shown(v)} is not a finite number (only NaN marks an invalid window)`);
    if (y[w] !== y[w] || x[w] !== x[w]) continue;
    ys[n] = y[w]; xs[n++] = x[w];
    largest = Math.max(largest, Math.abs(y[w]));
  }
  const my = moments(ys, n), mx = moments(xs, n);
  const result = {n, intercept: NaN, slope: NaN, seIntercept: NaN, seSlope: NaN, tIntercept: NaN,
    pInterceptGreater: NaN, r2: NaN};
  if (n < 2 || mx.sd === 0) return result;
  let sxx = 0, sxy = 0, syy = 0, residual = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx.mean, dy = ys[i] - my.mean;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxy / sxx, intercept = my.mean - slope * mx.mean;
  for (let i = 0; i < n; i++) residual += (ys[i] - intercept - slope * xs[i]) ** 2;
  if (residual <= n * (ZERO_SPREAD * largest) ** 2) residual = 0;
  Object.assign(result, {intercept, slope, r2: syy > 0 ? 1 - residual / syy : NaN});
  if (n < 3) return result;
  const variance = residual / (n - 2), seIntercept = Math.sqrt(variance * (1 / n + mx.mean ** 2 / sxx));
  return Object.assign(result, {seIntercept, seSlope: Math.sqrt(variance / sxx),
    tIntercept: seIntercept === 0 ? 0 : intercept / seIntercept,
    pInterceptGreater: seIntercept === 0 ? 1 : tUpperTail(intercept / seIntercept, n - 2)});
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

function checkResampling(resamples, seed) {
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('seed must be an unsigned 32-bit integer');
}

// The resampled statistic of both tests, (mean* - mean) / (sd* / sqrt(m)) over m drawn values, computed two ways.
// fromSums works from s1 = the sum of the drawn values' deviations from the full-sample mean and s2 = the sum of
// their squares: mean* - mean = s1 / m and (m - 1) sd*^2 = s2 - s1^2 / m. That subtraction is accurate unless it
// cancels (a statistic beyond sqrt(m - 1) in size), and a resample without spread ("sd* is 0") leaves a
// difference of at most noSpread. Both cases return NaN and are settled by literal(): the formula as written,
// on the drawn values themselves, which is NaN only when sd* is 0.
const fromSums = (s1, s2, m, noSpread) => {
  const between = s1 * s1 / m, within = s2 - between;
  return between <= 0.5 * s2 && within > noSpread ? s1 * Math.sqrt((m - 1) / (m * within)) : NaN;
};
const literal = (drawn, m, mean) => {
  const star = moments(drawn, m);
  return star.sd === 0 ? NaN : (star.mean - mean) / (star.sd / Math.sqrt(m));
};
// m values with "sd is 0" lie within ZERO_SPREAD x largest of each other, so their squared deviations sum to at
// most half of this.
const noSpreadBound = (largest, m) => 2 * m * (ZERO_SPREAD * largest) ** 2;

// Search-adjusted p-value (PROTOCOL.md, "Measures", as amended).
//
// returns: one series per setting, all aligned to the same design-window columns; NaN marks a window that is
// invalid for that setting. eligible: the setting indices searched over. The columns are both the windows that
// are drawn and the order in which windows are adjacent for the autocorrelation, so a caller that removes a
// window's column makes its two neighbours adjacent; keeping it as NaN keeps them apart (it is then drawn like
// any other column and ignored).
//
// Observed: the maximum over eligible settings of the protocol's score T(c) = score(returns[c]); argmax is the
// setting holding it and observedMax is that setting's score. Ties go to the earliest setting in `eligible`: a
// later setting takes the maximum only when its score is above it by more than the tie tolerance of the
// conventions, so two settings whose scores are equal as written and differ in their last bits (a series and
// its reverse) are a tie, like two identical series. A setting with no valid window is left out: it is never
// the argmax and adds nothing to the maximum.
// Each resample draws as many window indices as there are columns, with replacement, ONE draw shared by every
// setting: window = floor(u * columns) for consecutive u from a single mulberry32(seed) stream, resample after
// resample. The draws do not depend on returns or eligible, so two calls with the same seed and column count
// (one family, then all families pooled) see the same resampled windows.
// In each resample, for every eligible setting: mean*, sd* (n - 1 denominator) and m* over the drawn windows
// that are valid for it, counted as often as drawn; the setting is skipped in that resample when m* < 2 or sd*
// is 0; its statistic is (mean* - mean(c)) / (sd* / sqrt(m*)), with mean(c) the full-sample mean. The
// autocorrelation factor is in the observed score only, as the protocol writes it.
// p = share of resamples whose maximum statistic is at least the observed maximum. A resample in which no
// setting can be evaluated counts as reaching it, so p can only be overstated; with nothing to search the
// result is observedMax -Infinity, argmax -1, p 1. p is a plain share (no +1): 0 means below 1 / resamples.
//
// How often this p-value falls below 0.05 when no setting has a positive mean is measured, not assumed:
// research/calibration.mjs, and PROTOCOL.md "What the tests can and cannot do".
//
// Cost: about 1.5 ns per setting x column x resample on typed arrays (about 10 s for 13,200 x 50 x 10,000).
export function searchAdjustedP({returns, eligible, resamples = 10000, seed = 20261118}) {
  if (!Array.isArray(returns)) throw new TypeError('returns must be an array with one series of window returns per setting');
  if (!isSeries(eligible)) throw new TypeError('eligible must be an array of setting indices');
  checkResampling(resamples, seed);
  returns.forEach((row, c) => {
    if (!isSeries(row)) throw new TypeError(`returns[${c}]: expected an array or typed array with one return per window, got ${shown(row)}`);
    if (row.length !== returns[0].length) throw new RangeError('Every setting needs one return per design window');
  });
  const windows = returns.length ? returns[0].length : 0;

  // The observed side. Settings that can be resampled (sd > 0) are grouped by which windows are valid for
  // them, because m*, the number of valid drawn windows, depends only on that pattern.
  const groups = new Map();
  let observedMax = -Infinity, argmax = -1;
  for (let e = 0; e < eligible.length; e++) {
    const c = eligible[e];
    if (!Number.isInteger(c) || c < 0 || c >= returns.length) throw new RangeError(`Eligible setting index out of range: ${c}`);
    const row = returns[c], observed = describe(row, `Setting ${c}`);
    if (observed.n === 0) continue;
    if (argmax === -1 || observed.score > observedMax + TIE_TOLERANCE * Math.max(1, Math.abs(observedMax))) {
      observedMax = observed.score; argmax = c;
    }
    if (observed.sd === 0) continue;   // without spread, sd* is 0 in every resample
    let pattern = '', largest = 0;
    for (let w = 0; w < windows; w++) {
      pattern += row[w] === row[w] ? '1' : '0';
      if (Math.abs(row[w]) > largest) largest = Math.abs(row[w]);
    }
    if (!groups.has(pattern)) groups.set(pattern, []);
    groups.get(pattern).push({row, mean: observed.mean, noSpread: noSpreadBound(largest, windows)});
  }
  if (!groups.size) return {observedMax, argmax, p: 1, resamples, seed};

  // The draws, stored per resample as the distinct windows drawn and how often each was drawn.
  const Index = windows < 256 ? Uint8Array : windows < 65536 ? Uint16Array : Uint32Array;
  const drawnWindow = new Index(resamples * windows), drawnTimes = new Float64Array(resamples * windows);
  const first = new Uint32Array(resamples + 1), times = new Uint32Array(windows), random = mulberry32(seed);
  for (let b = 0, k = 0; b < resamples; b++) {
    times.fill(0);
    for (let draw = 0; draw < windows; draw++) times[Math.floor(random() * windows)]++;
    for (let w = 0; w < windows; w++) if (times[w]) { drawnWindow[k] = w; drawnTimes[k++] = times[w]; }
    first[b + 1] = k;
  }

  const best = new Float64Array(resamples).fill(-Infinity);   // each resample's maximum so far
  const mStar = new Float64Array(resamples), valid = new Float64Array(windows);
  const deviation = new Float64Array(windows), squared = new Float64Array(windows), picked = new Float64Array(windows);
  for (const [pattern, members] of groups) {
    for (let w = 0; w < windows; w++) valid[w] = pattern[w] === '1' ? 1 : 0;
    for (let b = 0; b < resamples; b++) {
      let m = 0;
      for (let k = first[b]; k < first[b + 1]; k++) m += drawnTimes[k] * valid[drawnWindow[k]];
      mStar[b] = m;
    }
    for (const {row, mean, noSpread} of members) {
      for (let w = 0; w < windows; w++) {   // deviations from the full-sample mean; 0 at invalid windows
        const d = valid[w] ? row[w] - mean : 0;
        deviation[w] = d; squared[w] = d * d;
      }
      for (let b = 0; b < resamples; b++) {
        const m = mStar[b];
        if (m < 2) continue;
        let s1 = 0, s2 = 0;
        for (let k = first[b], end = first[b + 1]; k < end; k++) {
          const w = drawnWindow[k], n = drawnTimes[k];
          s1 += n * deviation[w]; s2 += n * squared[w];
        }
        let statistic = fromSums(s1, s2, m, noSpread);
        if (statistic !== statistic) {
          let i = 0;
          for (let k = first[b]; k < first[b + 1]; k++)
            if (valid[drawnWindow[k]]) for (let n = drawnTimes[k]; n > 0; n--) picked[i++] = row[drawnWindow[k]];
          statistic = literal(picked, m, mean);
        }
        if (statistic > best[b]) best[b] = statistic;   // false for NaN: sd* is 0, skipped
      }
    }
  }
  const tolerance = TIE_TOLERANCE * Math.max(1, Math.abs(observedMax));
  let reached = 0;
  for (let b = 0; b < resamples; b++) if (best[b] === -Infinity || best[b] >= observedMax - tolerance) reached++;
  return {observedMax, argmax, p: reached / resamples, resamples, seed};
}

// Confirmation p-value for one nominee (PROTOCOL.md, "Confirmation", as amended). xs: its returns aligned to
// the confirmation windows, NaN where a window is invalid for it.
//
// score is the protocol's T on the n valid windows (t and factor are its two parts, lag1 the autocorrelation
// before the floor at 0). pT = P(Student t with n - 1 degrees of freedom >= score). pResample = share of
// resamples, each n draws with replacement from the n valid values (index floor(u * n) for consecutive u from
// one mulberry32(seed) stream), whose (mean* - mean) / (sd* / sqrt(n)) is at least score; a resample with sd* 0
// counts as reaching it. p = the larger of the two. With fewer than two valid entries or sd 0 the score is 0
// and all three p-values are 1. Whether n is enough (at least 20) and mean > 0 is the caller's rule to apply.
export function confirmationP(xs, {resamples = 10000, seed = 20261118} = {}) {
  checkResampling(resamples, seed);
  const {values, n, mean, sd, t, lag1, factor, score} = describe(xs);
  const result = {n, mean, sd, t, lag1, factor, score, skewness: skewness(values), pT: 1, pResample: 1, p: 1};
  if (sd === 0) return result;
  const deviation = values.map(v => v - mean), squared = deviation.map(d => d * d);
  const noSpread = noSpreadBound(values.reduce((largest, v) => Math.max(largest, Math.abs(v)), 0), n);
  const random = mulberry32(seed), drawn = new Uint32Array(n), star = new Float64Array(n);
  const tolerance = TIE_TOLERANCE * Math.max(1, Math.abs(score));
  let reached = 0;
  for (let b = 0; b < resamples; b++) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(random() * n);
      drawn[i] = j; s1 += deviation[j]; s2 += squared[j];
    }
    let statistic = fromSums(s1, s2, n, noSpread);
    if (statistic !== statistic) {
      for (let i = 0; i < n; i++) star[i] = values[drawn[i]];
      statistic = literal(star, n, mean);
    }
    if (statistic !== statistic || statistic >= score - tolerance) reached++;   // NaN: sd* is 0, which counts
  }
  result.pT = tUpperTail(score, n - 1);
  result.pResample = reached / resamples;
  result.p = Math.max(result.pT, result.pResample);
  return result;
}

// "More than a share of buy-and-hold" for one nominee (PROTOCOL.md, "Confirmation", as amended). r: the nominee's
// returns, b: the comparison account's, both aligned to the same confirmation windows, NaN where a window is
// invalid.
//
// "Fit r = intercept + slope × b by least squares over the nominee's valid confirmation windows": ols(r, b), over
// the n windows valid for both series. pFit is "the fit's one-sided p-value for intercept > 0 (Student's t, n − 2
// degrees of freedom)". adjusted is "the confirmation p-value defined above computed on the series r − slope × b":
// confirmationP of that series, which is NaN wherever r or b is, so adjacency follows the window order. p, "the
// larger of" the two, is max(pFit, adjusted.p).
// When the fit is undefined (fewer than 3 valid pairs, or b without spread), intercept, slope, both standard
// errors and pFit are NaN, adjusted is the confirmation calculation of a series with no valid window, and p is 1.
// Whether n is at least 20, intercept > 0 and p < 0.05 / k (the reading "yes") is the caller's rule to apply.
export function buyAndHoldReading(r, b, {resamples = 10000, seed = 20261118} = {}) {
  const fit = ols(r, b), defined = fit.n >= 3 && fit.slope === fit.slope;
  if (defined && fit.pInterceptGreater !== fit.pInterceptGreater)
    throw new RangeError('buyAndHoldReading: the fit is not finite (the squares of the values overflow)');
  const adjusted = confirmationP(Float64Array.from(r, (v, w) => (defined ? v - fit.slope * b[w] : NaN)), {resamples, seed});
  return {n: fit.n, intercept: defined ? fit.intercept : NaN, slope: defined ? fit.slope : NaN, seIntercept: fit.seIntercept,
    seSlope: fit.seSlope, pFit: fit.pInterceptGreater, adjusted, p: defined ? Math.max(fit.pInterceptGreater, adjusted.p) : 1};
}
