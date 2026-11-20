// research/RESULTS.md: the record of one study run (research/study.mjs, exploration.json) as plain Markdown.
// renderResults() is a pure function of the record, so the report can be rebuilt from exploration.json alone.
//
// Wording rules, checked by research/study.test.mjs: this is exploration, not evidence; every number the run
// produced is labelled Measured, everything else is fixed text of research/PROTOCOL.md; a nominee's label never
// stands without its buy-and-hold reading; nothing states as a fact about a run that no setting was confirmed
// unless that is what the run measured; no word that claims more than was measured.
// Simulated cash only. Nothing here trades, fetches or reads market data.

// PROTOCOL.md, "What a result would and would not establish", as it now stands: its two paragraphs, quoted word for
// word and introduced as the protocol's text (the report says "The protocol bounds either outcome as follows:").
// The protocol's own negation "not a trading edge" is quoted as the protocol has it.
export const OUTCOME_BOUNDS = Object.freeze([
  'A confirmed nominee means only that one setting, chosen on 2020 to 2023, also had a positive mean modeled return ' +
    'on 2023 to 2025 at these cost assumptions. If the buy-and-hold reading beside it is *no*, that return cannot be ' +
    'told apart from holding a share of the two assets while they rose, and it justifies nothing further. If the ' +
    'reading is *yes*, it would justify writing a held-out contract for that setting and nothing more: not a trading ' +
    'edge, not executable fills, not future profit. Both carry the limits measured above. They pass too often when ' +
    'windows are not independent of one another, so a pass is a reason to test on untouched data and never a ' +
    'finding by itself. Replay quotes are candle closes with an assumed spread; latency, queue position, market ' +
    'impact, taxes and funding are not modeled, and the fee assumption is one venue\'s published rate, not a ' +
    'measured cost. If nothing is confirmed, that finding is bounded the same way: none of the settings searched was ' +
    'confirmed on these windows at these costs, which does not show that no rule could be. Either outcome is ' +
    'reported with the same prominence.',
  'Simulated cash only. No orders, keys, wallets or real-money path exist or are added.',
]);
// The section of PROTOCOL.md that measures the tests, by its title as amended.
export const TESTS_SECTION = 'What the tests can and cannot do (measured on simulated data, before any real data)';
// The protocol's sentence in bold under "Dependence between windows", word for word.
export const INDEPENDENCE = 'every label in this protocol assumes that a setting\'s windows are independent of one ' +
  'another, and for these two assets that cannot be assumed.';
// PROTOCOL.md, TESTS_SECTION, as amended: its three "Limits that no test on these windows can remove". The measured
// figures stay in the protocol's two tables, which are pointed to and not repeated; the first limit holds no figure
// of a table and is the protocol's text; the bold sentence is quoted.
export const TEST_LIMITS = Object.freeze([
  '**Rare large losses.** A rule that gains a little in most windows and loses a lot in one window out of twenty ' +
    'looks excellent in every sample that happens to contain no such loss; with 24 windows that is about three ' +
    'samples in ten. The worst window and the skewness are reported so this shape can be seen, but an unseen loss ' +
    'cannot be.',
  '**Dependence between windows.** The tests keep their stated level only when windows are independent of one ' +
    'another. When each window leans on the one before (runs), or good and bad windows come in stretches lasting ' +
    'several windows (regimes), every test passes more often than its level: by how much, on simulated returns, is ' +
    'in the protocol\'s first table ("How often each test passes when there is nothing to find"), and the ' +
    'substitutes an independent verifier tried in a scratch measurement did not bring the confirmation test back to ' +
    `its level. So the limit is stated instead: **${INDEPENDENCE}** The autocorrelations of 24 windows barely show ` +
    'such stretches. Lags 1 to 4, the two halves and the lowest third are reported so that the shape of a ' +
    'nominee\'s returns can be seen; none of them is a test.',
  '**Low power.** How often a real mean is found is the protocol\'s second table ("How often a real mean is ' +
    'found"). "Not confirmed" does not show that a smaller positive mean is absent.',
]);
// The same section's reading of the last row of its first table ("A rising market (the last row)"). It is not one
// of those limits: the buy-and-hold reading is the test that answers it.
export const RISING_MARKET = 'A long-only rule gains whenever the two assets rise, so a mean above zero can be ' +
  'nothing more than time spent invested. The last row of the protocol\'s first table measures a simulated rule with ' +
  'no timing value, only time invested in a rising market: the confirmation test is right to pass it, since its mean ' +
  'really is above zero, and the buy-and-hold reading stays near its level. That is why the reading stands beside ' +
  'every label.';
// The section headings, in the order the report has them.
export const SECTIONS = Object.freeze(['Status: what was run', 'Nominees and their labels',
  'The default setting on all windows', 'Per family', 'Each nominee: design and confirmation numbers', 'Engine check',
  'Cost hurdle', 'Coverage, invalid windows and receipts', 'Readings', 'Deviations',
  'What this result would and would not establish']);

const FAMILY_WORDS = {P: 'the app\'s rule', H: 'the app\'s rule with hold-through (a rule change, not in the app)',
  R: 'the app\'s rule with the forecast reversed (a rule change, not in the app)',
  X: 'the app\'s rule with LINK\'s forecast taken from BTC\'s drift (a rule change, not in the app)',
  L: 'long lookback (a rule change, not in the app)'};
