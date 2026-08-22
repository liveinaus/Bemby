import { SocksClient } from "socks";
import {
  Agent,
  ProxyAgent,
  buildConnector,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import type { TgProxy } from "../types";
import { globalProxyLabel, globalProxyUrl } from "./proxyProviders";

// Turning the global exit (see GLOBAL_PROXY_ID_KEY) into the two shapes the rest of the
// server connects with: an undici dispatcher for everything that speaks HTTP, and a SOCKS
// descriptor for the MTProto client, which takes a host and port rather than a url.
//
// Setting the process-wide dispatcher is what makes this reach the calls nobody threads a
// proxy through -- the GitHub update check, the notification bot, a provider's list url.
// Node's own `fetch` reads the same global, so those follow it without being touched. A call
// that names its own dispatcher, such as a job going out through its account's proxy, is
// unaffected: it was already routed, and the global exit is only the default.

/** Plain dispatcher used when the global proxy is off, so the default is restored on flip. */
const direct = new Agent();

let active: { url: string; dispatcher: Dispatcher } | null = null;

/**
 * An undici dispatcher that goes out through one proxy url, whichever kind it is. `insecureTls`
 * accepts an untrusted certificate on the far side, for a server behind one Node rejects.
 *
 * Shared rather than per-caller because the SOCKS half is the part each caller got wrong:
 * undici's own proxy support covers http(s) only, and handing it a socks5:// url throws.
 */
export function proxyDispatcher(
  url: string,
  insecureTls = false,
): Dispatcher {
  if (/^socks/i.test(url)) return socksAgent(new URL(url), insecureTls);
  return insecureTls
    ? new ProxyAgent({ uri: url, requestTls: { rejectUnauthorized: false } })
    : new ProxyAgent(url);
}

/**
 * A dispatcher that opens each connection through a SOCKS proxy. undici carries an HTTP
 * proxy on its own but not this, so the tunnel is opened here and handed to undici's own
 * connector for the TLS half, which is the same handover its HTTP proxy support makes.
 */
function socksAgent(url: URL, insecureTls: boolean): Agent {
  const proxy = {
    host: url.hostname,
    port: Number(url.port) || 1080,
    type: (url.protocol === "socks4:" ? 4 : 5) as 4 | 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
  const upgrade = buildConnector(
    insecureTls ? { rejectUnauthorized: false } : {},
  );

  const connect: buildConnector.connector = (opts, callback) => {
    const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
    SocksClient.createConnection({
      proxy,
      command: "connect",
      // The name goes to the proxy unresolved, as socks5h does, so it is looked up on the
      // far side -- which is the whole point when the near side cannot resolve it
      destination: { host: opts.hostname, port },
    })
      .then(({ socket }) => {
        if (opts.protocol !== "https:") {
          callback(null, socket.setNoDelay(true));
          return;
        }
        upgrade({ ...opts, httpSocket: socket }, callback);
      })
      .catch((err: unknown) => callback(err as Error, null));
  };

  return new Agent({ connect });
}

/**
 * The dispatcher for the global exit, or undefined when it is off. Built once per url and
 * kept: a fresh one per request leaves its keep-alive sockets open until they time out.
 *
 * A url that has changed under it is swapped here rather than at the caller, which is why
 * this reads more like a switch than a getter -- see `swap`.
 */
export function globalProxyDispatcher(): Dispatcher | undefined {
  const url = globalProxyUrl();
  if (!url) {
    if (active) swap(null);
    return undefined;
  }
  if (active?.url === url) return active.dispatcher;

  let dispatcher: Dispatcher;
  try {
    dispatcher = proxyDispatcher(url);
  } catch (err: any) {
    console.error(
      `[proxy] global proxy could not be used (${err?.message ?? err}); connections go out direct`,
    );
    swap(null);
    return undefined;
  }

  swap({ url, dispatcher });
  return dispatcher;
}

/**
 * Puts one dispatcher in the other's place everywhere at once, then closes what it replaced.
 *
 * The process-wide dispatcher is set here rather than only in `applyGlobalProxy` because the
 * one being retired may be the one every unrouted call is currently using: closing it without
 * replacing it would leave those calls dispatching through a closed pool. Closing comes after
 * the swap, so a request already in flight finishes on the old one.
 */
function swap(next: { url: string; dispatcher: Dispatcher } | null): void {
  const previous = active?.dispatcher;
  active = next;
  setGlobalDispatcher(next?.dispatcher ?? direct);
  previous?.close().catch(() => {});
}

/**
 * Points every unrouted HTTP call at the global exit, or back at a direct connection when it
 * is off. Called at startup and again whenever the setting or the proxy list changes.
 */
export function applyGlobalProxy(): void {
  const dispatcher = globalProxyDispatcher();
  // Set again for the case `globalProxyDispatcher` had nothing to swap: an unchanged url, or
  // a first call while the exit is off
  setGlobalDispatcher(dispatcher ?? direct);
  const label = globalProxyLabel();
  console.log(
    dispatcher
      ? `[proxy] global proxy on: unrouted connections leave by "${label || "the global exit"}"`
      : "[proxy] global proxy off: unrouted connections go out direct",
  );
}

/**
 * The global exit as MTProto can use it, or undefined when there is none it can.
 *
 * Telegram's transport speaks SOCKS only, so an HTTP exit -- which is what most sellers hand
 * out -- cannot carry an account. That is said once and the connection goes direct, the same
 * as before the global proxy was set: an account naming no proxy was never going to be
 * routed, and failing every account over the wrong kind of global exit helps nobody.
 */
export function globalTgProxy(): TgProxy | undefined {
  const url = globalProxyUrl();
  if (!url) return undefined;
  const proxy = parseSocksUrl(url);
  if (!proxy) warnGlobalNotSocks(url);
  return proxy;
}

/** The same exit as a url, for a caller that passes urls rather than descriptors. */
export function globalTgProxyUrl(): string | undefined {
  return globalTgProxy() ? globalProxyUrl() : undefined;
}

let warnedNotSocks = "";
function warnGlobalNotSocks(url: string): void {
  if (warnedNotSocks === url) return;
  warnedNotSocks = url;
  console.warn(
    "[proxy] the global proxy is not SOCKS, so Telegram connections cannot use it " +
      "(MTProto needs socks5:// or socks4://); they go out direct",
  );
}

function parseSocksUrl(proxyUrl: string): TgProxy | undefined {
  try {
    const u = new URL(proxyUrl);
    const proto = u.protocol.replace(":", "");
    if (proto !== "socks5" && proto !== "socks4" && proto !== "socks")
      return undefined;
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      socksType: proto === "socks4" ? 4 : 5,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return undefined;
  }
}
