// Tests for the three new template endpoints added in the bulk-features work:
//   PUT  /templates/:id/jobs/enabled      — enable / disable all linked jobs
//   GET  /templates/:id/available-accounts — accounts with no job for this template
//   POST /templates/:id/create-jobs        — bulk-create jobs from a template
//
// Each test operates on the SQL / DB logic directly (no HTTP layer), matching
// the style of templates.test.ts.

import Database from 'better-sqlite3';

let testDb!: InstanceType<typeof Database>;

vi.mock('../db/database', () => ({ get db() { return testDb; } }));
vi.mock('../scheduler', () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL,
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
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
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1200,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT    NOT NULL DEFAULT '/start',
    checkin_button        TEXT    NOT NULL DEFAULT '签到',
    template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    retired               TEXT
  );
`;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertAccount(fields: Partial<{
  name: string; phoneNumber: string; authStatus: string; disabled: number;
}> = {}) {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO tg_accounts (name, phone_number, auth_status, disabled)
    VALUES (?, ?, ?, ?)
  `).run(
    fields.name ?? 'Acct',
    fields.phoneNumber ?? '+61400000000',
    fields.authStatus ?? 'authenticated',
    fields.disabled ?? 0,
  );
  return testDb.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(lastInsertRowid) as any;
}

function insertTemplate(fields: Partial<{
  name: string; jobType: string; botUsername: string; config: unknown;
}> = {}) {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO job_templates (name, job_type, bot_username, config)
    VALUES (?, ?, ?, ?)
  `).run(
    fields.name ?? 'Template',
    fields.jobType ?? 'checkin',
    fields.botUsername ?? 'testbot',
    fields.config != null ? JSON.stringify(fields.config) : null,
  );
  return testDb.prepare('SELECT * FROM job_templates WHERE id = ?').get(lastInsertRowid) as any;
}

function insertJob(fields: Partial<{
  name: string; templateId: number | null; accountId: number | null;
  jobType: string; enabled: number; config: unknown; retired: string | null;
}> = {}) {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO jobs (name, template_id, account_id, job_type, enabled, config, retired)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name ?? 'Job',
    fields.templateId ?? null,
    fields.accountId ?? null,
    fields.jobType ?? 'checkin',
    fields.enabled ?? 1,
    fields.config != null ? JSON.stringify(fields.config) : null,
    fields.retired ?? null,
  );
  return testDb.prepare('SELECT * FROM jobs WHERE id = ?').get(lastInsertRowid) as any;
}

function getJob(id: number) {
  return testDb.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec('DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;');
});

// ---------------------------------------------------------------------------
// Mirrors the route logic for PUT /:id/jobs/enabled
// ---------------------------------------------------------------------------

function setLinkedJobsEnabled(templateId: number, enabled: boolean) {
  testDb.prepare('UPDATE jobs SET enabled = ? WHERE template_id = ?').run(enabled ? 1 : 0, templateId);
}

// Mirrors the route logic for GET /:id/available-accounts
function getAvailableAccounts(templateId: number) {
  return testDb.prepare(`
    SELECT id, name, phone_number, auth_status, disabled
    FROM tg_accounts
    WHERE (disabled = 0 OR disabled IS NULL)
      AND id NOT IN (
        SELECT account_id FROM jobs
        WHERE template_id = ? AND account_id IS NOT NULL AND retired IS NULL
      )
    ORDER BY name COLLATE NOCASE
  `).all(templateId) as any[];
}

// Mirrors the route logic for POST /:id/create-jobs
function createJobs(
  template: any,
  jobs: Array<{ accountId: number; name: string; config?: Record<string, unknown> }>,
  scheduleWindowStart: number,
  scheduleWindowEnd: number,
  // Absent means on, as the route reads it; the toggle for it is covered in
  // template-create-jobs.test.ts, against the route itself
  enabled?: boolean,
): number[] {
  const createdIds: number[] = [];
  for (const j of jobs) {
    let jobConfig = template.config;
    if (j.config && template.job_type === 'embywatch') {
      const tplCfg = template.config ? JSON.parse(template.config) : {};
      jobConfig = JSON.stringify({ ...tplCfg, ...j.config });
    }
    const result = testDb.prepare(`
      INSERT INTO jobs (
        name, account_id, job_type, bot_username,
        schedule_window_start, schedule_window_end, timezone,
        reply_timeout_ms, retry_max, enabled, config,
        start_command, checkin_button, template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      j.name,
      j.accountId,
      template.job_type,
      template.bot_username,
      Number(scheduleWindowStart),
      Number(scheduleWindowEnd),
      template.timezone,
      template.reply_timeout_ms,
      template.retry_max,
      enabled === false ? 0 : 1,
      jobConfig,
      template.start_command,
      template.checkin_button,
      template.id,
    );
    createdIds.push(Number(result.lastInsertRowid));
  }
  return createdIds;
}

