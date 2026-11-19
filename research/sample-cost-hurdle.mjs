#!/usr/bin/env node
// Descriptive only, on the bundled 30-hour sample (data/sample.json), which every earlier report in this
// repository has already looked at. For each horizon the app supports: how large a typical price move over that
// horizon is, against the modeled cost of one round trip, and the direction accuracy a rule would need for a
// one-horizon long position to break even.
//
//   node research/sample-cost-hurdle.mjs
//
// It reads no other data, fetches nothing and simulates no account. It is not part of the exploration protocol
// (research/PROTOCOL.md) and selects nothing; the study reports the same hurdle on its own data.
//
// Break-even accuracy: if a position gains the mean absolute move when the direction call is right and loses it
// when wrong, and pays the round trip either way, the expected gain is (2p - 1) x move - cost, which is zero at
// p = 0.5 + cost / (2 x move). Above 100% no accuracy is enough. This ignores that right and wrong calls can
// differ in size, so it is a yardstick, not a result.
import {readFileSync} from 'node:fs';

const MINUTE = 60000;
const HORIZON_MINUTES = [1, 5, 7, 15, 60, 420, 1440];           // configuration.js HORIZONS
const COSTS = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};     // the app's defaults (README: about 0.14% a round trip)

const sample = JSON.parse(readFileSync(new URL('../data/sample.json', import.meta.url), 'utf8'));
const rows = sample.prices;                                      // [closeTimeMs, BTC close, LINK close], shared minutes only
const indexOf = new Map(rows.map((row, i) => [row[0], i]));

// The engine buys at ask x (1 + slippage) and sells at bid x (1 - slippage), a fee on each side.
const fraction = bps => bps / 1e4;
const kept = (1 - fraction(COSTS.halfSpreadBps)) * (1 - fraction(COSTS.slippageBps)) * (1 - fraction(COSTS.feeBps));
const paid = (1 + fraction(COSTS.halfSpreadBps)) * (1 + fraction(COSTS.slippageBps)) * (1 + fraction(COSTS.feeBps));
const roundTripBps = -Math.log(kept / paid) * 1e4;

const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const median = xs => {
  const sorted = [...xs].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const breakEven = moveBps => {
  const p = 0.5 + roundTripBps / (2 * moveBps);
  return p > 1 ? 'none (above 100%)' : `${(100 * p).toFixed(1)}%`;
};

const spanMinutes = (rows.at(-1)[0] - rows[0][0]) / MINUTE;
console.log(`Bundled sample: ${rows.length} shared minutes, ${new Date(rows[0][0]).toISOString()} to ${new Date(rows.at(-1)[0]).toISOString()}`);
console.log(`Modeled round trip at the default costs: ${roundTripBps.toFixed(2)} basis points`);
console.log('');
console.log('| Horizon | Whole horizons in the sample | BTC median move | BTC mean move | BTC break-even accuracy | LINK median move | LINK mean move | LINK break-even accuracy |');
console.log('|---|---|---|---|---|---|---|---|');
for (const horizon of HORIZON_MINUTES) {
  const btc = [], link = [];
  for (const [time, btcClose, linkClose] of rows) {
    const later = indexOf.get(time + horizon * MINUTE);
    if (later === undefined) continue;                           // a missing minute is never filled
    btc.push(Math.abs(Math.log(rows[later][1] / btcClose)) * 1e4);
    link.push(Math.abs(Math.log(rows[later][2] / linkClose)) * 1e4);
  }
  const bps = x => `${x.toFixed(1)} bps`;
  console.log(`| ${horizon} min | ${Math.floor(spanMinutes / horizon)} | ${bps(median(btc))} | ${bps(mean(btc))} | ${breakEven(mean(btc))} | ` +
    `${bps(median(link))} | ${bps(mean(link))} | ${breakEven(mean(link))} |`);
}
console.log('');
console.log('Moves are absolute log changes of the close over the horizon, from every minute whose later minute exists.');
console.log('The 420 and 1440 minute rows rest on 4 and 1 whole horizons: they say almost nothing.');
