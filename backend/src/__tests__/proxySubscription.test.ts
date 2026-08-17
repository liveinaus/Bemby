// Where a provider's token goes: a subscription wants it in the path or the query, which
// only the URL knows, so `{token}` marks the spot and the key field holds the secret.
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

// Real parsing, but no sockets: what is under test is the request, not the listener
vi.mock("../tg/vlessTunnel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tg/vlessTunnel")>();
  return {
    ...actual,
    applyVlessNodes: (
      providerId: string,
      nodes: Array<{ proxyId: string; node: import("../tg/vlessTunnel").VlessNode }>,
    ) => nodes.map((n, i) => ({ ...n, providerId, port: 24080 + i })),
    pruneVlessProviders: () => {},
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFromProvider,
  resolveProviderUrl,
  syncProviders,
  type ProxyProvider,
} from "../tg/proxyProviders";

const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";
const BODY = `vless://${UUID}@cf.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Sydney`;

const SUB: ProxyProvider = {
  id: "edt",
  name: "EDT2",
  type: "subscription",
  url: "https://edt2.example.xyz/sub?token={token}",
  apiKey: "3af763d9",
  enabled: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => BODY }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveProviderUrl", () => {
  it("puts the key where the URL asks for it, and sends no bearer header", () => {
    expect(resolveProviderUrl("https://w.dev/sub?token={token}", "abc123")).toEqual({
      url: "https://w.dev/sub?token=abc123",
      headers: {},
    });
  });

  it("fills a path segment too, which is the shape edgetunnel serves", () => {
    expect(resolveProviderUrl("https://w.dev/{token}", "abc123").url).toBe("https://w.dev/abc123");
  });

  it("fills every mention", () => {
    expect(resolveProviderUrl("https://w.dev/{token}/x?k={token}", "t").url).toBe(
      "https://w.dev/t/x?k=t",
    );
  });

  it("escapes a token that would otherwise change the URL's shape", () => {
    expect(resolveProviderUrl("https://w.dev/sub?token={token}", "a&b=c d").url).toBe(
      "https://w.dev/sub?token=a%26b%3Dc%20d",
    );
  });

  it("keeps the bearer header for a URL that asks for nothing", () => {
    expect(resolveProviderUrl("https://w.dev/sub", "abc123")).toEqual({
      url: "https://w.dev/sub",
      headers: { Authorization: "Bearer abc123" },
    });
  });

  it("sends no header at all without a key", () => {
    expect(resolveProviderUrl("https://w.dev/sub", undefined).headers).toEqual({});
    expect(resolveProviderUrl("https://w.dev/sub", "  ").headers).toEqual({});
  });

  it("says so when the URL asks for a token that is not set", () => {
    expect(() => resolveProviderUrl("https://w.dev/{token}", undefined)).toThrow(/no token is set/);
  });
});

describe("fetching a subscription", () => {
  it("requests the filled-in URL", async () => {
    await fetchFromProvider(SUB);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://edt2.example.xyz/sub?token=3af763d9",
      expect.objectContaining({ headers: { "User-Agent": "v2rayN/6.0" } }),
    );
  });

  it("asks as a plain client would, so the base64 format comes back", async () => {
    await fetchFromProvider({ ...SUB, url: "https://edt2.example.xyz/sub", apiKey: undefined });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "User-Agent": "v2rayN/6.0" });
  });

  it("turns each node into a loopback proxy kept out of automatic pools", async () => {
    const proxies = await fetchFromProvider(SUB);
    expect(proxies).toEqual([
      { id: expect.stringMatching(/^pp:edt:/), name: "EDT2 Sydney", url: "socks5://127.0.0.1:24080", host: "", autoPool: false },
    ]);
  });

  it("does not ask at all when the URL needs a token and none is set", async () => {
    await expect(fetchFromProvider({ ...SUB, apiKey: undefined })).rejects.toThrow(/no token is set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a body with nothing it can carry", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "trojan://x@a:443" });
    await expect(fetchFromProvider(SUB)).rejects.toThrow(/No VLESS-over-WebSocket nodes/);
  });
});

// A subscription that re-issues the same node on a new address gives it a new identity, and
// with it a new id -- which is what a job pins to. See PROXY_SYNC_MATCH_BY_NAME_KEY.
describe("refreshing a subscription whose nodes moved", () => {
  const MOVED = `vless://${UUID}@cf2.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Sydney`;

  async function firstImport(): Promise<string> {
    store.set("proxy_providers", JSON.stringify([SUB]));
    await syncProviders();
    const [proxy] = JSON.parse(store.get("proxies") ?? "[]");
    return proxy.id;
  }

  it("keeps the id a job is pinned to, and reports it as updated", async () => {
    const before = await firstImport();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => MOVED });

    const result = await syncProviders();
    const proxies = JSON.parse(store.get("proxies") ?? "[]");
    expect(proxies).toHaveLength(1);
    expect(proxies[0].id).toBe(before);
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0, total: 1 });
  });

  it("goes by identity alone when the setting is off", async () => {
    const before = await firstImport();
    store.set("proxy_sync_match_by_name", "false");
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => MOVED });

    const result = await syncProviders();
    const proxies = JSON.parse(store.get("proxies") ?? "[]");
    expect(proxies[0].id).not.toBe(before);
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 1 });
  });

  it("leaves a node that did not move alone", async () => {
    const before = await firstImport();
    const result = await syncProviders();
    expect(JSON.parse(store.get("proxies") ?? "[]")[0].id).toBe(before);
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 });
  });
});
