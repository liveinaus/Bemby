import net from "net";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { isWorkerNode, type ProxyNode } from "./proxyNodes";

// VLESS-over-WebSocket exits (edgetunnel and friends running on Cloudflare Workers),
// presented to the rest of Bemby as ordinary SOCKS5 proxies on loopback.
//
// This is Bemby's own carrier, and it covers exactly one shape: VLESS over WebSocket with
// plain TLS or none, which is what a Workers deployment serves. It needs nothing installed,
// so a Workers subscription works on a bare image. Everything else a subscription may hold
// -- REALITY, raw TCP, gRPC, VMess, Trojan, Shadowsocks -- goes to the Xray core instead
// (see xrayTunnel); the choice between them is nodeTunnel's.
//
// Worth knowing before reaching for these: every node on one Worker leaves from
// Cloudflare's own address space, so a subscription is one exit identity rather than a
// pool. Imported entries are therefore kept out of automatic draws (see `autoPool`).

const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Bytes queued towards the Worker before the local side is held back. */
const HIGH_WATER = 1 << 20;
const BIND_RETRIES = 5;
const BIND_RETRY_MS = 100;

// ── Listeners ─────────────────────────────────────────────────────────────────

export type WsExit = { port: number; node: ProxyNode; key: string };

type Running = { server: net.Server; key: string; sockets: Set<net.Socket> };

const running = new Map<number, Running>();

/** Ports this bridge is listening on right now. */
export function runningWsPorts(): number[] {
  return [...running.keys()];
}

/** Starts a listener for each of these nodes, and stops any that no longer belongs. */
export function syncWsExits(exits: WsExit[]): void {
  const wanted = new Map(exits.map((e) => [e.port, e]));

  for (const [port, live] of running) {
    const exit = wanted.get(port);
    if (exit && exit.key === live.key) continue;
    stopWsExit(port);
  }

  for (const [port, exit] of wanted) {
    if (running.has(port)) continue;
    startWsExit(exit);
  }
}

export function stopAllWsExits(): void {
  for (const port of [...running.keys()]) stopWsExit(port);
}

function stopWsExit(port: number): void {
  const live = running.get(port);
  if (!live) return;
  running.delete(port);
  for (const socket of live.sockets) socket.destroy();
  live.server.close();
}

function startWsExit(exit: WsExit): void {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    serveSocks(client, exit.node);
  });

  // Registered before it is bound, so a second reconcile in the same tick does not start
  // a duplicate on the port this one is still opening
  const live: Running = { server, key: exit.key, sockets };
  running.set(exit.port, live);

  let attempts = 0;
  server.on("error", (err: NodeJS.ErrnoException) => {
    // A port handed back by a listener that has not finished closing is in use for a
    // moment longer. Giving up there would leave the node with no exit and the port held
    // by a listener pointed at a node that is gone, so the bind is retried briefly.
    if (err.code === "EADDRINUSE" && attempts < BIND_RETRIES && running.get(exit.port) === live) {
      attempts++;
      setTimeout(() => {
        if (running.get(exit.port) === live) server.listen(exit.port, "127.0.0.1");
      }, BIND_RETRY_MS).unref();
      return;
    }

    if (running.get(exit.port) === live) running.delete(exit.port);
    console.error(
      err.code === "EADDRINUSE"
        ? `[vless] port ${exit.port} is taken, so "${exit.node.name}" has no exit`
        : `[vless] listener for "${exit.node.name}" failed: ${err.message}`,
    );
  });

  server.listen(exit.port, "127.0.0.1");
}

// ── SOCKS5 in, VLESS out ──────────────────────────────────────────────────────

const SOCKS_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

/**
 * A destination as the SOCKS request gave it. The address bytes are carried through
 * untouched: SOCKS and VLESS agree on the shape of all three forms, including the
 * length byte in front of a domain.
 */
export type Target = {
  /** VLESS address type: 1 IPv4, 2 domain (length-prefixed), 3 IPv6. */
  type: 1 | 2 | 3;
  addr: Buffer;
  port: number;
};

/**
 * One local connection: SOCKS5 greeting and CONNECT, then a WebSocket to the Worker
 * carrying a VLESS request. The local side stays paused until the tunnel is up, so
 * nothing has to be queued beyond whatever arrived in the request's own packet.
 */
