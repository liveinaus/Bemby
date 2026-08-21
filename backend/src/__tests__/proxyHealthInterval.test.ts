// The automatic proxy test's schedule: what a configured interval means now that it is in
// minutes, and that a short one runs once per period rather than twice on the first tick.
const { store, recordProxyTestResults } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  recordProxyTestResults: vi.fn(() => ({ failed: 0, recovered: 0 })),
}));

vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && store.has(key) ? { value: store.get(key) } : undefined,
      run: (key: string, value?: string) => {
        if (sql.startsWith("DELETE")) store.delete(key);
        else store.set(key, value as string);
      },
      all: () => [],
    }),
  },
}));

vi.mock("../tg/proxyProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tg/proxyProviders")>();
  return { ...actual, recordProxyTestResults };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_TEST_INTERVAL_KEY,
  proxyTestIntervalMinutes,
  startProxyHealthChecks,
  stopProxyHealthChecks,
} from "../tg/proxyHealth";

const FIRST_RUN_MS = 2 * 60 * 1000;

beforeEach(() => {
  store.clear();
  recordProxyTestResults.mockClear();
  // One exit with a URL nothing can dial, so a run records a verdict without a socket
  store.set("proxies", JSON.stringify([{ id: "p1", name: "P1", url: "not-a-url" }]));
});

afterEach(() => {
  stopProxyHealthChecks();
  vi.useRealTimers();
});

describe("proxyTestIntervalMinutes", () => {
  it("is off by default", () => {
    expect(proxyTestIntervalMinutes()).toBe(0);
  });

  it("ignores a value that is not a positive number", () => {
    for (const value of ["0", "-30", "abc", ""]) {
      store.set(PROXY_TEST_INTERVAL_KEY, value);
      expect(proxyTestIntervalMinutes()).toBe(0);
    }
  });

  it("takes a minute as the shortest interval", () => {
    store.set(PROXY_TEST_INTERVAL_KEY, "1");
    expect(proxyTestIntervalMinutes()).toBe(1);
  });

  it("caps a long interval at a week", () => {
    store.set(PROXY_TEST_INTERVAL_KEY, "99999");
    expect(proxyTestIntervalMinutes()).toBe(7 * 24 * 60);
  });
});

describe("startProxyHealthChecks", () => {
  beforeEach(() => vi.useFakeTimers());

  it("arms nothing while the interval is 0", async () => {
    startProxyHealthChecks();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS * 10);
    expect(recordProxyTestResults).not.toHaveBeenCalled();
  });

  it("tests shortly after boot, then on the interval", async () => {
    store.set(PROXY_TEST_INTERVAL_KEY, "360");
    startProxyHealthChecks();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS - 1000);
    expect(recordProxyTestResults).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(recordProxyTestResults).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(360 * 60 * 1000);
    expect(recordProxyTestResults).toHaveBeenCalledTimes(2);
  });

  it("keeps to a short interval from the first tick", async () => {
    store.set(PROXY_TEST_INTERVAL_KEY, "1");
    startProxyHealthChecks();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(recordProxyTestResults).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(recordProxyTestResults).toHaveBeenCalledTimes(2);
  });

  it("stops when turned off", async () => {
    store.set(PROXY_TEST_INTERVAL_KEY, "360");
    startProxyHealthChecks();
    store.set(PROXY_TEST_INTERVAL_KEY, "0");
    startProxyHealthChecks();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS * 10);
    expect(recordProxyTestResults).not.toHaveBeenCalled();
  });
});
