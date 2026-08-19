import { db } from "../db/database";
import {
  CF_PROXY_DIRECT,
  CF_PROXY_RANDOM,
  listProxies,
  parseProxyChoice,
  POOL_PROVIDER_PREFIX,
  randomProxyPool,
  readProviders,
  type BembyProxy,
  type ProxyChoice,
} from "../tg/proxyProviders";
import type { JobProxy, JobProxySource } from "../types";

// Which exit a job actually leaves by, for the optional column on the jobs page.
//
// The pick follows the same chain a run does: the job's own proxy, else its template's, else
// the account's. What is worth saying about the result is only what identifies it -- a pinned
// exit by name, a whole-supplier pool by the supplier's name, and a wider draw by how many
// exits it covers. A pool is never listed out: a supplier with two hundred entries is one
// answer to "where does this go", not two hundred.

export type JobProxyRow = {
  config: string | null;
  template_id: number | null;
  account_proxy_id?: string | null;
};

/** Host and port of an exit, never the url itself, which carries its credentials. */
function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "proxy";
  }
}

/**
 * Resolves many jobs against one read of the proxy list, the provider list and whichever
 * templates come up. Build one per request; it holds no state worth keeping between them.
 */
export function makeJobProxyResolver(): (row: JobProxyRow) => JobProxy {
  let proxies: Map<string, BembyProxy> | null = null;
  let providerNames: Map<string, string> | null = null;
  const templateConfigs = new Map<number, string | null>();
  const poolSizes = new Map<string, number>();

  const exitName = (id: string): string => {
    if (!proxies) proxies = new Map(listProxies().map((p) => [p.id, p]));
    const proxy = proxies.get(id);
    // A pin to an exit that has since gone still says which one, so it can be put back
    if (!proxy) return id;
    return proxy.name?.trim() || hostPort(proxy.url);
  };

  const providerName = (id: string): string => {
    if (!providerNames) {
      providerNames = new Map(readProviders().map((p) => [p.id, p.name]));
    }
    return providerNames.get(id) || id;
  };

  const templateConfig = (id: number): string | null => {
    if (!templateConfigs.has(id)) {
      const row = db
        .prepare("SELECT config FROM job_templates WHERE id = ?")
        .get(id) as { config: string | null } | undefined;
      templateConfigs.set(id, row?.config ?? null);
    }
    return templateConfigs.get(id) ?? null;
  };

  const drawSize = (pool: string[]): number => {
    const key = [...pool].sort().join("|");
    let size = poolSizes.get(key);
    if (size === undefined) {
      size = randomProxyPool(pool.length ? pool : undefined).length;
      poolSizes.set(key, size);
    }
    return size;
  };

  const describe = (choice: ProxyChoice, source: JobProxySource): JobProxy => {
    const id = choice.proxyId;
    if (!id || id === CF_PROXY_DIRECT) return { kind: "direct", label: "", source };
    if (id !== CF_PROXY_RANDOM) return { kind: "proxy", label: exitName(id), source };

    const pool = choice.pool ?? [];
    const suppliers = pool
      .filter((entry) => entry.startsWith(POOL_PROVIDER_PREFIX))
      .map((entry) => entry.slice(POOL_PROVIDER_PREFIX.length))
      // The empty id is the ungrouped bucket, which has no supplier to name
      .filter(Boolean);
    // A pool that is nothing but whole suppliers reads as those suppliers
    if (pool.length && suppliers.length === pool.length) {
      return {
        kind: "provider",
        label: suppliers.map(providerName).join(" + "),
        source,
        poolSize: drawSize(pool),
      };
    }
    return { kind: "random", label: "", source, poolSize: drawSize(pool) };
  };

  return (row) => {
    const accountProxyId = row.account_proxy_id ?? undefined;

    const fromJob = parseProxyChoice(row.config);
    const fromTemplate = fromJob.proxyId
      ? null
      : row.template_id
        ? parseProxyChoice(templateConfig(row.template_id))
        : null;
    const override = fromJob.proxyId ? fromJob : fromTemplate?.proxyId ? fromTemplate : null;
    if (!override) return describe({ proxyId: accountProxyId }, "account");

    const resolved = describe(override, fromJob.proxyId ? "job" : "template");
    // Telegram stays on the account's exit; naming it here is what keeps that visible
    if (accountProxyId && accountProxyId !== override.proxyId) {
      resolved.tgLabel = describe({ proxyId: accountProxyId }, "account").label;
    }
    return resolved;
  };
}
