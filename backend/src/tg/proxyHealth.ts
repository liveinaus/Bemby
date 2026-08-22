import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { SocksClient } from "socks";

import { db } from "../db/database";
import { parseTgProxy } from "../jobs/runner";
import { isVlessListener } from "./vlessTunnel";
import {
  CF_PROXY_DIRECT,
  CF_PROXY_RANDOM,
  IMPORTED_ID_PREFIX,
  proxyById,
  proxyUrlFor,
  randomProxyOrder,
  recordProxyTestResults,
  type BembyProxy,
  type ProxyChoice,
} from "./proxyProviders";
import type { TgProxy } from "../types";

// Reachability of the stored proxies, and the status each test leaves behind. A failed exit
// is disabled: draws, suppliers and the Cloudflare fall-through all skip it until a later
// test finds it working again, which is why every test covers the failed ones too.
//
// Reachability is only the first check. The optional ones below answer what reachability
// cannot: an exit can answer a CONNECT perfectly well and still be refused by Cloudflare,
// which is the exit a browser job needs and the one a plain connect test calls healthy.

type ProxyEntry = { id?: string; url?: string; [key: string]: unknown };

function parseProxyList(raw: string | undefined): ProxyEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as ProxyEntry[]) : [];
  } catch {
    return [];
  }
}

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | undefined)?.value;
}

/** Also require the exit to reach Cloudflare's challenge host. Off unless turned on. */
export const PROXY_TEST_CF_KEY = "proxy_test_cf";
/** One more URL the exit must fetch, for a host that matters to this deployment. */
export const PROXY_TEST_EXTRA_URL_KEY = "proxy_test_extra_url";
/** How often the whole list is re-tested on its own, in minutes. 0 turns it off. */
export const PROXY_TEST_INTERVAL_KEY = "proxy_test_interval_minutes";
/** Check the exit answers immediately before a run goes out through it. */
export const PROXY_CHECK_BEFORE_USE_KEY = "proxy_check_before_use";

const PROXY_TEST_TIMEOUT_MS = 6000;
// Tested together rather than one after another: a list of 80 would take eight minutes
// serially at the timeout above. Capped so a large list does not open a socket per proxy.
const PROXY_TEST_CONCURRENCY = 20;

type TestTarget = { host: string; port: number };

const PROXY_TEST_TARGET: TestTarget = { host: "1.1.1.1", port: 80 };

/**
 * Where a tunnel exit is tested against instead. A Cloudflare Worker cannot open a
 * connection to Cloudflare's own addresses, so 1.1.1.1 would report a perfectly good
 * node as broken. Google's resolver answers on TCP 53 and sits nowhere near Cloudflare.
 */
const TUNNEL_TEST_TARGET: TestTarget = { host: "8.8.8.8", port: 53 };

/** What the Cloudflare check fetches: the challenge host jobs actually have to clear. */
const CF_CHECK_HOST = "challenges.cloudflare.com";
const CF_CHECK_PATH = "/cdn-cgi/trace";

/** One thing a test asked of an exit, and what came back. */
export type ProxyCheck = {
  /** `reach`, `cloudflare`, or `extra` -- named so the UI can label it. */
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
};

export type ProxyTestResult = {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  /** Round trip of the SOCKS connect, in ms. */
  ms: number;
  /** Every check this test ran, in order. */
  checks?: ProxyCheck[];
  /** The address the exit comes out on, when a Cloudflare check read it back. */
  exitIp?: string;
};

/** Which checks a test runs on top of reachability, as configured. */
export type ProxyTestOptions = { cloudflare?: boolean; extraUrl?: string };

export function proxyTestOptions(): ProxyTestOptions {
  return {
    cloudflare: readSetting(PROXY_TEST_CF_KEY) === "true",
    extraUrl: readSetting(PROXY_TEST_EXTRA_URL_KEY)?.trim() || undefined,
  };
}

/** Opens a tunnel to `target` through a SOCKS proxy, handing back the live socket. */
async function socksTunnel(proxy: TgProxy, target: TestTarget): Promise<net.Socket> {
  const result = await SocksClient.createConnection({
    proxy: {
      host: proxy.ip,
      port: proxy.port,
      type: proxy.socksType,
      ...(proxy.username ? { userId: proxy.username, password: proxy.password } : {}),
    },
    command: "connect",
    destination: target,
    timeout: PROXY_TEST_TIMEOUT_MS,
  });
  return result.socket;
}

