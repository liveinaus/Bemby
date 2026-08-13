import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  getSelfId,
  sendLoginEmailCode,
  verifyLoginEmail,
  type TgDeviceParams,
} from "../auth/tgAuth";
import { expandCommand } from "./checkin";
import { leaseEmail, pollForCode, releaseEmail } from "./msOauth2api";
import type { TgProxy } from "../types";

// Automates a Telegram login-email change against a Gmail inbox: each account
// gets a plus-address (local+{tag}@gmail.com) where {tag} is expanded from a
// user template. Telegram emails a code there, and the code is read back over
// IMAP using a Gmail app password. Nothing is stored; the Gmail credentials
// live only for the request.

export const DEFAULT_EMAIL_TAG = "{phoneNum}";

// Builds local+{suffix}@domain from a base Gmail address (plus-addressing).
export function buildPlusAddress(gmail: string, suffix: string): string {
  const at = gmail.lastIndexOf("@");
  if (at === -1) throw new Error("Invalid Gmail address");
  const local = gmail.slice(0, at);
  const domain = gmail.slice(at + 1);
  return `${local}+${suffix}@${domain}`;
}

// Maps digits to letters (0=a, 1=b, ... 9=j). Telegram rejects login-email
// plus-tags that contain digits, so the whole tag is de-digitised.
export function digitsToLetters(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));
}

// Expands a tag template into a Gmail plus-tag. Named tokens: {phoneNum},
// {tgId}, {id}; random tokens ({word:N}, {alpha:N}, {uuid}) come from
// expandCommand. Digits are mapped to letters (Telegram rejects numeric tags)
// and the result is stripped to address-safe characters.
export async function expandEmailTag(
  template: string,
  ctx: {
    phoneNumber: string;
    accountId: number;
    getTgId: () => Promise<string>;
  },
): Promise<string> {
  const phoneDigits = ctx.phoneNumber.replace(/\D/g, "");
  const context: Record<string, string> = {
    phoneNum: phoneDigits,
    phone: phoneDigits,
    id: String(ctx.accountId),
  };
  if (/\{tgId\}/.test(template)) context.tgId = await ctx.getTgId();
  const expanded = digitsToLetters(expandCommand(template, context));
  const tag = expanded.replace(/[^A-Za-z._-]/g, "");
  if (!tag) throw new Error("Email tag template produced an empty value");
  return tag;
}

// Pulls the numeric code out of Telegram's login-email message. Prefers a code
// next to the word "code"; otherwise the first 5-7 digit run.
export function extractLoginCode(subject: string, text: string): string | null {
  const hay = `${subject ?? ""}\n${text ?? ""}`;
  const labelled = hay.match(/code[^0-9]{0,20}(\d{5,7})/i);
  if (labelled) return labelled[1];
  const any = hay.match(/\b(\d{5,7})\b/);
  return any ? any[1] : null;
}

// Verifies the Gmail address + app password can log in over IMAP.
export async function testGmailImap(
  gmail: string,
  appPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: gmail, pass: appPassword },
    logger: false,
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err: any) {
    await client.logout().catch(() => undefined);
    return {
      ok: false,
      error: err?.responseText || err?.message || "IMAP login failed",
    };
  }
}

// Polls the Gmail inbox over IMAP for a Telegram code sent to `toAddress`,
// returning the parsed code or null on timeout.
async function fetchTelegramLoginCode(opts: {
  gmail: string;
  appPassword: string;
  toAddress: string;
  sinceMs: number;
  timeoutMs: number;
}): Promise<string | null> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: opts.gmail, pass: opts.appPassword },
    logger: false,
  });
  await client.connect();
  // logout is guarded here so a failure to acquire the mailbox lock still
  // closes the connection instead of leaking it.
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const deadline = Date.now() + opts.timeoutMs;
      const since = new Date(opts.sinceMs);
      while (true) {
        let uids: number[] = [];
        try {
          await client.noop();
          uids = (await client.search(
            { since, to: opts.toAddress },
            { uid: true },
          )) || [];
        } catch {
          uids = [];
        }
        // Newest first
        for (const uid of [...uids].reverse()) {
          const msg = await client.fetchOne(
            uid,
            { source: true },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const body = parsed.text || parsed.html || "";
          const code = extractLoginCode(parsed.subject ?? "", body);
          if (code) return code;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 5000));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export type ChangeLoginEmailParams = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  phoneNumber: string;
  accountId: number;
  proxy?: TgProxy;
  deviceParams?: TgDeviceParams;
  gmail: string;
  appPassword: string;
  tag: string;
};

