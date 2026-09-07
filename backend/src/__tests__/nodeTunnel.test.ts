// Tunnel exits: keeping a node on the same loopback port across a re-sync, and carrying a
// connection end to end through a stand-in Worker. Link reading is proxyNodes.test.ts.

// Bound away from the range an instance uses, so a Bemby running on this machine with
// tunnels of its own does not own the ports these tests are about to bind
vi.hoisted(() => {
  process.env.VLESS_PORT_BASE = "24700";
});

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

// No core installed, so the built-in WebSocket bridge is what carries these nodes. A host
// with an xray on PATH would otherwise hand them to it and bind nothing here.
vi.mock("../jobs/xrayInstall", () => ({
  isXrayInstalled: () => false,
  xrayPath: () => undefined,
  xrayRoot: () => "/tmp/bemby-test-xray",
}));

import net from "net";
import { WebSocketServer } from "ws";
import { SocksClient } from "socks";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyNodes, stopTunnels, tunnelNodeFor } from "../tg/nodeTunnel";
import { nodeKey, type ProxyNode } from "../tg/proxyNodes";
import { vlessRequest } from "../tg/vlessTunnel";

const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";

describe("vlessRequest", () => {
  it("writes version, uuid, no addons, TCP, port and address", () => {
    const header = vlessRequest(UUID, { type: 2, addr: Buffer.from([3, 97, 98, 99]), port: 443 });
    expect(header[0]).toBe(0);
    expect(header.subarray(1, 17).toString("hex")).toBe(UUID.replace(/-/g, ""));
    expect(header[17]).toBe(0);
    expect(header[18]).toBe(1);
    expect(header.readUInt16BE(19)).toBe(443);
    expect(header.subarray(21)).toEqual(Buffer.from([2, 3, 97, 98, 99]));
  });
});

// ── Stand-in Worker ───────────────────────────────────────────────────────────

/** A TCP server that answers with what it was sent, upper-cased. */
function startEcho(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase()));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      }),
    );
  });
}

/**
 * What the Worker does: read the VLESS request, open the connection it asks for, answer
 * with the two-byte response header, then relay.
 */
function startWorker(): Promise<{ port: number; close: () => void }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", (ws) => {
    let upstream: net.Socket | undefined;
    let ready = false;
    const pending: Buffer[] = [];

    ws.on("message", (data: Buffer) => {
      if (upstream) {
        if (ready) upstream.write(data);
        else pending.push(data);
        return;
      }

      let i = 18 + data[17];
      i++; // command
      const port = data.readUInt16BE(i);
      i += 2;
      const type = data[i++];
      let host: string;
      if (type === 1) {
        host = [...data.subarray(i, i + 4)].join(".");
        i += 4;
      } else {
        const len = data[i++];
        host = data.subarray(i, i + len).toString();
        i += len;
      }
      const initial = data.subarray(i);

      upstream = net.connect(port, host, () => {
        ws.send(Buffer.from([0, 0]));
        ready = true;
        if (initial.length) upstream!.write(initial);
        for (const chunk of pending) upstream!.write(chunk);
        pending.length = 0;
      });
      upstream.on("data", (chunk) => ws.send(chunk));
      upstream.on("close", () => ws.close());
      upstream.on("error", () => ws.close());
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () =>
      resolve({
        port: (wss.address() as net.AddressInfo).port,
        close: () => wss.close(),
      }),
    );
  });
}

describe("tunnel exits", () => {
  let echo: { port: number; close: () => void };
  let worker: { port: number; close: () => void };

  beforeEach(async () => {
    store.clear();
    [echo, worker] = await Promise.all([startEcho(), startWorker()]);
  });

  afterEach(() => {
    stopTunnels();
    echo.close();
    worker.close();
  });

  afterAll(() => stopTunnels());

  const node = (name: string): ProxyNode => ({
    protocol: "vless",
    address: "127.0.0.1",
    port: worker.port,
    id: UUID,
    transport: "ws",
    security: "none",
    path: "/",
    name,
  });

  /** Sends one line through the exit and returns what came back. Retried while it binds. */
  function speak(port: number, host: string, payload: string): Promise<string> {
    return vi.waitFor(
      async () => {
        const { socket } = await SocksClient.createConnection({
          proxy: { host: "127.0.0.1", port, type: 5 },
          command: "connect",
          destination: { host, port: echo.port },
        });
        try {
          return await new Promise<string>((resolve, reject) => {
            socket.once("data", (chunk) => resolve(chunk.toString()));
            socket.once("error", reject);
            socket.write(payload);
          });
        } finally {
          socket.destroy();
        }
      },
      { timeout: 5000 },
    );
  }

  function exitPort(): number {
    const only = node("Node one");
    const [entry] = applyNodes("prov", [
      { proxyId: `pp:prov:${nodeKey(only)}`, node: only },
    ]);
    expect(tunnelNodeFor(`socks5://127.0.0.1:${entry.port}`)?.name).toBe("Node one");
    return entry.port;
  }

  it("carries a connection from local SOCKS5 through to the destination", async () => {
    expect(await speak(exitPort(), "127.0.0.1", "through the tunnel")).toBe("THROUGH THE TUNNEL");
  });

  it("resolves the destination name at the exit rather than here", async () => {
    // A hostname goes out as a hostname, the way socks5h behaves
    expect(await speak(exitPort(), "localhost", "by name")).toBe("BY NAME");
  });

  it("keeps a node on its port across a re-sync, and gives a new node its own", () => {
    const one = node("Node one");
    const two = { ...node("Node two"), path: "/second" };
    const idOne = `pp:prov:${nodeKey(one)}`;
    const idTwo = `pp:prov:${nodeKey(two)}`;

    const first = applyNodes("prov", [{ proxyId: idOne, node: one }]);
    const port = first[0].port;

    const second = applyNodes("prov", [
      { proxyId: idTwo, node: two },
      { proxyId: idOne, node: one },
    ]);
    expect(second.find((e) => e.proxyId === idOne)?.port).toBe(port);
    expect(second.find((e) => e.proxyId === idTwo)?.port).not.toBe(port);
  });

  it("replaces only its own provider's nodes", () => {
    const mine = node("Mine");
    const theirs = { ...node("Theirs"), path: "/theirs" };
    applyNodes("a", [{ proxyId: `pp:a:${nodeKey(mine)}`, node: mine }]);
    applyNodes("b", [{ proxyId: `pp:b:${nodeKey(theirs)}`, node: theirs }]);

    // Syncing "a" again with nothing must leave "b" alone
    applyNodes("a", []);
    const stored = JSON.parse(store.get("vless_nodes") ?? "[]");
    expect(stored.map((e: { providerId: string }) => e.providerId)).toEqual(["b"]);
  });
});
