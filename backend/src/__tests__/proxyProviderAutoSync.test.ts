// The automatic provider refresh: what arms it, and that two refreshes never overlap --
// each one reads the proxy list and writes it back, so one running inside another would
// lose the other's work.
const store = new Map<string, string>();
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

// Hoisted with the mock factories that use them: what is under test is the timer and the
// queue, not the fetching or the sockets
const { syncProviders, testStoredProxies } = vi.hoisted(() => ({
  syncProviders: vi.fn(),
  testStoredProxies: vi.fn(async () => [{ ok: true }, { ok: false }]),
}));
vi.mock("../tg/proxyProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tg/proxyProviders")>();
  return { ...actual, syncProviders };
});
vi.mock("../tg/proxyHealth", () => ({ testStoredProxies }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_PROVIDER_SYNC_INTERVAL_KEY,
  proxyProviderSyncIntervalMinutes,
  startProxyProviderSync,
  stopProxyProviderSync,
  syncAndTestProviders,
} from "../tg/proxySync";

const FIRST_RUN_MS = 5 * 60 * 1000;

const result = (ids: string[] = ["acme"]) => ({
  providers: ids.map((id) => ({ providerId: id, name: id, ok: true, fetched: 2 })),
  added: 1,
  updated: 0,
  removed: 0,
  total: 2,
  syncedProviderIds: ids,
});

beforeEach(() => {
  store.clear();
  syncProviders.mockReset().mockResolvedValue(result());
  testStoredProxies.mockClear();
  store.set("proxy_providers", JSON.stringify([{ id: "acme", name: "Acme", type: "webshare" }]));
});

afterEach(() => {
  stopProxyProviderSync();
  vi.useRealTimers();
});

describe("proxyProviderSyncIntervalMinutes", () => {
  it("is off by default", () => {
    expect(proxyProviderSyncIntervalMinutes()).toBe(0);
  });

  it("ignores a value that is not a positive number", () => {
    for (const value of ["0", "-4", "abc", ""]) {
      store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, value);
      expect(proxyProviderSyncIntervalMinutes()).toBe(0);
    }
  });

  it("takes a minute as the shortest interval", () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "1");
    expect(proxyProviderSyncIntervalMinutes()).toBe(1);
  });

  it("caps a long interval at a week", () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "99999");
    expect(proxyProviderSyncIntervalMinutes()).toBe(7 * 24 * 60);
  });
});

describe("syncAndTestProviders", () => {
  it("tests what the refresh brought in and counts the ones that answered", async () => {
    const out = await syncAndTestProviders("acme");
    expect(syncProviders).toHaveBeenCalledWith("acme");
    expect(testStoredProxies).toHaveBeenCalledWith({ providerIds: ["acme"] });
    expect(out).toMatchObject({ added: 1, tested: 2, reachable: 1 });
  });

  it("skips the test when no provider was refreshed", async () => {
    syncProviders.mockResolvedValueOnce(result([]));
    const out = await syncAndTestProviders();
    expect(testStoredProxies).not.toHaveBeenCalled();
    expect(out).toMatchObject({ tested: 0, reachable: 0 });
  });

  it("runs one refresh at a time", async () => {
    let running = 0;
    let overlapped = false;
    syncProviders.mockImplementation(async () => {
      overlapped ||= running > 0;
      running++;
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return result();
    });

    await Promise.all([syncAndTestProviders(), syncAndTestProviders(), syncAndTestProviders()]);
    expect(overlapped).toBe(false);
    expect(syncProviders).toHaveBeenCalledTimes(3);
  });

  it("lets the next refresh through after one fails", async () => {
    syncProviders.mockRejectedValueOnce(new Error("Fetch failed"));
    await expect(syncAndTestProviders()).rejects.toThrow("Fetch failed");
    await expect(syncAndTestProviders()).resolves.toMatchObject({ added: 1 });
  });
});

describe("startProxyProviderSync", () => {
  beforeEach(() => vi.useFakeTimers());

  it("arms nothing while the interval is 0", async () => {
    startProxyProviderSync();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS * 10);
    expect(syncProviders).not.toHaveBeenCalled();
  });

  it("refreshes shortly after boot, then on the interval", async () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "360");
    startProxyProviderSync();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS - 1000);
    expect(syncProviders).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(syncProviders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(360 * 60 * 1000);
    expect(syncProviders).toHaveBeenCalledTimes(2);
  });

  // An interval shorter than the boot delay must not wait the whole delay out first
  it("keeps to a short interval from the first tick", async () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "2");
    startProxyProviderSync();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(syncProviders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(syncProviders).toHaveBeenCalledTimes(2);
  });

  it("does not fetch when every provider is disabled", async () => {
    store.set(
      "proxy_providers",
      JSON.stringify([{ id: "acme", name: "Acme", type: "webshare", enabled: false }]),
    );
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "360");
    startProxyProviderSync();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(syncProviders).not.toHaveBeenCalled();
  });

  it("re-arms rather than stacking timers when the interval changes", async () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "360");
    startProxyProviderSync();
    startProxyProviderSync();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(syncProviders).toHaveBeenCalledTimes(1);
  });

  it("stops when turned off", async () => {
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "360");
    startProxyProviderSync();
    store.set(PROXY_PROVIDER_SYNC_INTERVAL_KEY, "0");
    startProxyProviderSync();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS * 10);
    expect(syncProviders).not.toHaveBeenCalled();
  });
});
