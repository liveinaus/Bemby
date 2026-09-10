// Global TG API credential fallback: credentials must resolve as a pair --
// the account's own when complete, otherwise the global defaults -- and the
// manual-run route must apply the same fallback the scheduler does.

let testDb!: InstanceType<typeof Database>;
let defaultCreds: { apiId: number; apiHash: string } | null = null;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: vi.fn(() => defaultCreds),
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { loadEligibleJobs } from "../scheduler";
import jobsRouter from "../routes/jobs";
import { runJob } from "../jobs/runner";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    phone_number  TEXT    NOT NULL DEFAULT '',
    api_id        INTEGER,
    api_hash      TEXT,
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
    account_id            INTEGER,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT 'bot',
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
    job_id  INTEGER NOT NULL,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler',
    detail  TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function insertAccount(apiId: number | null, apiHash: string | null): number {
  const { lastInsertRowid } = testDb
    .prepare(
      `
    INSERT INTO tg_accounts (name, api_id, api_hash, session_string, auth_status)
    VALUES ('acc', ?, ?, 'session', 'authenticated')
  `,
    )
    .run(apiId, apiHash);
  return Number(lastInsertRowid);
}

function insertCheckinJob(accountId: number): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id) VALUES ('checkin', ?)")
    .run(accountId);
  return Number(lastInsertRowid);
}

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (jobsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  defaultCreds = null;
  vi.mocked(runJob).mockClear();
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM tg_accounts;");
});

// ─── loadEligibleJobs credential pairing ─────────────────────────────────────

describe("loadEligibleJobs credential pairing", () => {
  it("keeps the account's own pair when complete, even with defaults set", () => {
    defaultCreds = { apiId: 999, apiHash: "global-hash" };
    insertCheckinJob(insertAccount(111, "own-hash"));

    const [{ account }] = loadEligibleJobs();
    expect(account?.apiId).toBe(111);
    expect(account?.apiHash).toBe("own-hash");
  });

  it("uses the full global pair when the account pair is incomplete", () => {
    defaultCreds = { apiId: 999, apiHash: "global-hash" };
    // api_id set but no hash -- must NOT mix own id with global hash
    insertCheckinJob(insertAccount(111, null));

    const [{ account }] = loadEligibleJobs();
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("treats 0 / empty-string credentials as missing", () => {
    defaultCreds = { apiId: 999, apiHash: "global-hash" };
    insertCheckinJob(insertAccount(0, ""));

    const [{ account }] = loadEligibleJobs();
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("resolves to nulls when neither account nor global credentials exist", () => {
    insertCheckinJob(insertAccount(null, null));

    const [{ account }] = loadEligibleJobs();
    expect(account?.apiId).toBeNull();
    expect(account?.apiHash).toBeNull();
  });
});

// ─── POST /:id/run credential fallback ───────────────────────────────────────

describe("manual run credential fallback", () => {
  const run = () => routeHandler("post", "/:id/run");

  it("falls back to global defaults when the account has no credentials", async () => {
    defaultCreds = { apiId: 999, apiHash: "global-hash" };
    const jobId = insertCheckinJob(insertAccount(null, null));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(runJob).toHaveBeenCalledTimes(1);
    const account = vi.mocked(runJob).mock.calls[0][1];
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("uses the account's own complete pair over the defaults", async () => {
    defaultCreds = { apiId: 999, apiHash: "global-hash" };
    const jobId = insertCheckinJob(insertAccount(111, "own-hash"));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    const account = vi.mocked(runJob).mock.calls[0][1];
    expect(account?.apiId).toBe(111);
    expect(account?.apiHash).toBe("own-hash");
  });

  it("returns 400 when no credentials are available anywhere", async () => {
    const jobId = insertCheckinJob(insertAccount(null, null));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No API credentials available/);
    expect(runJob).not.toHaveBeenCalled();
  });
});
