import net from "net";
import crypto from "crypto";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { db } from "../db/database";

// VLESS-over-WebSocket exits (edgetunnel and friends running on Cloudflare Workers),
// presented to the rest of Bemby as ordinary SOCKS5 proxies on loopback.
//
// Nothing downstream learns a new protocol: a node becomes socks5://127.0.0.1:<port>,
// which Telegram accepts (see parseTgProxy) and the browser bridges as it already does.
// Each node keeps its port across restarts, because the port is stored beside the node
// and the proxy list holds the resulting URL.
//
// Worth knowing before reaching for these: every node on one Worker leaves from
// Cloudflare's own address space, so a subscription is one exit identity rather than a
// pool. Imported entries are therefore kept out of automatic draws (see `autoPool`).

export type VlessNode = {
  /** Host or IP the WebSocket dials: a Cloudflare edge address. */
  address: string;
  port: number;
  uuid: string;
  tls: boolean;
  /** TLS servername, when the dialled address is an IP or a different front-end. */
  sni?: string;
  /** Host header, when it differs from the dialled address. */
  hostHeader?: string;
  path: string;
  name: string;
};

/** A node with the loopback port it answers on, as stored between restarts. */
export type VlessEntry = {
  proxyId: string;
  providerId: string;
  port: number;
  node: VlessNode;
};

const STORE_KEY = "vless_nodes";
const PORT_BASE = Number(process.env.VLESS_PORT_BASE) || 24080;
const PORT_LIMIT = 512;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Bytes queued towards the Worker before the local side is held back. */
const HIGH_WATER = 1 << 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Link parsing ──────────────────────────────────────────────────────────────

/**
 * Reads one `vless://uuid@host:port?...#name` link. Only the WebSocket transport with
 * no encryption is handled, which is what a Workers deployment hands out; anything else
 * (tcp, grpc, reality) returns undefined so the caller can report it as unsupported.
 */
export function parseVlessLink(link: string): VlessNode | undefined {
  const raw = link.trim();
  if (!/^vless:\/\//i.test(raw)) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  const uuid = decodeURIComponent(url.username);
  if (!UUID_RE.test(uuid)) return undefined;

  const params = url.searchParams;
  if ((params.get("type") ?? "ws").toLowerCase() !== "ws") return undefined;
  if ((params.get("encryption") ?? "none").toLowerCase() !== "none") return undefined;

  const security = (params.get("security") ?? "").toLowerCase();
  const tls = security === "tls";
  if (security && !tls) return undefined; // reality and friends need a handshake we do not speak

  const address = url.hostname.replace(/^\[|\]$/g, "");
  if (!address) return undefined;
  const port = Number(url.port) || (tls ? 443 : 80);

  const hostHeader = params.get("host")?.trim() || undefined;
  const sni = params.get("sni")?.trim() || undefined;
  const path = params.get("path")?.trim() || "/";

  return {
    address,
    port,
    uuid: uuid.toLowerCase(),
    tls,
    sni: tls ? (sni ?? hostHeader) : undefined,
    hostHeader,
    path: path.startsWith("/") ? path : `/${path}`,
    name: decodeURIComponent(url.hash.slice(1)) || `${address}:${port}`,
  };
}

/** True for a body that is base64 rather than plain links, as most subscriptions are. */
function decodeIfBase64(body: string): string {
  if (/vless:\/\//i.test(body)) return body;
  const packed = body.replace(/\s+/g, "");
  if (!packed || !/^[A-Za-z0-9+/=_-]+$/.test(packed)) return body;
  try {
    const decoded = Buffer.from(packed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return /vless:\/\//i.test(decoded) ? decoded : body;
  } catch {
    return body;
  }
}

export type SubscriptionParse = {
  nodes: VlessNode[];
  /** Links that were understood as node links but not ones we can carry. */
  skipped: number;
};

/**
 * Reads a subscription body: base64 or plain, one link per line. Duplicates collapse,
 * and links of other protocols are counted rather than reported one by one.
 */
export function parseVlessSubscription(body: string): SubscriptionParse {
  const nodes: VlessNode[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const line of decodeIfBase64(body).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;

    const node = parseVlessLink(raw);
    if (!node) {
      skipped++;
      continue;
    }
    const key = nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }

  return { nodes, skipped };
}

/** Stable identity for a node, so its id and port survive a re-fetch. */
export function nodeKey(node: VlessNode): string {
  const shape = [node.address, node.port, node.uuid, node.tls, node.sni, node.hostHeader, node.path]
    .map((v) => v ?? "")
    .join("|");
  return crypto.createHash("sha1").update(shape).digest("hex").slice(0, 12);
}


// ── Stored nodes ──────────────────────────────────────────────────────────────

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;
}

export function readVlessEntries(): VlessEntry[] {
  try {
    const parsed = JSON.parse(readSetting(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as VlessEntry[]) : [];
  } catch {
    return [];
  }
}

function writeVlessEntries(entries: VlessEntry[]): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    STORE_KEY,
    JSON.stringify(entries),
  );
}

/**
 * Replaces one provider's nodes, keeping the loopback port each already had so stored
 * proxy URLs stay pointed at the same node, and starts or stops listeners to match.
 * Ports come from a fixed range; a subscription larger than that range is cut short
 * rather than wandering into ports something else may want.
 */
export function applyVlessNodes(
  providerId: string,
  nodes: Array<{ proxyId: string; node: VlessNode }>,
): VlessEntry[] {
  const existing = readVlessEntries();
  const kept = existing.filter((e) => e.providerId !== providerId);
  const previousPort = new Map(
    existing.filter((e) => e.providerId === providerId).map((e) => [e.proxyId, e.port]),
  );
  const taken = new Set(kept.map((e) => e.port));

  // Ports a node already had are reserved before any new node is given one. Without that
  // pass, a node added at the top of the subscription takes the port of one further down,
  // and every account or job pinned to the moved node quietly points at a different exit.
  const reused = new Map<string, number>();
  for (const { proxyId } of nodes) {
    const previous = previousPort.get(proxyId);
    if (!previous || taken.has(previous)) continue;
    taken.add(previous);
    reused.set(proxyId, previous);
  }

  const mine: VlessEntry[] = [];
  for (const { proxyId, node } of nodes) {
    let port = reused.get(proxyId) ?? 0;
    if (!port) {
      for (let candidate = PORT_BASE; candidate < PORT_BASE + PORT_LIMIT; candidate++) {
        if (!taken.has(candidate)) {
          port = candidate;
          break;
        }
      }
    }
    if (!port) {
      console.warn(`[vless] no loopback port left for "${node.name}"; skipping the rest`);
      break;
    }
    taken.add(port);
    mine.push({ proxyId, providerId, port, node });
  }

  writeVlessEntries([...kept, ...mine]);
  reconcileListeners();
  return mine;
}

/** Drops the nodes of providers that no longer exist, and their listeners with them. */
export function pruneVlessProviders(liveProviderIds: Iterable<string>): void {
  const live = new Set(liveProviderIds);
  const entries = readVlessEntries();
  const kept = entries.filter((e) => live.has(e.providerId));
  if (kept.length === entries.length) return;
  writeVlessEntries(kept);
  reconcileListeners();
}

// ── Listeners ─────────────────────────────────────────────────────────────────

type Running = { server: net.Server; fingerprint: string; sockets: Set<net.Socket> };

const running = new Map<number, Running>();

/** True for a proxy URL that is one of our loopback listeners. */
export function isVlessListener(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1") return false;
    return running.has(Number(parsed.port));
  } catch {
    return false;
  }
}

