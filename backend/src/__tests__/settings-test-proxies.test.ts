// The proxy panel's "test all" button. The list is read from the database rather than
// the request, since the URLs the client holds have their passwords masked.

const { proxiesValue, mockCreateConnection } = vi.hoisted(() => ({
  proxiesValue: { raw: "[]" },
  mockCreateConnection: vi.fn(),
}));

vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(() => ({ value: proxiesValue.raw })),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
vi.mock("socks", () => ({
  SocksClient: { createConnection: mockCreateConnection },
}));

import http from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testStoredProxies } from "../routes/settings";

const socket = { destroy: vi.fn() };

function storeProxies(list: Array<{ id: string; name: string; url: string }>) {
  proxiesValue.raw = JSON.stringify(list);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateConnection.mockResolvedValue({ socket });
  storeProxies([]);
});

describe("testStoredProxies", () => {
  it("returns one result per stored proxy, in list order", async () => {
    storeProxies([
      { id: "a", name: "A", url: "socks5://10.0.0.1:1080" },
      { id: "b", name: "B", url: "socks5://10.0.0.2:1080" },
    ]);

    const results = await testStoredProxies();

    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mockCreateConnection).toHaveBeenCalledTimes(2);
  });

  it("reports the failure per proxy without failing the others", async () => {
    storeProxies([
      { id: "a", name: "A", url: "socks5://10.0.0.1:1080" },
      { id: "b", name: "B", url: "socks5://10.0.0.2:1080" },
    ]);
    mockCreateConnection
      .mockRejectedValueOnce(new Error("Connection timed out"))
      .mockResolvedValueOnce({ socket });

    const results = await testStoredProxies();

    expect(results[0]).toMatchObject({ id: "a", ok: false, error: "Connection timed out" });
    expect(results[1]).toMatchObject({ id: "b", ok: true });
  });

  it("marks an unparseable proxy URL as failed without dialling", async () => {
    storeProxies([{ id: "a", name: "A", url: "not-a-proxy" }]);

    const results = await testStoredProxies();

    expect(results[0]).toMatchObject({ id: "a", ok: false });
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("keeps at most PROXY_TEST_CONCURRENCY connections open at once", async () => {
    storeProxies(
      Array.from({ length: 45 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        url: `socks5://10.0.0.${i}:1080`,
      })),
    );
    let inFlight = 0;
    let peak = 0;
    mockCreateConnection.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { socket };
    });

    const results = await testStoredProxies();

    expect(results).toHaveLength(45);
    expect(peak).toBeLessThanOrEqual(20);
  });

  it("returns nothing when no proxies are stored", async () => {
    expect(await testStoredProxies()).toEqual([]);
  });
});

// Webshare and downloaded lists hand out HTTP proxies. A SOCKS handshake against one
// only ever fails, so they used to be reported dead without a packet being sent.
describe("testStoredProxies over HTTP proxies", () => {
  let server: http.Server;
  let port = 0;
  // What the fake proxy answers a CONNECT with
  let reply = "HTTP/1.1 200 Connection Established\r\n\r\n";

  beforeEach(async () => {
    reply = "HTTP/1.1 200 Connection Established\r\n\r\n";
    server = http.createServer();
    server.on("connect", (_req, socket) => {
      socket.write(reply);
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("reports an HTTP proxy that establishes the tunnel as reachable", async () => {
    storeProxies([
      { id: "w", name: "Webshare", url: `http://user:pass@127.0.0.1:${port}/` },
    ]);

    const [result] = await testStoredProxies();

    expect(result).toMatchObject({ id: "w", ok: true });
    // Never routed through the SOCKS client, which is what used to fail them all
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("names a rejected proxy password rather than reporting it unreachable", async () => {
    reply = "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n";
    storeProxies([
      { id: "w", name: "Webshare", url: `http://user:bad@127.0.0.1:${port}/` },
    ]);

    const [result] = await testStoredProxies();

    expect(result).toMatchObject({
      ok: false,
      error: "Proxy authentication failed",
    });
  });

  it("rejects a scheme that is neither SOCKS nor HTTP", async () => {
    storeProxies([{ id: "x", name: "X", url: "ftp://10.0.0.1:21" }]);

    const [result] = await testStoredProxies();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported proxy scheme");
  });
});
