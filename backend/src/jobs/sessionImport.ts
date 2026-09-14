import crypto from "crypto";
import { TelegramClient, Api, Logger } from "telegram";
import { StringSession } from "telegram/sessions";
import { LogLevel } from "telegram/extensions/Logger";
import { db } from "../db/database";
import { encryptSecret } from "../db/secretColumns";
import { patchAttributes } from "../db/accountAttributes";
import { parseTgProxy } from "./runner";
import { resolveProxyUrl } from "./accountOps";
import { connectWithTimeout, destroyQuietly } from "../tg/clientTimeout";
import { clampGap } from "./bulkTasks";
import {
  aliveCheck,
  submitCards,
  downloadZip,
  parseConvertedArchive,
  normaliseConverterBase,
  type AliveStatus,
  type ConvertedAccount,
} from "./sessionConvert";

// Imports "protocol-only" TG accounts sold as cards. Each card line is redeemed at a
// caller-supplied converter (see sessionConvert), which returns a real session; the account is
// already-authenticated, with its login fingerprint pinned so nothing re-registers the bought
// key under a different device. This is a session import, not the getcode/bulk-add code flow.

export type SessionImportItemStatus =
  | "pending"
  | "checking"
  | "frozen"
  | "dead"
  | "converting"
  | "validating"
  | "importing"
  | "waiting"
  | "created"
  | "skipped"
  | "failed";

export type SessionImportItem = {
  index: number;
  phoneNumber: string;
  apiUrl: string;
  accountId: number | null;
  accountName: string | null;
  /** True when a matching account already existed and was left untouched. */
  existing: boolean;
  aliveStatus: AliveStatus | null;
  status: SessionImportItemStatus;
  message: string;
  error: string | null;
};

export type SessionImportBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  gapSeconds: number;
  total: number;
  items: SessionImportItem[];
};

export type SessionImportOptions = {
  /** Base URL of the card-to-session converter, supplied per import -- never stored in code. */
  converterBaseUrl?: string;
  /** Screen each card with the converter's liveness check before converting (default true). */
  aliveCheckFirst?: boolean;
  /** Also request the tdesktop tdata folder in the archive (default false; unused by import). */
  includeTdata?: boolean;
  /** Pause between account validations, in seconds (default 8) -- spaces MTProto connects. */
  gapSeconds?: number;
  /** Generated Bemby name prefix (default "TG_"). */
  namePrefix?: string;
  /** "total" continues from the account count (default); "batch" restarts at 1. */
  nameIndexMode?: "total" | "batch";
  /** Zero-pad the name number; 0/omitted = auto. */
  namePadDigits?: number;
  /** Notes template; {phone} and {uuid} are substituted (default). */
  notesTemplate?: string;
  /** Candidate proxy ids (SOCKS); one is assigned per account at random. Empty = global exit. */
  proxyIds?: string[];
};

const DEFAULT_GAP_SECONDS = 8;
const DEFAULT_NAME_PREFIX = "TG_";
const DEFAULT_NOTES_TEMPLATE = "Imported session ({phone})";
const CONVERT_CHUNK = 100;

const uuidPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ParsedCardLine = { phoneNumber: string; apiUrl: string; line: string };

/**
 * Card lines are "phone----url", but only the URL's UUID actually identifies the card to the
 * converter, so a bare UUID or a plain link is accepted too. The phone is display-only here.
 */
export function parseCardInput(text: string): {
  lines: ParsedCardLine[];
  errors: string[];
} {
  const lines: ParsedCardLine[] = [];
  const errors: string[] = [];
  const raw = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of raw) {
    if (!uuidPattern.test(line)) {
      errors.push(`No card UUID found: ${line}`);
      continue;
    }
    const sep = line.indexOf("----");
    const phoneNumber = sep >= 0 ? line.slice(0, sep).trim() : "";
    const apiUrl = sep >= 0 ? line.slice(sep + 4).trim() : line;
    lines.push({ phoneNumber, apiUrl, line });
  }
  return { lines, errors };
}

let current: SessionImportBatch | null = null;

export function getSessionImportStatus(): SessionImportBatch | null {
  return current;
}

export function cancelSessionImport(): boolean {
  if (!current || !current.running) return false;
  current.cancelled = true;
  return true;
}

