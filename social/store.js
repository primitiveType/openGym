import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'social.sqlite');
  const db = new DatabaseSync(file);
  let closed = false;
  fs.chmodSync(file, 0o600);
  if (db.prepare('PRAGMA user_version').get().user_version > 1) { db.close(); throw new Error('Social database is newer than this application; restore the matching image'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entities (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    PRAGMA user_version=1;`);
  return {
    db,
    get(kind, id) { const r = db.prepare('SELECT value FROM entities WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(r.value) : null; },
    put(kind, id, value) { db.prepare('INSERT OR REPLACE INTO entities VALUES (?,?,?)').run(kind, id, JSON.stringify(value)); return value; },
    remove(kind, id) { db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id); },
    // shortcut: small-server collections are filtered in memory; add indexed columns before opening a large public instance.
    all(kind) { return db.prepare('SELECT value FROM entities WHERE kind=?').all(kind).map(r => JSON.parse(r.value)); },
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    job(id, value) { db.prepare('INSERT OR IGNORE INTO jobs(id,value,due) VALUES(?,?,?)').run(id, JSON.stringify(value), Date.now()); },
    jobs() { return db.prepare('SELECT * FROM jobs WHERE due<=? ORDER BY due, rowid LIMIT 20').all(Date.now()).map(r => ({ ...r, value: JSON.parse(r.value) })); },
    finish(id) { db.prepare('DELETE FROM jobs WHERE id=?').run(id); },
    retry(id, attempts) { db.prepare('UPDATE jobs SET attempts=?,due=? WHERE id=?').run(attempts, Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)), id); },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
