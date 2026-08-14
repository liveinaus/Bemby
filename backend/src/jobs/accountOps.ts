import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import {
  checkAccountStatus,
  getPasswordInfo,
  getPasskeys,
  registerPasskey,
  deletePasskey,
  getSessionDc,
  terminateOtherSessions,
  updateTwoFa,
  verifyPasskeyLogin,
  type TgAccountStatus,
  type TgDeviceParams,
} from "../auth/tgAuth";
import type { Passkey, PasskeyLoginVerification } from "../tg/passkeys";
import { checkSpamStatus } from "./checkin";
import { changeLoginEmailViaGmail, changeLoginEmailViaPool } from "./bulkLoginEmail";
import { parseTgProxy } from "./runner";
import { resolveAppClientParams } from "../tg/appClient";
import {
  cleanAccount,
  getLiveClient,
  isAuthError,
  markSessionExpired,
  syncDialogsInBackground,
  type TgCleanResult,
} from "../tg/liveClient";
import {
  deletePasskeySecret,
  getPasskeySecret,
  pruneAccountPasskeySecrets,
  savePasskeySecret,
  storedPasskeyIdsForAccount,
} from "../tg/passkeyStore";
import { hardenPrivacy, type PrivacyResult } from "../tg/privacy";
import { parseAttributes, patchAttributes } from "../db/accountAttributes";
import type { AuthStatus, TgProxy } from "../types";

// Single-account Telegram operations shared by the account routes and the
// background bulk tasks, so both go through the same credential resolution,
// bookkeeping and expired-session handling.

export type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: AuthStatus;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
  sort_order: number;
  tg_display_name: string | null;
  tg_username: string | null;
  notes: string | null;
  passkey: string | null;
  additional_attributes: string | null;
};

/**
 * Loads one account with its credential columns decrypted. Every caller goes through this
 * rather than querying directly, so the decryption cannot be forgotten at a call site
 * (see db/secretColumns for why the columns are encrypted at all).
 */
