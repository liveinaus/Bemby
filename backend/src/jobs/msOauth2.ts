import { fetch as undiciFetch } from "undici";
import { db } from "../db/database";
import type { WebStep } from "../types";

// Turning a signed-in Microsoft account into an OAuth2 refresh token, for a `web_ms_oauth2`
// step. The browser does the half only a browser can do -- sign in as the mailbox, pass the
// second factor, agree to the consent screen -- and lands on the redirect address with a
// one-time `code` in the query string. This module does the other half: it trades that code
// at the token endpoint for the refresh token, which is the value worth keeping.
//
// Not to be confused with msOauth2api.ts beside it: that is a client for the self-hosted
// mailbox-pool service, which consumes tokens like these. Nothing here talks to it.

/** The application (client) id, a setting rather than a step field: one app per panel. */
export const MS_OAUTH_CLIENT_ID_KEY = "ms_oauth_client_id";

/** Where the client secret is kept. Named, never typed into a template or its exports. */
export const MS_OAUTH_CLIENT_SECRET_REF = "{msOauthClientSecret}";

/**
 * Where the authorize call comes back to. Microsoft's own blank page, so nothing has to
 * listen on a port for the redirect -- the code sits in the address bar and is read from
 * there. It must also be registered on the app.
 */
export const MS_OAUTH_REDIRECT_DEFAULT =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";

/** Which sign-in authority: `common` takes personal and work accounts alike. */
export const MS_OAUTH_TENANT_DEFAULT = "common";

/** How long the token call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export type MsOauthExchange = {
  tenant?: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  /** Space-separated, e.g. `offline_access Mail.ReadWrite`. Blank asks for what was consented. */
  scope?: string;
};

export type MsOauthTokens = {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scope: string;
};

export function msOauthClientId(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MS_OAUTH_CLIENT_ID_KEY) as
    | { value: string }
    | undefined;
  return (row?.value ?? "").trim();
}

/**
 * The application a page's OAuth2 steps will sign in against: one named on a step wins over
 * the panel-wide setting. The sign-in address is built from this as well (`{msOauthClientId}`),
 * and it is built long before the step holding the id runs -- so reading only the setting sends
 * the browser to an authorize URL with `client_id=` empty, which Microsoft refuses outright
 * (AADSTS900144) after the whole sign-in wait has already been spent.
 */
export function msOauthClientIdFor(steps: WebStep[], fromSettings: string): string {
  const named = msOauthStepsIn(steps)
    .map((s) => (s.clientId ?? "").trim())
    .find(Boolean);
  return named || fromSettings.trim();
}

/** Every OAuth2 step on the page, loops and branches included -- that is where they live. */
export function msOauthStepsIn(
  steps: WebStep[] | undefined,
): Array<Extract<WebStep, { type: "web_ms_oauth2" }>> {
  const found: Array<Extract<WebStep, { type: "web_ms_oauth2" }>> = [];
  for (const step of steps ?? []) {
    if (step.type === "web_ms_oauth2") found.push(step);
    else if ("steps" in step) found.push(...msOauthStepsIn(step.steps));
  }
  return found;
}

/**
 * The `code` the redirect carries, or the reason there is none.
 *
 * Both halves matter. A redirect holding `error=access_denied` means the consent screen was
 * refused, which reads on the page as an ordinary blank page -- indistinguishable from a run
 * that simply arrived too early unless the query string is read.
 */
export function authCodeFromUrl(raw: string): { code?: string; error?: string } {
  let params: URLSearchParams;
  try {
    const url = new URL(raw);
    params = url.searchParams;
    // Some flows come back on the fragment (`#code=...`) rather than the query string
    if (!params.get("code") && !params.get("error") && url.hash.length > 1) {
      params = new URLSearchParams(url.hash.slice(1));
    }
  } catch {
    return { error: `\`${raw}\` is not an address the code could be read from` };
  }

  const code = params.get("code");
  if (code) return { code };

  const error = params.get("error");
  if (error) {
    const detail = params.get("error_description");
    return { error: detail ? `${error}: ${oneLine(detail)}` : error };
  }
  return {};
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Trades the code for tokens. The secret is optional: an app registered as a public client
 * has none, and sending an empty one is refused outright by the endpoint.
 */
export async function exchangeAuthCode(
  q: MsOauthExchange,
  signal?: AbortSignal,
): Promise<MsOauthTokens> {
  const tenant = (q.tenant ?? "").trim() || MS_OAUTH_TENANT_DEFAULT;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: q.clientId,
    grant_type: "authorization_code",
    code: q.code,
    redirect_uri: q.redirectUri,
  });
  if (q.clientSecret) form.set("client_secret", q.clientSecret);
  if (q.scope?.trim()) form.set("scope", q.scope.trim());

  let res;
  try {
    res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(`Microsoft's token endpoint is unreachable: ${err?.message ?? err}`);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Reported by status alone below
  }

  if (!res.ok) {
    // `error_description` carries the AADSTS code, which is the part worth reading: a wrong
    // redirect address and an expired code are the same HTTP 400 without it
    const detail = body?.error_description
      ? oneLine(String(body.error_description))
      : (body?.error ?? `HTTP ${res.status}`);
    throw new Error(`Microsoft refused the code exchange: ${detail}`);
  }

  const refreshToken = String(body?.refresh_token ?? "");
  if (!refreshToken) {
    // Without `offline_access` among the scopes the exchange succeeds and hands back an
    // access token alone, which expires within the hour and is of no use to a mailbox client
    throw new Error(
      "Microsoft issued no refresh token -- ask for the `offline_access` scope on the sign-in URL",
    );
  }
  return {
    refreshToken,
    accessToken: String(body?.access_token ?? ""),
    expiresIn: Number(body?.expires_in ?? 0),
    scope: String(body?.scope ?? ""),
  };
}
