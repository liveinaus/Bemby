import { db } from "../db/database";
import { cfTuning } from "../jobs/cfTuning";
import { applyVlessNodes, nodeKey, parseVlessSubscription, pruneVlessProviders } from "./vlessTunnel";

// Proxy sellers hand out lists that change over time -- addresses get replaced, plans
// get resized. Rather than pasting each proxy into Settings by hand, a provider can be
// configured once and its current list pulled in on demand. This matters most for
// Cloudflare solving, where only some exit IPs are accepted, so a larger and current
// pool is what makes a working one findable.
//
// Three adapters cover the field without a provider-specific plugin for each vendor:
//   - `webshare`: the webshare.io API (token auth, paginated JSON)
//   - `list`: any URL returning a plain-text list, the format nearly every seller's
//     "download list" link produces (ip:port:user:pass and friends)
//   - `subscription`: a VLESS-over-WebSocket subscription, as a Cloudflare Workers
//     deployment such as edgetunnel serves. Each node is carried by a loopback SOCKS5
//     listener (see vlessTunnel), so it reaches the rest of Bemby as an ordinary proxy.

const TIMEOUT_MS = 20_000;
const WEBSHARE_API_URL = "https://proxy.webshare.io/api/v2/proxy/list/";
const WEBSHARE_PAGE_SIZE = 100;
const PAGE_LIMIT = 20; // backstop against a paginating loop
const MAX_LIST_BYTES = 2_000_000;

/** Prefix marking an imported proxy, so manually added entries are never touched. */
export const IMPORTED_ID_PREFIX = "pp:";

/**
 * Prefix used before proxies were grouped by provider. Syncing Webshare adopts these so
 * the entries are replaced rather than left behind as duplicates of themselves.
 */
const LEGACY_WEBSHARE_PREFIX = "ws:";

export type ProxyProviderType = "webshare" | "list" | "subscription";

export type ProxyProvider = {
  id: string;
  name: string;
  type: ProxyProviderType;
  /** Token for the provider's API, or a bearer token for a protected list URL. */
  apiKey?: string;
  /** Where to fetch from: a plain-text list (`list`) or a node subscription (`subscription`). */
  url?: string;
  /** Scheme to assume for list entries that don't state one. */
  scheme?: "http" | "socks5";
  enabled?: boolean;
};

/** A proxy entry as stored in the `proxies` setting. */
export type BembyProxy = {
  id: string;
  name: string;
  url: string;
  host?: string;
  /**
   * Whether an unnamed random draw and a Cloudflare fall-through may reach for this exit.
   * Absent means yes, which is every proxy that predates the flag. Tunnel exits set it
   * false: a subscription is one exit identity however many nodes it lists, so offering
   * them to a fall-through only spends attempts on the same address.
   */
  autoPool?: boolean;
};

export type ProviderSyncResult = {
  providerId: string;
  name: string;
  ok: boolean;
  fetched?: number;
  error?: string;
};

export type SyncResult = {
  providers: ProviderSyncResult[];
  added: number;
  updated: number;
  removed: number;
  total: number;
};

// ── Stored configuration ──────────────────────────────────────────────────────

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;
}

function writeSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function clearSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/**
 * Reads the configured providers, folding in the standalone Webshare token that earlier
 * versions stored on its own so an upgraded install keeps working.
 */
export function readProviders(): ProxyProvider[] {
  let providers: ProxyProvider[] = [];
  try {
    const parsed = JSON.parse(readSetting("proxy_providers") ?? "[]");
    if (Array.isArray(parsed)) providers = parsed as ProxyProvider[];
  } catch {
    providers = [];
  }

  // An id is what ties a provider to the proxies it imported, so two providers sharing one
  // would overwrite each other's entries -- and nothing at all could be saved, since a save
  // turns a repeated id down. Keeping the first of any repeat heals a list already stored
  // that way rather than leaving the panel unable to save its way out.
  const ids = new Set<string>();
  const unique = providers.filter((p) => {
    if (!p?.id || ids.has(p.id)) return false;
    ids.add(p.id);
    return true;
  });
  let changed = unique.length !== providers.length;
  providers = unique;

  // The Webshare token used to be stored on its own. Adopt it as a provider, then clear it:
  // left in place it is adopted again every time the provider it created is deleted or
  // changed to another type, and the second copy arrives with the same id as the first.
  const legacyKey = readSetting("webshare_api_key");
  if (legacyKey) {
    if (!providers.some((p) => p.type === "webshare")) {
      let id = "webshare";
      for (let n = 2; ids.has(id); n++) id = `webshare-${n}`;
      providers = [
        ...providers,
        { id, name: "Webshare", type: "webshare", apiKey: legacyKey, enabled: true },
      ];
    }
    clearSetting("webshare_api_key");
    changed = true;
  }

  if (changed) writeProviders(providers);
  return providers;
}