/**
 * The same tunnel through an HTTP proxy -- what Webshare and downloaded lists hand out.
 * These cannot carry a Telegram connection, but they do carry the browser side, so "does it
 * answer" is still worth reporting. A SOCKS handshake against one only ever fails, which is
 * why they need a CONNECT tunnel of their own.
 */
function httpTunnel(url: URL, target: TestTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const credentials = url.username
      ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
      : "";
    const req = (secure ? https : http).request({
      host: url.hostname,
      port: Number(url.port) || (secure ? 443 : 80),
      method: "CONNECT",
      path: `${target.host}:${target.port}`,
      timeout: PROXY_TEST_TIMEOUT_MS,
      ...(credentials
        ? {
            headers: {
              "Proxy-Authorization": `Basic ${Buffer.from(credentials).toString("base64")}`,
            },
          }
        : {}),
    });
    const fail = (message: string) => {
      req.destroy();
      reject(new Error(message));
    };
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      fail(
        res.statusCode === 407
          ? "Proxy authentication failed"
          : `Proxy refused CONNECT (${res.statusCode})`,
      );
    });
    req.on("timeout", () => fail("Connection timed out"));
    req.on("error", (err) => fail(err.message));
    req.end();
  });
}

/** A tunnel to `target` through whichever kind of proxy `url` describes. */
function tunnelThrough(url: string, target: TestTarget): Promise<net.Socket> {
  const socks = parseTgProxy(url);
  if (socks) return socksTunnel(socks, target);
  return httpTunnel(new URL(url), target);
}

/**
 * Fetches a page over an already-open tunnel and reads the response head. Only enough of the
 * body is kept to read a value out of it; the socket is dropped as soon as that much is in,
 * so a large page costs nothing.
 */
function httpsGet(
  socket: net.Socket,
  host: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false });
    let buffer = "";
    const done = (err?: Error, out?: { status: number; body: string }) => {
      secure.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(out!);
    };
    secure.setTimeout(PROXY_TEST_TIMEOUT_MS, () => done(new Error("Request timed out")));
    secure.on("error", (err) => done(err));
    secure.on("secureConnect", () => {
      secure.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Bemby-proxy-check\r\nConnection: close\r\nAccept: */*\r\n\r\n`,
      );
    });
    secure.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 8192) finish();
    });
    secure.on("end", finish);

    function finish() {
      const status = Number(buffer.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
      if (!status) return done(new Error("No HTTP response"));
      done(undefined, { status, body: buffer.slice(buffer.indexOf("\r\n\r\n") + 4) });
    }
  });
}

/** Turns what a user typed into a host, port and path to fetch. */
function parseExtraTarget(raw: string): { host: string; port: number; path: string } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:") return null;
    return {
      host: url.hostname,
      port: Number(url.port) || 443,
      path: `${url.pathname}${url.search}` || "/",
    };
  } catch {
    return null;
  }
}

/**
 * Reachability through a proxy, plus whichever extra checks are turned on. `ms` stays the
 * round trip of the first connect, so the number beside a proxy still means what it did
 * before the extra checks existed.
 *
 * A tunnel exit skips the Cloudflare check: a Cloudflare Worker cannot open a connection to
 * Cloudflare's own addresses, so failing it would disable a node that is working perfectly.
 */
export async function testProxyUrl(
  url: string,
  options: ProxyTestOptions = proxyTestOptions(),
): Promise<{ ok: boolean; error?: string; ms: number; checks: ProxyCheck[]; exitIp?: string }> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const socks = parseTgProxy(url);
  if (!socks) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "Invalid proxy URL", ms: 0, checks: [] };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        error: `Unsupported proxy scheme (${parsed.protocol.replace(":", "")})`,
        ms: 0,
        checks: [],
      };
    }
  }

  const tunnelExit = isVlessListener(url);
  const checks: ProxyCheck[] = [];
  const reach = await runCheck("reach", () =>
    tunnelThrough(url, tunnelExit ? TUNNEL_TEST_TARGET : PROXY_TEST_TARGET).then((s) =>
      s.destroy(),
    ),
  );
  checks.push(reach);
  const ms = elapsed();
  if (!reach.ok) return { ok: false, error: reach.error, ms, checks };

  let exitIp: string | undefined;
  if (options.cloudflare && !tunnelExit) {
    const check = await runCheck("cloudflare", async () => {
      const socket = await tunnelThrough(url, { host: CF_CHECK_HOST, port: 443 });
      const { status, body } = await httpsGet(socket, CF_CHECK_HOST, CF_CHECK_PATH);
      if (status !== 200) throw new Error(`Cloudflare answered ${status}`);
      exitIp = body.match(/^ip=(.+)$/m)?.[1]?.trim();
    });
    checks.push(check);
  }

  const extra = options.extraUrl ? parseExtraTarget(options.extraUrl) : null;
  if (extra) {
    checks.push(
      await runCheck("extra", async () => {
        const socket = await tunnelThrough(url, { host: extra.host, port: extra.port });
        const { status } = await httpsGet(socket, extra.host, extra.path);
        if (status >= 400) throw new Error(`${extra.host} answered ${status}`);
      }),
    );
  }

  const broken = checks.find((c) => !c.ok);
  return { ok: !broken, error: broken?.error, ms, checks, exitIp };
}

