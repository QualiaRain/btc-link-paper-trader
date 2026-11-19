// research/RESULTS.md: the record of one study run (research/study.mjs, exploration.json) as plain Markdown.
// renderResults() is a pure function of the record, so the report can be rebuilt from exploration.json alone.
//
// Wording rules, checked by research/study.test.mjs: this is exploration, not evidence; every number the run
// produced is labelled Measured, everything else is fixed text of research/PROTOCOL.md; a label of "not confirmed"
// is bounded as the protocol bounds it; no word that claims more than was measured.
// Simulated cash only. Nothing here trades, fetches or reads market data.

// PROTOCOL.md, "What a result would and would not establish". One phrase is reworded: where the protocol says
// what a confirmed nominee would not be, its first item is written here as "not a demonstrated trading
// advantage", because the repository's results never use the protocol's own word for it.
export const LIMITS = Object.freeze([
  'A confirmed nominee means only that one setting, chosen on 2020 to 2023, also had a positive mean modeled return ' +
    'on 2023 to 2025 at these cost assumptions. It would justify writing a held-out contract for that setting and ' +
    'nothing more: not a demonstrated trading advantage, not executable fills, not future profit. Replay quotes are ' +
    'candle closes with an assumed spread; latency, queue position, market impact, taxes and funding are not ' +
    'modeled, and the fee assumption is one venue\'s published rate, not a measured cost. "Not confirmed" is bounded ' +
    'the same way: no setting among the 13,200 searched was confirmed on these windows at these costs. Either ' +
    'outcome is reported with the same prominence.',
  'Simulated cash only. No orders, keys, wallets or real-money path exist or are added.',
]);
// PROTOCOL.md, "What the two tests can and cannot do": the "two limits no test on these windows can remove".
export const TEST_LIMITS = Object.freeze([
  '**Rare large losses.** A rule that gains a little in most windows and loses a lot in one window out of twenty ' +
    'looks excellent in every sample that happens to contain no such loss; with 24 windows that is about three ' +
    'samples in ten. The worst window and the skewness are reported so this shape can be seen, but an unseen loss ' +
    'cannot be.',
  '**Low power for slow rules.** With 24 or 50 windows these tests can only detect a mean return of roughly half a ' +
    'standard deviation per window or more. "Not confirmed" does not show a smaller positive mean is absent.',
]);
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

// One row of statistics for a cost level of a nominee's confirmation windows.
const levelRow = (name, level, resamples) => [name, whole(level.n), percent(level.mean), number(level.sd, 3),
  number(level.T), number(level.skewness), number(level.lag1), pValue(level.pT), pValue(level.pResample, resamples),
  pValue(level.p), share(level.sharePositive),
  level.worst ? `${percent(level.worst.r)} (window ${level.worst.index})` : 'n/a'];