export function writeProviders(providers: ProxyProvider[]): void {
  writeSetting("proxy_providers", JSON.stringify(providers));
}

/** Providers with secrets replaced by a flag, for sending to the client. */
export function providersForClient(): Array<Omit<ProxyProvider, "apiKey"> & { hasKey: boolean }> {
  return readProviders().map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }));
}

/**
 * Saves an incoming provider list, carrying over any key the client left blank -- it
 * never receives the stored keys, so a blank one means "unchanged", not "cleared".
 *
 * A key is only carried over while the type stays put. A row pointed at something else
 * entirely wants nothing to do with the credential entered for what it used to be, and
 * since the panel cannot send a blank to clear one, this is what lets go of it.
 */
export function saveProviders(incoming: ProxyProvider[]): ProxyProvider[] {
  const existing = new Map(readProviders().map((p) => [p.id, p]));
  const merged = incoming.map((p) => {
    const previous = existing.get(p.id);
    const carried = previous?.type === p.type ? previous.apiKey : undefined;
    return { ...p, apiKey: p.apiKey?.trim() ? p.apiKey.trim() : carried };
  });
  writeProviders(merged);
  // A subscription that has been removed should not leave its tunnels listening
  pruneVlessProviders(merged.map((p) => p.id));
  return merged;
}

// ── Adapters ──────────────────────────────────────────────────────────────────

type WebshareProxy = {
  id: string;
  username: string;
  password: string;
  proxy_address: string;
  port: number;
  valid?: boolean;
  country_code?: string;
  city_name?: string;
};

async function fetchWebshare(provider: ProxyProvider): Promise<BembyProxy[]> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) throw new Error("API token is not set");

  const out: BembyProxy[] = [];
  let url: string | null = `${WEBSHARE_API_URL}?mode=direct&page_size=${WEBSHARE_PAGE_SIZE}`;

  for (let page = 0; url && page < PAGE_LIMIT; page++) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        res.status === 401
          ? "Webshare rejected the API token"
          : `Webshare API error ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { next: string | null; results: WebshareProxy[] };
    for (const p of data.results ?? []) {
      // Skip addresses Webshare itself reports as not working
      if (p.valid === false) continue;
      const where = [p.country_code, p.city_name].filter(Boolean).join(" ");
      out.push({
        id: proxyId(provider, p.id),
        name: `${provider.name} ${where || p.proxy_address}`.trim(),
        url: `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.proxy_address}:${p.port}`,
        host: "",
      });
    }
    url = data.next;
  }

  return out;
}

/**
 * Parses one line of a downloaded proxy list. Handles the shapes sellers use:
 * `ip:port`, `ip:port:user:pass`, `user:pass@ip:port` and any of those with a
 * `scheme://` in front. Returns undefined for blanks, comments and malformed lines.
 */
export function parseProxyLine(line: string, fallbackScheme = "http"): string | undefined {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return undefined;

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = (schemeMatch?.[1] ?? fallbackScheme).toLowerCase();
  const body = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  const hostPort = (value: string): { host: string; port: string } | undefined => {
    const m = value.match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
    return m ? { host: m[1], port: m[2] } : undefined;
  };

  // user:pass@host:port
  const atIndex = body.lastIndexOf("@");
  if (atIndex > 0) {
    const creds = body.slice(0, atIndex).split(":");
    const target = hostPort(body.slice(atIndex + 1));
    if (!target || creds.length !== 2 || !creds[0]) return undefined;
    return `${scheme}://${encodeURIComponent(creds[0])}:${encodeURIComponent(creds[1])}@${target.host}:${target.port}`;
  }

  const parts = body.split(":");
  if (parts.length === 2) {
    const target = hostPort(body);
    return target ? `${scheme}://${target.host}:${target.port}` : undefined;
  }
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    if (!/^\d{1,5}$/.test(port) || !host || !user) return undefined;
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return undefined;
}

