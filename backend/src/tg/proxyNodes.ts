import crypto from "node:crypto";

// One shape for a node however a subscription spells it.
//
// Subscriptions come in two flavours. A Cloudflare Workers deployment (edgetunnel and
// friends) serves VLESS over WebSocket, which Bemby carries itself (see vlessTunnel).
// A commercial seller -- an "airport" -- serves whatever its panel was configured with:
// VLESS over raw TCP behind REALITY, VMess, Trojan, Shadowsocks. Those need a real proxy
// core, so they are handed to Xray (see xrayTunnel).
//
// Parsing is deliberately separate from carrying: a link is read into a `ProxyNode`
// whether or not this install can currently carry it, so the panel can say "these need
// the core" rather than silently dropping the whole subscription.

export type NodeProtocol = "vless" | "vmess" | "trojan" | "shadowsocks";
export type NodeTransport = "tcp" | "ws" | "grpc" | "httpupgrade" | "xhttp";
export type NodeSecurity = "none" | "tls" | "reality";

export type ProxyNode = {
  protocol: NodeProtocol;
  address: string;
  port: number;
  name: string;
  /** VLESS/VMess account id, or the password for Trojan and Shadowsocks. */
  id: string;
  /** Shadowsocks cipher. */
  method?: string;
  /** VMess alterId; 0 on anything made this decade. */
  alterId?: number;
  transport: NodeTransport;
  /** Path for ws, httpupgrade and xhttp. */
  path?: string;
  /** Host header, when it differs from the dialled address. */
  hostHeader?: string;
  /** gRPC service name. */
  serviceName?: string;
  security: NodeSecurity;
  /** TLS servername, when the dialled address is an IP or a different front-end. */
  sni?: string;
  alpn?: string[];
  /** uTLS fingerprint to imitate: chrome, firefox, safari, randomized. */
  fingerprint?: string;
  allowInsecure?: boolean;
  /** REALITY server public key. */
  publicKey?: string;
  /** REALITY short id. */
  shortId?: string;
  /** VLESS flow, in practice xtls-rprx-vision or nothing. */
  flow?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRANSPORTS: Record<string, NodeTransport> = {
  tcp: "tcp",
  raw: "tcp", // what Xray renamed tcp to
  ws: "ws",
  websocket: "ws",
  grpc: "grpc",
  httpupgrade: "httpupgrade",
  xhttp: "xhttp",
  splithttp: "xhttp", // xhttp's former name
};

/**
 * Reads one node link. Returns undefined for a link this cannot represent -- a protocol
 * Xray does not speak (hysteria2, tuic, ssr), or one carried by a plugin.
 */
export function parseNodeLink(link: string): ProxyNode | undefined {
  const raw = link.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  switch (scheme) {
    case "vless":
      return parseVless(raw);
    case "vmess":
      return parseVmess(raw);
    case "trojan":
      return parseTrojan(raw);
    case "ss":
      return parseShadowsocks(raw);
    default:
      return undefined;
  }
}

/** `vless://uuid@host:port?type=..&security=..#name` */
function parseVless(raw: string): ProxyNode | undefined {
  const url = asUrl(raw);
  if (!url) return undefined;

  const id = decodeURIComponent(url.username);
  if (!UUID_RE.test(id)) return undefined;

  const params = url.searchParams;
  if ((params.get("encryption") ?? "none").toLowerCase() !== "none") return undefined;

  // The URI spec's default is tcp, but Bemby read these links as WebSocket long before it
  // could carry anything else. Keeping that default means a Workers subscription that
  // omits `type` still resolves to the same node, on the same loopback port, after upgrade.
  const transport = readTransport(params.get("type"), "ws");
  const security = readSecurity(params.get("security"));
  if (!transport || !security) return undefined;

  const address = hostOf(url);
  if (!address) return undefined;

  const hostHeader = trimmed(params.get("host"));
  const sni = trimmed(params.get("sni"));

  return {
    protocol: "vless",
    address,
    port: Number(url.port) || (security === "none" ? 80 : 443),
    id: id.toLowerCase(),
    name: nameOf(url, address),
    transport,
    ...transportFields(transport, params),
    security,
    sni: security === "none" ? undefined : (sni ?? hostHeader),
    ...tlsFields(params),
    flow: trimmed(params.get("flow")),
  };
}

/** `vmess://<base64 json>`, the v2rayN format every panel emits. */
function parseVmess(raw: string): ProxyNode | undefined {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fromBase64(raw.slice("vmess://".length)));
  } catch {
    return undefined;
  }
  if (!config || typeof config !== "object") return undefined;

  const str = (key: string): string | undefined => {
    const v = config[key];
    return typeof v === "string" ? v.trim() || undefined : typeof v === "number" ? String(v) : undefined;
  };

  const id = str("id");
  const address = str("add");
  const port = Number(str("port"));
  if (!id || !UUID_RE.test(id) || !address || !port) return undefined;

  const transport = readTransport(str("net"), "tcp");
  if (!transport) return undefined;
  // "tls" carries the security, and vmess links have no REALITY variant
  const security: NodeSecurity = (str("tls") ?? "").toLowerCase() === "tls" ? "tls" : "none";
  const hostHeader = str("host");
  const alpn = str("alpn");

  return {
    protocol: "vmess",
    address,
    port,
    id: id.toLowerCase(),
    alterId: Number(str("aid")) || 0,
    name: str("ps") || `${address}:${port}`,
    transport,
    path: transport === "grpc" ? undefined : str("path") ?? "/",
    serviceName: transport === "grpc" ? str("path") : undefined,
    hostHeader,
    security,
    sni: security === "tls" ? str("sni") ?? hostHeader : undefined,
    alpn: alpn ? alpn.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
    fingerprint: str("fp"),
  };
}

