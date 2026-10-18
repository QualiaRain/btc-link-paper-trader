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
- The project operating checkpoint for this repo, recorded in J's Notion on 2026-10-12

Authorization level of this page: agent synthesis (Claude Code, 2026-10-14) of rules J has already ratified or
stated, applied to this repository. It promotes nothing new to doctrine. Where a rule here is stricter than the
source, the source wins. Nothing private is copied here; dated rulings are cited by page, not quoted.

## The three layers (from the God-loop working theory)

The working theory says a self-improving system needs a stable invariant layer, a highly revisable operational
layer, and a source of resistance outside the current narrative. Without invariants, "improvement" loses its
referent; without revisability, it cannot adapt; without external resistance, it can become perfectly coherent and
wrong. Mapped onto this repo:

| Layer | What it is here | Changed by |
|---|---|---|
| Invariant | The Invariants section of `CLAUDE.md`: simulated cash only, long only, limits always win, local-only backend | J's explicit ruling, recorded in the PR |
| Operational | Settings, rules, UI, backend internals, the JS-as-parity-reference arrangement, the sign-test report card, docs, this page | Ordinary PRs with receipts |
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
| Tests amendable, not unilaterally | Building with Claude | `CLAUDE.md`; PR template | Documented; depends on reviewer discipline |
| Decide the judgement before looking | Reliability Doctrine; project checkpoint ("freeze the evaluation contract before inspecting held-out outcomes"); repo rule 5 | `docs/EVALUATION_CONTRACT.md`; `scripts/pick-holdout-windows.mjs` with a pinned test | Contract proposed, not frozen; picker enforced by test |
| Evidence grades on every result | `docs/HOW_THIS_WAS_BUILT.md` (existing practice); Reliability Doctrine §7 | PR template "Verification" | Documented and prompted |
| Coverage is part of the answer; no unbounded absence | Reliability Doctrine §6 and "false negatives are not symmetric"; Building with Claude ("not established, retrieval incomplete") | Sample and range coverage blocks (`market.js`, `replay.js`, `evidence.py`, `candles.py`); ledger-event counts in both engines; Run/snapshot/History displays in both apps | Covered by JS/Python coverage tests and real-browser tests; historical and remaining limits below |
| "Verified" needs a disconfirming attempt | Reliability Doctrine (proportionate factual disconfirmation) | PR template; reviewer agent | Documented |
| Honest results over flattering ones | `docs/HOW_THIS_WAS_BUILT.md` operating rules; Personal AI Philosophy (truth over agreement) | Report card wording ("No clear skill"), "Not claimed" section | Enforced by the random-walk control for the verdict; by review for prose |
| Reconstruct, reconcile, resume | Building with Claude | `CLAUDE.md`; change history table | Documented |
| Decision surfaces, not chores | Economic Loop, function 4 and guardrail 8 | `CLAUDE.md` | Documented |
| Every PR is a receipt | Economic Loop guardrail 10 and Loop v0 minimum instrumentation | `.github/pull_request_template.md` (auto-arrives on every PR) | Enforced by template; content by review |
| No meta-work without outward yield | Economic Loop guardrail 7 | PR template "Controller change" | Documented |
| Never silently work around a failure | Building with Claude (failure-reporting rule) | PR template "Coverage and limitations" | Documented |
| Identity: J only, no names | Building with Claude | `CLAUDE.md` | Documented; reviewers check |
| Boundaries | Project checkpoint "consequential boundaries"; Economic Loop operating modes | `CLAUDE.md` | Documented; the code has no real-money path to misuse |

"Enforced" means a test or CI fails when the rule is broken. "Documented" means the rule loads into the session and
the PR template asks about it, which is the assimilation standard the Economic Loop sets (a lesson counts only when
it lands where it executes or auto-arrives), but a determined agent could still ignore it. That gap is accepted for
now; the next step would be a CI check that the PR body's sections are filled, if receipts turn out to go missing.

## The economic object (from the Economic Loop)

The governing architecture judges candidate strategies by how well they close a loop, and every circuit must leave
receipts and a changed controller. This repo is one candidate instantiation, not the strategy. What it can honestly
show is an idea turned into a tested, inspectable system by an operator directing agents, with every claim graded
and the mistakes caught on record (`docs/HOW_THIS_WAS_BUILT.md`); what it cannot show is investment returns or
production readiness. Each PR is a circuit receipt. Anything about who the work is for, and on what terms, stays in
J's private system and never in this public repo; new strategy features are speculative until a validated need
exists, and whether to add them is J's call, not an agent's.

### Where the two objects pull apart

