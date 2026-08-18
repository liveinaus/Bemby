import { settingsApi, type ProxyProvider } from "../api/client";

/** Value of a proxy pick meaning "draw one from the pool, per run". */
export const PROXY_RANDOM = "random";

/**
 * A pool entry naming a whole supplier instead of one exit: `provider:<providerId>`, or
 * `provider:` on its own for the proxies no provider imported. The backend expands it at
 * draw time, so the pool follows whatever that supplier currently lists.
 */
export const POOL_PROVIDER_PREFIX = "provider:";

export const supplierToken = (providerId: string) => `${POOL_PROVIDER_PREFIX}${providerId}`;

/** Prefix an imported proxy's id carries, mirroring `IMPORTED_ID_PREFIX` on the server. */
const IMPORTED_ID_PREFIX = "pp:";

/** The supplier a proxy belongs to: the provider that imported it, or "" when none did. */
export function supplierIdForProxy(proxyId: string, providerIds: Iterable<string>): string {
  for (const id of providerIds) {
    if (proxyId.startsWith(`${IMPORTED_ID_PREFIX}${id}:`)) return id;
  }
  return "";
}

/** Whether a pool covers this proxy, supplier entries expanded the way the server does. */
export function poolCovers(
  pool: string[],
  proxyId: string,
  providerIds: Iterable<string>,
): boolean {
  if (pool.includes(proxyId)) return true;
  const supplier = supplierToken(supplierIdForProxy(proxyId, providerIds));
  return pool.includes(supplier);
}

/**
 * A picked exit as the API takes it: the pick itself, and the pool only when the pick is a
 * draw. An empty pool is left off, since an absent pool already means the whole proxy list.
 */
export function proxyFields(
  proxyId: string,
  pool: string[],
): { proxyId?: string; proxyPool?: string[] } {
  if (!proxyId) return {};
  return {
    proxyId,
    ...(proxyId === PROXY_RANDOM && pool.length ? { proxyPool: [...pool] } : {}),
  };
}

// Several pickers can be on screen at once and the list rarely changes, so one fetch is
// shared between them; the TTL is what picks up a provider added in Settings meanwhile.
const PROVIDERS_TTL_MS = 30_000;
let cached: { at: number; list: Promise<ProxyProvider[]> } | undefined;

export function proxyProvidersCached(): Promise<ProxyProvider[]> {
  if (!cached || Date.now() - cached.at > PROVIDERS_TTL_MS) {
    cached = { at: Date.now(), list: settingsApi.getProxyProviders().catch(() => []) };
  }
  return cached.list;
}
