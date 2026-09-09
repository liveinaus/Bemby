// How a job gets a Telegram connection.
//
// Every `client.connect()` sends one `InvokeWithLayer{ initConnection{ ... } }`, and that is
// the request Telegram flood-limits per exit IP. Building a throwaway client per job run made
// the connect count scale with the job count, which is what produced the waits of several
// hundred seconds across accounts that each had their own api_id.
//
// So a job borrows the account's pooled client instead -- the same one the messenger keeps
// open -- and only falls back to a throwaway when the pool cannot serve it: no accountId to
// look up, or a caller that deliberately passed credentials, a session or an exit other than
// the account's stored ones (a manual run, or a test).

import { TelegramClient, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";
import { leaseLiveClient, liveClientIdentity } from "./liveClient";
import {
  OP_TIMEOUT_MS,
  connectWithTimeout,
  destroyQuietly,
  withTimeout,
} from "./clientTimeout";
import {
  accountScope,
  exitScope,
  floodWaitRemainingMs,
  floodWaitMessage,
  noteFloodWait,
  parseFloodWaitSeconds,
} from "./floodWait";

/** The account a job runs as, as far as connection reuse and flood-wait scoping care. */
export type JobAccountRef = { id: number; proxyId: string | null };

export type JobClientRequest = {
  /** Names the operation in timeout and teardown messages. */
  label: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
  /** Omit to force a throwaway client; with it, the pooled client is preferred. */
  accountId?: number;
  /** The account's exit, for scoping a flood wait. Null means the host's own address. */
  proxyId?: string | null;
  proxy?: TgProxy;
  deviceParams?: TgDeviceParams;
};

export type JobClientHandle = {
  client: TelegramClient;
  /** True when the client is the pooled one, which the caller must never destroy. */
  pooled: boolean;
  /** Drops the lease, or tears down the throwaway. Safe to call more than once. */
  release: () => Promise<void>;
};

/** Raised instead of connecting while a recorded wait is still running. */
export class FloodWaitPendingError extends Error {
  readonly remainingMs: number;
  constructor(remainingMs: number) {
    super(floodWaitMessage(remainingMs));
    this.name = "FloodWaitPendingError";
    this.remainingMs = remainingMs;
  }
}

function scopesFor(req: JobClientRequest): string[] {
  const scopes = [exitScope(req.proxyId)];
  if (req.accountId != null) scopes.push(accountScope(req.accountId));
  return scopes;
}

/** The pool authenticates from the stored row, so it can only stand in for a matching request. */
function poolCanServe(req: JobClientRequest): boolean {
  if (req.accountId == null) return false;
  const identity = liveClientIdentity(req.accountId);
  return (
    !!identity &&
    identity.apiId === req.apiId &&
    identity.sessionString === req.sessionString
  );
}

/**
 * A connected client for the job, plus the matching release.
 *
 * Refuses outright while a wait recorded earlier is still running, and records any wait the
 * connect itself raises: reconnecting inside a wait is what used to push 60 seconds up to 500.
 */
export async function acquireJobClient(
  req: JobClientRequest,
): Promise<JobClientHandle> {
  const scopes = scopesFor(req);
  const remaining = floodWaitRemainingMs(scopes);
  if (remaining > 0) throw new FloodWaitPendingError(remaining);

  try {
    if (poolCanServe(req)) {
      const lease = await leaseLiveClient(req.accountId!);
      return {
        client: lease.client,
        pooled: true,
        release: async () => lease.release(),
      };
    }

    const client = new TelegramClient(
      new StringSession(req.sessionString),
      req.apiId,
      req.apiHash,
      {
        connectionRetries: 5,
        autoReconnect: false,
        baseLogger: new Logger(LogLevel.NONE),
        ...(req.proxy ? { proxy: req.proxy } : {}),
        ...(req.deviceParams ?? {}),
      },
    );
    // Bounded: an unreachable proxy otherwise leaves connect pending with nothing to cancel
    // it, which stalls the account and everything queued behind it.
    await connectWithTimeout(client, req.label);
    return {
      client,
      pooled: false,
      release: async () => destroyQuietly(client, req.label),
    };
  } catch (err) {
    const seconds = parseFloodWaitSeconds(err);
    if (seconds != null) {
      noteFloodWait(scopes, seconds);
      console.warn(
        `[tg] ${req.label}: flood wait of ${seconds}s on connect; holding off ` +
          `${scopes.join(" and ")} until it passes`,
      );
    }
    throw err;
  }
}

/**
 * Acquire, run, always release. The operation is bounded like the connect is, so a stalled
 * RPC fails this account rather than the bulk loop it sits in. The pooled client is left
 * connected on purpose.
 */
export async function withJobClient<T>(
  req: JobClientRequest,
  fn: (client: TelegramClient) => Promise<T>,
  ms: number = OP_TIMEOUT_MS,
): Promise<T> {
  const handle = await acquireJobClient(req);
  try {
    return await withTimeout(fn(handle.client), ms, req.label);
  } finally {
    await handle.release();
  }
}
