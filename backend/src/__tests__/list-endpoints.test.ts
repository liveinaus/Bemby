// Contract tests for opt-in server-side pagination, filtering, and fuzzy search on the
// list endpoints (templates, jobs, accounts, logs). Without a `page`/`pageSize` param the
// legacy full-array response must be preserved for dropdown consumers.

import Database from "better-sqlite3";
import http from "http";
import express from "express";
import { fuzzyScore } from "../db/fuzzy";

let testDb!: InstanceType<typeof Database>;
const refreshScheduler = vi.fn();

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({ refreshScheduler }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
  getPasswordInfo: vi.fn(),
  sendLoginEmailCode: vi.fn(),
  verifyLoginEmail: vi.fn(),
  getPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn(), runCheckin: vi.fn(), CheckinError: class extends Error {} }));
vi.mock("../jobs/custom", () => ({ runCustom: vi.fn(), CustomJobError: class extends Error {} }));
vi.mock("../jobs/embywatch", () => ({ runEmbywatch: vi.fn(), testEmbyConnection: vi.fn() }));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn(), parseTgProxy: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildFailureMessage: vi.fn(),
  buildSuccessMessage: vi.fn(),
  getNotifyConfig: vi.fn(),
}));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn(() => false),
  getLiveDetail: vi.fn(() => null),
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../tg/liveClient", () => ({
  isAuthError: vi.fn(),
  markSessionExpired: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER,
    api_hash       TEXT,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username    TEXT,
    notes          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE job_templates (
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

  CREATE TABLE jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    config                TEXT,
    start_command         TEXT NOT NULL DEFAULT '/start',
    checkin_button        TEXT NOT NULL DEFAULT '签到',
    template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    retired               TEXT,
    last_success_at       TEXT,
    one_time              INTEGER NOT NULL DEFAULT 0,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    detail  TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    source  TEXT    NOT NULL DEFAULT 'scheduler'
  );