async function runCheck(name: string, run: () => Promise<unknown>): Promise<ProxyCheck> {
  const startedAt = Date.now();
  try {
    await run();
    return { name, ok: true, ms: Date.now() - startedAt };
  } catch (err: any) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      error: err?.message ?? "Connection failed",
    };
  }
}

/**
 * Tests every stored proxy, a few at a time, and records what it found on each entry: the
 * ones that fail are disabled, the ones that answer are put back in service. Disabled exits
 * are tested along with the rest, which is the only way one ever recovers.
 *
 * The URLs come from the database rather than the request: what the client holds has its
 * passwords masked, so testing those would only ever report an auth failure.
 *
 * `filter.providerIds` keeps the run to what those providers imported, which is what a sync
 * asks for: the list it just rewrote is the part whose health is unknown. Exits turned off by
 * hand are skipped throughout: only the operator puts one of those back.
 */
export async function testStoredProxies(
  filter?: { providerIds?: string[] },
): Promise<ProxyTestResult[]> {
  const prefixes = filter?.providerIds?.map((id) => `${IMPORTED_ID_PREFIX}${id}:`);
  const list = parseProxyList(readSetting("proxies")).filter(
    (p) =>
      typeof p.id === "string" &&
      typeof p.url === "string" &&
      // An exit turned off by hand is left alone: a pass here could not put it back anyway,
      // so testing it would only spend a socket on a decision already made
      p.disabled !== true &&
      (!prefixes?.length || prefixes.some((prefix) => (p.id as string).startsWith(prefix))),
  );
  const options = proxyTestOptions();

  const results: ProxyTestResult[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      const entry = list[index];
      const outcome = await testProxyUrl(entry.url as string, options);
      results[index] = {
        id: entry.id as string,
        name: typeof entry.name === "string" ? entry.name : (entry.id as string),
        ...outcome,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROXY_TEST_CONCURRENCY, list.length) }, worker),
  );

  const { failed, recovered } = recordProxyTestResults(results);
  if (failed || recovered) {
    console.log(`[proxy] health: ${failed} disabled, ${recovered} back in service`);
  }
  return results;
}

/** Longest interval accepted, in minutes: a week, past which an interval is not a schedule. */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** Minutes between automatic tests, as configured. 0 (the default) leaves them to the operator. */
export function proxyTestIntervalMinutes(): number {
  const minutes = Math.floor(Number(readSetting(PROXY_TEST_INTERVAL_KEY) ?? 0));
  return Number.isFinite(minutes) && minutes > 0
    ? Math.min(minutes, MAX_INTERVAL_MINUTES)
    : 0;
}

let healthTimer: ReturnType<typeof setInterval> | undefined;
let firstRunTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Delay before the first automatic test of a boot. Long enough for the tunnel listeners and
 * the network to settle, short enough that a deployment restarted daily still gets tested --
 * an interval alone would keep resetting its clock and never fire.
 */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/**
 * Arms the automatic re-test, which is what keeps a supplier's pool current: exits that stop
 * answering drop out of every draw, and ones that come back are picked up again without
 * anybody opening the settings page. Called again whenever the interval is changed.
 */