/** `trojan://password@host:port?security=tls&type=..#name` */
function parseTrojan(raw: string): ProxyNode | undefined {
  const url = asUrl(raw);
  if (!url) return undefined;

  const password = decodeURIComponent(url.username);
  const address = hostOf(url);
  if (!password || !address) return undefined;

  const params = url.searchParams;
  const transport = readTransport(params.get("type"), "tcp");
  // Trojan is TLS by definition, so a link that says nothing still means tls
  const security = readSecurity(params.get("security") ?? "tls");
  if (!transport || !security || security === "reality") return undefined;

  const hostHeader = trimmed(params.get("host"));

  return {
    protocol: "trojan",
    address,
    port: Number(url.port) || 443,
    id: password,
    name: nameOf(url, address),
    transport,
    ...transportFields(transport, params),
    security,
    sni: trimmed(params.get("sni")) ?? trimmed(params.get("peer")) ?? hostHeader,
    ...tlsFields(params),
  };
}

/**
 * `ss://<base64 method:password>@host:port#name` (SIP002), or the older form with the
 * whole `method:password@host:port` base64'd. A link carrying a plugin is turned down:
 * the plugin is a separate program Bemby does not have.
 */
function parseShadowsocks(raw: string): ProxyNode | undefined {
  const [body, hash] = splitOnce(raw.slice("ss://".length), "#");
  const name = hash ? safeDecode(hash) : undefined;
  const [beforeQuery, query] = splitOnce(body, "?");
  if (query && new URLSearchParams(query).get("plugin")) return undefined;

  let userinfo: string;
  let hostPart: string;
  if (beforeQuery.includes("@")) {
    const at = beforeQuery.lastIndexOf("@");
    userinfo = fromBase64(safeDecode(beforeQuery.slice(0, at)));
    hostPart = beforeQuery.slice(at + 1);
  } else {
    // Legacy: everything after the scheme is one base64 blob
    const decoded = fromBase64(beforeQuery);
    const at = decoded.lastIndexOf("@");
    if (at < 0) return undefined;
    userinfo = decoded.slice(0, at);
    hostPart = decoded.slice(at + 1);
  }

  const [method, password] = splitOnce(userinfo, ":");
  if (!method || !password) return undefined;

  const url = asUrl(`ss://placeholder@${hostPart}`);
  const address = url ? hostOf(url) : undefined;
  const port = Number(url?.port);
  if (!address || !port) return undefined;

  return {
    protocol: "shadowsocks",
    address,
    port,
    id: password,
    method,
    name: name || `${address}:${port}`,
    transport: "tcp",
    security: "none",
  };
}

// ── Shared link reading ───────────────────────────────────────────────────────

function asUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function hostOf(url: URL): string | undefined {
  return url.hostname.replace(/^\[|\]$/g, "") || undefined;
}

function nameOf(url: URL, address: string): string {
  return safeDecode(url.hash.slice(1)) || `${address}:${url.port || ""}`;
}

function trimmed(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const at = value.indexOf(sep);
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readTransport(value: string | null | undefined, fallback: NodeTransport): NodeTransport | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return fallback;
  return TRANSPORTS[key];
}

