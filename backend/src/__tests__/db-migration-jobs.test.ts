// Regression test for the jobs_v2 column-mismatch migration bug.
//
// When a new column is added to `jobs` via ALTER TABLE, it must also be added
// to the jobs_v2 CREATE TABLE block in database.ts. This test catches that
// omission by replaying the full migration sequence against an in-memory DB
// and asserting both fresh-install and upgrade paths succeed.
//
// Keep BASE_SCHEMA, ALTER_MIGRATIONS and JOBS_V2_DDL in sync with database.ts.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

type DB = InstanceType<typeof Database>;
type ColInfo = { name: string; notnull: number };

// ── Schema mirroring database.ts ────────────────────────────────────────────

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL,
    api_id         INTEGER NOT NULL,
    api_hash       TEXT    NOT NULL,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    job_type         TEXT    NOT NULL DEFAULT 'checkin',
    bot_username     TEXT    NOT NULL DEFAULT '',
    timezone         TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 5,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT    NOT NULL DEFAULT '/start',
    checkin_button   TEXT    NOT NULL DEFAULT '签到',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    run_every_days   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS jobs (
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

  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL
  );
`;

// All ALTER TABLE jobs ADD COLUMN statements from database.ts, in order.
const ALTER_MIGRATIONS = [
  "ALTER TABLE jobs ADD COLUMN config TEXT",
  "ALTER TABLE jobs ADD COLUMN start_command TEXT NOT NULL DEFAULT '/start'",
  "ALTER TABLE jobs ADD COLUMN checkin_button TEXT NOT NULL DEFAULT '签到'",
  "ALTER TABLE jobs ADD COLUMN template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL",
  "ALTER TABLE jobs ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE jobs ADD COLUMN retired TEXT",
];

// ALTER TABLE jobs ADD COLUMN statements that run *after* the jobs_v2 swap in
// database.ts. These must NOT be listed in JOBS_V2_MIGRATION below: the swap's
// positional `INSERT INTO jobs_v2 SELECT * FROM jobs` breaks if `jobs` carries
// columns the jobs_v2 DDL doesn't declare.
const POST_REBUILD_ALTERS = [
  "ALTER TABLE jobs ADD COLUMN run_every_days_max INTEGER",
  "ALTER TABLE jobs ADD COLUMN last_success_at TEXT",
  "ALTER TABLE jobs ADD COLUMN one_time INTEGER NOT NULL DEFAULT 0",
];

// The jobs_v2 swap block from database.ts — must list every column that ALTER_MIGRATIONS adds.
const JOBS_V2_MIGRATION = `
  DROP TABLE IF EXISTS jobs_v2;
  CREATE TABLE jobs_v2 (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT    NOT NULL DEFAULT '/start',
    checkin_button        TEXT    NOT NULL DEFAULT '签到',
    template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    retired               TEXT
  );
  INSERT INTO jobs_v2 SELECT * FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_v2 RENAME TO jobs;
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFreshDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(BASE_SCHEMA);
  for (const sql of ALTER_MIGRATIONS) {
    try { db.exec(sql); } catch { /* already exists on re-run */ }
  }
  return db;
}

