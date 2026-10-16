#!/usr/bin/env node
// Deterministic held-out window selection for docs/EVALUATION_CONTRACT.md.
// Given a seed and an eligible UTC date range, picks non-overlapping windows of whole UTC days
// that avoid every excluded interval. Same inputs always give the same windows, so the choice
// can be fixed before anyone looks at the data. No network, no randomness beyond the seed.
//
//   node scripts/pick-holdout-windows.mjs --seed <text> --from YYYY-MM-DD --to YYYY-MM-DD \
//        [--days 28] [--count 3] [--exclude YYYY-MM-DD/YYYY-MM-DD,...]
//
// Windows are [start, end) at 00:00 UTC; `end` is exclusive and the last window ends at or before --to.
// `lastMinute` (23:59 of the last day) is the inclusive end to give the app's date-range replay.
// --days is capped at 31 because the app's date-range replay covers at most 31 days.
import {createHash} from 'node:crypto';

const MINUTE=60000, DAY=86400000, MAX_DAYS=31;

function day(text){
  if(typeof text!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error(`Expected a UTC date YYYY-MM-DD, got ${JSON.stringify(text)}`);
  const t=Date.parse(text+'T00:00:00Z');
  if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==text)throw new Error(`Invalid UTC date ${text}`);
  return t;
}
const iso=t=>new Date(t).toISOString().slice(0,10);

// Uniform integer in [0, n) from SHA-256(seed, counter), rejecting the biased tail.
function* draws(seed){
  let counter=0;
  for(;;){
    const digest=createHash('sha256').update(`${seed}\n${counter++}`).digest();
    for(let offset=0;offset+4<=digest.length;offset+=4)yield digest.readUInt32BE(offset);
  }
}
function uniform(gen,n){
  const limit=Math.floor(0x100000000/n)*n;
  for(;;){const v=gen.next().value;if(v<limit)return v%n;}
}

export function pickHoldoutWindows({seed,from,to,days=28,count=3,exclude=[]}){
  if(typeof seed!=='string'||!seed)throw new Error('A non-empty --seed is required');
  if(!Number.isInteger(days)||days<1||days>MAX_DAYS)throw new Error(`--days must be an integer from 1 to ${MAX_DAYS}`);
  if(!Number.isInteger(count)||count<1||count>100)throw new Error('--count must be an integer from 1 to 100');
  const start=day(from),end=day(to);
  if(end<=start)throw new Error('--to must be after --from');
  const excluded=exclude.map(e=>{
    const [a,b]=String(e).split('/');const s=day(a),t=b?day(b):s+DAY;
    if(t<=s)throw new Error(`Excluded interval must be increasing: ${e}`);return [s,t];
  });
  const overlaps=(s,t)=>excluded.some(([a,b])=>s<b&&t>a);
  const span=days*DAY;
  const candidates=[];
  for(let s=start;s+span<=end;s+=DAY)if(!overlaps(s,s+span))candidates.push(s);
  const gen=draws(seed),chosen=[];
  while(chosen.length<count){
    const free=candidates.filter(s=>!chosen.some(c=>s<c+span&&s+span>c));
    if(!free.length)throw new Error(`Only ${chosen.length} non-overlapping window(s) of ${days} days fit; asked for ${count}`);
    chosen.push(free[uniform(gen,free.length)]);
  }
  chosen.sort((a,b)=>a-b);
  return {seed,from:iso(start),to:iso(end),days,count,exclude:excluded.map(([a,b])=>`${iso(a)}/${iso(b)}`),
    windows:chosen.map(s=>({start:`${iso(s)}T00:00`,end:`${iso(s+span)}T00:00`,lastMinute:`${iso(s+span-MINUTE)}T23:59`}))};
}

function parseArgs(argv){
  const out={exclude:[]};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];if(!key.startsWith('--'))throw new Error(`Unexpected argument ${key}`);
    const value=argv[++i];if(value===undefined)throw new Error(`Missing value for ${key}`);
    switch(key){
      case '--seed':out.seed=value;break;
      case '--from':out.from=value;break;
      case '--to':out.to=value;break;
      case '--days':out.days=Number(value);break;
      case '--count':out.count=Number(value);break;
      case '--exclude':out.exclude=value.split(',').filter(Boolean);break;
      default:throw new Error(`Unknown option ${key}`);
    }
  }
  return out;
}

if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  try{process.stdout.write(JSON.stringify(pickHoldoutWindows(parseArgs(process.argv.slice(2))),null,2)+'\n');}
  catch(error){process.stderr.write(`pick-holdout-windows: ${error.message}\n`);process.exit(1);}
}