// Full flow for one account: expand the tag template into a plus-address, ask
// Telegram to send a code there, read the code from Gmail, then confirm it.
export async function changeLoginEmailViaGmail(
  params: ChangeLoginEmailParams,
): Promise<{ email: string }> {
  const { apiId, apiHash, sessionString, proxy, deviceParams } = params;

  const tag = await expandEmailTag(params.tag || DEFAULT_EMAIL_TAG, {
    phoneNumber: params.phoneNumber,
    accountId: params.accountId,
    getTgId: () =>
      getSelfId(apiId, apiHash, sessionString, proxy, deviceParams),
  });
  const toAddress = buildPlusAddress(params.gmail, tag);

  // Look a little before "now" to absorb clock skew between hosts
  const sinceMs = Date.now() - 60_000;

  await sendLoginEmailCode(
    apiId,
    apiHash,
    sessionString,
    toAddress,
    proxy,
    deviceParams,
  );

  const code = await fetchTelegramLoginCode({
    gmail: params.gmail,
    appPassword: params.appPassword,
    toAddress,
    sinceMs,
    timeoutMs: 60_000,
  });
  if (!code)
    throw new Error("No verification code arrived in Gmail within the timeout");

  await verifyLoginEmail(
    apiId,
    apiHash,
    sessionString,
    code,
    proxy,
    deviceParams,
  );

  return { email: toAddress };
}

/** How long a pool address is given to receive Telegram's code before the run gives up. */
const POOL_CODE_WAIT_MS = 120_000;

/**
 * Telegram's own mail. Sent as the sender filter so a code left in the mailbox by something
 * else is not read as this one; the pool type's rules in the msOauth2api panel still apply
 * on top.
 */
const TELEGRAM_SENDER = "telegram";

export type ChangeLoginEmailViaPoolParams = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  proxy?: TgProxy;
  deviceParams?: TgDeviceParams;
  /** Pool type to lease from; blank uses the configured default. */
  poolType?: string;
};

/**
 * The same flow against msOauth2api's address pool: lease a mailbox nobody has used for this
 * type, point Telegram at it, read the code back and confirm. A run that fails anywhere after
 * the lease hands the address back, so a Telegram error does not burn one.
 */
export async function changeLoginEmailViaPool(
  params: ChangeLoginEmailViaPoolParams,
): Promise<{ email: string }> {
  const { apiId, apiHash, sessionString, proxy, deviceParams } = params;
  const lease = await leaseEmail(params.poolType);

  try {
    await sendLoginEmailCode(
      apiId,
      apiHash,
      sessionString,
      lease.email,
      proxy,
      deviceParams,
    );

    // No `since`: the pool defaults it to the lease, which is exactly the window this run owns
    const found = await pollForCode({
      email: lease.email,
      type: lease.type,
      fromContains: TELEGRAM_SENDER,
      waitMs: POOL_CODE_WAIT_MS,
    });
    if (!found)
      throw new Error(
        `no verification code reached ${lease.email} within ${POOL_CODE_WAIT_MS / 1000}s`,
      );

    await verifyLoginEmail(
      apiId,
      apiHash,
      sessionString,
      found.code,
      proxy,
      deviceParams,
    );
    return { email: lease.email };
  } catch (err) {
    await releaseEmail(lease.email, lease.type);
    throw err;
  }
}