The technical object wants the held-out test run next; the economic object wants no further build without a
validated need. These do not conflict today: freezing and running the contract adds no features and produces a
receipt either way. They would conflict if someone proposed new rule features "to make the demo better". Agents
surface that, they do not decide it.

## Coverage improvements incorporated from PR #10

The original read-only audit on 2026-10-14 identified five findings. The first three are implemented in this
branch after incorporating [PR #10](https://github.com/QualiaRain/btc-link-paper-trader/pull/10); they are no longer
pending implementation. This describes the combined branch, not a claim that either draft has merged or deployed.

1. **New sample runs record coverage.** `market.js` (`sampleCoverage`) and `evidence.py` (`sample_coverage`) compute
   per-asset expected/observed/missing counts and missing timestamps from the bundled data. The checked sample has
   1,648 retained shared observations in a 1,800-minute window, with 152 missing minutes. Both asset blocks describe
   that shared subset, not independently discarded observations. The full sample window includes warmup, even in a
   partial sample run; full range coverage describes the scored window with warmup outside it. Backend partial range
   snapshots retain counts only through the revealed frame, without a missing-timestamp list.
2. **Both interfaces display coverage.** Root Run/snapshot/History views and TypeScript run panels/snapshots/History
   display expected, observed and missing minute counts, stored fetch receipts and the recorded event counts.
   Numeric warmup counts remain in the record; the sample label states that warmup is included. Live runs have no
   minute-coverage window. See `coverage.js`, `web/src/run-panels.ts` and their call sites.
3. **Both engine summaries count ledger events.** `getSummary` / `get_summary` expose `gapEvents` and `invalidFrames`.
   These count `gap` and `invalid_frame` entries, not missing minutes or individual missed polls. Replays can have
   missing source minutes while their live-gap event count remains zero.

Verification: `coverage.test.js`, `backend/tests/test_coverage.py`, parity goldens and the TypeScript browser tests
exercise recorded coverage and event counts. `web/test/root-coverage-browser.test.ts` additionally checks the root
app's legacy History-to-snapshot path, reload, unchanged read-only export and a new run with recorded zeros.
Invalid sample timestamps are rejected, and incomplete imported coverage displays as unavailable.

### Historical evidence and compatibility limits

- Imports and read-only views do not backfill absent minute coverage or summary counts. Missing counts display
  **not recorded**; an explicitly recorded zero remains zero. A count derivable today from a saved ledger is not a
  count recorded in that historical summary. Read-only exports preserve omissions, timestamps and hashes.
- Both summary counts may be omitted together for compatibility; partial omissions and incorrect stated counts
  fail backend import verification. No version/config marker identifies their era, so the importer cannot tell a
  genuine legacy omission from both fields removed from a newer record. This is an explicit limitation, not an
  age guarantee or tamper-proofing claim.
- Receipt counts measure stored evidence. Zero stored receipts does not prove every retrieval was captured or that
  no retrieval happened outside that evidence. Existing browser metadata without a receipt-count field remains
  unavailable until metadata is rebuilt from a record; it is not silently represented as a verified zero.
- Coverage instrumentation and parity checks establish engineering behavior, not predictive skill. Incorporating
  this work does not freeze or execute `docs/EVALUATION_CONTRACT.md`.

## Remaining doctrine/code findings from the 2026-10-14 audit

The original findings 4 and 5 remain open; documentation of them is not an implementation fix.

4. **Sample provenance text is inconsistent.** The sample file's assumption text says a 2 bps half-spread while the
   app overrides the value to the configured default of 3 (`app.js`, `backend/paper_trail/evidence.py`).
5. **UI strings hard-code defaults** ("30 seconds" lateness, "cheapest verified taker") that are actually settings or
   dated facts (`index.html`).

## Open questions for J

- Approve the exact specification in `docs/EVALUATION_CONTRACT.md` (including the clarified seed bucket/string,
  fixed settings, criteria, final exclusions and accepted prior-exposure uncertainty), amend it, or leave it proposed?
  First resolve whether the >10% replacement threshold measures missing shared minutes or per-asset missing minutes;
  the current wording conflates them, and the corrected draft explicitly blocks freezing until J approves one.
  Publishing the Stage A freeze to `main` before 2026-11-01T00:00:00Z and executing Stage B need explicit authority;
  approval to correct this draft does not grant either. Stage B observations are not required to freeze Stage A.
- PR 7 describes its three 31-day performance runs as synthetic (author-reported). If any previously inspected
  historical windows can be identified, exclude their enclosing UTC days before the freeze; otherwise explicitly
  accept the remaining provenance uncertainty without inventing dates or claiming all prior access is known.
- Is the PR template the right weight of receipt for this repo, or too much ceremony for a small project?