const COST_WORDS = {default: 'default (feeBps 2)', fee10: 'feeBps 10', fee40: 'feeBps 40'};
const M = 'Measured';

const absent = value => value === null || value === undefined;
const whole = value => (absent(value) ? 'n/a' : value.toLocaleString('en-US'));
// A value that rounds to zero is printed without a minus sign.
const fixed = (value, digits) => value.toFixed(digits).replace(/^-(0(\.0*)?)$/, '$1');
const number = (value, digits = 2) => (absent(value) ? 'n/a' : fixed(value, digits));
const percent = (value, digits = 3) => (absent(value) ? 'n/a' : `${fixed(value, digits).replace(/^(?!-)/, '+')}%`);
const share = value => (absent(value) ? 'n/a' : `${(100 * value).toFixed(1)}%`);
const yesNo = value => (absent(value) ? 'unknown' : value ? 'yes' : 'no');
const code = text => `\`${text}\``;
const plural = (count, one, many = `${one}s`) => `${whole(count)} ${count === 1 ? one : many}`;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
  ...rows.map(row => `| ${row.join(' | ')} |`)];

// A p-value for print. A share of resamples that is exactly 0 is only known to be below 1 / resamples; it is
// printed as "<" that floor rounded up to one significant digit (10,000 resamples: "< 0.0001"; 300: "< 0.004").
export function pValue(p, resamples = null) {
  if (absent(p)) return 'n/a';
  if (p === 0 && resamples) {
    const floor = 1 / resamples, digits = Math.max(0, -Math.floor(Math.log10(floor) + 1e-9));
    return `< ${(Math.ceil(floor * 10 ** digits - 1e-9) / 10 ** digits).toFixed(digits)}`;
  }
  return p < 0.0001 ? '< 0.0001' : p.toFixed(4);
}

// A nominee's label with its buy-and-hold reading beside it, as the summary and the report print it and as the
// record stores it (PROTOCOL.md, Confirmation: "Stated beside the label of every nominee, wherever the label is
// printed"), e.g. "CONFIRMED AT DEFAULT COSTS; more than a share of buy-and-hold: no". `c` holds {label,
// moreThanAShareOfBuyAndHold}; the reading is the one at default costs.
export function labelWithReading({label, moreThanAShareOfBuyAndHold: reading}) {
  if (typeof label !== 'string' || !['yes', 'no'].includes(reading)) throw new Error('A label needs its buy-and-hold reading, yes or no');
  return `${label.toUpperCase()}; more than a share of buy-and-hold: ${reading}`;
}

// Whether the protocol's two tables were measured with the research/stats.mjs that ran (the record's
// `calibration`): nothing when they were, else one sentence that says so, for the summary and the report's status.
export function calibrationNote(calibration) {
  if (calibration?.measuredWithTheStatsThatRan === true) return [];
  if (calibration?.measuredWithTheStatsThatRan === false)
    return ['The protocol\'s tables were measured with another version of research/stats.mjs than the one that ran: ' +
      `${calibration.file} names SHA-256 ${calibration.statsSha256.slice(0, 16)}..., the research/stats.mjs that ran has ` +
      `${calibration.statsSha256ThatRan.slice(0, 16)}...`];
  return ['Which version of research/stats.mjs the protocol\'s tables were measured with is not known: ' +
    `${calibration?.file ?? 'research/calibration.json'} is missing or names none.`];
}

function settingWords(setting) {
  const minutes = setting.horizonMs / 60000, span = setting.spanMs / 60000;
  const spanWords = span % 1440 === 0 ? `${span / 1440} day${span === 1440 ? '' : 's'}` : `${span / 60} hours`;
  return [FAMILY_WORDS[setting.family], `${minutes}-minute horizon`,
    absent(setting.spanMs) ? `lookback ${setting.lookback} observations` : `drift measured over ${spanWords}`,
    `buffer ${setting.bufferBps} bps`, setting.stopLossBps ? `stop loss ${setting.stopLossBps} bps` : 'no stop loss',
    ...(setting.family === 'L' ? [`hold-through ${setting.holdThrough ? 'on' : 'off'}`] : [])].join('; ');
}

// What a label says in plain words, from the conditions the run measured.
function labelWords(c) {
  const {enoughWindows, positiveMean, pBelowThreshold, positiveMeanFee10} = c.conditions, bar = number(c.threshold, 4);
  if (c.label === 'not confirmed') {
    const failed = [...(enoughWindows ? [] : [`it has ${c.n} valid confirmation windows and needs at least ${c.minValidWindows}`]),
      ...(positiveMean ? [] : ['its mean return is not above 0']),
      ...(pBelowThreshold ? [] : [`its confirmation p-value is not below ${bar}`])];
    return `on these windows at these costs this setting was not confirmed, because ${failed.join(', and ')}`;
  }
  return `at default costs it had at least ${c.minValidWindows} valid confirmation windows, a mean return above 0 and a ` +
    `confirmation p-value below ${bar}; rerun with feeBps 10 its mean return ` +
    (positiveMeanFee10 ? 'stayed above 0' : 'was not above 0, so it is not cost-robust');
}

