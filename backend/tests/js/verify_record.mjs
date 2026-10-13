// Checks a record (stdin) with the EXISTING history.js: shape, hashes, and that the market unpacks to frames.
import {readFileSync} from 'node:fs';
import {canonicalJSON, runMetadata} from '../../../history.js';
import {unpackMarket} from '../../../history.js';

const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(value)))).toString('hex');
const record = JSON.parse(readFileSync(0, 'utf8'));
runMetadata(record);                                   // throws on an invalid/incomplete record
const market = unpackMarket(record.market);
const frames = market.dataset?.frames ?? [];
const out = {configHashOk: await sha(record.config) === record.hashes.configSha256,
  marketHashOk: await sha(record.market) === record.hashes.marketSha256,
  frameCount: frames.length, cursor: market.cursor, lastObservedAt: market.lastObservedFrame?.time ?? null,
  lastFrameAt: frames.at(-1)?.time ?? null, historyRestored: frames.every(f => Array.isArray(f.history?.BTC) && f.history.BTC.length > 0),
  futureFrames: frames.filter(f => f.time > market.lastObservedFrame.time).length, scoreStart: market.scoreStart, scoreEnd: market.scoreEnd};
process.stdout.write(JSON.stringify(out));
