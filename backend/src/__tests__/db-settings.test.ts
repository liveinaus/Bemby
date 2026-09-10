// The pragmas the database is opened with. They are one-liners with no visible behaviour,
// which is exactly why nothing would notice them going missing: the cost of losing them is
// a slower install, not a broken one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
const originalDbPath = process.env.DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-db-settings-"));
  process.env.DB_PATH = path.join(tmpDir, "bemby.db");
});

afterEach(() => {
  process.env.DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function open() {
  vi.resetModules();
  return (await import("../db/database")).db;
}

describe("how the database is opened", () => {
  it("writes ahead rather than journalling, with foreign keys enforced", async () => {
    const db = await open();
    try {
      expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not wait for the disk on every commit", async () => {
    const db = await open();
    try {
      // 1 is NORMAL: the write-ahead log already covers the process dying, which is the
      // failure a job run actually meets
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps a cache worth having for a database holding run history", async () => {
    const db = await open();
    try {
      // Negative is KiB rather than pages, so this is 64MB and not 64k pages
      expect(db.pragma("cache_size", { simple: true })).toBe(-65536);
    } finally {
      db.close();
    }
  });

  it("still opens where memory mapping is unavailable", async () => {
    const db = await open();
    try {
      // Not asserted as enabled: it is an optimisation, and some file systems refuse it
      expect(Number(db.pragma("mmap_size", { simple: true }))).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });
});
