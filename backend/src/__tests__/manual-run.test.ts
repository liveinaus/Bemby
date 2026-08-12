// jobs/manualRun.ts is what both the "Run now" button and the background bulk
// job queue go through, so its contract matters to both: refuse up front with a
// status, otherwise hand back the log id plus a promise that settles when the
// run is over and the log row has been stamped.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;
let defaultCreds: { apiId: number; apiHash: string } | null = null;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => defaultCreds,
}));

const mocks = vi.hoisted(() => ({
  runJob: vi.fn(),
  notifyJobEvent: vi.fn(),
  registerJob: vi.fn(() => new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));

vi.mock("../jobs/runner", () => ({ runJob: mocks.runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: mocks.notifyJobEvent,
  buildSuccessMessage: (name: string) => `ok ${name}`,
  buildFailureMessage: (name: string) => `bad ${name}`,
  getNotifyConfig: vi.fn(),
  sendTgNotify: vi.fn(),
}));
vi.mock("../jobs/cancellation", () => ({
  registerJob: mocks.registerJob,
  unregisterJob: mocks.unregisterJob,
  registerLiveDetail: mocks.registerLiveDetail,
  clearLiveDetail: mocks.clearLiveDetail,
  cancelJob: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { startManualJobRun } from "../jobs/manualRun";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT 'acc',
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER,
    api_hash       TEXT,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled       INTEGER NOT NULL DEFAULT 0,
    proxy_id       TEXT,
    app_client_id  TEXT
  );
  CREATE TABLE jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL DEFAULT 'Job',
    account_id            INTEGER,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT 'bot',
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'UTC',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT    NOT NULL DEFAULT '/start',
    checkin_button        TEXT    NOT NULL DEFAULT 'x',
    template_id           INTEGER,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    run_every_days_max    INTEGER,
    retired               TEXT,
    last_success_at       TEXT
  );
  CREATE TABLE job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler',
    detail  TEXT
  );
`;

function addAccount(authenticated = true): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `INSERT INTO tg_accounts (api_id, api_hash, session_string, auth_status)
       VALUES (111, 'own-hash', ?, ?)`,
    )
    .run(authenticated ? "session" : null, authenticated ? "authenticated" : "unauthenticated");
  return Number(lastInsertRowid);
}

function addJob(accountId: number | null, jobType = "checkin"): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (name, account_id, job_type) VALUES ('Smoke', ?, ?)")
    .run(accountId, jobType);
  return Number(lastInsertRowid);
}

function log(logId: number) {
  return testDb.prepare("SELECT * FROM job_logs WHERE id = ?").get(logId) as any;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerJob.mockReturnValue(new AbortController().signal);
  defaultCreds = null;
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM tg_accounts;");
});

describe("startManualJobRun", () => {
  it("refuses an unknown job with a 404", () => {
    expect(startManualJobRun(999)).toEqual({
      ok: false,
      status: 404,
      error: "Not found",
    });
  });

  it("refuses a job whose account has no live session", () => {
    const result = startManualJobRun(addJob(addAccount(false)));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mocks.runJob).not.toHaveBeenCalled();
  });

  it("refuses when no credentials are available anywhere", () => {
    const account = testDb
      .prepare(
        "INSERT INTO tg_accounts (api_id, api_hash, session_string, auth_status) VALUES (NULL, NULL, 'session', 'authenticated')",
      )
      .run();
    const result = startManualJobRun(addJob(Number(account.lastInsertRowid)));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (result.ok) return;
    expect(result.error).toMatch(/No API credentials available/);
  });

  it("logs the run as manual and stamps success once the run finishes", async () => {
    mocks.runJob.mockResolvedValue(undefined);
    const jobId = addJob(addAccount());

    const started = startManualJobRun(jobId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The log row exists straight away, so a caller can answer before the run ends
    expect(log(started.logId)).toMatchObject({ status: "running", source: "manual" });

    await started.completion;
    expect(log(started.logId).status).toBe("success");
    const job = testDb.prepare("SELECT last_success_at FROM jobs WHERE id = ?").get(jobId) as any;
    expect(job.last_success_at).not.toBeNull();
    expect(mocks.notifyJobEvent).toHaveBeenCalledWith("success", expect.any(String), expect.anything());
    expect(mocks.unregisterJob).toHaveBeenCalledWith(started.logId);
  });

  it("records a failure without rejecting the completion promise", async () => {
    mocks.runJob.mockRejectedValue(new Error("bot never replied"));
    const started = startManualJobRun(addJob(addAccount()));
    if (!started.ok) throw new Error("expected the run to start");

    await expect(started.completion).resolves.toBeUndefined();
    expect(log(started.logId)).toMatchObject({
      status: "failed",
      message: "bot never replied",
    });
    expect(mocks.notifyJobEvent).toHaveBeenCalledWith("failed", expect.any(String), expect.anything());
  });

  it("records a cancelled run as cancelled and sends no failure notification", async () => {
    mocks.runJob.mockRejectedValue(new Error("Job cancelled"));
    const started = startManualJobRun(addJob(addAccount()));
    if (!started.ok) throw new Error("expected the run to start");

    await started.completion;
    expect(log(started.logId)).toMatchObject({ status: "failed", message: "Cancelled" });
    expect(mocks.notifyJobEvent).not.toHaveBeenCalled();
  });

  // A cancel that gave up waiting settles the row itself, so the button stops spinning. The
  // run then finishes later and must leave that verdict alone -- overwriting it flips a row
  // the user was already shown back to success.
  it("leaves a row another hand already settled alone when it finishes", async () => {
    let finish!: () => void;
    mocks.runJob.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const started = startManualJobRun(addJob(addAccount()));
    if (!started.ok) throw new Error("expected the run to start");

    testDb
      .prepare("UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ?")
      .run(started.logId);
    finish();
    await started.completion;

    expect(log(started.logId)).toMatchObject({
      status: "failed",
      message: "Force stopped",
    });
  });

  it("does the same when the run fails after the row was settled", async () => {
    let fail!: (err: Error) => void;
    mocks.runJob.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
    const started = startManualJobRun(addJob(addAccount()));
    if (!started.ok) throw new Error("expected the run to start");

    testDb
      .prepare("UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ?")
      .run(started.logId);
    fail(new Error("the browser never came back"));
    await started.completion;

    expect(log(started.logId).message).toBe("Force stopped");
  });

  it("runs an account-less job type without demanding a session", async () => {
    mocks.runJob.mockResolvedValue(undefined);
    const started = startManualJobRun(addJob(null, "embywatch"));
    if (!started.ok) throw new Error("expected the run to start");
    await started.completion;
    expect(mocks.runJob.mock.calls[0][1]).toBeNull();
    expect(log(started.logId).status).toBe("success");
  });

  it("passes the linked account to embywatch when it has a session", async () => {
    mocks.runJob.mockResolvedValue(undefined);
    const accountId = addAccount();
    const started = startManualJobRun(addJob(accountId, "embywatch"));
    if (!started.ok) throw new Error("expected the run to start");
    await started.completion;
    expect(mocks.runJob.mock.calls[0][1]).toMatchObject({ id: accountId });
  });
});
