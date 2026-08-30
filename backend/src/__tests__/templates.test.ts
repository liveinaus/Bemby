import Database from 'better-sqlite3';

// testDb is assigned in beforeAll; the lazy getter ensures the mock
// returns the correct instance before any test accesses db
let testDb!: InstanceType<typeof Database>;

vi.mock('../db/database', () => ({ get db() { return testDb; } }));
vi.mock('../scheduler', () => ({ refreshScheduler: vi.fn() }));
vi.mock('../jobs/embywatch', () => ({ runEmbywatch: vi.fn() }));
vi.mock('../jobs/checkin', () => ({
  runCheckin: vi.fn(),
  CheckinError: class extends Error {
    log: unknown;
    constructor(msg: string, log: unknown) { super(msg); this.log = log; }
  },
}));
vi.mock('../jobs/custom', () => ({
  runCustom: vi.fn(),
  CustomJobError: class extends Error {
    log: unknown;
    constructor(msg: string, log: unknown) { super(msg); this.log = log; }
  },
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
// The real route helper, so this suite cannot drift from what a template save does
import { syncLinkedJobs } from '../routes/templates';
import { runJob, type JobDetailLog } from '../jobs/runner';
import { runEmbywatch } from '../jobs/embywatch';
import type { Job } from '../types';

// ---------------------------------------------------------------------------
// Schema -- minimal subset needed for template and job operations
// ---------------------------------------------------------------------------

const SCHEMA = `
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
    run_every_days   INTEGER NOT NULL DEFAULT 1,
    run_every_days_max INTEGER,
    one_time         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
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
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    run_every_days_max    INTEGER,
    one_time              INTEGER NOT NULL DEFAULT 0
  );
`;

// ---------------------------------------------------------------------------
// Row types (snake_case, matching DB columns)
// ---------------------------------------------------------------------------

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  created_at: string;
  run_every_days: number;
  run_every_days_max: number | null;
  one_time: number;
};

type JobRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  template_id: number | null;
  account_id: number | null;
  run_every_days: number;
  one_time: number;
};

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertTemplate(
  fields: Partial<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: unknown;
    startCommand: string;
    checkinButton: string;
    runEveryDays: number;
  }> = {},
): TemplateRow {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, run_every_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name ?? 'Test Template',
    fields.jobType ?? 'checkin',
    fields.botUsername ?? 'testbot',
    fields.timezone ?? 'Australia/Sydney',
    fields.replyTimeoutMs ?? 40000,
    fields.retryMax ?? 5,
    fields.config != null ? JSON.stringify(fields.config) : null,
    fields.startCommand ?? '/start',
    fields.checkinButton ?? '签到',
    fields.runEveryDays ?? 1,
  );
  return testDb.prepare('SELECT * FROM job_templates WHERE id = ?').get(lastInsertRowid) as TemplateRow;
}

function insertJob(
  fields: Partial<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: unknown;
    startCommand: string;
    checkinButton: string;
    templateId: number | null;
    accountId: number | null;
  }> = {},
): JobRow {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO jobs
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config,
       start_command, checkin_button, template_id, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name ?? 'Test Job',
    fields.jobType ?? 'checkin',
    fields.botUsername ?? 'testbot',
    fields.timezone ?? 'Australia/Sydney',
    fields.replyTimeoutMs ?? 40000,
    fields.retryMax ?? 5,
    fields.config != null ? JSON.stringify(fields.config) : null,
    fields.startCommand ?? '/start',
    fields.checkinButton ?? '签到',
    fields.templateId ?? null,
    fields.accountId ?? null,
  );
  return testDb.prepare('SELECT * FROM jobs WHERE id = ?').get(lastInsertRowid) as JobRow;
}

function getJob(id: number): JobRow {
  return testDb.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
}

function getTemplate(id: number): TemplateRow | undefined {
  return testDb.prepare('SELECT * FROM job_templates WHERE id = ?').get(id) as TemplateRow | undefined;
}

