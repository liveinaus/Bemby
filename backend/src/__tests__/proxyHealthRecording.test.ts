// What a test leaves behind. Every run covers the disabled exits too, which is the only way
// one ever comes back, and a sync tests just the list it rewrote.
const store = new Map<string, string>();
const { mockCreateConnection } = vi.hoisted(() => ({ mockCreateConnection: vi.fn() }));

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
vi.mock("socks", () => ({ SocksClient: { createConnection: mockCreateConnection } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testStoredProxies } from "../tg/proxyHealth";
import type { BembyProxy } from "../tg/proxyProviders";

const socket = { destroy: vi.fn() };
const proxies = (): BembyProxy[] => JSON.parse(store.get("proxies") ?? "[]");
const setProxies = (list: BembyProxy[]) => store.set("proxies", JSON.stringify(list));

/** Fails the exits whose URL holds one of these hosts, and answers for the rest. */
function failFor(...hosts: string[]) {
  mockCreateConnection.mockImplementation(async (opts: any) => {
    if (hosts.includes(opts.proxy.host)) throw new Error("Connection timed out");
    return { socket };
  });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  failFor();
});

describe("testStoredProxies", () => {
  it("disables the exits that failed and marks the ones that answered", async () => {
    setProxies([
      { id: "a", name: "A", url: "socks5://10.0.0.1:1080" },
      { id: "b", name: "B", url: "socks5://10.0.0.2:1080" },
    ]);
    failFor("10.0.0.2");

    const results = await testStoredProxies();

    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(proxies().map((p) => p.status)).toEqual(["ok", "failed"]);
    expect(proxies()[1].testError).toBe("Connection timed out");
    expect(proxies()[1].testedAt).toBeTypeOf("number");
  });

  it("tests a disabled exit as well, and puts it back when it answers", async () => {
    setProxies([
      { id: "a", name: "A", url: "socks5://10.0.0.1:1080", status: "failed", testError: "old" },
    ]);

    await testStoredProxies();

    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    expect(proxies()[0]).toMatchObject({ status: "ok" });
    expect(proxies()[0].testError).toBeUndefined();
  });

  it("records every check it ran, so the UI can say which one failed", async () => {
    setProxies([{ id: "a", name: "A", url: "socks5://10.0.0.1:1080" }]);
    const [result] = await testStoredProxies();
    expect(result.checks?.map((c) => c.name)).toEqual(["reach"]);
  });

  it("skips an exit turned off by hand: a pass could not put it back anyway", async () => {
    setProxies([
      { id: "a", name: "A", url: "socks5://10.0.0.1:1080", disabled: true },
      { id: "b", name: "B", url: "socks5://10.0.0.2:1080" },
    ]);

    const results = await testStoredProxies();

    expect(results.map((r) => r.id)).toEqual(["b"]);
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    expect(proxies()[0]).toEqual({
      id: "a",
      name: "A",
      url: "socks5://10.0.0.1:1080",
      disabled: true,
    });
  });

  it("keeps a filtered run to that provider's imports, leaving the rest untouched", async () => {
    setProxies([
      { id: "manual", name: "Manual", url: "socks5://10.0.0.1:1080" },
      { id: "pp:acme:1", name: "Acme", url: "socks5://10.0.0.2:1080" },
      { id: "pp:other:1", name: "Other", url: "socks5://10.0.0.3:1080" },
    ]);

    const results = await testStoredProxies({ providerIds: ["acme"] });

    expect(results.map((r) => r.id)).toEqual(["pp:acme:1"]);
    expect(proxies().map((p) => p.status)).toEqual([undefined, "ok", undefined]);
  });
});
