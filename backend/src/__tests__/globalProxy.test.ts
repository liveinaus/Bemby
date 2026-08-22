// The global exit: what a connection uses when nothing else was picked for it. It stands in
// for a direct connection everywhere, and everything picked anywhere still wins over it.
// Settings live in SQLite; a map stands in for the table.
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

import http from "node:http";
import net from "node:net";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cfProxyCandidatesFor,
  globalProxyLabel,
  globalProxyUrl,
  proxyUrlFor,
  GLOBAL_PROXY_ID_KEY,
} from "../tg/proxyProviders";
import {
  applyGlobalProxy,
  globalTgProxy,
  globalTgProxyUrl,
  proxyDispatcher,
} from "../tg/globalProxy";
import { makeJobProxyResolver } from "../jobs/jobProxy";

const SOCKS = "socks5://u:p@9.9.9.9:1080";
const POOL = [
  { id: "g1", name: "Global exit", url: SOCKS },
  { id: "p1", name: "Proxy One", url: "http://u:p@1.1.1.1:8080" },
  { id: "h1", name: "HTTP global", url: "http://u:p@8.8.8.8:8080" },
];

beforeEach(() => {
  store.clear();
  store.set("proxies", JSON.stringify(POOL));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("globalProxyUrl", () => {
  it("is off until an exit is named, which is a direct connection as before", () => {
    expect(globalProxyUrl()).toBeUndefined();
    expect(globalProxyLabel()).toBe("");
  });

  it("resolves the named exit, and names it for a log line", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    expect(globalProxyUrl()).toBe(SOCKS);
    expect(globalProxyLabel()).toBe("Global exit");
  });

  it("treats an explicit `direct` as off", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "direct");
    expect(globalProxyUrl()).toBeUndefined();
  });

  it("goes direct rather than throwing when the exit has been deleted", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "gone");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(globalProxyUrl()).toBeUndefined();
    expect(globalProxyLabel()).toBe("");
  });
});

describe("proxyUrlFor with a global exit set", () => {
  beforeEach(() => store.set(GLOBAL_PROXY_ID_KEY, "g1"));

  it("uses it when nothing was picked", () => {
    expect(proxyUrlFor(undefined)).toBe(SOCKS);
    expect(proxyUrlFor("")).toBe(SOCKS);
  });

  it("uses it for `direct` too: that is the connection it replaces", () => {
    expect(proxyUrlFor("direct")).toBe(SOCKS);
  });

  it("keeps out of the way of an exit picked by name", () => {
    expect(proxyUrlFor("p1")).toBe("http://u:p@1.1.1.1:8080");
  });

  it("leaves a pin that no longer resolves undefined, so the caller can still say so", () => {
    expect(proxyUrlFor("gone")).toBeUndefined();
  });

  it("catches a draw that comes up empty rather than letting it out direct", () => {
    expect(proxyUrlFor("random", ["gone"])).toBe(SOCKS);
  });
});

describe("the Cloudflare candidate list", () => {
  it("leads with the global exit where it would have gone direct, named by its list entry", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    expect(cfProxyCandidatesFor({ proxyId: "direct" })[0]).toMatchObject({
      id: "g1",
      label: "Global exit",
      url: SOCKS,
    });
    expect(cfProxyCandidatesFor({ tryAll: false })[0]).toMatchObject({ url: SOCKS });
  });

  it("still offers a direct attempt when no global exit is set", () => {
    expect(cfProxyCandidatesFor({ proxyId: "direct" })[0]).toMatchObject({
      id: "direct",
      url: undefined,
    });
  });
});

describe("the Telegram side", () => {
  it("carries an account with no proxy of its own when the global exit is SOCKS", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    expect(globalTgProxy()).toEqual({
      ip: "9.9.9.9",
      port: 1080,
      socksType: 5,
      username: "u",
      password: "p",
    });
    expect(globalTgProxyUrl()).toBe(SOCKS);
  });

  it("leaves it direct when the global exit is HTTP, which MTProto cannot use", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "h1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(globalTgProxy()).toBeUndefined();
    expect(globalTgProxyUrl()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("the jobs page's exit column", () => {
  const row = { config: null, template_id: null, account_proxy_id: null };

  it("says direct while the global exit is off", () => {
    expect(makeJobProxyResolver()(row)).toMatchObject({ kind: "direct", label: "" });
  });

  it("names the global exit once one is set", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    expect(makeJobProxyResolver()(row)).toMatchObject({
      kind: "global",
      label: "Global exit",
      source: "account",
    });
  });

  it("leaves a job that picked its own exit alone", () => {
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    expect(
      makeJobProxyResolver()({ ...row, config: JSON.stringify({ proxyId: "p1" }) }),
    ).toMatchObject({ kind: "proxy", label: "Proxy One", source: "job" });
  });
});

// The dispatcher half: undici carries an HTTP proxy itself but not a SOCKS one, and almost
// every exit Bemby is given is SOCKS. A minimal no-auth SOCKS5 server stands in for one.
describe("the dispatcher the global exit is reached through", () => {
  const opened: Array<net.Server> = [];

  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    setGlobalDispatcher(new Agent());
  });

  /** No auth, CONNECT only, which is all a dispatcher asks of it. */
  async function socksServer(): Promise<number> {
    const server = net.createServer((client) => {
      client.on("error", () => client.destroy());
      // `once` throughout: the third chunk onwards is the tunnelled request, which belongs to
      // the pipe below and must not be read as another handshake
      client.once("data", () => {
        client.write(Buffer.from([5, 0]));
        client.once("data", (chunk) => {
          const [host, after] =
            chunk[3] === 1
              ? [`${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`, 8]
              : [chunk.subarray(5, 5 + chunk[4]).toString(), 5 + chunk[4]];
          const upstream = net.connect(chunk.readUInt16BE(after), host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
        });
      });
    });
    opened.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as net.AddressInfo).port;
  }

  async function originServer(): Promise<number> {
    const server = http.createServer((_req, res) => res.end("through the exit"));
    opened.push(server as unknown as net.Server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as net.AddressInfo).port;
  }

  it("tunnels a request through a SOCKS exit", async () => {
    const [socks, origin] = [await socksServer(), await originServer()];
    const dispatcher = proxyDispatcher(`socks5://127.0.0.1:${socks}`);
    const res = await undiciFetch(`http://127.0.0.1:${origin}/`, { dispatcher });
    expect(await res.text()).toBe("through the exit");
  });

  it("points plain fetch at it, which is what covers the calls nobody routes by hand", async () => {
    const [socks, origin] = [await socksServer(), await originServer()];
    store.set("proxies", JSON.stringify([{ id: "g1", name: "S", url: `socks5://127.0.0.1:${socks}` }]));
    store.set(GLOBAL_PROXY_ID_KEY, "g1");
    vi.spyOn(console, "log").mockImplementation(() => {});

    applyGlobalProxy();
    const res = await fetch(`http://127.0.0.1:${origin}/`);
    expect(await res.text()).toBe("through the exit");
  });
});
