import { db } from "../db/database";
import { testStoredProxies } from "./proxyHealth";
import { readProviders, syncProviders, type SyncResult } from "./proxyProviders";

// Pulling the providers' lists in again on a timer, which is what keeps a subscription
// current: a Worker that rotates its nodes, or gains one, is otherwise only noticed when
// somebody opens Settings and presses refresh. A health test alone cannot do this -- it
// judges the exits already stored, so a node whose remote identity changed just fails and
// stays out of the pool.

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | undefined)?.value;
}

/** How often every enabled provider is refreshed on its own, in minutes. 0 turns it off. */
export const PROXY_PROVIDER_SYNC_INTERVAL_KEY = "proxy_provider_sync_interval_minutes";

/** Longest interval accepted, in minutes: a week, past which an interval is not a schedule. */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** Minutes between automatic refreshes, as configured. 0 (the default) leaves them to the operator. */
export function proxyProviderSyncIntervalMinutes(): number {
  const minutes = Math.floor(Number(readSetting(PROXY_PROVIDER_SYNC_INTERVAL_KEY) ?? 0));
  return Number.isFinite(minutes) && minutes > 0
    ? Math.min(minutes, MAX_INTERVAL_MINUTES)
    : 0;
}

export type SyncAndTestResult = SyncResult & {
  /** How many of the freshly imported exits were tested, and how many answered. */
  tested: number;
  reachable: number;
};

// A refresh reads the proxy list and writes it back, and so does the test that follows, so
// two of them at once would lose one's work. Queued rather than rejected: a press of the
// button while the timer is mid-refresh should still take effect.
let queue: Promise<unknown> = Promise.resolve();

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Refreshes the providers' lists and tests what came back. A freshly imported list is of
 * unknown health, and an exit that does not answer should be disabled before a job draws it
 * rather than after. Shared by the Settings button and the automatic refresh so both leave
 * the pool in the same state.
 */
export function syncAndTestProviders(
  onlyProviderId?: string,
): Promise<SyncAndTestResult> {
  return serialised(async () => {
    const result = await syncProviders(onlyProviderId);
    const tested = result.syncedProviderIds.length
      ? await testStoredProxies({ providerIds: result.syncedProviderIds })
      : [];
    return {
      ...result,
      tested: tested.length,
      reachable: tested.filter((r) => r.ok).length,
    };
  });
}

let syncTimer: ReturnType<typeof setInterval> | undefined;
let firstRunTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Delay before the first automatic refresh of a boot. Long enough that a restart loop does
 * not hammer the providers' APIs, short enough that a deployment restarted daily still gets
 * refreshed -- an interval alone would keep resetting its clock and never fire.
 */
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

/**
 * Arms the automatic provider refresh. Called again whenever the interval is changed.
 */
export function startProxyProviderSync(): void {
  stopProxyProviderSync();
  const minutes = proxyProviderSyncIntervalMinutes();
  if (!minutes) return;

  const run = () => {
    // Nothing enabled means nothing to fetch, and `syncProviders` would only throw
    if (!readProviders().some((p) => p.enabled !== false)) return;
    syncAndTestProviders()
      .then((result) => {
        const failed = result.providers.filter((p) => !p.ok);
        console.log(
          `[proxy] provider refresh: +${result.added} ~${result.updated} -${result.removed}, ` +
            `${result.reachable}/${result.tested} reachable` +
            (failed.length ? `, failed: ${failed.map((p) => p.name).join(", ")}` : ""),
        );
      })
      .catch((err) =>
        console.error(`[proxy] provider refresh failed: ${err?.message ?? err}`),
      );
  };
  const period = minutes * 60 * 1000;
  // The repeat is armed by the first run rather than alongside it: an interval shorter than
  // the boot delay would otherwise have its first tick land on the same instant as that run
  // and refresh twice. The delay only keeps a restart loop off the providers' APIs, so a
  // short interval starts sooner than it.
  firstRunTimer = setTimeout(() => {
    run();
    syncTimer = setInterval(run, period);
    syncTimer.unref();
  }, Math.min(FIRST_RUN_DELAY_MS, period));
  firstRunTimer.unref();
  console.log(`[proxy] provider refresh every ${minutes}m`);
}

export function stopProxyProviderSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  if (firstRunTimer) clearTimeout(firstRunTimer);
  syncTimer = undefined;
  firstRunTimer = undefined;
}
