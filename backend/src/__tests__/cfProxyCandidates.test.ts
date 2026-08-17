// Settings live in SQLite; a plain in-memory map stands in for the table here.
const store = new Map<string, string>();
vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && store.has(key) ? { value: store.get(key) } : undefined,
      run: (key: string, value: string) => store.set(key, value),
      all: () => [],
    }),
  },
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cfProxyCandidatesFor, proxyLabelForUrl, rememberCfProxy } from "../tg/proxyProviders";

const POOL = [
  { id: "p1", name: "Proxy One", url: "http://u:p@1.1.1.1:8080" },
  { id: "p2", name: "Proxy Two", url: "http://u:p@2.2.2.2:8080" },
  { id: "p3", name: "Proxy Three", url: "http://u:p@3.3.3.3:8080" },
];

beforeEach(() => {
  store.clear();
  store.set("proxies", JSON.stringify(POOL));
});

describe("cfProxyCandidatesFor", () => {
  it("leads with the job proxy and offers the rest of the pool", () => {
    const got = cfProxyCandidatesFor({ primaryUrl: POOL[1].url });
    expect(got.map((c) => c.id)).toEqual(["p2", "p1", "p3"]);
  });

  it("keeps to the single pinned exit when the pool is not to be tried", () => {
    const got = cfProxyCandidatesFor({ primaryUrl: POOL[0].url, proxyId: "p3", tryAll: false });
    expect(got).toEqual([{ id: "p3", label: "Proxy Three", url: POOL[2].url }]);
  });

  it("pins a chosen exit first, with the pool behind it", () => {
    const got = cfProxyCandidatesFor({ primaryUrl: POOL[0].url, proxyId: "p3" });
    expect(got.map((c) => c.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("runs without a proxy when direct is pinned", () => {
    const got = cfProxyCandidatesFor({ proxyId: "direct", tryAll: false });
    expect(got).toEqual([{ id: "direct", label: "direct", url: undefined }]);
  });

  it("leads with the exit that last cleared the host, unless one is pinned", () => {
    rememberCfProxy("app.example.com", "p3");
    expect(
      cfProxyCandidatesFor({ primaryUrl: POOL[0].url, host: "app.example.com" }).map((c) => c.id),
    ).toEqual(["p3", "p1", "p2"]);
    expect(
      cfProxyCandidatesFor({ primaryUrl: POOL[0].url, host: "app.example.com", proxyId: "p2" }).map(
        (c) => c.id,
      ),
    ).toEqual(["p2", "p1", "p3"]);
  });

  it("caps how many exits are offered", () => {
    expect(cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 2 })).toHaveLength(2);
  });

  it("offers an exit once: refused ones are not repeated on a retry", () => {
    const first = cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 2 });
    expect(first.map((c) => c.id)).toEqual(["p1", "p2"]);
    const second = cfProxyCandidatesFor({
      primaryUrl: POOL[0].url,
      max: 2,
      exclude: first.map((c) => c.id),
    });
    expect(second.map((c) => c.id)).toEqual(["p3"]);
    expect(
      cfProxyCandidatesFor({ primaryUrl: POOL[0].url, exclude: ["p1", "p2", "p3"] }),
    ).toEqual([]);
  });

  it("reaches exits sitting past one attempt's window, imports included", () => {
    const big = [
      ...POOL,
      { id: "pp:webshare:1", name: "Webshare A", url: "http://u:p@4.4.4.4:8080" },
      { id: "pp:webshare:2", name: "Webshare B", url: "http://u:p@5.5.5.5:8080" },
    ];
    store.set("proxies", JSON.stringify(big));
    const first = cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 3 });
    const second = cfProxyCandidatesFor({
      primaryUrl: POOL[0].url,
      max: 3,
      exclude: first.map((c) => c.id),
    });
    expect(second.map((c) => c.id)).toEqual(["pp:webshare:1", "pp:webshare:2"]);
  });

  it("drops a pinned exit that has already been refused", () => {
    expect(cfProxyCandidatesFor({ proxyId: "p3", tryAll: false, exclude: ["p3"] })).toEqual([]);
  });
});

// What a session or a run says it is going out through. Never the url: it carries credentials.
describe("proxyLabelForUrl", () => {
  it("gives the name the proxy list holds", () => {
    expect(proxyLabelForUrl(POOL[1].url)).toBe("Proxy Two");
  });

  it("says direct when there is no proxy at all", () => {
    expect(proxyLabelForUrl(undefined)).toBe("direct");
  });

  it("falls back to host and port for an exit not in the list, credentials left out", () => {
    const label = proxyLabelForUrl("http://user:secret@9.9.9.9:3128");
    expect(label).toBe("9.9.9.9:3128");
    expect(label).not.toContain("secret");
  });
});
