let testDb!: InstanceType<typeof Database>;
let releaseRun: Array<() => void> = [];

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
// Each runJob call blocks until its release function is invoked
vi.mock("../jobs/runner", () => ({
  runJob: vi.fn(
    () => new Promise<void>((resolve) => releaseRun.push(resolve)),
  ),
}));
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

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { executeJob } from "../scheduler";
import { runJob } from "../jobs/runner";
import type { Job } from "../types";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL DEFAULT 'Job',
    account_id            INTEGER,
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
    detail  TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function insertJob(): Job {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id) VALUES ('embywatch', NULL)")
    .run();
  return { id: Number(lastInsertRowid) } as Job;
}

// Drain the microtask queue so pending awaits settle without advancing timers
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
  releaseRun = [];
  vi.mocked(runJob).mockClear();
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs;");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("job execution concurrency cap", () => {
  it("runs at most 2 jobs at once and queues the rest", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];

    const p1 = executeJob(j1, null);
    const p2 = executeJob(j2, null);
    const p3 = executeJob(j3, null);
    await drain();

    // Third job waits for a free slot
    expect(runJob).toHaveBeenCalledTimes(2);

    releaseRun[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun[1]();
    releaseRun[2]();
    await drain();
    await Promise.all([p1, p2, p3]);

    const statuses = testDb
      .prepare("SELECT status FROM job_logs ORDER BY id")
      .all() as Array<{ status: string }>;
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.status === "success")).toBe(true);
  });

  it("does not create the run log until a slot is acquired", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];

    const runs = [executeJob(j1, null), executeJob(j2, null), executeJob(j3, null)];
    await drain();

    // Only the two running jobs have log rows; the queued one has none yet
    const count = testDb
      .prepare("SELECT COUNT(*) AS n FROM job_logs")
      .get() as { n: number };
    expect(count.n).toBe(2);

    releaseRun.forEach((release) => release());
    await drain();
    releaseRun.forEach((release) => release()); // release the late starter too
    await drain();
    await Promise.all(runs);
  });

  it("frees the slot when a job fails", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];
    vi.mocked(runJob).mockRejectedValueOnce(new Error("boom"));

    const p1 = executeJob(j1, null);
    await drain();
    const p2 = executeJob(j2, null);
    const p3 = executeJob(j3, null);
    await drain();

    // j1 failed immediately, so its slot was released and all three have run
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun.forEach((release) => release());
    await drain();
    await Promise.all([p1, p2, p3]);
  });
});
