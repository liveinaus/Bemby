// Jobs with an empty timezone follow the default_timezone setting at
// scheduling time, so changing the default reschedules them (issue #13).

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
  FALLBACK_TIMEZONE: "Australia/Sydney",
  getDefaultTimezone: () => {
    const row = testDb
      .prepare("SELECT value FROM settings WHERE key = 'default_timezone'")
      .get() as { value: string } | undefined;
    return row?.value || "Australia/Sydney";
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

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import {
  refreshScheduler,
  getSchedulerStatus,
  resolveJobTimezone,
} from "../scheduler";

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
    schedule_window_start INTEGER NOT NULL DEFAULT 100,
    schedule_window_end   INTEGER NOT NULL DEFAULT 300,
    timezone              TEXT    NOT NULL DEFAULT '',
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

function insertJob(timezone = ""): number {
  const { lastInsertRowid } = testDb
    .prepare(
      "INSERT INTO jobs (job_type, account_id, timezone) VALUES ('embywatch', NULL, ?)",
    )
    .run(timezone);
  return Number(lastInsertRowid);
}

function setDefaultTimezone(tz: string) {
  testDb
    .prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('default_timezone', ?)",
    )
    .run(tz);
}

function nextRunIn(zone: string): DateTime {
  const status = getSchedulerStatus();
  expect(status).toHaveLength(1);
  return DateTime.fromISO(status[0].nextRun, { zone });
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.useFakeTimers();
  // 08:00 UTC = 16:00 in Hong Kong, past the 01:00-03:00 window
  vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM settings;");
  refreshScheduler(); // flush leftover schedule entries from previous test
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveJobTimezone", () => {
  it("returns the job's own zone when set and valid", () => {
    expect(resolveJobTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls back to the default for empty or invalid zones", () => {
    setDefaultTimezone("Asia/Hong_Kong");
    expect(resolveJobTimezone("")).toBe("Asia/Hong_Kong");
    expect(resolveJobTimezone(null)).toBe("Asia/Hong_Kong");
    expect(resolveJobTimezone("Not/AZone")).toBe("Asia/Hong_Kong");
  });

  it("uses the built-in fallback when the default itself is invalid", () => {
    setDefaultTimezone("garbage");
    expect(resolveJobTimezone("")).toBe("Australia/Sydney");
  });
});

describe("default timezone scheduling", () => {
  it("schedules a follow-default job in the default zone's window", () => {
    setDefaultTimezone("Asia/Hong_Kong");
    insertJob();
    refreshScheduler();

    const next = nextRunIn("Asia/Hong_Kong");
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
    // Window already passed today in HK, so it lands tomorrow
    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("reschedules follow-default jobs when the default changes", () => {
    setDefaultTimezone("Asia/Hong_Kong");
    insertJob();
    refreshScheduler();
    const before = nextRunIn("Asia/Hong_Kong");

    setDefaultTimezone("America/New_York");
    refreshScheduler();

    const next = nextRunIn("America/New_York");
    expect(next.toMillis()).not.toBe(before.toMillis());
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
  });

  it("leaves jobs with an explicit timezone untouched by a default change", () => {
    setDefaultTimezone("Asia/Hong_Kong");
    insertJob("Asia/Tokyo");
    refreshScheduler();
    const before = nextRunIn("Asia/Tokyo");
    expect(before.hour).toBeGreaterThanOrEqual(1);
    expect(before.hour).toBeLessThan(3);

    setDefaultTimezone("America/New_York");
    refreshScheduler();

    expect(nextRunIn("Asia/Tokyo").toMillis()).toBe(before.toMillis());
  });

  it("schedules an invalid job timezone in the default zone instead of breaking", () => {
    setDefaultTimezone("UTC");
    insertJob("Not/AZone");
    refreshScheduler();

    const next = nextRunIn("UTC");
    expect(next.isValid).toBe(true);
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
  });
});