export function renderResults(results) {
  const {banner, protocol, deviations, readings, code: codeState, data, previousRun, windows, invalidWindows,
    designGrid, pooled, nominees, families, defaultSetting, costHurdle, timing} = results;
  const p = protocol.windows, k = nominees.length, searched = whole(designGrid.settings);
  const resamples = protocol.resampling.resamples;
  const out = [], add = (...lines) => out.push(...lines), section = index => add('', `## ${SECTIONS[index]}`, '');

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
  add(`- Protocol. ${M}: ${code(protocol.file)}, SHA-256 ${code(protocol.sha256)}; state against the commit: ${codeState.protocol.state}.`,
    `- Code. ${M}: commit ${code(codeState.commit ?? 'unknown')}; every module that ran is committed at that commit: ` +
      `${yesNo(codeState.allModulesCommitted)}; tracked files modified anywhere in the repository: ` +
      `${yesNo(codeState.trackedFilesModified)}; research modules untracked: ${yesNo(codeState.researchModulesUntracked)}; ` +
      `${code('engine.js')} equals the engine at commit ${code(codeState.engine.referenceCommit)}: ` +
      `${yesNo(codeState.engine.equalsReference)}.` +
      (codeState.problems.length ? ` The commit does not name the code that ran: ${codeState.problems.join('; ')}.` : ''),
    `- Data. ${M}: ${data.kind}; source "${data.source}"; complete exchange store: ${yesNo(data.completeExchangeStore)}; ` +
      `manifest SHA-256 ${data.manifestSha256 ? code(data.manifestSha256) : 'none (no store was read)'}; ` +
      `${whole(rows.BTC)} BTC rows and ${whole(rows.LINK)} LINK rows, closes from ${first ?? 'n/a'} to ${last ?? 'n/a'}.`,
    `- Run. ${M}: started ${timing.startedAt}; wall time ${number(timing.wallSeconds, 1)} s; Node ${codeState.node}; ` +
      `${timing.workers} worker threads.`,
    `- Search. ${M}: ${searched} settings on ${designGrid.designWindows} design windows (${designGrid.validDesignWindows} ` +
      `above the coverage floor), ${whole(designGrid.simulations)} simulations at default costs; ` +
      `${windows.length - designGrid.designWindows} confirmation windows. Both tests: ${whole(resamples)} resamples, ` +
      `seed ${protocol.resampling.seed}.`,
    `- Earlier record. ${M}: ` + (previousRun ? ['exploration', 'report'].filter(name => previousRun[name]).map(name =>
      `the earlier ${name} file was replaced (SHA-256 ${code(previousRun[name].sha256)}, ${whole(previousRun[name].bytes)} ` +
      `bytes, last modified ${previousRun[name].modifiedAt})`).join('; ') + '.' : 'none was replaced.'),
    `- Deviations from the protocol. ${M}: ${deviations.length ? `${deviations.length}, each with its reason under "Deviations"` : 'none'}.`,
    '', `${M}: the modules that ran.`, '',
    ...table(['Module', 'SHA-256', 'State against the commit'], codeState.modules.map(m => [code(m.file), code(m.sha256), m.state])));

  section(1);
  if (!k) {
    add(`${M}: no nominee. No family had a setting among its ten highest-scoring distinct settings with a design mean ` +
      'above 0 and neighbours whose median T is above 0, so nothing was run on the confirmation windows for a nominee.');
  } else {
    add(`${M}: ${k} nominee${k === 1 ? '' : 's'}, at most one per family, chosen on the design windows only. With k = ${k} a ` +
      `nominee is confirmed only on at least ${p.minValidConfirmationWindows} valid confirmation windows, with a mean ` +
      `return above 0 and a confirmation p-value below 0.05 / ${k} = ${number(0.05 / k, 4)}.`, '');
    for (const {id, setting, confirmation: c} of nominees)
      add(`- **${id}** (${settingWords(setting)}): **${c.label.toUpperCase()}**. ${M}: mean return ${percent(c.mean)} per ` +
        `window over ${c.n} valid confirmation windows, confirmation p-value ${pValue(c.p)} against ${number(c.threshold, 4)}, ` +
        `mean return at feeBps 10 ${percent(c.fee10.mean)}. In plain words: ${labelWords(c)}.`);
  }
  const confirmedCount = nominees.filter(n => n.confirmation.label !== 'not confirmed').length;
  add('', 'What a label means, and no more:', '',
    '- A confirmed nominee means only that this one setting, chosen on the design windows, also had a positive mean ' +
      'modeled return on the confirmation windows at these cost assumptions. It would justify writing a held-out ' +
      'contract for that setting and nothing more.',
    '- "Not confirmed" is bounded the same way: it says that on these windows at these costs the setting was not ' +
      'confirmed. It does not show a smaller positive mean is absent.',
    ...(confirmedCount ? [] : [`- ${M}: no setting among the ${searched} searched was confirmed on these windows at these costs.`]),
    '- Either outcome is reported with the same prominence.');

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
      'had a positive mean? It is reported with the nominees, not used as a gate. How often it passes simulated ' +
      `no-skill data is in ${code(protocol.file)}, "What the two tests can and cannot do", measured there for 300 ` +
      'settings; `node research/calibration.mjs --settings N` measures it for another number.',
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
    const reg = c.regression;
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
      ...table(['Cost level', 'Valid windows', 'Mean return', 'sd', 'T', 'Skewness', 'Lag-1 autocorrelation', 'p (Student t)',
        'p (resample)', 'Confirmation p (larger of the two)', 'Share of windows above 0', 'Worst window'],
        [['default', c], ['fee10', c.fee10], ['fee40', c.fee40]].map(([name, level]) => levelRow(COST_WORDS[name], level, resamples))),
      '', `Label: **${c.label}**. ${M}: at least ${c.minValidWindows} valid windows: ${yesNo(c.conditions.enoughWindows)} ` +
        `(${c.n}); mean above 0: ${yesNo(c.conditions.positiveMean)}; confirmation p below 0.05 / ${c.k} = ` +
        `${number(c.threshold, 4)}: ${yesNo(c.conditions.pBelowThreshold)} (${pValue(c.p)}); mean above 0 at feeBps 10: ` +
        `${yesNo(c.conditions.positiveMeanFee10)} (${percent(c.meanFee10)}). Only the default row and the feeBps 10 mean ` +
        'decide the label; the other p-values are reported, not used.',
      '', `Reported alongside, not pass/fail. ${M} at default costs: return r regressed on the comparison account's ` +
        `return b over ${whole(reg.n)} windows: intercept ${percent(reg.intercept)} (standard error ${number(reg.seIntercept, 3)}, ` +
        `one-sided p ${pValue(reg.pInterceptGreater)}), slope ${number(reg.slope, 3)} (standard error ${number(reg.seSlope, 3)}); ` +
        `comparison account mean ${percent(c.meanComparison)}; average fills per window ${number(c.meanFills, 1)}; average ` +
        `fees per window $${number(c.meanFees)}. Direction sign test, two-sided, forecasts pooled over the windows: ` +
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
    // What the fetcher noted per month (research/fetch-candles.mjs): answers that held no row, and whether the
    // month's last wanted minute came back. Missing minutes are never filled; they show in the coverage above.
    const noted = test => assets.map(asset => {
      const found = Object.entries(data.manifest.assets[asset]?.months ?? {}).filter(([, entry]) => test(entry)).map(([month]) => month);
      return `${asset} ${found.length ? `${found.length} (${found.slice(0, 4).join(', ')}${found.length > 4 ? ', ...' : ''})` : 'none'}`;
    }).join('; ');
    add(`${M}: receipts, one per stored exchange response: ` + assets.map(asset => `${asset} ${whole(data.receipts[asset].receipts)} ` +
      `receipts in ${whole(data.receipts[asset].files)} files`).join(', ') + '. Months with an exchange answer that held no ' +
      `row: ${noted(entry => entry.emptyResponses > 0)}. Months whose last wanted minute did not come back: ` +
      `${noted(entry => entry.lastBucketPresent === false)}.`, '',
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
      const listed = (deviation.problems ?? []).map(problem => (typeof problem === 'string' ? problem
        : `${problem.asset} ${problem.month}: ${problem.problem}`));
      return [`${i + 1}. **${deviation.option}**: ${code(JSON.stringify(deviation.value))} where the protocol's run has ` +
        `${code(JSON.stringify(deviation.default))}. Reason: ${deviation.reason}`,
        ...listed.slice(0, 12).map(problem => `   - ${problem}`),
        ...(listed.length > 12 ? [`   - and ${listed.length - 12} more, all listed in \`exploration.json\` under \`deviations\``] : [])];
    }));

  section(10);
  add(...LIMITS.map(text => `- ${text}`), '',
    `Two limits no test on these windows can remove (${code(protocol.file)}, "What the two tests can and cannot do"):`, '',
    ...TEST_LIMITS.map(text => `- ${text}`), '',
    `${M}: this run searched ${searched} settings on ${designGrid.designWindows} design windows and ran ${k} ` +
      `nominee${k === 1 ? '' : 's'} on ${windows.length - designGrid.designWindows} confirmation windows.`);
  return `${out.join('\n')}\n`;
}
