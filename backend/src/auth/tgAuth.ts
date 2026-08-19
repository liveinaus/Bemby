import { TelegramClient, Api, Logger } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from "../types";
import {
  invokeGetPasskeys,
  invokeDeletePasskey,
  invokeRegisterPasskey,
  invokeVerifyPasskeyLogin,
  invokePasskeyLogin,
  type Passkey,
  type RegisterPasskeyResult,
  type PasskeyLoginVerification,
} from "../tg/passkeys";
import type { PasskeySecret } from "../tg/passkeyStore";
import {
  OP_TIMEOUT_MS,
  withTgClient,
  withTimeout,
} from "../tg/clientTimeout";

export type TgDeviceParams = {
  deviceModel?: string;
  systemVersion?: string;
  appVersion?: string;
  langCode?: string;
  langPack?: string;
  systemLangCode?: string;
};

export type TgAccountStatus = {
  isActive: boolean;
  isDeleted: boolean;
  isRestricted: boolean;
  restrictions: Array<{ platform: string; reason: string; text: string }>;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
};

type PendingAuth = {
  client: TelegramClient;
  phoneNumber: string;
  phoneCodeHash: string;
  step: "code" | "2fa";
  startedAt: number;
};

// In-memory pending auth sessions keyed by account ID
const pending = new Map<number, PendingAuth>();

// Each entry holds a connected TelegramClient, so an auth nobody finishes (the
// browser tab closed at the code prompt, a bulk add that moved on) would pin a
// live connection for the life of the process. Telegram expires login codes in
// minutes, so anything older than this is certainly dead.
const PENDING_AUTH_TTL_MS = 15 * 60_000;
const PENDING_SWEEP_INTERVAL_MS = 5 * 60_000;

export function sweepPendingAuth(now = Date.now()): number {
  let dropped = 0;
  for (const [accountId, entry] of pending) {
    if (now - entry.startedAt < PENDING_AUTH_TTL_MS) continue;
    pending.delete(accountId);
    entry.client.destroy().catch(() => undefined);
    dropped++;
  }
  if (dropped) console.log(`[tgAuth] Dropped ${dropped} abandoned auth session(s)`);
  return dropped;
}

// unref() so the sweep never keeps the process (or test runner) alive
setInterval(() => sweepPendingAuth(), PENDING_SWEEP_INTERVAL_MS).unref();

// Bound on the connect+sendCode round trip, longer than the shared one: a code has to
// travel before this settles. The rest of the reasoning lives in tg/clientTimeout.
const REQUEST_CODE_TIMEOUT_MS = 180_000;

export type SendCodeResult = {
  isCodeViaApp: boolean; // true = sent to Telegram app; false = SMS/call
};

export async function requestCode(
  accountId: number,
  apiId: number,
  apiHash: string,
  phoneNumber: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<SendCodeResult> {
  const existing = pending.get(accountId);
  if (existing) {
    await existing.client.destroy().catch(() => undefined);
    pending.delete(accountId);
  }

  // Do not pass deviceParams during auth -- desktop profiles (PC 64bit / tdesktop)
  // cause Telegram to route the code to a non-existent desktop session.
  // GramJS defaults (Android-like) have reliable SMS/app fallback.
  // The configured device profile is applied only in the live session (getLiveClient).
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
  });
  try {
    await withTimeout(client.connect(), REQUEST_CODE_TIMEOUT_MS, "connect");
    const sent = await withTimeout(
      client.sendCode({ apiId, apiHash }, phoneNumber),
      REQUEST_CODE_TIMEOUT_MS,
      "sendCode",
    );
    const isCodeViaApp =
      (sent as any).type?.className === "auth.SentCodeTypeApp";
    pending.set(accountId, {
      client,
      phoneNumber,
      phoneCodeHash: sent.phoneCodeHash,
      step: "code",
      startedAt: Date.now(),
    });
    return { isCodeViaApp };
  } catch (err) {
    // Nothing holds a reference to this client yet — destroy it so a failed
    // send (bad/blocked number, flood-wait) doesn't leak a connected session.
    await client.destroy().catch(() => undefined);
    throw err;
  }
}

