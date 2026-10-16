// Drive the root JavaScript app too: TS-client snapshot tests cannot catch root-app regressions.
import {after, before, it} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import type {Browser, Page} from 'playwright-core';
import {repo} from './server.ts';
import {launch} from './support.ts';

let server: Server, browser: Browser | undefined, baseUrl: string, problem = '';
before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^[a-z-]+\.(js|css|html)$/.test(file) && file !== 'data/sample.json') {
      response.writeHead(404).end(); return;
    }
    try {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html';
      response.writeHead(200, {'content-type': type}).end(readFileSync(repo(file)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  ({browser, problem} = await launch());
});
after(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

async function open(): Promise<Page> {
  const page = await browser!.newPage({acceptDownloads: true});
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl);
  await page.waitForFunction(() => !document.body.classList.contains('busy') && !document.getElementById('start-replay')!.hasAttribute('disabled'));
  return page;
}

for (const fixture of ['browser-run-completed.json', 'browser-run-live-partial.json', 'browser-run-partial-manual.json']) {
  it(`root legacy snapshot preserves unavailable counts and exported evidence: ${fixture}`, async t => {
    if (!browser) { t.skip(problem); return; }
    const page = await open();
    try {
      const record = JSON.parse(readFileSync(repo(`parity/fixtures/${fixture}`), 'utf8'));
      assert.equal(record.summary.gapEvents, undefined);
      assert.equal(record.summary.invalidFrames, undefined);
      await page.evaluate(async record => {
        // Keep the dynamic import inside the browser; tsc's import-rewrite helper belongs to Node.
        await new Function('record', "return import('/history.js').then(m => m.saveRun(record))")(record);
      }, record);
      await page.click('#view-history');
      const card = page.locator('.history-card').filter({hasText: record.name});
      assert.match(await card.locator('.coverage-line').innerText(), /gap and invalid-frame counts not recorded/);
      await card.getByRole('button', {name: 'Open snapshot'}).click();
      await page.waitForFunction(() => document.getElementById('mode-badge')!.textContent!.includes('read-only snapshot'));
      assert.match(await page.locator('#coverage-detail').innerText(), /gap and invalid-frame counts not recorded/);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('mode-badge')!.textContent!.includes('read-only snapshot'));
      assert.match(await page.locator('#coverage-detail').innerText(), /gap and invalid-frame counts not recorded/);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
      assert.deepEqual(JSON.parse(readFileSync((await download.path())!, 'utf8')), record,
        'read-only export preserves the stored record, including omitted counts, timestamps and hashes');
    } finally { await page.close(); }
  });
}

it('root new sample run and its snapshot show recorded coverage and verified zero event counts', async t => {
  if (!browser) { t.skip(problem); return; }
  const page = await open();
  try {
    await page.click('#start-replay');
    await page.waitForFunction(() => document.getElementById('coverage-detail')!.textContent!.includes('1,648 of 1,800'));
    const expected = await page.locator('#coverage-detail').innerText();
    assert.match(expected, /Sample window \(warmup included\)/);
    assert.match(expected, /152 missing/);
    assert.match(expected, /0 observation gaps · 0 invalid frames/);
    await page.click('#view-history');
    const card = page.locator('.history-card').first();
    assert.equal(await card.locator('.coverage-line').innerText(), expected);
    await card.getByRole('button', {name: 'Open snapshot'}).click();
    await page.waitForFunction(() => document.getElementById('mode-badge')!.textContent!.includes('read-only snapshot'));
    assert.equal(await page.locator('#coverage-detail').innerText(), expected);
    await page.click('#view-config');
    await page.click('#new-account');
    await page.click('#config-start-replay');
    await page.waitForFunction(() => document.getElementById('mode-badge')!.textContent!.includes('paused / partial'));
    assert.equal(await page.locator('#coverage-detail').innerText(), expected, 'a new run uses its own summary');
  } finally { await page.close(); }
});
