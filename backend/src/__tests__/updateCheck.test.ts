// Knowing whether a newer build is out. The comparison is the part worth pinning down: the
// three tag shapes the publish workflow produces sort differently, and a stable install must
// never be told a beta or a dev tag is newer than it.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  buildInfo,
  channelOf,
  compareVersions,
  isNewer,
  parseVersion,
  resetBuildInfo,
} from "../system/version";
import {
  resetUpdateCache,
  updateCheckEnabled,
  updateStatus,
  UPDATE_CHECK_KEY,
} from "../system/updateCheck";

const ENV_KEYS = ["BEMBY_VERSION", "BEMBY_CHANNEL"] as const;
const saved: Record<string, string | undefined> = {};

function stamp(version?: string, channel?: string): void {
  if (version === undefined) delete process.env.BEMBY_VERSION;
  else process.env.BEMBY_VERSION = version;
  if (channel === undefined) delete process.env.BEMBY_CHANNEL;
  else process.env.BEMBY_CHANNEL = channel;
  resetBuildInfo();
}

function setCheck(on: boolean): void {
  testDb
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(UPDATE_CHECK_KEY, on ? "true" : "false");
}

/** Answers the two GitHub endpoints the check uses, and records what was asked for. */
function githubReturning(body: unknown, ok = true) {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    calls.push(String(url));
    return {
      ok,
      status: ok ? 200 : 403,
      json: async () => body,
    } as any;
  });
  return { calls, spy };
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

beforeEach(() => {
  testDb.exec("DELETE FROM settings");
  resetUpdateCache();
  stamp(undefined, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  resetBuildInfo();
});

describe("channelOf", () => {
  it("reads the line a tag belongs to the way the publish workflow decides it", () => {
    expect(channelOf("v1.2.3")).toBe("latest");
    expect(channelOf("1.2.3")).toBe("latest");
    expect(channelOf("v1.2.3-beta.1")).toBe("beta");
    expect(channelOf("dev-v1.2.3-4")).toBe("dev");
  });
});

describe("parseVersion", () => {
  it("strips the dev- and v prefixes and splits off the prerelease", () => {
    expect(parseVersion("v1.2.3")).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion("v1.2.3-beta.1")).toEqual({ core: [1, 2, 3], pre: ["beta", "1"] });
    expect(parseVersion("dev-v0.9.29-4")).toEqual({ core: [0, 9, 29], pre: ["4"] });
  });

  it("refuses what is not a version", () => {
    expect(parseVersion("main")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by the numeric core first", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("puts a prerelease below the release of the same core", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBe(1);
  });

  it("compares numeric prerelease identifiers as numbers, so beta.10 follows beta.9", () => {
    expect(compareVersions("1.2.3-beta.9", "1.2.3-beta.10")).toBe(-1);
    expect(compareVersions("dev-v0.9.29-2", "dev-v0.9.29-10")).toBe(-1);
  });

  it("treats a shorter prerelease as the older one", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3-beta.1.1")).toBe(-1);
  });

  it("says nothing rather than guessing when a tag will not parse", () => {
    expect(compareVersions("1.2.3", "main")).toBe(0);
    expect(isNewer("1.2.3", "not-a-version")).toBe(false);
  });
});

describe("buildInfo", () => {
  it("takes the stamp when there is one, and the declared channel over the inferred one", () => {
    stamp("0.9.29-beta.1", "beta");
    expect(buildInfo()).toEqual({ version: "0.9.29-beta.1", channel: "beta", stamped: true });
  });

  it("infers the channel from the version when none is declared", () => {
    stamp("dev-v0.9.29-1");
    expect(buildInfo()).toMatchObject({ channel: "dev", stamped: true });
  });

  it("falls back to package.json and reports itself unstamped", () => {
    stamp(undefined, undefined);
    const info = buildInfo();
    expect(info.stamped).toBe(false);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("updateCheckEnabled", () => {
  it("is on unless it was explicitly turned off", () => {
    expect(updateCheckEnabled()).toBe(true);
    setCheck(false);
    expect(updateCheckEnabled()).toBe(false);
    setCheck(true);
    expect(updateCheckEnabled()).toBe(true);
  });
});

describe("updateStatus", () => {
  it("stays quiet, and reaches for nothing, when the check is off", async () => {
    stamp("1.0.0", "latest");
    setCheck(false);
    const { spy } = githubReturning({});
    const status = await updateStatus();
    expect(status).toMatchObject({ reason: "disabled", updateAvailable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays quiet on an unpublished build rather than comparing a source tree", async () => {
    stamp(undefined, undefined);
    const { spy } = githubReturning({});
    expect(await updateStatus()).toMatchObject({ reason: "unstamped" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the stable line off the release, which is what the workflow builds on", async () => {
    stamp("1.0.0", "latest");
    const { calls } = githubReturning({ tag_name: "v1.1.0" });
    const status = await updateStatus();
    expect(calls[0]).toContain("/releases/latest");
    expect(status).toMatchObject({ latest: "v1.1.0", updateAvailable: true });
  });

  it("reads beta and dev off the tag list, since those have no release", async () => {
    stamp("0.9.29-beta.1", "beta");
    const tags = githubReturning([
      { name: "v0.9.30" },
      { name: "v0.9.29-beta.2" },
      { name: "dev-v0.9.31-1" },
      { name: "v0.9.29-beta.10" },
    ]);
    const beta = await updateStatus();
    expect(tags.calls[0]).toContain("/tags");
    // Newest beta by version, not by list order, and neither the stable nor the dev tag
    expect(beta).toMatchObject({ latest: "v0.9.29-beta.10", updateAvailable: true });

    vi.restoreAllMocks();
    resetUpdateCache();
    stamp("dev-v0.9.31-1", "dev");
    githubReturning([
      { name: "v0.9.30" },
      { name: "dev-v0.9.31-1" },
      { name: "v0.9.29-beta.10" },
    ]);
    // The newest dev tag is the one already running, so there is nothing to report
    expect(await updateStatus()).toMatchObject({
      latest: "dev-v0.9.31-1",
      updateAvailable: false,
    });
  });

  it("never reports a newer line as an update to a stable install", async () => {
    stamp("1.0.0", "latest");
    githubReturning({ tag_name: "v1.0.0" });
    expect(await updateStatus()).toMatchObject({ updateAvailable: false });
  });

  it("answers from the cache until forced, so GitHub is not asked per page load", async () => {
    stamp("1.0.0", "latest");
    const { spy } = githubReturning({ tag_name: "v1.1.0" });
    await updateStatus();
    await updateStatus();
    expect(spy).toHaveBeenCalledTimes(1);
    await updateStatus(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reports a failed look instead of throwing, and does not cache it", async () => {
    stamp("1.0.0", "latest");
    const { spy } = githubReturning({}, false);
    const status = await updateStatus();
    expect(status).toMatchObject({ reason: "error", updateAvailable: false });
    expect(status.error).toMatch(/rate-limiting/);
    await updateStatus();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