`;

let server: http.Server;
let baseUrl: string;

async function getJson(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
  // Mirror the registration done in db/database.ts
  testDb.function("fuzzy_score", { deterministic: true }, (needle, haystack) =>
    fuzzyScore(needle, haystack),
  );

  const { default: templatesRouter } = await import("../routes/templates");
  const { default: jobsRouter } = await import("../routes/jobs");
  const { default: accountsRouter } = await import("../routes/accounts");
  const { default: logsRouter } = await import("../routes/logs");

  const app = express();
  app.use(express.json());
  app.use("/templates", templatesRouter);
  app.use("/jobs", jobsRouter);
  app.use("/accounts", accountsRouter);
  app.use("/logs", logsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;");
});

function insertTemplate(
  name: string,
  opts: {
    jobType?: string;
    bot?: string;
    enabled?: number;
    config?: string;
    timezone?: string;
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
  } = {},
) {
  return testDb
    .prepare(
      "INSERT INTO job_templates (name, job_type, bot_username, enabled, config, timezone, run_every_days, run_every_days_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      name,
      opts.jobType ?? "checkin",
      opts.bot ?? "",
      opts.enabled ?? 1,
      opts.config ?? null,
      opts.timezone ?? "Australia/Sydney",
      opts.runEveryDays ?? 1,
      opts.runEveryDaysMax ?? null,
    ).lastInsertRowid as number;
}

/** Backdates a template, so the added-date column has something to sort. */
function setCreatedAt(id: number, at: string) {
  testDb.prepare("UPDATE job_templates SET created_at = ? WHERE id = ?").run(at, id);
}

function insertAccount(
  name: string,
  opts: {
    disabled?: number;
    notes?: string;
    phone?: string;
    tgName?: string;
    tgUsername?: string;
  } = {},
) {
  return testDb
    .prepare(
      "INSERT INTO tg_accounts (name, phone_number, disabled, notes, tg_display_name, tg_username) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      name,
      opts.phone ?? "+61",
      opts.disabled ?? 0,
      opts.notes ?? null,
      opts.tgName ?? null,
      opts.tgUsername ?? null,
    ).lastInsertRowid as number;
}

function insertJob(name: string, opts: { accountId?: number | null; jobType?: string; bot?: string; templateId?: number | null } = {}) {
  return testDb
    .prepare("INSERT INTO jobs (name, account_id, job_type, bot_username, template_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, opts.accountId ?? null, opts.jobType ?? "checkin", opts.bot ?? "", opts.templateId ?? null).lastInsertRowid as number;
}

function insertLog(jobId: number, status: string, message: string, ranAt: string) {
  return testDb
    .prepare("INSERT INTO job_logs (job_id, ran_at, status, message) VALUES (?, ?, ?, ?)")
    .run(jobId, ranAt, status, message).lastInsertRowid as number;
}

describe("fuzzyScore", () => {
  it("matches substrings with a high score", () => {
    expect(fuzzyScore("daily", "My Daily Checkin")).toBeGreaterThan(500);
  });

  it("matches subsequences", () => {
    expect(fuzzyScore("dlychk", "daily checkin")).toBeGreaterThan(0);
  });

  it("requires every token to match", () => {
    expect(fuzzyScore("daily bot", "daily checkin @mybot")).toBeGreaterThan(0);
    expect(fuzzyScore("daily zzz", "daily checkin")).toBe(0);
  });

  it("returns 0 when characters are out of order", () => {
    expect(fuzzyScore("xyz", "daily checkin")).toBe(0);
  });

  it("ranks tighter matches higher", () => {
    const tight = fuzzyScore("abc", "abc-template");
    const loose = fuzzyScore("abc", "a1b2c3");
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("GET /templates", () => {
  it("keeps the legacy array shape without paging params", async () => {
    insertTemplate("Alpha");
    insertTemplate("Beta");
    const { body } = await getJson("/templates");
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((t: any) => t.name)).toEqual(["Alpha", "Beta"]);
  });

  it("returns a paged envelope with total", async () => {
    for (let i = 1; i <= 7; i++) insertTemplate(`Tpl ${String(i).padStart(2, "0")}`);
    const { body } = await getJson("/templates?page=2&pageSize=3");
    expect(body.total).toBe(7);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(3);
    expect(body.items.map((t: any) => t.name)).toEqual(["Tpl 04", "Tpl 05", "Tpl 06"]);
  });

  it("fuzzy search filters and ranks by relevance", async () => {
    insertTemplate("Daily Checkin", { bot: "dailybot" });
    insertTemplate("Weekly Report", { bot: "weeklybot" });
    insertTemplate("Dry Cleaner", { bot: "cleanbot" });
    const { body } = await getJson("/templates?page=1&pageSize=10&search=daily");
    const names = body.items.map((t: any) => t.name);
    expect(names[0]).toBe("Daily Checkin");
    expect(names).not.toContain("Weekly Report");
    expect(body.total).toBe(1);
  });

  it("fuzzy search matches subsequences and bot usernames", async () => {
    insertTemplate("Signin Group", { bot: "sgn_helper" });
    insertTemplate("Other", { bot: "another" });
    const { body } = await getJson("/templates?page=1&pageSize=10&search=sgnhlp");
    expect(body.items.map((t: any) => t.name)).toEqual(["Signin Group"]);
  });

  it("filters by jobType and enabled", async () => {
    insertTemplate("A", { jobType: "checkin", enabled: 1 });
    insertTemplate("B", { jobType: "custom", enabled: 0 });
    const byType = await getJson("/templates?page=1&pageSize=10&jobType=custom");
    expect(byType.body.items.map((t: any) => t.name)).toEqual(["B"]);
    const byEnabled = await getJson("/templates?page=1&pageSize=10&enabled=1");
    expect(byEnabled.body.items.map((t: any) => t.name)).toEqual(["A"]);
  });

  it("sorts by requested column and direction", async () => {
    insertTemplate("A", { bot: "zbot" });
    insertTemplate("B", { bot: "abot" });
    const { body } = await getJson("/templates?page=1&pageSize=10&sortKey=botUrl&sortDir=desc");
    expect(body.items.map((t: any) => t.name)).toEqual(["A", "B"]);
  });

  // The date a template was added is a column of its own, so it has to be sortable both ways
  it("sorts by the date the template was added", async () => {
    const older = insertTemplate("Older");
    const newer = insertTemplate("Newer");
    setCreatedAt(older, "2026-01-05 09:00:00");
    setCreatedAt(newer, "2026-08-12 09:00:00");

    const asc = await getJson("/templates?page=1&pageSize=10&sortKey=created&sortDir=asc");
    expect(asc.body.items.map((t: any) => t.name)).toEqual(["Older", "Newer"]);
    const desc = await getJson("/templates?page=1&pageSize=10&sortKey=created&sortDir=desc");
    expect(desc.body.items.map((t: any) => t.name)).toEqual(["Newer", "Older"]);
  });

  it("reports the date each template was added", async () => {
    const id = insertTemplate("Dated");
    setCreatedAt(id, "2026-01-05 09:00:00");
    const { body } = await getJson("/templates");
    expect(body[0].createdAt).toBe("2026-01-05 09:00:00");
  });
});

describe("GET /jobs", () => {
  it("keeps the legacy array shape without paging params", async () => {
    insertJob("Job A");
    insertJob("Job B");
    const { body } = await getJson("/jobs");
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("pages, filters, and reports facets", async () => {
    const acct = insertAccount("Acct 1");
    const tpl = insertTemplate("Tpl", { bot: "tplbot" });
    insertJob("Standalone", { bot: "solobot", jobType: "custom" });
    insertJob("Linked", { accountId: acct, jobType: "custom", bot: "tplbot", templateId: tpl });
    insertJob("Other", { accountId: acct, jobType: "checkin", bot: "otherbot" });

    const { body } = await getJson("/jobs?page=1&pageSize=2&sortKey=name");
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
    expect(body.facets.botUsernames).toEqual(["otherbot", "solobot"]);
    expect(body.facets.templates).toEqual([{ id: tpl, name: "Tpl" }]);

    const filtered = await getJson(`/jobs?page=1&pageSize=10&accountId=${acct}&jobType=checkin`);
    expect(filtered.body.items.map((j: any) => j.name)).toEqual(["Other"]);

    const byTemplate = await getJson(`/jobs?page=1&pageSize=10&templateId=${tpl}`);
    expect(byTemplate.body.items.map((j: any) => j.name)).toEqual(["Linked"]);

    const byName = await getJson("/jobs?page=1&pageSize=10&search=stand");
    expect(byName.body.items.map((j: any) => j.name)).toEqual(["Standalone"]);
  });

  it("escapes LIKE wildcards in search", async () => {
    insertJob("100% real");
    insertJob("underscored");
    const { body } = await getJson(`/jobs?page=1&pageSize=10&search=${encodeURIComponent("100%")}`);
    expect(body.items.map((j: any) => j.name)).toEqual(["100% real"]);
  });
});

describe("GET /accounts", () => {
  it("keeps the legacy array shape without paging params", async () => {
    insertAccount("One");
    const { body } = await getJson("/accounts");
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].name).toBe("One");
  });

  it("pages and searches name, phone, and notes", async () => {
    insertAccount("Primary", { phone: "+6140000", notes: "vip customer" });
    insertAccount("Backup", { phone: "+6150000" });
    insertAccount("Spare", { phone: "+6160000", disabled: 1 });

    const paged = await getJson("/accounts?page=1&pageSize=2");
    expect(paged.body.total).toBe(3);
    expect(paged.body.items).toHaveLength(2);

    const byNotes = await getJson("/accounts?page=1&pageSize=10&search=vip");
    expect(byNotes.body.items.map((a: any) => a.name)).toEqual(["Primary"]);

    const byPhone = await getJson("/accounts?page=1&pageSize=10&search=615");
    expect(byPhone.body.items.map((a: any) => a.name)).toEqual(["Backup"]);

    const activeOnly = await getJson("/accounts?page=1&pageSize=10&disabled=0");
    expect(activeOnly.body.total).toBe(2);
  });

  // A list of names and usernames pasted in whole: one term per line, any of which keeps a row
  it("reads a multi-line search as one term per line", async () => {
    insertAccount("01", { tgName: "\u5411\u9633\u800c\u751f", tgUsername: "sunward7" });
    insertAccount("02", { tgName: "Astra", tgUsername: "iulzee" });
    insertAccount("03", { tgName: "\u5403\u74dc\u7fa4\u4f17", tgUsername: "melon22" });
    insertAccount("04", { tgName: "Nobody", tgUsername: "elsewhere" });

    const list = ["\u5411\u9633\u800c\u751f", "@iulzee", "melon22", ""].join("\n");
    const { body } = await getJson(
      `/accounts?page=1&pageSize=10&search=${encodeURIComponent(list)}`,
    );

    // The @ is dropped, a bare username matches too, and the blank line counts for nothing
    expect(body.items.map((a: any) => a.name)).toEqual(["01", "02", "03"]);
    expect(body.total).toBe(3);
  });

  it("keeps other filters over the whole list of terms", async () => {
    insertAccount("01", { tgUsername: "keeper" });
    insertAccount("02", { tgUsername: "gone", disabled: 1 });

    const { body } = await getJson(
      `/accounts?page=1&pageSize=10&disabled=0&search=${encodeURIComponent("keeper\ngone")}`,
    );

    expect(body.items.map((a: any) => a.name)).toEqual(["01"]);
  });

  it("still escapes LIKE wildcards line by line", async () => {
    insertAccount("01", { notes: "100% real" });
    insertAccount("02", { notes: "anything at all" });

    const { body } = await getJson(
      `/accounts?page=1&pageSize=10&search=${encodeURIComponent("100%\n@")}`,
    );

    expect(body.items.map((a: any) => a.name)).toEqual(["01"]);
  });
});

describe("GET /logs", () => {
  it("keeps the legacy array shape with limit/offset", async () => {
    const job = insertJob("Job A");
    insertLog(job, "success", "ok", "2026-07-01T00:00:00Z");
    insertLog(job, "failed", "boom", "2026-07-02T00:00:00Z");
    const { body } = await getJson("/logs?limit=1&offset=0");
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].message).toBe("boom");
  });

  it("pages with total and filters by status and search", async () => {
    const jobA = insertJob("Alpha Job");
    const jobB = insertJob("Beta Job");
    insertLog(jobA, "success", "all good", "2026-07-01T00:00:00Z");
    insertLog(jobA, "failed", "timeout waiting", "2026-07-02T00:00:00Z");
    insertLog(jobB, "failed", "button not found", "2026-07-03T00:00:00Z");

    const paged = await getJson("/logs?page=1&pageSize=2");
    expect(paged.body.total).toBe(3);
    expect(paged.body.items).toHaveLength(2);
    expect(paged.body.items[0].message).toBe("button not found");

    const failedOnly = await getJson("/logs?page=1&pageSize=10&status=failed");
    expect(failedOnly.body.total).toBe(2);

    const bySearch = await getJson("/logs?page=1&pageSize=10&search=beta");
    expect(bySearch.body.items.map((l: any) => l.message)).toEqual(["button not found"]);

    const byMessage = await getJson("/logs?page=1&pageSize=10&search=timeout");
    expect(byMessage.body.items.map((l: any) => l.message)).toEqual(["timeout waiting"]);
  });
});

describe("POST /templates/:id/duplicate", () => {
  it("copies every configured field onto a new template", async () => {
    const cfg = JSON.stringify({ actions: [{ type: "open_mini_app_url", url: "https://x/app" }] });
    const id = insertTemplate("Daily Draw", {
      jobType: "custom",
      bot: "drawbot",
      config: cfg,
      timezone: "Australia/Sydney",
      runEveryDays: 3,
      runEveryDaysMax: 5,
    });

    const { status, body } = await postJson(`/templates/${id}/duplicate`);
    expect(status).toBe(201);
    expect(body.id).not.toBe(id);
    expect(body.name).toBe("Daily Draw (copy)");
    expect(body.jobType).toBe("custom");
    expect(body.botUsername).toBe("drawbot");
    expect(body.config).toBe(cfg);
    expect(body.timezone).toBe("Australia/Sydney");
    expect(body.runEveryDays).toBe(3);
    expect(body.runEveryDaysMax).toBe(5);

    const all = await getJson("/templates");
    expect(all.body.map((t: any) => t.name)).toEqual(["Daily Draw", "Daily Draw (copy)"]);
  });

  // A copy is a template added today, whatever the source's age: inheriting the source's
  // date would bury every duplicate at the bottom of a newest-first list
  it("dates the copy when it was duplicated, not when the source was added", async () => {
    const id = insertTemplate("Ancient");
    setCreatedAt(id, "2020-03-01 09:00:00");

    const { body } = await postJson(`/templates/${id}/duplicate`);

    expect(body.createdAt).not.toBe("2020-03-01 09:00:00");
    expect(new Date(`${body.createdAt}Z`).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("numbers further copies rather than repeating the name", async () => {
    const id = insertTemplate("Alpha");
    const first = await postJson(`/templates/${id}/duplicate`);
    const second = await postJson(`/templates/${id}/duplicate`);
    const third = await postJson(`/templates/${first.body.id}/duplicate`);
    expect(first.body.name).toBe("Alpha (copy)");
    expect(second.body.name).toBe("Alpha (copy 2)");
    expect(third.body.name).toBe("Alpha (copy) (copy)");
  });

  it("leaves the source's linked jobs with the source", async () => {
    const tpl = insertTemplate("Linked");
    insertJob("Job A", { templateId: tpl });
    const { body } = await postJson(`/templates/${tpl}/duplicate`);

    const paged = await getJson("/templates?page=1&pageSize=10");
    const rows = Object.fromEntries(
      paged.body.items.map((t: any) => [t.id, t.linkedJobCount]),
    );
    expect(rows[tpl]).toBe(1);
    expect(rows[body.id]).toBe(0);
  });

  it("404s for a template that does not exist", async () => {
    const { status } = await postJson("/templates/9999/duplicate");
    expect(status).toBe(404);
  });
});

// `pageSize=0` is the "All" choice in the list views: one page, no ceiling -- including
// past the 200-row cap the numbered page sizes are clamped to.
describe("page size All (pageSize=0)", () => {
  it("returns every template on one page, beyond the usual cap", async () => {
    for (let i = 1; i <= 205; i++) insertTemplate(`Tpl ${String(i).padStart(3, "0")}`);
    const { body } = await getJson("/templates?page=1&pageSize=0");
    expect(body.total).toBe(205);
    expect(body.items).toHaveLength(205);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(0);
  });

  it("returns every job, account, and log on one page", async () => {
    for (let i = 1; i <= 5; i++) insertAccount(`Acct ${i}`);
    const job = insertJob("Job A");
    for (let i = 1; i <= 5; i++) insertJob(`Job ${i}`);
    for (let i = 1; i <= 5; i++)
      insertLog(job, "success", `run ${i}`, `2026-07-0${i}T00:00:00Z`);

    const jobs = await getJson("/jobs?page=1&pageSize=0");
    expect(jobs.body.items).toHaveLength(6);
    const accounts = await getJson("/accounts?page=1&pageSize=0");
    expect(accounts.body.items).toHaveLength(5);
    const logs = await getJson("/logs?page=1&pageSize=0");
    expect(logs.body.items).toHaveLength(5);
  });

  it("ignores the page number, since All is a single page", async () => {
    for (let i = 1; i <= 5; i++) insertTemplate(`Tpl ${i}`);
    const { body } = await getJson("/templates?page=3&pageSize=0");
    expect(body.page).toBe(1);
    expect(body.items).toHaveLength(5);
  });

  it("still keeps the legacy array shape when no paging param is sent", async () => {
    insertTemplate("Alpha");
    const { body } = await getJson("/templates");
    expect(Array.isArray(body)).toBe(true);
  });
});
