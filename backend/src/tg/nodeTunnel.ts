import { db } from "../db/database";
import { isXrayInstalled } from "../jobs/xrayInstall";
import { isWorkerNode, nodeKey, type ProxyNode } from "./proxyNodes";
import { stopAllWsExits, syncWsExits } from "./vlessTunnel";
import { applyXrayNodes, stopXray, xrayRunning } from "./xrayTunnel";

/**
 * Subscription nodes, and which carrier each one gets.
 *
 * A node becomes socks5://127.0.0.1:<port> whatever carries it, and the port is stored
 * beside the node so it survives a restart and a re-sync -- that port is in the proxy list
 * and is what a job pins to.
 *
 * Two carriers, and the choice is made here rather than per node:
 *   - the Xray core, when it is installed, takes everything. It is the reference
 *     implementation of every protocol a subscription serves, REALITY included.
 *   - otherwise the built-in WebSocket bridge takes the nodes it can (see vlessTunnel),
 *     and the rest sit stored but unstarted until the core is installed.
 *
 * Storing a node the core would be needed for, rather than dropping it, is deliberate:
 * installing the core then brings the whole subscription up without anyone re-syncing.
 */

const STORE_KEY = "vless_nodes";
const PORT_BASE = Number(process.env.VLESS_PORT_BASE) || 24080;
const PORT_LIMIT = 512;

/** A node with the loopback port it answers on, as stored between restarts. */
export type TunnelEntry = {
  proxyId: string;
  providerId: string;
  port: number;
  node: ProxyNode;
};

export type Carrier = "ws" | "xray";

/** What would carry this node on this install, or undefined while nothing can. */
export function carrierFor(node: ProxyNode): Carrier | undefined {
  if (isXrayInstalled()) return "xray";
  return isWorkerNode(node) ? "ws" : undefined;
}

/** How many of these nodes are waiting on a core that is not installed. */
export function nodesNeedingCore(nodes: ProxyNode[]): number {
  return isXrayInstalled() ? 0 : nodes.filter((n) => !isWorkerNode(n)).length;
}

// ── Stored nodes ──────────────────────────────────────────────────────────────

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;
}

/**
 * A stored node in today's shape.
 *
 * Entries written before other protocols existed here hold a bare VLESS-over-WebSocket
 * node -- `uuid` and `tls` rather than `id` and `security`. They are read into the current
 * shape on the way past, which keeps their key, their port and the proxy ids pinned to
 * them unchanged.
 */
function normaliseNode(raw: any): ProxyNode | undefined {
  if (!raw || typeof raw !== "object" || !raw.address) return undefined;
  if (typeof raw.protocol === "string") return raw as ProxyNode;
  if (typeof raw.uuid !== "string") return undefined;
  return {
    protocol: "vless",
    address: raw.address,
    port: Number(raw.port),
    id: raw.uuid,
    name: raw.name ?? raw.address,
    transport: "ws",
    path: raw.path ?? "/",
    hostHeader: raw.hostHeader,
    security: raw.tls ? "tls" : "none",
    sni: raw.sni,
  };
}

/**
 * Parsed entries, keyed on the stored text they came from.
 *
 * A health test asks which node is behind each proxy, once per proxy, so without this a
 * round of tests parses the whole node list as many times as there are exits.
 */
let parsedEntries: { raw: string; entries: TunnelEntry[] } | undefined;

export function readTunnelEntries(): TunnelEntry[] {
  const raw = readSetting(STORE_KEY) ?? "[]";
  if (parsedEntries?.raw === raw) return parsedEntries.entries;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: TunnelEntry[] = [];
  for (const row of parsed as any[]) {
    const node = normaliseNode(row?.node);
    if (!node || !row.proxyId || !row.port) continue;
    entries.push({ proxyId: row.proxyId, providerId: row.providerId, port: Number(row.port), node });
  }
  parsedEntries = { raw, entries };
  return entries;
}

function writeTunnelEntries(entries: TunnelEntry[]): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    STORE_KEY,
    JSON.stringify(entries),
  );
}

/**
 * Replaces one provider's nodes, keeping the loopback port each already had so stored
 * proxy URLs stay pointed at the same node, and starts or stops carriers to match.
 * Ports come from a fixed range; a subscription larger than that range is cut short
 * rather than wandering into ports something else may want.
 */
export function applyNodes(
  providerId: string,
  nodes: Array<{ proxyId: string; node: ProxyNode }>,
): TunnelEntry[] {
  const existing = readTunnelEntries();
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

  const mine: TunnelEntry[] = [];
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
      console.warn(`[tunnel] no loopback port left for "${node.name}"; skipping the rest`);
      break;
    }
    taken.add(port);
    mine.push({ proxyId, providerId, port, node });
  }

  writeTunnelEntries([...kept, ...mine]);
  reconcileTunnels();
  return mine;
}

/** Drops the nodes of providers that no longer exist, and their carriers with them. */
export function pruneTunnelProviders(liveProviderIds: Iterable<string>): void {
  const live = new Set(liveProviderIds);
  const entries = readTunnelEntries();
  const kept = entries.filter((e) => live.has(e.providerId));
  if (kept.length === entries.length) return;
  writeTunnelEntries(kept);
  reconcileTunnels();
}

// ── Carriers ──────────────────────────────────────────────────────────────────

/** The node behind a proxy URL, when that URL is one of our loopback exits. */
export function tunnelNodeFor(url: string | undefined): ProxyNode | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1") return undefined;
    const port = Number(parsed.port);
    return readTunnelEntries().find((e) => e.port === port)?.node;
  } catch {
    return undefined;
  }
}

/** Points each carrier at the nodes that are its to run, and stops what is no longer wanted. */
export function reconcileTunnels(): void {
  const entries = readTunnelEntries();

  if (isXrayInstalled()) {
    // The core takes the lot: leaving some nodes on the bridge would mean two carriers
    // competing for one port the moment a node's transport changed under it
    stopAllWsExits();
    applyXrayNodes(entries.map((e) => ({ port: e.port, node: e.node })));
    return;
  }

  stopXray();
  syncWsExits(
    entries
      .filter((e) => isWorkerNode(e.node))
      .map((e) => ({ port: e.port, node: e.node, key: nodeKey(e.node) })),
  );
}

/** Brings the stored nodes up at boot, before any job goes looking for its proxy. */
export function startTunnels(): void {
  const entries = readTunnelEntries();
  if (!entries.length) return;
  reconcileTunnels();

  const waiting = tunnelStatus().needsCore;
  console.log(
    `[tunnel] ${entries.length - waiting} exit(s) on 127.0.0.1:${PORT_BASE}+ via ${
      isXrayInstalled() ? "the Xray core" : "the WebSocket bridge"
    }`,
  );
  if (waiting) {
    console.warn(
      `[tunnel] ${waiting} node(s) need the Xray core, which is not installed; install it in Settings to bring them up`,
    );
  }
}

export function stopTunnels(): void {
  stopAllWsExits();
  stopXray();
}

/** What the panel shows: how many exits are up, and how many are waiting on the core. */
export function tunnelStatus(): { total: number; carried: number; needsCore: number; core: boolean } {
  const entries = readTunnelEntries();
  const needsCore = isXrayInstalled() ? 0 : entries.filter((e) => !isWorkerNode(e.node)).length;
  return {
    total: entries.length,
    carried: entries.length - needsCore,
    needsCore,
    core: xrayRunning(),
  };
}
