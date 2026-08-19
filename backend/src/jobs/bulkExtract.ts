import { Api } from "telegram";
import {
  dataStoreOffReason,
  isDataStoreEnabled,
  isValidDataName,
  parseDataValue,
  writeDataValue,
} from "../db/dataStore";
import { getLiveClient } from "../tg/liveClient";
import { parsePeerTarget, resolvePeerTarget } from "../tg/peerTarget";
import { TERMINATED, type BulkTaskContext } from "./bulkTasks";

// Reads one chat's history on many accounts at once: the same @username, invite link or ID is
// resolved separately per account, since a private group only resolves for a member. What each
// account pulls out is either the message text or whatever an operator's regex captures from it,
// and the lines can be written into the data store as they are found.
//
// Full results do not live on the task object the panel polls every second or two -- a long
// history across a dozen accounts would make that list enormous. The task carries counts and a
// short preview; the lines themselves sit here under the task id and are fetched on demand.

/** Lines kept per task, across every account in it. Beyond this the run stops collecting. */
const MAX_LINES_PER_TASK = 50_000;

/** Extracted values echoed onto the task item, so the panel can show something without a fetch. */
const PREVIEW_PER_ACCOUNT = 5;

/** How often the item's progress line is refreshed while a long history is being read. */
const PROGRESS_EVERY = 200;

export const DEFAULT_MAX_MESSAGES = 1000;
export const MAX_MESSAGES_CEILING = 20_000;

export type ExtractStoreOptions = {
  /** Data store folder the lines are written into; created if it is not there yet. */
  folder: string;
  /** Record key per line. Must resolve to a name the store accepts. */
  keyFormat: string;
  /** Record value per line. JSON is stored as JSON; anything else as the text it is. */
  valueFormat: string;
};

export type ExtractMessagesOptions = {
  /** @username, t.me link, invite link or chat ID -- whatever names the chat. */
  target: string;
  /** Unix seconds; only messages at or after this are taken. 0 reads the whole history. */
  afterEpoch: number;
  /** Hard ceiling on messages read per account. */
  maxMessages: number;
  /** Handed to Telegram's own search, so the history is narrowed server-side. */
  search: string;
  /** Operator regex, `/pattern/flags` or bare. Empty takes the whole message text. */
  pattern: string;
  /** With a pattern set, whether a message that matches nothing still produces a line. */
  keepUnmatched: boolean;
  /** Line format for the collected output. */
  lineFormat: string;
  /** Where to write each line in the data store, or null to only collect them. */
  store: ExtractStoreOptions | null;
};

export type ExtractLine = {
  accountId: number;
  accountName: string;
  chat: string;
  messageId: number;
  /** ISO timestamp of the message. */
  date: string;
  sender: string;
  senderName: string;
  text: string;
  value: string;
  line: string;
};

export type ExtractAccountResult = {
  chat: string;
  scanned: number;
  matched: number;
  lines: number;
  stored: number;
  /** True when the per-task line cap or the message ceiling cut the read short. */
  truncated: boolean;
  preview: string[];
};

/** Placeholders every format string here understands, listed for the panel's hint text. */
export const EXTRACT_PLACEHOLDERS = [
  "value",
  "text",
  "account",
  "accountId",
  "chat",
  "id",
  "date",
  "sender",
  "senderName",
] as const;

type ExtractRun = { lines: ExtractLine[]; truncated: boolean };

const runs = new Map<string, ExtractRun>();

/**
 * Compiles the operator's pattern, `/pattern/flags` as well as a bare one, and adds the global
 * flag the scan needs. Mirrors autoreg's code regex so both fields take the same forms.
 */
export function compileExtractRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const delimited = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  const source = delimited ? delimited[1] : trimmed;
  const flags = delimited ? delimited[2] : "";
  return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
}

/**
 * Fills a format string. `{value}`, `{text}`, `{account}` and the rest name the fields below;
 * `{1}`..`{9}` are the regex capture groups. `\t` and `\n` are the characters they name, so a
 * tab-separated file can be asked for. An unknown name comes out empty rather than printed as
 * it stands -- a line of an export is no place to find `{valeu}`.
 */