function runAccountIdMigration(db: DB) {
  const cols = db.prepare('PRAGMA table_info(jobs)').all() as ColInfo[];
  if (cols.find(c => c.name === 'account_id')?.notnull === 1) {
    // Mirrors database.ts: foreign_keys must be off during the swap, otherwise
    // DROP TABLE jobs cascades ON DELETE CASCADE and wipes every job_logs row.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(JOBS_V2_MIGRATION);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

function insertJobLog(db: DB, jobId: number) {
  return db.prepare(
    "INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, '2026-01-01T00:00:00Z', 'success')",
  ).run(jobId).lastInsertRowid as number;
}

function jobsColumns(db: DB) {
  return (db.prepare('PRAGMA table_info(jobs)').all() as ColInfo[]).map(c => c.name).sort();
}

function insertAccount(db: DB) {
  return db.prepare(
    'INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)',
  ).run('Acc', '+61400000000', 1, 'hash').lastInsertRowid as number;
}

function insertJob(db: DB, accountId: number | null) {
  return db.prepare(`
    INSERT INTO jobs
      (name, account_id, bot_username, job_type,
       schedule_window_start, schedule_window_end, timezone,
       reply_timeout_ms, retry_max, enabled,
       config, start_command, checkin_button, template_id, run_every_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('J', accountId, 'bot', 'checkin', 1400, 1600, 'Australia/Sydney', 40000, 5, 1, null, '/start', '签到', null, 1);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('jobs account_id nullable migration', () => {
  it('fresh install — migration succeeds with no existing rows', () => {
    const db = buildFreshDb();
    expect(() => runAccountIdMigration(db)).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(jobs)').all() as ColInfo[];
    expect(cols.find(c => c.name === 'account_id')?.notnull).toBe(0);
  });

  it('upgrade — migration preserves existing rows', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db);
    insertJob(db, accId);

    runAccountIdMigration(db);

    const jobs = db.prepare('SELECT * FROM jobs').all() as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('J');
    expect(jobs[0].account_id).toBe(accId);
  });

  it('jobs_v2 column set matches jobs after all ALTER migrations', () => {
    // Catches future columns added to jobs via ALTER TABLE but not added to jobs_v2.
    const db = buildFreshDb();
    const colsBefore = jobsColumns(db);

    runAccountIdMigration(db);

    // After the swap, jobs should have the same columns (just account_id nullability changed).
    expect(jobsColumns(db)).toEqual(colsBefore);
  });

  it('embywatch job inserts with null account_id after migration', () => {
    const db = buildFreshDb();
    runAccountIdMigration(db);

    expect(() => insertJob(db, null)).not.toThrow();

    const jobs = db.prepare('SELECT * FROM jobs').all() as any[];
    expect(jobs[0].account_id).toBeNull();
  });

  it('migration is skipped when account_id is already nullable', () => {
    const db = buildFreshDb();
    runAccountIdMigration(db); // first run

    // Second run must be a no-op — should not throw
    expect(() => runAccountIdMigration(db)).not.toThrow();
  });

  // Regression: DROP TABLE jobs fires job_logs.job_id's ON DELETE CASCADE when
  // foreign_keys is on, silently deleting all job run history. This is why the
  // migration must toggle foreign_keys off for the swap.
  it('preserves job_logs history across the migration', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db);
    const jobId = insertJob(db, accId).lastInsertRowid as number;
    insertJobLog(db, jobId);
    insertJobLog(db, jobId);

    runAccountIdMigration(db);

    const logs = db.prepare('SELECT * FROM job_logs').all() as any[];
    expect(logs).toHaveLength(2);
    expect(logs.every(l => l.job_id === jobId)).toBe(true);
  });

  it('demonstrates the cascade-delete bug when foreign_keys is left on during the swap', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db);
    const jobId = insertJob(db, accId).lastInsertRowid as number;
    insertJobLog(db, jobId);

    // Unpatched version of the migration — no foreign_keys toggle.
    db.exec(JOBS_V2_MIGRATION);

    const logs = db.prepare('SELECT * FROM job_logs').all() as any[];
    expect(logs).toHaveLength(0);
  });
});

// job_templates is never rebuilt, so its columns are plain ALTERs on whatever the
// installed version left behind.
describe('job_templates one_time upgrade', () => {
  const TEMPLATE_ALTERS = [
    "ALTER TABLE job_templates ADD COLUMN run_every_days_max INTEGER",
    "ALTER TABLE job_templates ADD COLUMN one_time INTEGER NOT NULL DEFAULT 0",
  ];

  function runTemplateAlters(db: DB) {
    for (const sql of TEMPLATE_ALTERS) {
      try { db.exec(sql); } catch { /* already exists on re-run */ }
    }
  }

  it('leaves templates written by an older version switched off', () => {
    const db = buildFreshDb();
    db.prepare("INSERT INTO job_templates (name, bot_username) VALUES ('T', 'bot')").run();

    runTemplateAlters(db);

    const tpl = db.prepare("SELECT * FROM job_templates WHERE name = 'T'").get() as any;
    expect(tpl.one_time).toBe(0);
    expect(tpl.run_every_days).toBe(1);
  });

  it('is idempotent across restarts', () => {
    const db = buildFreshDb();
    expect(() => runTemplateAlters(db)).not.toThrow();
    expect(() => runTemplateAlters(db)).not.toThrow();
  });
});

describe('jobs columns added after the jobs_v2 rebuild', () => {
  function runPostRebuildAlters(db: DB) {
    for (const sql of POST_REBUILD_ALTERS) {
      try { db.exec(sql); } catch { /* already exists on re-run */ }
    }
  }

  it('production order (swap, then ALTERs) preserves job rows and log history', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db);
    const jobId = insertJob(db, accId).lastInsertRowid as number;
    insertJobLog(db, jobId);

    runAccountIdMigration(db);
    runPostRebuildAlters(db);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.name).toBe('J');
    expect(job.bot_username).toBe('bot');
    expect(job.run_every_days).toBe(1);
    // New columns land as NULL, not as a shifted copy of a neighbouring column
    expect(job.run_every_days_max).toBeNull();
    expect(job.last_success_at).toBeNull();
    // one_time carries a NOT NULL default, so an upgraded row reads as off rather than null
    expect(job.one_time).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_logs').get()).toEqual({ n: 1 });
  });

  it('post-rebuild ALTERs are idempotent across restarts', () => {
    const db = buildFreshDb();
    runAccountIdMigration(db);
    expect(() => runPostRebuildAlters(db)).not.toThrow();
    expect(() => runPostRebuildAlters(db)).not.toThrow();
  });

  it('running them before the swap would break the positional copy', () => {
    // Guards the ordering: an extra column on `jobs` that jobs_v2 doesn't
    // declare makes `INSERT INTO jobs_v2 SELECT *` fail outright.
    const db = buildFreshDb();
    runPostRebuildAlters(db);

    expect(() => db.exec(JOBS_V2_MIGRATION)).toThrow();
  });

  it('legacy pre-swap installs still reach the new columns', () => {
    // Upgrade from the oldest schema: NOT NULL account_id triggers the swap,
    // then the post-rebuild ALTERs apply on the rebuilt table.
    const db = buildFreshDb();
    const accId = insertAccount(db);
    insertJob(db, accId);

    runAccountIdMigration(db);
    runPostRebuildAlters(db);

    expect(jobsColumns(db)).toContain('last_success_at');
    expect(jobsColumns(db)).toContain('one_time');
    expect((db.prepare('PRAGMA table_info(jobs)').all() as ColInfo[])
      .find(c => c.name === 'account_id')?.notnull).toBe(0);
  });
});