export async function resendCodeAsSms(accountId: number): Promise<void> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");
  const result = await withTimeout(
    entry.client.invoke(
      new Api.auth.ResendCode({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
      }),
    ),
    OP_TIMEOUT_MS,
    "resendCode",
  );
  // Update the hash from the resend response
  entry.phoneCodeHash = (result as any).phoneCodeHash ?? entry.phoneCodeHash;
}

// Destroy and drop a parked pending-auth client. Callers that abandon an
// auth flow mid-way (e.g. bulk-add moving on after a failure) must call this,
// or the connected client leaks -- nothing else evicts it unless requestCode
// is retried for the same account id.
export async function cancelPendingAuth(accountId: number): Promise<void> {
  const entry = pending.get(accountId);
  if (!entry) return;
  pending.delete(accountId);
  await entry.client.destroy().catch(() => undefined);
}

export async function submitCode(
  accountId: number,
  code: string,
): Promise<{ needsPassword: boolean; session?: string }> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");

  try {
    await withTimeout(
      entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phoneNumber,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: code,
        }),
      ),
      OP_TIMEOUT_MS,
      "signIn",
    );

    const session = entry.client.session.save() as unknown as string;
    await entry.client.destroy().catch(() => undefined);
    pending.delete(accountId);
    return { needsPassword: false, session };
  } catch (err: any) {
    if (err?.errorMessage === "SESSION_PASSWORD_NEEDED") {
      entry.step = "2fa";
      // Reaching the password prompt restarts the clock, so a slow 2FA entry
      // isn't swept out from under the user
      entry.startedAt = Date.now();
      return { needsPassword: true };
    }
    throw err;
  }
}

// Telegram error codes that indicate a permanently banned / deactivated account
const BANNED_CODES = [
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "PHONE_NUMBER_BANNED",
];

// Telegram error codes that indicate a frozen or revoked session
const FROZEN_CODES = [
  "ACCOUNT_FROZEN",
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "AUTH_KEY_DUPLICATED",
];

const FROZEN_TEXT: Record<string, string> = {
  ACCOUNT_FROZEN: "Account is frozen by Telegram",
  AUTH_KEY_UNREGISTERED:
    "Session revoked — account may have been banned or logged out everywhere",
  SESSION_REVOKED: "Session was explicitly revoked",
  AUTH_KEY_DUPLICATED: "Auth key duplicated — session is no longer valid",
};

export async function checkAccountStatus(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgAccountStatus> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);

  try {
    return await withTgClient(client, "status check", async (c) => {
      const me = await c.getMe();

      // UserEmpty or null — account deleted / inaccessible
      if (!me || (me as any).className === "UserEmpty") {
        return {
          isActive: false,
          isDeleted: true,
          isRestricted: false,
          restrictions: [],
          firstName: "",
        };
      }

      const user = me as Api.User;
      const isDeleted = Boolean(user.deleted);
      const isRestricted = Boolean(user.restricted);

      return {
        isActive: !isDeleted && !isRestricted,
        isDeleted,
        isRestricted,
        restrictions: (user.restrictionReason ?? []).map((r) => ({
          platform: r.platform,
          reason: r.reason,
          text: r.text,
        })),
        firstName: user.firstName ?? "",
        lastName: user.lastName,
        username: user.username,
        phone: user.phone,
      };
    });
  } catch (err: any) {
    const code: string = err?.errorMessage ?? "";

    if (BANNED_CODES.includes(code)) {
      return {
        isActive: false,
        isDeleted: true,
        isRestricted: false,
        restrictions: [
          {
            platform: "all",
            reason: "banned",
            text: `Account banned by Telegram (${code})`,
          },
        ],
        firstName: "",
      };
    }

    if (FROZEN_CODES.includes(code)) {
      return {
        isActive: false,
        isDeleted: false,
        isRestricted: true,
        restrictions: [
          {
            platform: "all",
            reason: code.toLowerCase(),
            text: FROZEN_TEXT[code] ?? code,
          },
        ],
        firstName: "",
      };
    }

    throw err;
  }
}

export async function updateTwoFa(
  apiId: number,
  apiHash: string,
  sessionString: string,
  opts: { currentPassword?: string; newPassword?: string; hint?: string },
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  await withTgClient(client, "2FA update", (c) =>
    c.updateTwoFaSettings({
      currentPassword: opts.currentPassword || undefined,
      newPassword: opts.newPassword || undefined,
      hint: opts.hint ?? "",
    }),
  );
}

