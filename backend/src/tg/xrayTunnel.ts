import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { xrayPath, xrayRoot } from "../jobs/xrayInstall";
import type { ProxyNode } from "./proxyNodes";

/**
 * The Xray core, run as one child process carrying every node that needs it.
 *
 * One SOCKS5 inbound per node on loopback, one outbound per node, and a routing rule
 * joining the two -- so a node reaches the rest of Bemby as socks5://127.0.0.1:<port>,
 * exactly as the WebSocket bridge's exits do. Nothing downstream learns a new protocol.
 *
 * One process rather than one per node: 127 nodes is an ordinary subscription, and Xray
 * carries them all in a few MB of RSS. The cost is that a changed list restarts the core,
 * which drops connections in flight -- so the config is hashed and only a real change
 * restarts anything.
 */

export type XrayNode = { port: number; node: ProxyNode };

/** Lines kept from the core's own output, for the panel when a node will not connect. */
const LOG_LINES = 60;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Uptime after which a run counts as healthy and the backoff starts over. */
const STABLE_MS = 60_000;

let child: ChildProcess | undefined;
let wanted: XrayNode[] = [];
let configHash = "";
let restarts = 0;
let restartTimer: NodeJS.Timeout | undefined;
let startedAt = 0;
const log: string[] = [];

function note(line: string): void {
  log.push(line);
  if (log.length > LOG_LINES) log.shift();
}

export function xrayTunnelLog(): string[] {
  return [...log];
}