export function formatExtractLine(
  format: string,
  fields: Record<string, string>,
  groups: string[] = [],
): string {
  const withEscapes = format
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
  return withEscapes.replace(/\{([^{}]*)\}/g, (_whole, name: string) => {
    const token = name.trim();
    if (/^\d+$/.test(token)) return groups[Number(token)] ?? "";
    return fields[token] ?? "";
  });
}

/** The name Telegram gives the resolved chat, for the `{chat}` placeholder. */
function entityTitle(entity: any, fallback: string): string {
  if (!entity || typeof entity !== "object") return fallback;
  if (typeof entity.title === "string" && entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  return name || entity.username || fallback;
}

/** Best effort: gramjs fills the sender from the entities that came back with the page. */
function senderName(msg: any): string {
  const sender = msg?._sender ?? msg?.sender;
  return sender ? entityTitle(sender, "") : "";
}

function senderId(msg: any): string {
  const peer = msg?.fromId;
  if (peer instanceof Api.PeerUser) return `u${peer.userId}`;
  if (peer instanceof Api.PeerChannel) return `c${peer.channelId}`;
  if (peer instanceof Api.PeerChat) return `g${peer.chatId}`;
  return msg?.senderId ? String(msg.senderId) : "";
}

/** Text of a message, caption included; service messages carry none and are skipped. */
function messageText(msg: any): string {
  return typeof msg?.message === "string" ? msg.message : "";
}

/** Every value the pattern pulls from one message: capture group 1 where there is one. */
function valuesFrom(text: string, re: RegExp): Array<{ value: string; groups: string[] }> {
  const scan = new RegExp(re.source, re.flags);
  scan.lastIndex = 0;
  const found: Array<{ value: string; groups: string[] }> = [];
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    const value = (m[1] ?? m[0]).trim();
    if (value) found.push({ value, groups: [...m].map((g) => g ?? "") });
    // A pattern that can match nothing would otherwise spin here for ever
    if (m[0] === "") scan.lastIndex += 1;
  }
  return found;
}

/**
 * Refuses a store target the data store would reject anyway, before a long read starts rather
 * than on the first line it writes.
 */
export function validateStoreOptions(store: ExtractStoreOptions): string | null {
  if (!isDataStoreEnabled()) return dataStoreOffReason();
  if (!isValidDataName(store.folder)) {
    return "The data folder name may not hold a brace or a bracket, or begin or end with a space";
  }
  if (!store.keyFormat.trim()) return "A record key format is required to store to data";
  return null;
}

/** Lines a finished (or running) task has collected, oldest first within each account. */
export function getExtractResults(taskId: string): ExtractRun | null {
  return runs.get(taskId) ?? null;
}

export function dropExtractResults(taskId: string): void {
  runs.delete(taskId);
}

/** Forgets runs whose task the bulk-task list has already pruned. */
export function pruneExtractResults(liveTaskIds: Set<string>): void {
  for (const id of runs.keys()) {
    if (!liveTaskIds.has(id)) runs.delete(id);
  }
}

/** The task's collection, made on the first item rather than pre-registered by the starter. */
function ensureExtractRun(taskId: string): ExtractRun {
  let run = runs.get(taskId);
  if (!run) {
    run = { lines: [], truncated: false };
    runs.set(taskId, run);
  }
  return run;
}

/** Test seam: forget every collected run. */
export function resetExtractResults(): void {
  runs.clear();
}

/**
 * Reads the chat on one account and collects its lines into the task's run.
 *
 * History is walked newest first and stopped as soon as it reaches past `afterEpoch`, which is
 * both how the date filter is applied and what keeps "everything since yesterday" from paging
 * through years of backlog. Lines are handed back oldest first, the order they read in.
 */
