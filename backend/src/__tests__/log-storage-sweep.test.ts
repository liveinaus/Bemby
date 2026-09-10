// Retention against the real database and the real files: a purged run must take its
// screenshots with it, a run whose row went with its job must not leave a folder behind,
// and the file has to actually give the space back. Deleting rows alone leaves SQLite the
// same size for ever, which is how the database reached 531MB.

vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn(),
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let dbPath: string;
const originalDbPath = process.env.DB_PATH;
const DAY_MS = 86_400_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-log-sweep-"));
  dbPath = path.join(tmpDir, "bemby.db");
  process.env.DB_PATH = dbPath;
});

afterEach(() => {
  process.env.DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const shotsDir = (logId: number) => path.join(tmpDir, "run-shots", String(logId));

function putShot(logId: number, bytes = 2048) {
  fs.mkdirSync(shotsDir(logId), { recursive: true });
  fs.writeFileSync(path.join(shotsDir(logId), "0.jpg"), Buffer.alloc(bytes, 1));
}

/** The real database and the real scheduler, both pointed at this test's own file. */
async function boot() {
  vi.resetModules();
  const { db } = await import("../db/database");
  const scheduler = await import("../scheduler");
  const jobId = Number(
    db
      .prepare(
        "INSERT INTO jobs (name, job_type, bot_username, account_id) VALUES ('J', 'embywatch', '', NULL)",
      )
      .run().lastInsertRowid,
  );
  const addLog = (daysAgo: number, status = "success") =>
    Number(
      db
        .prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, ?, ?)")
        .run(jobId, new Date(Date.now() - daysAgo * DAY_MS).toISOString(), status, '["shot:0.jpg"]')
        .lastInsertRowid,
    );
  return { db, scheduler, jobId, addLog };
}

describe("purgeOldLogs against real storage", () => {
  it("takes a purged run's screenshots with it and leaves the rest", async () => {
    const { db, scheduler, addLog } = await boot();
    const old = addLog(10);
    const recent = addLog(1);
    putShot(old);
    putShot(recent);
    db.prepare("UPDATE settings SET value = '5' WHERE key = 'log_retention_days'").run();

    scheduler.purgeOldLogs();

    expect(db.prepare("SELECT COUNT(*) n FROM job_logs").get()).toEqual({ n: 1 });
    expect(fs.existsSync(shotsDir(old))).toBe(false);
    expect(fs.existsSync(shotsDir(recent))).toBe(true);
    db.close();
  });

  it("leaves a run still inside the window alone", async () => {
    const { db, scheduler, addLog } = await boot();
    const recent = addLog(1);
    putShot(recent);
    db.prepare("UPDATE settings SET value = '30' WHERE key = 'log_retention_days'").run();

    scheduler.purgeOldLogs();

    expect(db.prepare("SELECT COUNT(*) n FROM job_logs").get()).toEqual({ n: 1 });
    expect(fs.existsSync(shotsDir(recent))).toBe(true);
    db.close();
  });

  it("never touches a run still being written", async () => {
    const { db, scheduler, addLog } = await boot();
    const running = addLog(10, "running");
    putShot(running);
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'log_retention_days'").run();

    scheduler.purgeOldLogs();

    expect(db.prepare("SELECT COUNT(*) n FROM job_logs").get()).toEqual({ n: 1 });
    expect(fs.existsSync(shotsDir(running))).toBe(true);
    db.close();
  });
});

describe("what a run writes to the row", () => {
  it("keeps the pictures beside the database and references in the row", async () => {
    const { db, scheduler, jobId } = await boot();
    const { runJob } = await import("../jobs/runner");
    const page = `data:image/jpeg;base64,${Buffer.from("the page, as a picture").toString("base64")}`;
    // The runner's job is to fill the detail array it is handed, which is what it does here
    vi.mocked(runJob).mockImplementation(async (_job, _account, detailLogs: any) => {
      detailLogs.push({ label: "press Login", screenshot: page });
    });

    await scheduler.executeJob({ id: jobId, name: "J", runEveryDays: 1 } as never, null);

    const row = db
      .prepare("SELECT id, detail FROM job_logs ORDER BY id DESC LIMIT 1")
      .get() as { id: number; detail: string };
    expect(row.detail).toContain("shot:0.jpg");
    expect(row.detail).not.toContain("data:image");
    expect(fs.existsSync(path.join(shotsDir(row.id), "0.jpg"))).toBe(true);

    // And the panel reads it back exactly as the run left it
    const { inlineRunImages } = await import("../jobs/runDetail");
    const asRead = inlineRunImages(row.id, JSON.parse(row.detail)) as any[];
    expect(asRead[0]).toEqual({ label: "press Login", screenshot: page });
    db.close();
  });

  it("writes no row detail for a run that logged nothing", async () => {
    const { db, scheduler, jobId } = await boot();
    const { runJob } = await import("../jobs/runner");
    vi.mocked(runJob).mockImplementation(async () => {});

    await scheduler.executeJob({ id: jobId, name: "J", runEveryDays: 1 } as never, null);

    const row = db.prepare("SELECT id, detail FROM job_logs ORDER BY id DESC LIMIT 1").get() as {
      id: number;
      detail: string | null;
    };
    expect(row.detail).toBeNull();
    expect(fs.existsSync(shotsDir(row.id))).toBe(false);
    db.close();
  });
});

describe("bringing existing history up to date", () => {
  /** A row as an older version wrote it: the images inside the JSON. */
  function inlineRow(db: any, jobId: number, images: number) {
    const detail = Array.from({ length: images }, (_, i) => ({
      label: `step ${i}`,
      screenshot: `data:image/jpeg;base64,${Buffer.from("x".repeat(20_000)).toString("base64")}`,
    }));
    return Number(
      db
        .prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, 'success', ?)")
        .run(jobId, new Date().toISOString(), JSON.stringify(detail)).lastInsertRowid,
    );
  }

  /** Turns until the table is finished, the way the background pass does it. */
  function runToCompletion(scheduler: any, batch = 2): number {
    let turns = 0;
    for (;;) {
      const progress = scheduler.backfillRunLogStorage(batch);
      turns++;
      if (progress.done || turns > 500) return turns;
    }
  }

  it("moves the images of existing history out of the rows", async () => {
    const { db, scheduler, jobId } = await boot();
    const a = inlineRow(db, jobId, 4);
    const b = inlineRow(db, jobId, 3);

    runToCompletion(scheduler);

    for (const id of [a, b]) {
      const row = db.prepare("SELECT detail FROM job_logs WHERE id = ?").get(id) as {
        detail: string;
      };
      expect(row.detail).not.toContain("data:image");
      expect(row.detail).toContain("shot:0.jpg");
      expect(fs.readdirSync(shotsDir(id)).length).toBeGreaterThan(0);
    }
    db.close();
  });

  it("keeps every step in the log it rewrites", async () => {
    const { db, scheduler, jobId } = await boot();
    const id = inlineRow(db, jobId, 5);

    runToCompletion(scheduler);

    const detail = JSON.parse(
      (db.prepare("SELECT detail FROM job_logs WHERE id = ?").get(id) as { detail: string }).detail,
    );
    expect(detail).toHaveLength(5);
    expect(detail.map((d: any) => d.label)).toEqual([
      "step 0",
      "step 1",
      "step 2",
      "step 3",
      "step 4",
    ]);
    db.close();
  });

  it("records a size for every row, images or not", async () => {
    const { db, scheduler, jobId } = await boot();
    inlineRow(db, jobId, 2);
    db.prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, 'success', ?)")
      .run(jobId, new Date().toISOString(), '[{"label":"no pictures here"}]');
    db.prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, 'failed', NULL)")
      .run(jobId, new Date().toISOString());

    runToCompletion(scheduler);

    expect(db.prepare("SELECT COUNT(*) n FROM job_logs WHERE detail_bytes IS NULL").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("works in bounded turns rather than one long one", async () => {
    const { db, scheduler, jobId } = await boot();
    for (let i = 0; i < 7; i++) inlineRow(db, jobId, 1);

    // Two rows a turn: four turns of work, then one that finds the end
    const first = scheduler.backfillRunLogStorage(2);
    expect(first.processed).toBe(2);
    expect(first.done).toBe(false);
    expect(runToCompletion(scheduler, 2)).toBeLessThan(8);
    db.close();
  });

  it("carries on where it stopped rather than starting again", async () => {
    const { db, scheduler, jobId } = await boot();
    const ids = Array.from({ length: 6 }, () => inlineRow(db, jobId, 1));

    scheduler.backfillRunLogStorage(2);
    const doneEarly = ids.filter(
      (id) =>
        (db.prepare("SELECT detail_bytes n FROM job_logs WHERE id = ?").get(id) as { n: number | null })
          .n != null,
    ).length;
    expect(doneEarly).toBe(2);

    // A restart: a fresh module, same database
    const restarted = await import("../scheduler");
    restarted.backfillRunLogStorage(2);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM job_logs WHERE detail_bytes IS NOT NULL").get() as {
        n: number;
      }).n,
    ).toBe(4); // the next two, not the first two again
    db.close();
  });

  it("stops asking once the table is finished", async () => {
    const { db, scheduler, jobId } = await boot();
    inlineRow(db, jobId, 2);

    runToCompletion(scheduler);
    expect(scheduler.runLogBackfillPending()).toBe(false);

    const after = db.prepare("SELECT detail FROM job_logs").all();
    expect(scheduler.backfillRunLogStorage().processed).toBe(0);
    expect(db.prepare("SELECT detail FROM job_logs").all()).toEqual(after);
    db.close();
  });

  it("treats an install that finished the older pass as done", async () => {
    const { db, scheduler, jobId } = await boot();
    inlineRow(db, jobId, 2);
    for (const key of ["migration:job-logs-images-to-files", "migration:job-logs-detail-bytes"])
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(key);

    expect(scheduler.runLogBackfillPending()).toBe(false);
    expect(scheduler.backfillRunLogStorage().processed).toBe(0);
    db.close();
  });

  it("leaves a row it cannot read alone rather than stopping the pass", async () => {
    const { db, scheduler, jobId } = await boot();
    db.prepare("INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, 'failed', ?)")
      .run(jobId, new Date().toISOString(), '{"data:image/jpeg;base64,AAA" not json');
    const good = inlineRow(db, jobId, 1);

    runToCompletion(scheduler);

    // The broken row is untouched, and the pass still reached the one after it
    expect(
      (db.prepare("SELECT detail FROM job_logs WHERE detail LIKE '%not json%'").get() as {
        detail: string;
      }).detail,
    ).toContain("not json");
    expect(
      (db.prepare("SELECT detail FROM job_logs WHERE id = ?").get(good) as { detail: string })
        .detail,
    ).toContain("shot:");
    db.close();
  });

  it("has nothing to do on an install with no history", async () => {
    const { db, scheduler } = await boot();
    expect(scheduler.backfillRunLogStorage().done).toBe(true);
    db.close();
  });
});