// The protocol's words for a reading of "no" (PROTOCOL.md, Confirmation), quoted.
const NO_MEANS = '"*No* means the nominee\'s return on these windows cannot be told apart from holding the fraction ' +
  '`slope` of the comparison account."';
// What the buy-and-hold reading says in plain words: which condition decided it.
function readingWords(h) {
  const bar = number(h.threshold, 4);
  if (h.reading === 'yes')
    return `its return is more than a share of buy-and-hold: on ${h.n} valid windows the fit's intercept is above 0 and ` +
      `the reading's p-value ${pValue(h.p)} is below ${bar}`;
  const failed = [...(h.conditions.enoughWindows ? [] : [`it has ${h.n} valid windows and needs at least ${h.minValidWindows}`]),
    ...(h.conditions.positiveIntercept ? [] : [absent(h.intercept) ? 'no line can be fitted' : 'the fit\'s intercept is not above 0']),
    ...(h.conditions.pBelowThreshold ? [] : [`the reading's p-value ${pValue(h.p)} is not below ${bar}`])];
  const because = `its buy-and-hold reading is no, because ${failed.join(', and ')}`;
  // The protocol's words for a no describe a fit that was read. With no line, or with too few windows as the only
  // reason, nothing was read: the protocol counts it as no, and its words are not set against a fit that decided
  // nothing.
  if (absent(h.intercept)) return `${because}: with no fitted line there is nothing to read, and the protocol counts that as no`;
  if (h.conditions.positiveIntercept && h.conditions.pBelowThreshold)
    return `${because}: too few valid windows to read, and the protocol counts that as no, whatever the fit on them shows`;
  return `${because}. In the protocol's words, ${NO_MEANS} Here the slope is ${number(h.slope, 3)}`;
}

// One row of statistics for a cost level of an account on the confirmation windows (a nominee's r, or b).
const levelRow = (name, level, resamples) => [name, whole(level.n), percent(level.mean), number(level.sd, 3),
  number(level.T), number(level.skewness), number(level.lag1), pValue(level.pT), pValue(level.pResample, resamples),
  pValue(level.p), share(level.sharePositive),
  level.worst ? `${percent(level.worst.r ?? level.worst.b)} (window ${level.worst.index})` : 'n/a'];
const LEVEL_HEAD = ['Cost level', 'Valid windows', 'Mean return', 'sd', 'T', 'Skewness', 'Lag-1 autocorrelation',
  'p (Student t)', 'p (resample)', 'Confirmation p (larger of the two)', 'Share of windows above 0', 'Worst window'];
const levels = (account, resamples) => [['default', account], ['fee10', account.fee10], ['fee40', account.fee40]]
  .map(([name, level]) => levelRow(COST_WORDS[name], level, resamples));

// One problem of research/dataset.mjs storeCompleteness, as a line: a file no manifest entry names is named by
// the path its text holds; every other problem by its asset and month.
const problemText = problem => (typeof problem === 'string' ? problem : problem.problem.startsWith('not in the manifest')
  ? problem.problem : `${problem.asset} ${problem.month}: ${problem.problem}`);

// The comparison account's own row (PROTOCOL.md, Confirmation: "the comparison account's own returns b on the
// confirmation windows put through the same confirmation calculation (did simply holding pass?)"; Reading 8).
function comparisonRow(held, resamples) {
  const bar = number(held.threshold, 4), {enoughWindows, positiveMean, pBelowThreshold} = held.conditions;
  const why = [`at least ${held.minValidWindows} valid windows: ${yesNo(enoughWindows)} (${held.n})`,
    `mean above 0: ${yesNo(positiveMean)} (${percent(held.mean)})`];
  return [`The comparison account's own row: half BTC, half LINK, bought once and held, same costs, put through the ` +
    `same confirmation calculation on every confirmation window above the coverage floor (Reading 8). ${M}:`, '',
    ...table(LEVEL_HEAD, levels(held, resamples)), '',
    held.k
      ? `${M}: simply holding ${held.passed ? 'PASSED' : 'did not pass'} the test a nominee is confirmed by, on these ` +
        `windows and with the nominees' bar: ${why.join('; ')}; confirmation p below 0.05 / ${held.k} = ${bar}: ` +
        `${yesNo(pBelowThreshold)} (${pValue(held.p)}).`
      : `${M}: there is no nominee, so there is no k and no bar: the numbers above stand alone (${why.join('; ')}; ` +
        `confirmation p-value ${pValue(held.p)}).`];
}