export async function extractMessagesForAccount(
  accountId: number,
  accountName: string,
  options: ExtractMessagesOptions,
  ctx: BulkTaskContext,
): Promise<ExtractAccountResult> {
  const run = ensureExtractRun(ctx.taskId);

  const entry = await getLiveClient(accountId);
  ctx.progress("Resolving the chat");
  const entity = await resolvePeerTarget(entry.client, options.target);
  const chat = entityTitle(entity, options.target);

  const re = options.pattern.trim() ? compileExtractRegex(options.pattern) : null;
  // One entry per message, so the whole lot can be flipped to chronological order at the end
  // without disturbing the order of several matches inside a single message.
  const perMessage: ExtractLine[][] = [];
  let lineCount = 0;
  let scanned = 0;
  let matched = 0;
  let stored = 0;
  let truncated = false;
  /** A store write that failed: raised only once the read's own lines are safely flushed. */
  let storeError: Error | null = null;

  ctx.progress(`Reading ${chat}`);
  for await (const msg of entry.client.iterMessages(entity, {
    limit: options.maxMessages,
    ...(options.search ? { search: options.search } : {}),
  })) {
    if (ctx.cancelled()) break;
    if (!msg) continue;
    // Newest first, so the first message older than the cut-off ends the read
    if (options.afterEpoch && msg.date < options.afterEpoch) break;
    scanned++;
    if (scanned % PROGRESS_EVERY === 0) {
      ctx.progress(`Read ${scanned} messages, ${matched} matched`);
    }

    const text = messageText(msg);
    const hits = re ? valuesFrom(text, re) : text ? [{ value: text, groups: [text] }] : [];
    if (hits.length) matched++;
    else if (!re || !options.keepUnmatched) continue;

    const fields = {
      text,
      account: accountName,
      accountId: String(accountId),
      chat,
      id: String(msg.id),
      date: new Date(msg.date * 1000).toISOString(),
      sender: senderId(msg),
      senderName: senderName(msg),
    };

    const lines: ExtractLine[] = [];
    for (const hit of hits.length ? hits : [{ value: "", groups: [] }]) {
      if (run.lines.length + lineCount >= MAX_LINES_PER_TASK) {
        truncated = true;
        break;
      }
      const full = { ...fields, value: hit.value };
      lineCount++;
      lines.push({
        accountId,
        accountName,
        chat,
        messageId: msg.id,
        date: full.date,
        sender: full.sender,
        senderName: full.senderName,
        text,
        value: hit.value,
        line: formatExtractLine(options.lineFormat, full, hit.groups),
      });
      if (options.store) {
        try {
          stored += writeStoreLine(options.store, full, hit.groups) ? 1 : 0;
        } catch (err: any) {
          storeError = err instanceof Error ? err : new Error(String(err));
          break;
        }
      }
    }
    if (lines.length) perMessage.push(lines);
    if (truncated || storeError) break;
  }

  // Newest first on the way in; the export reads better chronologically
  const collected = perMessage.reverse().flat();
  run.lines.push(...collected);
  if (truncated) run.truncated = true;

  // Both failures come after the flush above, so nothing already read is thrown away with them
  if (storeError) throw storeError;
  // Whatever was read before the terminate is kept, but the item is not a completed read
  if (ctx.cancelled()) throw new Error(TERMINATED);

  return {
    chat,
    scanned,
    matched,
    lines: collected.length,
    stored,
    truncated: truncated || scanned >= options.maxMessages,
    preview: collected.slice(0, PREVIEW_PER_ACCOUNT).map((l) => l.line),
  };
}

/** Writes one line into the store. A key the store will not take fails the whole item. */
function writeStoreLine(
  store: ExtractStoreOptions,
  fields: Record<string, string>,
  groups: string[],
): boolean {
  const key = formatExtractLine(store.keyFormat, fields, groups).trim();
  if (!key) return false;
  if (!isValidDataName(key)) {
    throw new Error(
      `Record key "${key}" is not one the data store accepts -- it may not hold a brace or a bracket and must be 1-128 characters`,
    );
  }
  writeDataValue(
    store.folder,
    key,
    "",
    parseDataValue(formatExtractLine(store.valueFormat, fields, groups)),
  );
  return true;
}

/** Rejects a target the peer parser cannot read, before any account is touched. */
export function invalidTargetReason(target: string): string | null {
  if (!target.trim()) return "A chat to read is required";
  return parsePeerTarget(target)
    ? null
    : `"${target.trim()}" does not name a chat -- use @username, a t.me link, or a chat ID`;
}
