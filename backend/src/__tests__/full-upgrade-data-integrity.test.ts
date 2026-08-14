// End-to-end regression test: runs the REAL migration script in db/database.ts
// (not a hand-copied mirror of it) against a file seeded with the oldest known
// schema, exactly as happens on a real upgrade. Asserts that every pre-existing
// row -- accounts, jobs, their account linkage, and job run history -- survives
// unchanged all the way through to the current schema.
//
// This is what would have caught the account_id/job_logs wipe bug: the other
// db-migration-*.test.ts files replay individual migration snippets by hand,
// which only proves those snippets are correct in isolation. This file proves
// the actual startup code path in database.ts is safe end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let dbPath: string;
const originalDbPath = process.env.DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bemby-upgrade-test-'));
  dbPath = path.join(tmpDir, 'bemby.db');
});

afterEach(() => {
  process.env.DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The very first schema this app ever shipped with (matches the initial
// `CREATE TABLE` block in database.ts, before any ALTER TABLE migration or
// v2 table-rebuild existed).
function seedLegacyDatabase(dbFilePath: string) {
  const legacy = new Database(dbFilePath);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE tg_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      phone_number TEXT   NOT NULL,
      api_id      INTEGER NOT NULL,
      api_hash    TEXT    NOT NULL,
      session_string TEXT,
      auth_status TEXT    NOT NULL DEFAULT 'unauthenticated',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE jobs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      name                  TEXT    NOT NULL,
      account_id            INTEGER NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
      job_type              TEXT    NOT NULL DEFAULT 'checkin',
      bot_username          TEXT    NOT NULL,
      schedule_window_start INTEGER NOT NULL DEFAULT 1400,
      schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
      timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
      reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
      retry_max             INTEGER NOT NULL DEFAULT 5,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE job_logs (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ran_at  TEXT    NOT NULL,
      status  TEXT    NOT NULL
    );

    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const sam = legacy.prepare(
    `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('Sam', '+61411111111', 123456, 'sam-hash', 'sam-session', 'authenticated');

  const james = legacy.prepare(
    `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('James', '+61422222222', 654321, 'james-hash', 'james-session', 'authenticated');

  const checkinJob = legacy.prepare(
    `INSERT INTO jobs (name, account_id, job_type, bot_username, enabled)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('Sam Daily Checkin', sam.lastInsertRowid, 'checkin', 'checkin_bot', 1);

  const customJob = legacy.prepare(
    `INSERT INTO jobs (name, account_id, job_type, bot_username, enabled)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('James Custom Flow', james.lastInsertRowid, 'custom', 'custom_bot', 0);

  legacy.prepare(
    `INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)`,
  ).run(checkinJob.lastInsertRowid, '2025-06-01T09:00:00Z', 'success');
  legacy.prepare(
    `INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)`,
  ).run(checkinJob.lastInsertRowid, '2025-06-02T09:00:00Z', 'failed');

  legacy.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
    .run('default_timezone', 'Australia/Melbourne'); // non-default value, must survive as-is

  legacy.close();

  return {
    samId: sam.lastInsertRowid as number,
    jamesId: james.lastInsertRowid as number,
    checkinJobId: checkinJob.lastInsertRowid as number,
    customJobId: customJob.lastInsertRowid as number,
  };
}

describe('full upgrade path — no data lost from oldest schema to current', () => {
  it('preserves accounts, job-account links, and job run history end to end', async () => {
    const { samId, jamesId, checkinJobId, customJobId } = seedLegacyDatabase(dbPath);

    process.env.DB_PATH = dbPath;
    vi.resetModules();
    const { db } = await import('../db/database');

    try {
      // Accounts kept their identity and auth state
      const sam = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(samId) as any;
      expect(sam.name).toBe('Sam');
      expect(sam.session_string).toBe('sam-session');
      expect(sam.auth_status).toBe('authenticated');
      expect(sam.disabled).toBe(0); // column added later, sane default for existing rows

      const james = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(jamesId) as any;
      expect(james.name).toBe('James');
      expect(james.session_string).toBe('james-session');

      // The actual bug this whole investigation was about: account_id must
      // still point at the same account after all migrations have run.
      const checkinJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(checkinJobId) as any;
      expect(checkinJob.name).toBe('Sam Daily Checkin');
      expect(checkinJob.account_id).toBe(samId);
      expect(checkinJob.enabled).toBe(1);

      const customJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(customJobId) as any;
      expect(customJob.name).toBe('James Custom Flow');
      expect(customJob.account_id).toBe(jamesId);

      // Job run history must not be cascade-deleted by the table rebuilds
      const logs = db.prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY ran_at').all(checkinJobId) as any[];
      expect(logs).toHaveLength(2);
      expect(logs[0].status).toBe('success');
      expect(logs[1].status).toBe('failed');

      // Pre-existing settings values must not be clobbered by re-seeding defaults
      const tz = db.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any;
      expect(tz.value).toBe('Australia/Melbourne');
    } finally {
      db.close();
    }
  });

  it('leaves a fresh install (no pre-existing data) fully functional', async () => {
    process.env.DB_PATH = dbPath;
    vi.resetModules();
    const { db } = await import('../db/database');

    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM tg_accounts').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
      const cols = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string; notnull: number }>;
      expect(cols.find(c => c.name === 'account_id')?.notnull).toBe(0);

      // issue #19: on a fresh install's first boot the job_templates ALTER used
      // to run before the CREATE, leaving run_every_days missing and breaking
      // template creation until the container restarted.
      const templateCols = db.prepare('PRAGMA table_info(job_templates)').all() as Array<{ name: string }>;
      expect(templateCols.some(c => c.name === 'run_every_days')).toBe(true);
      expect(() =>
        db.prepare('INSERT INTO job_templates (name, run_every_days) VALUES (?, ?)').run('t', 2),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