export type TgOwnProfile = {
  firstName: string;
  lastName: string;
  about: string;
  /** Public @handle, or "" when the account has none. */
  username: string;
};

// Read the account's own Telegram profile (first/last name + bio + username).
export async function getProfile(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgOwnProfile> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "profile read", async (c) => {
    const me = (await c.getMe()) as Api.User;
    const full = await c.invoke(
      new Api.users.GetFullUser({ id: new Api.InputUserSelf() }),
    );
    return {
      firstName: me?.firstName ?? "",
      lastName: me?.lastName ?? "",
      about: full.fullUser.about ?? "",
      username: me?.username ?? "",
    };
  });
}

/**
 * Sets or clears the account's public @handle. An empty string removes it, which is how the
 * official clients do it too. Telegram owns the verdict on whether a handle may be taken --
 * USERNAME_OCCUPIED, USERNAME_INVALID and USERNAME_PURCHASE_AVAILABLE all come back from
 * here as RPC errors and are worth showing verbatim, since each needs a different response.
 */
export async function updateUsername(
  apiId: number,
  apiHash: string,
  sessionString: string,
  username: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<string> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "username update", async (c) => {
    const user = (await c.invoke(
      new Api.account.UpdateUsername({ username }),
    )) as Api.User;
    return user?.username ?? "";
  });
}

/** Whether a handle is free, without claiming it. */
export async function checkUsername(
  apiId: number,
  apiHash: string,
  sessionString: string,
  username: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<boolean> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "username check", async (c) =>
    Boolean(await c.invoke(new Api.account.CheckUsername({ username }))),
  );
}

/**
 * The account's own profile photo, or null when it has none. Returned as bytes for the
 * caller to encode however it serves them; Telegram hands back a JPEG.
 */
export async function getProfilePhoto(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<Buffer | null> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "profile photo read", async (c) => {
    const photo = await c.downloadProfilePhoto("me");
    // Missing photos come back as undefined from some layers and as an empty buffer
    // from others, and an empty buffer would render as a broken image.
    if (!photo || !photo.length) return null;
    return Buffer.isBuffer(photo) ? photo : Buffer.from(photo);
  });
}

/**
 * Replaces the account's profile photo. Telegram keeps the previous ones on the account --
 * this adds a new photo and makes it current, which is what the official clients do too.
 */
export async function setProfilePhoto(
  apiId: number,
  apiHash: string,
  sessionString: string,
  image: { buffer: Buffer; filename: string },
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  await withTgClient(client, "profile photo update", async (c) => {
    const file = await c.uploadFile({
      file: new CustomFile(
        image.filename,
        image.buffer.length,
        "",
        image.buffer,
      ),
      workers: 1,
    });
    await c.invoke(new Api.photos.UploadProfilePhoto({ file }));
  });
}

// Update the account's own Telegram profile. Empty strings clear the field.
export async function updateProfile(
  apiId: number,
  apiHash: string,
  sessionString: string,
  opts: { firstName: string; lastName?: string; about?: string },
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgOwnProfile> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "profile update", async (c) => {
    await c.invoke(
      new Api.account.UpdateProfile({
        firstName: opts.firstName,
        lastName: opts.lastName ?? "",
        about: opts.about ?? "",
      }),
    );
    const me = (await c.getMe()) as Api.User;
    return {
      firstName: me?.firstName ?? "",
      lastName: me?.lastName ?? "",
      about: opts.about ?? "",
      username: me?.username ?? "",
    };
  });
}

export type SessionInfo = {
  hash: string;
  current: boolean;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  appName: string;
  appVersion: string;
  dateCreated: number;
  dateActive: number;
  ip: string;
  country: string;
  region: string;
};

export async function getSessions(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<SessionInfo[]> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "session list", async (c) => {
    const result = await c.invoke(new Api.account.GetAuthorizations());
    return result.authorizations.map((a) => ({
      hash: a.hash.toString(),
      current: Boolean(a.current),
      deviceModel: a.deviceModel,
      platform: a.platform,
      systemVersion: a.systemVersion,
      appName: a.appName,
      appVersion: a.appVersion,
      dateCreated: a.dateCreated,
      dateActive: a.dateActive,
      ip: a.ip,
      country: a.country,
      region: a.region,
    }));
  });
}

