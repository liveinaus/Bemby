/**
 * In-memory capture of everything the process prints, so the panel can show what
 * `docker logs` shows.
 *
 * Container logs are the only record of a system-level fault -- a proxy that will not
 * dial, a browser that will not launch, a migration that complained on boot -- and they
 * are exactly what an operator running Bemby from a compose file cannot reach without a
 * shell on the host. The buffer here is that record, read back over the API.
 *
 * Only console output is captured, which is all this codebase prints. A crash Node itself
 * reports (an uncaught exception, an OOM kill) never passes through console, so the last
 * word on those still belongs to `docker logs`.
 *
 * Installed by importing this module, and it must be imported before anything that logs
 * on the way in -- see the import order in server.ts.
 */
import { format } from "node:util";

export type SystemLogLevel = "debug" | "log" | "info" | "warn" | "error";

export type SystemLogEntry = {
  /** Monotonic per-process id; the cursor a poller passes back as `since`. */
  seq: number;
  at: string;
  level: SystemLogLevel;
  /** The leading `[tag]` most lines here carry, pulled out for filtering. */
  scope: string | null;
  text: string;
};

/** Ranked so a filter can ask for "warn and worse" rather than one exact level. */
const SEVERITY: Record<SystemLogLevel, number> = {
  debug: 0,
  log: 1,
  info: 1,
  warn: 2,
  error: 3,
};

const CAPACITY = clampInt(process.env.SYSTEM_LOG_LINES, 2000, 100, 20000);
/** A stack trace is worth keeping whole; a dumped payload is not worth 2MB of heap. */
const MAX_TEXT_CHARS = 8000;
const SCOPE_RE = /^\[([^\]\s]{1,40})\]/;

const buffer: SystemLogEntry[] = [];
let nextSeq = 1;
let dropped = 0;
const startedAt = new Date().toISOString();

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function record(level: SystemLogLevel, args: unknown[]): void {
  let text = format(...args);
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}… [${text.length - MAX_TEXT_CHARS} more chars]`;
  }
  buffer.push({
    seq: nextSeq++,
    at: new Date().toISOString(),
    level,
    scope: SCOPE_RE.exec(text)?.[1] ?? null,
    text,
  });
  if (buffer.length > CAPACITY) {
    dropped += buffer.length - CAPACITY;
    buffer.splice(0, buffer.length - CAPACITY);
  }
}

let installed = false;

export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const levels: SystemLogLevel[] = ["debug", "log", "info", "warn", "error"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // Never let the buffer break the thing it is recording
      try {
        record(level, args);
      } catch {
        /* ignore */
      }
      original(...args);
    };
  }
}

export type SystemLogQuery = {
  /** Return only entries newer than this seq. */
  since?: number;
  /** Minimum severity to include. */
  level?: SystemLogLevel;
  search?: string;
  limit?: number;
};

export type SystemLogPage = {
  entries: SystemLogEntry[];
  /** Cursor for the next poll, held even when the page came back empty. */
  nextSeq: number;
  /** Oldest seq still held; a `since` below it means the poller missed lines. */
  oldestSeq: number;
  /** Entries held before filtering. */
  buffered: number;
  capacity: number;
  /** Lines pushed out of the buffer since boot. */
  dropped: number;
  /** Boot time of this process, i.e. how far back the buffer can reach. */
  startedAt: string;
};

export function readSystemLog(query: SystemLogQuery = {}): SystemLogPage {
  const since = query.since ?? 0;
  const minSeverity = query.level ? SEVERITY[query.level] : -1;
  const needle = query.search?.toLowerCase() ?? "";
  const limit = query.limit ?? CAPACITY;

  const matched: SystemLogEntry[] = [];
  // Newest first while collecting, so a limit keeps the recent end rather than the stale one
  for (let i = buffer.length - 1; i >= 0 && matched.length < limit; i--) {
    const entry = buffer[i];
    if (entry.seq <= since) break;
    if (SEVERITY[entry.level] < minSeverity) continue;
    if (needle && !entry.text.toLowerCase().includes(needle)) continue;
    matched.push(entry);
  }
  matched.reverse();

  return {
    entries: matched,
    nextSeq: nextSeq - 1,
    oldestSeq: buffer.length ? buffer[0].seq : nextSeq,
    buffered: buffer.length,
    capacity: CAPACITY,
    dropped,
    startedAt,
  };
}

/** Drops what is held so a reproduction can be read on its own. The container log keeps it all. */
export function clearSystemLog(): number {
  const cleared = buffer.length;
  buffer.length = 0;
  return cleared;
}

installConsoleCapture();
