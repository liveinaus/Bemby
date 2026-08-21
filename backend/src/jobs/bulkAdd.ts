import crypto from "crypto";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow, encryptSecret } from "../db/secretColumns";
import {
  cancelPendingAuth,
  requestCode,
  submitCode,
  submitPassword,
} from "../auth/tgAuth";
import { parseTgProxy } from "./runner";
import { resolveAppClientParams } from "../tg/appClient";

// Bulk-adds Telegram accounts whose verification code + 2FA are served by an
// external "getcode" API page (one page per account). Accounts are created
// first, then authenticated one at a time: request code, poll the API page for
// the code, submit it, submit the 2FA password, then pause before the next.

export type BulkAddItemStatus =
  | "pending"
  | "requesting_code"
  | "fetching_code"
  | "submitting_code"
  | "submitting_2fa"
  | "waiting"
  | "paused"
  | "created"
  | "skipped"
  | "retrying"
  | "done"
  | "failed";

export type BulkAddItem = {
  index: number;
  phoneNumber: string;
  apiUrl: string;
  accountId: number | null;
  accountName: string | null;
  /** True when the account already existed and was reused, not created. */
  existing: boolean;
  /** Number of authentication attempts made so far. */
  attempts: number;
  status: BulkAddItemStatus;
  message: string;
  error: string | null;
};

export type BulkAddBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  /** Held between accounts: the one in flight finishes, then the batch waits. */
  paused: boolean;
  total: number;
  items: BulkAddItem[];
};

export type ParsedBulkLine = { phoneNumber: string; apiUrl: string };

// Line separator between phone number and API URL, e.g.
// +917507166497----https://example.com/getcode?id=...
const SEPARATOR = "----";

export function parseBulkAddInput(text: string): {
  lines: ParsedBulkLine[];
  errors: string[];
} {
  const lines: ParsedBulkLine[] = [];
  const errors: string[] = [];
  const raw = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of raw) {
    const idx = line.indexOf(SEPARATOR);
    // No separator -> phone-only line: the account is created but not
    // authenticated (there is no API page to read a code from).
    if (idx === -1) {
      lines.push({ phoneNumber: line, apiUrl: "" });
      continue;
    }
    const phoneNumber = line.slice(0, idx).trim();
    const apiUrl = line.slice(idx + SEPARATOR.length).trim();
    if (!phoneNumber) {
      errors.push(`Missing phone number: ${line}`);
      continue;
    }
    lines.push({ phoneNumber, apiUrl });
  }
  return { lines, errors };
}

// How to pull a single value out of the getcode page HTML. A regex (with a
// capture group for the value) takes precedence; otherwise the value is read
// from the readonly <input> carrying the given id.
export type FieldExtractor = { fieldId?: string; regex?: string };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractField(html: string, ex: FieldExtractor): string {
  if (ex.regex && ex.regex.trim()) {
    try {
      return new RegExp(ex.regex, "i").exec(html)?.[1]?.trim() ?? "";
    } catch {
      return "";
    }
  }
  const id = ex.fieldId?.trim() || "code";
  const tag = html.match(
    new RegExp(`<input[^>]*\\bid=["']${escapeRegex(id)}["'][^>]*>`, "i"),
  )?.[0];
  return tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1]?.trim() ?? "";
}

// Pulls the verification code and 2FA password out of the getcode page HTML.
// The page renders them as readonly inputs: <input id="code" value="42344">
// and <input id="pass2fa" value="bemby">. Defaults reproduce that layout.
export function extractApiCredentials(
  html: string,
  codeEx: FieldExtractor = { fieldId: "code" },
  twoFaEx: FieldExtractor = { fieldId: "pass2fa" },
): { code: string; pass2fa: string } {
  return {
    code: extractField(html, codeEx),
    pass2fa: extractField(html, twoFaEx),
  };
}

