// Flood-wait cooldowns.
//
// Telegram rate-limits connection setup: the first request on any connection is
// `InvokeWithLayer{ initConnection{ ..., query: help.GetConfig } }`, and when that is refused
// GramJS raises `A wait of N seconds is required (caused by InvokeWithLayer)`. The limit is
// keyed on the exit IP and the account, not on the api_id, so giving each account its own app
// credentials does nothing for it.
//
// Two things used to make one refusal snowball. GramJS sends that request through the raw
// sender rather than `invoke`, so `floodSleepThreshold` never absorbs it; and the runner then
// retried the whole job a few seconds later, which connected again and pushed the wait higher.
// Recording the wait and refusing to reconnect until it has passed is what breaks that loop.
//
// Waits outlive the process (a tsx-watch restart must not forget a 415-second wait), so they
// live in the settings KV table alongside the other per-account bookkeeping.

import { db } from "../db/database";

const FLOOD_KEY = "tg_flood_waits";

/** Scope of a wait: the account it was raised for, and the exit it went out through. */
export type FloodScope = string;

export const accountScope = (accountId: number): FloodScope =>
  `account:${accountId}`;

/**
 * Accounts naming no proxy all leave through the same exit -- the global one, or the host's
 * own address when no global one is set -- so they share a single bucket.
 */
export const exitScope = (proxyId: string | null | undefined): FloodScope =>
  `exit:${proxyId ?? "direct"}`;

type FloodMap = Record<FloodScope, number>;

function readFloodMap(): FloodMap {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(FLOOD_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as FloodMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFloodMap(map: FloodMap): void {
  try {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ).run(FLOOD_KEY, JSON.stringify(map));
  } catch {
    /* a cooldown that cannot be stored must not fail the run that raised it */
  }
}

/**
 * The wait an error is asking for, in seconds, or null when it is not a flood wait.
 *
 * Reads `err.seconds` where the GramJS error class survived, and falls back to the message
 * because the job wrappers (CheckinError, CustomJobError, AutoregJobError) re-throw the text
 * and drop the class. SLOW_MODE_WAIT is worded the same way but is a per-chat posting limit
 * rather than a connection limit, so it is deliberately not treated as one.
 */
export function parseFloodWaitSeconds(err: unknown): number | null {
  const e = err as { seconds?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.includes("before sending another message in this chat")) {
    return null;
  }

  if (typeof e?.seconds === "number" && Number.isFinite(e.seconds)) {
    return Math.max(0, Math.floor(e.seconds));
  }

  const found = message.match(/A wait of (\d+) seconds is required/);
  return found ? Number(found[1]) : null;
}

/**
 * Records a wait against every scope it applies to. The longest standing wait wins, so a
 * fresh short wait never shortens one already in force.
 */
export function noteFloodWait(scopes: FloodScope[], seconds: number): void {
  if (!scopes.length || seconds <= 0) return;
  const now = Date.now();
  const until = now + seconds * 1000;
  const map = readFloodMap();

  // Expired entries are dropped on the way past, so the row cannot grow without bound
  for (const [scope, at] of Object.entries(map)) {
    if (at <= now) delete map[scope];
  }
  for (const scope of scopes) {
    map[scope] = Math.max(map[scope] ?? 0, until);
  }
  writeFloodMap(map);
}

/** Milliseconds left on the longest wait covering these scopes; 0 when they are all clear. */
export function floodWaitRemainingMs(scopes: FloodScope[]): number {
  if (!scopes.length) return 0;
  const map = readFloodMap();
  const now = Date.now();
  let until = 0;
  for (const scope of scopes) {
    until = Math.max(until, map[scope] ?? 0);
  }
  return Math.max(0, until - now);
}

/** Clears the waits for these scopes, for the "run now anyway" path in the UI. */
export function clearFloodWait(scopes: FloodScope[]): void {
  const map = readFloodMap();
  let changed = false;
  for (const scope of scopes) {
    if (scope in map) {
      delete map[scope];
      changed = true;
    }
  }
  if (changed) writeFloodMap(map);
}

/** Reason text for a run refused by a standing wait, so the log says what to wait for. */
export function floodWaitMessage(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(seconds / 60);
  const readable = mins > 0 ? `${mins}m ${seconds % 60}s` : `${seconds}s`;
  return (
    `Skipped: Telegram flood wait in force for another ${readable}. ` +
    "Connecting again before it passes only extends it."
  );
}
