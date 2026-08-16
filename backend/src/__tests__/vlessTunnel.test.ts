// VLESS-over-WebSocket exits: reading a subscription, keeping a node on the same
// loopback port, and carrying a connection end to end through a stand-in Worker.

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

import net from "net";
import { WebSocketServer } from "ws";
import { SocksClient } from "socks";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyVlessNodes,
  isVlessListener,
  nodeKey,
  parseVlessLink,
  parseVlessSubscription,
  stopVlessTunnels,
  vlessRequest,
  type VlessNode,
} from "../tg/vlessTunnel";

const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";

describe("parseVlessLink", () => {
  it("reads the link a Workers deployment hands out", () => {
    const node = parseVlessLink(
      `vless://${UUID}@cf.example.com:443?encryption=none&security=tls&sni=my.worker.dev&fp=randomized&type=ws&host=my.worker.dev&path=%2F%3Fed%3D2048#Sydney`,
    );
    expect(node).toEqual({
      address: "cf.example.com",
      port: 443,
      uuid: UUID,
      tls: true,
      sni: "my.worker.dev",
      hostHeader: "my.worker.dev",
      path: "/?ed=2048",
      name: "Sydney",
    });
  });

  it("falls back to the host header for sni, and to port 443 with tls", () => {
    const node = parseVlessLink(
      `vless://${UUID}@1.2.3.4?security=tls&type=ws&host=my.worker.dev&path=%2F`,
    );
    expect(node?.port).toBe(443);
    expect(node?.sni).toBe("my.worker.dev");
  });

  it("takes a plain ws node on port 80 with a root path", () => {
    const node = parseVlessLink(`vless://${UUID}@1.2.3.4`);
    expect(node).toMatchObject({ port: 80, tls: false, path: "/", sni: undefined });
  });

  it("turns down what it cannot carry", () => {
    // Transports other than WebSocket, and handshakes we do not speak
    expect(parseVlessLink(`vless://${UUID}@a.com:443?type=grpc`)).toBeUndefined();
    expect(parseVlessLink(`vless://${UUID}@a.com:443?type=ws&security=reality`)).toBeUndefined();
    expect(parseVlessLink(`vless://not-a-uuid@a.com:443?type=ws`)).toBeUndefined();
    expect(parseVlessLink(`trojan://${UUID}@a.com:443`)).toBeUndefined();
    expect(parseVlessLink("nonsense")).toBeUndefined();
  });
});

describe("parseVlessSubscription", () => {
  const links = [
    `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#One`,
    `vless://${UUID}@b.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Two`,
  ].join("\n");

  it("reads a plain body", () => {
    const { nodes } = parseVlessSubscription(links);
    expect(nodes.map((n) => n.name)).toEqual(["One", "Two"]);
  });

  it("reads a base64 body, which is what most subscriptions serve", () => {
    const { nodes } = parseVlessSubscription(Buffer.from(links).toString("base64"));
    expect(nodes.map((n) => n.address)).toEqual(["a.example.com", "b.example.com"]);
  });

  it("collapses repeats and counts the nodes it cannot carry", () => {
    const { nodes, skipped } = parseVlessSubscription(
      [links, links, `trojan://x@c.example.com:443`, `ss://y@d.example.com:443`].join("\n"),
    );
    expect(nodes).toHaveLength(2);
    expect(skipped).toBe(2);
  });

  it("names differ but the node is the same, so the first name stands", () => {
    const { nodes } = parseVlessSubscription(
      [
        `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#First`,
        `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Second`,
      ].join("\n"),
    );
    expect(nodes.map((n) => n.name)).toEqual(["First"]);
  });
});

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
    stopVlessTunnels();
    echo.close();
    worker.close();
  });

  afterAll(() => stopVlessTunnels());

  const node = (name: string): VlessNode => ({
    address: "127.0.0.1",
    port: worker.port,
    uuid: UUID,
    tls: false,
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
    const [entry] = applyVlessNodes("prov", [
      { proxyId: `pp:prov:${nodeKey(only)}`, node: only },
    ]);
    expect(isVlessListener(`socks5://127.0.0.1:${entry.port}`)).toBe(true);
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

    const first = applyVlessNodes("prov", [{ proxyId: idOne, node: one }]);
    const port = first[0].port;

    const second = applyVlessNodes("prov", [
      { proxyId: idTwo, node: two },
      { proxyId: idOne, node: one },
    ]);
    expect(second.find((e) => e.proxyId === idOne)?.port).toBe(port);
    expect(second.find((e) => e.proxyId === idTwo)?.port).not.toBe(port);
  });

  it("replaces only its own provider's nodes", () => {
    const mine = node("Mine");
    const theirs = { ...node("Theirs"), path: "/theirs" };
    applyVlessNodes("a", [{ proxyId: `pp:a:${nodeKey(mine)}`, node: mine }]);
    applyVlessNodes("b", [{ proxyId: `pp:b:${nodeKey(theirs)}`, node: theirs }]);

    // Syncing "a" again with nothing must leave "b" alone
    applyVlessNodes("a", []);
    const stored = JSON.parse(store.get("vless_nodes") ?? "[]");
    expect(stored.map((e: { providerId: string }) => e.providerId)).toEqual(["b"]);
  });
});
