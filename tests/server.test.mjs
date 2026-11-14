import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';
import { cleanup, TTL } from '../server/storage.mjs';

test('room access, synchronized captures, atomic versions, retention and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'photobox-api-'));
  let now = Date.now();
  let app;
  let base;
  const peers = new Set();
  const config = {
    PHOTOBOX_EXTERNAL_CLEANUP: '1', PHOTOBOX_TURN_URLS: 'turn:example.test:3478',
    PHOTOBOX_TURN_SECRET: 'integration-test-secret',
  };
  async function start() {
    app = await createApp({ dataDir, now: () => now, config });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  function call(path, method = 'GET', credential, body, mime = 'application/json') {
    return fetch(base + '/api' + path, { method, headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(body ? { 'Content-Type': mime } : {}),
    }, body: body && mime === 'application/json' ? JSON.stringify(body) : body });
  }
  async function response(request, status) {
    const result = await request;
    assert.equal(result.status, status, await result.clone().text());
    return result.json();
  }
  function connect(session) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: base });
    peers.add(ws);
    const events = [];
    const send = (message) => ws.send(JSON.stringify(message));
    ws.on('open', () => send({ type: 'auth', roomId: session.roomId, credential: session.credential }));
    ws.on('message', (bytes) => events.push(JSON.parse(bytes)));
    const take = async (type, predicate = () => true) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const index = events.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return events.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw Error(`No ${type} event`);
    };
    return { ws, send, take };
  }
  try {
    await start();
    const sessions = [];
    for (let index = 0; index < 5; index++) sessions.push(await response(call('/rooms', 'POST'), 201));
    await response(call('/rooms', 'POST'), 409);
    const [a, outsider, ...others] = sessions;
    const route = '/rooms/' + a.roomId;
    const album = '/albums/' + a.albumId;
    const b = await response(call(route + '/join', 'POST', undefined, { invite: a.invite }), 201);
    const group = [a, b];
    for (let index = 2; index < 10; index++) group.push(await response(call(route + '/join', 'POST', undefined, { invite: a.invite }), 201));
    assert.equal(new Set(group.map((s) => s.seat)).size, 10);
    await response(call(route + '/join', 'POST', undefined, { invite: a.invite }), 409);
    await response(call(route + '/leave', 'POST', group.at(-1).credential), 200);
    const replacement = await response(call(route + '/join', 'POST', undefined, { invite: a.invite }), 201);
    assert.equal(replacement.seat, group.at(-1).seat);
    await response(call(route + '/ice', 'GET', group.at(-1).credential), 401);
    group[9] = replacement;
    for (const s of group.slice(2)) await response(call(route + '/leave', 'POST', s.credential), 200);
    await response(call(route + '/ice', 'GET', outsider.credential), 401);
    const { iceServers } = await response(call(route + '/ice', 'GET', a.credential), 200);
    assert.ok(iceServers[0].username.startsWith(String(Math.floor(now / 1000) + 3600)));
    assert.equal(iceServers[0].credential, createHmac('sha1', config.PHOTOBOX_TURN_SECRET).update(iceServers[0].username).digest('base64'));
    await response(call(album, 'GET', a.credential), 403);
    const unauthorized = connect({ ...outsider, roomId: a.roomId });
    await unauthorized.take('error');
    for (const s of [outsider, ...others]) await response(call(`/rooms/${s.roomId}/leave`, 'POST', s.credential), 200);
    let A = connect(a);
    const B = connect(b);
    for (const p of [A, B]) await p.take('state', (s) => s.presence.a.online && s.presence.b.online);
    A.ws.close();
    await B.take('state', (s) => !s.presence.a.online);
    A = connect(a);
    const joined = await A.take('state', (s) => s.presence.a.online && s.presence.b.online);
    const link = [joined.presence.a.id, joined.presence.b.id].sort().join(':');
    assert.deepEqual(joined.layout.people.a, { x: 0.5, y: 0.5, scale: 1 });
    assert.deepEqual(joined.layout.people.b, joined.layout.people.a);
    now += TTL * 2;
    A.send({ type: 'layout', key: 'background', value: 'sage' });
    B.send({ type: 'layout', key: 'person', person: 'b', axis: 'x', value: 0.54 });
    const finalLayout = (state) => state.layout.background === 'sage' && state.layout.people.b.x === 0.54;
    assert.deepEqual((await A.take('state', finalLayout)).layout, (await B.take('state', finalLayout)).layout);
    A.send({ type: 'layout', key: 'ratio', value: '16:9' });
    B.send({ type: 'layout', key: 'strip', value: '1x2' });
    for (const p of [A, B]) await p.take('state', (s) => s.layout.ratio === '16:9' && s.layout.strip === '1x2' && s.slots.length === 2);
    A.send({ type: 'layout', key: 'strip', value: '4x1' });
    for (const p of [A, B]) await p.take('state', (s) => s.layout.strip === '4x1' && s.slots.length === 4);
    B.send({ type: 'layout', key: 'frame', value: 'none' });
    const withoutFrame = (state) => state.layout.frame === 'none';
    for (const p of [A, B]) await p.take('state', withoutFrame);
    A.send({ type: 'media', camera: true, links: [link] });
    B.send({ type: 'media', camera: true, links: [link] });
    await A.take('state', (s) => s.presence.a.links.includes(link) && s.presence.b.links.includes(link));
    A.send({ type: 'filter', key: 'brightness', value: 2 });
    A.send({ type: 'mirror', enabled: true });
    B.send({ type: 'filter', key: 'temperature', value: -3 });
    B.send({ type: 'export:request' });
    await B.take('error');

    const jpeg = (background) => sharp({ create: { width: 21, height: 16, channels: 3, background } }).jpeg().toBuffer();
    const first = await jpeg('#d88895');
    const second = await jpeg('#68d4aa');
    const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
    async function capture(slot, succeed = true, bytes = first) {
      B.send({ type: 'capture:request', slot });
      const pending = await A.take('capture:prepare');
      assert.equal(pending.layout.frame, 'none');
      await B.take('capture:prepare', (p) => p.captureId === pending.captureId);
      assert.equal(pending.compositor, 'b');
      assert.equal(pending.filters.a.brightness, slot === 0 ? 2 : 4);
      assert.equal(pending.filters.b.temperature, -3);
      assert.deepEqual(pending.mirrors, { a: slot === 0, b: false });
      A.send({ type: 'filter', key: 'brightness', value: 4 });
      A.send({ type: 'mirror', enabled: false });
      A.send({ type: 'layout', key: 'background', value: 'sky' });
      await A.take('error');
      for (const p of [A, B]) p.send({ type: 'capture:ready', captureId: pending.captureId });
      const { targetTime } = await A.take('capture:start', (p) => p.captureId === pending.captureId);
      assert.equal((await B.take('capture:start', (p) => p.captureId === pending.captureId)).targetTime, targetTime);
      now = targetTime;
      if (!succeed) {
        A.send({ type: 'capture:failed', captureId: pending.captureId });
        await B.take('capture:failed', (p) => p.captureId === pending.captureId);
        return;
      }
      for (const p of [A, B]) p.send({ type: 'capture:stored', captureId: pending.captureId, digest: checksum(bytes) });
      await A.take('capture:committed', (p) => p.captureId === pending.captureId);
      return pending.captureId;
    }
    const slots = [];
    for (let slot = 0; slot < 4; slot++) slots.push(await capture(slot));
    await capture(2, false);
    await A.take('state', (s) => !s.busy && s.slots[2]?.id === slots[2]);
    A.send({ type: 'layout', key: 'strip', value: '2x1' });
    await A.take('error', (e) => e.message.startsWith('Konfirmasi diperlukan'));
    B.send({ type: 'layout', key: 'strip', value: '2x2' });
    for (const p of [A, B]) await p.take('state', (s) => s.layout.strip === '2x2' && s.slots.every((slot, index) => slot.id === slots[index]));
    A.send({ type: 'export:request', slots, strip: '4x1' });
    await A.take('error', (e) => e.message.startsWith('Template photostrip sudah berubah.'));

    async function upload(bytes, broken = false, checkBusy = false) {
      A.send({ type: 'export:request', slots });
      const { exportId } = await A.take('export:started');
      if (checkBusy) {
        B.send({ type: 'slot:clear', slot: 2, id: slots[2] });
        await B.take('error', (e) => e.message === 'Tunggu proses foto atau ekspor selesai.');
      }
      const path = `${route}/exports/${exportId}`;
      await response(call(path + '/commit', 'POST', a.credential), 409);
      for (let index = 0; index < 5; index++) {
        const invalid = broken && index === 2;
        const buffer = invalid ? Buffer.from([255, 216, 1, 2, 255, 217]) : index === 0 || index === 3 ? bytes : first;
        await response(call(path + '/' + index, 'PUT', a.credential, buffer, 'image/jpeg'), invalid ? 415 : 200);
        if (invalid) {
          await A.take('export:failed');
          await response(call(path + '/commit', 'POST', a.credential), 409);
          return;
        }
      }
      return response(call(path + '/commit', 'POST', a.credential), 201);
    }
    await upload(first, true);
    assert.equal((await response(call(album, 'GET', a.albumToken), 200)).versions.length, 0);
    assert.equal((await upload(first, false, true)).version, 1);
    const firstStored = now;
    now += 32 * 60_000;
    const removed = slots[2];
    B.send({ type: 'slot:clear', slot: 4, id: removed });
    await B.take('error', (e) => e.message === 'Slot foto tidak valid.');
    B.send({ type: 'slot:clear', slot: 2, id: removed });
    await B.take('slot:cleared', (e) => e.slot === 2);
    const empty = (s) => !s.busy && s.slots[2] === null && s.slots[3]?.id === slots[3];
    for (const p of [A, B]) await p.take('state', empty);
    const { payload } = app.storage.db.prepare('SELECT payload FROM rooms WHERE id = ?').get(a.roomId);
    assert.equal(JSON.parse(payload).slots[2], null);
    A.send({ type: 'export:request' });
    await A.take('error', (e) => e.message === 'Isi semua slot sebelum mengekspor.');
    assert.equal((await response(call(album, 'GET', a.albumToken), 200)).versions[0].version, 1);
    slots[2] = await capture(2, true, second);
    A.send({ type: 'slot:clear', slot: 2, id: removed });
    await A.take('error', (e) => e.message.startsWith('Isi slot sudah berubah.'));
    A.send({ type: 'export:request', slots: slots.map((id, index) => index === 2 ? removed : id) });
    await A.take('error', (e) => e.message.startsWith('Foto di room sudah berubah.'));
    assert.equal((await upload(second)).version, 2);
    const { versions } = await response(call(album, 'GET', b.albumToken), 200);
    assert.deepEqual(versions.map((version) => version.files.length), [5, 5]);
    const [v2, v1] = versions;
    assert.equal(v1.expires, firstStored + TTL);
    assert.ok(v2.expires > v1.expires);
    const oldFile = album + '/files/' + v1.files[0].id;
    const newFile = album + '/files/' + v2.files[0].id;
    for (const participant of [a, b]) {
      const result = await call(oldFile, 'GET', participant.albumToken);
      assert.equal(result.status, 200);
      assert.equal(checksum(Buffer.from(await result.arrayBuffer())), checksum(first));
    }
    await response(call(oldFile, 'GET', outsider.albumToken), 403);
    now = v1.expires;
    await response(call(oldFile, 'GET', a.albumToken), 410);
    assert.equal((await call(newFile, 'GET', b.albumToken)).status, 200);
    assert.equal((await upload(second)).version, 3);
    await response(call(route + '/leave', 'POST', a.credential), 200);
    await B.take('state', (s) => !s.presence.a && s.presence.b.online);
    await response(call(route + '/leave', 'POST', b.credential), 200);
    await response(call(route + '/ice', 'GET', b.credential), 404);
    assert.equal((await call(newFile, 'GET', b.albumToken)).status, 200);
    await app.close();
    app = undefined;
    await start();
    assert.equal((await call(newFile, 'GET', b.albumToken)).status, 200);
    assert.equal(await cleanup(app.storage, now), 1);
    assert.equal(await cleanup(app.storage, now), 0);
    assert.ok(!(await readdir(app.storage.exports)).includes(v1.id));
    assert.equal(app.storage.db.prepare('SELECT 1 FROM versions WHERE id = ?').get(v1.id), undefined);
    assert.ok((await readdir(app.storage.exports)).includes(v2.id));
    now += TTL * 2;
    await cleanup(app.storage, now);
    await response(call(album, 'GET', b.albumToken), 410);
  } finally {
    for (const socket of peers) socket.terminate();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
