// Wall-clock bounds for anything that talks to Telegram.
//
// GramJS's `connectionRetries` limits how many times it redials, not how long the attempt may
// take: a proxy that accepts the TCP connection and then black-holes the traffic leaves
// `connect()` pending with nothing to cancel it. The await never settles, so a sequential
// runner stops on that account and every account behind it waits forever.
//
// Turning the stall into a rejection is what lets a caller fail the one account and carry on,
// which is the behaviour every bulk loop assumes.

const DEFAULT_OP_TIMEOUT_SECONDS = 120;

/** Bound for a connect and for each RPC on a throwaway client. */
export const OP_TIMEOUT_MS =
  Number(process.env.TG_OP_TIMEOUT_SECONDS ?? DEFAULT_OP_TIMEOUT_SECONDS) * 1000;

/** Teardown talks over the same connection, so it can hang on the same dead proxy. */
export const DESTROY_TIMEOUT_MS = 10_000;

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Minimal shape of the client these helpers drive, so callers need not import GramJS. */
type ConnectableClient = {
  connect: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
};

/**
 * Bounds a connect on a client the caller goes on to use itself.
 *
 * For the throwaway connect-act-disconnect shape, prefer `withTgClient` -- this is for the
 * long-lived clients (a checkin, a custom job) that keep working after connecting and tear
 * themselves down in their own `finally`.
 */
export async function connectWithTimeout(
  client: ConnectableClient,
  label: string,
  ms: number = OP_TIMEOUT_MS,
): Promise<void> {
  try {
    await withTimeout(client.connect() as Promise<void>, ms, `${label} connect`);
  } catch (err) {
    // A connect that timed out still holds sockets and a retry loop; drop them before the
    // error travels, or a run over many accounts leaves one client behind per bad proxy.
    await destroyQuietly(client, label);
    throw err;
  }
}

/** Tears a client down without letting a dead connection turn teardown into a second hang. */
export async function destroyQuietly(
  client: ConnectableClient,
  label: string,
): Promise<void> {
  await withTimeout(
    client.destroy() as Promise<void>,
    DESTROY_TIMEOUT_MS,
    `${label} disconnect`,
  ).catch(() => undefined);
}

/**
 * Runs a one-shot operation on a throwaway client: connect, act, always disconnect.
 * Connect, operation and teardown are each bounded, so a dead proxy fails the caller
 * rather than leaving it awaiting forever -- which used to wedge the sequential bulk
 * runners on one account and stall every account behind it.
 */
export async function withTgClient<T, C extends ConnectableClient>(
  client: C,
  label: string,
  fn: (client: C) => Promise<T>,
  ms: number = OP_TIMEOUT_MS,
): Promise<T> {
  try {
    await withTimeout(client.connect() as Promise<void>, ms, `${label} connect`);
    return await withTimeout(fn(client), ms, label);
  } finally {
    await destroyQuietly(client, label);
  }
}