const TOKEN_PLACEHOLDER = "{token}";

/**
 * Where a URL says `{token}` it is replaced by the provider's key, and the key is then not
 * also sent as a bearer header -- it is already in the request. Most subscriptions want
 * their token in the path or the query rather than in a header, and only the URL itself
 * knows which of the two, or under what parameter name. Written this way the key stays in
 * the key field, where it is masked and never sent back to the panel, rather than sitting
 * in plain sight in the address.
 */
export function resolveProviderUrl(
  url: string,
  apiKey: string | undefined,
): { url: string; headers: Record<string, string> } {
  const key = apiKey?.trim();
  if (!url.includes(TOKEN_PLACEHOLDER)) {
    return { url, headers: key ? { Authorization: `Bearer ${key}` } : {} };
  }
  if (!key) throw new Error(`This URL asks for ${TOKEN_PLACEHOLDER}, but no token is set`);
  return {
    url: url.split(TOKEN_PLACEHOLDER).join(encodeURIComponent(key)),
    headers: {},
  };
}

async function fetchList(provider: ProxyProvider): Promise<BembyProxy[]> {
  const configured = provider.url?.trim();
  if (!configured) throw new Error("List URL is not set");
  const { url, headers } = resolveProviderUrl(configured, provider.apiKey);

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`List URL returned ${res.status}`);

  const body = (await res.text()).slice(0, MAX_LIST_BYTES);
  const out: BembyProxy[] = [];
  const seen = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    const proxyUrl = parseProxyLine(line, provider.scheme ?? "http");
    if (!proxyUrl || seen.has(proxyUrl)) continue;
    seen.add(proxyUrl);
    // Address and port identify the entry, so ids stay stable as the list is re-fetched
    const { hostname, port } = new URL(proxyUrl);
    out.push({
      id: proxyId(provider, `${hostname}:${port}`),
      name: `${provider.name} ${hostname}`,
      url: proxyUrl,
      host: "",
    });
  }

  if (!out.length) throw new Error("No proxies found at that URL");
  return out;
}

/**
 * A VLESS-over-WebSocket subscription, such as a Cloudflare Workers deployment serves.
 * The nodes themselves are handed to vlessTunnel, which gives each one a loopback SOCKS5
 * port; what comes back here is that port dressed as a normal proxy entry.
 *
 * The subscription is asked for the plain v2ray format rather than Clash or sing-box,
 * which is what a deployment serves when the request does not look like either client.
 */
async function fetchSubscription(provider: ProxyProvider): Promise<BembyProxy[]> {
  const configured = provider.url?.trim();
  if (!configured) throw new Error("Subscription URL is not set");
  const { url, headers } = resolveProviderUrl(configured, provider.apiKey);

  const res = await fetch(url, {
    headers: { "User-Agent": "v2rayN/6.0", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Subscription URL returned ${res.status}`);

  const { nodes, skipped } = parseVlessSubscription((await res.text()).slice(0, MAX_LIST_BYTES));
  if (!nodes.length) {
    throw new Error(
      skipped
        ? `No VLESS-over-WebSocket nodes there (${skipped} node(s) of other kinds were skipped)`
        : "No nodes found at that URL",
    );
  }
  if (skipped) {
    console.log(`[vless] ${provider.name}: ${skipped} node(s) of other kinds were skipped`);
  }

  const entries = applyVlessNodes(
    provider.id,
    nodes.map((node) => ({ proxyId: proxyId(provider, nodeKey(node)), node })),
  );

  return entries.map((entry) => ({
    id: entry.proxyId,
    name: `${provider.name} ${entry.node.name}`.trim(),
    url: `socks5://127.0.0.1:${entry.port}`,
    host: "",
    autoPool: false,
  }));
}

function proxyId(provider: ProxyProvider, remoteId: string): string {
  return `${IMPORTED_ID_PREFIX}${provider.id}:${remoteId}`;
}

/**
 * Fetches one provider's current list. Only `subscription` writes anything of its own:
 * its loopback ports have to be recorded and bound for the urls it returns to mean
 * anything, so those come back already listening.
 */
