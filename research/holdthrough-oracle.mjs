// Independent oracle for the hypothetical hold-through rule change (research/PROTOCOL.md, family H). It exists so
// that a fast simulator can be checked against something that is not itself. Family L uses the same rule when its
// switch is on, but L's long-lookback forecast is a different change and is not part of this file.
//
// Nothing of the engine is reimplemented here. ../engine.js is read as text, exactly one branch of ingest() - the
// scheduled decision - is swapped for the hold-through version below, and the patched text is imported as a module
// of its own. Fills, stop losses, forecast settlement, account limits, the completion frame, equity marks and the
// summary remain the engine's own code.
//
// Research instrument only: simulated cash, no orders, and nothing here is wired into the app.

import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';

const ENGINE = new URL('../engine.js', import.meta.url);

// The scheduled-decision branch of ingest() in the reference engine, verbatim. The patch applies only when this
// text occurs exactly once. If engine.js changes here, the hold-through branch has to be re-derived from the new
// source; it must never be patched over something else.
const SCHEDULED = "  } else if (a.lastDecisionAt===null||frame.time-a.lastDecisionAt>=a.config.horizonMs) {";
const DECIDED = "    a.lastDecisionAt=frame.time;\n  }";
const ENGINE_BRANCH = [
  SCHEDULED,
  "    close(a,frame,'auto');",
  "    const budget=a.cash*a.config.allocationFraction;",
  "    for (const asset of ASSETS) {",
  "      if (stopped.has(asset)) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Stop loss: no same-frame reentry'});continue;}",
  "      const pred=prediction(a,asset,frame);",
  "      if (!pred) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Insufficient, stale or conflicting completed history'});continue;}",
  "      const targetAt=frame.time+a.config.horizonMs;",
  "      if (targetAt>a.endsAt) {event(a,'decision_skipped',frame.time,{actor:'auto',asset,reason:'Horizon extends past session end'});continue;}",
  "      const f={id:`f${a.forecasts.length+1}`,asset,model:a.config.model,issuedAt:frame.time,",
  "        issueAt:iso(frame.time),targetAt,targetTime:iso(targetAt),...pred,status:'pending',",
  "        observedAt:null,actual:null,latenessMs:null};",
  "      a.forecasts.push(f);",
  "      const p=prices(a,frame.quotes[asset]);",
  "      // Forecast applies to mid. Assume current bid/mid ratio at the future exit,",
  "      // retaining spread, both slippage charges and both fees in the hurdle.",
  "      const expectedNetRatio=(pred.prediction/pred.anchor)*(p.sell/p.buy)*(1-p.fee)/(1+p.fee);",
  "      const buy=expectedNetRatio>1+a.config.bufferBps/10000;",
  "      // A halted decision still records what the rule would have done.",
  "      event(a,'decision',frame.time,{actor:'auto',asset,forecastId:f.id,action:buy&&!blockedBy?'buy':'cash',",
  "        expectedNetRatio,requiredNetRatio:1+a.config.bufferBps/10000,...(blockedBy?{blockedBy,wouldBuy:buy}:{})});",
  "      if (buy&&!blockedBy) fill(a,a,asset,'buy',budget,frame,'auto');",
  "    }",
  DECIDED,
].join('\n');

