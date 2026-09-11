let testDb!: InstanceType<typeof Database>;

vi.mock('../db/database', () => ({ get db() { return testDb; } }));
vi.mock('../jobs/runner', () => ({ runJob: vi.fn() }));
vi.mock('../jobs/cancellation', () => ({
  registerJob: vi.fn(() => new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock('../jobs/notify', () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { daysUntilNextRun, resolveRunEveryDays, refreshScheduler, getSchedulerStatus } from '../scheduler';

// Fixed reference day; window 10:00-12:00 UTC; tests run at 08:00 (before window).
const BASE_DATE = '2024-06-15';
const TZ = 'UTC';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    phone_number  TEXT    NOT NULL DEFAULT '',
    api_id        INTEGER NOT NULL DEFAULT 0,
    api_hash      TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status   TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled      INTEGER NOT NULL DEFAULT 0,
    proxy_id      TEXT,
    app_client_id TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT '',
    run_every_days INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL DEFAULT 'Job',
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'embywatch',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1200,
    timezone              TEXT    NOT NULL DEFAULT 'UTC',
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
    retired               TEXT,
    last_success_at       TEXT,
    next_run_at           TEXT
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler',
    detail  TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    detail_bytes INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function insertJob(fields: Partial<{
  runEveryDays: number;
  runEveryDaysMax: number | null;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  timezone: string;
  templateId: number | null;
}> = {}): number {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO jobs
      (job_type, account_id, run_every_days, run_every_days_max, schedule_window_start, schedule_window_end, timezone, template_id)
    VALUES ('embywatch', NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.runEveryDays ?? 1,
    fields.runEveryDaysMax ?? null,
    fields.scheduleWindowStart ?? 1000,
    fields.scheduleWindowEnd ?? 1200,
    fields.timezone ?? TZ,
    fields.templateId ?? null,
  );
  return Number(lastInsertRowid);
}

// Record a successful run N days before the current fake-timer clock.
function logSuccess(jobId: number, daysAgo: number) {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')").run(jobId, ts);
}

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SCHEMA);
  testDb.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('check_daily_run', 'true');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: always picks window start
  testDb.exec('DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM job_templates;');
  refreshScheduler(); // flush any leftover schedule entries from previous test
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── daysUntilNextRun ────────────────────────────────────────────────────────

describe('daysUntilNextRun', () => {
  it('returns 0 when no prior successful run exists', () => {
    const id = insertJob();
    expect(daysUntilNextRun(id, TZ, 1)).toBe(0);
    expect(daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('returns runEveryDays when job ran today (daysSince = 0)', () => {
    const id = insertJob();
    logSuccess(id, 0);
    expect(daysUntilNextRun(id, TZ, 1)).toBe(1);
    expect(daysUntilNextRun(id, TZ, 10)).toBe(10);
  });

  it('returns remaining interval days when job ran partway through', () => {
    const id = insertJob();
    logSuccess(id, 3);
    expect(daysUntilNextRun(id, TZ, 10)).toBe(7); // 10 - 3
    expect(daysUntilNextRun(id, TZ, 7)).toBe(4);  //  7 - 3
  });

  it('returns 0 when exactly runEveryDays have elapsed', () => {
    const id = insertJob();
    logSuccess(id, 10);
    expect(daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('returns 0 when more than runEveryDays have elapsed', () => {
    const id = insertJob();
    logSuccess(id, 15);
    expect(daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('ignores failed runs -- treats job as never run', () => {
    const id = insertJob();
    testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'failed')")
      .run(id, new Date().toISOString());
    expect(daysUntilNextRun(id, TZ, 1)).toBe(0);
  });
});

// ─── run-every-days range ────────────────────────────────────────────────────

describe('run-every-days range', () => {
  it('resolves an interval within [min, max]', () => {
    const id = insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    logSuccess(id, 0);
    const interval = resolveRunEveryDays(id, 7, 15);
    expect(interval).toBeGreaterThanOrEqual(7);
    expect(interval).toBeLessThanOrEqual(15);
  });

  it('is deterministic within a cycle (stable across calls, not re-rolled)', () => {
    const id = insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    logSuccess(id, 0);
    const a = resolveRunEveryDays(id, 7, 15);
    const b = resolveRunEveryDays(id, 7, 15);
    const c = daysUntilNextRun(id, TZ, 7, 15); // ran today -> full interval
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it('defers by the resolved interval minus days elapsed', () => {
    const id = insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    logSuccess(id, 3);
    const interval = resolveRunEveryDays(id, 7, 15); // same seed (latest success)
    const expected = interval > 3 ? interval - 3 : 0;
    expect(daysUntilNextRun(id, TZ, 7, 15)).toBe(expected);
  });

  it('re-rolls once a new successful run is recorded', () => {
    const id = insertJob({ runEveryDays: 1, runEveryDaysMax: 60 });
    // A wide range makes an accidental collision between two seeds unlikely.
    testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, new Date(Date.now() - 5 * 86_400_000).toISOString());
    const first = resolveRunEveryDays(id, 1, 60);
    testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, new Date(Date.now() - 1 * 86_400_000).toISOString());
    const second = resolveRunEveryDays(id, 1, 60);
    expect(first).not.toBe(second);
  });

  it('behaves as a fixed interval when max is null or <= min', () => {
    const id = insertJob({ runEveryDays: 7, runEveryDaysMax: null });
    logSuccess(id, 0);
    expect(daysUntilNextRun(id, TZ, 7, null)).toBe(7);
    expect(daysUntilNextRun(id, TZ, 7, 5)).toBe(7); // max <= min -> fixed
    expect(resolveRunEveryDays(id, 7, null)).toBe(7);
  });
});

// ─── First-ever run scheduling ───────────────────────────────────────────────

describe('first-ever run scheduling', () => {
  it('schedules today when job has no run history and window is ahead', () => {
    // 08:00 UTC, window 10:00-12:00, Math.random=0 → picks 10:00 today
    const id = insertJob();
    refreshScheduler();

    const [s] = getSchedulerStatus();
    expect(s.jobId).toBe(id);
    expect(s.nextRun.startsWith(BASE_DATE)).toBe(true);
    expect(s.nextRun).toContain('T10:00:00');
  });

  it('schedules tomorrow when job has no run history and window has passed', () => {
    vi.setSystemTime(new Date(`${BASE_DATE}T13:00:00Z`)); // past 10:00-12:00
    const id = insertJob();
    refreshScheduler();

    const [s] = getSchedulerStatus();
    expect(s.jobId).toBe(id);
    expect(s.nextRun.startsWith('2024-06-16')).toBe(true);
  });
});

// ─── run_every_days deferral after a successful run ──────────────────────────

describe('run_every_days deferral after a successful run', () => {
  it('defers 1 day when runEveryDays=1 and job ran today', () => {
    const id = insertJob({ runEveryDays: 1 });
    logSuccess(id, 0);
    refreshScheduler();

    const [s] = getSchedulerStatus();
    expect(s.nextRun.startsWith('2024-06-16')).toBe(true); // +1
    expect(s.nextRun).toContain('T10:00:00');
  });

  it('defers 10 days when runEveryDays=10 and job ran today', () => {
    const id = insertJob({ runEveryDays: 10 });
    logSuccess(id, 0);
    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true); // +10
  });

  it('defers remaining days when job ran partway through the interval', () => {
    // ran 3 days ago, interval=10 → 7 more days
    const id = insertJob({ runEveryDays: 10 });
    logSuccess(id, 3);
    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-22')).toBe(true); // +7
  });

  it('schedules today when the full interval has elapsed', () => {
    const id = insertJob({ runEveryDays: 7 });
    logSuccess(id, 7); // exactly 7 days ago
    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith(BASE_DATE)).toBe(true);
  });
});

// ─── Rescheduling when run_every_days changes on a standalone job ─────────────

describe('standalone job -- run_every_days change triggers reschedule', () => {
  it('moves next run out when run_every_days increases', () => {
    const id = insertJob({ runEveryDays: 1 });
    logSuccess(id, 0);
    refreshScheduler();
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-16')).toBe(true);

    testDb.prepare('UPDATE jobs SET run_every_days = 10 WHERE id = ?').run(id);
    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);
  });

  it('moves next run in when run_every_days decreases', () => {
    const id = insertJob({ runEveryDays: 10 });
    logSuccess(id, 0);
    refreshScheduler();
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);

    testDb.prepare('UPDATE jobs SET run_every_days = 1 WHERE id = ?').run(id);
    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-16')).toBe(true);
  });

  it('schedules today when run_every_days is reduced below days since last run', () => {
    // ran 5 days ago, interval was 10 (5 days remaining) → reduce to 3 → already overdue
    const id = insertJob({ runEveryDays: 10 });
    logSuccess(id, 5);
    refreshScheduler();
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-20')).toBe(true); // +5 remaining

    testDb.prepare('UPDATE jobs SET run_every_days = 3 WHERE id = ?').run(id);
    refreshScheduler();

    // daysSince(5) >= runEveryDays(3) → return 0 → schedule today
    expect(getSchedulerStatus()[0].nextRun.startsWith(BASE_DATE)).toBe(true);
  });
});

// ─── Template run_every_days change reschedules all linked jobs ───────────────

describe('template run_every_days change reschedules all linked jobs', () => {
  it('all linked jobs move to the new interval after template sync + refreshScheduler', () => {
    const { lastInsertRowid: tplId } = testDb.prepare(
      "INSERT INTO job_templates (name, run_every_days) VALUES ('Watch', 1)",
    ).run();
    const tpl = Number(tplId);

    const id1 = insertJob({ runEveryDays: 1, templateId: tpl });
    const id2 = insertJob({ runEveryDays: 1, templateId: tpl });
    logSuccess(id1, 0);
    logSuccess(id2, 0);

    refreshScheduler();
    expect(getSchedulerStatus().every(s => s.nextRun.startsWith('2024-06-16'))).toBe(true);

    // Simulate syncLinkedJobs updating both template and linked jobs
    testDb.prepare('UPDATE job_templates SET run_every_days = 10 WHERE id = ?').run(tpl);
    testDb.prepare('UPDATE jobs SET run_every_days = 10 WHERE template_id = ?').run(tpl);
    refreshScheduler();

    const after = getSchedulerStatus();
    expect(after).toHaveLength(2);
    expect(after.every(s => s.nextRun.startsWith('2024-06-25'))).toBe(true);
  });

  it('standalone jobs are not affected when template interval changes', () => {
    const { lastInsertRowid: tplId } = testDb.prepare(
      "INSERT INTO job_templates (name, run_every_days) VALUES ('Watch', 1)",
    ).run();
    const tpl = Number(tplId);

    const linkedId     = insertJob({ runEveryDays: 1, templateId: tpl });
    const standaloneId = insertJob({ runEveryDays: 1, templateId: null });
    logSuccess(linkedId, 0);
    logSuccess(standaloneId, 0);

    testDb.prepare('UPDATE job_templates SET run_every_days = 10 WHERE id = ?').run(tpl);
    testDb.prepare('UPDATE jobs SET run_every_days = 10 WHERE template_id = ?').run(tpl);
    refreshScheduler();

    const statuses    = getSchedulerStatus();
    const linked      = statuses.find(s => s.jobId === linkedId);
    const standalone  = statuses.find(s => s.jobId === standaloneId);

    expect(linked?.nextRun.startsWith('2024-06-25')).toBe(true);
    expect(standalone?.nextRun.startsWith('2024-06-16')).toBe(true);
  });

  it('reduces interval when template run_every_days decreases mid-cycle', () => {
    const { lastInsertRowid: tplId } = testDb.prepare(
      "INSERT INTO job_templates (name, run_every_days) VALUES ('Watch', 10)",
    ).run();
    const tpl = Number(tplId);

    const id = insertJob({ runEveryDays: 10, templateId: tpl });
    logSuccess(id, 0);
    refreshScheduler();
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);

    // Template drops to 3 days
    testDb.prepare('UPDATE job_templates SET run_every_days = 3 WHERE id = ?').run(tpl);
    testDb.prepare('UPDATE jobs SET run_every_days = 3 WHERE template_id = ?').run(tpl);
    refreshScheduler();

    // ran today, interval=3 → 3 days from now = 2024-06-18
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-18')).toBe(true);
  });

  it('multiple templates with different intervals reschedule independently', () => {
    const { lastInsertRowid: t1Id } = testDb.prepare(
      "INSERT INTO job_templates (name, run_every_days) VALUES ('Tpl A', 1)",
    ).run();
    const { lastInsertRowid: t2Id } = testDb.prepare(
      "INSERT INTO job_templates (name, run_every_days) VALUES ('Tpl B', 1)",
    ).run();
    const tplA = Number(t1Id);
    const tplB = Number(t2Id);

    const idA = insertJob({ runEveryDays: 1, templateId: tplA });
    const idB = insertJob({ runEveryDays: 1, templateId: tplB });
    logSuccess(idA, 0);
    logSuccess(idB, 0);

    // Only template A changes to 7 days
    testDb.prepare('UPDATE job_templates SET run_every_days = 7 WHERE id = ?').run(tplA);
    testDb.prepare('UPDATE jobs SET run_every_days = 7 WHERE template_id = ?').run(tplA);
    refreshScheduler();

    const statuses = getSchedulerStatus();
    const sA = statuses.find(s => s.jobId === idA);
    const sB = statuses.find(s => s.jobId === idB);

    expect(sA?.nextRun.startsWith('2024-06-22')).toBe(true); // +7
    expect(sB?.nextRun.startsWith('2024-06-16')).toBe(true); // +1, unchanged
  });
});
