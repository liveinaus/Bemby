// The two halves of fetching an account's own Telegram API credentials from
// my.telegram.org that the browser cannot do for itself.
//
// The site posts its login code to the account inside Telegram rather than to an email
// address, so the code arrives over MTProto on the account's own client -- which is why
// `web_tg_code` is a step of its own rather than a `web_email_code` with a different
// mailbox. And the pair the site hands back belongs in the accounts table, where the
// api_hash is stored encrypted like every other login, so `web_tg_api_save` writes it
// through here rather than the page steps reaching into the database.

import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers";
import { db } from "../db/database";
import { encryptSecret } from "../db/secretColumns";
import {
  dataStoreOffReason,
  isDataStoreEnabled,
  writeDataValue,
} from "../db/dataStore";

/** Telegram's own service chat, the only sender a login code ever comes from. */
export const TG_SERVICE_USER_ID = 777000;

/** How long a `web_tg_code` step waits for the message when it is not told. */
export const TG_CODE_WAIT_MS = 180_000;

/** How often the service chat is read while waiting. */
const TG_CODE_POLL_MS = 3_000;

/**
 * Slack on the "since" instant, so a code sent while the step was still starting counts.
 * Telegram dates a message to the second, so a step that begins mid-second would otherwise
 * skip the very message it asked for.
 */
const TG_CODE_LOOKBACK_MS = 60_000;

/** What my.telegram.org hands back: an app id and its 32-character hash. */
export type TgApiPair = { apiId: number; apiHash: string };

/**
 * A run of characters a code is made of, as either flavour writes one. Underscores and hyphens
 * count anywhere, first character included: `_b6cgbgXyH4` is a real web login code.
 */
const CODE_TOKEN = "[A-Za-z0-9_-]{4,64}";

/**
 * Does this read as a code rather than as an ordinary word? Only asked where the wording did
 * not introduce the code with a colon, and there a code is told from prose by mixing letters
 * with digits -- which "Dear", "can" and "Two-Step" do not.
 */
function looksLikeCodeToken(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

/**
 * The code out of a service message.
 *
 * Two flavours, and my.telegram.org sends the awkward one: a web login code is a token like
 * `Q6mq_4re-8s`, not the 5-6 digit run a phone login gets. Both are looked for -- the token
 * first, since a message carrying one carries no digit code, then the digit run, which is what
 * a translated wording ("登录代码：52901") comes down to.
 *
 * A caller with a wording of its own passes `pattern`, where capture group 1 is the code when
 * there is one and the whole match otherwise.
 */
export function extractLoginCode(text: string, pattern?: string): string | null {
  const body = (text ?? "").trim();
  if (!body) return null;
  if (pattern) {
    const m = new RegExp(pattern, "i").exec(body);
    if (!m) return null;
    return (m[1] ?? m[0]).trim() || null;
  }

  // A colon is the wording handing the code over ("This is your login code:\n_b6cgbgXyH4"),
  // and whatever follows it is the code whatever it looks like. The sentences that merely
  // mention one ("Web login code. Dear Luna", "This code can be used to delete...") have no
  // colon, which is what keeps their next word from being read as the code.
  const handedOver = new RegExp(String.raw`code\s*[:：]\s*(${CODE_TOKEN})`, "i").exec(body);
  if (handedOver) return handedOver[1];

  // No colon: fall back to a token that reads like a code rather than like prose
  for (const m of body.matchAll(new RegExp(String.raw`code\s*[=-]?\s*(${CODE_TOKEN})`, "gi"))) {
    if (looksLikeCodeToken(m[1])) return m[1];
  }

  const nearCode = /code[^0-9]{0,24}(\d{5,6})/i.exec(body);
  if (nearCode) return nearCode[1];
  const any = /(?<!\d)(\d{5,6})(?!\d)/.exec(body);
  return any ? any[1] : null;
}

/**
 * The service chat as a peer this client can read.
 *
 * A job's client is built from a session string, whose entity cache may hold nothing: a user
 * id alone is not enough to address anybody, so the dialog list is fetched to fill the cache
 * before falling back to the one access hash that is the same for every account -- the service
 * user's, which is zero.
 */
async function serviceChatPeer(client: TelegramClient): Promise<Api.TypeEntityLike> {
  try {
    return await client.getInputEntity(TG_SERVICE_USER_ID);
  } catch {
    /* not cached yet */
  }
  try {
    await client.getDialogs({ limit: 100 });
    return await client.getInputEntity(TG_SERVICE_USER_ID);
  } catch {
    return new Api.InputPeerUser({
      userId: returnBigInt(TG_SERVICE_USER_ID),
      accessHash: returnBigInt(0),
    });
  }
}

/**
 * Waits for Telegram to deliver a login code to this account and reads it out.
 *
 * Polled rather than event-driven: a job's client is connected for the run and a service
 * message may already be sitting there by the time the step is reached (the site sends it the
 * moment the phone number is submitted, which is a step or two earlier).
 */
export async function waitForTgLoginCode(opts: {
  client: TelegramClient;
  /** Only messages at or after this instant count, so an earlier code is not read again. */
  sinceMs: number;
  pattern?: string;
  waitMs: number;
  signal?: AbortSignal;
}): Promise<{ code: string; text: string } | null> {
  const { client, pattern, signal } = opts;
  const since = Math.floor((opts.sinceMs - TG_CODE_LOOKBACK_MS) / 1000);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  const peer = await serviceChatPeer(client);

  for (;;) {
    if (signal?.aborted) throw new Error("Job cancelled");

    const messages = (await client
      .getMessages(peer, { limit: 5 })
      .catch(() => [])) as Api.Message[];
    // Newest first, which is the one to trust: a code superseded by a fresh request is dead
    for (const msg of messages) {
      if (!msg?.message || (msg.date ?? 0) < since) continue;
      const code = extractLoginCode(msg.message, pattern);
      if (code) return { code, text: msg.message };
    }

    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(TG_CODE_POLL_MS, left)),
    );
  }
}