export function startProxyHealthChecks(): void {
  stopProxyHealthChecks();
  const minutes = proxyTestIntervalMinutes();
  if (!minutes) return;

  const run = () => {
    testStoredProxies().catch((err) =>
      console.error(`[proxy] health check failed: ${err?.message ?? err}`),
    );
  };
  const period = minutes * 60 * 1000;
  // The repeat is armed by the first run rather than alongside it: an interval shorter than
  // the boot delay would otherwise have its first tick land on the same instant as that run
  // and test twice. The delay is there to let the tunnels and the network settle, so a short
  // interval starts sooner than it.
  firstRunTimer = setTimeout(() => {
    run();
    healthTimer = setInterval(run, period);
    healthTimer.unref();
  }, Math.min(FIRST_RUN_DELAY_MS, period));
  firstRunTimer.unref();
  console.log(`[proxy] health checks every ${minutes}m`);
}

export function stopProxyHealthChecks(): void {
  if (healthTimer) clearInterval(healthTimer);
  if (firstRunTimer) clearTimeout(firstRunTimer);
  healthTimer = undefined;
  firstRunTimer = undefined;
}

// ── The check a run makes for itself ──────────────────────────────────────────

/** Whether a run verifies its exit before going out through it. */
export function checksProxyBeforeUse(): boolean {
  return readSetting(PROXY_CHECK_BEFORE_USE_KEY) === "true";
}

/**
 * Most exits one run will check before giving up. A draw works down the pool in order, and
 * each refusal costs up to the test timeout, so the cap is what keeps a pool of ninety dead
 * exits from holding a run for nine minutes.
 */
const PRE_USE_MAX_TRIES = 5;

/** Nothing the run was allowed to use answered, so it has no exit to go out through. */
export class ProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyUnavailableError";
  }
}

/**
 * The exit a run should use, verified first when that option is on. A draw is checked one
 * candidate at a time in draw order and the first that answers is the one used, so a pool
 * routes around an exit that has gone bad since the last test. A single exit -- a pinned
 * proxy, or a pool with one candidate left -- has nothing to fall back to, so the run fails
 * rather than quietly leaving through the host's own address.
 *
 * Only reachability is checked here: it is the fast question, and the deeper ones (Cloudflare,
 * an extra URL) belong to the scheduled test rather than to every run's critical path.
 *
 * Outcomes are recorded like any other test, so an exit that fails here is disabled and drops
 * out of later draws, and one that answers is marked working.
 */
export async function checkedProxyUrl(choice: ProxyChoice): Promise<string | undefined> {
  const { proxyId, pool } = choice;
  // Nothing picked resolves to the global exit, which has nothing to check between: there is
  // no second candidate to move on to, so a failure would only turn into a run that fails
  if (!proxyId || proxyId === CF_PROXY_DIRECT) return proxyUrlFor(proxyId);
  if (!checksProxyBeforeUse()) return proxyUrlFor(proxyId, pool);

  const pinned = proxyId === CF_PROXY_RANDOM ? undefined : proxyById(proxyId);
  const candidates: BembyProxy[] =
    proxyId === CF_PROXY_RANDOM ? randomProxyOrder(pool) : pinned?.url ? [pinned] : [];
  if (!candidates.length) {
    throw new ProxyUnavailableError(
      proxyId === CF_PROXY_RANDOM
        ? "Proxy check: the pool has no exit left to draw from"
        : `Proxy check: proxy "${proxyId}" is no longer configured`,
    );
  }

  const options: ProxyTestOptions = {};
  const results: ProxyTestResult[] = [];
  let chosen: BembyProxy | undefined;

  for (const proxy of candidates.slice(0, PRE_USE_MAX_TRIES)) {
    const outcome = await testProxyUrl(proxy.url, options);
    results.push({ id: proxy.id, name: proxy.name, ...outcome });
    if (outcome.ok) {
      chosen = proxy;
      break;
    }
    console.warn(`[proxy] pre-use check: "${proxy.name}" refused (${outcome.error})`);
  }

  // Recorded whichever way it went, so a refusal here disables the exit for later draws
  if (results.length) recordProxyTestResults(results);

  if (!chosen) {
    const last = results[results.length - 1];
    throw new ProxyUnavailableError(
      candidates.length === 1
        ? `Proxy check: "${last.name}" refused the connection (${last.error})`
        : `Proxy check: ${results.length} of ${candidates.length} exits checked, none answered ` +
          `(last: ${last.name} -- ${last.error})`,
    );
  }
  if (results.length > 1) {
    console.log(`[proxy] pre-use check: using "${chosen.name}" after ${results.length} tries`);
  }
  return chosen.url;
}
