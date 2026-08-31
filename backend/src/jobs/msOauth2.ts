import type { WebStep } from "../types";

// Connecting a Microsoft mailbox to msOauth2api, for the `web_ms_oauth2_start` and
// `web_ms_oauth2` steps. The browser does the half only a browser can do -- sign in as the
// mailbox, pass the second factor, agree to the consent screen -- and lands back on
// msOauth2api's callback, which trades the one-time code and stores the account.
//
// Nothing about the OAuth2 application lives here any more. The registration, its redirect
// address, the PKCE pair and the scopes are all msOauth2api's, so Bemby holds no client id,
// no client secret, and never sees a refresh token. See msOauth2api.ts beside this for the
// calls that drive it.

/** Every OAuth2 step on the page, loops and branches included -- that is where they live. */
export function msOauthStepsIn(
  steps: WebStep[] | undefined,
): Array<Extract<WebStep, { type: "web_ms_oauth2" | "web_ms_oauth2_start" }>> {
  const found: Array<Extract<WebStep, { type: "web_ms_oauth2" | "web_ms_oauth2_start" }>> = [];
  for (const step of steps ?? []) {
    if (step.type === "web_ms_oauth2" || step.type === "web_ms_oauth2_start") found.push(step);
    else if ("steps" in step) found.push(...msOauthStepsIn(step.steps));
  }
  return found;
}

/**
 * The refusal a redirect carries, if any.
 *
 * Worth reading even though msOauth2api does the exchange: a declined consent screen comes
 * back as `error=access_denied` and renders as an ordinary page, indistinguishable from a
 * run that simply arrived too early unless the query string is read.
 */
export function authErrorFromUrl(raw: string): string | null {
  let params: URLSearchParams;
  try {
    const url = new URL(raw);
    params = url.searchParams;
    if (!params.get("error") && url.hash.length > 1) {
      params = new URLSearchParams(url.hash.slice(1));
    }
  } catch {
    return null;
  }

  const error = params.get("error");
  if (!error) return null;
  const detail = params.get("error_description");
  return detail ? `${error}: ${oneLine(detail)}` : error;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
