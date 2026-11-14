import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const base = (process.env.PHOTOBOX_TEST_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const temp = await mkdtemp(join(tmpdir(), 'photobox-camera-'));
const fixture = join(temp, 'camera.y4m');
const width = 640, height = 480;
const rgb = await sharp('public/booth-example.webp').resize(width, height).removeAlpha().raw().toBuffer();
const frame = Buffer.alloc(width * height * 3 / 2);
const color = (value) => Math.max(0, Math.min(255, Math.round(value)));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const [r, g, b] = rgb.subarray(index * 3, index * 3 + 3);
    frame[index] = color(16 + 0.257 * r + 0.504 * g + 0.098 * b);
    if (y % 2 === 0 && x % 2 === 0) {
      const chroma = y / 2 * (width / 2) + x / 2;
      frame[width * height + chroma] = color(128 - 0.148 * r - 0.291 * g + 0.439 * b);
      frame[width * height * 5 / 4 + chroma] = color(128 + 0.439 * r - 0.368 * g - 0.071 * b);
    }
  }
}
await writeFile(fixture, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F24:1 Ip A1:1 C420jpeg\nFRAME\n`), frame]));
let browser;
let session;
let peerSession;
let thirdSession;
try {
  browser = await chromium.launch({
    channel: process.env.PHOTOBOX_TEST_BROWSER || 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  });
  const a = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  const b = await browser.newContext({ permissions: ['camera', 'microphone'] });
  for (const browserContext of [a, b]) await browserContext.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const connections = window.photoboxTestConnections = [];
    window.RTCPeerConnection = class extends Native {
      constructor(config) {
        super(config);
        connections.push(this);
      }
    };
  });
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const c = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pageC = await c.newPage();
  const screenshot = process.env.PHOTOBOX_TEST_SCREENSHOTS;
  for (const [label, page] of [['A', pageA], ['B', pageB], ['C', pageC]]) {
    page.on('pageerror', (error) => console.error(label, error));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) console.warn(label, message.text());
    });
  }
  await pageA.goto(base);
  if (screenshot) {
    await pageA.locator('h1').waitFor();
    await pageA.screenshot({ path: join(screenshot, 'home.png'), fullPage: true });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
    await mobile.goto(base);
    await mobile.locator('h1').waitFor();
    await mobile.screenshot({ path: join(screenshot, 'mobile.png'), fullPage: true });
    await mobile.close();
  }
  await pageA.getByRole('button', { name: 'Buat room baru' }).click();
  await pageA.getByRole('heading', { name: 'Photo Studio' }).waitFor();
  session = await pageA.evaluate(() => JSON.parse(sessionStorage.getItem(`photobox:session:${location.pathname.split('/').at(-1)}`)));
  await pageA.getByRole('button', { name: 'Aktifkan kamera dan mikrofon' }).click();
  await pageA.getByRole('button', { name: 'Ambil foto 1' }).click();
  await pageA.getByRole('button', { name: 'Slot 1, terisi' }).locator('img').waitFor({ timeout: 45_000 });
  await pageA.getByRole('button', { name: 'Slot 1, terisi' }).click();
  console.info('Foto solo tersimpan.');
  await pageA.getByRole('button', { name: 'Undangan' }).click();
  const invite = await pageA.evaluate(() => navigator.clipboard.readText());
  assert.ok(invite.includes(session.invite));
  await pageB.goto(invite);
  await pageB.getByRole('button', { name: 'Gabung room' }).click();
  await pageB.getByRole('heading', { name: 'Photo Studio' }).waitFor();
  peerSession = await pageB.evaluate(() => JSON.parse(sessionStorage.getItem(`photobox:session:${location.pathname.split('/').at(-1)}`)));
  await pageC.goto(invite);
  await pageC.getByRole('button', { name: 'Gabung room' }).click();
  await pageC.getByRole('heading', { name: 'Photo Studio' }).waitFor();
  thirdSession = await pageC.evaluate(() => JSON.parse(sessionStorage.getItem(`photobox:session:${location.pathname.split('/').at(-1)}`)));
  await Promise.all([pageB, pageC].map(async (page) => {
    await page.getByRole('button', { name: 'Nyalakan kamera' }).click();
    await page.getByRole('button', { name: 'Nyalakan mikrofon' }).click();
    await page.getByRole('button', { name: 'Slot 1, terisi' }).locator('img').waitFor();
  }));
  const captureButton = (page, slot) => page.getByRole('button', { name: `Ambil foto ${slot}` });
  const previewButton = (page) => page.getByRole('button', { name: 'Pratinjau & edit', exact: true });
  async function saveAlbum(page, edit = false) {
    await previewButton(page).click();
    const editor = page.getByRole('dialog', { name: 'Edit photostrip' });
    const save = editor.getByRole('button', { name: 'Simpan ke album' });
    const stage = editor.getByRole('img', { name: 'Hasil gabungan foto dan teks' });
    if (edit) {
      await editor.getByLabel('Teks', { exact: true }).waitFor();
      const before = await stage.evaluate((node) => node.toDataURL());
      await editor.getByRole('button', { name: 'Hapus teks' }).click();
      await editor.getByText('Belum ada teks pada photostrip.').waitFor();
      await editor.getByRole('button', { name: 'Tambah teks' }).click();
      await editor.getByLabel('Teks', { exact: true }).fill('Foto bersama');
      await editor.getByLabel('Font', { exact: true }).selectOption('Georgia');
      await editor.getByLabel('Warna', { exact: true }).fill('#1462a0');
      await editor.getByRole('button', { name: 'Miring', exact: true }).click();
      const after = await stage.evaluate((node) => node.toDataURL());
      assert.notEqual(before, after);
    }
    await save.click();
    await editor.waitFor({ state: 'hidden', timeout: 35_000 });
  }
  const enabled = (locator) => locator.and(locator.page().locator(':enabled')).waitFor({ timeout: 30_000 });
  await enabled(pageA.getByRole('button', { name: 'Retake slot 1' }));
  await enabled(pageB.getByRole('button', { name: 'Retake slot 1' }));
  const sliders = (page, label) => page.getByRole('slider', { name: label, exact: true });
  assert.equal(await sliders(pageA, 'Skala').inputValue(), '100');
  assert.equal(await sliders(pageA, 'Horizontal').inputValue(), '50');
  const editor = pageA.locator('.layer-editor');
  await editor.scrollIntoViewIfNeeded();
  const box = await editor.boundingBox();
  assert.ok(box);
  await pageA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pageA.mouse.down();
  await pageA.mouse.move(box.x + box.width * 0.37, box.y + box.height / 2, { steps: 5 });
  await pageA.mouse.up();
  await pageB.getByRole('button', { name: /Peserta 1 Kamera aktif/ }).click();
  assert.equal(await sliders(pageB, 'Horizontal').inputValue(), '37');
  const handle = await pageA.locator('[data-corner=se]').boundingBox();
  assert.ok(handle);
  await pageA.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await pageA.mouse.down();
  await pageA.mouse.move(handle.x + handle.width / 2 - 48, handle.y + handle.height / 2 - 48, { steps: 5 });
  await pageA.mouse.up();
  await pageB.waitForFunction(() => Number(document.querySelector('input[aria-label=Skala]').value) < 100);
  await pageA.getByRole('button', { name: 'Ke depan', exact: true }).click();
  await pageB.waitForFunction(() => document.querySelectorAll('.layer-list button')[1].textContent.includes('Peserta 1'));
  await Promise.all([pageA, pageB].map((page) => page.waitForFunction(async () => {
    for (const pc of window.photoboxTestConnections) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      if ([...stats.values()].some((report) => report.type === 'inbound-rtp' &&
        report.kind === 'audio' && report.packetsReceived > 0)) return true;
    }
    return false;
  })));
  if (process.env.PHOTOBOX_TEST_RELAY === '1') {
    await Promise.all([pageA, pageB].map((page) => page.getByText('Terhubung melalui TURN', { exact: true }).waitFor()));
  }
  const canvasState = (page) => page.locator('canvas').evaluate((canvas) => canvas.toDataURL());
  const unfiltered = await canvasState(pageB);
  await pageA.getByRole('button', { name: 'Kamera', exact: true }).click();
  await pageA.getByRole('slider', { name: 'Brightness' }).fill('2');
  assert.equal(await pageA.getByRole('slider', { name: 'Brightness' }).inputValue(), '2');
  await pageB.waitForFunction((before) => document.querySelector('canvas').toDataURL() !== before, unfiltered);
  const beforeMirror = await Promise.all([pageA, pageB].map(canvasState));
  const mirror = pageA.getByRole('switch', { name: 'Mirror kamera' });
  await mirror.check();
  assert.ok(await mirror.isChecked());
  await Promise.all([pageA, pageB].map((page, index) =>
    page.waitForFunction((before) => document.querySelector('canvas').toDataURL() !== before, beforeMirror[index])));
  await pageB.getByRole('button', { name: 'Kamera', exact: true }).click();
  assert.equal(await pageB.getByRole('switch', { name: 'Mirror kamera' }).isChecked(), false);
  await pageB.getByRole('button', { name: 'Komposisi' }).click();
  await pageA.getByRole('button', { name: 'Komposisi' }).click();
  await pageA.getByRole('button', { name: '6 foto 3×2', exact: true }).click();
  await pageB.getByRole('button', { name: 'Slot 6, kosong' }).waitFor();
  await pageB.getByRole('button', { name: '8 foto 4×2', exact: true }).click();
  await pageA.getByRole('button', { name: 'Slot 8, kosong' }).waitFor();
  await pageB.getByRole('button', { name: '4 foto 4×1', exact: true }).click();
  await pageB.getByRole('button', { name: '9:16' }).click();
  await pageA.waitForFunction(() => document.querySelector('canvas').width * 16 === document.querySelector('canvas').height * 9);
  await pageB.getByRole('button', { name: '1:1' }).click();
  await pageA.waitForFunction(() => document.querySelector('canvas').width === document.querySelector('canvas').height);
  await pageB.getByRole('button', { name: '4:3' }).click();
  const preset = await canvasState(pageA);
  await pageB.locator('input[type=file]').setInputFiles('public/booth-example.webp');
  await pageA.waitForFunction((before) => document.querySelector('canvas').toDataURL() !== before, preset);
  await Promise.all([pageA, pageB, pageC].map((page) => page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.template-grid .template-card')];
    return cards.length > 0 && cards.every((button) => button.getAttribute('aria-pressed') === 'false');
  })));
  if (screenshot) await pageA.screenshot({ path: join(screenshot, 'studio.png'), fullPage: true });
  for (let slot = 1; slot <= 4; slot++) {
    const prior = slot === 1 ? await pageA.locator('.slot img').first().getAttribute('src') : undefined;
    if (slot === 1) await pageA.getByRole('button', { name: 'Retake slot 1' }).click();
    else await captureButton(pageA, slot).click();
    await Promise.all([pageA, pageB, pageC].map((page) => page.locator('.countdown').waitFor()));
    if (prior) await pageA.waitForFunction((src) => document.querySelector('.slot img')?.getAttribute('src') !== src, prior);
    await Promise.all([pageA, pageB, pageC].map((page) => page.getByRole('button', { name: `Slot ${slot}, terisi` }).locator('img').waitFor({ timeout: 50_000 })));
    console.info(`Slot ${slot} tersinkron.`);
  }
  const keys = () => pageA.locator('.slot img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  const before = await keys();
  await saveAlbum(pageB, true);
  await pageA.getByText('Versi 1 tersimpan.', { exact: false }).waitFor({ timeout: 35_000 });
  const albumPath = `/album/${session.albumId}#${session.albumToken}`;
  const [albumA, albumB] = await Promise.all([a.newPage(), b.newPage()]);
  await Promise.all([albumA.goto(base + albumPath), albumB.goto(base + albumPath)]);
  await albumA.getByRole('button', { name: 'Lihat Foto 3', exact: true }).click();
  await albumA.getByRole('dialog').getByRole('img', { name: 'Foto 3' }).waitFor();
  await albumA.getByRole('button', { name: 'Tutup foto' }).click();
  const albumFetch = async () => (await fetch(base + `/api/albums/${session.albumId}`, {
    headers: { Authorization: `Bearer ${session.albumToken}` },
  })).json();
  const fileBytes = async (file) => {
    const response = await fetch(base + `/api/albums/${session.albumId}/files/${file.id}`, {
      headers: { Authorization: `Bearer ${session.albumToken}` },
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const download = async (page) => {
    const item = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Unduh Photostrip', exact: true }).first().click();
    return createHash('sha256').update(await readFile(await (await item).path())).digest('hex');
  };
  const [hashA, hashB] = await Promise.all([download(albumA), download(albumB)]);
  assert.equal(hashA, hashB);
  const { versions: [firstVersion] } = await albumFetch();
  const mirrored = await fileBytes(firstVersion.files[3]);
  await Promise.all([albumA.close(), albumB.close()]);
  await pageA.getByRole('button', { name: 'Kamera', exact: true }).click();
  await mirror.uncheck();
  await pageA.getByRole('button', { name: 'Slot 3, terisi' }).click();
  await pageA.getByRole('button', { name: 'Retake slot 3' }).click();
  await pageA.waitForFunction((url) => document.querySelectorAll('.slot img')[2]?.getAttribute('src') !== url, before[2]);
  await pageA.getByRole('button', { name: 'Slot 3, terisi' }).locator('img').waitFor();
  const after = await keys();
  assert.equal(after.length, 4);
  assert.notEqual(after[2], before[2]);
  assert.deepEqual(after.filter((_, index) => index !== 2), before.filter((_, index) => index !== 2));
  await saveAlbum(pageB);
  await pageA.getByText('Versi 2 tersimpan.', { exact: false }).waitFor();
  const { versions: [secondVersion] } = await albumFetch();
  const original = await fileBytes(secondVersion.files[3]);
  const thumbnail = (buffer) => sharp(buffer).resize(120, 90).raw().toBuffer();
  const [flipped, regular] = await Promise.all([thumbnail(mirrored), thumbnail(original)]);
  const meanDelta = flipped.reduce((sum, value, index) => sum + Math.abs(value - regular[index]), 0) / flipped.length;
  assert.ok(meanDelta > 2, `Mode mirror harus mengubah orientasi foto, mean delta ${meanDelta}`);
  assert.deepEqual(await fileBytes(firstVersion.files[3]), mirrored);
  for (const position of [1, 2, 4]) {
    assert.deepEqual(await fileBytes(firstVersion.files[position]), await fileBytes(secondVersion.files[position]));
  }
  await mirror.check();
  await pageA.getByRole('button', { name: 'Komposisi' }).click();
  for (const count of [6, 8]) {
    await pageA.getByRole('button', { name: `${count} foto ${count / 2}×2`, exact: true }).click();
    for (let slot = count - 1; slot <= count; slot++) {
      await pageB.getByRole('button', { name: `Slot ${slot}, kosong` }).click();
      await captureButton(pageB, slot).click();
      await pageA.getByRole('button', { name: `Slot ${slot}, terisi` }).locator('img').waitFor({ timeout: 50_000 });
    }
    await saveAlbum(pageA);
    const versionNumber = count / 2;
    await pageB.getByText(`Versi ${versionNumber} tersimpan.`, { exact: false }).waitFor({ timeout: 35_000 });
    const { versions } = await albumFetch();
    assert.equal(versions[0].version, versionNumber);
    assert.equal(versions[0].files.length, count + 1);
    console.info(`Ekspor template ${count} slot menghasilkan ${count + 1} berkas.`);
  }
  await pageC.getByRole('button', { name: 'Slot 8, terisi' }).click();
  const removePhoto = pageC.getByRole('button', { name: 'Hapus foto 8' });
  const clearDialog = pageC.getByRole('dialog', { name: 'Hapus foto slot 8?' });
  await removePhoto.click();
  await clearDialog.getByRole('img', { name: 'Foto 8' }).waitFor();
  await clearDialog.getByRole('button', { name: 'Batal' }).click();
  assert.equal(await pageC.getByRole('button', { name: 'Slot 8, terisi' }).count(), 1);
  await removePhoto.click();
  await pageC.keyboard.press('Escape');
  await clearDialog.waitFor({ state: 'hidden' });
  assert.equal(await pageC.getByRole('button', { name: 'Slot 8, terisi' }).count(), 1);
  await removePhoto.click();
  await clearDialog.getByRole('button', { name: 'Hapus foto', exact: true }).click();
  for (const page of [pageA, pageB, pageC]) {
    await page.getByRole('button', { name: 'Slot 8, kosong' }).waitFor();
    assert.equal(await previewButton(page).isDisabled(), true);
  }
  assert.equal(await captureButton(pageC, 8).count(), 1);
  assert.equal((await albumFetch()).versions[0].files.length, 9);
  for (const page of [pageA, pageB, pageC]) {
    await page.getByRole('button', { name: 'Matikan kamera', exact: true }).click();
    await page.getByRole('button', { name: 'Nyalakan kamera', exact: true }).waitFor();
  }
  await pageA.reload();
  await pageA.getByRole('button', { name: 'Slot 3, terisi' }).locator('img').waitFor();
  await pageA.getByRole('button', { name: 'Slot 8, kosong' }).waitFor();
  await pageA.getByRole('button', { name: 'Kamera', exact: true }).click();
  assert.ok(await pageA.getByRole('switch', { name: 'Mirror kamera' }).isChecked());
  for (const page of [pageC, pageA, pageB]) {
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Keluar' }).click();
    await page.getByRole('heading', { name: 'Versi 2' }).waitFor();
  }
  assert.equal(await pageB.getByRole('heading', { name: 'Versi 1' }).count(), 1);
  console.info(`Alur tiga browser, retake, hapus foto, ekspor ulang, reload, dan album setelah room ditutup lulus. SHA-256 ${hashA}`);
} finally {
  for (const s of [session, peerSession, thirdSession]) {
    if (s) await fetch(`${base}/api/rooms/${s.roomId}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${s.credential}` } }).catch(() => {});
  }
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
