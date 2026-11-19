// Deterministic test markets. Nothing here is market data except sampleMarket(), which reads the bundled sample.
import {readFileSync} from 'node:fs';
import {MINUTE, ASSETS, assertSeries} from './windows.mjs';

// mulberry32: a small seeded generator returning uniform doubles in [0, 1).
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  // price: first close; decimals: tick (BTC cents, LINK 3 decimals, like the real feeds);
  // volatility, drift: per-minute log-return standard deviation and mean;
  // regimeDrift: standard deviation of an extra per-minute drift redrawn every regimeMinutes (trends);
  // jumpRate, jumpSize: chance per minute of a jump and its log-size standard deviation;
  // missing: chance a single minute is absent; gapRate/gapMinutes: chance per minute that a gap of 2..gapMinutes
  // starts; longGapRate/longGapHours: the same for gaps of 1..longGapHours hours.
  BTC: {price: 42000, decimals: 2, volatility: 0.0007, drift: 0, regimeDrift: 0.00004, jumpRate: 0.0008,
    jumpSize: 0.008, missing: 0.01, gapRate: 0.002, gapMinutes: 15, longGapRate: 0.0002, longGapHours: 3},
  LINK: {price: 14.5, decimals: 3, volatility: 0.0011, drift: 0, regimeDrift: 0.00006, jumpRate: 0.0008,
    jumpSize: 0.012, missing: 0.02, gapRate: 0.003, gapMinutes: 15, longGapRate: 0.0002, longGapHours: 3},
};

// options: {seed = 1, start (minute-close ms) = 2021-01-01T00:00Z, minutes = 6000, correlation = 0.6,
// regimeMinutes = 360, BTC: {...}, LINK: {...}} with the per-asset fields documented on DEFAULTS.
// Prices follow one path whether or not a minute is observed; each asset's missing minutes are drawn from its
// own stream, so changing a gap rate does not move the prices.
export function syntheticMarket(options = {}) {
  const {seed = 1, start = Date.UTC(2021, 0, 1), minutes = 6000, correlation = 0.6, regimeMinutes = 360} = options;
  if (!Number.isSafeInteger(start) || start % MINUTE || !Number.isInteger(minutes) || minutes < 1)
    throw new Error('start must be a minute-close timestamp and minutes a positive integer');
  const setup = Object.fromEntries(ASSETS.map(a => [a, {...DEFAULTS[a], ...options[a]}]));
  const path = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - path())) * Math.cos(2 * Math.PI * path());
  const blend = Math.sqrt(1 - correlation * correlation);
  const level = {BTC: Math.log(setup.BTC.price), LINK: Math.log(setup.LINK.price)}, regime = {BTC: 0, LINK: 0};
  const gaps = Object.fromEntries(ASSETS.map((a, i) => [a, {random: mulberry32(seed * 7919 + 104729 * (i + 1)), left: 0}]));
  const rows = {BTC: {time: [], close: []}, LINK: {time: [], close: []}};
  for (let m = 0; m < minutes; m++) {
    const common = normal(), own = normal();
    const shock = {BTC: common, LINK: correlation * common + blend * own};
    for (const a of ASSETS) {
      const c = setup[a];
      if (m % regimeMinutes === 0) regime[a] = c.regimeDrift * normal();
      if (m) level[a] += c.drift + regime[a] + c.volatility * shock[a] + (path() < c.jumpRate ? c.jumpSize * normal() : 0);
      const gap = gaps[a], u = gap.random(), v = gap.random(), w = gap.random();
      if (gap.left === 0) {
        if (u < c.longGapRate) gap.left = 60 + Math.floor(v * 60 * c.longGapHours);
        else if (u < c.longGapRate + c.gapRate) gap.left = 2 + Math.floor(v * (c.gapMinutes - 1));
        else if (w < c.missing) gap.left = 1;
      }
      if (gap.left > 0) { gap.left--; continue; }
      const tick = 10 ** c.decimals;
      rows[a].time.push(start + m * MINUTE);
      rows[a].close.push(Math.max(1, Math.round(Math.exp(level[a]) * tick)) / tick);
    }
  }
  return Object.fromEntries(ASSETS.map(a => [a,
    assertSeries({time: Float64Array.from(rows[a].time), close: Float64Array.from(rows[a].close)}, a)]));
}

// The bundled 30-hour sample: rows are [closeTimeMs, btcClose, linkClose], shared minutes only.
export function sampleMarket() {
  const {prices} = JSON.parse(readFileSync(new URL('../data/sample.json', import.meta.url), 'utf8'));
  return {BTC: assertSeries({time: Float64Array.from(prices, r => r[0]), close: Float64Array.from(prices, r => r[1])}, 'BTC'),
    LINK: assertSeries({time: Float64Array.from(prices, r => r[0]), close: Float64Array.from(prices, r => r[2])}, 'LINK')};
}
