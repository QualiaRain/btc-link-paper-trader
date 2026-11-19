// The settings searched (research/PROTOCOL.md, "Settings searched"), enumerated exactly as the table lists them.
// Every setting is a plain frozen object that research/fastsim.mjs simulate() accepts as it is, plus
//   id      a stable name built from the setting's values, e.g. "P-h7-l7-b10-s0" or "L-h60-span240-b0-s0-hold1"
//   family  "P" | "H" | "R" | "X" | "L"
//   grid    its position on the family's own axes (indices into AXES[family]), used for the neighbour rule.
// Nothing here trades or reads market data.
import {MINUTE} from './windows.mjs';

export const FAMILIES = Object.freeze(['P', 'H', 'R', 'X', 'L']);
// The counts in the protocol table. familySettings() refuses to return a grid of any other size.
export const FAMILY_SIZE = Object.freeze({P: 3360, H: 3360, R: 3360, X: 1920, L: 720});

// Every horizon the app accepts (configuration.js HORIZONS), in minutes.
export const HORIZON_MINUTES = Object.freeze([1, 5, 7, 15, 60, 420, 1440]);
const LOOKBACKS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const BUFFERS = [0, 5, 10, 20, 40, 80, 160, 320];
const STOPS = [0, 100, 300, 1000];
const lookbackAxes = horizonMinutes => ({horizonMinutes, lookback: LOOKBACKS, bufferBps: BUFFERS, stopLossBps: STOPS});

// Family X: the table says "horizons up to 60 minutes" and 1,920 settings. 1,920 = 4 x 15 x 8 x 4, so the count
// (on which the protocol's total of 12,720 rests) fixes FOUR horizons; "up to 60 minutes" is therefore read as
// below 60 minutes: 1, 5, 7 and 15. Including 60 would give 2,400 settings. Reported as an ambiguity.
export const AXES = Object.freeze({
  P: lookbackAxes(HORIZON_MINUTES),
  H: lookbackAxes(HORIZON_MINUTES),
  R: lookbackAxes(HORIZON_MINUTES),
  X: lookbackAxes([1, 5, 7, 15]),
  // 4h, 8h, 12h, 1d, 2d, 3d, 5d, 7d, 14d, 28d, in minutes.
  L: {spanMinutes: [240, 480, 720, 1440, 2880, 4320, 7200, 10080, 20160, 40320], horizonMinutes: [60, 420, 1440],
    bufferBps: [0, 20, 80, 320], stopLossBps: [0, 300, 1000], holdThrough: [false, true]},
});

const SWITCHES = {
  P: {holdThrough: false, reversal: false, btcLed: false},
  H: {holdThrough: true, reversal: false, btcLed: false},
  R: {holdThrough: false, reversal: true, btcLed: false},
  X: {holdThrough: false, reversal: false, btcLed: true},
};

// The family's grid in the table's order: for P, H, R and X horizon x lookback x buffer x stop (stop varies
// fastest); for L span x horizon x buffer x stop x hold-through.
export function familySettings(family) {
  const axes = AXES[family], settings = [];
  if (!axes) throw new Error(`Unknown family: ${family}`);
  const add = setting => settings.push(Object.freeze({...setting, grid: Object.freeze(setting.grid)}));
  if (family === 'L') {
    axes.spanMinutes.forEach((spanMinutes, span) => axes.horizonMinutes.forEach((horizonMinutes, horizon) =>
      axes.bufferBps.forEach((bufferBps, buffer) => axes.stopLossBps.forEach((stopLossBps, stop) =>
        axes.holdThrough.forEach((holdThrough, hold) => add({
          id: `L-h${horizonMinutes}-span${spanMinutes}-b${bufferBps}-s${stopLossBps}-hold${hold}`, family,
          horizonMs: horizonMinutes * MINUTE, spanMs: spanMinutes * MINUTE, bufferBps, stopLossBps,
          holdThrough, reversal: false, btcLed: false, grid: {horizon, span, buffer, stop, hold}}))))));
  } else {
    axes.horizonMinutes.forEach((horizonMinutes, horizon) => axes.lookback.forEach((lookback, lookbackAt) =>
      axes.bufferBps.forEach((bufferBps, buffer) => axes.stopLossBps.forEach((stopLossBps, stop) => add({
        id: `${family}-h${horizonMinutes}-l${lookback}-b${bufferBps}-s${stopLossBps}`, family,
        horizonMs: horizonMinutes * MINUTE, lookback, bufferBps, stopLossBps, ...SWITCHES[family],
        grid: {horizon, lookback: lookbackAt, buffer, stop}})))));
  }
  if (settings.length !== FAMILY_SIZE[family] || new Set(settings.map(s => s.id)).size !== settings.length)
    throw new Error(`Family ${family}: ${settings.length} settings enumerated, the protocol table says ${FAMILY_SIZE[family]}`);
  return settings;
}

// All five families in the order P, H, R, X, L: 12,720 settings.
export function allSettings() {
  const settings = FAMILIES.flatMap(familySettings);
  if (settings.length !== 12720) throw new Error(`${settings.length} settings enumerated, the protocol says 12,720`);
  return settings;
}

// The protocol's neighbours of a setting among `all`: "one grid step either way in lookback and in buffer; same
// horizon, stop and switches". Read as the up-to-four settings that differ by exactly one step on the lookback
// axis (the span axis for family L) or by exactly one step on the buffer axis, everything else equal. A setting
// one step away on both axes is two steps away and is not a neighbour. Settings on the border of the grid, or
// whose neighbours are missing from `all`, have fewer. Returned in the order of `all`.
export function neighbours(setting, all) {
  const axis = setting.family === 'L' ? 'span' : 'lookback';
  if (!Number.isInteger(setting.grid?.[axis]) || !Number.isInteger(setting.grid.buffer))
    throw new Error('neighbours() needs a setting from familySettings()');
  return all.filter(other => other.family === setting.family && other.horizonMs === setting.horizonMs &&
    other.stopLossBps === setting.stopLossBps && other.holdThrough === setting.holdThrough &&
    other.reversal === setting.reversal && other.btcLed === setting.btcLed &&
    Math.abs(other.grid[axis] - setting.grid[axis]) + Math.abs(other.grid.buffer - setting.grid.buffer) === 1);
}

// "The default setting (seven-minute horizon, seven lookback, 10 bps buffer, no stop)": the engine's own defaults
// (engine.js `defaults`: horizonMs 420000, lookbackIntervals 7, bufferBps 10, stopLossBps 0) and a member of
// family P's grid.
export const DEFAULT_SETTING = familySettings('P').find(s => s.id === 'P-h7-l7-b10-s0');

// The protocol's costs: the default (about 14 bps per round trip), the cost-robustness rerun at feeBps 10 (about
// 30 bps) and the reported rerun at feeBps 40. Slippage and the assumed half-spread stay at 2 and 3 bps. feeBps 2
// and slippageBps 2 are the engine's defaults; 3 bps is the app's default assumed half-spread for a replay
// (configuration.js: `replay.halfSpreadBps ?? 3`). The engine charges the fee and slippage on each side and
// replay.js puts bid and ask one half-spread either side of the close, hence 2 x (2 + 2 + 3) = 14 bps.
export const COSTS = Object.freeze({
  default: Object.freeze({feeBps: 2, slippageBps: 2, halfSpreadBps: 3}),
  fee10: Object.freeze({feeBps: 10, slippageBps: 2, halfSpreadBps: 3}),
  fee40: Object.freeze({feeBps: 40, slippageBps: 2, halfSpreadBps: 3}),
});