// The hold-through decision, as the protocol defines it:
//
//   "At a scheduled decision compute each asset's forecast and buy test exactly as the engine does. Let E be the
//   account's net liquidation value at that frame before any trade. First sell every held asset whose test says
//   cash. Then, in the order BTC, LINK: a held asset whose test says buy is left untouched; an unheld asset whose
//   test says buy is bought with min(allocationFraction × E, available cash). Stop losses, the "no same-frame
//   reentry" rule and the final close are unchanged. A decision the engine skips (insufficient history, or a
//   horizon extending past the session end) sells that asset if held, which is the position the engine would be
//   in."
//
// This function is moved into the engine module by its source text (see HOLD_THROUGH_BRANCH) and runs there in
// place of the engine's branch. It must therefore stay self-contained: everything it uses from the engine arrives
// through `engine`, and it must not refer to anything else in this file.
function holdThroughDecision(engine, a, frame, stopped, blockedBy) {
  const {ASSETS, iso, event, prices, fill, liquidation, prediction} = engine;

  // The engine sells everything and budgets from the cash that results:
  //   close(a,frame,'auto'); const budget=a.cash*a.config.allocationFraction;
  // Here nothing has been sold yet, so the budget comes from E: the engine's own net liquidation value (cash plus
  // each position at its bid less slippage and exit fee), read before any trade of this decision. This frame's
  // stop losses and account limits have already run, as they have in the engine.
  // E is the cash the engine's close() would leave, computed another way: with nothing held it is the same
  // double, with a position open and a fee it can differ in the last bit.
  const E = liquidation(a, a, frame);
  const budget = a.config.allocationFraction * E;

  // 1. Each asset's outcome, BTC then LINK: the engine's three skip rules in the engine's order, then its forecast
  //    record and its buy test. Forecasts are recorded now, so their ids and order are the engine's. Nothing is
  //    traded or written to the ledger yet, because the sells need both outcomes.
  const outcomes = ASSETS.map(asset => {
    const held = a.positions[asset].qty > 0;
    if (stopped.has(asset)) return {asset, held, skipped: 'Stop loss: no same-frame reentry'};
    const pred = prediction(a, asset, frame);
    if (!pred) return {asset, held, skipped: 'Insufficient, stale or conflicting completed history'};
    const targetAt = frame.time + a.config.horizonMs;
    if (targetAt > a.endsAt) return {asset, held, skipped: 'Horizon extends past session end'};
    const f = {id: `f${a.forecasts.length + 1}`, asset, model: a.config.model, issuedAt: frame.time,
      issueAt: iso(frame.time), targetAt, targetTime: iso(targetAt), ...pred, status: 'pending',
      observedAt: null, actual: null, latenessMs: null};
    a.forecasts.push(f);
    const p = prices(a, frame.quotes[asset]);
    // The engine's hurdle: the forecast ratio net of the spread, both slippage charges and both fees.
    const expectedNetRatio = (pred.prediction / pred.anchor) * (p.sell / p.buy) * (1 - p.fee) / (1 + p.fee);
    const buy = expectedNetRatio > 1 + a.config.bufferBps / 10000;
    // The engine acts on buy&&!blockedBy: while an account limit blocks entries, the outcome is cash.
    return {asset, held, forecastId: f.id, expectedNetRatio, buy, saysBuy: buy && !blockedBy};
  });

  // 2. "First sell every held asset whose test says cash", and every held asset whose decision is skipped. Each
  //    sale is the fill the engine's close() makes (desired proceeds Number.MAX_VALUE; no trade when nothing is
  //    held), so an asset that is not kept ends up exactly where the engine leaves it.
  for (const o of outcomes) if (!o.saysBuy) fill(a, a, o.asset, 'sell', Number.MAX_VALUE, frame, 'auto');

  // 3. "Then, in the order BTC, LINK": the ledger entry the engine writes for the asset, followed by its buy if it
  //    is not held. The entries come after the sells, as they come after close() in the engine, so whenever no
  //    position is kept the ledger is the engine's own, entry for entry.
  for (const o of outcomes) {
    if (o.skipped) {
      event(a, 'decision_skipped', frame.time, {actor: 'auto', asset: o.asset, reason: o.skipped});
      continue;
    }
    // "buy": a buy fill is attempted. "hold": a held asset is kept, untouched. "cash": everything else.
    const action = !o.saysBuy ? 'cash' : o.held ? 'hold' : 'buy';
    event(a, 'decision', frame.time, {actor: 'auto', asset: o.asset, forecastId: o.forecastId, action,
      expectedNetRatio: o.expectedNetRatio, requiredNetRatio: 1 + a.config.bufferBps / 10000,
      ...(blockedBy ? {blockedBy, wouldBuy: o.buy} : {})});
    // min(allocationFraction x E, available cash): the engine's fill caps a buy at the cash on hand.
    if (action === 'buy') fill(a, a, o.asset, 'buy', budget, frame, 'auto');
  }
}

// The replacement branch: the engine's own schedule test and decision stamp, with the hold-through decision in
// between, handed the engine internals it needs.
const HOLD_THROUGH_BRANCH = [
  SCHEDULED,
  `    (${holdThroughDecision})({ASSETS,iso,event,prices,fill,liquidation,prediction},a,frame,stopped,blockedBy);`,
  DECIDED,
].join('\n');

// The engine's source text with the scheduled-decision branch replaced by the hold-through branch.
export function holdThroughEngineSource(engineSource) {
  const around = engineSource.split(ENGINE_BRANCH);
  if (around.length !== 2) {
    throw new Error(`holdthrough-oracle: expected the engine's scheduled-decision branch exactly once in ` +
      `engine.js, found it ${around.length - 1} times. engine.js has changed: re-derive the hold-through branch ` +
      'from the new source; do not patch around it.');
  }
  return around.join(HOLD_THROUGH_BRANCH);
}

// The patched engine, with the engine's own signatures: createAccount(config), ingest(account, frame) and
// getSummary(account). Accounts, frames, ledger entries and summaries have the engine's shapes; the only new
// vocabulary is the decision action "hold".
export async function loadHoldThroughEngine() {
  const patched = holdThroughEngineSource(await readFile(ENGINE, 'utf8'));
  // Imported from memory: engine.js imports nothing, and repeated calls resolve to the same module. The
  // sourceURL comment only names the module in stack traces.
  const {createAccount, ingest, getSummary} = await import('data:text/javascript;base64,' +
    Buffer.from(`${patched}\n//# sourceURL=engine.holdthrough.js\n`).toString('base64'));
  return {createAccount, ingest, getSummary};
}
