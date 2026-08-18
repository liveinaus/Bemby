// A proxy carries what the last test made of it. A failed exit is disabled: no draw, no
// supplier and no Cloudflare fall-through reaches for it until a later test clears it.
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

vi.mock("../tg/vlessTunnel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tg/vlessTunnel")>();
  return { ...actual, applyVlessNodes: () => [], pruneVlessProviders: () => {} };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cfProxyCandidatesFor,
  clearProxyStatus,
  randomProxyPool,
  recordProxyTestResults,
  syncProviders,
  type BembyProxy,
} from "../tg/proxyProviders";

const proxies = (): BembyProxy[] => JSON.parse(store.get("proxies") ?? "[]");
const setProxies = (list: BembyProxy[]) => store.set("proxies", JSON.stringify(list));

const OK = { id: "p1", name: "One", url: "http://u:p@1.1.1.1:8080" };
const DEAD = { id: "p2", name: "Two", url: "http://u:p@2.2.2.2:8080", status: "failed" as const };
const UNTESTED = { id: "p3", name: "Three", url: "http://u:p@3.3.3.3:8080" };

beforeEach(() => {
  store.clear();
  setProxies([OK, DEAD, UNTESTED]);
});

afterEach(() => vi.unstubAllGlobals());

describe("a disabled exit", () => {
  it("is left out of a draw over the whole list", () => {
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("is left out even when the pool names it, since it cannot carry the run", () => {
    expect(randomProxyPool(["p1", "p2"]).map((p) => p.id)).toEqual(["p1"]);
  });

  it("is left out of a supplier the pool names", () => {
    setProxies([
      { id: "pp:acme:1", name: "Acme A", url: "http://u:p@4.4.4.4:8080" },
      { id: "pp:acme:2", name: "Acme B", url: "http://u:p@5.5.5.5:8080", status: "failed" },
    ]);
    store.set(
      "proxy_providers",
      JSON.stringify([{ id: "acme", name: "Acme", type: "list", url: "https://acme.test/l" }]),
    );
    expect(randomProxyPool(["provider:acme"]).map((p) => p.id)).toEqual(["pp:acme:1"]);
  });

  it("is not walked into when a Cloudflare attempt falls through the list", () => {
    expect(cfProxyCandidatesFor({ primaryUrl: OK.url }).map((c) => c.id)).not.toContain("p2");
  });

  it("is still used when it is the only thing left, rather than the run going out direct", () => {
    setProxies([DEAD]);
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p2"]);
    expect(randomProxyPool(["p2"]).map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("recordProxyTestResults", () => {
  it("disables what failed and puts back what answered", () => {
    const counts = recordProxyTestResults([
      { id: "p1", ok: false, error: "Connection timed out", ms: 6000 },
      { id: "p2", ok: true, ms: 120 },
    ]);

    expect(counts).toEqual({ failed: 1, recovered: 1 });
    const [one, two] = proxies();
    expect(one).toMatchObject({ status: "failed", testError: "Connection timed out" });
    expect(two).toMatchObject({ status: "ok", testMs: 120 });
    expect(two.testError).toBeUndefined();
  });

  it("leaves an entry the results say nothing about alone", () => {
    recordProxyTestResults([{ id: "p1", ok: true, ms: 10 }]);
    expect(proxies()[2].status).toBeUndefined();
  });

  it("ignores a result for an entry that has since gone", () => {
    recordProxyTestResults([{ id: "vanished", ok: false, error: "x" }]);
    expect(proxies().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("clearProxyStatus", () => {
  it("puts a disabled exit back in the draw", () => {
    expect(clearProxyStatus("p2")).toBe(true);
    expect(proxies()[1].status).toBeUndefined();
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("says so when there is no such exit", () => {
    expect(clearProxyStatus("nope")).toBe(false);
  });
});

describe("a provider refresh", () => {
  const PROVIDER = {
    id: "acme",
    name: "Acme",
    type: "list" as const,
    url: "https://acme.test/list",
    enabled: true,
  };

  const listReturning = (body: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => body })),
    );

  beforeEach(() => {
    store.set("proxy_providers", JSON.stringify([PROVIDER]));
  });

  it("keeps the verdict on an exit it hands back unchanged", async () => {
    setProxies([
      {
        id: "pp:acme:1.1.1.1:8080",
        name: "1.1.1.1:8080",
        url: "http://1.1.1.1:8080",
        status: "failed",
        testError: "Connection timed out",
      },
    ]);
    listReturning("1.1.1.1:8080\n");

    await syncProviders("acme");
    expect(proxies()[0]).toMatchObject({ status: "failed", testError: "Connection timed out" });
  });

  it("clears it when the address behind the entry changed: that exit is untested", async () => {
    setProxies([
      {
        id: "pp:acme:1.1.1.1:8080",
        name: "1.1.1.1:8080",
        url: "http://1.1.1.1:8080",
        status: "failed",
      },
    ]);
    listReturning("1.1.1.1:9090\n");

    await syncProviders("acme");
    const list = proxies();
    expect(list.map((p) => p.url)).toEqual(["http://1.1.1.1:9090"]);
    expect(list[0].status).toBeUndefined();
  });

  it("reports which providers it rewrote, so the caller can test just those", async () => {
    listReturning("1.1.1.1:8080\n");
    const result = await syncProviders("acme");
    expect(result.syncedProviderIds).toEqual(["acme"]);
  });
});
