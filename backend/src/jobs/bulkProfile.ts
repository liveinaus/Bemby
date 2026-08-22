import crypto from "crypto";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import { updateProfile, setProfilePhoto, updateUsername } from "../auth/tgAuth";
import { normaliseUsername, usernameError } from "../tg/usernames";
import { parseTgProxy } from "./runner";
import { globalTgProxyUrl } from "../tg/globalProxy";
import { resolveAppClientParams } from "../tg/appClient";
import { isAuthError, markSessionExpired } from "../tg/liveClient";
import {
  pickRandomAvatar,
  type AvatarSourceMode,
} from "../tg/avatarSource";

// Bulk-updates the Telegram profile (first name, last name, bio/about, profile
// photo) of already-authenticated accounts. Accounts are processed one at a time
// with a gap between them to stay under Telegram's rate limits; failed accounts
// are retried a few times. Runs as a background batch that survives page reloads,
// mirroring the bulk-add flow.

export type BulkProfileItemStatus =
  | "pending"
  | "updating"
  | "waiting"
  | "paused"
  | "retrying"
  | "done"
  | "failed";

export type BulkProfileItem = {
  index: number;
  accountId: number;
  accountName: string;
  firstName: string;
  lastName: string;
  about: string;
  /** Target @handle, or "" to leave the current one alone. */
  username: string;
  attempts: number;
  status: BulkProfileItemStatus;
  message: string;
  error: string | null;
  /** Which source supplied this account's new photo, once one has been set. */
  avatar: string | null;
};

export type BulkProfileBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  /** Held between accounts: the one in flight finishes, then the batch waits. */
  paused: boolean;
  total: number;
  items: BulkProfileItem[];
};

// One account's target profile, as supplied by the client. firstName may be left
// empty only when the batch is setting avatars, which is the avatar-only case:
// there is nothing to write to the name fields and Telegram rejects a blank one.
export type BulkProfileEntry = {
  accountId: number;
  firstName?: string;
  lastName?: string;
  about?: string;
  /** Target @handle; omitted or empty leaves the account's current one. */
  username?: string;
};

export type BulkProfileOptions = {
  /** Pause between accounts, in seconds (default 3). */
  gapSeconds?: number;
  /** How many times to retry an account after a failed update (default 1). */
  maxRetries?: number;
  /** Cooldown before a failed account is retried, in seconds (default 60). */
  retryDelaySeconds?: number;
  /** Where a random profile photo comes from; omitted leaves photos untouched. */
  avatarSource?: AvatarSourceMode;
};

type BulkProfileConfig = {
  betweenAccountsMs: number;
  maxRetries: number;
  retryDelayMs: number;
  avatarSource: AvatarSourceMode | null;
};

const DEFAULT_GAP_SECONDS = 3;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_SECONDS = 60;

const AVATAR_MODES: AvatarSourceMode[] = ["pool", "online", "any"];

function resolveConfig(opts?: BulkProfileOptions): BulkProfileConfig {
  const gap = Number(opts?.gapSeconds);
  const retries = Number(opts?.maxRetries);
  const retryDelay = Number(opts?.retryDelaySeconds);
  const avatar = opts?.avatarSource;
  return {
    avatarSource:
      avatar && AVATAR_MODES.includes(avatar) ? avatar : null,
    betweenAccountsMs:
      Number.isFinite(gap) && gap >= 0
        ? gap * 1000
        : DEFAULT_GAP_SECONDS * 1000,
    maxRetries:
      Number.isFinite(retries) && retries >= 0
        ? Math.floor(retries)
        : DEFAULT_MAX_RETRIES,
    retryDelayMs:
      Number.isFinite(retryDelay) && retryDelay >= 0
        ? retryDelay * 1000
        : DEFAULT_RETRY_DELAY_SECONDS * 1000,
  };
}

let current: BulkProfileBatch | null = null;

export function getBulkProfileStatus(): BulkProfileBatch | null {
  return current;
}

export function cancelBulkProfile(): boolean {
  if (!current || !current.running) return false;
  current.cancelled = true;
  current.paused = false;
  return true;
}

/** Holds the batch once the account in flight is done; false if it had finished. */
export function pauseBulkProfile(): boolean {
  if (!current || !current.running || current.cancelled) return false;
  current.paused = true;
  return true;
}

/** Lets a held batch carry on; false if it was not paused. */
export function resumeBulkProfile(): boolean {
  if (!current || !current.running || !current.paused) return false;
  current.paused = false;
  return true;
}

