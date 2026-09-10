// Tests for the account-disable feature:
//   1. DB column — 'disabled' defaults to 0, persists correctly
//   2. Scheduler filter — loadEligibleJobs excludes jobs whose account is disabled,
//      keeps jobs with enabled accounts, and keeps no-account (embywatch) jobs.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildFailureMessage: vi.fn(),
  buildSuccessMessage: vi.fn(),
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
}));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { loadEligibleJobs } from "../scheduler";

// ---------------------------------------------------------------------------
// Schema — mirrors the real DB, includes the disabled column
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
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
    template_id           INTEGER,
    retired               TEXT,
    last_success_at       TEXT,
    next_run_at           TEXT
  );
`;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertAccount(
  fields: Partial<{
    name: string;
    authStatus: string;
    sessionString: string | null;
    disabled: number;
  }> = {},
) {
  const { lastInsertRowid } = testDb
    .prepare(
      `
    INSERT INTO tg_accounts (name, auth_status, session_string, disabled)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(
      fields.name ?? "Acct",
      fields.authStatus ?? "authenticated",
      fields.sessionString !== undefined ? fields.sessionString : "sess",
      fields.disabled ?? 0,
    );
  return testDb
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(lastInsertRowid) as any;
}

function insertJob(
  fields: Partial<{
    name: string;
    accountId: number | null;
    jobType: string;
    enabled: number;
  }> = {},
) {
  const { lastInsertRowid } = testDb
    .prepare(
      `
    INSERT INTO jobs (name, account_id, job_type, enabled)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(
      fields.name ?? "Job",
      fields.accountId !== undefined ? fields.accountId : null,
      fields.jobType ?? "checkin",
      fields.enabled ?? 1,
    );
  return testDb
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(lastInsertRowid) as any;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM jobs; DELETE FROM tg_accounts;");
});

// ---------------------------------------------------------------------------
// DB column behaviour
// ---------------------------------------------------------------------------

describe("tg_accounts.disabled column", () => {
  it("defaults to 0 for a newly inserted account", () => {
    const { lastInsertRowid } = testDb
      .prepare(
        "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES ('A', '+1', 1, 'h')",
      )
      .run();
    const row = testDb
      .prepare("SELECT disabled FROM tg_accounts WHERE id = ?")
      .get(lastInsertRowid) as any;
    expect(row.disabled).toBe(0);
  });

  it("persists disabled = 1 after an UPDATE", () => {
    const a = insertAccount({ disabled: 0 });
    testDb
      .prepare("UPDATE tg_accounts SET disabled = 1 WHERE id = ?")
      .run(a.id);
    const row = testDb
      .prepare("SELECT disabled FROM tg_accounts WHERE id = ?")
      .get(a.id) as any;
    expect(row.disabled).toBe(1);
  });

  it("can be toggled back to 0", () => {
    const a = insertAccount({ disabled: 1 });
    testDb
      .prepare("UPDATE tg_accounts SET disabled = 0 WHERE id = ?")
      .run(a.id);
    const row = testDb
      .prepare("SELECT disabled FROM tg_accounts WHERE id = ?")
      .get(a.id) as any;
    expect(row.disabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scheduler filter — loadEligibleJobs
// ---------------------------------------------------------------------------

describe("loadEligibleJobs — disabled account filter", () => {
  it("excludes a checkin job whose account is disabled", () => {
    const disabledAcct = insertAccount({ disabled: 1 });
    const job = insertJob({ accountId: disabledAcct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("includes a checkin job whose account is enabled", () => {
    const enabledAcct = insertAccount({ disabled: 0 });
    const job = insertJob({ accountId: enabledAcct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).toContain(job.id);
  });

  it("includes an embywatch job with no account regardless of other disabled accounts", () => {
    // Insert an unrelated disabled account to make sure the filter is precise
    insertAccount({ disabled: 1 });
    const job = insertJob({ accountId: null, jobType: "embywatch" });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).toContain(job.id);
  });

  it("excludes a custom job whose account is disabled", () => {
    const disabledAcct = insertAccount({ disabled: 1 });
    const job = insertJob({ accountId: disabledAcct.id, jobType: "custom" });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("keeps enabled-account jobs while filtering disabled-account jobs in the same query", () => {
    const enabled = insertAccount({ name: "Enabled", disabled: 0 });
    const disabled = insertAccount({ name: "Disabled", disabled: 1 });
    const goodJob = insertJob({ accountId: enabled.id, jobType: "checkin" });
    const badJob = insertJob({ accountId: disabled.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();
    const ids = eligible.map((e) => e.job.id);

    expect(ids).toContain(goodJob.id);
    expect(ids).not.toContain(badJob.id);
  });

  it("excludes a job that is explicitly disabled (enabled = 0)", () => {
    const acct = insertAccount({ disabled: 0 });
    const job = insertJob({
      accountId: acct.id,
      jobType: "checkin",
      enabled: 0,
    });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("excludes a checkin job whose account has no session string", () => {
    const unauthAcct = insertAccount({
      authStatus: "unauthenticated",
      sessionString: null,
      disabled: 0,
    });
    const job = insertJob({ accountId: unauthAcct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("returns account with disabled=false on the account object for eligible jobs", () => {
    const acct = insertAccount({ disabled: 0 });
    insertJob({ accountId: acct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();
    const entry = eligible.find((e) => e.account?.id === acct.id);

    expect(entry).toBeDefined();
    expect(entry!.account!.disabled).toBe(false);
  });

  it("returns account with the correct appClientId when one is set", () => {
    const acct = insertAccount({ disabled: 0 });
    testDb
      .prepare("UPDATE tg_accounts SET app_client_id = ? WHERE id = ?")
      .run("preset-ios", acct.id);
    insertJob({ accountId: acct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();
    const entry = eligible.find((e) => e.account?.id === acct.id);

    expect(entry).toBeDefined();
    expect(entry!.account!.appClientId).toBe("preset-ios");
  });

  it("returns account with appClientId null when no client is assigned", () => {
    const acct = insertAccount({ disabled: 0 }); // no app_client_id set
    insertJob({ accountId: acct.id, jobType: "checkin" });

    const eligible = loadEligibleJobs();
    const entry = eligible.find((e) => e.account?.id === acct.id);

    expect(entry!.account!.appClientId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheduler filter — orphaned account_id (account row deleted / never existed)
//
// Regression test: deleting a tg_accounts row that still had jobs pointing at
// it (account_id INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL) used
// to silently vanish from the scheduler forever, since the WHERE clause
// treated "no joined account row" the same as "job legitimately has no
// account" (embywatch). Only embywatch jobs kept appearing as a result.
// ---------------------------------------------------------------------------

describe("loadEligibleJobs — orphaned account (account_id set but row missing)", () => {
  it("excludes a checkin job after its linked account is deleted", () => {
    const acct = insertAccount({ disabled: 0 });
    const job = insertJob({ accountId: acct.id, jobType: "checkin" });

    testDb.prepare("DELETE FROM tg_accounts WHERE id = ?").run(acct.id);
    // ON DELETE SET NULL should have nulled the FK
    const row = testDb
      .prepare("SELECT account_id FROM jobs WHERE id = ?")
      .get(job.id) as any;
    expect(row.account_id).toBeNull();

    const eligible = loadEligibleJobs();
    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("excludes a custom job whose account_id points at a nonexistent account", () => {
    // Simulates legacy data from before the FK constraint existed — insert
    // with FK checks off since a live SQLite connection would otherwise
    // reject a dangling reference outright.
    testDb.pragma("foreign_keys = OFF");
    const job = insertJob({ accountId: 999999, jobType: "custom" });
    testDb.pragma("foreign_keys = ON");

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).not.toContain(job.id);
  });

  it("keeps an embywatch job schedulable once cascade nulls its optional account link", () => {
    // account_id is optional for embywatch — once ON DELETE SET NULL fires,
    // the job correctly falls back to running without a linked account.
    const acct = insertAccount({ disabled: 0 });
    const job = insertJob({ accountId: acct.id, jobType: "embywatch" });

    testDb.prepare("DELETE FROM tg_accounts WHERE id = ?").run(acct.id);

    const eligible = loadEligibleJobs();

    expect(eligible.map((e) => e.job.id)).toContain(job.id);
  });

  it("still includes healthy checkin/custom/embywatch jobs alongside an orphaned one", () => {
    const acct = insertAccount({ disabled: 0 });
    const healthyCheckin = insertJob({ accountId: acct.id, jobType: "checkin" });
    const healthyWatch = insertJob({ accountId: null, jobType: "embywatch" });

    testDb.pragma("foreign_keys = OFF");
    const orphaned = insertJob({ accountId: 424242, jobType: "checkin" });
    testDb.pragma("foreign_keys = ON");

    const eligible = loadEligibleJobs();
    const ids = eligible.map((e) => e.job.id);

    expect(ids).toContain(healthyCheckin.id);
    expect(ids).toContain(healthyWatch.id);
    expect(ids).not.toContain(orphaned.id);
  });
});