export function clearSessionImport(): boolean {
  if (!current || current.running) return false;
  current = null;
  return true;
}

// Last converter base URL used, kept in the settings table so the operator supplies it once
// rather than on every import. It is a service address, not a secret, and never ships in code.
const CONVERTER_BASE_KEY = "session_converter_base";

export function readLastConverterBase(): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(CONVERTER_BASE_KEY) as { value: string } | undefined;
  return row?.value ?? "";
}

function saveLastConverterBase(base: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  ).run(CONVERTER_BASE_KEY, base);
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

function sleep(ms: number, batch: SessionImportBatch): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (batch.cancelled || Date.now() - start >= ms) return resolve();
      setTimeout(tick, Math.min(500, ms));
    };
    tick();
  });
}

/** Connect once with the pinned fingerprint and confirm the session is authorised. */
async function validateSession(
  account: ConvertedAccount,
  proxyId: string | null,
): Promise<{ userId: string; username?: string; firstName?: string }> {
  const proxy = parseTgProxy(resolveProxyUrl(proxyId));
  const client = new TelegramClient(
    new StringSession(account.sessionString),
    account.meta.apiId,
    account.meta.apiHash,
    {
      connectionRetries: 2,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(account.meta.deviceModel ? { deviceModel: account.meta.deviceModel } : {}),
      ...(account.meta.systemVersion
        ? { systemVersion: account.meta.systemVersion }
        : {}),
      ...(account.meta.appVersion ? { appVersion: account.meta.appVersion } : {}),
      ...(account.meta.systemLangCode
        ? { systemLangCode: account.meta.systemLangCode }
        : {}),
    },
  );
  try {
    await connectWithTimeout(client, "session import validate");
    if (!(await client.checkAuthorization())) {
      throw new Error("session is not authorised (dead or revoked)");
    }
    const me = (await client.getMe()) as Api.User;
    if (me.deleted) throw new Error("account is deleted");
    return {
      userId: String(me.id),
      username: me.username ?? undefined,
      firstName: me.firstName ?? undefined,
    };
  } finally {
    await destroyQuietly(client, "session import validate");
  }
}

type ExistingRow = { id: number; name: string };