// User-supplied, per-batch customisation. Everything is optional and falls
// back to the defaults below.
export type BulkAddOptions = {
  /** Pause between accounts, in seconds (default 70). */
  gapSeconds?: number;
  /** Prefix for the generated Bemby name, e.g. "A_" -> A_1, A_2 (default "A_"). */
  namePrefix?: string;
  /**
   * Where the name's number starts. "total" continues from the current account
   * count (default); "batch" numbers this batch from 1.
   */
  nameIndexMode?: "total" | "batch";
  /** Zero-pad the name number to this many digits; 0/omitted = auto. */
  namePadDigits?: number;
  /** Notes template; "{apiUrl}" is replaced per account (default "Automatically added via {apiUrl}"). */
  notesTemplate?: string;
  /** HTML input id holding the verification code (default "code"). */
  codeFieldId?: string;
  /** Advanced: regex (capture group 1) for the code, overrides codeFieldId. */
  codeRegex?: string;
  /** Where the 2FA password comes from (default "api"). */
  twoFaMode?: "api" | "fixed";
  /** HTML input id holding the 2FA password (default "pass2fa"). */
  twoFaFieldId?: string;
  /** Advanced: regex (capture group 1) for the 2FA password, overrides twoFaFieldId. */
  twoFaRegex?: string;
  /** Fixed 2FA password, used when twoFaMode is "fixed". */
  twoFaFixed?: string;
  /** Candidate device (app client) ids; one is picked at random per account. Empty = all configured. */
  deviceIds?: string[];
  /** Candidate proxy ids; one is picked at random per account. Empty = all configured. */
  proxyIds?: string[];
  /** Candidate API ID/hash pairs; one is picked at random per account. Empty = leave NULL (global default). */
  apiCredentials?: { apiId: number; apiHash: string }[];
  /** How many times to retry an account after a failed authentication (default 2). */
  maxRetries?: number;
  /** Cooldown before a failed account is retried, in seconds (default 300). */
  retryDelaySeconds?: number;
};

type BulkAddConfig = {
  /** Wait after requesting a code before first polling the API page. */
  initialWaitMs: number;
  /** Wait after a failed/empty page fetch before retrying (rate limit). */
  rateLimitWaitMs: number;
  /** Pause after each account before moving to the next. */
  betweenAccountsMs: number;
  /** Max retries after a failed authentication (0 disables retrying). */
  maxRetries: number;
  /** Cooldown before a failed account is re-queued for retry. */
  retryDelayMs: number;
  /** Max attempts to read a code from the API page. */
  maxFetchAttempts: number;
  namePrefix: string;
  nameIndexMode: "total" | "batch";
  namePadDigits: number;
  notesTemplate: string;
  codeEx: FieldExtractor;
  twoFaMode: "api" | "fixed";
  twoFaEx: FieldExtractor;
  twoFaFixed: string;
  deviceIds: string[];
  proxyIds: string[];
  apiCredentials: { apiId: number; apiHash: string }[];
};

const DEFAULT_GAP_SECONDS = 70;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_SECONDS = 300;
const DEFAULT_NAME_PREFIX = "A_";
const DEFAULT_NOTES_TEMPLATE = "Automatically added via {apiUrl}";

function resolveConfig(opts?: BulkAddOptions): BulkAddConfig {
  const gap = Number(opts?.gapSeconds);
  const retries = Number(opts?.maxRetries);
  const retryDelay = Number(opts?.retryDelaySeconds);
  return {
    initialWaitMs: 15_000,
    rateLimitWaitMs: 120_000,
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
    maxFetchAttempts: 5,
    namePrefix: opts?.namePrefix ?? DEFAULT_NAME_PREFIX,
    nameIndexMode: opts?.nameIndexMode === "batch" ? "batch" : "total",
    namePadDigits:
      Number(opts?.namePadDigits) > 0 ? Math.floor(Number(opts?.namePadDigits)) : 0,
    notesTemplate: opts?.notesTemplate ?? DEFAULT_NOTES_TEMPLATE,
    codeEx: { fieldId: opts?.codeFieldId, regex: opts?.codeRegex },
    twoFaMode: opts?.twoFaMode === "fixed" ? "fixed" : "api",
    twoFaEx: { fieldId: opts?.twoFaFieldId, regex: opts?.twoFaRegex },
    twoFaFixed: opts?.twoFaFixed ?? "",
    deviceIds: Array.isArray(opts?.deviceIds)
      ? opts!.deviceIds.filter((x): x is string => typeof x === "string")
      : [],
    proxyIds: Array.isArray(opts?.proxyIds)
      ? opts!.proxyIds.filter((x): x is string => typeof x === "string")
      : [],
    apiCredentials: Array.isArray(opts?.apiCredentials)
      ? opts!.apiCredentials
          .map((c) => ({
            apiId: Number(c?.apiId),
            apiHash: String(c?.apiHash ?? "").trim(),
          }))
          .filter((c) => Number.isInteger(c.apiId) && c.apiId > 0 && !!c.apiHash)
      : [],
  };
}

let current: BulkAddBatch | null = null;

