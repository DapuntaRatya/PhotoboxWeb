import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { WebSocket, WebSocketServer } from 'ws';
import { cleanup, EXPORT_WINDOW, openStorage, transaction, TTL } from './storage.mjs';
import catalog from '../src/template-catalog.json' with { type: 'json' };
import formats from '../src/photo-formats.json' with { type: 'json' };

const token = () => randomBytes(32).toString('base64url');
const id = () => randomBytes(16).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cameraFilters = ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint'];
const neutral = Object.fromEntries(cameraFilters.map((key) => [key, 0]));
const backgroundIds = new Set(catalog.backgrounds.map(({ id }) => id));
const frameIds = new Set(catalog.frames.map(({ id }) => id));
const maxFile = 16 * 1024 ** 2;
const diskReserve = 128 * 1024 ** 2;
const disconnectGrace = 30 * 60_000;
const seats = 'abcdefghij'.split('');
const fullFrame = () => ({ x: 0.5, y: 0.5, scale: 1 });
const pairKey = (a, b) => [a, b].sort().join(':');
const linkId = (room, a, b) => room.links.get(pairKey(a, b)) ?? pairKey(a, b);
const initialLayout = () => ({
  revision: 0, background: 'rose', frame: 'paper', ratio: '4:3', strip: formats.defaultStrip, count: formats.strips[formats.defaultStrip].count,
  people: { a: fullFrame() }, order: ['a'],
});
const clamp = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const fail = (status, message) => Object.assign(new Error(message), { status });
const timestamp = () => Date.now();
const keyPattern = /^[a-f0-9]{32}$/;
const assetPattern = /^[a-f0-9]{64}$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    req.resume();
    throw fail(413, 'Ukuran unggahan terlalu besar.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw fail(413, 'Ukuran unggahan terlalu besar.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(req) {
  try {
    const body = JSON.parse(await readBody(req, 8192));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch (error) {
    if (error.status) throw error;
  }
  throw fail(400, 'Data permintaan tidak valid.');
}

function patchLayout(layout, patch) {
  const { key, value, person, axis } = patch;
  const layer = layout.people[person];
  const ranges = { x: [-1, 2], y: [-1, 2], scale: [0.1, 3] };
  if (key === 'background' && backgroundIds.has(value)) {
    layout.background = value;
  } else if (key === 'frame' && frameIds.has(value)) {
    layout.frame = value;
  } else if (key === 'ratio' && typeof value === 'string' && Object.hasOwn(formats.ratios, value)) {
    layout.ratio = value;
  } else if (key === 'person' && seats.includes(person) && layer && Object.hasOwn(ranges, axis) && clamp(value, ...ranges[axis])) {
    layer[axis] = value;
  } else if (key === 'transform' && seats.includes(person) && layer && value && Object.entries(ranges).every(([axis, range]) => clamp(value[axis], ...range))) {
    layout.people[person] = { x: value.x, y: value.y, scale: value.scale };
  } else if (key === 'order' && seats.includes(person) && layer && [-1, 1].includes(value)) {
    const index = layout.order.indexOf(person);
    const next = index + value;
    if (next < 0 || next >= layout.order.length) return;
    [layout.order[index], layout.order[next]] = [layout.order[next], layout.order[index]];
  } else {
    throw fail(400, 'Pengaturan tidak valid.');
  }
  layout.revision++;
}

export async function createApp({ dataDir, now = timestamp, config = process.env } = {}) {
  const storage = await openStorage(dataDir);
  const { db, exports } = storage;
  const rooms = new Map();
  const connections = new Map();
  const save = db.prepare('INSERT INTO rooms(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const persist = (room) => save.run(room.id, JSON.stringify(room.data));
  const getConnections = (room) => connections.get(room.id) ?? {};
  const send = (ws, event) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) return ws.terminate();
    ws.send(JSON.stringify(event));
  };
  const broadcast = (room, event) => Object.values(getConnections(room)).forEach((ws) => send(ws, event));
  const limits = new Map();
  const log = (event, fields = {}) => console.info(JSON.stringify({ event, ...fields }));

  for (const row of db.prepare('SELECT * FROM rooms').all()) {
    const data = JSON.parse(row.payload);
    data.offlineSince ??= now();
    const { layout } = data;
    if (!Object.hasOwn(formats.strips, layout.strip)) {
      layout.strip = formats.legacyStrips[layout.count] ?? formats.defaultStrip;
      layout.revision++;
    }
    layout.count = formats.strips[layout.strip].count;
    if (!backgroundIds.has(layout.background) && !assetPattern.test(layout.background ?? '')) {
      layout.background = 'rose';
      layout.revision++;
    }
    if (!frameIds.has(layout.frame)) {
      layout.frame = 'paper';
      layout.revision++;
    }
    const active = Object.keys(data.seats).filter((seat) => !data.seats[seat].left);
    if (!data.layout.order) {
      data.layout.order = active;
      data.layout.people = Object.fromEntries(active.map((seat) => [seat, fullFrame()]));
      data.layout.revision++;
    }
    for (const [seat, member] of Object.entries(data.seats)) {
      if (member.left) {
        delete data.seats[seat];
        continue;
      }
      member.offlineSince ??= now();
    }
    const room = { id: row.id, data, links: new Map() };
    rooms.set(row.id, room);
    persist(room);
  }

  function getRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) throw fail(404, 'Room sudah ditutup atau tidak ditemukan.');
    return room;
  }

  function authenticate(room, credential) {
    if (!credential || typeof credential !== 'string' || credential.length > 128) throw fail(401, 'Sesi room tidak valid.');
    const digest = hash(credential);
    const seat = seats.find((key) => room.data.seats[key]?.token === digest);
    if (!seat) throw fail(401, 'Sesi room tidak valid.');
    return seat;
  }

  function state(room) {
    const peers = getConnections(room);
    return {
      type: 'state',
      layout: room.data.layout, slots: room.data.slots,
      resets: Object.fromEntries(room.links),
      presence: Object.fromEntries(Object.keys(room.data.seats).map((seat) => [seat, {
        online: Boolean(peers[seat]), id: peers[seat]?.connectionId,
        camera: Boolean(peers[seat]?.camera),
        links: peers[seat]?.readyLinks ?? [],
      }])),
      busy: room.capture ? 'capture' : room.export ? 'export' : null,
    };
  }

  function removeMember(room, seat) {
    delete room.data.seats[seat];
    delete room.data.layout.people[seat];
    room.data.layout.order = room.data.layout.order.filter((member) => member !== seat);
    room.data.layout.revision++;
  }

  function dropLinks(room, connectionId) {
    for (const key of room.links.keys()) if (key.split(':').includes(connectionId)) room.links.delete(key);
  }

  function closeRoom(room) {
    transaction(db, () => {
      db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
      db.prepare('DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM versions WHERE album = ?)').run(room.data.albumId, room.data.albumId);
    });
    rooms.delete(room.id);
    broadcast(room, { type: 'closed' });
    for (const ws of Object.values(getConnections(room))) ws.close(1000);
    connections.delete(room.id);
    log('room.closed', { active: rooms.size });
  }

  function abortCapture(room, message) {
    if (!room.capture) return;
    const { captureId, began } = room.capture;
    room.capture = undefined;
    broadcast(room, { type: 'capture:failed', captureId, message });
    broadcast(room, state(room));
    log('capture.failed', { durationMs: now() - began });
  }

  function abortExport(room, message) {
    if (!room.export) return;
    room.export = undefined;
    broadcast(room, { type: 'export:failed', message });
    broadcast(room, state(room));
  }

  function session(room, seat, credential) {
    const { invite, albumId, albumToken } = room.data;
    return { roomId: room.id, seat, credential, invite, albumId, albumToken };
  }

  function checkRate(key, count, period) {
    const time = now();
    let entry = limits.get(key);
    if (!entry || entry.until <= time) {
      entry = { count: 0, until: time + period };
      if (limits.size > 10_000) throw fail(429, 'Server sedang sibuk. Coba lagi sebentar.');
      limits.set(key, entry);
    }
    if (++entry.count > count) throw fail(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
  }

  async function exportFile(req, room, seat, exportId, position) {
    const pending = room.export;
    if (!pending || pending.exportId !== exportId || pending.seat !== seat || now() >= pending.expires) {
      throw fail(409, 'Sesi unggah sudah berakhir.');
    }
    if (position < 0 || position > pending.count || pending.uploading || pending.files.has(position)) {
      throw fail(409, 'Berkas tidak sesuai dengan sesi unggah.');
    }
    if (req.headers['content-type'] !== 'image/jpeg') throw fail(415, 'Format hasil ekspor harus JPEG.');
    pending.uploading = true;
    try {
      const bytes = await readBody(req, maxFile);
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
        throw fail(415, 'Berkas JPEG tidak valid.');
      }
      try {
        const image = sharp(bytes, { limitInputPixels: 18_000_000, failOn: 'warning' });
        const info = await image.metadata();
        if (info.format !== 'jpeg' || info.width < 1 || info.height < 1) throw Error();
        await image.resize(1, 1, { fastShrinkOnLoad: false }).raw().toBuffer();
      } catch {
        throw fail(415, 'Berkas JPEG tidak dapat dibaca.');
      }
      if (position && hash(bytes) !== pending.slots[position - 1].digest) {
        throw fail(409, 'Berkas berbeda dari foto aktif pada slot.');
      }
      if (room.export !== pending || now() >= pending.expires) throw fail(409, 'Sesi unggah sudah berakhir.');
      const space = await statfs(exports);
      if (space.bavail * space.bsize - bytes.length < diskReserve) throw fail(507, 'Penyimpanan server hampir penuh.');
      const directory = resolve(exports, exportId);
      const fileId = id();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(directory, fileId), bytes, { flag: 'wx', mode: 0o600 });
      if (room.export !== pending || now() >= pending.expires) throw fail(409, 'Sesi unggah sudah berakhir.');
      pending.files.set(position, { fileId, bytes: bytes.length });
    } catch (error) {
      if (room.export === pending) abortExport(room, error.status ? error.message : 'Gagal menyimpan berkas ekspor.');
      await rm(resolve(exports, exportId), { recursive: true, force: true }).catch(() => {});
      log('export.upload_failed', { status: error.status ?? 500 });
      if (error.code === 'ENOSPC') throw fail(507, 'Penyimpanan server penuh.');
      throw error;
    } finally {
      pending.uploading = false;
    }
  }

  function commitExport(room, seat, exportId) {
    const pending = room.export;
    if (!pending || pending.exportId !== exportId || pending.seat !== seat || now() >= pending.expires) {
      const existing = db.prepare('SELECT version FROM versions WHERE id = ? AND album = ? AND expires > ?').get(exportId, room.data.albumId, now());
      if (existing) return existing.version;
      throw fail(409, 'Sesi unggah sudah berakhir.');
    }
    if (pending.files.size !== pending.count + 1 || pending.uploading) throw fail(409, 'Set ekspor belum lengkap.');
    const stored = now();
    const album = room.data.albumId;
    const version = transaction(db, () => {
      const { last_version: version } = db.prepare('UPDATE albums SET last_version = last_version + 1 WHERE id = ? RETURNING last_version').get(album);
      db.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?)').run(exportId, album, version, stored, stored + TTL, pending.count);
      const insert = db.prepare('INSERT INTO files VALUES (?,?,?,?)');
      for (const [position, file] of pending.files) insert.run(file.fileId, exportId, position, file.bytes);
      return version;
    });
    room.export = undefined;
    broadcast(room, { type: 'export:created', version });
    broadcast(room, state(room));
    log('export.created', { durationMs: stored - pending.began, files: pending.files.size });
    return version;
  }

  function bearer(req) {
    return req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const path = pathname.split('/').slice(1);
      const [, group, first, action, exportId, position] = path;
      const method = req.method;
      const credential = bearer(req);
      if (path[0] !== 'api') throw fail(404, 'Halaman tidak ditemukan.');
      if (group === 'time' && path.length === 2 && method === 'GET') return json(res, 200, { now: now() });
      if (group === 'rooms' && path.length === 2 && method === 'POST') {
        checkRate(`create:${req.headers['x-real-ip'] ?? req.socket.remoteAddress}`, 20, 60_000);
        if (rooms.size >= 5) throw fail(409, 'Kapasitas penuh. Lima room sedang aktif.');
        const credential = token();
        const room = {
          id: id(), links: new Map(),
          data: { invite: token(), albumId: id(), albumToken: token(), offlineSince: now(),
            seats: { a: { token: hash(credential), offlineSince: now() } },
            layout: initialLayout(), slots: Array(4).fill(null) },
        };
        transaction(db, () => {
          db.prepare('INSERT INTO albums(id,token) VALUES (?,?)').run(room.data.albumId, hash(room.data.albumToken));
          persist(room);
        });
        rooms.set(room.id, room);
        log('room.created', { active: rooms.size });
        return json(res, 201, session(room, 'a', credential));
      }
      if (group === 'rooms' && keyPattern.test(first ?? '')) {
        const room = getRoom(first);
        if (action === 'join' && path.length === 4 && method === 'POST') {
          checkRate(`join:${req.headers['x-real-ip'] ?? req.socket.remoteAddress}`, 60, 60_000);
          const { invite } = await readJson(req);
          if (rooms.get(first) !== room) throw fail(404, 'Room sudah ditutup.');
          if (credential) return json(res, 200, session(room, authenticate(room, credential), credential));
          if (invite !== room.data.invite) throw fail(403, 'Tautan undangan tidak valid.');
          const seat = seats.find((key) => !room.data.seats[key]);
          if (!seat) throw fail(409, 'Room penuh. Maksimal 10 peserta.');
          const next = token();
          room.data.seats[seat] = { token: hash(next), offlineSince: now() };
          room.data.layout.people[seat] = fullFrame();
          room.data.layout.order.push(seat);
          room.data.layout.revision++;
          persist(room);
          broadcast(room, state(room));
          return json(res, 201, session(room, seat, next));
        }
        const seat = authenticate(room, credential);
        if (action === 'leave' && path.length === 4 && method === 'POST') {
          removeMember(room, seat);
          const peers = getConnections(room);
          const ws = peers[seat];
          delete peers[seat];
          if (ws) dropLinks(room, ws.connectionId);
          ws?.close(1000);
          if (room.capture?.members.includes(seat)) abortCapture(room, 'Salah satu peserta keluar. Foto sebelumnya tetap tersimpan.');
          if (room.export?.seat === seat) abortExport(room, 'Peserta yang mengekspor telah keluar.');
          if (!Object.keys(room.data.seats).length) closeRoom(room);
          else {
            if (!Object.keys(peers).length) room.data.offlineSince = now();
            persist(room);
            broadcast(room, state(room));
          }
          return json(res, 200, { ok: true });
        }
        if (action === 'ice' && path.length === 4 && method === 'GET') {
          const iceServers = [];
          if (config.PHOTOBOX_STUN_URLS) iceServers.push({ urls: config.PHOTOBOX_STUN_URLS.split(',') });
          if (config.PHOTOBOX_TURN_URLS && config.PHOTOBOX_TURN_SECRET) {
            const username = `${Math.floor(now() / 1000) + 3600}:${room.id}-${seat}`;
            const credential = createHmac('sha1', config.PHOTOBOX_TURN_SECRET).update(username).digest('base64');
            iceServers.push({ urls: config.PHOTOBOX_TURN_URLS.split(','), username, credential });
          }
          return json(res, 200, { iceServers, ...(config.PHOTOBOX_RELAY_ONLY === '1' ? { iceTransportPolicy: 'relay' } : {}) });
        }
        if (action === 'exports' && keyPattern.test(exportId ?? '')) {
          if (method === 'PUT' && path.length === 6 && /^[0-8]$/.test(position)) {
            await exportFile(req, room, seat, exportId, Number(position));
            return json(res, 200, { ok: true });
          }
          if (method === 'POST' && path.length === 6 && position === 'commit') {
            return json(res, 201, { version: commitExport(room, seat, exportId) });
          }
        }
      }
      if (group === 'albums' && keyPattern.test(first ?? '')) {
        const album = db.prepare('SELECT token FROM albums WHERE id = ?').get(first);
        if (!album) throw fail(410, 'Album sudah kedaluwarsa atau tidak ditemukan.');
        if (!credential || hash(credential) !== album.token) throw fail(403, 'Tautan album tidak valid.');
        if (method === 'GET' && path.length === 3) {
          const versions = db.prepare('SELECT id, version, stored, expires, slots FROM versions WHERE album = ? AND expires > ? ORDER BY version DESC').all(first, now());
          const files = db.prepare('SELECT id, position, bytes FROM files WHERE version = ? ORDER BY position');
          return json(res, 200, { versions: versions.map((version) => ({ ...version, files: files.all(version.id) })), now: now() });
        }
        if (method === 'GET' && action === 'files' && keyPattern.test(exportId ?? '') && path.length === 5) {
          const file = db.prepare(`SELECT f.id, f.position, f.bytes, v.id AS version_id, v.version, v.expires
            FROM files f JOIN versions v ON v.id = f.version WHERE f.id = ? AND v.album = ?`).get(exportId, first);
          if (!file || now() >= file.expires) throw fail(410, 'Berkas sudah kedaluwarsa atau tidak ditemukan.');
          const stream = createReadStream(resolve(exports, file.version_id, file.id));
          stream.once('open', () => {
            if (now() >= file.expires) {
              stream.destroy();
              return json(res, 410, { error: 'Berkas sudah kedaluwarsa.' });
            }
            if (res.destroyed) return stream.destroy();
            res.writeHead(200, {
              'Content-Type': 'image/jpeg', 'Content-Length': file.bytes,
              'Content-Disposition': `attachment; filename="photobox-v${file.version}-${file.position ? `foto-${file.position}` : 'photostrip'}.jpg"`,
            });
            stream.pipe(res);
          });
          stream.once('error', () => {
            if (res.headersSent) res.destroy();
            else json(res, 410, { error: 'Berkas tidak tersedia.' });
          });
          res.once('close', () => stream.destroy());
          return;
        }
      }
      throw fail(404, 'Permintaan tidak ditemukan.');
    } catch (error) {
      if (!error.status) log('request.failed', { code: error.code ?? error.name });
      if (!res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'Terjadi kesalahan pada server.' });
    }
  });
  server.requestTimeout = EXPORT_WINDOW;

  function handleEvent(room, seat, ws, message) {
    const peers = getConnections(room);
    const capture = room.capture;
    if (message.type === 'rtc:signal') {
      const { target, link, description, candidate } = message;
      const peer = Object.values(peers).find((peer) => peer !== ws && peer.connectionId === target);
      if (peer && link === linkId(room, ws.connectionId, target)) {
        send(peer, { type: 'rtc:signal', from: ws.connectionId, link, description, candidate });
      }
      return;
    }
    if (message.type === 'rtc:reset') {
      const { target, link } = message;
      const peer = Object.values(peers).find((peer) => peer !== ws && peer.connectionId === target);
      if (!peer || link !== linkId(room, ws.connectionId, target)) return;
      room.links.set(pairKey(ws.connectionId, target), id());
      if (capture && capture.members.includes(seat) && capture.members.some((member) => peers[member] === peer) &&
          (capture.compositor === seat || peers[capture.compositor] === peer)) {
        abortCapture(room, 'Koneksi media terputus. Foto sebelumnya tetap tersimpan.');
      }
      broadcast(room, state(room));
      return;
    }
    if (message.type === 'media') {
      ws.camera = message.camera === true;
      const candidates = Object.values(peers).filter((peer) => peer !== ws).map((peer) => linkId(room, ws.connectionId, peer.connectionId));
      ws.readyLinks = Array.isArray(message.links) ? candidates.filter((link) => message.links.includes(link)) : [];
      if (capture?.members.includes(seat)) {
        const compositor = peers[capture.compositor];
        const targets = seat === capture.compositor ? capture.members.filter((member) => member !== seat).map((member) => peers[member]) : [compositor];
        if (!ws.camera || targets.some((peer) => !peer || !ws.readyLinks.includes(linkId(room, ws.connectionId, peer.connectionId)))) {
          abortCapture(room, 'Kamera atau koneksi peserta terputus.');
        }
      }
      broadcast(room, state(room));
      return;
    }
    if (message.type === 'filter') {
      const { key, value } = message;
      if (!cameraFilters.includes(key) || !clamp(value, -5, 5)) throw fail(400, 'Nilai filter tidak valid.');
      ws.filters[key] = value;
      return;
    }
    if (message.type === 'mirror') {
      if (typeof message.enabled !== 'boolean') throw fail(400, 'Pengaturan mirror tidak valid.');
      ws.mirror = message.enabled;
      return;
    }
    if (message.type === 'capture:ready' && capture?.captureId === message.captureId && capture.members.includes(seat)) {
      if (capture.targetTime) return;
      capture.ready.add(seat);
      if (capture.ready.size === capture.members.length) {
        capture.targetTime = now() + 3500;
        capture.deadline = capture.targetTime + 90_000;
        broadcast(room, { type: 'capture:start', captureId: capture.captureId, targetTime: capture.targetTime });
      }
      return;
    }
    if (message.type === 'capture:failed' && capture?.captureId === message.captureId && capture.members.includes(seat)) {
      abortCapture(room, 'Pengambilan atau transfer foto gagal. Foto sebelumnya tetap tersimpan.');
      return;
    }
    if (message.type === 'capture:stored' && capture?.captureId === message.captureId && capture.members.includes(seat)) {
      if (!capture.targetTime || now() < capture.targetTime - 100 || !assetPattern.test(message.digest ?? '')) return;
      capture.stored[seat] = message.digest;
      if (capture.members.every((member) => capture.stored[member])) {
        const digest = capture.stored[capture.compositor];
        if (capture.members.some((member) => capture.stored[member] !== digest)) return abortCapture(room, 'Hasil transfer foto berbeda. Foto sebelumnya tetap tersimpan.');
        room.data.slots[capture.slot] = { id: capture.captureId, digest };
        persist(room);
        room.capture = undefined;
        broadcast(room, { type: 'capture:committed', captureId: capture.captureId, slot: capture.slot });
        broadcast(room, state(room));
        log('capture.completed', { durationMs: now() - capture.began });
      }
      return;
    }
    if (message.type === 'export:cancel' && room.export?.seat === seat && room.export?.exportId === message.exportId) {
      const { exportId } = room.export;
      abortExport(room, 'Ekspor gagal. Foto di room tetap tersedia.');
      rm(resolve(exports, exportId), { recursive: true, force: true }).catch(() => {});
      return;
    }
    if (message.type === 'asset:ready') {
      if (!assetPattern.test(message.id ?? '')) throw fail(400, 'Aset latar tidak valid.');
      ws.background = message.id;
      send(ws, { type: 'asset:ready', id: message.id });
      return;
    }
    if (!['layout', 'asset:select', 'capture:request', 'slot:clear', 'export:request'].includes(message.type)) return;
    if (room.capture || room.export) throw fail(409, 'Tunggu proses foto atau ekspor selesai.');
    if (message.type === 'layout' || message.type === 'asset:select') {
      if (message.type === 'asset:select') {
        if (!assetPattern.test(message.id ?? '') || Object.values(peers).some((peer) => peer.background !== message.id)) {
          throw fail(409, 'Latar belum tersedia pada semua perangkat yang terhubung.');
        }
        room.data.layout.background = message.id;
        room.data.layout.revision++;
      } else {
        const { key, value } = message;
        if (key === 'strip' || key === 'count') {
          const strip = key === 'count' && typeof value === 'number' ? formats.legacyStrips[value] : key === 'strip' ? value : undefined;
          if (typeof strip !== 'string' || !Object.hasOwn(formats.strips, strip)) throw fail(400, 'Template photostrip tidak valid.');
          const { count } = formats.strips[strip];
          if (room.data.slots.slice(count).some(Boolean) && message.confirm !== true) {
            throw fail(409, 'Konfirmasi diperlukan untuk membuang slot di luar template baru.');
          }
          Object.assign(room.data.layout, { strip, count, revision: room.data.layout.revision + 1 });
          room.data.slots = Array.from({ length: count }, (_, index) => room.data.slots[index] ?? null);
        } else {
          patchLayout(room.data.layout, message);
        }
      }
      persist(room);
      return broadcast(room, state(room));
    }
    if (message.type === 'capture:request' || message.type === 'slot:clear') {
      const slot = message.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= room.data.slots.length) throw fail(400, 'Slot foto tidak valid.');
      if (message.type === 'slot:clear') {
        const current = room.data.slots[slot];
        if (typeof message.id !== 'string' || !keyPattern.test(message.id)) throw fail(400, 'ID foto tidak valid.');
        if (!current) return;
        if (current.id !== message.id) throw fail(409, 'Isi slot sudah berubah. Pilih kembali foto yang ingin dihapus.');
        const slots = room.data.slots.slice();
        slots[slot] = null;
        const data = { ...room.data, slots };
        persist({ id: room.id, data });
        room.data = data;
        broadcast(room, state(room));
        return send(ws, { type: 'slot:cleared', slot });
      }
      const members = room.data.layout.order.filter((member) => peers[member]?.camera);
      const ready = members.every((member) => {
        if (member === seat) return true;
        const peer = peers[member];
        const link = linkId(room, ws.connectionId, peer.connectionId);
        return ws.readyLinks?.includes(link) && peer.readyLinks?.includes(link);
      });
      if (!ws.camera || !ready) throw fail(409, 'Nyalakan kamera dan tunggu koneksi peserta siap.');
      const captureId = id();
      const layout = structuredClone(room.data.layout);
      const filters = Object.fromEntries(members.map((member) => [member, { ...peers[member].filters }]));
      const mirrors = Object.fromEntries(members.map((member) => [member, peers[member].mirror]));
      room.capture = { captureId, slot, members, compositor: seat, began: now(), deadline: now() + 15_000, ready: new Set(), stored: {} };
      broadcast(room, state(room));
      return broadcast(room, { type: 'capture:prepare', captureId, slot, members, compositor: seat, layout, filters, mirrors });
    }
    if (room.data.slots.some((slot) => !slot)) throw fail(409, 'Isi semua slot sebelum mengekspor.');
    if (!Array.isArray(message.slots) || message.slots.length !== room.data.slots.length ||
        room.data.slots.some((slot, index) => slot.id !== message.slots[index])) {
      throw fail(409, 'Foto di room sudah berubah. Buka editor lagi untuk memakai foto terbaru.');
    }
    if (['strip', 'ratio', 'frame'].some((key) => Object.hasOwn(message, key) && message[key] !== room.data.layout[key])) {
      throw fail(409, 'Template photostrip sudah berubah. Buka editor lagi untuk memakai pilihan terbaru.');
    }
    const exportId = id();
    const began = now();
    room.export = { exportId, seat, count: room.data.layout.count, slots: [...room.data.slots],
      files: new Map(), began, expires: began + EXPORT_WINDOW };
    broadcast(room, state(room));
    send(ws, { type: 'export:started', exportId, layout: room.data.layout, slots: room.data.slots });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    let allowed = Boolean(origin && origin === config.PHOTOBOX_ORIGIN);
    try {
      if (!config.PHOTOBOX_ORIGIN && origin) {
        const url = new URL(origin);
        allowed = url.host === req.headers.host && ['http:', 'https:'].includes(url.protocol);
      }
    } catch {}
    if (req.url !== '/ws' || !allowed) return socket.destroy();
    try {
      checkRate(`socket:${req.headers['x-real-ip'] ?? req.socket.remoteAddress}`, 180, 60_000);
    } catch {
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    let room;
    let seat;
    ws.alive = true;
    const authTimer = setTimeout(() => { if (!room) ws.close(4401); }, 5000).unref();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => log('websocket.error'));
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!room) return;
      const peers = getConnections(room);
      if (peers[seat] !== ws) return;
      delete peers[seat];
      dropLinks(room, ws.connectionId);
      room.data.seats[seat].offlineSince = now();
      if (!Object.keys(peers).length) {
        room.data.offlineSince = now();
        connections.delete(room.id);
      }
      persist(room);
      if (room.capture?.members.includes(seat)) abortCapture(room, 'Koneksi peserta terputus. Foto sebelumnya tetap tersimpan.');
      broadcast(room, state(room));
    });
    ws.on('message', (raw, binary) => {
      try {
        if (binary) throw fail(400, 'Pesan signaling tidak valid.');
        const message = JSON.parse(raw);
        if (!message || typeof message.type !== 'string') throw fail(400, 'Pesan signaling tidak valid.');
        if (!room) {
          if (message.type !== 'auth') throw fail(401, 'Sesi room diperlukan.');
          const selected = getRoom(message.roomId);
          seat = authenticate(selected, message.credential);
          room = selected;
          const peers = getConnections(room);
          const previous = peers[seat];
          ws.connectionId = id();
          ws.filters = { ...neutral };
          ws.mirror = false;
          peers[seat] = ws;
          connections.set(room.id, peers);
          if (previous) {
            dropLinks(room, previous.connectionId);
            previous.close(4409, 'Sesi dibuka di tab lain.');
            if (room.capture?.members.includes(seat)) abortCapture(room, 'Salah satu sesi disambungkan ulang.');
          }
          room.data.seats[seat].offlineSince = null;
          if (room.data.offlineSince !== null) {
            room.data.offlineSince = null;
          }
          persist(room);
          clearTimeout(authTimer);
          broadcast(room, state(room));
          log('room.presence', { connected: Object.keys(peers).length });
          return;
        }
        if (getConnections(room)[seat] !== ws) return;
        if (!ws.rateUntil || now() >= ws.rateUntil) {
          ws.rateUntil = now() + 1000;
          ws.messages = 0;
        }
        if (++ws.messages > 150) return ws.close(4429, 'Terlalu banyak pesan.');
        handleEvent(room, seat, ws, message);
      } catch (error) {
        send(ws, { type: 'error', message: error.status ? error.message : 'Pesan tidak dapat diproses.' });
        if (!room) ws.close(error.status === 404 ? 4404 : 4401);
        else if (!error.status && !(error instanceof SyntaxError)) log('websocket.event_failed', { code: error.code ?? error.name });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 20_000).unref();
  const sweep = setInterval(() => {
    const time = now();
    for (const [key, value] of limits) if (time >= value.until) limits.delete(key);
    for (const room of rooms.values()) {
      if (room.capture && time >= room.capture.deadline) abortCapture(room, 'Pengambilan melewati waktu tunggu. Coba lagi.');
      if (room.export && time >= room.export.expires) {
        const { exportId, uploading } = room.export;
        abortExport(room, 'Unggahan melewati waktu tunggu.');
        if (!uploading) rm(resolve(exports, exportId), { recursive: true, force: true }).catch(() => {});
      }
      if (room.data.offlineSince !== null && time - room.data.offlineSince >= disconnectGrace) closeRoom(room);
      else if (!room.capture && !room.export) {
        const expired = Object.entries(room.data.seats).filter(([, member]) => member.offlineSince !== null && time - member.offlineSince >= disconnectGrace);
        if (!expired.length) continue;
        for (const [seat] of expired) removeMember(room, seat);
        if (!Object.keys(room.data.seats).length) closeRoom(room);
        else {
          persist(room);
          broadcast(room, state(room));
        }
      }
    }
  }, 1000).unref();
  let cleaning;
  const localCleanup = setInterval(() => {
    if (config.PHOTOBOX_EXTERNAL_CLEANUP !== '1' && !cleaning) {
      cleaning = cleanup(storage, now()).catch(() => log('cleanup.failed')).finally(() => { cleaning = undefined; });
    }
  }, 60_000).unref();

  return {
    server, storage,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      clearInterval(localCleanup);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      await cleaning;
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp();
  app.server.listen(Number(process.env.PHOTOBOX_PORT || 8787), '127.0.0.1', () => console.info('PhotoboxWeb API siap.'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().then(() => process.exit()));
}
