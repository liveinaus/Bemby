// GET /logs query hardening: limit clamped to 200, offset floored at 0,
// jobId validated as a positive integer.
// POST /logs/bulk-retire: ids validated, and the state set rather than toggled per row.

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn().mockReturnValue(false),
  getLiveDetail: vi.fn().mockReturnValue(null),
}));

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import logsRouter from "../routes/logs";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'Job',
    job_type   TEXT NOT NULL DEFAULT 'checkin',
    account_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    detail  TEXT,
    retired INTEGER NOT NULL DEFAULT 0
  );
`;

function routeHandler(method: string, path: string) {
  const layer = (logsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
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

function list(query: Record<string, string>) {
  const res = makeRes();
  routeHandler("get", "/")({ query }, res);
  return res;
}

function bulkRetire(body: unknown) {
  const res = makeRes();
  routeHandler("post", "/bulk-retire")({ body }, res);
  return res;
}

function retiredFlags(ids: number[]): number[] {
  return ids.map(
    (id) =>
      (testDb.prepare("SELECT retired FROM job_logs WHERE id = ?").get(id) as {
        retired: number;
      }).retired,
  );
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  const { lastInsertRowid: jobId } = testDb
    .prepare("INSERT INTO jobs (name) VALUES ('Job A')")
    .run();
  const insert = testDb.prepare(
    "INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')",
  );
  for (let i = 0; i < 250; i++) {
    insert.run(Number(jobId), `2024-06-01T00:${String(i % 60).padStart(2, "0")}:00Z`);
  }
});

describe("POST /logs/bulk-retire", () => {
  let ids: number[];

  beforeEach(() => {
    const insert = testDb.prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, retired) VALUES (1, '2024-07-01T00:00:00Z', 'success', ?)",
    );
    // One already retired, so setting rather than toggling can be told apart
    ids = [0, 0, 1].map((retired) => Number(insert.run(retired).lastInsertRowid));
  });

  it("retires every id in one call, and counts only the rows it changed", () => {
    const res = bulkRetire({ ids });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ changed: 2, retired: true });
    expect(retiredFlags(ids)).toEqual([1, 1, 1]);
  });

  it("brings rows back when retired is false", () => {
    const res = bulkRetire({ ids, retired: false });
    expect(res.body).toEqual({ changed: 1, retired: false });
    expect(retiredFlags(ids)).toEqual([0, 0, 0]);
  });

  it("drops anything that is not a positive integer id", () => {
    const res = bulkRetire({ ids: [ids[0], "abc", 0, -2, null] });
    expect(res.body.changed).toBe(1);
    expect(retiredFlags(ids)).toEqual([1, 0, 1]);
  });

  it("rejects a body with no usable ids", () => {
    expect(bulkRetire({ ids: [] }).statusCode).toBe(400);
    expect(bulkRetire({ ids: ["abc"] }).statusCode).toBe(400);
    expect(bulkRetire({}).statusCode).toBe(400);
  });
});

describe("GET /logs query hardening", () => {
  it("defaults to 50 rows", () => {
    expect(list({}).body).toHaveLength(50);
  });

  it("clamps limit to 200", () => {
    expect(list({ limit: "999999" }).body).toHaveLength(200);
  });

  it("falls back to the default on a non-numeric limit", () => {
    expect(list({ limit: "abc" }).body).toHaveLength(50);
  });

  it("floors a negative offset to 0", () => {
    const res = list({ offset: "-5", limit: "10" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(10);
  });

  it("rejects a non-numeric jobId", () => {
    const res = list({ jobId: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid jobId");
  });

  it("rejects a non-positive jobId", () => {
    expect(list({ jobId: "0" }).statusCode).toBe(400);
    expect(list({ jobId: "-3" }).statusCode).toBe(400);
  });

  it("accepts a valid jobId", () => {
    const res = list({ jobId: "1", limit: "5" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0].jobId).toBe(1);
  });
});
