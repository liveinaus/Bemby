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
import type { Job } from '../types';

// Fixed reference day; window 10:00-12:00 UTC; tests run at 08:00 (before window).
const BASE_DATE = '2024-06-15';
const TZ = 'UTC';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT '',
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled       INTEGER NOT NULL DEFAULT 0,
    proxy_id       TEXT,
    app_client_id  TEXT
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
    template_id           INTEGER,
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
    detail  TEXT,
    detail_bytes INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

type SchedulerModule = typeof import('../scheduler');

/** A fresh module instance, i.e. the same state a restarted process starts from. */
async function restartScheduler(): Promise<SchedulerModule> {
  vi.resetModules();
  return (await import('../scheduler')) as SchedulerModule;
}

function insertJob(fields: Partial<{
  runEveryDays: number;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
}> = {}): number {
  const { lastInsertRowid } = testDb.prepare(`
    INSERT INTO jobs
      (job_type, account_id, run_every_days, schedule_window_start, schedule_window_end, timezone, next_run_at, last_success_at)
    VALUES ('embywatch', NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.runEveryDays ?? 1,
    fields.scheduleWindowStart ?? 1000,
    fields.scheduleWindowEnd ?? 1200,
    TZ,
    fields.nextRunAt ?? null,
    fields.lastSuccessAt ?? null,
  );
  return Number(lastInsertRowid);
}

function storedPlan(jobId: number): string | null {
  return (testDb.prepare('SELECT next_run_at FROM jobs WHERE id = ?').get(jobId) as
    { next_run_at: string | null }).next_run_at;
}

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SCHEMA);
  testDb.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('check_daily_run', 'true');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: always picks window start
  testDb.exec('DELETE FROM job_logs; DELETE FROM jobs;');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('persisted schedule survives a restart', () => {
  it('re-arms a plan that is still days out instead of re-deriving it', async () => {
    // The reported bug: a run three days out, with no successful run to derive it from,
    // was rebuilt as "due now" on the next process start.
    const planned = `${BASE_DATE.slice(0, 8)}18T10:30:00.000Z`;
    const id = insertJob({ runEveryDays: 3, nextRunAt: planned });

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    const [status] = scheduler.getSchedulerStatus();
    expect(status.jobId).toBe(id);
    expect(status.nextRun).toBe(planned);
  });

  it('stamps the plan it picks so the next process can read it', async () => {
    const id = insertJob({ runEveryDays: 3 });

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    const [status] = scheduler.getSchedulerStatus();
    expect(storedPlan(id)).toBe(status.nextRun);
    expect(status.nextRun).toBe(`${BASE_DATE}T10:00:00.000Z`);
  });

  it('keeps a skipped run skipped', async () => {
    const id = insertJob({ runEveryDays: 1 });
    const first = await restartScheduler();
    first.refreshScheduler();
    expect(first.getSchedulerStatus()[0].nextRun.startsWith(BASE_DATE)).toBe(true);

    first.skipNextRun(id);
    const skipped = storedPlan(id);
    expect(skipped?.startsWith('2024-06-16')).toBe(true);

    const restarted = await restartScheduler();
    restarted.refreshScheduler();
    expect(restarted.getSchedulerStatus()[0].nextRun).toBe(skipped);
  });

  it('falls back to the interval when the plan was missed while the process was down', async () => {
    // Planned for yesterday: the run is owed, so it goes at the next opportunity today.
    const id = insertJob({ runEveryDays: 3, nextRunAt: '2024-06-14T10:30:00.000Z' });

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    expect(scheduler.getSchedulerStatus()[0].nextRun).toBe(`${BASE_DATE}T10:00:00.000Z`);
    expect(storedPlan(id)).toBe(`${BASE_DATE}T10:00:00.000Z`);
  });

  it('ignores a plan that no longer fits the job window', async () => {
    // Window edited to 14:00-16:00 while the process was down
    insertJob({
      runEveryDays: 1,
      scheduleWindowStart: 1400,
      scheduleWindowEnd: 1600,
      nextRunAt: '2024-06-18T10:30:00.000Z',
    });

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    expect(scheduler.getSchedulerStatus()[0].nextRun).toBe(`${BASE_DATE}T14:00:00.000Z`);
  });

  it('drops the plan when the job stops being eligible', async () => {
    const id = insertJob({ runEveryDays: 1 });
    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();
    expect(storedPlan(id)).not.toBeNull();

    testDb.prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(id);
    scheduler.refreshScheduler();

    expect(storedPlan(id)).toBeNull();
  });
});

describe('cadence anchor', () => {
  it('reads the durable success stamp, so purged logs cannot reset the interval', async () => {
    // A 10-day job whose success log has been swept by log retention
    const id = insertJob({ runEveryDays: 10, lastSuccessAt: `${BASE_DATE}T10:05:00.000Z` });

    const scheduler = await restartScheduler();
    expect(scheduler.daysUntilNextRun(id, TZ, 10)).toBe(10);
  });

  it('reads the logs only when the stamp is missing', async () => {
    // Pre-column history: the backfill covers most of it, and a log answers for the rest
    const id = insertJob({ runEveryDays: 10 });
    testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, `${BASE_DATE}T10:05:00.000Z`);

    const scheduler = await restartScheduler();
    expect(scheduler.daysUntilNextRun(id, TZ, 10)).toBe(10);
  });

  it('takes the stamp as the authority, so the cadence costs one lookup', async () => {
    // The stamp is what every success path writes, so it stands even against a later log
    // row. Keeping both honest is the job of the test below.
    const id = insertJob({ runEveryDays: 10, lastSuccessAt: '2024-06-05T10:05:00.000Z' });
    testDb.prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, `${BASE_DATE}T10:05:00.000Z`);

    const scheduler = await restartScheduler();
    expect(scheduler.daysUntilNextRun(id, TZ, 10)).toBe(0); // 10 days on from the stamp
  });
});

describe('what a run leaves behind', () => {
  function jobArg(id: number, runEveryDays: number): Job {
    return {
      id,
      name: 'Job',
      accountId: null,
      jobType: 'embywatch',
      botUsername: '',
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
      timezone: TZ,
      replyTimeoutMs: 40000,
      retryMax: 1,
      enabled: true,
      createdAt: `${BASE_DATE}T00:00:00Z`,
      config: null,
      startCommand: '/start',
      checkinButton: '签到',
      runEveryDays,
    } as Job;
  }

  it('waits the full interval after a successful run', async () => {
    const id = insertJob({ runEveryDays: 7 });
    const scheduler = await restartScheduler();

    await scheduler.executeJob(jobArg(id, 7), null);

    expect(storedPlan(id)?.startsWith('2024-06-22')).toBe(true); // +7
    // What makes the stamp the authority for the cadence: a run that succeeds writes it
    expect(
      (testDb.prepare('SELECT last_success_at FROM jobs WHERE id = ?').get(id) as
        { last_success_at: string | null }).last_success_at,
    ).toBe(`${BASE_DATE}T08:00:00.000Z`);
  });

  it('tries again the next day after a failed run, not a whole interval later', async () => {
    const id = insertJob({ runEveryDays: 7 });
    const scheduler = await restartScheduler();
    const { runJob } = await import('../jobs/runner');
    vi.mocked(runJob).mockRejectedValueOnce(new Error('Emby server unreachable'));

    await scheduler.executeJob(jobArg(id, 7), null);

    expect(storedPlan(id)?.startsWith('2024-06-16')).toBe(true); // +1
    // The failure did not stamp a success, so the interval still counts from the last one
    expect(
      (testDb.prepare('SELECT last_success_at FROM jobs WHERE id = ?').get(id) as
        { last_success_at: string | null }).last_success_at,
    ).toBeNull();
  });
});

describe('a run the day owes', () => {
  // The wedge case: timers fired, the runs never happened, and by the time the process comes
  // back the window has closed -- which used to put every missed job on tomorrow.
  const afterWindow = `${BASE_DATE}T13:00:00Z`;

  it('places a missed run in the rest of the day, past the closed window', async () => {
    const id = insertJob({ nextRunAt: `${BASE_DATE}T10:30:00.000Z` });
    vi.setSystemTime(new Date(afterWindow));

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    // 13:01, not 10:00 tomorrow: the window is 10:00-12:00 and long shut
    expect(storedPlan(id)).toBe(`${BASE_DATE}T13:01:00.000Z`);
  });

  it('leaves a job that already ran today alone', async () => {
    const id = insertJob({
      nextRunAt: `${BASE_DATE}T10:30:00.000Z`,
      lastSuccessAt: `${BASE_DATE}T10:30:00.000Z`,
    });
    vi.setSystemTime(new Date(afterWindow));

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    // Its run happened, so the plan goes to tomorrow's window as usual
    expect(storedPlan(id)?.startsWith('2024-06-16T10:00')).toBe(true);
  });

  it('does not catch up a plan that belongs to an earlier day', async () => {
    // Days down, not a wedge: the interval decides, so it must not fire tonight
    const id = insertJob({ nextRunAt: '2024-06-13T10:30:00.000Z' });
    vi.setSystemTime(new Date(afterWindow));

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    expect(storedPlan(id)?.startsWith('2024-06-16T10:00')).toBe(true);
  });

  it('staggers the caught-up runs instead of stacking them on one minute', async () => {
    const ids = [1, 2, 3].map(() => insertJob({ nextRunAt: `${BASE_DATE}T10:30:00.000Z` }));
    vi.setSystemTime(new Date(afterWindow));

    const scheduler = await restartScheduler();
    scheduler.refreshScheduler();

    const plans = ids.map((id) => storedPlan(id));
    expect(new Set(plans).size).toBe(3);
    // Every pair at least the 2-minute default gap apart
    const minutes = plans
      .map((p) => new Date(p!).getTime())
      .sort((a, b) => a - b);
    expect(minutes[1] - minutes[0]).toBeGreaterThanOrEqual(2 * 60_000);
    expect(minutes[2] - minutes[1]).toBeGreaterThanOrEqual(2 * 60_000);
  });
});
