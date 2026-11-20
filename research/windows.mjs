// Protocol windows and the setting-independent preparation of one window (research/PROTOCOL.md, "Windows").
// A series is {time: Float64Array, close: Float64Array}: minute-close timestamps in ms (multiples of 60000,
// strictly increasing) and the candle close. A market is {BTC: series, LINK: series}; missing minutes are absent.
export const MINUTE = 60000, DAY = 86400000, ASSETS = ['BTC', 'LINK'];

// minValidDesignWindows: "Eligible: the setting has at least 40 valid design windows" (Measures).
// minValidConfirmationWindows: "Confirmed at default costs: at least 20 valid confirmation windows" (Confirmation).
export const PROTOCOL = Object.freeze({from: Date.parse('2020-01-01T00:00:00Z'), windowDays: 28, windowCount: 74,
  designCount: 50, minSharedFraction: 0.9, minValidDesignWindows: 40, minValidConfirmationWindows: 20});

// Window k covers minute closes from `from + 28k days` (00:00Z) through 23:59Z of its last day.
export function protocolWindows(p = PROTOCOL) {
  const windows = [];
  for (let index = 0; index < p.windowCount; index++) {
    const start = p.from + index * p.windowDays * DAY;
    windows.push({index, start, end: start + p.windowDays * DAY - MINUTE,
      set: index < p.designCount ? 'design' : 'confirmation'});
  }
  return windows;
}

// First index in [lo, hi) of an ascending array whose value is >= value (hi when there is none).
export function lowerBound(sorted, value, lo = 0, hi = sorted.length) {
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (sorted[middle] < value) lo = middle + 1; else hi = middle;
  }
  return lo;
}

// The simulators assume what the app enforces on its own data: minute-close timestamps that strictly increase and
// positive finite closes (so every replay frame is a valid frame for engine.js validFrame). Loaders should call this.
export function assertSeries(series, label = 'series') {
  const {time, close} = series ?? {};
  if (!(time instanceof Float64Array) || !(close instanceof Float64Array) || time.length !== close.length)
    throw new Error(`${label}: expected {time: Float64Array, close: Float64Array} of equal length`);
  for (let i = 0; i < time.length; i++) {
    if (!Number.isSafeInteger(time[i]) || time[i] % MINUTE || (i && time[i] <= time[i - 1]))
      throw new Error(`${label}: times must be strictly increasing minute-close timestamps (row ${i})`);
    if (!(close[i] > 0) || close[i] === Infinity) throw new Error(`${label}: invalid close (row ${i})`);
  }
  return series;
}

// Everything setting-independent about one window. The app refuses a range whose exact boundary minute is
// missing; the protocol instead scores from the first to the last minute observed for BOTH assets, so
// scoreStart/scoreEnd are the first/last shared minute inside [start, end] and the frames are the shared minutes
// between them (replay.js builds frames the same way: BTC rows whose timestamp LINK also has). Reading 2: the
// session ends at scoreEnd, which is earlier than `end` when the nominal last minute is missing for an asset.
// `valid` is the protocol's window rule: at least minSharedFraction of the window's minutes observed for both
// assets (and the two frames any run needs). A window that fails it is invalid for EVERY setting. Under Reading 7
// as amended, such a window "enters none of that setting's counts, means, standard deviations or scores, and it
// keeps its place in the window order": the caller does that, once per window, on this flag. The simulators compute
// no statistic and run whatever window they are given as long as it has two frames, so a caller that looked only at
// a run's own `valid` would count a low-coverage window.
export function prepareWindow(market, {start, end}, p = PROTOCOL) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start % MINUTE || end % MINUTE || end < start)
    throw new Error('Window endpoints must be minute-close timestamps with end >= start');
  const btc = market.BTC, link = market.LINK;
  let i = lowerBound(btc.time, start), j = lowerBound(link.time, start);
  const iEnd = lowerBound(btc.time, end + 1, i), jEnd = lowerBound(link.time, end + 1, j);
  const observed = {BTC: iEnd - i, LINK: jEnd - j}, room = Math.min(observed.BTC, observed.LINK);
  const times = new Float64Array(room), index = {BTC: new Int32Array(room), LINK: new Int32Array(room)};
  const close = {BTC: new Float64Array(room), LINK: new Float64Array(room)};
  let shared = 0;
  while (i < iEnd && j < jEnd) {
    const a = btc.time[i], b = link.time[j];
    if (a < b) i++;
    else if (b < a) j++;
    else {
      times[shared] = a; index.BTC[shared] = i; index.LINK[shared] = j;
      close.BTC[shared] = btc.close[i++]; close.LINK[shared] = link.close[j++]; shared++;
    }
  }
  const expected = (end - start) / MINUTE + 1, sharedFraction = shared / expected;
  const invalidReason = shared < 2 ? 'fewer than 2 shared minutes'
    : sharedFraction < p.minSharedFraction ? 'insufficient shared coverage' : null;
  return {start, end, expected, observed, shared, sharedFraction,
    scoreStart: shared ? times[0] : null, scoreEnd: shared ? times[shared - 1] : null,
    // Per scored frame: its time, each asset's row in its own series, and each asset's close (the quote mid).
    times: times.subarray(0, shared),
    index: {BTC: index.BTC.subarray(0, shared), LINK: index.LINK.subarray(0, shared)},
    close: {BTC: close.BTC.subarray(0, shared), LINK: close.LINK.subarray(0, shared)},
    valid: invalidReason === null, invalidReason};
}
