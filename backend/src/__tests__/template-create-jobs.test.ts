// Creating jobs from a template, against the real route. A template that only needs one run
// (a signup) should be able to arrive switched off, so nothing starts running on the schedule
// the moment the jobs exist.

import Database from "better-sqlite3";
import http from "http";
import express from "express";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone_number TEXT NOT NULL DEFAULT '',
    auth_status  TEXT NOT NULL DEFAULT 'authenticated',
    disabled     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    job_type         TEXT NOT NULL DEFAULT 'custom',
    bot_username     TEXT NOT NULL DEFAULT '',
    timezone         TEXT NOT NULL DEFAULT '',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 1,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT NOT NULL DEFAULT '/start',
    checkin_button   TEXT NOT NULL DEFAULT '签到',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    run_every_days   INTEGER NOT NULL DEFAULT 7,
    run_every_days_max INTEGER
  );
  CREATE TABLE jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT NOT NULL,
    account_id            INTEGER,
    job_type              TEXT NOT NULL DEFAULT 'custom',
    bot_username          TEXT NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT NOT NULL DEFAULT '',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 1,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT NOT NULL DEFAULT '/start',
    checkin_button        TEXT NOT NULL DEFAULT '签到',
    template_id           INTEGER,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    retired               TEXT,
    run_every_days_max    INTEGER,
    last_success_at       TEXT
  );
`;

let server: http.Server;
let baseUrl: string;
let templateId = 0;
let accountId = 0;

const createJobs = (body: unknown) =>
  fetch(`${baseUrl}/templates/${templateId}/create-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const createdJobs = () =>
  testDb.prepare("SELECT name, enabled FROM jobs ORDER BY id").all() as Array<{
    name: string;
    enabled: number;
  }>;

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);

  const { default: templatesRouter } = await import("../routes/templates");
  const app = express();
  app.use(express.json());
  app.use("/templates", templatesRouter);
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
  testDb.exec("DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;");
  templateId = Number(
    testDb.prepare("INSERT INTO job_templates (name) VALUES ('Signup')").run()
      .lastInsertRowid,
  );
  accountId = Number(
    testDb.prepare("INSERT INTO tg_accounts (name) VALUES ('001')").run().lastInsertRowid,
  );
});

describe("create jobs from a template", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    jobs: [{ accountId, name: "Signup - 001" }],
    scheduleWindowStart: 1400,
    scheduleWindowEnd: 1600,
    ...extra,
  });

  it("creates them running when nothing says otherwise", async () => {
    const res = await createJobs(body());
    expect(res.status).toBe(201);
    expect(createdJobs()).toEqual([{ name: "Signup - 001", enabled: 1 }]);
  });

  it("creates them switched off when asked", async () => {
    const res = await createJobs(body({ enabled: false }));
    expect(res.status).toBe(201);
    expect(createdJobs()).toEqual([{ name: "Signup - 001", enabled: 0 }]);
  });

  it("treats anything but false as running, so a stray value cannot silently stop a job", async () => {
    await createJobs(body({ enabled: true }));
    await createJobs(body({ enabled: undefined }));
    expect(createdJobs().map((j) => j.enabled)).toEqual([1, 1]);
  });
});
