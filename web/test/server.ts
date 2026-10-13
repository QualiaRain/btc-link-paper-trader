// Starts the real Python API (uvicorn in a child process, ephemeral port, temp run directory).
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as {port: number};
      probe.close(() => resolve(port));
    });
  });
}

export interface RunningApi {
  baseUrl: string;
  stop(): void;
}

/** Needs `python3` with the backend installed (override with $PYTHON). Serves web/public too. */
export async function startApi(options: {env?: Record<string, string>} = {}): Promise<RunningApi> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'paper-trail-test-'));
  let log = '';
  const server: ChildProcess = spawn(process.env['PYTHON'] ?? 'python3',
    ['-m', 'uvicorn', '--factory', 'paper_trail.api:create_app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: repo('backend'), env: {...process.env, PAPER_TRAIL_DATA_DIR: dataDir, PYTHONDONTWRITEBYTECODE: '1', ...options.env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
  server.stdout?.on('data', chunk => { log += String(chunk); });
  server.stderr?.on('data', chunk => { log += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = (): void => { server.kill('SIGTERM'); rmSync(dataDir, {recursive: true, force: true}); };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Python API exited early:\n${log}`);
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return {baseUrl, stop};
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  stop();
  throw new Error(`Python API did not start:\n${log}`);
}
