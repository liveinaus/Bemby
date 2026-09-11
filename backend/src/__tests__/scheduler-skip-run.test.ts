let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn(() => new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { refreshScheduler, getSchedulerStatus, skipNextRun } from "../scheduler";

// 08:00 UTC, before the default 10:00-12:00 window, so every job has a run coming today
const BASE_DATE = "2024-06-15";
const TZ = "UTC";

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
    app_client_id TEXT
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

// checkin/custom/autoreg jobs are only eligible with an authenticated account behind them
function insertAccount(): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO tg_accounts (name, api_id, api_hash, session_string, auth_status)
       VALUES ('acct', 1, 'hash', 'session', 'authenticated')`,
    )
    .run();
  return Number(lastInsertRowid);
}

function insertJob(
  name: string,
  jobType = "checkin",
  window?: { start: number; end: number },
): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO jobs (name, job_type, account_id, timezone, schedule_window_start, schedule_window_end)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, jobType, accountId, TZ, window?.start ?? 1000, window?.end ?? 1200);
  return Number(lastInsertRowid);
}

let accountId = 0;

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM tg_accounts; DELETE FROM settings;");
  accountId = insertAccount();
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES ('check_daily_run', 'true')")
    .run();
  refreshScheduler(); // flush entries left by an earlier test
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getSchedulerStatus", () => {
  it("reports each job's type, which is what the list colours the chips by", () => {
    insertJob("Checkin job", "checkin");
    insertJob("Watch job", "embywatch");
    insertJob("Custom job", "custom");
    insertJob("Signup job", "autoreg");
    refreshScheduler();

    const byName = Object.fromEntries(
      getSchedulerStatus().map((s) => [s.jobName, s.jobType]),
    );
    expect(byName).toEqual({
      "Checkin job": "checkin",
      "Watch job": "embywatch",
      "Custom job": "custom",
      "Signup job": "autoreg",
    });
  });
});

describe("skipNextRun", () => {
  it("moves the pending run to a later day and keeps the job scheduled", () => {
    const id = insertJob("Daily job");
    refreshScheduler();
    const before = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;

    const result = skipNextRun(id);

    expect(result.ok).toBe(true);
    const after = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;
    expect(after).toBe(result.nextRun);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    // A day out, not merely a later slot in today's window
    expect(new Date(after).getUTCDate()).toBeGreaterThan(new Date(before).getUTCDate());
  });

  it("leaves the job in the list rather than unscheduling it", () => {
    const id = insertJob("Daily job");
    refreshScheduler();
    skipNextRun(id);
    expect(getSchedulerStatus().map((s) => s.jobId)).toContain(id);
  });

  it("does not fire the run that was called off", () => {
    const id = insertJob("Daily job");
    refreshScheduler();
    const firesAt = new Date(getSchedulerStatus()[0].nextRun).getTime();
    skipNextRun(id);

    // Past the original slot: nothing should have run, and the entry still stands
    vi.setSystemTime(new Date(firesAt + 60_000));
    vi.advanceTimersByTime(firesAt + 60_000 - Date.parse(`${BASE_DATE}T08:00:00Z`));
    expect(
      testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("leaves other jobs' runs alone", () => {
    const a = insertJob("Job A");
    const b = insertJob("Job B");
    refreshScheduler();
    const bBefore = getSchedulerStatus().find((s) => s.jobId === b)!.nextRun;

    skipNextRun(a);

    expect(getSchedulerStatus().find((s) => s.jobId === b)!.nextRun).toBe(bBefore);
  });

  it("moves a run that is already days out further still, never nearer", () => {
    // Window is behind us today, so the pending run is already tomorrow. Counting a day from
    // today would land back on that same day -- possibly at an earlier minute.
    const id = insertJob("Evening job", "checkin", { start: 300, end: 500 });
    refreshScheduler();
    const before = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;
    expect(new Date(before).getUTCDate()).toBe(16); // tomorrow

    skipNextRun(id);

    const after = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(new Date(after).getUTCDate()).toBe(17);
  });

  it("skips a whole interval for a job that does not run daily", () => {
    const id = insertJob("Every third day");
    testDb.prepare("UPDATE jobs SET run_every_days = 3 WHERE id = ?").run(id);
    refreshScheduler();
    const before = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;

    skipNextRun(id);

    const after = getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;
    const days =
      (new Date(after).setUTCHours(0, 0, 0, 0) - new Date(before).setUTCHours(0, 0, 0, 0)) /
      86_400_000;
    expect(days).toBe(3);
  });

  it("reports a job that has no scheduled run rather than throwing", () => {
    expect(skipNextRun(4242)).toEqual({ ok: false });
  });
});