function serveSocks(client: net.Socket, node: ProxyNode): void {
  let stage: "greeting" | "request" | "relay" = "greeting";
  let buf = Buffer.alloc(0);
  let ws: WebSocket | undefined;
  let open = false;
  let responseHeader: Buffer = Buffer.alloc(0);
  let headerRead = false;

  client.setKeepAlive(true, 30_000);

  const refuse = (code: number) => {
    if (!client.destroyed) client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  };

  const closeBoth = () => {
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    if (!client.destroyed) client.destroy();
  };

  client.on("close", () => {
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  });

  client.on("data", (chunk) => {
    if (stage === "relay") {
      if (!open || !ws) return; // paused until open, so this cannot normally happen
      ws.send(chunk, () => {
        if (client.isPaused()) client.resume();
      });
      if (ws.bufferedAmount > HIGH_WATER) client.pause();
      return;
    }

    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    if (stage === "greeting") {
      if (buf.length < 2) return;
      if (buf[0] !== 5) return closeBoth();
      const methods = buf[1];
      if (buf.length < 2 + methods) return;
      buf = buf.subarray(2 + methods);
      client.write(Buffer.from([5, 0])); // no authentication: the listener is loopback only
      stage = "request";
    }

    if (stage === "request") {
      if (buf.length < 5) return;
      if (buf[0] !== 5) return closeBoth();
      if (buf[1] !== 1) return refuse(7); // CONNECT only: no BIND, no UDP associate

      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : atyp === 4 ? 16 : 0;
      if (!addrLen) return refuse(8);
      const total = 4 + addrLen + 2;
      if (buf.length < total) return;

      const target: Target = {
        type: atyp === 1 ? 1 : atyp === 3 ? 2 : 3,
        addr: Buffer.from(buf.subarray(4, 4 + addrLen)),
        port: buf.readUInt16BE(4 + addrLen),
      };
      const leftover = Buffer.from(buf.subarray(total));
      buf = Buffer.alloc(0);
      stage = "relay";
      client.pause();
      connect(target, leftover);
    }
  });

  const connect = (target: Target, leftover: Buffer) => {
    const tls = node.security === "tls";
    const host = node.address.includes(":") ? `[${node.address}]` : node.address;
    const url = `${tls ? "wss" : "ws"}://${host}:${node.port}${node.path ?? "/"}`;

    // `servername` reaches tls.connect through ws, but is not on its published options
    const options = {
      headers: { Host: node.hostHeader ?? node.address },
      servername: tls ? (node.sni ?? node.hostHeader ?? node.address) : undefined,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
    } as ClientOptions;

    try {
      ws = new WebSocket(url, options);
    } catch {
      refuse(1);
      return;
    }

    ws.on("open", () => {
      open = true;
      ws!.send(vlessRequest(node.id, target));
      if (leftover.length) ws!.send(leftover);
      client.write(SOCKS_OK);
      client.resume();
    });

    ws.on("message", (data: RawData) => {
      let payload: Buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      // The Worker answers with its own short header once, ahead of the first byte of
      // the destination's reply: version, addon length, addons.
      if (!headerRead) {
        responseHeader = responseHeader.length ? Buffer.concat([responseHeader, payload]) : payload;
        if (responseHeader.length < 2) return;
        const skip = 2 + responseHeader[1];
        if (responseHeader.length < skip) return;
        payload = responseHeader.subarray(skip);
        responseHeader = Buffer.alloc(0);
        headerRead = true;
        if (!payload.length) return;
      }
      if (!client.write(payload)) {
        ws!.pause();
        client.once("drain", () => ws?.resume());
      }
    });

    ws.on("close", () => {
      if (!client.destroyed) client.end();
    });

    ws.on("error", (err) => {
      if (!open) {
        console.warn(`[vless] "${node.name}" would not connect: ${err.message}`);
        refuse(1);
        return;
      }
      closeBoth();
    });
  };
}

/**
 * The VLESS request header: version, uuid, no addons, TCP, port, address. The address
 * is passed through as the SOCKS client gave it, so a hostname is resolved at the exit
 * rather than here.
 */
export function vlessRequest(uuid: string, target: Target): Buffer {
  const id = Buffer.from(uuid.replace(/-/g, ""), "hex");
  const head = Buffer.alloc(21);
  head[0] = 0; // version
  id.copy(head, 1);
  head[17] = 0; // addon length
  head[18] = 1; // TCP
  head.writeUInt16BE(target.port, 19);
  return Buffer.concat([head, Buffer.from([target.type]), target.addr]);
}
