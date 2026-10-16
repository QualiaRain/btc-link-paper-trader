// Coverage is part of the answer. One sentence, shared by the run view and the history cards, that says what the
// source data held, what was missing, how it was obtained and how many observations the run itself lost.
// `coverage` is a per-asset block (sample window or scored date range, as recorded by market.js `sampleCoverage`
// or replay.js `fetchHistoricalRange`), `receipts` the number of fetch receipts stored with the run (null when the
// record does not say), `summary` carries the run's own `gapEvents` and `invalidFrames`. Legacy records may omit any
// of these, and the line says so instead of showing zeros.
const ASSETS = ['BTC', 'LINK'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const count = n => n.toLocaleString('en-US');

export function coverageLine({kind, mode, coverage, receipts, summary}) {
  const counts = summary && Number.isFinite(summary.gapEvents) && Number.isFinite(summary.invalidFrames)
    ? `${plural(summary.gapEvents, 'observation gap')} · ${plural(summary.invalidFrames, 'invalid frame')}`
    : 'gap and invalid-frame counts not recorded';
  if (mode === 'live') return `Live quotes: no minute coverage is expected · ${counts}.`;
  const per = coverage && ASSETS.map(asset => {
    const c = coverage[asset];
    return c && [c.observedCount, c.expectedCount, c.missingCount].every(Number.isFinite)
      ? `${asset} ${count(c.observedCount)} of ${count(c.expectedCount)} minutes observed, ${count(c.missingCount)} missing` : null;
  });
  const window = kind === 'sample' ? 'Sample window (warmup included)' : 'Scored range';
  const source = receipts == null ? 'fetch receipts not recorded'
    : kind === 'sample' ? `${plural(receipts, 'fetch receipt')} (bundled data, no fetch)` : plural(receipts, 'fetch receipt');
  return `${per && per.every(Boolean) ? `${window}: ${per.join(' · ')}` : 'Minute coverage not recorded for this run'} · ${source} · ${counts}.`;
}