export async function terminateSession(
  apiId: number,
  apiHash: string,
  sessionString: string,
  hash: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  await withTgClient(client, "session termination", (c) =>
    c.invoke(new Api.account.ResetAuthorization({ hash: BigInt(hash) as any })),
  );
}

export async function terminateOtherSessions(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  await withTgClient(client, "device removal", (c) =>
    c.invoke(new Api.auth.ResetAuthorizations()),
  );
}

export async function submitPassword(
  accountId: number,
  password: string,
): Promise<string> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "2fa")
    throw new Error("No pending 2FA for this account");

  // Dynamic import to avoid issues with module resolution
  const { computeCheck } = await import("telegram/Password");
  const passwordInfo = await withTimeout(
    entry.client.invoke(new Api.account.GetPassword()),
    OP_TIMEOUT_MS,
    "getPassword",
  );
  const passwordSrp = await computeCheck(passwordInfo, password);
  await withTimeout(
    entry.client.invoke(new Api.auth.CheckPassword({ password: passwordSrp })),
    OP_TIMEOUT_MS,
    "checkPassword",
  );

  const session = entry.client.session.save() as unknown as string;
  await entry.client.destroy().catch(() => undefined);
  pending.delete(accountId);
  return session;
}

// ── Recovery email management ─────────────────────────────────────────────────

export type PasswordInfo = {
  hasPassword: boolean;
  hasRecovery: boolean;
  hint: string | null;
  emailUnconfirmedPattern: string | null;
  loginEmailPattern: string | null;
};

function makeTgClient(
  sessionString: string,
  apiId: number,
  apiHash: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
) {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });
}

/** Returns the account's own Telegram numeric user id as a string. */
export async function getSelfId(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<string> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "self id read", async (c) => {
    const me = await c.getMe();
    const id = (me as { id?: unknown } | null)?.id;
    if (id === undefined || id === null)
      throw new Error("Could not resolve Telegram user id");
    return String(id);
  });
}

export async function getPasswordInfo(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<PasswordInfo> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "password info read", async (c) => {
    const pwd = await c.invoke(new Api.account.GetPassword());
    return {
      hasPassword: Boolean(pwd.hasPassword),
      hasRecovery: Boolean(pwd.hasRecovery),
      hint: pwd.hint ?? null,
      emailUnconfirmedPattern: pwd.emailUnconfirmedPattern ?? null,
      loginEmailPattern: pwd.loginEmailPattern ?? null,
    };
  });
}

// ── Login email management ────────────────────────────────────────────────────
// The masked pattern comes from account.getPassword (loginEmailPattern).
// Setting or replacing uses SendVerifyEmailCode + VerifyEmail with the
// emailVerifyPurposeLoginChange purpose. Telegram provides no method to remove
// a login email from an authorised session -- it can only be replaced.

/** Send a verification code to a new login email address. */
export async function sendLoginEmailCode(
  apiId: number,
  apiHash: string,
  sessionString: string,
  email: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ emailPattern: string; codeLength: number }> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "login email code send", async (c) => {
    // GramJS bug: EntityCache.add treats any response with a numeric `length`
    // field as array-like, and account.SentEmailCode has one (the code length),
    // so invoke() crashes with "entities is not iterable" after a successful RPC.
    // The response carries no entities, so disable caching on this throwaway client.
    (c as unknown as { _entityCache: { add: (e: unknown) => void } })
      ._entityCache.add = () => undefined;
    const sent = await c.invoke(
      new Api.account.SendVerifyEmailCode({
        purpose: new Api.EmailVerifyPurposeLoginChange(),
        email,
      }),
    );
    return { emailPattern: sent.emailPattern, codeLength: sent.length };
  });
}

/** Verify the code sent by sendLoginEmailCode, committing the new login email. */
export async function verifyLoginEmail(
  apiId: number,
  apiHash: string,
  sessionString: string,
  code: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ email: string | null }> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "login email verify", async (c) => {
    const verified = await c.invoke(
      new Api.account.VerifyEmail({
        purpose: new Api.EmailVerifyPurposeLoginChange(),
        verification: new Api.EmailVerificationCode({ code }),
      }),
    );
    return { email: "email" in verified ? (verified.email ?? null) : null };
  });
}

