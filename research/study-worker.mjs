// Units of work of research/study.mjs. The same functions run in this thread (workers: 0) or in worker threads,
// so the number of workers cannot change a result. Simulated cash only.
import {isMainThread, parentPort, workerData} from 'node:worker_threads';
import {ASSETS, prepareWindow} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine} from './engine-run.mjs';
import {loadHoldThroughEngine} from './holdthrough-oracle.mjs';

// DESIGN GRID: one design window, every setting, default costs. A window below the protocol's coverage floor is
// invalid for every setting (PROTOCOL.md Reading 7: "dropped for every setting before any statistic is
// computed": it is never simulated); a setting the app would refuse for lack of causal warmup is invalid for that
// window. Both are returned as NaN. The window's label is checked here as well as in runDesignGrid: a window that
// is not a design window is refused before any price is read.
export function gridTask(context, {window}) {
  if (window.set !== 'design') throw new Error(`The design grid was handed window ${window.index} (${window.set}); design windows only`);
  const {market, settings, costs, protocol} = context;
  const prepared = prepareWindow(market, window, protocol);
  const returns = new Float64Array(settings.length).fill(NaN), fills = new Int32Array(settings.length);
  let refused = 0;
  if (prepared.valid) {
    const results = simulateGrid(market, prepared, settings, costs);
    for (let i = 0; i < results.length; i++) {
      if (results[i].valid) { returns[i] = results[i].returnPct; fills[i] = results[i].fills; }
      else refused++;
    }
  }
  // What this thread could see at all: the last close of the market it was given (the audit in exploration.json).
  const lastVisibleClose = Math.max(...ASSETS.map(asset => market[asset].time.at(-1) ?? -Infinity));
  return {index: window.index, valid: prepared.valid, invalidReason: prepared.invalidReason, refused, returns, fills,
    lastVisibleClose};
}

// The engine a hold-through setting is rerun on, loaded once per thread and only when one is needed: "the same
// engine with only its scheduled-decision branch replaced" (PROTOCOL.md, Simulation).
let holdThroughEngine = null;

// ENGINE CHECK: one window of one nominee through the fast simulator and through an engine (PROTOCOL.md,
// Simulation: "families P, R, X and L through the unmodified engine (R, X and L by feeding it the history their
// rule reads), hold-through nominees through research/holdthrough-oracle.mjs"). research/engine-run.mjs builds
// the frames for both engines; the oracle is passed for hold-through settings only. Compared by the caller.
export async function engineTask(context, {window, setting, costs, detail = false}) {
  const prepared = prepareWindow(context.market, window, context.protocol);
  if (!prepared.valid) return {index: window.index, windowValid: false};
  const engine = setting.holdThrough ? (holdThroughEngine ??= await loadHoldThroughEngine()) : undefined;
  const pick = r => r.valid ? {valid: true, finalValue: r.finalValue, returnPct: r.returnPct, fills: r.fills}
    : {valid: false, invalidReason: r.invalidReason};
  return {index: window.index, windowValid: true, fast: pick(simulate(context.market, prepared, setting, costs, {detail})),
    engine: pick(runEngine(context.market, prepared, setting, costs, {engine}))};
}

// A grid task returns its result, an engine task a promise of it.
export function runTask(context, task) {
  if (task.kind === 'grid') return gridTask(context, task);
  if (task.kind === 'engine') return engineTask(context, task);
  throw new Error(`Unknown task kind: ${task.kind}`);
}

// In a worker thread started by research/study.mjs: workerData is the context (the market arrays are views on
// SharedArrayBuffers), each message is one task, each reply its result or the error that stopped it. The first
// message out says that this thread has loaded its modules; the pool does not terminate a thread before that.
if (!isMainThread && workerData?.role === 'study-worker') {
  parentPort.on('message', async ({id, task}) => {
    try { parentPort.postMessage({id, result: await runTask(workerData, task)}); }
    catch (error) { parentPort.postMessage({id, error: String(error?.stack ?? error)}); }
  });
  parentPort.postMessage({ready: true});
}
