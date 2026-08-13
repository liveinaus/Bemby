import { fetch as undiciFetch } from "undici";
import { db } from "../db/database";

// Client for msOauth2api (https://github.com/liveinaus/msOauth2api), a self-hosted service
// that turns a pool of Microsoft mailboxes into HTTP endpoints. Bemby uses its address pool:
// lease an address that has not been used for a type, hand it to Telegram, then poll for the
// code that arrives. That gives every account a real mailbox of its own, where the Gmail
// route can only give it a plus-tag on one shared inbox.
//
// The base URL and API key are settings; nothing here is ever handed to the browser side.

export const MSAPI_BASE_URL_KEY = "msapi_base_url";
export const MSAPI_API_KEY_SETTING = "msapi_api_key";
export const MSAPI_POOL_TYPE_KEY = "msapi_pool_type";

/** The pool type a lease is scoped to when neither the run nor the settings name one. */
export const DEFAULT_MSAPI_POOL_TYPE = "Telegram";

/** How often the pool is asked again while waiting for a code. */
const POLL_MS = 5_000;

/** How long a single call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export type MsApiConfig = {
  baseUrl: string;
  apiKey: string;
  poolType: string;
};

export type LeasedEmail = {
  email: string;
  type: string;
  leasedAt?: number;
  leaseExpiresAt?: number;
  remaining?: number;
};

export type PoolStatus = {
  available: number;
  leased: number;
  confirmed: number;
};

export type PoolCode = {
  code: string;
  from?: string;
  subject?: string;
  mailbox?: string;
};

function setting(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return (row?.value ?? "").trim();
}

/**
 * Accepts what an operator is likely to paste: with or without a trailing slash, and with or
 * without the `/api` the endpoints already carry.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/api$/i, "");
}

export function msApiConfig(): MsApiConfig {
  return {
    baseUrl: normaliseBaseUrl(setting(MSAPI_BASE_URL_KEY)),
    apiKey: setting(MSAPI_API_KEY_SETTING),
    poolType: setting(MSAPI_POOL_TYPE_KEY) || DEFAULT_MSAPI_POOL_TYPE,
  };
}

/** Both halves are needed: the endpoints are never public, so a URL alone reaches nothing. */
export function msApiConfigured(): boolean {
  const cfg = msApiConfig();
  return Boolean(cfg.baseUrl && cfg.apiKey);
}

/** The type a run acts on: what it asked for, else the configured default. */
export function resolvePoolType(requested?: string): string {
  return (requested ?? "").trim() || msApiConfig().poolType;
}

function requireConfig(): MsApiConfig {
  const cfg = msApiConfig();
  if (!cfg.baseUrl)
    throw new Error("no msOauth2api base URL is set (see Settings)");
  if (!cfg.apiKey) throw new Error("no msOauth2api API key is set (see Settings)");
  return cfg;
}

type CallOptions = {
  method?: "GET" | "POST";
  params?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Statuses to hand back rather than throw on, e.g. 409 for an exhausted pool. */
  allowStatus?: number[];
};

/**
 * One call to the service. The key goes in the header rather than the query string so it
 * stays out of the far side's access log.
 */
async function call(
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; body: any }> {
  const cfg = requireConfig();
  const url = new URL(`${cfg.baseUrl}/api/${path}`);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await undiciFetch(url, {
      method: opts.method ?? "GET",
      headers: { "X-API-Key": cfg.apiKey, Accept: "application/json" },
      signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(`msOauth2api unreachable at ${cfg.baseUrl}: ${err?.message ?? err}`);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body is still worth reporting by status alone
  }

  if (!res.ok && !opts.allowStatus?.includes(res.status)) {
    const detail = body?.error ?? `HTTP ${res.status}`;
    throw new Error(
      res.status === 401
        ? `msOauth2api rejected the API key (${detail})`
        : `msOauth2api: ${detail}`,
    );
  }
  return { status: res.status, body };
}

/** Capacity for a type, and the first call that proves the URL and key work. */
export async function poolStatus(type?: string): Promise<PoolStatus> {
  const { body } = await call("pool-status", {
    params: { type: resolvePoolType(type) },
  });
  return {
    available: Number(body?.available ?? 0),
    leased: Number(body?.leased ?? 0),
    confirmed: Number(body?.confirmed ?? 0),
  };
}

/**
 * Takes the next address unused for this type. The claim lapses on its own, so an abandoned
 * run does not consume an address for good -- but a failed run still releases it explicitly.
 */
export async function leaseEmail(
  type?: string,
  signal?: AbortSignal,
): Promise<LeasedEmail> {
  const poolType = resolvePoolType(type);
  const { status, body } = await call("get-available-email", {
    method: "POST",
    params: { type: poolType },
    allowStatus: [409],
    signal,
  });
  if (status === 409) {
    const counts = `available ${body?.available ?? 0}, leased ${body?.leased ?? 0}, confirmed ${body?.confirmed ?? 0}`;
    throw new Error(`no msOauth2api address left for "${poolType}" (${counts})`);
  }
  if (!body?.email) throw new Error("msOauth2api returned no address");
  return { ...body, email: String(body.email), type: poolType };
}

/** Hands an address back, for a run that got no code. Best effort: never masks the real error. */
export async function releaseEmail(email: string, type?: string): Promise<void> {
  await call("release-email", {
    method: "POST",
    params: { email, type: resolvePoolType(type) },
  }).catch(() => undefined);
}

export type PollCodeOptions = {
  email: string;
  type?: string;
  /** Case-insensitive sender filter. Blank leaves it to the type's rules in the panel. */
  fromContains?: string;
  subjectContains?: string;
  /** Ignore mail older than this. Blank defaults to when the address was leased. */
  sinceMs?: number;
  waitMs: number;
  signal?: AbortSignal;
};

/**
 * Polls until the code arrives or the wait runs out. `get-code` answers 200 either way, so
 * "not yet" is read off `status` and only a real failure throws.
 */
export async function pollForCode(opts: PollCodeOptions): Promise<PoolCode | null> {
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  const params = {
    email: opts.email,
    type: resolvePoolType(opts.type),
    from: opts.fromContains,
    subject: opts.subjectContains,
    since: opts.sinceMs,
  };

  // Try at least once even on a spent budget: the mail may already be sitting there
  while (true) {
    const { body } = await call("get-code", { params, signal: opts.signal });
    if (body?.status === "found" && body?.code) {
      return {
        code: String(body.code),
        from: body?.message?.from,
        subject: body?.message?.subject,
        mailbox: body?.message?.mailbox,
      };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
  }
}

/** First 4 and last 4 characters, for showing a stored key without serving it. */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}