export function fetchFromProvider(provider: ProxyProvider): Promise<BembyProxy[]> {
  switch (provider.type) {
    case "webshare":
      return fetchWebshare(provider);
    case "list":
      return fetchList(provider);
    case "subscription":
      return fetchSubscription(provider);
    default:
      return Promise.reject(new Error(`Unknown provider type "${provider.type}"`));
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

// ── Cloudflare solving: proxy candidates ──────────────────────────────────────

/** One browser-proxy option for a Cloudflare attempt. `url` undefined means direct. */
export type ProxyCandidate = { id: string; label: string; url?: string };

const CF_WINS_KEY = "cf_proxy_last_ok";
// Cloudflare accepts a minority of exits, so a first run needs room to find one. A
// refused attempt is cut short as soon as the page says so, keeping this affordable.
// Both counts are configurable in Settings (cfTuning).
const candidateCount = () => cfTuning().proxyCandidates;
/** Sanity ceiling for callers that offer the whole pool, however large it has grown. */
export const cfMaxCandidates = () => cfTuning().maxPoolCandidates;

function readCfWins(): Record<string, string> {
  try {
    const parsed = JSON.parse(readSetting(CF_WINS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const CF_GEO_KEY = "cf_exit_geo";

/** Where an exit comes out, so the browser can present a matching locale and clock. */
export type CfExitGeo = {
  loc: string;
  tz?: string;
  lang?: string;
  /** Epoch ms this was looked up, so a stale answer is re-checked rather than kept forever. */
  at?: number;
};

/**
 * How long a remembered location stands before it is looked up again.
 *
 * A proxy's own country does not move, but which exit a key names certainly does: `direct` is
 * whatever host Bemby runs on, and that changes when the deployment moves or a VPN goes up on
 * it. Kept forever, a stale answer dresses the browser in the old country's clock and language
 * indefinitely -- and nothing on the page says why. Re-checking costs one extra launch per
 * exit per fortnight.
 */
export const CF_GEO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function readCfGeo(): Record<string, CfExitGeo> {
  try {
    const parsed = JSON.parse(readSetting(CF_GEO_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CfExitGeo>) : {};
  } catch {
    return {};
  }
}

/**
 * The known geography of an exit, looked up by its stable key. An answer older than
 * `CF_GEO_MAX_AGE_MS` is treated as unknown, so the next launch probes again: see there for
 * why one is not kept indefinitely.
 */
export function cfExitGeo(exitKey: string): CfExitGeo | undefined {
  const known = readCfGeo()[exitKey];
  if (!known) return undefined;
  // No stamp at all means it was written before this expiry existed: probe it once, which
  // both refreshes it and stamps it
  if (!known.at || Date.now() - known.at > CF_GEO_MAX_AGE_MS) return undefined;
  return known;
}

/**
 * Remembers where an exit comes out, stamped with when. Looked up once per exit and kept for
 * a fortnight, since the lookup costs a page load.
 */
export function rememberCfExitGeo(exitKey: string, geo: CfExitGeo): void {
  if (!exitKey || !geo.loc) return;
  const all = readCfGeo();
  all[exitKey] = { ...geo, at: geo.at ?? Date.now() };
  writeSetting(CF_GEO_KEY, JSON.stringify(all));
}

/**
 * Forgets where every exit comes out, so the next launch of each looks it up again. For the
 * case the fortnight is too long to wait on: the host has just moved country, and every job is
 * meanwhile presenting the old one's clock and language.
 */
export function clearCfExitGeo(): number {
  const all = readCfGeo();
  const n = Object.keys(all).length;
  if (n) writeSetting(CF_GEO_KEY, "{}");
  return n;
}

/** Records which proxy cleared a challenge on a host, so the next run starts there. */
export function rememberCfProxy(host: string, proxyId: string): void {
  if (!host) return;
  const wins = readCfWins();
  if (wins[host] === proxyId) return;
  wins[host] = proxyId;
  writeSetting(CF_WINS_KEY, JSON.stringify(wins));
}

/** Value of a pinned proxy id meaning "no proxy for the browser". */
export const CF_PROXY_DIRECT = "direct";

/**
 * Value of a pinned proxy id meaning "draw one from the pool". The draw happens where the
 * exit is needed, so each run gets its own, and a pool that is left empty means the whole
 * proxy list.
 */
export const CF_PROXY_RANDOM = "random";

/** A picked exit: an id from the proxy list, `direct`, or `random` drawing from `pool`. */
export type ProxyChoice = { proxyId?: string; pool?: string[] };

/**
 * The proxies a random pick may draw from: the ones `poolIds` names, or every proxy in the
 * list when it names none. An entry with no url is not an exit and is left out.
 *
 * A named pool is taken at its word, tunnel exits included: naming one is the deliberate
 * choice that `autoPool` asks for. Only the unnamed draw, which is "whatever is in the
 * list", leaves them out.
 */
export function randomProxyPool(poolIds?: string[]): BembyProxy[] {
  const usable = readProxies().filter((p) => p.url);
  if (!poolIds?.length) return usable.filter((p) => p.autoPool !== false);
  const wanted = new Set(poolIds);
  return usable.filter((p) => wanted.has(p.id));
}

/** One proxy drawn from that pool, or undefined when the pool holds none. */
export function pickRandomProxy(poolIds?: string[]): BembyProxy | undefined {
  const pool = randomProxyPool(poolIds);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
}

/**
 * The exit url a picker's value stands for: an id from the proxy list, `random` for a draw
 * from `poolIds`, and no url at all for `direct`, a blank, or an id that has since gone.
 */
export function proxyUrlFor(
  proxyId: string | null | undefined,
  poolIds?: string[],
): string | undefined {
  if (!proxyId || proxyId === CF_PROXY_DIRECT) return undefined;
  if (proxyId === CF_PROXY_RANDOM) return pickRandomProxy(poolIds)?.url;
  return readProxies().find((p) => p.id === proxyId)?.url;
}

/**
 * What an exit is called, for showing. The name it goes by in the proxy list when the url is
 * one of those, otherwise host and port -- never the url itself, which carries its credentials.
 */
export function proxyLabelForUrl(url: string | undefined): string {
  if (!url) return "direct";
  const named = readProxies().find((p) => p.url === url)?.name?.trim();
  if (named) return named;
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "proxy";
  }
}

/** Fisher-Yates over a copy: the caller's list is a setting, not ours to reorder. */
function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Ordered proxies for a Cloudflare attempt, with the caller's own preference honoured:
 * `proxyId` pins one exit from the pool (or `direct` for none) instead of the job's
 * proxy, and `tryAll: false` keeps the run to that single exit rather than working
 * through the pool. A pinned exit always stays first -- the host's last winner only
 * leads when nothing was pinned.
 *
 * `exclude` drops exits that have already had their turn, so a retry moves further into
 * the pool instead of cycling the same few -- which is also what lets a pool bigger than
 * one attempt's window (imported proxies sit after the manually added ones) be covered.
 *
 * `random` is a pinned exit drawn rather than named: the draw settles which exit leads, and
 * the same draw orders the fall-through, so a refusal moves on inside `proxyPool` instead of
 * wandering into exits that were deliberately left out of it.
 */
export function cfProxyCandidatesFor(opts: {
  primaryUrl?: string;
  host?: string;
  /** Pool id of a pinned proxy, `direct`, or `random`. */
  proxyId?: string;
  /** Ids a `random` pick draws from. Empty draws from the whole list. */
  proxyPool?: string[];
  /** Fall through the rest of the pool when an exit is refused. Defaults to true. */
  tryAll?: boolean;
  max?: number;
  /** Ids of exits already tried; each proxy is offered once. */
  exclude?: Iterable<string>;
}): ProxyCandidate[] {
  const { primaryUrl, host, proxyId, tryAll = true, max = candidateCount() } = opts;
  const pool = readProxies();
  const tried = new Set(opts.exclude ?? []);
  const cap = Math.max(1, Math.min(max, cfMaxCandidates()));

  // A draw with nothing to draw from (no proxies, or a pool naming only proxies that have
  // since gone) falls through to the job's own exit rather than failing the action
  const drawn = proxyId === CF_PROXY_RANDOM ? shuffled(randomProxyPool(opts.proxyPool)) : [];
  if (drawn.length) {
    const offered = drawn
      .filter((p) => !tried.has(p.id))
      .map((p) => ({ id: p.id, label: p.name, url: p.url }));
    return dedupeByExit(tryAll ? offered : offered.slice(0, 1)).slice(0, cap);
  }

  const pinned = proxyId && proxyId !== CF_PROXY_DIRECT ? pool.find((p) => p.id === proxyId) : undefined;
  const primary: ProxyCandidate = pinned
    ? { id: pinned.id, label: pinned.name, url: pinned.url }
    : proxyId === CF_PROXY_DIRECT
      ? { id: CF_PROXY_DIRECT, label: "direct", url: undefined }
      : {
          id: pool.find((p) => p.url === primaryUrl)?.id ?? (primaryUrl ? "job" : "direct"),
          label: pool.find((p) => p.url === primaryUrl)?.name ?? (primaryUrl ? "job proxy" : "direct"),
          url: primaryUrl,
        };

  if (!tryAll) return tried.has(primary.id) ? [] : [primary];

  // `autoPool: false` keeps tunnel exits out of the fall-through: they share one address,
  // so working through them spends attempts without changing what the challenge sees. A
  // pinned one is still honoured above, since that was asked for by name.
  const rest: ProxyCandidate[] = pool
    .filter((p) => p.url && p.autoPool !== false && p.url !== primary.url && !tried.has(p.id))
    .map((p) => ({ id: p.id, label: p.name, url: p.url }));

  // Lead with the proxy that cleared this host last time, wherever it sits in the pool
  const winnerId = host && !proxyId ? readCfWins()[host] : undefined;
  const winnerIndex = winnerId ? rest.findIndex((c) => c.id === winnerId) : -1;
  const head = tried.has(primary.id) ? [] : [primary];
  const ordered =
    winnerIndex >= 0
      ? [rest[winnerIndex], ...head, ...rest.filter((_, i) => i !== winnerIndex)]
      : [...head, ...rest];

  return dedupeByExit(ordered).slice(0, cap);
}

/** One candidate per exit: the same url reached under two ids is still the same IP. */
function dedupeByExit(list: ProxyCandidate[]): ProxyCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.url ?? "direct";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readProxies(): BembyProxy[] {
  try {
    const parsed = JSON.parse(readSetting("proxies") ?? "[]");
    return Array.isArray(parsed) ? (parsed as BembyProxy[]) : [];
  } catch {
    return [];
  }
}

const importedByProvider = (id: string) => `${IMPORTED_ID_PREFIX}${id}:`;

/**
 * Pulls the current list from each enabled provider (or just `onlyProviderId`) and
 * rewrites that provider's share of the proxy list. Manually added proxies, and imports
 * belonging to providers that were not synced, are left as they are. Ids are derived
 * from the provider's own identifiers so anything pinned to a proxy survives a sync.
 *
 * A provider that fails leaves its previously imported proxies in place -- a transient
 * API outage should not strip the pool a job is about to use.
 */
export async function syncProviders(onlyProviderId?: string): Promise<SyncResult> {
  const providers = readProviders().filter(
    (p) => (onlyProviderId ? p.id === onlyProviderId : p.enabled !== false),
  );
  if (!providers.length) {
    throw new Error(onlyProviderId ? "Provider not found" : "No proxy providers configured");
  }

  const results: ProviderSyncResult[] = [];
  const fetched: BembyProxy[] = [];
  const syncedIds: string[] = [];

  for (const provider of providers) {
    try {
      const list = await fetchFromProvider(provider);
      fetched.push(...list);
      syncedIds.push(provider.id);
      results.push({ providerId: provider.id, name: provider.name, ok: true, fetched: list.length });
    } catch (err: any) {
      results.push({
        providerId: provider.id,
        name: provider.name,
        ok: false,
        error: err?.message ?? "Fetch failed",
      });
    }
  }

  const existing = readProxies();
  const replacedPrefixes = syncedIds.map(importedByProvider);
  // Sweep up entries imported by the pre-provider build when Webshare is refreshed
  if (providers.some((p) => syncedIds.includes(p.id) && p.type === "webshare")) {
    replacedPrefixes.push(LEGACY_WEBSHARE_PREFIX);
  }
  const isReplaced = (p: BembyProxy) => replacedPrefixes.some((prefix) => p.id.startsWith(prefix));

  const kept = existing.filter((p) => !isReplaced(p));
  const previous = new Map(existing.filter(isReplaced).map((p) => [p.id, p]));

  let added = 0;
  let updated = 0;
  for (const p of fetched) {
    const prev = previous.get(p.id);
    if (!prev) added++;
    else if (prev.url !== p.url || prev.name !== p.name) updated++;
  }
  const fetchedIds = new Set(fetched.map((p) => p.id));
  const removed = [...previous.keys()].filter((id) => !fetchedIds.has(id)).length;

  const merged = [...kept, ...fetched];
  writeSetting("proxies", JSON.stringify(merged));

  return { providers: results, added, updated, removed, total: merged.length };
}