// Bulk account management (bulk add + bulk clean) is opt-in via the
// BULK_ACCOUNT_MANAGEMENT env var ("1"/"true").
export function isBulkAccountManagementEnabled(): boolean {
  const v = (process.env.BULK_ACCOUNT_MANAGEMENT ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function getBulkAddStatus(): BulkAddBatch | null {
  return current;
}

export function cancelBulkAdd(): boolean {
  if (!current || !current.running) return false;
  current.cancelled = true;
  current.paused = false;
  return true;
}

/** Holds the batch once the account in flight is done; false if it had finished. */
export function pauseBulkAdd(): boolean {
  if (!current || !current.running || current.cancelled) return false;
  current.paused = true;
  return true;
}

/** Lets a held batch carry on; false if it was not paused. */
export function resumeBulkAdd(): boolean {
  if (!current || !current.running || !current.paused) return false;
  current.paused = false;
  return true;
}

/**
 * Forgets a finished batch, so the task dock stops listing it. Only the panel clearing its
 * own view used to happen, which left this batch here for the next poll to hand straight
 * back -- the card could not be got rid of short of restarting the backend.
 */
export function clearBulkAdd(): boolean {
  if (!current || current.running) return false;
  current = null;
  return true;
}

function readSettingList<T>(key: string): T[] {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  try {
    return row?.value ? (JSON.parse(row.value) as T[]) : [];
  } catch {
    return [];
  }
}

function pickRandom<T>(arr: T[]): T | null {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function resolveProxyUrl(proxyId: string | null): string | undefined {
  if (!proxyId) return undefined;
  const list = readSettingList<{ id: string; url: string }>("proxies");
  return list.find((p) => p.id === proxyId)?.url;
}

// Abortable sleep -- resolves early when the batch is cancelled.
function sleep(ms: number, batch: BulkAddBatch): Promise<void> {
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
  batch: BulkAddBatch,
  item: BulkAddItem,
): Promise<void> {
  while (batch.paused && !batch.cancelled) {
    item.status = "paused";
    item.message = "Paused";
    await sleep(250, batch);
  }
}

async function fetchApiCredentials(
  url: string,
  config: BulkAddConfig,
): Promise<{ code: string; pass2fa: string }> {
  // A page that accepts the connection but never responds would hang the whole
  // sequential batch on this account -- bound it so the retry loop can proceed.
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  return extractApiCredentials(html, config.codeEx, config.twoFaEx);
}

type AccountRow = {
  id: number;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  proxy_id: string | null;
  app_client_id: string | null;
};

async function authenticateAccount(
  batch: BulkAddBatch,
  item: BulkAddItem,
  config: BulkAddConfig,
): Promise<void> {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(item.accountId) as AccountRow | undefined;
  if (!account) throw new Error("Account not found");
  decryptAccountRow(account);

  const own =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const creds = own ?? getDefaultTgApiCredentials();
  if (!creds)
    throw new Error(
      "No API credentials -- configure global defaults in Settings",
    );

  const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
  const deviceParams = resolveAppClientParams(
    account.id,
    account.app_client_id,
  );

  // 1. Request the verification code
  item.status = "requesting_code";
  item.message = "Requesting verification code";
  await requestCode(
    account.id,
    creds.apiId,
    creds.apiHash,
    account.phone_number,
    proxy,
    deviceParams,
  );
  db.prepare(
    "UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?",
  ).run(account.id);

  // 2. Poll the API page for the code (page is only populated after the code
  // is sent, and it rate-limits -- back off on failure/empty result)
  item.status = "fetching_code";
  item.message = "Waiting for code to arrive on API page";
  await sleep(config.initialWaitMs, batch);
  if (batch.cancelled) throw new Error("Cancelled");

  let apiCreds: { code: string; pass2fa: string } | null = null;
  for (let attempt = 1; attempt <= config.maxFetchAttempts; attempt++) {
    if (batch.cancelled) throw new Error("Cancelled");
    try {
      const r = await fetchApiCredentials(item.apiUrl, config);
      if (r.code) {
        apiCreds = r;
        break;
      }
      item.message = `Code not ready (attempt ${attempt}/${config.maxFetchAttempts})`;
    } catch (err: any) {
      item.message = `Fetch failed (attempt ${attempt}/${config.maxFetchAttempts}): ${err?.message ?? err}`;
    }
    if (attempt < config.maxFetchAttempts) {
      item.message += ` -- retrying in ${Math.round(config.rateLimitWaitMs / 1000)}s`;
      await sleep(config.rateLimitWaitMs, batch);
    }
  }
  if (!apiCreds)
    throw new Error("Could not retrieve verification code from API page");

  // 3. Submit the code, then 2FA password if required
  item.status = "submitting_code";
  item.message = "Submitting verification code";
  const result = await submitCode(account.id, apiCreds.code);
  if (result.needsPassword) {
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?",
    ).run(account.id);
    // Fixed mode uses the batch password; otherwise take it from the API page.
    const pass2fa =
      config.twoFaMode === "fixed" ? config.twoFaFixed : apiCreds.pass2fa;
    if (!pass2fa)
      throw new Error(
        config.twoFaMode === "fixed"
          ? "2FA required but no fixed password was provided"
          : "2FA required but the API page has no password",
      );
    item.status = "submitting_2fa";
    item.message = "Submitting 2FA password";
    const session = await submitPassword(account.id, pass2fa);
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
    ).run(encryptSecret(session), account.id);
  } else {
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
    ).run(encryptSecret(result.session), account.id);
  }

  item.status = "done";
  item.message = "Authenticated";
}