/** Forgets a finished batch, so the task dock stops listing it. See clearBulkAdd. */
export function clearBulkProfile(): boolean {
  if (!current || current.running) return false;
  current = null;
  return true;
}

function resolveProxyUrl(proxyId: string | null): string | undefined {
  // No exit of its own means the global one, when it is SOCKS -- see accountOps.resolveProxyUrl
  if (!proxyId) return globalTgProxyUrl();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("proxies") as { value: string } | undefined;
  try {
    const list = row?.value
      ? (JSON.parse(row.value) as Array<{ id: string; url: string }>)
      : [];
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

// Abortable sleep -- resolves early when the batch is cancelled.
function sleep(ms: number, batch: BulkProfileBatch): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (batch.cancelled || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(1000, ms));
    };
    tick();
  });
}

// Held between accounts, so nothing new is started while the batch is paused. A pause
// asked for during a gap or cooldown takes hold once that wait runs out.
async function holdWhilePaused(
  batch: BulkProfileBatch,
  item: BulkProfileItem,
): Promise<void> {
  while (batch.paused && !batch.cancelled) {
    item.status = "paused";
    item.message = "Paused";
    await sleep(250, batch);
  }
}

type AccountRow = {
  id: number;
  name: string;
  api_id: number | null;
  api_hash: string | null;
  proxy_id: string | null;
  app_client_id: string | null;
  session_string: string | null;
  auth_status: string;
  tg_username: string | null;
};

async function updateOne(
  item: BulkProfileItem,
  config: BulkProfileConfig,
  usedAvatars: Set<string>,
): Promise<void> {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(item.accountId) as AccountRow | undefined;
  if (!account) throw new Error("Account not found");
  decryptAccountRow(account);
  if (account.auth_status !== "authenticated" || !account.session_string) {
    throw new Error("Account is not authenticated");
  }

  const own =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const creds = own ?? getDefaultTgApiCredentials();
  if (!creds) {
    throw new Error(
      "No API credentials -- configure global defaults in Settings",
    );
  }

  const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
  const deviceParams = resolveAppClientParams(account.id, account.app_client_id);

  // An avatar-only row has no name to write, and Telegram rejects a blank firstName.
  if (item.firstName) {
    const profile = await updateProfile(
      creds.apiId,
      creds.apiHash,
      account.session_string,
      { firstName: item.firstName, lastName: item.lastName, about: item.about },
      proxy,
      deviceParams,
    );

    // Keep the cached display name in sync with the new profile.
    const displayName =
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    db.prepare(
      "UPDATE tg_accounts SET tg_display_name = ? WHERE id = ?",
    ).run(displayName, account.id);
  }

  // Before the photo, because a rejected handle is the likeliest failure of the three and
  // there is no sense spending an upload on an account whose row is going to fail anyway.
  if (item.username) {
    const applied = await updateUsername(
      creds.apiId,
      creds.apiHash,
      account.session_string,
      item.username,
      proxy,
      deviceParams,
    );
    db.prepare("UPDATE tg_accounts SET tg_username = ? WHERE id = ?").run(
      applied || null,
      account.id,
    );
  }

  if (config.avatarSource) {
    const pick = await pickRandomAvatar(config.avatarSource, usedAvatars);
    await setProfilePhoto(
      creds.apiId,
      creds.apiHash,
      account.session_string,
      { buffer: pick.buffer, filename: pick.filename },
      proxy,
      deviceParams,
    );
    item.avatar = pick.source;
  }
}

/**
 * Verdicts a retry cannot change. A handle someone else owns is still theirs a minute later,
 * so retrying only spends the gap and asks Telegram the same question again.
 */
const PERMANENT_FAILURES = [
  "USERNAME_OCCUPIED",
  "USERNAME_INVALID",
  "USERNAME_PURCHASE_AVAILABLE",
];

function isPermanentFailure(reason: string): boolean {
  return PERMANENT_FAILURES.some((code) => reason.includes(code));
}

/** What actually changed on this account, for the row's final line. */
function describeApplied(item: BulkProfileItem): string {
  const parts: string[] = [];
  if (item.firstName) parts.push("profile");
  if (item.username) parts.push(`@${item.username}`);
  if (item.avatar) parts.push(`avatar (${item.avatar})`);
  return parts.length ? `Updated ${parts.join(", ")}` : "Nothing to update";
}

type QueueEntry = { item: BulkProfileItem; readyAt: number };

