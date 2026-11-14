import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TTL = 60 * 60 * 1000;
export const EXPORT_WINDOW = 3 * 60 * 1000;

export async function openStorage(root = process.env.PHOTOBOX_DATA || 'data') {
  const base = resolve(root);
  const exports = resolve(base, 'exports');
  await mkdir(exports, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(base, 'photobox.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY, token TEXT NOT NULL, last_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, album TEXT NOT NULL REFERENCES albums(id), version INTEGER NOT NULL,
      stored INTEGER NOT NULL, expires INTEGER NOT NULL, slots INTEGER NOT NULL,
      UNIQUE(album, version)
    );
    CREATE INDEX IF NOT EXISTS version_expiry ON versions(expires);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, version TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, bytes INTEGER NOT NULL
    );
  `);
  return { db, exports };
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function cleanup({ db, exports }, now = Date.now()) {
  const expired = db.prepare('SELECT id FROM versions WHERE expires <= ?').all(now);
  for (const { id } of expired) {
    try {
      await rm(resolve(exports, id), { recursive: true, force: true });
      db.prepare('DELETE FROM versions WHERE id = ? AND expires <= ?').run(id, now);
    } catch (error) {
      console.warn('cleanup.expired', error.code ?? 'filesystem');
    }
  }
  for (const id of await readdir(exports)) {
    if (!/^[a-f0-9]{32}$/.test(id)) continue;
    const directory = resolve(exports, id);
    try {
      const details = await stat(directory);
      if (details.mtimeMs > now - EXPORT_WINDOW * 3) continue;
      if (!db.prepare('SELECT 1 FROM versions WHERE id = ?').get(id)) {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('cleanup.orphan', error.code ?? 'filesystem');
    }
  }
  transaction(db, () => {
    const roomAlbums = new Set(db.prepare('SELECT payload FROM rooms').all().map(({ payload }) => JSON.parse(payload).albumId));
    for (const { id } of db.prepare('SELECT id FROM albums WHERE NOT EXISTS (SELECT 1 FROM versions WHERE album = albums.id)').all()) {
      if (!roomAlbums.has(id)) db.prepare('DELETE FROM albums WHERE id = ?').run(id);
    }
  });
  return expired.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const storage = await openStorage();
  try {
    console.info('cleanup.expiredVersions', await cleanup(storage));
  } finally {
    storage.db.close();
  }
}