function isAccountAuthenticated(accountId: number): boolean {
  const row = db
    .prepare("SELECT auth_status FROM tg_accounts WHERE id = ?")
    .get(accountId) as { auth_status: string } | undefined;
  return row?.auth_status === "authenticated";
}

// A unit of work in the run queue: the account plus the earliest time it may
// be (re)attempted. Failed accounts are re-queued with readyAt in the future.
type QueueEntry = { item: BulkAddItem; readyAt: number };

async function runBatch(
  batch: BulkAddBatch,
  config: BulkAddConfig,
): Promise<void> {
  try {
    // Resolve everything that needs no authentication up front (no gap, no
    // queue), and collect the rest into a FIFO work queue.
    const queue: QueueEntry[] = [];
    for (const item of batch.items) {
      if (batch.cancelled) break;

      // A pre-existing account that is already authenticated needs nothing.
      if (
        item.existing &&
        item.accountId != null &&
        isAccountAuthenticated(item.accountId)
      ) {
        item.status = "skipped";
        item.message = "Already authenticated";
        continue;
      }

      // No API page: nothing to authenticate against. A new line is left as a
      // created-but-unauthenticated account; an existing one is left as is.
      if (!item.apiUrl) {
        item.status = item.existing ? "skipped" : "created";
        item.message = item.existing
          ? "Already exists, no API page to authenticate"
          : "Added without authentication";
        continue;
      }

      queue.push({ item, readyAt: 0 });
    }

    // The inter-account gap spaces Telegram sendCode calls, so it belongs
    // between two authentications -- applied before every auth except the
    // first. A failed account is re-queued (readyAt = now + retryDelay) and
    // retried up to config.maxRetries times; retries sit behind still-pending
    // accounts and only wait out their remaining cooldown once reached.
    const totalAttempts = config.maxRetries + 1;
    let authenticatedAny = false;
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

      if (authenticatedAny) {
        item.status = "waiting";
        item.message = `Waiting ${Math.round(config.betweenAccountsMs / 1000)}s before authenticating`;
        await sleep(config.betweenAccountsMs, batch);
        if (batch.cancelled) break;
      }

      await holdWhilePaused(batch, item);
      if (batch.cancelled) break;

      item.attempts++;
      try {
        await authenticateAccount(batch, item, config);
        item.error = null;
      } catch (err: any) {
        const reason = err?.message ?? String(err);
        // requestCode may have parked a connected client before the failure;
        // drop it so abandoned accounts don't leak sessions.
        if (item.accountId != null) await cancelPendingAuth(item.accountId);
        // Re-queue for a later retry, unless out of attempts or cancelled. While
        // a retry is pending the reason goes in the (non-error) message so the
        // row reads as "retrying", not a hard failure; error is only set once
        // all attempts are exhausted.
        if (item.attempts <= config.maxRetries && !batch.cancelled) {
          entry.readyAt = Date.now() + config.retryDelayMs;
          item.status = "retrying";
          item.error = null;
          item.message = `Attempt ${item.attempts}/${totalAttempts} failed (${reason}) -- retrying in ${Math.round(config.retryDelayMs / 1000)}s`;
          queue.push(entry);
        } else {
          item.status = "failed";
          item.error = reason;
          item.message = `Failed after ${item.attempts} attempt(s)`;
        }
      }
      authenticatedAny = true;
    }
  } finally {
    batch.running = false;
  }
}