export function loadAccount(
  id: string | number | bigint,
): AccountRow | undefined {
  const row = db.prepare("SELECT * FROM tg_accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  return row ? decryptAccountRow(row) : undefined;
}

/** Resolves effective API credentials, falling back to global defaults. Throws if neither is set. */
export function resolveApiCredentials(account: AccountRow): {
  apiId: number;
  apiHash: string;
} {
  const ownCredentials =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  const apiId = credentials?.apiId;
  const apiHash = credentials?.apiHash;
  if (!apiId || !apiHash) {
    throw new Error(
      "No API credentials available. Add credentials to this account or configure global defaults in Settings.",
    );
  }
  return { apiId, apiHash };
}

export function resolveProxyUrl(
  proxyId: string | null | undefined,
): string | undefined {
  if (!proxyId) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

export type AccountExit = {
  proxy: TgProxy | undefined;
  /** How the exit reads in a result or a log line: host:port, or "direct". */
  label: string;
};

/**
 * The exit an account's Telegram traffic leaves by. An account that names a proxy which is no
 * longer configured -- or which is not SOCKS, so MTProto cannot use it -- is an error rather
 * than a quiet fall back to the server's own address: a run that unknowingly puts many accounts
 * behind one IP is what Telegram answers by dropping what it was asked to send (login-email
 * codes first of all), and nothing about it would otherwise be visible.
 */
export function resolveAccountExit(account: AccountRow): AccountExit {
  if (!account.proxy_id) return { proxy: undefined, label: "direct" };
  const url = resolveProxyUrl(account.proxy_id);
  if (!url)
    throw new Error(
      `The account's proxy (${account.proxy_id}) is not configured on this server; assign one in Settings > Proxies, or clear it to connect direct`,
    );
  const proxy = parseTgProxy(url);
  if (!proxy)
    throw new Error(
      "The account's proxy cannot carry Telegram (an account proxy must be socks5:// or socks4://)",
    );
  return { proxy, label: `${proxy.ip}:${proxy.port}` };
}

export type AccountOpContext = {
  account: AccountRow & { session_string: string };
  apiId: number;
  apiHash: string;
  proxy: TgProxy | undefined;
  /** Exit label for results and logs; see resolveAccountExit. */
  exit: string;
  deviceParams: TgDeviceParams | undefined;
};

/** Everything a Telegram call on this account needs. Throws when it cannot be assembled. */
export function accountOpContext(accountId: number): AccountOpContext {
  const account = loadAccount(accountId);
  if (!account) throw new Error("Account not found");
  if (!account.session_string) throw new Error("Account is not authenticated");
  const { apiId, apiHash } = resolveApiCredentials(account);
  const exit = resolveAccountExit(account);
  return {
    account: account as AccountRow & { session_string: string },
    apiId,
    apiHash,
    proxy: exit.proxy,
    exit: exit.label,
    deviceParams: resolveAppClientParams(account.id, account.app_client_id),
  };
}

/** Flags the stored session as expired when the error says it is gone, then rethrows. */
function rethrowTracking(accountId: number, err: any): never {
  if (isAuthError(err?.message ?? "")) markSessionExpired(accountId);
  throw err;
}

// Reasons set by checkAccountStatus for frozen/revoked sessions that need re-auth
const REAUTH_REASONS = new Set([
  "auth_key_duplicated",
  "session_revoked",
  "auth_key_unregistered",
  "account_frozen",
]);

export function statusNeedsReauth(status: TgAccountStatus): boolean {
  return status.restrictions.some((r) =>
    REAUTH_REASONS.has(r.reason.toLowerCase()),
  );
}

export function saveTgMeta(
  id: number,
  firstName: string,
  lastName: string | undefined,
  username: string | undefined,
): void {
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  db.prepare(
    "UPDATE tg_accounts SET tg_display_name = ?, tg_username = ? WHERE id = ?",
  ).run(displayName || null, username || null, id);
}

/** Asks @SpamBot for the account's standing and persists the restriction flag. */
export async function checkSpamForAccount(
  accountId: number,
): Promise<{ spamStatus: string; rawMessage: string }> {
  const ctx = accountOpContext(accountId);
  try {
    const result = await checkSpamStatus(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
    // Store the status while restricted, clear it once confirmed free, and leave
    // an existing value alone on an unknown result.
    if (result.spamStatus === "free") {
      patchAttributes(accountId, { restriction: undefined });
    } else if (result.spamStatus !== "unknown") {
      patchAttributes(accountId, { restriction: result.spamStatus });
    }
    return result;
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/**
 * Refreshes TG meta and extra attributes (display name/username, hasEmail, hasPasskey).
 * Deliberately excludes the spam check. Each step runs independently so one failure does
 * not block the rest; per-step failures come back as warnings.
 */
export async function fetchAttributesForAccount(
  accountId: number,
): Promise<{ warnings: string[]; authExpired: boolean }> {
  const ctx = accountOpContext(accountId);
  const warnings: string[] = [];
  let authExpired = false;

  // Skip remaining steps once the session is known dead; they would only fail too.
  const runStep = async (label: string, fn: () => Promise<void>) => {
    if (authExpired) return;
    try {
      await fn();
    } catch (err: any) {
      if (isAuthError(err?.message ?? "")) {
        markSessionExpired(accountId);
        authExpired = true;
      }
      warnings.push(
        `${label}: ${err?.errorMessage ?? err?.message ?? "failed"}`,
      );
    }
  };

  await runStep("status", async () => {
    const status = await checkAccountStatus(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
    if (statusNeedsReauth(status)) {
      markSessionExpired(accountId);
      authExpired = true;
    }
    saveTgMeta(accountId, status.firstName, status.lastName, status.username);
  });
  await runStep("password-info", async () => {
    const info = await getPasswordInfo(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
    // A Telegram account with no login email cannot still have one Bemby set, so the stored
    // address goes with the flag rather than lingering as a stale badge
    patchAttributes(accountId, {
      hasEmail: info.loginEmailPattern ? true : undefined,
      ...(info.loginEmailPattern ? {} : { loginEmail: undefined }),
    });
  });
  await runStep("passkeys", async () => {
    const passkeys = await getPasskeys(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
    pruneAccountPasskeySecrets(
      accountId,
      passkeys.map((p) => p.id),
    );
    patchAttributes(accountId, { hasPasskey: passkeys.length > 0 });
  });

  return { warnings, authExpired };
}

/**
 * Lists the account's passkeys. Telegram is authoritative: stored keys for passkeys that no
 * longer exist there (e.g. dropped when the 2FA password changed) are pruned, so storedIds
 * stays accurate.
 */
export async function listPasskeysForAccount(
  accountId: number,
): Promise<{ passkeys: Passkey[]; storedIds: string[] }> {
  const ctx = accountOpContext(accountId);
  try {
    const passkeys = await getPasskeys(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
    pruneAccountPasskeySecrets(
      accountId,
      passkeys.map((p) => p.id),
    );
    patchAttributes(accountId, { hasPasskey: passkeys.length > 0 });
    return { passkeys, storedIds: storedPasskeyIdsForAccount(accountId) };
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/** Registers a passkey and stores its private key so it can later be used for login. */
export async function registerPasskeyForAccount(
  accountId: number,
  origin?: string,
): Promise<{ passkey: Passkey }> {
  const ctx = accountOpContext(accountId);
  try {
    const result = await registerPasskey(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      origin,
      ctx.proxy,
      ctx.deviceParams,
    );
    const dc = getSessionDc(ctx.account.session_string) ?? {};
    savePasskeySecret({
      accountId,
      telegramPasskeyId: result.passkey.id,
      credentialId: result.credentialId,
      privateKeyPem: result.privateKeyPem,
      rpId: result.rpId,
      userHandle: result.userHandle,
      createdDate: result.passkey.date,
      ...dc,
    });
    patchAttributes(accountId, { hasPasskey: true });
    return { passkey: result.passkey };
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/** Proves a Bemby-stored passkey still works by running a real passkey login. */
export async function verifyStoredPasskeyForAccount(
  accountId: number,
  passkeyId: string,
  origin?: string,
): Promise<PasskeyLoginVerification> {
  const secret = getPasskeySecret(passkeyId);
  if (!secret || secret.accountId !== accountId) {
    throw new Error("No stored key for this passkey");
  }
  const ctx = accountOpContext(accountId);
  return await verifyPasskeyLogin(
    ctx.apiId,
    ctx.apiHash,
    ctx.account.session_string,
    secret,
    origin,
    ctx.proxy,
    ctx.deviceParams,
  );
}

export async function deletePasskeyForAccount(
  accountId: number,
  passkeyId: string,
): Promise<{ ok: boolean }> {
  const ctx = accountOpContext(accountId);
  try {
    const ok = await deletePasskey(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      passkeyId,
      ctx.proxy,
      ctx.deviceParams,
    );
    if (ok) deletePasskeySecret(passkeyId);
    return { ok };
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

export async function updateTwoFaForAccount(
  accountId: number,
  opts: { currentPassword?: string; newPassword?: string; hint?: string },
): Promise<void> {
  const ctx = accountOpContext(accountId);
  try {
    await updateTwoFa(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      opts,
      ctx.proxy,
      ctx.deviceParams,
    );
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

export async function terminateOtherSessionsForAccount(
  accountId: number,
): Promise<void> {
  const ctx = accountOpContext(accountId);
  try {
    await terminateOtherSessions(
      ctx.apiId,
      ctx.apiHash,
      ctx.account.session_string,
      ctx.proxy,
      ctx.deviceParams,
    );
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/**
 * Where the new login email comes from: a plus-address on one Gmail inbox, read over IMAP, or
 * a mailbox of its own leased from the msOauth2api pool.
 */
export type LoginEmailSource =
  | { source?: "gmail"; gmail: string; appPassword: string; tag: string }
  | { source: "msapi"; poolType?: string };

/**
 * Points the account's login email at a new address and confirms it with the emailed code.
 * The exit comes back with the address: Telegram stops delivering these codes when a run puts
 * account after account behind one IP, so which exit each change went out by is the first thing
 * worth seeing when a bulk run only ever gets one code.
 */
export async function changeLoginEmailForAccount(
  accountId: number,
  opts: LoginEmailSource,
): Promise<{ email: string; exit: string }> {
  const ctx = accountOpContext(accountId);
  try {
    const result =
      opts.source === "msapi"
        ? await changeLoginEmailViaPool({
            apiId: ctx.apiId,
            apiHash: ctx.apiHash,
            sessionString: ctx.account.session_string,
            proxy: ctx.proxy,
            deviceParams: ctx.deviceParams,
            poolType: opts.poolType,
          })
        : await changeLoginEmailViaGmail({
            apiId: ctx.apiId,
            apiHash: ctx.apiHash,
            sessionString: ctx.account.session_string,
            phoneNumber: ctx.account.phone_number,
            accountId,
            proxy: ctx.proxy,
            deviceParams: ctx.deviceParams,
            gmail: opts.gmail,
            appPassword: opts.appPassword,
            tag: opts.tag,
          });
    // The address itself is worth keeping: with a pool mailbox it is the only record of which
    // one this account was given
    patchAttributes(accountId, { hasEmail: true, loginEmail: result.email });
    return { ...result, exit: ctx.exit };
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/** Leaves every group/channel and deletes all private chats for both sides. Irreversible. */
export async function cleanTelegramAccount(
  accountId: number,
): Promise<TgCleanResult> {
  const entry = await getLiveClient(accountId);
  const result = await cleanAccount(entry, accountId);
  syncDialogsInBackground(accountId).catch(() => undefined);
  return result;
}

/** Shuts every privacy setting as far as Telegram allows: nobody where it can, contacts where not. */
export async function hardenPrivacyForAccount(
  accountId: number,
): Promise<PrivacyResult> {
  const entry = await getLiveClient(accountId);
  try {
    return await hardenPrivacy(entry.client);
  } catch (err) {
    rethrowTracking(accountId, err);
  }
}

/** Last known "the Telegram account has some passkey" flag, as recorded by a passkey listing. */
export function accountHasPasskeyFlag(accountId: number): boolean {
  const row = db
    .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { additional_attributes: string | null } | undefined;
  return parseAttributes(row?.additional_attributes ?? null).hasPasskey === true;
}

export function appendAccountNotes(accountId: number, append: string): void {
  const row = db
    .prepare("SELECT notes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { notes: string | null } | undefined;
  const base = row?.notes ? `${row.notes}\n` : "";
  db.prepare("UPDATE tg_accounts SET notes = ? WHERE id = ?").run(
    base + append,
    accountId,
  );
}
