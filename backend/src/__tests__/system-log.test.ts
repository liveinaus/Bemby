// The system log buffer: what console prints is what the panel reads back, filtered by
// level and search, polled with a cursor, and capped so a long run cannot grow the heap.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

type ConsoleLogModule = typeof import("../system/consoleLog");

let mod!: ConsoleLogModule;

beforeAll(async () => {
  // Capacity is read once at load, so it has to be set before the import
  process.env.SYSTEM_LOG_LINES = "100";
  mod = await import("../system/consoleLog");
});

beforeEach(() => {
  mod.clearSystemLog();
});

describe("system log capture", () => {
  it("records each console level with its own severity", () => {
    console.log("plain line");
    console.warn("[proxy] dial failed");
    console.error("boom");

    const { entries } = mod.readSystemLog();
    expect(entries.map((e) => e.level)).toEqual(["log", "warn", "error"]);
    expect(entries[1].scope).toBe("proxy");
    expect(entries[0].scope).toBeNull();
    expect(entries[2].text).toBe("boom");
  });

  it("formats arguments the way console does", () => {
    console.log("run %s of %d", "a", 2, { ok: true });
    expect(mod.readSystemLog().entries[0].text).toBe("run a of 2 { ok: true }");
  });

  it("filters to the asked-for severity and above", () => {
    console.log("quiet");
    console.warn("noisy");
    console.error("fatal");

    expect(mod.readSystemLog({ level: "warn" }).entries.map((e) => e.text)).toEqual([
      "noisy",
      "fatal",
    ]);
    expect(mod.readSystemLog({ level: "error" }).entries.map((e) => e.text)).toEqual([
      "fatal",
    ]);
  });

  it("searches case-insensitively", () => {
    console.log("[webview] claim arrived");
    console.log("scheduler armed");
    expect(mod.readSystemLog({ search: "CLAIM" }).entries).toHaveLength(1);
  });

  it("returns only what printed after the cursor", () => {
    console.log("first");
    const first = mod.readSystemLog();
    expect(first.entries).toHaveLength(1);

    expect(mod.readSystemLog({ since: first.nextSeq }).entries).toEqual([]);
    console.log("second");
    const next = mod.readSystemLog({ since: first.nextSeq });
    expect(next.entries.map((e) => e.text)).toEqual(["second"]);
    expect(next.nextSeq).toBeGreaterThan(first.nextSeq);
  });

  it("keeps the newest lines once the buffer is full, and says how many were lost", () => {
    for (let i = 0; i < 130; i++) console.log(`line ${i}`);
    const page = mod.readSystemLog();
    expect(page.buffered).toBe(100);
    expect(page.capacity).toBe(100);
    expect(page.dropped).toBeGreaterThanOrEqual(30);
    expect(page.entries[0].text).toBe("line 30");
    expect(page.entries.at(-1)!.text).toBe("line 129");
  });

  it("limits to the recent end rather than the stale one", () => {
    for (let i = 0; i < 10; i++) console.log(`line ${i}`);
    const page = mod.readSystemLog({ limit: 3 });
    expect(page.entries.map((e) => e.text)).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("clears on request", () => {
    console.log("before");
    expect(mod.clearSystemLog()).toBe(1);
    expect(mod.readSystemLog().entries).toEqual([]);
  });
});
