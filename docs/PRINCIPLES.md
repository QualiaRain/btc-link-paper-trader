# Principles: how this repo aligns with J's doctrine, and where each rule executes

`CLAUDE.md` holds the rules. This page records where each rule comes from, where in the repository it is enforced
rather than merely written down, and what is still only prose. Sources are pages in J's Notion workspace, cited by
title so they can be found by search; no private content is copied here.

**Sources (titles in J's Notion):**
- *AI Reliability Doctrine — engineered correctness, coverage, and verification*
- *Personal AI Philosophy — sovereignty, truth, cognitive extension, and the moat*
- *Custody of the Object — recursive AI, the single-integrator hypothesis, and the "God loop" (working theory)*
- *Self-Reinforcing Agentic Economic Loop — governing architecture (ratified 2026-08-12)*
- *Building with Claude — working principles*
- *Money-making skill — portable Claude Code copy* (the `earn-money-agentically` workflow)
- The project operating checkpoint for this repo, recorded 2026-10-12 on the source row *How to Use Jev to Build
  a 24/7 HFT Trading System*

Authorization level of this page: agent synthesis (Claude Code, 2026-10-14) of rules J has already ratified or
stated, applied to this repository. It promotes nothing new to doctrine. Where a rule here is stricter than the
source, the source wins.

## The three layers (from the God-loop working theory)

The working theory says a self-improving system needs a stable invariant layer, a highly revisable operational
layer, and a source of resistance outside the current narrative. Without invariants, "improvement" loses its
referent; without revisability, it cannot adapt; without external resistance, it can become perfectly coherent and
wrong. Mapped onto this repo:

| Layer | What it is here | Changed by |
|---|---|---|
| Invariant | The Invariants section of `CLAUDE.md`: simulated cash only, long only, limits always win, local-only backend, JS as parity reference, the sign-test report card | J's explicit ruling, recorded in the PR |
| Operational | Settings, rules, UI, backend internals, docs, this page | Ordinary PRs with receipts |
| Resistance | `npm test`, parity goldens produced by the JS and consumed by Python, the random-walk control, the real-Chromium oracle, CI, and the held-out windows of `docs/EVALUATION_CONTRACT.md` | Only by the "tests are amendable but not unilaterally" procedure |

The step the theory calls "export the candidate to resistance" is, for this project, the evaluation contract: the
rule is a concrete candidate, and the held-out windows are the most opinion-resistant artifact available.

## Rule-by-rule mapping

| Rule in `CLAUDE.md` | Source | Where it executes | Status |
|---|---|---|---|
| Two objects, kept separate | Custody of the Object ("maintain the object separately from the current wording"); Economic Loop (J supplies the object and the criterion) | `CLAUDE.md` loads every session | Documented; J adjudicates when they conflict |
| Invariants need J's ruling | Economic Loop guardrail 5 (no silent strategy promotion); Personal AI Philosophy (change control) | PR template "Rule changes" section asks for the authorization level | Documented and prompted; not machine-enforced |
| Name the answer sheet first | Building with Claude §2 ("the verifier is the whole game") | Existing tests, goldens, oracle; `scripts/verify.sh`; CI | Enforced by CI for code; by review for docs |
| Verifier independent of builder | Reliability Doctrine §5; Building with Claude "routine accountability" | Random-walk control (`report-card.test.js`); goldens written by JS, read by Python (`parity/`); oracle built on root modules (`web/test/oracle.ts`) | Enforced by tests |
| Tests amendable, not unilaterally | Building with Claude (J, live 2026-08-08) | `CLAUDE.md`; PR template | Documented; depends on reviewer discipline |
| Decide the judgement before looking | Reliability Doctrine; project checkpoint ("freeze the evaluation contract before inspecting held-out outcomes"); repo rule 5 | `docs/EVALUATION_CONTRACT.md`; `scripts/pick-holdout-windows.mjs` with a pinned test | Contract proposed, not frozen; picker enforced by test |
| Evidence grades on every result | `docs/HOW_THIS_WAS_BUILT.md` (existing practice); Reliability Doctrine §7 | PR template "Verification" | Documented and prompted |
| Coverage is part of the answer; no unbounded absence | Reliability Doctrine §6 and "false negatives are not symmetric"; Building with Claude ("not established, retrieval incomplete") | Date-range replay records per-asset expected/observed/missing minutes and receipts (`replay.js`, `candles.py`); summary reports expired forecasts | Partly enforced in code; known gaps listed below |
| "Verified" needs a disconfirming attempt | Reliability Doctrine, proportionate factual disconfirmation (adopted 2026-09-02) | PR template; reviewer agent | Documented |
| Honest results over flattering ones | `docs/HOW_THIS_WAS_BUILT.md` operating rules; Personal AI Philosophy (truth over agreement) | Report card wording ("No clear skill"), "Not claimed" section | Enforced by the random-walk control for the verdict; by review for prose |
| Reconstruct, reconcile, resume | Building with Claude, J directive 2026-08-24 | `CLAUDE.md`; change history table | Documented |
| Decision surfaces, not chores | Economic Loop, function 4 and guardrail 8 | `CLAUDE.md` | Documented |
| Every PR is a receipt | Economic Loop guardrail 10 and Loop v0 minimum instrumentation | `.github/pull_request_template.md` (auto-arrives on every PR) | Enforced by template; content by review |
| No meta-work without outward yield | Economic Loop guardrail 7 | PR template "Controller change" | Documented |
| Never silently work around a failure | Building with Claude (failure-reporting rule) | PR template "Coverage and limitations" | Documented |
| Identity: J only, no names | Building with Claude, J directive 2026-08-22 | `CLAUDE.md` | Documented; reviewers check |
| Boundaries | Project checkpoint "consequential boundaries"; Economic Loop operating modes | `CLAUDE.md` | Documented; the code has no real-money path to misuse |

"Enforced" means a test or CI fails when the rule is broken. "Documented" means the rule loads into the session and
the PR template asks about it, which is the assimilation standard the Economic Loop sets (a lesson counts only when
it lands where it executes or auto-arrives), but a determined agent could still ignore it. That gap is accepted for
now; the next step would be a CI check that the PR body's sections are filled, if receipts turn out to go missing.

## The economic object (from the Economic Loop and the money-making skill)

The governing architecture judges candidate strategies by how well they close a loop: sensing, compression,
selection, J's maximum-leverage cut, downstream execution, verification and transaction, assimilation. This repo
is one candidate instantiation, not the strategy. Its roles:

- **Proof asset.** What it can honestly show a prospective buyer: an idea turned into a tested, inspectable system
  by an operator directing agents, with every claim graded and the mistakes caught on record
  (`docs/HOW_THIS_WAS_BUILT.md`). What it cannot show: investment returns, a trading edge, or production hosting.
- **Receipts.** Each PR is a circuit receipt. The change history table is the ledger of what was built, by whom,
  and how it was checked. A commercial outcome record (payer, scope, acceptance test, fee, state) belongs in J's
  private system, never in this public repo.
- **Money's two roles** apply here as they do everywhere in the doctrine: payment would be external proof that the
  capability is worth something to someone, and a resource for the next circuit. Until a buyer-confirmed problem,
  acceptance test and fee exist, more features are speculative; the money-making skill's rule is to validate one
  paid workflow problem before building for it.
- **Satisfaction, not pleasure.** Work on this repo is sustainable when it produces agency, legibility, closure and
  leverage. A frozen contract with a clear pass/fail is closure; an endless settings sweep is not.

### Where the two objects pull apart

The technical object wants the held-out test run next. The economic object wants no further build until a buyer
names a problem. These do not conflict today: freezing and running the contract costs no client-specific work and
produces a receipt either way. They would conflict if someone proposed new strategy features "to make the demo
better". That is J's call; agents should surface it, not decide it.

## Known gaps between the doctrine and the code (found 2026-10-14, not fixed in the alignment PR)

Found by a read-only audit agent; each is a candidate follow-up, listed here so it is not re-derived.

1. **Sample runs record no coverage block.** The 1,648-of-1,800 shared minutes fact for the bundled sample lives only
   in `data/README.md`; a sample run's record and summary carry no missing-minute count (`app.js`, sample dataset
   construction). Range runs do record it.
2. **The root app does not display range coverage.** Missing, observed and expected minute counts and receipt counts
   are in the export but not on screen (`app.js` run note); the TypeScript client shows them only in the transient
   fetch summary, not in snapshots or history.
3. **The summary has no count of gap or invalid-frame events.** They exist as ledger events only, so a live run's
   missed polls are never summarized (`engine.js` `getSummary`).
4. **Sample provenance text is inconsistent.** The sample file's assumption text says a 2 bps half-spread while the
   app overrides the value to the configured default of 3 (`app.js`, `backend/paper_trail/evidence.py`).
5. **UI strings hard-code defaults** ("30 seconds" lateness, "cheapest verified taker") that are actually settings or
   dated facts (`index.html`).

## Open questions for J

- Freeze `docs/EVALUATION_CONTRACT.md` as written, amend it, or leave it proposed?
- Were the three 31-day performance runs in PR 7 on windows you can name? They would be excluded from the held-out
  draw.
- Is the PR template the right weight of receipt for this repo, or too much ceremony for a small project?