// ---------------------------------------------------------------------------
// Enable / disable all linked jobs
// ---------------------------------------------------------------------------

describe('setLinkedJobsEnabled', () => {
  it('disables all jobs linked to the template', () => {
    const t = insertTemplate();
    const j1 = insertJob({ templateId: t.id, enabled: 1 });
    const j2 = insertJob({ templateId: t.id, enabled: 1 });

    setLinkedJobsEnabled(t.id, false);

    expect(getJob(j1.id).enabled).toBe(0);
    expect(getJob(j2.id).enabled).toBe(0);
  });

  it('enables all jobs linked to the template', () => {
    const t = insertTemplate();
    const j1 = insertJob({ templateId: t.id, enabled: 0 });
    const j2 = insertJob({ templateId: t.id, enabled: 0 });

    setLinkedJobsEnabled(t.id, true);

    expect(getJob(j1.id).enabled).toBe(1);
    expect(getJob(j2.id).enabled).toBe(1);
  });

  it('does not affect jobs linked to a different template', () => {
    const t1 = insertTemplate();
    const t2 = insertTemplate();
    const j1 = insertJob({ templateId: t1.id, enabled: 1 });
    const j2 = insertJob({ templateId: t2.id, enabled: 1 });

    setLinkedJobsEnabled(t1.id, false);

    expect(getJob(j1.id).enabled).toBe(0);
    expect(getJob(j2.id).enabled).toBe(1);
  });

  it('does not affect unlinked jobs', () => {
    const t = insertTemplate();
    const linked   = insertJob({ templateId: t.id,   enabled: 1 });
    const unlinked = insertJob({ templateId: null, enabled: 1 });

    setLinkedJobsEnabled(t.id, false);

    expect(getJob(linked.id).enabled).toBe(0);
    expect(getJob(unlinked.id).enabled).toBe(1);
  });

  it('is a no-op when the template has no linked jobs', () => {
    const t = insertTemplate();
    // Should not throw
    expect(() => setLinkedJobsEnabled(t.id, false)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Available accounts (candidates for job creation)
// ---------------------------------------------------------------------------

describe('getAvailableAccounts', () => {
  it('returns all enabled accounts when no jobs exist for the template', () => {
    const t = insertTemplate();
    const a1 = insertAccount({ name: 'Alice' });
    const a2 = insertAccount({ name: 'Bob' });

    const result = getAvailableAccounts(t.id);

    expect(result.map((r: any) => r.id)).toEqual(
      expect.arrayContaining([a1.id, a2.id]),
    );
  });

  it('excludes accounts that already have a job for this template', () => {
    const t  = insertTemplate();
    const a1 = insertAccount({ name: 'Alice' });
    const a2 = insertAccount({ name: 'Bob' });
    insertJob({ templateId: t.id, accountId: a1.id });

    const result = getAvailableAccounts(t.id);

    const ids = result.map((r: any) => r.id);
    expect(ids).not.toContain(a1.id);
    expect(ids).toContain(a2.id);
  });

  it('does not exclude an account whose only job for this template is retired', () => {
    const t  = insertTemplate();
    const a1 = insertAccount({ name: 'Alice' });
    const a2 = insertAccount({ name: 'Bob' });
    insertJob({ templateId: t.id, accountId: a1.id, retired: '2026-07-08 00:00:00' });
    insertJob({ templateId: t.id, accountId: a2.id });

    const result = getAvailableAccounts(t.id);

    const ids = result.map((r: any) => r.id);
    expect(ids).toContain(a1.id);
    expect(ids).not.toContain(a2.id);
  });

  it('still excludes an account with both a retired and an active job for this template', () => {
    const t = insertTemplate();
    const a = insertAccount({ name: 'Alice' });
    insertJob({ templateId: t.id, accountId: a.id, retired: '2026-07-08 00:00:00' });
    insertJob({ templateId: t.id, accountId: a.id });

    expect(getAvailableAccounts(t.id).map((r: any) => r.id)).not.toContain(a.id);
  });

  it('does not exclude an account linked to a different template', () => {
    const t1 = insertTemplate();
    const t2 = insertTemplate();
    const a  = insertAccount({ name: 'Carol' });
    // Account is linked to t1, not t2
    insertJob({ templateId: t1.id, accountId: a.id });

    const result = getAvailableAccounts(t2.id);

    expect(result.map((r: any) => r.id)).toContain(a.id);
  });

  it('excludes disabled accounts', () => {
    const t       = insertTemplate();
    const active   = insertAccount({ name: 'Active',  disabled: 0 });
    const disabled = insertAccount({ name: 'Disabled', disabled: 1 });

    const result = getAvailableAccounts(t.id);

    const ids = result.map((r: any) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(disabled.id);
  });

  it('returns accounts ordered alphabetically by name', () => {
    const t = insertTemplate();
    insertAccount({ name: 'Zara' });
    insertAccount({ name: 'Alice' });
    insertAccount({ name: 'Mike' });

    const result = getAvailableAccounts(t.id);

    const names = result.map((r: any) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  });

  it('returns empty list when all accounts already have a job for this template', () => {
    const t = insertTemplate();
    const a = insertAccount();
    insertJob({ templateId: t.id, accountId: a.id });

    const result = getAvailableAccounts(t.id);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bulk create jobs from template
// ---------------------------------------------------------------------------

describe('createJobs', () => {
  it('creates the requested number of jobs', () => {
    const t  = insertTemplate();
    const a1 = insertAccount({ name: 'A1' });
    const a2 = insertAccount({ name: 'A2' });

    const ids = createJobs(t, [
      { accountId: a1.id, name: 'Job A1' },
      { accountId: a2.id, name: 'Job A2' },
    ], 1400, 1600);

    expect(ids).toHaveLength(2);
  });

  it('links created jobs to the template', () => {
    const t = insertTemplate();
    const a = insertAccount();

    const [id] = createJobs(t, [{ accountId: a.id, name: 'Linked Job' }], 1400, 1600);

    expect(getJob(id).template_id).toBe(t.id);
  });

  it('copies template fields onto each created job', () => {
    const t = insertTemplate({ jobType: 'checkin', botUsername: 'mybot' });
    const a = insertAccount();

    const [id] = createJobs(t, [{ accountId: a.id, name: 'Test' }], 1000, 1200);
    const job  = getJob(id);

    expect(job.job_type).toBe('checkin');
    expect(job.bot_username).toBe('mybot');
    expect(job.schedule_window_start).toBe(1000);
    expect(job.schedule_window_end).toBe(1200);
    expect(job.account_id).toBe(a.id);
    expect(job.name).toBe('Test');
    expect(job.enabled).toBe(1);
  });

  it('merges embywatch credentials into template config', () => {
    const t = insertTemplate({
      jobType: 'embywatch',
      config:  { playDuration: 300, markWatched: true },
    });
    const a = insertAccount();

    const [id] = createJobs(t, [{
      accountId: a.id,
      name:      'Watch Job',
      config:    { username: 'alice', password: 'secret' },
    }], 1400, 1600);

    const merged = JSON.parse(getJob(id).config);
    expect(merged.playDuration).toBe(300);
    expect(merged.markWatched).toBe(true);
    expect(merged.username).toBe('alice');
    expect(merged.password).toBe('secret');
  });

  it('job-level credentials override duplicate keys in template config', () => {
    // Templates should not store credentials, but job config wins on conflict
    const t = insertTemplate({
      jobType: 'embywatch',
      config:  { username: 'template-user', playDuration: 300 },
    });
    const a = insertAccount();

    const [id] = createJobs(t, [{
      accountId: a.id,
      name:      'Override Test',
      config:    { username: 'real-user', password: 'pw' },
    }], 1400, 1600);

    const merged = JSON.parse(getJob(id).config);
    expect(merged.username).toBe('real-user');
    expect(merged.playDuration).toBe(300);
  });

  it('does not merge config for non-embywatch jobs', () => {
    const t = insertTemplate({
      jobType: 'checkin',
      config:  null,
    });
    const a = insertAccount();

    // Passing a config for a checkin job should be ignored (no merge for checkin)
    const [id] = createJobs(t, [{
      accountId: a.id,
      name:      'Checkin',
      config:    { someField: 'value' },
    }], 1400, 1600);

    expect(getJob(id).config).toBeNull();
  });

  it('creates multiple jobs with individual account IDs', () => {
    const t  = insertTemplate();
    const a1 = insertAccount({ name: 'A1' });
    const a2 = insertAccount({ name: 'A2' });
    const a3 = insertAccount({ name: 'A3' });

    const ids = createJobs(t, [
      { accountId: a1.id, name: 'J1' },
      { accountId: a2.id, name: 'J2' },
      { accountId: a3.id, name: 'J3' },
    ], 800, 1000);

    const accountIds = ids.map(id => getJob(id).account_id);
    expect(accountIds).toEqual([a1.id, a2.id, a3.id]);
  });
});
