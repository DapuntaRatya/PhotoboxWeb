import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import catalog from '../src/template-catalog.json' with { type: 'json' };

const base = process.env.PHOTOBOX_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.PHOTOBOX_TEST_BROWSER || 'chrome' });
const [a, b] = await Promise.all(Array.from({ length: 2 }, () => browser.newPage({ ignoreHTTPSErrors: true })));
const sessions = [];
const session = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('photobox:session:' + location.pathname.split('/')[2])));
const waitLayout = (page, key, id) => page.waitForFunction(([field, value]) => window.roomLayout?.[field] === value, [key, id], { timeout: 8000 });
const pixels = (page) => page.locator('.preview-frame canvas').evaluate((canvas) => canvas.toDataURL());
const ready = (page) => page.getByText('Memuat latar dan bingkai…', { exact: true }).waitFor({ state: 'hidden' });
const select = (page, key, value) => page.evaluate(([field, id]) => {
  window.roomSocket.send(JSON.stringify({ type: 'layout', key: field, value: id }));
}, [key, value]);

try {
  for (const page of [a, b]) {
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          if (!String(args[0]).endsWith('/ws')) return;
          window.roomSocket = this;
          this.addEventListener('message', (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'state') window.roomLayout = data.layout;
          });
        }
      };
    });
  }

  await a.goto(base);
  await a.getByRole('button', { name: 'Buat room baru' }).click();
  await a.getByRole('heading', { name: 'Photo Studio' }).waitFor();
  const first = await session(a);
  sessions.push(first);
  await b.goto(base + '/room/' + first.roomId + '#' + first.invite);
  await b.getByRole('button', { name: 'Gabung room' }).click();
  await b.getByRole('heading', { name: 'Photo Studio' }).waitFor();
  sessions.push(await session(b));
  await select(a, 'frame', 'none');
  await Promise.all([a, b].map((page) => waitLayout(page, 'frame', 'none')));

  let previous = '';
  let origin = a;
  const frameOrder = [...catalog.frames.filter((frame) => frame.art), catalog.frames.find((frame) => frame.id === 'none')];
  for (const [key, items] of [['background', catalog.backgrounds], ['frame', frameOrder]]) {
    const seen = new Set();
    for (const item of items) {
      await select(origin, key, item.id);
      origin = origin === a ? b : a;
      await Promise.all([a, b].map(async (page) => {
        await waitLayout(page, key, item.id);
        await ready(page);
        await page.waitForFunction((prior) => document.querySelector('.preview-frame canvas').toDataURL() !== prior, previous);
      }));
      const [left, right] = await Promise.all([pixels(a), pixels(b)]);
      assert.equal(left, right, item.id + ' differs between clients');
      assert.ok(!seen.has(left), item.id + ' duplicates another render');
      seen.add(left);
      previous = left;
    }
    console.log(key, items.length, 'choices synchronized with identical rendered pixels.');
  }

  let failures = 0;
  await b.route('**/templates/sets/lengkung-pernikahan.webp', async (route) => {
    failures++;
    await route.abort();
  }, { times: 1 });
  await select(a, 'background', 'set-lengkung-pernikahan');
  await Promise.all([a, b].map((page) => waitLayout(page, 'background', 'set-lengkung-pernikahan')));
  await ready(a);
  const final = await pixels(a);
  await b.waitForFunction((expected) => document.querySelector('.preview-frame canvas').toDataURL() === expected, final);
  assert.equal(failures, 1);

  let release;
  const delay = new Promise((resolve) => { release = resolve; });
  const pending = b.route('**/templates/sets/lobi-bioskop.webp', async (route) => {
    await delay;
    await route.continue();
  }, { times: 1 });
  await pending;
  const oldDownload = b.waitForResponse('**/templates/sets/lobi-bioskop.webp');
  await select(a, 'background', 'set-lobi-bioskop');
  await waitLayout(b, 'background', 'set-lobi-bioskop');
  await select(a, 'background', 'set-lengkung-pernikahan');
  await waitLayout(b, 'background', 'set-lengkung-pernikahan');
  release();
  await oldDownload;
  await ready(b);
  assert.equal(await pixels(b), final);

  await b.reload();
  await waitLayout(b, 'background', 'set-lengkung-pernikahan');
  await b.waitForFunction((expected) => document.querySelector('.preview-frame canvas').toDataURL() === expected, final);
  assert.equal(await b.evaluate(() => window.roomLayout.frame), 'none');
  console.log('Asset retry, rapid changes, and rejoin after reload passed.');
} finally {
  for (const item of sessions) {
    await a.evaluate(async ({ roomId, credential }) => {
      await fetch('/api/rooms/' + roomId + '/leave', { method: 'POST', headers: { Authorization: 'Bearer ' + credential } });
    }, item).catch(() => {});
  }
  await browser.close();
}