// "More than a share of buy-and-hold" for one nominee at default costs, with the fit behind it (PROTOCOL.md,
// Confirmation: "Fit r = intercept + slope × b by least squares over the nominee's valid confirmation windows").
function readingParagraph(c) {
  const h = c.buyAndHold, bar = number(h.threshold, 4);
  return `More than a share of buy-and-hold. ${M} at default costs: r = intercept + slope × b fitted by least squares ` +
    `over ${plural(h.n, 'valid window')}: intercept ${percent(h.intercept)} (standard error ${number(h.seIntercept, 3)}; ` +
    `one-sided p-value for intercept > 0, Student's t with n − 2 degrees of freedom: ${pValue(h.pFit)}), slope ` +
    `${number(h.slope, 3)} (standard error ${number(h.seSlope, 3)}); the confirmation p-value of the series ` +
    `r − slope × b: ${pValue(h.adjusted.p)}; the reading's p-value, the larger of the two: ${pValue(h.p)}, against ` +
    `0.05 / ${c.k} = ${bar}. At least ${h.minValidWindows} valid windows: ${yesNo(h.conditions.enoughWindows)}; ` +
    `intercept above 0: ${yesNo(h.conditions.positiveIntercept)}; p-value below ${bar}: ${yesNo(h.conditions.pBelowThreshold)}. ` +
    `Reading: **${h.reading}**. In plain words: ${readingWords(h)}. Reported, not used: the reading at feeBps 10 is ` +
    `${h.fee10.reading} (p ${pValue(h.fee10.p)}), at feeBps 40 ${h.fee40.reading} (p ${pValue(h.fee40.p)}).`;
}

// Reading 9: the shape of a nominee's returns, described and not tested.
function shapeParagraph(c) {
  const half = ({windows, n, mean}) => `${windows ? `windows ${windows[0]} to ${windows[1]}` : 'no window'}: ` +
    `${percent(mean)} over ${plural(n, 'valid window')}`;
  const low = c.lowestThird;
  return `The shape of the returns (Reading 9): descriptive figures, not tests. ${M} at default costs: the ` +
    `autocorrelation of r at lags 1 to 4: ${c.autocorrelation.map(a => number(a)).join(', ')}; the mean of r in the ` +
    `first half of the confirmation windows, ${half(c.halves[0])}, and in the second half, ${half(c.halves[1])}; the ` +
    `mean of r over the ${plural(low.n, 'valid window')} in which b was lowest` +
    (low.n ? ` (windows ${low.windows.join(', ')}, lowest b first): ${percent(low.mean)}, where b averaged ${percent(low.meanComparison)}.`
      : ': none, with fewer than three valid windows.');
}

// Months named by one of storeCompleteness's lists, per asset, written out in full.
const monthLists = (assets, months) => assets.map(asset => {
  const found = months.filter(entry => entry.asset === asset).map(entry => entry.month);
  return `${asset} ${found.length ? `${found.length} (${found.join(', ')})` : 'none'}`;
}).join('; ');