/** Starts a listener for every stored node, and stops any that no longer belongs. */
export function reconcileListeners(): void {
  const wanted = new Map(readVlessEntries().map((e) => [e.port, e]));

  for (const [port, live] of running) {
    const entry = wanted.get(port);
    if (entry && nodeKey(entry.node) === live.fingerprint) continue;
    stopListener(port);
  }

  for (const [port, entry] of wanted) {
    if (running.has(port)) continue;
    startListener(entry);
  }
}

/** Brings the stored nodes up at boot, before any job goes looking for its proxy. */
export function startVlessTunnels(): void {
  const entries = readVlessEntries();
  if (!entries.length) return;
  reconcileListeners();
  console.log(`[vless] ${entries.length} tunnel exit(s) on 127.0.0.1:${PORT_BASE}+`);
}

export function stopVlessTunnels(): void {
  for (const port of [...running.keys()]) stopListener(port);
}

function stopListener(port: number): void {
  const live = running.get(port);
  if (!live) return;
  running.delete(port);
  for (const socket of live.sockets) socket.destroy();
  live.server.close();
}

function startListener(entry: VlessEntry): void {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    serveSocks(client, entry.node);
  });

  // Registered before it is bound, so a second reconcile in the same tick does not start
  // a duplicate on the port this one is still opening
  const live: Running = { server, fingerprint: nodeKey(entry.node), sockets };
  running.set(entry.port, live);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (running.get(entry.port) === live) running.delete(entry.port);
    console.error(
      err.code === "EADDRINUSE"
        ? `[vless] port ${entry.port} is taken, so "${entry.node.name}" has no exit`
        : `[vless] listener for "${entry.node.name}" failed: ${err.message}`,
    );
  });

  server.listen(entry.port, "127.0.0.1");
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
function serveSocks(client: net.Socket, node: VlessNode): void {
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
    const host = node.address.includes(":") ? `[${node.address}]` : node.address;
    const url = `${node.tls ? "wss" : "ws"}://${host}:${node.port}${node.path}`;

    // `servername` reaches tls.connect through ws, but is not on its published options
    const options = {
      headers: { Host: node.hostHeader ?? node.address },
      servername: node.tls ? (node.sni ?? node.hostHeader ?? node.address) : undefined,
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
      ws!.send(vlessRequest(node.uuid, target));
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
