# How this was built

Paper Trail was built by one operator directing AI coding agents (Claude Code and Codex) over several sessions. This page records who did what, how each change was checked and which mistakes were caught. It also lists what is deliberately not claimed. Every entry links to its evidence so it can be checked, not taken on trust.

**Evidence grades used below:**
- **Measured:** rerun and observed directly.
- **Self-reported:** an agent's own account, not independently rerun.
- **Inferred:** follows from measured facts.

## Operating rules

- **The verifier, not the builder, owns correctness.** Work an agent builds is checked by a different agent or by the operator before it merges: tests rerun, changed tests read for weakened assertions, and results compared against an independent calculation.
- **Every change is a reviewable pull request.** Each PR says what it does, how it was verified and what it does not establish.
- **Honest results over flattering ones.** A rule that loses, or shows no skill, is reported as such.
- **Tests are never skipped, disabled or loosened to get a green check.** When a test is changed, the PR says why.
- **Decide how a strategy will be judged before looking at the data it will be judged on.** See "Not claimed".

## Change history

| PR | Change | Built by | How it was verified |
|---|---|---|---|
| (initial) | $1,000 paper account, replay, live quotes, costs, buy-and-hold benchmark; UTC replay and run history | Agent not recorded in commits | Test suite in repo |
| [#1](https://github.com/QualiaRain/btc-link-paper-trader/pull/1) | Keep imported timing settings | Codex | Regression tests fail on the base and pass after; separate reviewer reran them |
| [#2](https://github.com/QualiaRain/btc-link-paper-trader/pull/2) | Require enough warmup history before a date-range replay | Codex | Regression fails on the base; deterministic sparse fixture; independent review |
| [#3](https://github.com/QualiaRain/btc-link-paper-trader/pull/3) | Stop stale async operations from altering saved snapshots | Codex | Four regressions fail on the base (a snapshot fell from $1,000 to $900); seven ownership cases pass after |
| [#5](https://github.com/QualiaRain/btc-link-paper-trader/pull/5) | Drawdown and daily-loss limits, cheapest-venue fee defaults, optional cash yield | Claude Code | 52 tests; real-browser replays at four cost levels. Retested before merge: 52/52, plus a browser sample replay matching the reported $997.58 |
| [#6](https://github.com/QualiaRain/btc-link-paper-trader/pull/6) | Forecast report card: does the rule call direction better than chance? | Claude Code, with an independent critic agent | 61 tests, including a random-walk control; browser render at desktop and phone width; numbers cross-checked by a separate replay |
| [#7](https://github.com/QualiaRain/btc-link-paper-trader/pull/7) | Faster forecast settling (31-day replay 100 s → 1.5 s) | Claude Code | Full accounts byte-identical before and after on three 31-day runs; two deliberately broken variants fail the new tests |
| [#4](https://github.com/QualiaRain/btc-link-paper-trader/pull/4) | Python backend + TypeScript frontend (requested), run locally with `scripts/run-local.sh` | Claude Code builders; Codex follow-up | Python must match goldens produced by the JavaScript engine; full suite (JS, Python, TypeScript with real Chromium) rerun independently before each push; GitHub CI; fresh-clone rehearsal of the launcher (sample replay matches, saved run survives a restart, unreachable off loopback) |
| [#9](https://github.com/QualiaRain/btc-link-paper-trader/pull/9) | Operating rules for agents (`CLAUDE.md`), their provenance (`docs/PRINCIPLES.md`), a proposed pre-registered held-out test (`docs/EVALUATION_CONTRACT.md`) with a seeded window picker, a PR receipt template, and wording fixes from a read-only audit | Claude Code, with a separate read-only audit agent and a separate reviewer agent | `npm test` (with a pinned-output test for the picker) and the full `scripts/verify.sh` rerun in-session after the changes (Measured); the original reviewer reported four contract issues addressed in the draft; the contract remains proposed and unfrozen |
| [#10](https://github.com/QualiaRain/btc-link-paper-trader/pull/10) | Coverage is part of the answer: sample runs record their coverage block (1,648 of 1,800 minutes, 152 missing, computed from the data, not copied from a README), summaries count observation gaps and invalid frames, and the Run view and History cards in both apps show coverage, fetch receipts and those counts | Claude Code | Goldens regenerated with the repo's own generators and the diff inspected (only coverage/count fields, resulting sample market hashes and regenerated Python fixture timestamps changed); new JS, Python and real-Chromium tests for every field, including the legacy "not recorded" path on the committed browser exports; full `scripts/verify.sh` rerun before pushing |

## Mistakes caught, and how

1. **A biased verdict, caught by an independent critic before merge (#6).**
   - **What happened:** the first report card asked whether the rule's forecast landed closer to the real price than "no change", and assumed a rule with no skill would win half the time. That assumption is false: a forecast that always predicts some move lands closer less than half the time, even with no skill.
   - **How it was caught:** a separate critic agent fed the engine 40 pure random walks, where no rule can have skill. All 80 grades came out "worse".
   - **The fix:** grade the direction call instead; a rule with no skill scores 50% there. A random-walk control test now fails on the old version (`{"worse":40}`) and passes on the new one. The sample verdict changed from "worse than no change" to "no clear skill".
   - Grade: **Measured.**
2. **A value read mid-update.**
   - **What happened:** a browser check read the account value while the page was still drawing ($996.67 against the expected $997.58).
   - **The fix:** re-reading after the page settled gave $997.58, matching the earlier report. Later checks wait for the page to settle.
   - Grade: **Measured.**
3. **A rewrite parked too early.**
   - **What happened:** the Python/TypeScript rewrite (#4) was closed as "no visible benefit" before the operator mentioned that it had been requested.
   - **The fix:** the PR was reopened the same day and nothing was lost. It was brought up to date and its port verified.
   - **The lesson:** ask who a piece of work is for before judging its value.
4. **Legacy-import gaps, tightened by a second agent (#4).**
   - **What happened:** after the Python port, Codex independently reviewed it and narrowed when old saved runs may omit the new summary fields.
   - **The fix:** omission of risk/interest fields is restricted by the legacy config and neutral-state checks.
     Report-card and later coverage counts have no config-era marker; their all-or-none omission rule does not prove
     a record's age. See [Data coverage](BACKEND_MIGRATION.md#data-coverage) for the current compatibility limit.
   - Grade: **Self-reported** by Codex; CI green on that commit (**Measured**).
5. **Coverage reconciliation caught a root-app snapshot regression (#10).**
   - Opening an old snapshot recalculated omitted gap/invalid-frame counts; exporting it silently added those counts.
   - The correction preserves the saved summary for read-only coverage display and the saved record for export.
     New real-Chromium tests exercise the three unchanged legacy fixtures, reload and export, plus a new sample run
     whose recorded zero counts remain zero. The legacy snapshot assertions failed before the correction.
   - Additional failing checks exposed off-minute sample observations producing impossible coverage and incomplete
     imported coverage crashing the TypeScript formatter. Narrow guards reject invalid sample timestamps and render
     unavailable imported counts as "not recorded". Existing assertions and goldens remain intact.
   - Grade: **Measured** for the regression checks; the independent reviewer also compared the changed goldens and
     existing assertions. These checks establish engineering behavior, not predictive skill.

## What the results say

- **Bundled sample, about 30 hours of real Coinbase minute data, default 7-minute trend rule:**
  - The paper account ended at $997.58 (−0.24%) after 34 fills.
  - Buying and holding half BTC and half LINK ended at $1,021.14.
  - Grade: **Measured.**
- **Forecast skill:** direction was called right in 116 of 235 BTC forecasts (49%) and 117 of 221 LINK forecasts (53%). Neither is distinguishable from a coin flip at p < 0.025 with that many forecasts, which can only detect an edge larger than about ±6–7 points. Grade: **Measured.**
- **Costs:** in this sample, the typical 7-minute BTC move is about 3 basis points, while one round trip costs about 14 at the default costs. On moves of that size the rule cannot clear its costs at this horizon whatever its accuracy; whether other periods move more is untested. Grade: **Measured** (independent critic); the conclusion is **Inferred**.

## Not claimed

- **No trading edge.** One 30-hour window proves nothing either way, and repeatedly tuning settings on the same data would overfit them. A test that would mean something is written down in [docs/EVALUATION_CONTRACT.md](EVALUATION_CONTRACT.md): rules and pass criteria fixed in advance, then judged on three 28-day windows chosen by a seeded picker from a value that does not exist yet. It is proposed, not frozen, and has not been run.
- **Paper fills are not real fills.** Replay bid/ask is modeled from candle closes with an assumed spread. Latency, queue position, market impact, taxes and funding are not modeled.
- **Live mode from the cloud is unexercised.** The build environment cannot reach Coinbase, so live polling was tested only with fixtures, not end to end.
- **The Python/TypeScript version is local only.** It has no hosting, authentication or rate limits, listens on 127.0.0.1, and must not be exposed until those are added.
- **No real money, exchange keys or order endpoints exist anywhere in the code.**

## Reproduce

```sh
npm test                        # JavaScript engine, report card, settle, history and settings tests
python3 -m http.server 8080     # then open http://127.0.0.1:8080 and run the included sample
```

For the Python/TypeScript branch, `scripts/verify.sh` runs everything: JS tests, JS-generated goldens, Python parity and API tests, and TypeScript with real-Chromium UI tests.