function readSecurity(value: string | null | undefined): NodeSecurity | undefined {
  const key = value?.trim().toLowerCase();
  if (!key || key === "none") return "none";
  if (key === "tls" || key === "reality") return key;
  return undefined; // xtls and whatever else a panel invents
}

/** Path, host header and service name, wherever this transport keeps them. */
function transportFields(
  transport: NodeTransport,
  params: URLSearchParams,
): Pick<ProxyNode, "path" | "hostHeader" | "serviceName"> {
  const path = trimmed(params.get("path")) ?? "/";
  return {
    path: transport === "tcp" || transport === "grpc" ? undefined : path.startsWith("/") ? path : `/${path}`,
    hostHeader: trimmed(params.get("host")),
    serviceName: transport === "grpc" ? trimmed(params.get("serviceName")) : undefined,
  };
}

function tlsFields(params: URLSearchParams): Pick<ProxyNode, "alpn" | "fingerprint" | "allowInsecure" | "publicKey" | "shortId"> {
  const alpn = trimmed(params.get("alpn"));
  return {
    alpn: alpn ? alpn.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
    fingerprint: trimmed(params.get("fp")),
    allowInsecure: params.get("allowInsecure") === "1" || params.get("insecure") === "1" ? true : undefined,
    publicKey: trimmed(params.get("pbk")),
    shortId: trimmed(params.get("sid")),
  };
}

function fromBase64(value: string): string {
  const packed = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(packed, "base64").toString("utf8");
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export type SubscriptionParse = {
  nodes: ProxyNode[];
  /** Links that looked like nodes but could not be represented, counted by scheme. */
  skipped: number;
};

const LINK_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** True for a body that is base64 rather than plain links, as most subscriptions are. */
function decodeIfBase64(body: string): string {
  if (LINK_RE.test(body.trim())) return body;
  const packed = body.replace(/\s+/g, "");
  if (!packed || !/^[A-Za-z0-9+/=_-]+$/.test(packed)) return body;
  try {
    const decoded = fromBase64(packed);
    return LINK_RE.test(decoded.trim()) ? decoded : body;
  } catch {
    return body;
  }
}

/**
 * Reads a subscription body: base64 or plain, one link per line. Duplicates collapse, and
 * links of protocols no core here speaks are counted rather than reported one by one.
 */
export function parseSubscription(body: string): SubscriptionParse {
  const nodes: ProxyNode[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const line of decodeIfBase64(body).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || !LINK_RE.test(raw)) continue;

    const node = parseNodeLink(raw);
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

/**
 * Stable identity for a node, so its id and loopback port survive a re-fetch.
 *
 * A VLESS-over-WebSocket node hashes exactly the fields it did before other protocols
 * existed here, which is what keeps an install's imported ids -- and the jobs pinned to
 * them -- unchanged across the upgrade that added the rest.
 */
export function nodeKey(node: ProxyNode): string {
  const legacy = node.protocol === "vless" && node.transport === "ws" && node.security !== "reality";
  const shape = legacy
    ? [node.address, node.port, node.id, node.security === "tls", node.sni, node.hostHeader, node.path]
    : [
        node.protocol,
        node.address,
        node.port,
        node.id,
        node.method,
        node.transport,
        node.path,
        node.hostHeader,
        node.serviceName,
        node.security,
        node.sni,
        node.publicKey,
        node.shortId,
        node.flow,
      ];
  return crypto.createHash("sha1").update(shape.map((v) => v ?? "").join("|")).digest("hex").slice(0, 12);
}

/**
 * True for the VLESS-over-WebSocket shape a Cloudflare Workers deployment serves.
 *
 * Two things turn on it. It is what Bemby's own bridge can carry without the Xray core
 * (see vlessTunnel), and it is what leaves from Cloudflare's own address space -- so such
 * a node is one exit identity however many the subscription lists, is kept out of
 * automatic draws, and cannot be tested against a Cloudflare address.
 */
export function isWorkerNode(node: ProxyNode): boolean {
  return node.protocol === "vless" && node.transport === "ws" && node.security !== "reality";
}

/** A one-line description of the node's shape, for logs and the panel's skipped counts. */
export function nodeKind(node: ProxyNode): string {
  const parts = [node.protocol.toUpperCase(), node.transport];
  if (node.security !== "none") parts.push(node.security);
  return parts.join("-");
}
