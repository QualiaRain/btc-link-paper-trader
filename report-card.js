// Plain-language verdict on whether the forecast rule called price direction better than chance.
// A rule with no skill calls direction right half the time, so an exact two-sided sign test on
// direction hits vs misses is a fair check; flat predictions or outcomes are excluded.
// ("Closer than no change" is not a fair check: a nonzero forecast with no skill lands closer
// less than half the time, so it would always look worse.)

export const MIN_FORECASTS = 30;
// Two assets are graded, so each needs stronger evidence than a single 5% test.
export const SIGNIFICANCE = 0.025;

// Probability of a split at least this far from 50/50 if each call were a coin flip.
export function signTestPValue(hits,misses) {
  const n=hits+misses;
  if (!n) return 1;
  const k=Math.min(hits,misses);
  let logP=-n*Math.LN2,tail=0;
  for (let i=0;i<=k;i++) {
    tail+=Math.exp(logP);
    logP+=Math.log(n-i)-Math.log(i+1);
  }
  return Math.min(1,2*tail);
}

// Half-width, in percentage points, of the range a no-skill rule lands in 95% of the time.
export function detectableEdgePts(n) {
  return n?100*1.96*Math.sqrt(.25/n):null;
}

const LABELS = {
  baseline:'Baseline rule',
  none:'No scored forecasts yet',
  too_few:'Too few to judge',
  better:'Better than chance',
  worse:'Worse than chance',
  unclear:'No clear skill',
};

export function gradeAsset(stats,model) {
  const hits=stats?.directionHits??0,misses=stats?.directionMisses??0,flat=stats?.directionFlat??0;
  const decided=hits+misses,count=stats?.count??0;
  const maeChangePct=stats?.mae!=null&&stats.samePriceMae>0?100*(stats.mae-stats.samePriceMae)/stats.samePriceMae:null;
  const base={count,hits,misses,flat,decided,hitRatePct:decided?100*hits/decided:null,
    detectablePts:detectableEdgePts(decided),maeChangePct,pValue:null};
  let verdict;
  if (model==='same-price') verdict='baseline';
  else if (!count) verdict='none';
  else if (decided<MIN_FORECASTS) verdict='too_few';
  else {
    base.pValue=signTestPValue(hits,misses);
    verdict=base.pValue>=SIGNIFICANCE?'unclear':hits>misses?'better':'worse';
  }
  return {...base,verdict,label:LABELS[verdict]};
}

export function reportCard(summary,model) {
  return Object.fromEntries(Object.entries(summary?.perAsset??{}).map(([asset,stats])=>[asset,gradeAsset(stats,model)]));
}