// Mirrors the isLinked config-lock logic in the jobs PUT route.
// templateId === undefined means the field was absent from the request body (isLinked stays true).
function simulateJobPut(
  jobId: number,
  body: {
    name?: string;
    botUsername?: string;
    timezone?: string;
    replyTimeoutMs?: number;
    retryMax?: number;
    config?: unknown;
    startCommand?: string;
    checkinButton?: string;
    accountId?: number | null;
    templateId?: number | null;
  },
) {
  const existing = getJob(jobId);
  const {
    name, botUsername, timezone, replyTimeoutMs, retryMax,
    config, startCommand, checkinButton, accountId, templateId,
  } = body;

  const isLinked = existing.template_id != null && templateId === undefined;
  const resolvedTemplateId = templateId !== undefined
    ? (templateId != null ? templateId : null)
    : existing.template_id;

  testDb.prepare(`
    UPDATE jobs SET
      name = ?, account_id = ?, bot_username = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?,
      config = ?, start_command = ?, checkin_button = ?,
      template_id = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    accountId !== undefined ? (accountId != null ? accountId : null) : existing.account_id,
    isLinked ? existing.bot_username : (botUsername ?? existing.bot_username),
    isLinked ? existing.timezone : (timezone ?? existing.timezone),
    isLinked ? existing.reply_timeout_ms : Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max),
    // embywatch jobs may save credentials to config even when linked to a template
    (isLinked && existing.job_type !== 'embywatch')
      ? existing.config
      : (config !== undefined ? (config != null ? JSON.stringify(config) : null) : existing.config),
    isLinked ? existing.start_command : (startCommand ?? existing.start_command),
    isLinked ? existing.checkin_button : (checkinButton ?? existing.checkin_button),
    resolvedTemplateId,
    jobId,
  );
}

function makeJobObj(row: JobRow, overrides: Partial<Job> = {}): Job {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    jobType: row.job_type as Job['jobType'],
    botUsername: row.bot_username,
    scheduleWindowStart: 1000,
    scheduleWindowEnd: 1200,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: 1,
    enabled: true,
    createdAt: '2024-01-01T00:00:00Z',
    config: row.config,
    startCommand: row.start_command,
    checkinButton: row.checkin_button,
    templateId: row.template_id,
    runEveryDays: 1,
    ...overrides,
  };
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
  // Jobs first so template_id FK is cleared before templates are deleted
  testDb.exec('DELETE FROM jobs; DELETE FROM job_templates;');
});

// ---------------------------------------------------------------------------
// Template CRUD
// ---------------------------------------------------------------------------

describe('Template CRUD', () => {
  it('creates and retrieves a template', () => {
    const t = insertTemplate({ name: 'Daily Checkin', jobType: 'checkin', botUsername: 'bot1' });
    expect(t.id).toBeGreaterThan(0);
    expect(t.name).toBe('Daily Checkin');
    expect(t.job_type).toBe('checkin');
    expect(t.bot_username).toBe('bot1');
  });

  it('stores serialised config', () => {
    const cfg = { playDuration: 300, markWatched: true };
    const t = insertTemplate({ config: cfg });
    expect(JSON.parse(t.config!)).toEqual(cfg);
  });

  it('updates a template name and retry count', () => {
    const t = insertTemplate({ name: 'Original', retryMax: 3 });
    testDb.prepare('UPDATE job_templates SET name = ?, retry_max = ? WHERE id = ?')
      .run('Updated', 7, t.id);
    const updated = getTemplate(t.id)!;
    expect(updated.name).toBe('Updated');
    expect(updated.retry_max).toBe(7);
  });

  it('deletes a template', () => {
    const t = insertTemplate();
    testDb.prepare('DELETE FROM job_templates WHERE id = ?').run(t.id);
    expect(getTemplate(t.id)).toBeUndefined();
  });

  it('stores null config when none is provided', () => {
    const t = insertTemplate();
    expect(t.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Template update syncs linked jobs
// ---------------------------------------------------------------------------

describe('Template update -- syncLinkedJobs', () => {
  it('propagates field changes to all linked jobs', () => {
    const t = insertTemplate({ botUsername: 'old-bot', timezone: 'UTC', retryMax: 3 });
    const job1 = insertJob({ templateId: t.id });
    const job2 = insertJob({ templateId: t.id });
    const unlinked = insertJob();

    const updated: TemplateRow = { ...t, bot_username: 'new-bot', timezone: 'America/New_York', retry_max: 9 };
    testDb.prepare('UPDATE job_templates SET bot_username = ?, timezone = ?, retry_max = ? WHERE id = ?')
      .run('new-bot', 'America/New_York', 9, t.id);
    syncLinkedJobs(t.id, updated);

    expect(getJob(job1.id).bot_username).toBe('new-bot');
    expect(getJob(job1.id).timezone).toBe('America/New_York');
    expect(getJob(job1.id).retry_max).toBe(9);
    expect(getJob(job2.id).bot_username).toBe('new-bot');
    // Unlinked job is untouched
    expect(getJob(unlinked.id).bot_username).toBe(unlinked.bot_username);
  });

  it('syncs config when template config changes', () => {
    const t = insertTemplate({ config: { playDuration: 300 } });
    const job = insertJob({ templateId: t.id });

    const newConfig = JSON.stringify({ playDuration: 600, markWatched: true });
    testDb.prepare('UPDATE job_templates SET config = ? WHERE id = ?').run(newConfig, t.id);
    syncLinkedJobs(t.id, { ...t, config: newConfig });

    expect(getJob(job.id).config).toBe(newConfig);
  });

  it('pushes the one-time flag down to every linked job, and back off again', () => {
    const t = insertTemplate();
    const job = insertJob({ templateId: t.id });
    const unlinked = insertJob();

    testDb.prepare('UPDATE job_templates SET one_time = 1 WHERE id = ?').run(t.id);
    syncLinkedJobs(t.id, { ...t, one_time: 1 });
    expect(getJob(job.id).one_time).toBe(1);
    expect(getJob(unlinked.id).one_time).toBe(0);

    testDb.prepare('UPDATE job_templates SET one_time = 0 WHERE id = ?').run(t.id);
    syncLinkedJobs(t.id, { ...t, one_time: 0 });
    expect(getJob(job.id).one_time).toBe(0);
  });

  it('does not modify jobs linked to a different template', () => {
    const t1 = insertTemplate({ botUsername: 'bot-a' });
    const t2 = insertTemplate({ botUsername: 'bot-b' });
    const jobT1 = insertJob({ templateId: t1.id, botUsername: 'bot-a' });
    const jobT2 = insertJob({ templateId: t2.id, botUsername: 'bot-b' });

    syncLinkedJobs(t1.id, { ...t1, bot_username: 'bot-updated' });

    expect(getJob(jobT1.id).bot_username).toBe('bot-updated');
    expect(getJob(jobT2.id).bot_username).toBe('bot-b');
  });

  it('preserves per-job credentials when an embywatch template config is updated', () => {
    const t = insertTemplate({ jobType: 'embywatch', config: { playDuration: 300, markWatched: true } });
    const job1 = insertJob({ jobType: 'embywatch', templateId: t.id, config: { playDuration: 300, markWatched: true, username: 'alice', password: 'secret1' } });
    const job2 = insertJob({ jobType: 'embywatch', templateId: t.id, config: { playDuration: 300, markWatched: true, username: 'bob', password: 'secret2' } });

    const newConfig = JSON.stringify({ playDuration: 600, markWatched: false });
    testDb.prepare('UPDATE job_templates SET config = ? WHERE id = ?').run(newConfig, t.id);
    syncLinkedJobs(t.id, { ...t, config: newConfig });

    const cfg1 = JSON.parse(getJob(job1.id).config!);
    const cfg2 = JSON.parse(getJob(job2.id).config!);

    // Template settings updated
    expect(cfg1.playDuration).toBe(600);
    expect(cfg1.markWatched).toBe(false);
    expect(cfg2.playDuration).toBe(600);
    expect(cfg2.markWatched).toBe(false);

    // Per-job credentials preserved
    expect(cfg1.username).toBe('alice');
    expect(cfg1.password).toBe('secret1');
    expect(cfg2.username).toBe('bob');
    expect(cfg2.password).toBe('secret2');
  });

  it('keeps a job proxy override when the template proxy changes', () => {
    const t = insertTemplate({ jobType: 'custom', config: { actions: [], proxyId: 'tpl-px' } });
    const overridden = insertJob({ jobType: 'custom', templateId: t.id, config: { actions: [], proxyId: 'job-px' } });
    const following = insertJob({ jobType: 'custom', templateId: t.id, config: { actions: [] } });

    const newConfig = JSON.stringify({ actions: [], proxyId: 'tpl-px2' });
    testDb.prepare('UPDATE job_templates SET config = ? WHERE id = ?').run(newConfig, t.id);
    syncLinkedJobs(t.id, { ...t, config: newConfig });

    expect(JSON.parse(getJob(overridden.id).config!).proxyId).toBe('job-px');
    // A job following the template stores no proxy of its own; the runner falls back
    expect(JSON.parse(getJob(following.id).config!).proxyId).toBeUndefined();
  });

  it('keeps an embywatch job proxy override alongside its credentials', () => {
    const t = insertTemplate({ jobType: 'embywatch', config: { playDuration: 300, proxyId: 'tpl-px' } });
    const job = insertJob({ jobType: 'embywatch', templateId: t.id, config: { username: 'alice', password: 'secret1', proxyId: 'job-px' } });

    const newConfig = JSON.stringify({ playDuration: 600, proxyId: 'tpl-px2' });
    testDb.prepare('UPDATE job_templates SET config = ? WHERE id = ?').run(newConfig, t.id);
    syncLinkedJobs(t.id, { ...t, config: newConfig });

    const cfg = JSON.parse(getJob(job.id).config!);
    expect(cfg).toMatchObject({ playDuration: 600, username: 'alice', password: 'secret1', proxyId: 'job-px' });
  });
});

// ---------------------------------------------------------------------------
// Template deletion cascade
// ---------------------------------------------------------------------------

describe('Template deletion -- ON DELETE SET NULL cascade', () => {
  it('sets template_id to NULL on a linked job when the template is deleted', () => {
    const t = insertTemplate();
    const job = insertJob({ templateId: t.id });
    expect(getJob(job.id).template_id).toBe(t.id);

    testDb.prepare('DELETE FROM job_templates WHERE id = ?').run(t.id);

    expect(getJob(job.id).template_id).toBeNull();
    expect(getTemplate(t.id)).toBeUndefined();
  });

  it('unlinks all jobs when template is deleted', () => {
    const t = insertTemplate();
    const jobs = [insertJob({ templateId: t.id }), insertJob({ templateId: t.id }), insertJob({ templateId: t.id })];

    testDb.prepare('DELETE FROM job_templates WHERE id = ?').run(t.id);

    for (const j of jobs) {
      expect(getJob(j.id).template_id).toBeNull();
    }
  });

  it('does not affect jobs linked to a different template', () => {
    const t1 = insertTemplate();
    const t2 = insertTemplate();
    const jobT1 = insertJob({ templateId: t1.id });
    const jobT2 = insertJob({ templateId: t2.id });

    testDb.prepare('DELETE FROM job_templates WHERE id = ?').run(t1.id);

    expect(getJob(jobT1.id).template_id).toBeNull();
    expect(getJob(jobT2.id).template_id).toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// Applying a template to a job (linking)
// ---------------------------------------------------------------------------

describe('Applying a template', () => {
  it('sets template_id on the job', () => {
    const t = insertTemplate();
    const job = insertJob();
    simulateJobPut(job.id, { templateId: t.id });
    expect(getJob(job.id).template_id).toBe(t.id);
  });

  it('locks template-controlled fields once a job is linked', () => {
    const t = insertTemplate({ botUsername: 'template-bot', timezone: 'UTC', retryMax: 3 });
    const job = insertJob({ templateId: t.id, botUsername: 'job-bot', timezone: 'Australia/Sydney', retryMax: 5 });

    // Attempt to override locked fields (no templateId in body => isLinked = true)
    simulateJobPut(job.id, { botUsername: 'override-bot', timezone: 'Asia/Tokyo', retryMax: 99 });

    const updated = getJob(job.id);
    expect(updated.bot_username).toBe('job-bot');
    expect(updated.timezone).toBe('Australia/Sydney');
    expect(updated.retry_max).toBe(5);
  });

  it('still allows updating job name and accountId while linked', () => {
    const t = insertTemplate();
    const job = insertJob({ templateId: t.id, name: 'Original Name' });

    simulateJobPut(job.id, { name: 'Renamed Job' });

    expect(getJob(job.id).name).toBe('Renamed Job');
    expect(getJob(job.id).template_id).toBe(t.id);
  });

  it('does not change accountId when a template is applied', () => {
    const t = insertTemplate();
    // Embywatch-style job with no account
    const job = insertJob({ accountId: null });

    simulateJobPut(job.id, { templateId: t.id });

    expect(getJob(job.id).account_id).toBeNull();
    expect(getJob(job.id).template_id).toBe(t.id);
  });

  it('locks config for non-embywatch template-linked jobs', () => {
    const t = insertTemplate({ jobType: 'checkin' });
    const job = insertJob({ jobType: 'checkin', templateId: t.id, config: null });

    simulateJobPut(job.id, { config: { someField: 'value' } });

    expect(getJob(job.id).config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Removing a template from a job (unlinking)
// ---------------------------------------------------------------------------

describe('Removing a template', () => {
  it('clears template_id when explicitly unlinked', () => {
    const t = insertTemplate();
    const job = insertJob({ templateId: t.id });

    simulateJobPut(job.id, { templateId: null });

    expect(getJob(job.id).template_id).toBeNull();
  });

  it('allows updating previously locked fields after unlinking', () => {
    const t = insertTemplate({ botUsername: 'template-bot', timezone: 'UTC' });
    const job = insertJob({ templateId: t.id, botUsername: 'template-bot', timezone: 'UTC' });

    // Unlink and update in the same PUT
    simulateJobPut(job.id, { templateId: null, botUsername: 'my-bot', timezone: 'Australia/Sydney' });

    const updated = getJob(job.id);
    expect(updated.template_id).toBeNull();
    expect(updated.bot_username).toBe('my-bot');
    expect(updated.timezone).toBe('Australia/Sydney');
  });

  it('leaves the template unchanged when a job is unlinked', () => {
    const t = insertTemplate({ name: 'Shared Template' });
    const job = insertJob({ templateId: t.id });

    simulateJobPut(job.id, { templateId: null });

    expect(getTemplate(t.id)).toBeDefined();
    expect(getTemplate(t.id)!.name).toBe('Shared Template');
  });

  it('a second unlink on an already unlinked job is a no-op', () => {
    const job = insertJob({ templateId: null });

    simulateJobPut(job.id, { templateId: null });

    expect(getJob(job.id).template_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embywatch -- config writable even when linked
// ---------------------------------------------------------------------------

describe('embywatch -- config writable when template-linked', () => {
  it('allows saving credentials to a template-linked embywatch job', () => {
    const t = insertTemplate({ jobType: 'embywatch', config: { playDuration: 300 } });
    const job = insertJob({ jobType: 'embywatch', templateId: t.id, config: null });

    simulateJobPut(job.id, { config: { username: 'alice', password: 'secret' } });

    expect(JSON.parse(getJob(job.id).config!)).toEqual({ username: 'alice', password: 'secret' });
  });

  it('does not overwrite credentials when only the job name is updated', () => {
    const t = insertTemplate({ jobType: 'embywatch' });
    const job = insertJob({ jobType: 'embywatch', templateId: t.id, config: { username: 'bob', password: 'pw' } });

    simulateJobPut(job.id, { name: 'Renamed' });

    expect(getJob(job.id).name).toBe('Renamed');
    expect(JSON.parse(getJob(job.id).config!)).toEqual({ username: 'bob', password: 'pw' });
  });
});

// ---------------------------------------------------------------------------
// Runner -- embywatch template config merge at runtime
// ---------------------------------------------------------------------------

describe('Runner -- embywatch template config merge', () => {
  it('merges template playback config with job credentials', async () => {
    const template = insertTemplate({
      jobType: 'embywatch',
      config: { playDuration: 600, markWatched: true, userAgent: 'TestAgent/1.0' },
    });
    const jobRow = insertJob({
      jobType: 'embywatch',
      templateId: template.id,
      config: { username: 'user1', password: 'pass1' },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 1, total: 1 } as any);

    const logs: JobDetailLog[] = [];
    await runJob(makeJobObj(jobRow), null, logs);

    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledOnce();
    const merged = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(merged.playDuration).toBe(600);
    expect(merged.markWatched).toBe(true);
    expect(merged.userAgent).toBe('TestAgent/1.0');
    expect(merged.username).toBe('user1');
    expect(merged.password).toBe('pass1');
    expect(logs).toHaveLength(1);
  });

  it('job credentials override any credential fields in template config', async () => {
    // Templates should not store credentials, but job config always wins on merge
    const template = insertTemplate({
      jobType: 'embywatch',
      config: { username: 'template-user', password: 'template-pass', playDuration: 300 },
    });
    const jobRow = insertJob({
      jobType: 'embywatch',
      templateId: template.id,
      config: { username: 'job-user', password: 'job-pass' },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 0, total: 0 } as any);

    await runJob(makeJobObj(jobRow), null, []);

    const merged = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(merged.username).toBe('job-user');
    expect(merged.password).toBe('job-pass');
    expect(merged.playDuration).toBe(300);
  });

  it('throws when credentials are absent even with a template linked', async () => {
    const template = insertTemplate({ jobType: 'embywatch', config: { playDuration: 300 } });
    const jobRow = insertJob({ jobType: 'embywatch', templateId: template.id, config: null });

    await expect(runJob(makeJobObj(jobRow), null, [])).rejects.toThrow(
      'Emby username and password are required',
    );
    expect(vi.mocked(runEmbywatch)).not.toHaveBeenCalled();
  });

  it('uses job config directly when no template is linked', async () => {
    const jobRow = insertJob({
      jobType: 'embywatch',
      templateId: null,
      config: { username: 'solo', password: 'solo-pass', playDuration: 120 },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 1, total: 1 } as any);

    await runJob(makeJobObj(jobRow), null, []);

    const calledWith = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(calledWith.username).toBe('solo');
    expect(calledWith.password).toBe('solo-pass');
    expect(calledWith.playDuration).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Template update syncs run_every_days to linked jobs
// ---------------------------------------------------------------------------

describe('Template update -- run_every_days sync', () => {
  it('propagates run_every_days to all linked jobs', () => {
    const t = insertTemplate({ runEveryDays: 1 });
    const job1 = insertJob({ templateId: t.id });
    const job2 = insertJob({ templateId: t.id });
    const unlinked = insertJob();

    const updated: TemplateRow = { ...t, run_every_days: 10 };
    testDb.prepare('UPDATE job_templates SET run_every_days = ? WHERE id = ?').run(10, t.id);
    syncLinkedJobs(t.id, updated);

    expect(getJob(job1.id).run_every_days).toBe(10);
    expect(getJob(job2.id).run_every_days).toBe(10);
    // Unlinked job is untouched
    expect(getJob(unlinked.id).run_every_days).toBe(1);
  });

  it('does not change run_every_days on jobs linked to a different template', () => {
    const t1 = insertTemplate({ runEveryDays: 1 });
    const t2 = insertTemplate({ runEveryDays: 1 });
    const jobT1 = insertJob({ templateId: t1.id });
    const jobT2 = insertJob({ templateId: t2.id });

    syncLinkedJobs(t1.id, { ...t1, run_every_days: 7 });

    expect(getJob(jobT1.id).run_every_days).toBe(7);
    expect(getJob(jobT2.id).run_every_days).toBe(1);
  });

  it('stores the updated run_every_days on the template itself', () => {
    const t = insertTemplate({ runEveryDays: 1 });
    testDb.prepare('UPDATE job_templates SET run_every_days = ? WHERE id = ?').run(14, t.id);
    expect(getTemplate(t.id)!.run_every_days).toBe(14);
  });
});