describe("sweepLogStorage", () => {
  it("drops the screenshots of a run whose row has gone", async () => {
    const { db, scheduler, jobId, addLog } = await boot();
    const live = addLog(1);
    putShot(live);
    putShot(9999); // a run deleted with its job, so nothing points at this folder

    scheduler.sweepLogStorage();

    expect(fs.existsSync(shotsDir(live))).toBe(true);
    expect(fs.existsSync(shotsDir(9999))).toBe(false);
    expect(jobId).toBeGreaterThan(0);
    db.close();
  });

  it("clears up after a job deleted with its logs", async () => {
    const { db, scheduler, jobId, addLog } = await boot();
    const gone = addLog(1);
    putShot(gone);

    // The foreign key takes the log row, which no delete path can turn into a file sweep
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    expect(db.prepare("SELECT COUNT(*) n FROM job_logs").get()).toEqual({ n: 0 });

    scheduler.sweepLogStorage();
    expect(fs.existsSync(shotsDir(gone))).toBe(false);
    db.close();
  });

  it("gives the space back after a purge, which a delete alone does not", async () => {
    const { db, scheduler, addLog } = await boot();
    // Rows heavy enough that the pages they hold are visible in the file size
    const insert = db.prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES ((SELECT id FROM jobs LIMIT 1), ?, 'success', ?)",
    );
    for (let i = 0; i < 40; i++)
      insert.run(new Date(Date.now() - 10 * DAY_MS).toISOString(), "x".repeat(100_000));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const grown = fs.statSync(dbPath).size;
    expect(grown).toBeGreaterThan(3_000_000);

    db.prepare("UPDATE settings SET value = '5' WHERE key = 'log_retention_days'").run();
    scheduler.purgeOldLogs();
    scheduler.sweepLogStorage();

    expect(fs.statSync(dbPath).size).toBeLessThan(grown / 2);
    expect(addLog).toBeTypeOf("function");
    db.close();
  });

  it("leaves a healthy database alone rather than rewriting it daily", async () => {
    const { db, scheduler, jobId } = await boot();
    // A table with nothing to reclaim: a vacuum here is all cost. On a multi-gigabyte
    // database a daily rewrite blocks everything else for as long as it takes.
    const insert = db.prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, 'success', ?)",
    );
    for (let i = 0; i < 20; i++) insert.run(jobId, new Date().toISOString(), "x".repeat(20_000));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const size = fs.statSync(dbPath).size;
    const free = db.pragma("freelist_count", { simple: true }) as number;
    expect(free * 4096).toBeLessThan(8_388_608);

    scheduler.sweepLogStorage();

    expect(fs.statSync(dbPath).size).toBe(size); // untouched
    db.close();
  });

  it("survives a data directory with nothing stored in it", async () => {
    const { db, scheduler } = await boot();
    expect(() => scheduler.sweepLogStorage()).not.toThrow();
    db.close();
  });
});