async function runBatch(
  batch: BulkProfileBatch,
  config: BulkProfileConfig,
): Promise<void> {
  try {
    const queue: QueueEntry[] = batch.items.map((item) => ({
      item,
      readyAt: 0,
    }));
    const totalAttempts = config.maxRetries + 1;
    let processedAny = false;
    // Shared across the batch so a pool of images is spread over the accounts
    // rather than each account drawing from the whole pool independently.
    const usedAvatars = new Set<string>();

    while (queue.length && !batch.cancelled) {
      const entry = queue.shift()!;
      const { item } = entry;

      const cooldownMs = entry.readyAt - Date.now();
      if (cooldownMs > 0) {
        item.status = "retrying";
        item.message = `Retrying in ${Math.round(cooldownMs / 1000)}s (attempt ${item.attempts + 1}/${totalAttempts})`;
        await sleep(cooldownMs, batch);
        if (batch.cancelled) break;
      }

      // The gap spaces successive Telegram calls; applied before every update
      // except the first.
      if (processedAny) {
        item.status = "waiting";
        item.message = `Waiting ${Math.round(config.betweenAccountsMs / 1000)}s before updating`;
        await sleep(config.betweenAccountsMs, batch);
        if (batch.cancelled) break;
      }

      await holdWhilePaused(batch, item);
      if (batch.cancelled) break;

      item.attempts++;
      item.status = "updating";
      item.message = item.firstName ? "Updating profile" : "Applying changes";
      try {
        await updateOne(item, config, usedAvatars);
        item.status = "done";
        item.message = describeApplied(item);
        item.error = null;
      } catch (err: any) {
        const reason = err?.errorMessage ?? err?.message ?? String(err);
        if (isAuthError(reason)) markSessionExpired(item.accountId);
        if (
          item.attempts <= config.maxRetries &&
          !batch.cancelled &&
          !isPermanentFailure(reason)
        ) {
          entry.readyAt = Date.now() + config.retryDelayMs;
          item.status = "retrying";
          item.error = null;
          item.message = `Attempt ${item.attempts}/${totalAttempts} failed (${reason}) -- retrying in ${Math.round(config.retryDelayMs / 1000)}s`;
          queue.push(entry);
        } else {
          item.status = "failed";
          item.error = reason;
          item.message = `Failed after ${item.attempts} attempt(s): ${reason}`;
        }
      }
      processedAny = true;
    }
  } finally {
    batch.running = false;
  }
}

export type StartBulkProfileResult =
  | { ok: true; batch: BulkProfileBatch }
  | { ok: false; error: string };

export function startBulkProfile(
  entries: BulkProfileEntry[],
  options?: BulkProfileOptions,
): StartBulkProfileResult {
  if (current?.running) {
    return { ok: false, error: "A bulk-rename batch is already running" };
  }
  if (!Array.isArray(entries) || !entries.length) {
    return { ok: false, error: "No accounts provided" };
  }

  const config = resolveConfig(options);
  const items: BulkProfileItem[] = [];
  for (const [index, entry] of entries.entries()) {
    const accountId = Number(entry?.accountId);
    const firstName = String(entry?.firstName ?? "").trim();
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { ok: false, error: `Invalid account id on row ${index + 1}` };
    }
    const username = normaliseUsername(String(entry?.username ?? ""));
    if (username) {
      const problem = usernameError(username);
      if (problem) {
        return { ok: false, error: `Row ${index + 1}: ${problem}` };
      }
    }
    // Without a name there has to be something else to do, or the row is a no-op.
    if (!firstName && !config.avatarSource && !username) {
      return { ok: false, error: `First name is required on row ${index + 1}` };
    }
    const row = db
      .prepare("SELECT id, name FROM tg_accounts WHERE id = ?")
      .get(accountId) as { id: number; name: string } | undefined;
    if (!row) {
      return { ok: false, error: `Account ${accountId} not found` };
    }
    items.push({
      index,
      accountId,
      accountName: row.name,
      firstName,
      lastName: String(entry?.lastName ?? "").trim(),
      about: String(entry?.about ?? "").trim(),
      username,
      attempts: 0,
      status: "pending",
      message: "",
      error: null,
      avatar: null,
    });
  }

  const batch: BulkProfileBatch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    running: true,
    cancelled: false,
    paused: false,
    total: items.length,
    items,
  };
  current = batch;
  void runBatch(batch, config);
  return { ok: true, batch };
}
