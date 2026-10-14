# Paper Trail — operating rules for agents

This file is the operative layer: it loads into every Claude Code session on this repo, so a rule written here
executes instead of being re-derived. `AGENTS.md` points Codex here. Rationale, provenance and the mapping from
each rule to J's Notion doctrine live in `docs/PRINCIPLES.md`; read that when a rule's reason matters.

**Identity.** This repository is public. Call the operator **J**. Never write a real name, a client's or prospect's
name, an email address, or private personal context into any file, commit, PR, comment or branch name.

## The object (what the work is about)

Two statements, both J's, both current. Keep them separate; do not quietly collapse one into the other.

1. **Technical object:** a paper-trading harness whose every claim is checkable. The measured question is whether
   the seven-minute trend rule calls BTC/LINK direction better than chance on data chosen before anyone looked,
   against a frozen same-price baseline. Passing tests and a profitable replay do not establish a trading edge.
2. **Economic object:** a proof asset. The repo demonstrates that an agent-assisted team can turn an idea into a
   tested, inspectable system. It is not evidence of investment returns. Which of the two objects the next piece of
   work should serve is J's call; when they pull in different directions, say so and stop.

## Invariants (change only with J's explicit ruling, recorded in the PR)

- Simulated cash only. No wallets, exchange keys, order endpoints, real-money paths or paid services, anywhere.
- Long only, no leverage, allocation at most 50% per asset; the two account limits always win over the rule.
- The Python/TypeScript version binds to 127.0.0.1 and is not hosted or exposed until the hardening list in
  `docs/BACKEND_MIGRATION.md` is done. The GitHub Pages app stays on the JavaScript engine until then.
- The JavaScript modules at the root are the parity reference; Python must reproduce their goldens.
- The forecast ledger scores direction with the exact two-sided sign test in `report-card.js`
  (at least 30 decided forecasts, p < 0.025 per asset). A rule with no skill scores 50%.

## Verification (the verifier owns correctness, not the builder)

- Before building, name the answer sheet: the test, golden, oracle or invariant the change is checked against. If
  none exists, build it first. Existing answer sheets: `npm test`, `node --test parity/**/*.test.mjs`, the
  random-walk control in `report-card.test.js`, the oracle in `web/test/oracle.ts`, and `scripts/verify.sh`
  (all of it, including real-Chromium browser tests; CI runs exactly this).
- Run the checks yourself and paste the output in the PR. "CI will tell us" is not verification.
- **Tests are amendable but not unilaterally.** Never skip, disable, loosen or delete a test to get green. If a
  test is wrong, propose the replacement next to the old one in the PR, say what each catches that the other
  misses, and leave both in place until a separate reviewer (preferably a different model or vendor) adjudicates.
- Substantial work gets an independent check before it is called done: a fresh reviewer agent that re-derives the
  result from the source, not one that grades the builder's own summary.
- Decide how a strategy will be judged **before** looking at the data it will be judged on. The pre-registered
  test lives in `docs/EVALUATION_CONTRACT.md`; windows come from `scripts/pick-holdout-windows.mjs`. Do not
  tune settings on a window and then report results from it as evidence.

## Claims and coverage

- Every result carries its evidence grade: **Measured** (rerun and observed), **Self-reported** (an agent's own
  account), or **Inferred**. Unlabelled numbers are not results.
- Coverage is part of the answer. State what was run, on which data and commit, and what was not checked. A
  negative claim is bounded ("no X in the checked Y for window Z"), never "there is no X".
- "Verified" means a disconfirming check was attempted and failed to disconfirm. Otherwise write PARTIAL or
  UNKNOWN. A retrieval that was stopped reads "not established, retrieval incomplete", never "checked and absent".
- Honest results over flattering ones. A rule that loses or shows no skill is reported as such, in the app and in
  the docs. Marketing-grade words (edge, alpha, HFT, guaranteed) do not appear in this repo.

## Workflow

- **Reconstruct, reconcile, resume.** Before proposing work, read `docs/HOW_THIS_WAS_BUILT.md`, the open PRs and
  the current CI state. Treat every "next step" in a doc as a dated claim; verified artifacts outrank status prose.
  Return the delta: what was already done, what changed, the smallest genuinely open next action.
- **Bring J decision surfaces, not chores.** Exhaust retrieval, tests, conservative defaults and reversible
  preparation first. When J's input is needed, state the object, the alternatives, the cost of being wrong, the
  recommendation and the smallest input required. Do not ask whether to take the next routine step.
- **Every PR is a receipt.** Fill in `.github/pull_request_template.md`: object served, what changed, verification
  run with output, coverage gaps, what is deliberately not claimed, J attention consumed, authorization level of any
  rule change, and the controller change (what will be different next time). Add a row to the change history in
  `docs/HOW_THIS_WAS_BUILT.md`.
- **No meta-work without outward yield.** A change to docs, tooling or these rules must name the cost it removes or
  the experiment it enables. If the meta-layer grows faster than measured results, stop and say so.
- **Never silently work around a failure.** A flaky test, a blocked fetch, a tool that could not run: report it in
  the PR as a limitation, do not route around it quietly.

## Boundaries (outside routine work; need J's live approval each time)

Spending, real-money trading, hosting or deployment, outbound messages, security or access changes, publishing
results outside the repo, and changing anything in this Invariants section.