export function renderResults(results) {
  const {banner, protocol, deviations, readings, code: codeState, calibration, data, previousRun, windows,
    invalidWindows, designGrid, pooled, comparisonAccount, nominees, families, defaultSetting, costHurdle, timing} = results;
  const p = protocol.windows, k = nominees.length, searched = whole(designGrid.settings);
  const resamples = protocol.resampling.resamples, confirmationWindows = windows.length - designGrid.designWindows;
  const out = [], add = (...lines) => out.push(...lines), section = index => add('', `## ${SECTIONS[index]}`, '');
  const confirmedCount = nominees.filter(n => n.confirmation.label !== 'not confirmed').length;

  // The banner is the first thing in the file (PROTOCOL.md, Data boundary: "recorded as a deviation at the top of
  // the results").
  for (const line of banner) add(`> **${line}**`);
  if (banner.length) add('');
  add('# Exploration results', '',
    'Written by `node research/study.mjs` together with `exploration.json` (format ' + code(results.format) + '), from ' +
    'which every number below is taken. **This is exploration, not evidence.** It can nominate a setting for a ' +
    'pre-registered held-out test; it cannot establish that any rule makes money. Simulated cash only: no orders, ' +
    `keys or wallets exist. A number labelled ${M} was produced by this run; all other text is fixed by ` +
    `${code(protocol.file)}.`);

  section(0);
  const rows = data.rows, first = Object.values(data.firstClose).filter(Boolean).sort()[0];
  const last = Object.values(data.lastClose).filter(Boolean).sort().at(-1);
  const record = previousRun?.record;
  add(`- Protocol. ${M}: ${code(protocol.file)}, SHA-256 ${code(protocol.sha256)}; state against the commit: ${codeState.protocol.state}.`,
    `- Code. ${M}: commit ${code(codeState.commit ?? 'unknown')}; every module that ran is committed at that commit: ` +
      `${yesNo(codeState.allModulesCommitted)}; tracked files modified anywhere in the repository: ` +
      `${yesNo(codeState.trackedFilesModified)}; research modules untracked: ${yesNo(codeState.researchModulesUntracked)}; ` +
      `${code('engine.js')} equals the engine at commit ${code(codeState.engine.referenceCommit)}: ` +
      `${yesNo(codeState.engine.equalsReference)}.` +
      (codeState.problems.length ? ` The commit does not name the code that ran: ${codeState.problems.join('; ')}.` : ''),
    // The measurement behind the protocol's two tables, held against the statistics that ran.
    `- Calibration. ${M}: ${code(calibration.file)}, SHA-256 ${calibration.sha256 ? code(calibration.sha256) : 'none (no such file)'}, ` +
      `says the protocol's two tables were measured with ${code('research/stats.mjs')} SHA-256 ` +
      `${calibration.statsSha256 ? code(calibration.statsSha256) : 'unknown'}; the ${code('research/stats.mjs')} that ran has ` +
      `SHA-256 ${code(calibration.statsSha256ThatRan)}; the same: ${yesNo(calibration.measuredWithTheStatsThatRan)}.` +
      calibrationNote(calibration).map(note => ` **${note}**`).join(''),
    `- Data. ${M}: ${data.kind}; source "${data.source}"; complete exchange store: ${yesNo(data.completeExchangeStore)}` +
      (data.completeness ? ' (read from the store\'s own records, its source label and the origin each receipt names, ' +
        'which cannot prove where a file came from)' : '') +
      `; manifest SHA-256 ${data.manifestSha256 ? code(data.manifestSha256) : 'none (no store was read)'}; ` +
      `${whole(rows.BTC)} BTC rows and ${whole(rows.LINK)} LINK rows, closes from ${first ?? 'n/a'} to ${last ?? 'n/a'}.`,
    `- Run. ${M}: started ${timing.startedAt}; wall time ${number(timing.wallSeconds, 1)} s; Node ${codeState.node}; ` +
      `${timing.workers} worker threads.`,
    `- Search. ${M}: ${searched} settings on ${designGrid.designWindows} design windows (${designGrid.validDesignWindows} ` +
      `above the coverage floor), ${whole(designGrid.simulations)} simulations at default costs; ` +
      `${confirmationWindows} confirmation windows. Both tests: ${whole(resamples)} resamples, seed ${protocol.resampling.seed}.`,
    // PROTOCOL.md, Always reported: "A second run does not silently replace an earlier record."
    `- Earlier record. ${M}: ` + (previousRun ? ['exploration', 'report'].filter(name => previousRun[name]).map(name =>
      `the earlier ${name} file was replaced (SHA-256 ${code(previousRun[name].sha256)}, ${whole(previousRun[name].bytes)} ` +
      `bytes, last modified ${previousRun[name].modifiedAt})`).join('; ') + '; ' + (record
      ? `the replaced exploration.json recorded the data source "${record.dataSource}" and the banner ` +
        `${record.banner.length ? record.banner.map(line => `"${line.split(':')[0]}"`).join(', ') : 'none'}.`
      : 'what the replaced files recorded could not be read from an exploration.json.') : 'none was replaced.') +
      ' Only the two output paths are checked for an earlier record (`exploration.json` in the output directory, and ' +
      'the report): a record written to any other path is not seen.',
    `- Deviations from the protocol. ${M}: ${deviations.length ? `${deviations.length}, each with its reason under "Deviations"` : 'none'}.`,
    '', `${M}: the modules that ran.`, '',
    ...table(['Module', 'SHA-256', 'State against the commit'], codeState.modules.map(m => [code(m.file), code(m.sha256), m.state])));

  section(1);
  if (!k && !pooled.eligible) {
    add(`${M}: no nominee. No setting was eligible (at least ${p.minValidDesignWindows} valid design windows and a ` +
      'fill in at least half of them), so no family had a setting to nominate and nothing was run on the confirmation ' +
      'windows for a nominee.');
  } else if (!k) {
    add(`${M}: no nominee. No family had a setting among its ten highest-scoring distinct settings with a design mean ` +
      'above 0 and neighbours whose median T is above 0, so nothing was run on the confirmation windows for a nominee.');
  } else {
    add(`${M}: ${k} nominee${k === 1 ? '' : 's'}, at most one per family, chosen on the design windows only. With k = ${k} a ` +
      `nominee is confirmed only on at least ${p.minValidConfirmationWindows} valid confirmation windows, with a mean ` +
      `return above 0 and a confirmation p-value below 0.05 / ${k} = ${number(0.05 / k, 4)}. Beside each label stands ` +
      `its buy-and-hold reading: "yes" needs at least ${p.minValidConfirmationWindows} valid windows, an intercept ` +
      `above 0 and a reading p-value below the same ${number(0.05 / k, 4)}; anything else is "no".`, '');
    for (const {id, setting, confirmation: c} of nominees)
      add(`- **${id}** (${settingWords(setting)}): **${labelWithReading(c)}**. ${M}: mean return ${percent(c.mean)} per ` +
        `window over ${c.n} valid confirmation windows, confirmation p-value ${pValue(c.p)} against ${number(c.threshold, 4)}, ` +
        `mean return at feeBps 10 ${percent(c.fee10.mean)}; buy-and-hold fit intercept ${percent(c.buyAndHold.intercept)}, ` +
        `slope ${number(c.buyAndHold.slope, 3)}, reading p-value ${pValue(c.buyAndHold.p)}. In plain words: ${labelWords(c)}; ` +
        `and ${readingWords(c.buyAndHold)}.`);
  }
  add('', ...comparisonRow(comparisonAccount, resamples));
  add('', 'What a label means, and no more:', '',
    '- A confirmed nominee whose buy-and-hold reading is no had a return that cannot be told apart from holding a ' +
      'share of the two assets over the same windows; it justifies nothing further.',
    '- A confirmed nominee whose buy-and-hold reading is yes would justify writing a held-out contract for that ' +
      'setting and nothing more.',
    '- "Not confirmed" says only that on these windows at these costs the setting was not confirmed. It does not show ' +
      'that a smaller positive mean is absent.',
    ...(confirmedCount ? [] : [`- ${M}: none of the ${searched} settings this run searched was confirmed on these windows ` +
      'at these costs.']),
    '- Every label assumes that a setting\'s windows are independent of one another (last section). Either outcome is ' +
      'reported with the same prominence.');

  section(2);
  const d = defaultSetting, skipped = d.perWindow.filter(w => !absent(w.invalid));
  add(`${M}, at default costs: ${code(d.id)} (${d.description}) ran on ${d.n} of ${d.perWindow.length} windows.`, '',
    ...table(['Windows', 'Valid', 'Mean return', 'sd', 'T', 'Share of windows above 0', 'Comparison account mean', 'Average fills'],
      [['all', d], ['design', d.design], ['confirmation', d.confirmation]].map(([name, part]) => [name, whole(part.n),
        percent(part.mean), number(part.sd, 3), number(part.T), share(part.sharePositive), percent(part.meanComparison),
        number(part.meanFills, 1)])),
    '', `${M}: windows on which it did not run: ${skipped.length ? skipped.map(w => `${w.index} (${w.invalid})`).join(', ') : 'none'}. ` +
      'Its return in every window is in the coverage table below.');

  section(3);
  const best = f => [number(f.best?.T), f.best ? code(f.best.id) : 'none', number(f.best?.skewness), number(f.best?.lag1),
    whole(f.best?.n), pValue(f.searchAdjusted.p, f.searchAdjusted.resamples)];
  add(`${M} on the design windows at default costs. Eligible means at least ${p.minValidDesignWindows} valid design ` +
    'windows and a fill in at least half of them. The best T is the highest score among eligible settings; skewness, ' +
    'lag-1 autocorrelation and valid windows are that setting\'s.', '',
    ...table(['Family', 'Settings', 'Eligible', 'Positive design mean (among eligible)', 'Distinct among the ten considered',
      'Best T', 'Best setting', 'Skewness', 'Lag-1 autocorrelation', 'Valid windows', 'Search-adjusted p', 'Nominee'],
      [...Object.entries(families).map(([family, f]) => [family, whole(f.settings), whole(f.eligible),
        `${whole(f.positiveMean)} (${whole(f.eligiblePositiveMean)})`, whole(f.nomination.tenConsidered.distinctReturnVectors),
        ...best(f), f.nomination.nominee ? code(f.nomination.nominee) : 'none']),
      ['all', whole(pooled.settings), whole(pooled.eligible), `${whole(pooled.positiveMean)} (${whole(pooled.eligiblePositiveMean)})`,
        '', ...best(pooled), '']]),
    '', '- The search-adjusted p-value answers: how often would the best of this many settings look this good if none ' +
      'had a positive mean? It is reported with the nominees, not used as a gate. How often it passes when no setting ' +
      `has a positive mean is the first table of ${code(protocol.file)}, "${TESTS_SECTION}", measured there at the ` +
      'width of one family of P, H or R and of all families pooled; families X and L have no column of their own.',
    '- Settings whose design returns are identical window for window count once. The ten considered are therefore ' +
      'distinct; fewer than ten means the family had fewer distinct eligible settings.',
    ...Object.entries(families).map(([family, f]) => {
      const ten = f.nomination.tenConsidered, refused = Object.entries(f.refusedForWarmup);
      return `- ${family} (${FAMILY_WORDS[family]}). ${M}: the ${ten.distinctReturnVectors} considered stand for ` +
        `${ten.eligibleSettingsStoodFor} eligible settings; the ten highest-scoring eligible settings held ` +
        `${ten.distinctAmongPlainTopTen} distinct return vectors before identical ones were counted once; ` +
        `${f.nomination.considered.length} looked at before the walk ended; settings refused for lack of warmup: ` +
        `${refused.length ? refused.map(([window, count]) => `window ${window}: ${whole(count)}`).join(', ') : 'none'}.`;
    }));

  section(4);
  if (!k) add(`${M}: there is no nominee.`);
  for (const {id, family, design: g, confirmation: c} of nominees) {
    add(`### ${id}`, '',
      `Design windows, default costs. ${M}: rank ${g.rank} among the ten considered of family ${family}; ${g.n} valid ` +
        `windows; mean return ${percent(g.mean)}, sd ${number(g.sd, 3)}; t ${number(g.t)}, lag-1 autocorrelation ` +
        `${number(g.lag1)}, so T ${number(g.T)}; skewness ${number(g.skewness)}; share of windows above 0 ` +
        `${share(g.sharePositive)}; average fills per window ${number(g.meanFills, 1)}. Neighbours' T: ` +
        `${g.neighbours.map(n => `${code(n.id)} ${number(n.T)}`).join(', ')}; median ${number(g.neighbourMedianT)}. ` +
        `Eligible settings with identical design returns, which it stands for: ${g.identical.length ? g.identical.map(code).join(', ') : 'none'}. ` +
        `Search-adjusted p of the best T: family ${pValue(g.searchAdjustedP.family, resamples)}, all families ` +
        `${pValue(g.searchAdjustedP.pooled, resamples)} (reported, not a gate).`,
      '', `Confirmation windows. ${M}:`, '',
      ...table(LEVEL_HEAD, levels(c, resamples)),
      '', `Label: **${labelWithReading(c)}**. ${M}: at least ${c.minValidWindows} valid windows: ${yesNo(c.conditions.enoughWindows)} ` +
        `(${c.n}); mean above 0: ${yesNo(c.conditions.positiveMean)}; confirmation p below 0.05 / ${c.k} = ` +
        `${number(c.threshold, 4)}: ${yesNo(c.conditions.pBelowThreshold)} (${pValue(c.p)}); mean above 0 at feeBps 10: ` +
        `${yesNo(c.conditions.positiveMeanFee10)} (${percent(c.meanFee10)}). Only the default row and the feeBps 10 mean ` +
        'decide the label, and the buy-and-hold reading below stands beside it; the other p-values are reported, not used.',
      '', readingParagraph(c),
      '', shapeParagraph(c),
      '', `Reported alongside, not pass/fail. ${M} at default costs: comparison account mean ${percent(c.meanComparison)}; ` +
        `average fills per window ${number(c.meanFills, 1)}; average fees per window $${number(c.meanFees)}. Direction ` +
        'sign test, two-sided, forecasts pooled over the windows: ' +
        Object.entries(c.direction).map(([asset, s]) => `${asset} ${whole(s.hits)} hits, ${whole(s.misses)} misses, ` +
          `${whole(s.flat)} flat, hit rate ${share(s.hitRate)}, p ${pValue(s.signTestP)}`).join('; ') +
        `. Confirmation windows refused for this setting: ${c.invalidForSetting.length ? c.invalidForSetting.map(w => `${w.index} (${w.reason})`).join(', ') : 'none'}.`,
      '');
  }
  if (k) add('Every window\'s return, fills and fees are in `exploration.json` under `nominees`.');

  section(5);
  add('Every nominee is rerun window by window through an engine before it is reported; a disagreement stops the ' +
    `study and nothing is written. Tolerance: 1e-9 relative on the final value, fills equal. ${M}: ` +
    `${code('engine.js')} (SHA-256 ${code(codeState.engine.sha256)}) equals the engine at commit ` +
    `${code(codeState.engine.referenceCommit)}: ${yesNo(codeState.engine.equalsReference)}.`, '',
    ...(k ? table(['Nominee', 'Reference it was checked against', 'Windows compared', 'Windows refused by both',
      'Largest relative difference in final value', 'Fills equal'],
      nominees.map(({id, exactCheck: e}) => [code(id),
        `${e.reference}${e.fedHistory && !e.reference.includes('fed the history') ? ', fed the history the rule reads' : ''}`,
        whole(e.windowsCompared), whole(e.windowsRefusedByBoth), e.maxRelativeDifference.toExponential(1),
        yesNo(e.fillsEqual)])) : [`${M}: there is no nominee to check.`]));

  section(6);
  const trip = costHurdle.roundTripBps;
  add(`${M} on the ${costHurdle.windows} valid windows: the median absolute log move over each horizon, against one ` +
    `round trip of costs: ${trip.default} bps at default costs (${trip.fee10} bps at feeBps 10, ${trip.fee40} bps at feeBps 40).`, '',
    ...table(['Horizon (minutes)', 'BTC median move (bps)', `BTC, share of ${trip.default} bps`, 'LINK median move (bps)',
      `LINK, share of ${trip.default} bps`], costHurdle.horizons.map(h => [h.horizonMinutes,
      number(h.BTC.medianAbsLogMoveBps, 1), share(h.BTC.shareOfDefaultRoundTrip), number(h.LINK.medianAbsLogMoveBps, 1),
      share(h.LINK.shareOfDefaultRoundTrip)])));

  section(7);
  const total = key => windows.reduce((sum, w) => sum + key(w), 0), expected = total(w => w.expected);
  const ran = new Map(d.perWindow.map(w => [w.index, w]));
  add(`${M}: ${windows.length} windows, ${whole(expected)} minutes expected. Observed: BTC ${whole(total(w => w.observed.BTC))} ` +
      `(missing ${whole(total(w => w.missing.BTC))}), LINK ${whole(total(w => w.observed.LINK))} (missing ` +
      `${whole(total(w => w.missing.LINK))}), both ${whole(total(w => w.shared))} (missing ${whole(total(w => w.missingShared))}).`,
    '', `${M}: windows invalid for every setting (fewer than ${share(p.minSharedFraction)} of their minutes observed for ` +
      `both assets): ${invalidWindows.length ? invalidWindows.map(w => `${w.index} (${w.set}, ${w.reason}, ${share(w.sharedFraction)} shared)`).join(', ') : 'none'}. ` +
      'Windows invalid for some settings only (the app would refuse the run for lack of warmup) are counted per family ' +
      'above and per nominee in its section.',
    '', `${M}, per window (the last three columns are the default setting):`, '',
    ...table(['Window', 'Set', 'First minute', 'Expected', 'BTC observed', 'BTC missing', 'LINK observed', 'LINK missing', 'Both',
      'Both missing', 'Both, share', 'Valid', 'Return', 'Comparison return', 'Fills'], windows.map(w => {
      const run = ran.get(w.index);
      return [w.index, w.set, w.start.slice(0, 16) + 'Z', whole(w.expected), whole(w.observed.BTC), whole(w.missing.BTC),
        whole(w.observed.LINK), whole(w.missing.LINK), whole(w.shared), whole(w.missingShared), share(w.sharedFraction),
        w.valid ? 'yes' : `no: ${w.invalidReason}`,
        ...(absent(run.invalid) ? [percent(run.r), percent(run.b), whole(run.fills)] : [run.invalid, '', ''])];
    })), '');
  if (!data.receipts) add(`${M}: receipts: none. This run read no candle store, so no exchange response stands behind its prices.`);
  else {
    const months = [...new Set(Object.values(data.receipts).flatMap(asset => Object.keys(asset.sha256))
      .concat(Object.values(data.manifest.assets).flatMap(asset => Object.keys(asset.months))))].sort();
    const short = hash => (hash ? code(hash.slice(0, 16)) : 'none'), assets = Object.keys(data.receipts);
    // What the store's own records say per month (research/dataset.mjs storeCompleteness): answers that held no
    // row, months whose last wanted minute did not come back, and months that hold no row. Missing minutes are never
    // filled; they show in the coverage above.
    const {emptyResponseMonths, lastBucketMissingMonths, rowsByMonth} = data.completeness;
    const noRows = assets.flatMap(asset => Object.entries(rowsByMonth[asset] ?? {}).filter(([, count]) => count === 0)
      .map(([month]) => ({asset, month})));
    // "Exchange" only for the complete exchange store, whose every receipt names the exchange's origin.
    const exchange = data.completeExchangeStore ? 'exchange ' : '';
    add(`${M}: receipts, one per stored ${exchange}response: ` + assets.map(asset => `${asset} ${whole(data.receipts[asset].receipts)} ` +
      `receipts in ${whole(data.receipts[asset].files)} files`).join(', ') + '.', '',
      `${M}, from the store's own records: months with an ${exchange}answer that held no row: ${monthLists(assets, emptyResponseMonths)}. ` +
      `Months whose last wanted minute did not come back: ${monthLists(assets, lastBucketMissingMonths)}. Months that hold ` +
      `no row: ${monthLists(assets, noRows)}.`, '',
      '"Fetched from the exchange" is read from the store\'s own records: the source label in its manifest and the ' +
      'origin each receipt names. That catches accidents and cannot prove where a file came from.', '',
      `${M}, per month, with the first 16 characters of each SHA-256 (the stored series, then its receipts file); the ` +
      'complete values are in `exploration.json` under `data`:', '',
      ...table(['Month', ...assets.flatMap(asset => [`${asset} rows`, `${asset} receipts`, `${asset} series`, `${asset} receipts file`])],
        months.map(month => [month, ...assets.flatMap(asset => {
          const entry = data.manifest.assets[asset]?.months[month];
          return [whole(entry?.rows), whole(entry?.receipts), short(entry?.sha256), short(data.receipts[asset].sha256[month])];
        })])));
  }

  section(8);
  add(`How each sentence of ${code(protocol.file)} is applied where it could be read two ways (its "Readings"):`, '',
    ...readings.protocol.map((text, i) => `${i + 1}. ${text}`),
    '', 'Further readings this study had to make. **They are not in the protocol**:', '',
    ...readings.notInProtocol.map(text => `- ${text}`));

  section(9);
  if (!deviations.length) add('None.');
  else add(`${M}: this run differs from ${code(protocol.file)} in ${deviations.length} way${deviations.length === 1 ? '' : 's'}.`, '',
    ...deviations.flatMap((deviation, i) => {
      const listed = (deviation.problems ?? []).map(problemText);
      return [`${i + 1}. **${deviation.option}**: ${code(JSON.stringify(deviation.value))} where the protocol's run has ` +
        `${code(JSON.stringify(deviation.default))}. Reason: ${deviation.reason}`,
        ...listed.slice(0, 12).map(problem => `   - ${problem}`),
        ...(listed.length > 12 ? [`   - and ${listed.length - 12} more, all listed in \`exploration.json\` under \`deviations\``] : [])];
    }));

  section(10);
  add('The protocol bounds either outcome as follows:', '',
    ...OUTCOME_BOUNDS.flatMap((text, i) => [...(i ? ['>'] : []), `> ${text}`]), '',
    `The "limits measured above" in that quotation are the protocol's limits that no test on these windows can remove ` +
      `(${code(protocol.file)}, "${TESTS_SECTION}"; the measured figures are in its two tables):`, '',
    ...TEST_LIMITS.map(text => `- ${text}`), '',
    `Not one of those limits, from the same section's reading of its first table (A rising market, the last row): ${RISING_MARKET}`, '',
    `${M}: this run searched ${searched} settings on ${designGrid.designWindows} design windows and ran ${k} ` +
      `nominee${k === 1 ? '' : 's'} on ${confirmationWindows} confirmation windows; ` +
      (confirmedCount ? `${confirmedCount} of them ${confirmedCount === 1 ? 'was' : 'were'} confirmed, each with its buy-and-hold reading beside its label above.`
        : `none of the ${searched} settings it searched was confirmed on these windows at these costs.`));
  return `${out.join('\n')}\n`;
}
