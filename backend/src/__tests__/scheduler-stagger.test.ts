let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
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
import {
  refreshScheduler,
  getSchedulerStatus,
  getScheduleGapMinutes,
  DEFAULT_SCHEDULE_GAP_MINUTES,
} from "../scheduler";

// Tests run at 08:00 UTC, before the default 10:00-12:00 window.
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

function insertJob(
  fields: Partial<{
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
  }> = {},
): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `
    INSERT INTO jobs (job_type, account_id, schedule_window_start, schedule_window_end, timezone)
    VALUES ('embywatch', NULL, ?, ?, ?)
  `,
    )
    .run(
      fields.scheduleWindowStart ?? 1000,
      fields.scheduleWindowEnd ?? 1200,
      fields.timezone ?? TZ,
    );
  return Number(lastInsertRowid);
}

function setGap(value: string | null) {
  if (value == null) {
    testDb
      .prepare("DELETE FROM settings WHERE key = 'schedule_min_gap_minutes'")
      .run();
  } else {
    testDb
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('schedule_min_gap_minutes', ?)",
      )
      .run(value);
  }
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM settings;");
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES ('check_daily_run', 'true')")
    .run();
  refreshScheduler(); // flush any leftover schedule entries from previous test
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── getScheduleGapMinutes ───────────────────────────────────────────────────

describe("getScheduleGapMinutes", () => {
  it("returns the default when the setting is missing", () => {
    setGap(null);
    expect(getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
  });

  it("returns the stored value", () => {
    setGap("5");
    expect(getScheduleGapMinutes()).toBe(5);
  });

  it("allows 0 to disable staggering", () => {
    setGap("0");
    expect(getScheduleGapMinutes()).toBe(0);
  });

  it("clamps to the 0-30 range and floors fractions", () => {
    setGap("99");
    expect(getScheduleGapMinutes()).toBe(30);
    setGap("-3");
    expect(getScheduleGapMinutes()).toBe(0);
    setGap("4.7");
    expect(getScheduleGapMinutes()).toBe(4);
  });

  it("returns the default for non-numeric or empty values", () => {
    setGap("abc");
    expect(getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
    setGap("");
    expect(getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
  });
});

// ─── Staggered scheduling ────────────────────────────────────────────────────

describe("staggered scheduling", () => {
  it("keeps jobs sharing a window at least the gap apart", () => {
    setGap("2");
    for (let i = 0; i < 5; i++) insertJob();
    refreshScheduler();

    const times = getSchedulerStatus().map((s) => new Date(s.nextRun).getTime());
    expect(times).toHaveLength(5);
    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        expect(Math.abs(times[i] - times[j])).toBeGreaterThanOrEqual(
          2 * 60_000,
        );
      }
    }
  });

  it("never doubles up a minute while free minutes remain, even in a tight window", () => {
    setGap("2");
    // 5 jobs in a 5-minute window -- the gap is unsatisfiable, but each job
    // should still land on its own minute
    for (let i = 0; i < 5; i++)
      insertJob({ scheduleWindowStart: 1000, scheduleWindowEnd: 1005 });
    refreshScheduler();

    const times = getSchedulerStatus().map((s) => s.nextRun);
    expect(times).toHaveLength(5);
    expect(new Set(times).size).toBe(5);
  });

  it("gap 0 disables staggering entirely", () => {
    setGap("0");
    vi.spyOn(Math, "random").mockReturnValue(0); // every pick lands on window start
    for (let i = 0; i < 3; i++) insertJob();
    refreshScheduler();

    const times = getSchedulerStatus().map((s) => s.nextRun);
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(1); // all collide on 10:00, by design
  });
});