/** Insert the account already-authenticated, pinning the vendor's fingerprint and api creds. */
function insertImportedAccount(
  account: ConvertedAccount,
  name: string,
  proxyId: string | null,
  notes: string,
  sortOrder: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO tg_accounts
         (name, phone_number, api_id, api_hash, session_string, auth_status,
          proxy_id, sort_order, notes)
       VALUES (?, ?, ?, ?, ?, 'authenticated', ?, ?, ?)`,
    )
    .run(
      name,
      account.phone || account.meta.phone,
      account.meta.apiId,
      encryptSecret(account.meta.apiHash),
      encryptSecret(account.sessionString),
      proxyId,
      sortOrder,
      notes,
    );
  const id = Number(info.lastInsertRowid);
  // Pin the device fingerprint so resolveAppClientParams never rolls a random client for a
  // bought key. The 2FA is kept (encrypted, UI-stripped) for the later take-ownership step.
  patchAttributes(id, {
    sessionSource: "imported",
    pinnedClient: {
      deviceModel: account.meta.deviceModel ?? null,
      systemVersion: account.meta.systemVersion ?? null,
      appVersion: account.meta.appVersion ?? null,
      systemLangCode: account.meta.systemLangCode ?? null,
      langPack: account.meta.langPack ?? null,
    },
    ...(account.meta.twoFa
      ? { importedTwoFa: encryptSecret(account.meta.twoFa) }
      : {}),
  });
  return id;
}

async function runBatch(
  batch: SessionImportBatch,
  opts: SessionImportOptions,
  converterBase: string,
): Promise<void> {
  try {
    const proxies = readSettingList<{ id: string; url?: string }>("proxies").filter(
      (p) => !!parseTgProxy(p.url),
    );
    const candidateProxies =
      opts.proxyIds && opts.proxyIds.length
        ? proxies.filter((p) => opts.proxyIds!.includes(p.id))
        : proxies;

    const findByPhone = db.prepare(
      "SELECT id, name FROM tg_accounts WHERE phone_number = ?",
    );
    const findByUserId = db.prepare(
      "SELECT id, name FROM tg_accounts WHERE json_extract(additional_attributes, '$.tgUserId') = ?",
    );

    const countRow = db
      .prepare("SELECT COUNT(*) AS c FROM tg_accounts")
      .get() as { c: number };
    const maxRow = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
      .get() as { m: number };
    const isBatch = opts.nameIndexMode === "batch";
    const prefix = opts.namePrefix ?? DEFAULT_NAME_PREFIX;
    const padWidth =
      opts.namePadDigits && opts.namePadDigits > 0
        ? opts.namePadDigits
        : isBatch
          ? Math.max(2, String(batch.total).length)
          : 0;
    const notesTemplate = opts.notesTemplate ?? DEFAULT_NOTES_TEMPLATE;
    let count = isBatch ? 0 : countRow.c;
    let sortOrder = maxRow.m;

    // Phase 1: liveness screen (default on). The converter warns that downloading forfeits
    // the free-replacement option, so a dead/frozen card is caught before it is spent.
    const toConvert: SessionImportItem[] = [];
    for (const item of batch.items) {
      if (batch.cancelled) break;
      if (item.status === "failed" || item.status === "skipped") continue;
      if (opts.aliveCheckFirst === false) {
        toConvert.push(item);
        continue;
      }
      item.status = "checking";
      item.message = "Checking card is alive";
      try {
        const alive = await aliveCheck(converterBase, item.apiUrl);
        item.aliveStatus = alive;
        // Only an explicit frozen/dead verdict blocks conversion. "unknown" (a wording the
        // check did not recognise, or a transient) is not a condemnation -- convert and let
        // the real connect be the judge, exactly as on a check that errored outright.
        if (alive === "frozen" || alive === "dead") {
          item.status = alive;
          item.message = `Card not usable (${alive})`;
          item.error = `Card not usable (${alive})`;
        } else {
          if (alive === "unknown") {
            item.message = "Liveness unclear; will still convert";
          }
          toConvert.push(item);
        }
      } catch (err: any) {
        // A liveness endpoint hiccup should not condemn a card -- convert and let the real
        // connect be the judge.
        item.message = `Liveness check failed (${err?.message ?? err}); will still convert`;
        toConvert.push(item);
      }
    }

    // Phase 2: convert the alive cards (chunked), download and unpack into per-account creds.
    const converted = new Map<string, ConvertedAccount>();
    const itemByUrlUuid = new Map<string, SessionImportItem>();
    for (const it of toConvert) {
      const uuid = (it.apiUrl.match(uuidPattern)?.[0] ?? "").toLowerCase();
      if (uuid) itemByUrlUuid.set(uuid, it);
    }
    for (let i = 0; i < toConvert.length && !batch.cancelled; i += CONVERT_CHUNK) {
      const chunk = toConvert.slice(i, i + CONVERT_CHUNK);
      for (const it of chunk) {
        it.status = "converting";
        it.message = "Converting card to session";
      }
      try {
        const res = await submitCards(
          converterBase,
          chunk.map((c) => c.apiUrl),
          opts.includeTdata,
        );
        const zip = await downloadZip(converterBase, res.downloadUrl);
        const { accounts, errors } = parseConvertedArchive(zip);
        for (const acc of accounts) {
          const key = (acc.meta.uuid ?? "").toLowerCase();
          if (key) converted.set(key, acc);
          else converted.set(acc.phone, acc);
        }
        for (const e of errors) {
          // Errors are keyed by phone stem; match back to an item by phone where possible.
          const hit = chunk.find((c) => c.phoneNumber === e.phone);
          if (hit) {
            hit.status = "failed";
            hit.error = `Conversion problem: ${e.error}`;
            hit.message = hit.error;
          }
        }
      } catch (err: any) {
        for (const it of chunk) {
          if (it.status === "converting") {
            it.status = "failed";
            it.error = `Conversion failed: ${err?.message ?? err}`;
            it.message = it.error;
          }
        }
      }
    }

    // Phase 3: validate each converted session by connecting, then insert it.
    let validatedAny = false;
    for (const item of toConvert) {
      if (batch.cancelled) break;
      if (item.status === "failed") continue;

      const uuid = (item.apiUrl.match(uuidPattern)?.[0] ?? "").toLowerCase();
      const acc =
        (uuid && converted.get(uuid)) ||
        (item.phoneNumber && converted.get(item.phoneNumber)) ||
        null;
      if (!acc) {
        item.status = "failed";
        item.error = "Converter returned no session for this card";
        item.message = item.error;
        continue;
      }

      const phone = acc.phone || acc.meta.phone || item.phoneNumber;
      const existing =
        (findByPhone.get(phone) as ExistingRow | undefined) ?? undefined;
      if (existing) {
        item.status = "skipped";
        item.existing = true;
        item.accountId = existing.id;
        item.accountName = existing.name;
        item.message = "Already exists (matched by phone)";
        continue;
      }

      if (validatedAny) {
        item.status = "waiting";
        item.message = `Waiting ${batch.gapSeconds}s before next connect`;
        await sleep(batch.gapSeconds * 1000, batch);
        if (batch.cancelled) break;
      }
      validatedAny = true;

      const proxyId = pickRandom(candidateProxies)?.id ?? null;
      item.status = "validating";
      item.message = "Connecting to verify the session";
      let me: { userId: string; username?: string; firstName?: string };
      try {
        me = await validateSession(acc, proxyId);
      } catch (err: any) {
        item.status = "failed";
        item.error = `Validation failed: ${err?.message ?? err}`;
        item.message = item.error;
        continue;
      }

      const dupById = findByUserId.get(me.userId) as ExistingRow | undefined;
      if (dupById) {
        item.status = "skipped";
        item.existing = true;
        item.accountId = dupById.id;
        item.accountName = dupById.name;
        item.message = `Already exists (same Telegram account, #${dupById.id})`;
        continue;
      }

      item.status = "importing";
      item.message = "Saving account";
      const num = count + 1;
      const name = `${prefix}${padWidth ? String(num).padStart(padWidth, "0") : num}`;
      const notes = notesTemplate
        .replace(/\{phone\}/g, phone)
        .replace(/\{uuid\}/g, acc.meta.uuid ?? "");
      try {
        const id = insertImportedAccount(acc, name, proxyId, notes, ++sortOrder);
        patchAttributes(id, {
          tgUserId: me.userId,
          ...(me.username ? { tgUsernameCache: me.username } : {}),
        });
        count++;
        item.accountId = id;
        item.accountName = name;
        item.existing = false;
        item.status = "created";
        item.message = `Imported ${me.firstName ?? phone}${me.username ? ` (@${me.username})` : ""}`;
      } catch (err: any) {
        item.status = "failed";
        item.error = `Save failed: ${err?.message ?? err}`;
        item.message = item.error;
      }
    }
  } finally {
    batch.running = false;
  }
}

