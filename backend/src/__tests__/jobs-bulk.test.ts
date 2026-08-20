// Bulk job routes. A panel selection runs to a couple of hundred jobs, and a request each
// meant the scheduler was rebuilt once per job as well -- so what matters here is that one
// request covers the whole selection and refreshes the scheduler exactly once.

import Database from "better-sqlite3";
import http from "http";
import express from "express";

let testDb!: InstanceType<typeof Database>;
const refreshScheduler = vi.fn();

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({ refreshScheduler }));
vi.mock("../jobs/manualRun", () => ({ startManualJobRun: vi.fn() }));
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    proxy_id TEXT,
    disabled INTEGER NOT NULL DEFAULT 0
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
    template_id           INTEGER,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    run_every_days_max    INTEGER,
    retired               TEXT,
    last_success_at       TEXT,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

let server: http.Server;
let baseUrl: string;

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const putJson = (path: string, body?: unknown) => send("PUT", path, body);
const postJson = (path: string, body?: unknown) => send("POST", path, body);

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  const { default: jobsRouter } = await import("../routes/jobs");
  const app = express();
  app.use(express.json());
  app.use("/jobs", jobsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM jobs");
});

/** Inserts `count` jobs and hands back their ids, the way a panel selection arrives. */
function seedJobs(count: number, opts: { enabled?: number; retired?: string | null } = {}) {
  const insert = testDb.prepare(
    "INSERT INTO jobs (name, enabled, retired) VALUES (?, ?, ?)",
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++)
    ids.push(
      Number(insert.run(`job ${i}`, opts.enabled ?? 1, opts.retired ?? null).lastInsertRowid),
    );
  return ids;
}

const jobById = (id: number) =>
  testDb.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;

describe("PUT /jobs/bulk", () => {
  it("disables a large selection in one request and one scheduler refresh", async () => {
    const ids = seedJobs(250);
    const res = await putJson("/jobs/bulk", { ids, enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 250 });
    expect(
      testDb.prepare("SELECT COUNT(*) c FROM jobs WHERE enabled = 0").get() as any,
    ).toEqual({ c: 250 });
    // The whole point: not once per job
    expect(refreshScheduler).toHaveBeenCalledTimes(1);
  });

  it("enables jobs again", async () => {
    const ids = seedJobs(3, { enabled: 0 });
    const res = await putJson("/jobs/bulk", { ids, enabled: true });

    expect(res.body).toEqual({ updated: 3 });
    for (const id of ids) expect(jobById(id).enabled).toBe(1);
  });

  it("sets both ends of the schedule window", async () => {
    const ids = seedJobs(2);
    const res = await putJson("/jobs/bulk", {
      ids,
      scheduleWindowStart: 800,
      scheduleWindowEnd: 900,
    });

    expect(res.body).toEqual({ updated: 2 });
    for (const id of ids) {
      expect(jobById(id).schedule_window_start).toBe(800);
      expect(jobById(id).schedule_window_end).toBe(900);
    }
  });

  it("leaves a retired job alone, so a stale selection cannot bring one back", async () => {
    const [live] = seedJobs(1);
    const [gone] = seedJobs(1, { retired: "2026-01-01 00:00:00" });
    const res = await putJson("/jobs/bulk", { ids: [live, gone], enabled: false });

    expect(res.body).toEqual({ updated: 1 });
    expect(jobById(gone).enabled).toBe(1);
  });

  it("touches nothing when the body names no field to change", async () => {
    const ids = seedJobs(2);
    const res = await putJson("/jobs/bulk", { ids });

    expect(res.status).toBe(400);
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("refuses a window that is not a number", async () => {
    const ids = seedJobs(1);
    const res = await putJson("/jobs/bulk", { ids, scheduleWindowStart: "morning" });

    expect(res.status).toBe(400);
    expect(jobById(ids[0]).schedule_window_start).toBe(1400);
  });

  it("refuses a missing or empty id list", async () => {
    expect((await putJson("/jobs/bulk", { enabled: true })).status).toBe(400);
    expect((await putJson("/jobs/bulk", { ids: [], enabled: true })).status).toBe(400);
    expect((await putJson("/jobs/bulk", { ids: ["x"], enabled: true })).status).toBe(400);
  });

  it("is not read as an id by the per-job route", async () => {
    // Registered ahead of "/:id"; were it not, this would 404 as a job named "bulk"
    const res = await putJson("/jobs/bulk", { ids: seedJobs(1), enabled: false });
    expect(res.status).toBe(200);
  });
});

describe("POST /jobs/bulk-retire", () => {
  it("retires a whole selection in one request", async () => {
    const ids = seedJobs(120);
    const res = await postJson("/jobs/bulk-retire", { ids });

    expect(res.body).toEqual({ retired: 120 });
    expect(
      testDb.prepare("SELECT COUNT(*) c FROM jobs WHERE retired IS NULL").get() as any,
    ).toEqual({ c: 0 });
    expect(refreshScheduler).toHaveBeenCalledTimes(1);
  });

  it("does not re-stamp a job that is already retired", async () => {
    const [gone] = seedJobs(1, { retired: "2026-01-01 00:00:00" });
    const res = await postJson("/jobs/bulk-retire", { ids: [gone] });

    expect(res.body).toEqual({ retired: 0 });
    expect(jobById(gone).retired).toBe("2026-01-01 00:00:00");
  });

  it("refuses an empty id list", async () => {
    expect((await postJson("/jobs/bulk-retire", { ids: [] })).status).toBe(400);
  });
});
