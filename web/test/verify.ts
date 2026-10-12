// Checks a run record with the ORIGINAL app's history.js (shape, config/market SHA-256, market unpacks to frames),
// through the repository's own verifier script. Needs `node` on the PATH (it is the test runner).
import {execFileSync} from 'node:child_process';
import {repo} from './server.ts';

export interface Verified {
  configHashOk: boolean; marketHashOk: boolean; frameCount: number; cursor: number; lastObservedAt: number | null;
  lastFrameAt: number | null; historyRestored: boolean; futureFrames: number; scoreStart: number | null; scoreEnd: number | null;
}

export function verifyRecord(record: unknown): Verified {
  const out = execFileSync(process.execPath, [repo('backend/tests/js/verify_record.mjs')], {input: JSON.stringify(record), maxBuffer: 256 * 1024 * 1024, timeout: 120_000});
  return JSON.parse(out.toString('utf8')) as Verified;
}
