// What a run's log costs, and taking it back. The log list reports a size per run and a
// total for what the filters show; compacting drops the pictures and keeps the steps, which
// is the trade an operator actually wants when history has grown.

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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logsRouter from "../routes/logs";
import { prepareRunDetail } from "../jobs/runDetail";

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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL,
    ran_at       TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    message      TEXT,
    detail       TEXT,
    retired      INTEGER NOT NULL DEFAULT 0,
    detail_bytes INTEGER
  );
`;

let tmpDir: string;
const originalDbPath = process.env.DB_PATH;

function routeHandler(method: string, routePath: string) {
  const layer = (logsRouter as any).stack.find(
    (l: any) => l.route?.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
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

const list = (query: Record<string, string> = {}) => {
  const res = makeRes();
  routeHandler("get", "/")({ query }, res);
  return res.body;
};

const detailOf = (id: number) => {
  const res = makeRes();
  routeHandler("get", "/:id")({ params: { id: String(id) }, query: {} }, res);
  return res;
};

const compact = (id: number, body: unknown = {}) => {
  const res = makeRes();
  routeHandler("post", "/:id/compact")({ params: { id: String(id) }, body }, res);
  return res;
};

const bulkCompact = (body: unknown) => {
  const res = makeRes();
  routeHandler("post", "/bulk-compact")({ body }, res);
  return res;
};

const image = (bytes: number) => `data:image/jpeg;base64,${"a".repeat(bytes)}`;
const shotsDir = (logId: number) => path.join(tmpDir, "run-shots", String(logId));
const shotCount = (logId: number) => {
  try {
    return fs.readdirSync(shotsDir(logId)).length;
  } catch {
    return 0;
  }
};

/** A run written up the way the scheduler writes one, images and all. */
function addRun(images: number, status = "success"): number {
  const id = Number(
    testDb
      .prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (1, ?, ?)")
      .run(new Date().toISOString(), status).lastInsertRowid,
  );
  const detail = Array.from({ length: images }, (_, i) => ({
    label: `step ${i}`,
    screenshot: image(4000),
  }));
  const stored = prepareRunDetail(id, detail);
  testDb
    .prepare("UPDATE job_logs SET detail = ?, detail_bytes = ? WHERE id = ?")
    .run(stored.detail, stored.bytes, id);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-logs-size-"));
  process.env.DB_PATH = path.join(tmpDir, "bemby.db");
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  testDb.prepare("INSERT INTO jobs (name) VALUES ('Job A')").run();
});

afterEach(() => {
  process.env.DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("the size the log list reports", () => {
  it("gives each run its own size, files included", () => {
    const small = addRun(1);
    const big = addRun(6);

    const items = list({ page: "1", pageSize: "10" }).items;
    const sizes = new Map(items.map((i: any) => [i.id, i.sizeBytes]));

    expect(sizes.get(small)).toBeGreaterThan(0);
    expect(sizes.get(big)).toBeGreaterThan(sizes.get(small) as number);
    // The files are most of it, so the size has to be more than the row's own text
    const rowLength = (
      testDb.prepare("SELECT LENGTH(detail) n FROM job_logs WHERE id = ?").get(big) as {
        n: number;
      }
    ).n;
    expect(sizes.get(big)).toBeGreaterThan(rowLength);
  });

  it("totals what the filters show, not the whole table", () => {
    addRun(2, "success");
    addRun(4, "failed");

    const all = list({ page: "1", pageSize: "10" });
    const failedOnly = list({ page: "1", pageSize: "10", status: "failed" });

    expect(all.totalSizeBytes).toBeGreaterThan(0);
    expect(failedOnly.totalSizeBytes).toBeGreaterThan(0);
    expect(failedOnly.totalSizeBytes).toBeLessThan(all.totalSizeBytes);
  });

  it("reports nothing rather than a wrong number for history never measured", () => {
    testDb
      .prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (1, ?, 'success', '[]')")
      .run(new Date().toISOString());

    const items = list({ page: "1", pageSize: "10" }).items;
    expect(items[0].sizeBytes).toBeNull();
    expect(list({ page: "1", pageSize: "10" }).totalSizeBytes).toBe(0);
  });
});

describe("compacting one run", () => {
  it("drops the pictures, keeps the steps, and reports what it freed", () => {
    const id = addRun(5);
    const before = (
      testDb.prepare("SELECT detail_bytes n FROM job_logs WHERE id = ?").get(id) as { n: number }
    ).n;

    const res = compact(id);

    expect(res.body.dropped).toBe(5);
    expect(res.body.freedBytes).toBeGreaterThan(0);
    expect(res.body.sizeBytes).toBeLessThan(before);
    expect(shotCount(id)).toBe(0);

    const steps = detailOf(id).body.detail;
    expect(steps).toHaveLength(5);
    expect(steps.every((s: any) => !s.screenshot)).toBe(true);
    expect(steps.map((s: any) => s.label)).toContain("step 4");
  });

  it("keeps the last few when asked for a count", () => {
    const id = addRun(5);

    const res = compact(id, { keep: 2 });

    expect(res.body.dropped).toBe(3);
    expect(shotCount(id)).toBe(2);
    const kept = detailOf(id).body.detail.filter((s: any) => s.screenshot);
    expect(kept.map((s: any) => s.label)).toEqual(["step 3", "step 4"]);
  });

  it("records the new size so the list agrees with what happened", () => {
    const id = addRun(4);
    compact(id);

    const items = list({ page: "1", pageSize: "10" }).items;
    expect(items[0].sizeBytes).toBe(
      (testDb.prepare("SELECT detail_bytes n FROM job_logs WHERE id = ?").get(id) as { n: number })
        .n,
    );
  });

  it("is a no-op on a run with no pictures left", () => {
    const id = addRun(2);
    compact(id);
    const res = compact(id);

    expect(res.body.dropped).toBe(0);
    expect(res.body.freedBytes).toBe(0);
  });

  it("says so when the run is not there", () => {
    expect(compact(9999).statusCode).toBe(404);
  });

  it("treats a nonsense keep as none, and refuses to be talked into a huge one", () => {
    const a = addRun(3);
    expect(compact(a, { keep: "lots" }).body.dropped).toBe(3);
    const b = addRun(3);
    expect(compact(b, { keep: -5 }).body.dropped).toBe(3);
    const c = addRun(3);
    expect(compact(c, { keep: 10_000 }).body.dropped).toBe(0); // clamped, so nothing to drop
  });
});

describe("compacting many runs", () => {
  it("does the ones it is given and leaves the rest", () => {
    const a = addRun(3);
    const b = addRun(3);
    const untouched = addRun(3);

    const res = bulkCompact({ ids: [a, b] });

    expect(res.body.changed).toBe(2);
    expect(res.body.dropped).toBe(6);
    expect(res.body.freedBytes).toBeGreaterThan(0);
    expect(shotCount(a)).toBe(0);
    expect(shotCount(b)).toBe(0);
    expect(shotCount(untouched)).toBe(3);
  });

  it("takes the lot when asked, which is the point of the button", () => {
    const ids = [addRun(2), addRun(3), addRun(4)];

    const res = bulkCompact({ all: true });

    expect(res.body.changed).toBe(3);
    expect(res.body.dropped).toBe(9);
    for (const id of ids) expect(shotCount(id)).toBe(0);
    expect(list({ page: "1", pageSize: "10" }).items.every((i: any) => i.sizeBytes < 2000)).toBe(
      true,
    );
  });

  it("honours a keep count across the batch", () => {
    const a = addRun(4);
    const b = addRun(4);

    bulkCompact({ ids: [a, b], keep: 1 });

    expect(shotCount(a)).toBe(1);
    expect(shotCount(b)).toBe(1);
  });

  it("needs to be told what to work on", () => {
    expect(bulkCompact({}).statusCode).toBe(400);
    expect(bulkCompact({ ids: "all of them" }).statusCode).toBe(400);
  });

  it("skips a row that has gone rather than failing the batch", () => {
    const live = addRun(2);
    const res = bulkCompact({ ids: [live, 9999] });

    expect(res.body.changed).toBe(1);
    expect(shotCount(live)).toBe(0);
  });
});