export type StartSessionImportResult =
  | { ok: true; batch: SessionImportBatch }
  | { ok: false; error: string };

export function startSessionImport(
  text: string,
  options?: SessionImportOptions,
): StartSessionImportResult {
  if (current?.running) {
    return { ok: false, error: "A session import is already running" };
  }
  // The converter address is supplied per import (or falls back to the last one used) so it is
  // never committed to the repo. Validate it up front rather than failing every card later.
  let converterBase: string;
  try {
    converterBase = normaliseConverterBase(
      options?.converterBaseUrl || readLastConverterBase(),
    );
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "A converter URL is required" };
  }
  const { lines, errors } = parseCardInput(text);
  if (errors.length) return { ok: false, error: errors.join("\n") };
  if (!lines.length) return { ok: false, error: "No valid card lines provided" };
  // Remember it for next time, so the operator types it once.
  saveLastConverterBase(converterBase);

  const items: SessionImportItem[] = lines.map((l, index) => ({
    index,
    phoneNumber: l.phoneNumber,
    apiUrl: l.apiUrl,
    accountId: null,
    accountName: null,
    existing: false,
    aliveStatus: null,
    status: "pending",
    message: "",
    error: null,
  }));

  const batch: SessionImportBatch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    running: true,
    cancelled: false,
    gapSeconds: clampGap(options?.gapSeconds ?? DEFAULT_GAP_SECONDS),
    total: items.length,
    items,
  };
  current = batch;
  void runBatch(batch, options ?? {}, converterBase);
  return { ok: true, batch };
}
