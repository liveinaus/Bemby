// The "random" pick: a draw settles which exit leads, the pool bounds what may be drawn, and
// the same draw orders the fall-through. Settings live in SQLite; a map stands in for the table.
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cfProxyCandidatesFor,
  pickRandomProxy,
  proxyUrlFor,
  randomProxyPool,
  rememberCfProxy,
} from "../tg/proxyProviders";

const POOL = [
  { id: "p1", name: "Proxy One", url: "http://u:p@1.1.1.1:8080" },
  { id: "p2", name: "Proxy Two", url: "http://u:p@2.2.2.2:8080" },
  { id: "p3", name: "Proxy Three", url: "http://u:p@3.3.3.3:8080" },
];

beforeEach(() => {
  store.clear();
  store.set("proxies", JSON.stringify(POOL));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("randomProxyPool", () => {
  it("draws from the whole list when no pool is named", () => {
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(randomProxyPool([]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps to the ids named, ignoring ones that have since gone", () => {
    expect(randomProxyPool(["p3", "p1", "gone"]).map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("leaves out an entry with no url: there is nothing to exit through", () => {
    store.set("proxies", JSON.stringify([...POOL, { id: "p4", name: "Blank", url: "" }]));
    expect(randomProxyPool().map((p) => p.id)).not.toContain("p4");
  });
});

describe("pickRandomProxy", () => {
  it("picks from inside the pool", () => {
    for (let i = 0; i < 20; i++) {
      expect(["p1", "p3"]).toContain(pickRandomProxy(["p1", "p3"])!.id);
    }
  });

  it("has nothing to pick when the pool names only proxies that are gone", () => {
    expect(pickRandomProxy(["gone"])).toBeUndefined();
  });
});

describe("proxyUrlFor", () => {
  it("resolves an id, direct and a blank", () => {
    expect(proxyUrlFor("p2")).toBe(POOL[1].url);
    expect(proxyUrlFor("direct")).toBeUndefined();
    expect(proxyUrlFor("")).toBeUndefined();
    expect(proxyUrlFor(null)).toBeUndefined();
  });

  it("draws a url from the pool for random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(proxyUrlFor("random", ["p3", "p2"])).toBe(POOL[1].url);
  });

  it("has no url when a random draw comes up empty", () => {
    store.set("proxies", "[]");
    expect(proxyUrlFor("random")).toBeUndefined();
  });
});

describe("cfProxyCandidatesFor with a random pick", () => {
  it("offers only the pool, so a refusal never falls through to an exit left out of it", () => {
    const got = cfProxyCandidatesFor({ primaryUrl: POOL[0].url, proxyId: "random", proxyPool: ["p2", "p3"] });
    expect(got.map((c) => c.id).sort()).toEqual(["p2", "p3"]);
  });

  it("draws from the whole list when the pool is empty", () => {
    const got = cfProxyCandidatesFor({ proxyId: "random" });
    expect(got.map((c) => c.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps to the single drawn exit when the pool is not to be tried", () => {
    const got = cfProxyCandidatesFor({ proxyId: "random", proxyPool: ["p1", "p3"], tryAll: false });
    expect(got).toHaveLength(1);
    expect(["p1", "p3"]).toContain(got[0].id);
  });

  it("does not offer an exit already refused this run", () => {
    const got = cfProxyCandidatesFor({ proxyId: "random", proxyPool: ["p1", "p2"], exclude: ["p1"] });
    expect(got.map((c) => c.id)).toEqual(["p2"]);
  });

  it("draws a different order across runs rather than always leading with the same exit", () => {
    const leads = new Set<string>();
    for (let i = 0; i < 60; i++) {
      leads.add(cfProxyCandidatesFor({ proxyId: "random" })[0].id);
    }
    expect(leads.size).toBeGreaterThan(1);
  });

  it("ignores the host's last winner: a draw is a deliberate pick, like a pinned exit", () => {
    rememberCfProxy("app.example.com", "p3");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const got = cfProxyCandidatesFor({ proxyId: "random", host: "app.example.com", tryAll: false });
    expect(got[0].id).not.toBe("p3");
  });

  it("falls back to the job's own exit when there is nothing to draw from", () => {
    store.set("proxies", "[]");
    const got = cfProxyCandidatesFor({ primaryUrl: "http://u:p@9.9.9.9:8080", proxyId: "random" });
    expect(got).toEqual([{ id: "job", label: "job proxy", url: "http://u:p@9.9.9.9:8080" }]);
  });

  it("offers one candidate per exit, so the same url under two ids is not tried twice", () => {
    store.set(
      "proxies",
      JSON.stringify([...POOL, { id: "dup", name: "Same as One", url: POOL[0].url }]),
    );
    const got = cfProxyCandidatesFor({ proxyId: "random" });
    expect(got).toHaveLength(3);
    expect(got.filter((c) => c.url === POOL[0].url)).toHaveLength(1);
  });
});

// A tunnel exit is one address however many nodes list it, so it is offered only where it
// was asked for by name -- never by an unnamed draw or a Cloudflare fall-through.
describe("exits kept out of automatic pools", () => {
  const TUNNEL = { id: "t1", name: "Worker Sydney", url: "socks5://127.0.0.1:24080", autoPool: false };

  beforeEach(() => store.set("proxies", JSON.stringify([...POOL, TUNNEL])));

  it("is left out of a draw that names no pool", () => {
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("is drawn from once a pool names it", () => {
    expect(randomProxyPool(["t1", "p1"]).map((p) => p.id)).toEqual(["p1", "t1"]);
  });

  it("is not walked into when a Cloudflare attempt falls through the list", () => {
    const got = cfProxyCandidatesFor({ primaryUrl: POOL[0].url });
    expect(got.map((c) => c.id)).not.toContain("t1");
  });

  it("still leads when it is the pinned exit, since that was asked for", () => {
    const got = cfProxyCandidatesFor({ proxyId: "t1" });
    expect(got[0]).toEqual({ id: "t1", label: TUNNEL.name, url: TUNNEL.url });
  });

  it("an entry from before the flag is treated as poolable", () => {
    expect(randomProxyPool().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });
});

// A pool may name a supplier instead of each of its exits, so a sync that adds or drops
// proxies is followed without the pool being ticked again.
describe("a pool naming a supplier", () => {
  const IMPORTED = [
    { id: "pp:acme:1", name: "Acme Sydney", url: "http://u:p@4.4.4.4:8080" },
    { id: "pp:acme:2", name: "Acme Perth", url: "http://u:p@5.5.5.5:8080" },
    { id: "pp:other:9", name: "Other Tokyo", url: "http://u:p@6.6.6.6:8080" },
    { id: "pp:gone:1", name: "Deleted supplier", url: "http://u:p@7.7.7.7:8080" },
  ];

  beforeEach(() => {
    store.set("proxies", JSON.stringify([...POOL, ...IMPORTED]));
    store.set(
      "proxy_providers",
      JSON.stringify([
        { id: "acme", name: "Acme", type: "list", url: "https://acme.test/list" },
        { id: "other", name: "Other", type: "list", url: "https://other.test/list" },
      ]),
    );
  });

  it("draws from everything that supplier imported", () => {
    expect(randomProxyPool(["provider:acme"]).map((p) => p.id)).toEqual(["pp:acme:1", "pp:acme:2"]);
  });

  it("takes in a proxy the supplier gains, without the pool changing", () => {
    store.set(
      "proxies",
      JSON.stringify([...POOL, ...IMPORTED, { id: "pp:acme:3", name: "Acme Darwin", url: "http://u:p@8.8.8.8:8080" }]),
    );
    expect(randomProxyPool(["provider:acme"]).map((p) => p.id)).toContain("pp:acme:3");
  });

  it("mixes with proxies named one by one", () => {
    expect(randomProxyPool(["p2", "provider:other"]).map((p) => p.id)).toEqual([
      "p2",
      "pp:other:9",
    ]);
  });

  it("counts an import whose supplier is gone as ungrouped, alongside manual entries", () => {
    expect(randomProxyPool(["provider:"]).map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "pp:gone:1",
    ]);
  });

  it("still honours autoPool only where no pool is named", () => {
    store.set(
      "proxies",
      JSON.stringify([...IMPORTED, { id: "pp:acme:t", name: "Acme tunnel", url: "socks5://127.0.0.1:24080", autoPool: false }]),
    );
    expect(randomProxyPool().map((p) => p.id)).not.toContain("pp:acme:t");
    expect(randomProxyPool(["provider:acme"]).map((p) => p.id)).toContain("pp:acme:t");
  });

  it("orders a Cloudflare fall-through inside the supplier", () => {
    const got = cfProxyCandidatesFor({ proxyId: "random", proxyPool: ["provider:acme"] });
    expect(got.map((c) => c.id).sort()).toEqual(["pp:acme:1", "pp:acme:2"]);
  });
});
