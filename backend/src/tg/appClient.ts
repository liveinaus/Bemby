import { db } from "../db/database";
import { expandCommand } from "../jobs/checkin";
import type { TgAppClient } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";

// Per-account map of the randomly-assigned app client, keyed by account id.
// Kept in the settings table so a random pick stays stable for an account.
const ASSIGNMENTS_KEY = "tg_client_assignments";

// Per-account cache of the expanded deviceModel string. Persisting it keeps
// random tokens (e.g. {word:4}) stable across connects; we only re-expand when
// the source template or the account context changes (see `sig`).
const DEVICE_NAMES_KEY = "tg_client_device_names";

type CachedDeviceName = { sig: string; deviceModel: string };

function readAppClients(): TgAppClient[] {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_app_clients") as { value: string } | undefined;
    if (!row?.value) return [];
    return JSON.parse(row.value) as TgAppClient[];
  } catch {
    return [];
  }
}

function readAssignments(): Record<string, string> {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(ASSIGNMENTS_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveAssignment(accountId: number, clientId: string): void {
  const map = readAssignments();
  map[String(accountId)] = clientId;
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  ).run(ASSIGNMENTS_KEY, JSON.stringify(map));
}

function readDeviceNames(): Record<string, CachedDeviceName> {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(DEVICE_NAMES_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    return JSON.parse(row.value) as Record<string, CachedDeviceName>;
  } catch {
    return {};
  }
}

function saveDeviceName(accountId: number, entry: CachedDeviceName): void {
  const map = readDeviceNames();
  map[String(accountId)] = entry;
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  ).run(DEVICE_NAMES_KEY, JSON.stringify(map));
}

/**
 * Resolve the deviceModel for an account, expanding template variables.
 * Supported tokens: {name} (Bemby name), {tgName} (Telegram display name),
 * {tgUsername}, {id}, plus the random tokens from expandCommand ({word:4} etc.).
 * The expanded value is persisted per account so random tokens stay stable;
 * it is only re-rolled when the template or account context changes.
 */
function resolveDeviceModel(
  accountId: number,
  client: TgAppClient,
  persist = true,
): string {
  const template = client.deviceModel;
  // Fast path: no variables to expand.
  if (!template.includes("{")) return template;

  const acct = db
    .prepare(
      "SELECT name, tg_display_name, tg_username FROM tg_accounts WHERE id = ?",
    )
    .get(accountId) as
    | { name: string; tg_display_name: string | null; tg_username: string | null }
    | undefined;

  const context: Record<string, string> = {
    name: acct?.name ?? "",
    tgName: acct?.tg_display_name ?? "",
    tgUsername: acct?.tg_username ?? "",
    id: String(accountId),
  };

  // Signature captures everything that should trigger a re-expansion.
  const sig = [
    client.id,
    template,
    context.name,
    context.tgName,
    context.tgUsername,
  ].join("|");

  const cached = readDeviceNames()[String(accountId)];
  if (cached && cached.sig === sig) return cached.deviceModel;

  const expanded = expandCommand(template, context);
  if (persist) saveDeviceName(accountId, { sig, deviceModel: expanded });
  return expanded;
}

/**
 * Read-only preview of the device model an account would use for a given
 * (possibly hypothetical) client selection. Does not persist random tokens or
 * random-client assignments, so it is safe to call for UI previews.
 * Returns null when no clients are configured / resolvable.
 */
export function previewDeviceModel(
  accountId: number,
  appClientId: string | null | undefined,
): string | null {
  try {
    const list = readAppClients();
    if (!list.length) return null;

    let client: TgAppClient | undefined;
    if (appClientId) {
      client = list.find((c) => c.id === appClientId);
    } else {
      const modeRow = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("tg_client_mode") as { value: string } | undefined;
      if (modeRow?.value === "random") {
        // Reuse an existing sticky pick if present; otherwise fall back to the
        // default as an illustrative preview (the real pick happens on connect).
        const assignedId = readAssignments()[String(accountId)];
        client =
          (assignedId && list.find((c) => c.id === assignedId)) ||
          list.find((c) => c.isDefault);
      } else {
        client = list.find((c) => c.isDefault);
      }
    }

    if (!client) return null;
    return resolveDeviceModel(accountId, client, false);
  } catch {
    return null;
  }
}

/**
 * The pinned device fingerprint for an imported account, or null. Stored in
 * additional_attributes.pinnedClient by the session importer; only fields the vendor actually
 * supplied are returned, so GramJS fills the rest from its own defaults.
 */
function readPinnedClient(accountId: number): TgDeviceParams | null {
  let pinned: Record<string, unknown> | undefined;
  try {
    const row = db
      .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
      .get(accountId) as { additional_attributes: string | null } | undefined;
    if (!row?.additional_attributes) return null;
    const attrs = JSON.parse(row.additional_attributes) as Record<string, unknown>;
    pinned = attrs?.pinnedClient as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  if (!pinned || typeof pinned !== "object") return null;
  const params: TgDeviceParams = {};
  const put = (k: keyof TgDeviceParams, v: unknown) => {
    if (typeof v === "string" && v) params[k] = v;
  };
  put("deviceModel", pinned.deviceModel);
  put("systemVersion", pinned.systemVersion);
  put("appVersion", pinned.appVersion);
  put("systemLangCode", pinned.systemLangCode);
  put("langPack", pinned.langPack);
  put("langCode", pinned.langCode);
  return Object.keys(params).length ? params : null;
}

function toDeviceParams(accountId: number, c: TgAppClient): TgDeviceParams {
  return {
    deviceModel: resolveDeviceModel(accountId, c),
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  };
}

/**
 * Resolve the Telegram device params for an account.
 * - Explicit appClientId: use that client.
 * - No client + random mode: use a per-account sticky random pick that is
 *   persisted, so the same device is reused for auth, jobs and the live client.
 *   Only re-rolls if the previously assigned client no longer exists.
 * - Otherwise: use the default client.
 */
export function resolveAppClientParams(
  accountId: number,
  appClientId: string | null | undefined,
): TgDeviceParams | undefined {
  try {
    // A session imported as a bought card carries the exact device it was logged in with.
    // Re-registering that auth key under any other fingerprint is a reliable way to get it
    // killed, so a pinned fingerprint wins over the account's client assignment and over the
    // random/default modes -- appClientId is ignored here on purpose.
    const pinned = readPinnedClient(accountId);
    if (pinned) return pinned;

    const list = readAppClients();
    if (!list.length) return undefined;

    if (appClientId) {
      const client = list.find((c) => c.id === appClientId);
      return client ? toDeviceParams(accountId, client) : undefined;
    }

    const modeRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_client_mode") as { value: string } | undefined;

    if (modeRow?.value === "random") {
      const assignedId = readAssignments()[String(accountId)];
      const assigned = assignedId
        ? list.find((c) => c.id === assignedId)
        : undefined;
      if (assigned) return toDeviceParams(accountId, assigned);
      // First random pick for this account -- persist it so it stays stable.
      const picked = list[Math.floor(Math.random() * list.length)];
      saveAssignment(accountId, picked.id);
      return toDeviceParams(accountId, picked);
    }

    const def = list.find((c) => c.isDefault);
    return def ? toDeviceParams(accountId, def) : undefined;
  } catch {
    return undefined;
  }
}
