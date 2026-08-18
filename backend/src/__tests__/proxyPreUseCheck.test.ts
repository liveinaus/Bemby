// The check a run makes for itself. A draw works down the pool and takes the first exit that
// answers; a single exit that refuses fails the run rather than letting it out direct.
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
import { checkedProxyUrl, ProxyUnavailableError } from "../tg/proxyHealth";
import type { BembyProxy } from "../tg/proxyProviders";

const socket = { destroy: vi.fn() };
const proxies = (): BembyProxy[] => JSON.parse(store.get("proxies") ?? "[]");
const setProxies = (list: BembyProxy[]) => store.set("proxies", JSON.stringify(list));

const POOL: BembyProxy[] = [
  { id: "p1", name: "One", url: "socks5://10.0.0.1:1080" },
  { id: "p2", name: "Two", url: "socks5://10.0.0.2:1080" },
  { id: "p3", name: "Three", url: "socks5://10.0.0.3:1080" },
];

/** Refuses the exits whose host is listed, and answers for the rest. */
function refuse(...hosts: string[]) {
  mockCreateConnection.mockImplementation(async (opts: any) => {
    if (hosts.includes(opts.proxy.host)) throw new Error("Connection timed out");
    return { socket };
  });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  refuse();
  setProxies(POOL);
  store.set("proxy_check_before_use", "true");
});

describe("with the option off", () => {
  it("hands back the exit without testing anything", async () => {
    store.set("proxy_check_before_use", "false");
    refuse("10.0.0.1");
    await expect(checkedProxyUrl({ proxyId: "p1" })).resolves.toBe(POOL[0].url);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });
});

describe("a pinned exit", () => {
  it("is used once it answers", async () => {
    await expect(checkedProxyUrl({ proxyId: "p2" })).resolves.toBe(POOL[1].url);
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
  });

  it("fails the run when it refuses, rather than falling back to no proxy", async () => {
    refuse("10.0.0.2");
    await expect(checkedProxyUrl({ proxyId: "p2" })).rejects.toBeInstanceOf(
      ProxyUnavailableError,
    );
  });

  it("is disabled by that refusal, so later draws skip it", async () => {
    refuse("10.0.0.2");
    await checkedProxyUrl({ proxyId: "p2" }).catch(() => {});
    expect(proxies()[1]).toMatchObject({ status: "failed" });
  });

  it("fails the run when it is no longer configured at all", async () => {
    await expect(checkedProxyUrl({ proxyId: "gone" })).rejects.toThrow(/no longer configured/);
  });
});

describe("a draw", () => {
  it("moves on to another exit when the one drawn refuses", async () => {
    // The draw order is random, so the working exit may be reached first or last; what
    // matters is that a refusal is not the end of it
    refuse("10.0.0.1", "10.0.0.2");
    const url = await checkedProxyUrl({ proxyId: "random", pool: ["p1", "p2", "p3"] });
    expect(url).toBe(POOL[2].url);
  });

  it("disables the ones it reached that refused, and marks the one it settled on", async () => {
    refuse("10.0.0.1", "10.0.0.2");
    await checkedProxyUrl({ proxyId: "random", pool: ["p1", "p2", "p3"] });

    const byId = Object.fromEntries(proxies().map((p) => [p.id, p.status]));
    expect(byId.p3).toBe("ok");
    // The draw stops at the first exit that answers, so the others carry a verdict only if
    // they were reached first; what must never happen is a refusal recorded as working
    expect([byId.p1, byId.p2].every((s) => s === undefined || s === "failed")).toBe(true);
  });

  it("fails the run when nothing in the pool answers", async () => {
    refuse("10.0.0.1", "10.0.0.2", "10.0.0.3");
    await expect(
      checkedProxyUrl({ proxyId: "random", pool: ["p1", "p2", "p3"] }),
    ).rejects.toThrow(/none answered/);
  });

  it("fails the run when the pool has one exit left and it refuses", async () => {
    refuse("10.0.0.1");
    await expect(checkedProxyUrl({ proxyId: "random", pool: ["p1"] })).rejects.toThrow(
      /refused the connection/,
    );
  });

  it("fails the run when every exit in the pool is already out of service", async () => {
    setProxies([{ ...POOL[0], disabled: true }]);
    await expect(checkedProxyUrl({ proxyId: "random", pool: ["p1"] })).rejects.toThrow(
      /no exit left/,
    );
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("gives up after five tries rather than holding the run on a dead pool", async () => {
    setProxies(
      Array.from({ length: 12 }, (_, i) => ({
        id: `d${i}`,
        name: `Dead ${i}`,
        url: `socks5://10.1.0.${i}:1080`,
      })),
    );
    mockCreateConnection.mockRejectedValue(new Error("Connection timed out"));

    await expect(checkedProxyUrl({ proxyId: "random" })).rejects.toThrow(/5 of 12/);
    expect(mockCreateConnection).toHaveBeenCalledTimes(5);
  });
});

describe("nothing to check", () => {
  it("passes a blank pick and a direct one straight through", async () => {
    await expect(checkedProxyUrl({})).resolves.toBeUndefined();
    await expect(checkedProxyUrl({ proxyId: "direct" })).resolves.toBeUndefined();
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });
});
