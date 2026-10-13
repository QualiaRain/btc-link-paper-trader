// Plain-language verdict on whether the forecast rule beat the same-price baseline.
// Uses an exact two-sided sign test on which forecast landed closer; ties are excluded.

export const MIN_FORECASTS = 30;
export const SIGNIFICANCE = 0.05;

function logChoose(n,k) {
  let s=0;
  for (let i=1;i<=k;i++) s+=Math.log(n-k+i)-Math.log(i);
  return s;
}

// Probability of a split at least this lopsided if each forecast were a coin flip.
export function signTestPValue(wins,losses) {
  const n=wins+losses;
  if (!n) return 1;
  const k=Math.min(wins,losses);
  let tail=0;
  for (let i=0;i<=k;i++) tail+=Math.exp(logChoose(n,i)-n*Math.LN2);
  return Math.min(1,2*tail);
}

const LABELS = {
  baseline:'Baseline rule',
  none:'No scored forecasts yet',
  too_few:'Too few to judge',
  better:'Better than “no change”',
  worse:'Worse than “no change”',
  mixed:'Mixed result',
  unclear:'No clear difference',
};

export function gradeAsset(stats,model) {
  const wins=stats?.modelCloser??0,losses=stats?.samePriceCloser??0,ties=stats?.ties??0;
  const decided=wins+losses,count=stats?.count??0;
  const maeChangePct=stats?.mae!=null&&stats.samePriceMae>0?100*(stats.mae-stats.samePriceMae)/stats.samePriceMae:null;
  const base={count,wins,losses,ties,decided,maeChangePct,pValue:null};
  let verdict;
  if (model==='same-price') verdict='baseline';
  else if (!count) verdict='none';
  else if (decided<MIN_FORECASTS) verdict='too_few';
  else {
    base.pValue=signTestPValue(wins,losses);
    const smallerMisses=stats.mae<=stats.samePriceMae;
    if (base.pValue>=SIGNIFICANCE) verdict='unclear';
    else if (wins>losses) verdict=smallerMisses?'better':'mixed';
    else verdict=smallerMisses?'mixed':'worse';
  }
  return {...base,verdict,label:LABELS[verdict]};
}

export function reportCard(summary,model) {
  return Object.fromEntries(Object.entries(summary?.perAsset??{}).map(([asset,stats])=>[asset,gradeAsset(stats,model)]));
}