// ── Passkeys ──────────────────────────────────────────────────────────────────
// Uses raw TL requests (see tg/passkeys.ts) since GramJS lacks passkey types.

export async function getPasskeys(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<Passkey[]> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "passkey list", (c) => invokeGetPasskeys(c));
}

export async function deletePasskey(
  apiId: number,
  apiHash: string,
  sessionString: string,
  passkeyId: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<boolean> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "passkey removal", (c) =>
    invokeDeletePasskey(c, passkeyId),
  );
}

// Experimental: registers a new passkey by running the WebAuthn ceremony in Node
// (no browser). Returns the private key material for a possible future login.
export async function registerPasskey(
  apiId: number,
  apiHash: string,
  sessionString: string,
  originOverride?: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<RegisterPasskeyResult> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  return withTgClient(client, "passkey registration", (c) =>
    invokeRegisterPasskey(c, originOverride),
  );
}

// Verifies a stored passkey by logging in with it on a fresh (empty) session.
// Passkey login is DC-specific: it must run on the DC where the account lives, so
// we pin the fresh session to the authorised session's DC (avoids the cross-DC
// finishPasskeyLogin path, which otherwise fails as PASSKEY_CHALLENGE_EXPIRED).
export async function verifyPasskeyLogin(
  apiId: number,
  apiHash: string,
  accountSessionString: string,
  secret: PasskeySecret,
  originOverride?: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<PasskeyLoginVerification> {
  const authed = new StringSession(accountSessionString);
  const fresh = new StringSession("");
  fresh.setDC(authed.dcId, authed.serverAddress, authed.port);
  const client = new TelegramClient(fresh, apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });
  return withTgClient(client, "passkey login verify", (c) =>
    invokeVerifyPasskeyLogin(c, apiId, apiHash, secret, originOverride),
  );
}

// Reads the account's home DC out of an authorised session string.
export function getSessionDc(
  sessionString: string,
): { dcId: number; serverAddress: string; port: number } | null {
  if (!sessionString) return null;
  try {
    const s = new StringSession(sessionString);
    if (s.dcId == null || !s.serverAddress || s.port == null) return null;
    return { dcId: s.dcId, serverAddress: s.serverAddress, port: s.port };
  } catch {
    return null;
  }
}

// Logs in using a stored passkey as the first factor. On success without 2FA the
// session is returned; when the account has a cloud password, the connected client
// is parked in `pending` (step "2fa") so submitPassword() finishes it exactly like
// the code flow. Throws (caller falls back to code login) if the passkey is rejected.
export async function startPasskeyLogin(
  accountId: number,
  apiId: number,
  apiHash: string,
  secret: PasskeySecret,
  originOverride?: string,
  proxy?: TgProxy,
): Promise<{ needsPassword: boolean; session?: string }> {
  const existing = pending.get(accountId);
  if (existing) {
    await existing.client.destroy().catch(() => undefined);
    pending.delete(accountId);
  }

  const fresh = new StringSession("");
  if (secret.dcId != null && secret.serverAddress && secret.port != null) {
    fresh.setDC(secret.dcId, secret.serverAddress, secret.port);
  }
  // No deviceParams during auth (same rationale as requestCode).
  const client = new TelegramClient(fresh, apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
  });

  try {
    await withTimeout(client.connect(), OP_TIMEOUT_MS, "passkey login connect");
    try {
      await withTimeout(
        invokePasskeyLogin(client, apiId, apiHash, secret, originOverride),
        OP_TIMEOUT_MS,
        "passkey login",
      );
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? "";
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        // Keep the client alive for the 2FA step.
        pending.set(accountId, {
          client,
          phoneNumber: "",
          phoneCodeHash: "",
          step: "2fa",
          startedAt: Date.now(),
        });
        return { needsPassword: true };
      }
      throw err;
    }
    const session = client.session.save() as unknown as string;
    await client.destroy().catch(() => undefined);
    return { needsPassword: false, session };
  } catch (err) {
    await client.destroy().catch(() => undefined);
    throw err;
  }
}