/**
 * Reads an api_id/api_hash pair the way it is written on my.telegram.org, refusing anything
 * that does not look like one.
 *
 * Worth being strict about: a selector that has drifted reads a label or a whole paragraph
 * rather than the value, and a junk pair saved onto an account only shows up later as an
 * account that can no longer log in.
 */
export function parseTgApiPair(apiId: string, apiHash: string): TgApiPair {
  const idText = (apiId ?? "").trim();
  const hashText = (apiHash ?? "").trim();
  const id = Number(idText);
  if (!/^\d{4,12}$/.test(idText) || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`"${idText.slice(0, 60)}" is not an api_id`);
  }
  if (!/^[0-9a-f]{32}$/i.test(hashText)) {
    throw new Error(
      `"${hashText.slice(0, 60)}" is not an api_hash (32 hexadecimal characters)`,
    );
  }
  return { apiId: id, apiHash: hashText.toLowerCase() };
}

/** Enough of an api_hash to tell two apart in a log, without writing the login into one. */
export function maskApiHash(apiHash: string): string {
  return apiHash.length <= 8
    ? "*".repeat(apiHash.length)
    : `${apiHash.slice(0, 4)}${"*".repeat(apiHash.length - 8)}${apiHash.slice(-4)}`;
}

type AccountCredentialRow = {
  name: string;
  phone_number: string;
  api_id: number | null;
  session_string: string | null;
};

/**
 * Writes the pair onto the account, and mirrors it into the data store when a folder is
 * named. The account is what the rest of Bemby reads, so that write is the one that matters;
 * the data store copy is for whoever wants the pair outside the app.
 *
 * The store is checked before anything is written, since failing halfway would leave the
 * account holding credentials nothing has a record of.
 */
export function saveAccountApiCredentials(opts: {
  accountId: number;
  apiId: string;
  apiHash: string;
  /** Data-store folder to mirror the pair into. Blank writes to the account alone. */
  folder?: string;
  /** Record key inside that folder. Blank uses the account's phone number. */
  key?: string;
}): { summary: string } {
  const pair = parseTgApiPair(opts.apiId, opts.apiHash);
  const account = db
    .prepare(
      "SELECT name, phone_number, api_id, session_string FROM tg_accounts WHERE id = ?",
    )
    .get(opts.accountId) as AccountCredentialRow | undefined;
  if (!account) throw new Error(`account ${opts.accountId} is no longer there`);

  const folder = opts.folder?.trim();
  if (folder && !isDataStoreEnabled()) throw new Error(dataStoreOffReason());

  db.prepare("UPDATE tg_accounts SET api_id = ?, api_hash = ? WHERE id = ?").run(
    pair.apiId,
    encryptSecret(pair.apiHash),
    opts.accountId,
  );

  let stored = "";
  if (folder) {
    const key = opts.key?.trim() || account.phone_number || String(opts.accountId);
    writeDataValue(folder, key, "", {
      apiId: pair.apiId,
      apiHash: pair.apiHash,
      phone: account.phone_number,
    });
    stored = `, and to ${folder}/${key}`;
  }

  // A session made under other credentials keeps working, but it is another app's session as
  // far as Telegram is concerned -- so say which accounts may want signing in again
  const replaced =
    account.api_id && account.api_id !== pair.apiId ? account.api_id : null;
  const note = replaced
    ? ` (replacing ${replaced}${account.session_string ? "; the existing session was made under it, so sign in again if the account starts refusing" : ""})`
    : "";

  return {
    summary:
      `saved api_id ${pair.apiId} and api_hash ${maskApiHash(pair.apiHash)} to ` +
      `${account.name}${stored}${note}`,
  };
}