// Creates the accounts for the parsed lines, returning the created items.
// A line whose phone number already exists in the system reuses that account
// instead of inserting a duplicate; only genuinely new lines are created and
// consume a generated name. Name = {prefix}(current account count + 1).
function createAccounts(
  lines: ParsedBulkLine[],
  config: BulkAddConfig,
): BulkAddItem[] {
  // Restrict the random pools to the user-selected candidates; an empty
  // selection means "any configured entry".
  // These become account proxies, i.e. Telegram exits, so HTTP entries (what a Webshare
  // sync produces) are no use here -- assigning one would leave the account connecting direct.
  const allProxies = readSettingList<{ id: string; url?: string }>("proxies").filter(
    (p) => !!parseTgProxy(p.url),
  );
  const allClients = readSettingList<{ id: string }>("tg_app_clients");
  const proxies = config.proxyIds.length
    ? allProxies.filter((p) => config.proxyIds.includes(p.id))
    : allProxies;
  if (config.proxyIds.length && !proxies.length)
    console.warn(
      "[bulkAdd] None of the selected proxies can carry Telegram (SOCKS only); accounts are created without one",
    );
  const clients = config.deviceIds.length
    ? allClients.filter((c) => config.deviceIds.includes(c.id))
    : allClients;

  const countRow = db
    .prepare("SELECT COUNT(*) AS c FROM tg_accounts")
    .get() as { c: number };
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
    .get() as { m: number };

  const items: BulkAddItem[] = [];
  // "total" continues the numbering from the existing account count; "batch"
  // restarts at 1 for this run. namePadDigits zero-pads the number; 0 means
  // auto (no padding for "total", at least 2 digits for "batch").
  const isBatch = config.nameIndexMode === "batch";
  let count = isBatch ? 0 : countRow.c;
  const padWidth =
    config.namePadDigits > 0
      ? config.namePadDigits
      : isBatch
        ? Math.max(2, String(lines.length).length)
        : 0;
  let sortOrder = maxRow.m;

  const insert = db.prepare(
    "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id, app_client_id, sort_order, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const findByPhone = db.prepare(
    "SELECT id, name FROM tg_accounts WHERE phone_number = ?",
  );

  lines.forEach((line, index) => {
    // Reuse an existing account rather than inserting a duplicate. It keeps its
    // own name and credentials; authentication (if needed) is decided at run
    // time from its current auth_status.
    const existing = findByPhone.get(line.phoneNumber) as
      | { id: number; name: string }
      | undefined;
    if (existing) {
      items.push({
        index,
        phoneNumber: line.phoneNumber,
        apiUrl: line.apiUrl,
        accountId: existing.id,
        accountName: existing.name,
        existing: true,
        attempts: 0,
        status: "pending",
        message: "",
        error: null,
      });
      return;
    }

    const num = count + 1;
    const name = `${config.namePrefix}${padWidth ? String(num).padStart(padWidth, "0") : num}`;
    const proxyId = pickRandom(proxies)?.id ?? null;
    const appClientId = pickRandom(clients)?.id ?? null;
    // A picked pair overrides the account's api credentials; otherwise leave
    // NULL so authentication falls back to the global default.
    const cred = pickRandom(config.apiCredentials);
    const notes = config.notesTemplate.replace(/\{apiUrl\}/g, line.apiUrl);
    const res = insert.run(
      name,
      line.phoneNumber,
      cred?.apiId ?? null,
      encryptSecret(cred?.apiHash ?? null),
      proxyId,
      appClientId,
      ++sortOrder,
      notes,
    );
    count++;
    items.push({
      index,
      phoneNumber: line.phoneNumber,
      apiUrl: line.apiUrl,
      accountId: Number(res.lastInsertRowid),
      accountName: name,
      existing: false,
      attempts: 0,
      status: "pending",
      message: "",
      error: null,
    });
  });

  return items;
}

export type StartBulkAddResult =
  | { ok: true; batch: BulkAddBatch }
  | { ok: false; error: string };

export function startBulkAdd(
  text: string,
  options?: BulkAddOptions,
): StartBulkAddResult {
  if (current?.running) {
    return { ok: false, error: "A bulk-add batch is already running" };
  }

  const { lines, errors } = parseBulkAddInput(text);
  if (errors.length) {
    return { ok: false, error: errors.join("\n") };
  }
  if (!lines.length) {
    return { ok: false, error: "No valid account lines provided" };
  }
  const config = resolveConfig(options);

  // Credentials are only needed for accounts that will be authenticated; the
  // per-batch pairs cover this without global defaults.
  const needsAuth = lines.some((l) => l.apiUrl);
  if (
    needsAuth &&
    config.apiCredentials.length === 0 &&
    !getDefaultTgApiCredentials()
  ) {
    return {
      ok: false,
      error:
        "Telegram API credentials are required (add API ID/hash pairs or configure global defaults in Settings)",
    };
  }

  const items = createAccounts(lines, config);

  const batch: BulkAddBatch = {
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
