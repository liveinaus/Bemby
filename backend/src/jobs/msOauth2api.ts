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

/**
 * A mailbox address as msOauth2api keys it: trimmed and lower-cased. The service normalises on
 * its callback, so every lookup here has to match that or a connected mailbox reads as missing.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether this deployment offers the integration at all, set by MSOAUTH2API ("1"/"true") the
 * way the data store is set by DATA_MANAGEMENT. Off is off for everyone: no Settings section,
 * no address source on a login-email run, no pool steps in the step editor and no API behind
 * any of it, whatever is stored. Most panels have no msOauth2api install to point at, and are
 * simpler without the question.
 */
export function isMsApiEnabled(): boolean {
  const v = (process.env.MSOAUTH2API ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function msApiConfig(): MsApiConfig {
  return {
    baseUrl: normaliseBaseUrl(setting(MSAPI_BASE_URL_KEY)),
    apiKey: setting(MSAPI_API_KEY_SETTING),
    poolType: setting(MSAPI_POOL_TYPE_KEY) || DEFAULT_MSAPI_POOL_TYPE,
  };
}

/**
 * Whether a run can actually use the pool: offered by the deployment, and holding both halves
 * of the credential -- the endpoints are never public, so a URL alone reaches nothing.
 */
export function msApiConfigured(): boolean {
  if (!isMsApiEnabled()) return false;
  const cfg = msApiConfig();
  return Boolean(cfg.baseUrl && cfg.apiKey);
}

/** Why the pool is unavailable, naming the switch that would change it. */
export function msApiOffReason(): string {
  return isMsApiEnabled()
    ? "msOauth2api is not configured (see Settings)"
    : "msOauth2api is not enabled on this server (set MSOAUTH2API=1)";
}

/** The type a run acts on: what it asked for, else the configured default. */
export function resolvePoolType(requested?: string): string {
  return (requested ?? "").trim() || msApiConfig().poolType;
}

function requireConfig(): MsApiConfig {
  if (!isMsApiEnabled()) throw new Error(msApiOffReason());
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
  const method = opts.method ?? "GET";
  const url = new URL(`${cfg.baseUrl}/api/${path}`);
  const jsonBody: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
    jsonBody[key] = String(value);
  }

  // A POST also carries its params in the JSON body: newer endpoints (oauth/start) read the
  // body and ignore the query string, older ones read the query string, so sending both keeps
  // every version working. GET has no body.
  const sendBody = method === "POST" && Object.keys(jsonBody).length > 0;

  let res;
  try {
    res = await undiciFetch(url, {
      method,
      headers: {
        "X-API-Key": cfg.apiKey,
        Accept: "application/json",
        ...(sendBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(sendBody ? { body: JSON.stringify(jsonBody) } : {}),
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
    // Lower-cased for the same reason as the oauth calls: the service keys mailboxes in lower
    // case, so a mixed-case address reads back as "no stored account".
    email: normaliseEmail(opts.email),
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

export type OauthFlowStart = {
  authorizeUrl: string;
  state: string;
  expiresAt: number;
  redirectUri: string;
};

export type AccountStatus = {
  stored: boolean;
  disabled?: boolean;
  lastRefreshError?: string | null;
};

/**
 * Asks msOauth2api for a sign-in address that will connect one mailbox.
 *
 * The service owns the whole OAuth2 side of this: the application registration, the redirect
 * address, the PKCE pair and the scopes. It also owns the exchange -- the browser lands on
 * its callback, which trades the code and stores the account. So Bemby never handles a client
 * id, a client secret or a refresh token; it only drives the sign-in in between.
 */
export async function startOauthFlow(
  email: string,
  authType?: string,
  signal?: AbortSignal,
): Promise<OauthFlowStart> {
  // msOauth2api stores and looks the mailbox up in lower case (the callback normalises it),
  // so start it the same way -- otherwise a mixed-case address signs in fine but the later
  // status check for the same string comes back "not stored" and the confirm fails.
  const { body } = await call("oauth/start", {
    method: "POST",
    params: { email: normaliseEmail(email), authType: (authType ?? "").trim() || undefined },
    signal,
  });
  const authorizeUrl = String(body?.authorizeUrl ?? "");
  if (!authorizeUrl) throw new Error("msOauth2api returned no sign-in address");
  return {
    authorizeUrl,
    state: String(body?.state ?? ""),
    expiresAt: Number(body?.expiresAt ?? 0),
    redirectUri: String(body?.redirectUri ?? ""),
  };
}

/**
 * Whether msOauth2api holds this address, which is how a connection is confirmed.
 *
 * Asked of the service rather than read off the callback page: the page is HTML meant for a
 * person, and the service is the only thing that knows whether the token actually landed.
 * A 404 is the ordinary "not connected" answer, not a failure.
 */
export async function accountStatus(
  email: string,
  signal?: AbortSignal,
): Promise<AccountStatus> {
  const { status, body } = await call("email-status", {
    params: { email: normaliseEmail(email) },
    allowStatus: [404],
    signal,
  });
  if (status === 404) return { stored: false };
  return {
    stored: true,
    disabled: Boolean(body?.disabled),
    lastRefreshError: body?.lastRefreshError ?? null,
  };
}

/** Whether a landed address is msOauth2api's callback, i.e. the sign-in has come back. */
export function isCallbackUrl(raw: string, redirectUri: string): boolean {
  try {
    const landed = new URL(raw);
    const expected = new URL(redirectUri);
    return landed.origin === expected.origin && landed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

/** First 4 and last 4 characters, for showing a stored key without serving it. */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}