export function xrayRunning(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

function configPath(): string {
  return path.join(xrayRoot(), "config.json");
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * The config for a set of nodes. Exported for the tests, which is also the readable place
 * to see what each link's parameters turn into.
 */
export function buildXrayConfig(nodes: XrayNode[]): Record<string, unknown> {
  return {
    // access: "none" keeps a per-connection line out of the ring buffer, which is there to
    // show why a node will not connect, not what went through it
    log: { access: "none", loglevel: "warning" },
    inbounds: nodes.map(({ port }) => ({
      tag: inboundTag(port),
      listen: "127.0.0.1",
      port,
      protocol: "socks",
      // No sniffing: a destination hostname is passed through to the node and resolved
      // there, which is the socks5h behaviour the rest of Bemby relies on
      settings: { auth: "noauth", udp: true, ip: "127.0.0.1" },
    })),
    outbounds: nodes.map(({ port, node }) => outboundFor(port, node)),
    routing: {
      domainStrategy: "AsIs",
      rules: nodes.map(({ port }) => ({
        type: "field",
        inboundTag: [inboundTag(port)],
        outboundTag: outboundTag(port),
      })),
    },
  };
}

const inboundTag = (port: number): string => `in-${port}`;
const outboundTag = (port: number): string => `out-${port}`;

function outboundFor(port: number, node: ProxyNode): Record<string, unknown> {
  return {
    tag: outboundTag(port),
    protocol: node.protocol,
    settings: settingsFor(node),
    streamSettings: streamFor(node),
  };
}

function settingsFor(node: ProxyNode): Record<string, unknown> {
  const { address, port } = node;
  switch (node.protocol) {
    case "vless":
      return {
        vnext: [
          {
            address,
            port,
            users: [{ id: node.id, encryption: "none", ...(node.flow ? { flow: node.flow } : {}) }],
          },
        ],
      };
    case "vmess":
      return {
        vnext: [
          { address, port, users: [{ id: node.id, alterId: node.alterId ?? 0, security: "auto" }] },
        ],
      };
    case "trojan":
      return { servers: [{ address, port, password: node.id }] };
    case "shadowsocks":
      return { servers: [{ address, port, method: node.method, password: node.id }] };
  }
}

function streamFor(node: ProxyNode): Record<string, unknown> {
  const stream: Record<string, unknown> = {
    network: node.transport,
    security: node.security,
  };

  const host = node.hostHeader;
  switch (node.transport) {
    case "ws":
      stream.wsSettings = { path: node.path ?? "/", ...(host ? { headers: { Host: host } } : {}) };
      break;
    case "httpupgrade":
      stream.httpupgradeSettings = { path: node.path ?? "/", ...(host ? { host } : {}) };
      break;
    case "xhttp":
      stream.xhttpSettings = { path: node.path ?? "/", ...(host ? { host } : {}) };
      break;
    case "grpc":
      stream.grpcSettings = { serviceName: node.serviceName ?? "" };
      break;
    case "tcp":
      break;
  }

  const servername = node.sni ?? host;
  if (node.security === "tls") {
    stream.tlsSettings = {
      ...(servername ? { serverName: servername } : {}),
      ...(node.alpn?.length ? { alpn: node.alpn } : {}),
      ...(node.fingerprint ? { fingerprint: node.fingerprint } : {}),
      ...(node.allowInsecure ? { allowInsecure: true } : {}),
    };
  } else if (node.security === "reality") {
    stream.realitySettings = {
      ...(servername ? { serverName: servername } : {}),
      publicKey: node.publicKey ?? "",
      shortId: node.shortId ?? "",
      // REALITY is a browser's ClientHello or it is nothing; chrome is what a panel that
      // states no fingerprint assumes
      fingerprint: node.fingerprint || "chrome",
    };
  }

  return stream;
}

// ── Process ───────────────────────────────────────────────────────────────────

/**
 * Points the core at exactly these nodes. Starts it, restarts it on a changed list, and
 * stops it when nothing is left for it to carry.
 */
export function applyXrayNodes(nodes: XrayNode[]): void {
  wanted = [...nodes].sort((a, b) => a.port - b.port);

  if (!wanted.length) {
    stopXray();
    return;
  }

  const bin = xrayPath();
  if (!bin) {
    if (xrayRunning()) stopXray();
    return;
  }

  const config = JSON.stringify(buildXrayConfig(wanted), null, 2);
  const hash = createHash("sha1").update(config).update(bin).digest("hex");
  if (hash === configHash && xrayRunning()) return;
  configHash = hash;

  mkdirSync(xrayRoot(), { recursive: true });
  writeFileSync(configPath(), config);

  restarts = 0;
  restart(bin);
}

function restart(bin: string): void {
  killChild();
  spawnCore(bin);
}

function spawnCore(bin: string): void {
  startedAt = Date.now();
  const proc = spawn(bin, ["run", "-c", configPath()], {
    stdio: ["ignore", "pipe", "pipe"],
    // The core loads geodata only for a rule that names it, and none here does; the
    // variable is still set so a lookup never wanders into the process's cwd
    env: { ...process.env, XRAY_LOCATION_ASSET: xrayRoot() },
  });
  child = proc;

  const feed = (buf: Buffer): void => {
    for (const line of buf.toString().split("\n")) if (line.trim()) note(line.trim());
  };
  proc.stdout?.on("data", feed);
  proc.stderr?.on("data", feed);

  proc.once("error", (err) => {
    note(`could not start the core: ${err.message}`);
    if (child === proc) child = undefined;
  });

  proc.once("exit", (code, signal) => {
    if (child !== proc) return; // replaced by a newer run, which owns the restart
    child = undefined;
    if (!wanted.length) return;

    // A run that stayed up is not evidence of a broken config, so its successor starts
    // from the shortest delay rather than the one the last crash had reached
    if (Date.now() - startedAt > STABLE_MS) restarts = 0;
    const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
    restarts++;
    note(`the core exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s`);
    console.warn(
      `[xray] the core exited (${signal ?? `code ${code}`}) with ${wanted.length} node(s) configured; restarting in ${delay / 1000}s`,
    );

    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      const found = xrayPath();
      if (wanted.length && found && !child) spawnCore(found);
    }, delay);
    restartTimer.unref();
  });
}

function killChild(): void {
  clearTimeout(restartTimer);
  restartTimer = undefined;
  const proc = child;
  child = undefined;
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  // A core that ignores the term is not worth waiting on: its ports have to be free before
  // the next run binds them
  const timer = setTimeout(() => proc.kill("SIGKILL"), 3_000);
  timer.unref();
  proc.once("exit", () => clearTimeout(timer));
}

export function stopXray(): void {
  killChild();
  configHash = "";
}
