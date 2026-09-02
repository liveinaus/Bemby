import { db } from "../db/database";
import {
  CF_PROXY_DIRECT,
  CF_PROXY_RANDOM,
  globalProxyLabel,
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
// The pick follows the same chain a run does. A browser step's own proxy comes first: on a
// custom job with no template that is the only place an exit can be set at all, so a job
// whose one step is "open a web page" leaves by the step's pick and never touches the
// account's. A step left blank follows the job's own proxy, else its template's, and only
// then the account's -- which is what the browser falls back to when nothing else was
// picked (see resolveWebProxyUrl).
//
// What is worth saying about the result is only what identifies it -- a pinned exit by name,
// a whole-supplier pool by the supplier's name, and a wider draw by how many exits it
// covers. A pool is never listed out: a supplier with two hundred entries is one answer to
// "where does this go", not two hundred.

export type JobProxyRow = {
  config: string | null;
  template_id: number | null;
  account_proxy_id?: string | null;
};

/**
 * Actions that open a browser, and so carry an exit of their own. Nothing else in a chain
 * goes out anywhere but Telegram, which follows the account whatever a job picks.
 */
const BROWSER_ACTIONS = new Set([
  "open_url",
  "open_message_url",
  "open_mini_app",
  "open_mini_app_url",
  "open_bot_menu_app",
]);

type ActionLike = {
  type?: unknown;
  proxyId?: unknown;
  proxyPool?: unknown;
  then?: unknown;
  elseIfs?: unknown;
  otherwise?: unknown;
};

/**
 * Every browser action in a chain, the arms of a check included -- a branch runs as ordinary
 * steps once it is taken, so its exits count as much as the top level's.
 */
function browserActions(actions: unknown, found: ActionLike[] = []): ActionLike[] {
  if (!Array.isArray(actions)) return found;
  for (const entry of actions) {
    if (!entry || typeof entry !== "object") continue;
    const action = entry as ActionLike;
    if (action.type === "if_check") {
      browserActions(action.then, found);
      if (Array.isArray(action.elseIfs)) {
        for (const arm of action.elseIfs) {
          browserActions((arm as ActionLike | null)?.then, found);
        }
      }
      browserActions(action.otherwise, found);
      continue;
    }
    if (typeof action.type === "string" && BROWSER_ACTIONS.has(action.type)) {
      found.push(action);
    }
  }
  return found;
}

/** A custom job's action chain. Anything else parses to nothing and is left to the chain above. */
function parseActions(raw: string | null): ActionLike[] {
  if (!raw) return [];
  try {
    let config = JSON.parse(raw);
    if (typeof config === "string") config = JSON.parse(config);
    return browserActions(config?.actions);
  } catch {
    return [];
  }
}

/** A step's own pick, or nothing when it is left to follow the job's. */
function stepChoice(action: ActionLike): ProxyChoice | null {
  if (typeof action.proxyId !== "string" || !action.proxyId) return null;
  return {
    proxyId: action.proxyId,
    pool: Array.isArray(action.proxyPool) ? (action.proxyPool as string[]) : undefined,
  };
}

/** Identifies a choice, so two steps can be asked whether they leave by the same exit. */
function choiceKey(choice: ProxyChoice): string {
  return `${choice.proxyId ?? ""}|${[...(choice.pool ?? [])].sort().join(",")}`;
}

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

  const exitName = (id: string): { label: string; missing: boolean } => {
    if (!proxies) proxies = new Map(listProxies().map((p) => [p.id, p]));
    const proxy = proxies.get(id);
    // A pin to an exit that has since gone still says which one, so it can be put back --
    // flagged, because the id reads like a name and the row would otherwise look configured
    if (!proxy) return { label: id, missing: true };
    return { label: proxy.name?.trim() || hostPort(proxy.url), missing: false };
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

  let global: string | null = null;
  // Nothing picked no longer means the host's own address: the global exit stands in for it
  const globalLabel = (): string => (global ??= globalProxyLabel());

  const describe = (choice: ProxyChoice, source: JobProxySource): JobProxy => {
    const id = choice.proxyId;
    if (!id || id === CF_PROXY_DIRECT) {
      const label = globalLabel();
      return label
        ? { kind: "global", label, source }
        : { kind: "direct", label: "", source };
    }
    if (id !== CF_PROXY_RANDOM) {
      const exit = exitName(id);
      return {
        kind: "proxy",
        label: exit.label,
        source,
        ...(exit.missing ? { missing: true } : {}),
      };
    }

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
    const override = fromJob.proxyId
      ? fromJob
      : fromTemplate?.proxyId
        ? fromTemplate
        : null;

    // What a step left on "follow the job's proxy" ends up on, which is also the whole
    // answer for a job that opens no browser at all
    const base: ProxyChoice = override ?? { proxyId: accountProxyId };
    const baseSource: JobProxySource = override
      ? fromJob.proxyId
        ? "job"
        : "template"
      : "account";

    // A step's own pick wins over the job's, so the exits its steps use are what the job
    // leaves by -- the job's own pick reaches only the steps that left theirs blank
    const steps = parseActions(row.config).map((action) => {
      const own = stepChoice(action);
      return own
        ? { choice: own, source: "action" as JobProxySource }
        : { choice: base, source: baseSource };
    });
    const used = steps.length ? steps[0] : { choice: base, source: baseSource };
    const resolved = describe(used.choice, used.source);
    // Steps that disagree have no single answer; the first stands for the job, flagged
    if (steps.some((step) => choiceKey(step.choice) !== choiceKey(used.choice))) {
      resolved.stepsDiffer = true;
    }

    // Telegram stays on the account's exit, whatever the job goes out by, and its client is
    // dialled even by a job whose steps never speak to it -- so an account exit that differs
    // from the one shown is worth naming rather than leaving to be found in a log
    if (accountProxyId && accountProxyId !== used.choice.proxyId) {
      const tg = describe({ proxyId: accountProxyId }, "account");
      resolved.tgLabel = tg.label;
      // Flagged apart from the job's own pick: it is the account's exit that has gone, and
      // the two are separate settings on separate pages
      if (tg.missing) resolved.tgMissing = true;
    }
    return resolved;
  };
}
