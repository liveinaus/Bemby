import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import type { TgProxy, AutoregConfig, CustomStepLog } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";
import { expandCommand, parseMessages, callAI } from "./checkin";
import { escapeHtml } from "../tg/htmlEscape";
import { resolvePeerTarget } from "../tg/peerTarget";
import { connectWithTimeout, destroyQuietly } from "../tg/clientTimeout";
import { parseBotStartLink, webButtonOf, type BotStartLink } from "../tg/miniApp";

// Reuses the custom-job step log shape so LogsView renders the same timeline.
export type AutoregJobLog = {
  steps: CustomStepLog[];
};

export class AutoregJobError extends Error {
  constructor(
    message: string,
    public readonly log: AutoregJobLog,
  ) {
    super(message);
    this.name = "AutoregJobError";
  }
}

const DEFAULT_LISTEN_MINUTES = 30;
// Bots drop the code-entry state after a short window (often only a minute or two),
// so a previously armed prompt is refreshed before sending another code
const ARM_STALE_MS = 100_000;

// Characters a registration code may contain after the prefix. Telegram /start
// payloads only allow these, so anything else is a decoy, mask, or delimiter.
const CODE_CHAR = /[A-Za-z0-9_\-]/;
// Anti-bot decoy symbols some bots weave into posted codes with a "delete the
// symbol" instruction (e.g. ABC-30-Register_C~3vLEpVAYh, 删除符号“~”).
// Stripped from the extracted code. Deliberately excludes URL/sentence
// delimiters (& ? # / = . , ; : quotes, brackets) which end a code instead.
const DECOY_CHAR = /[!$%^*+~`@|\\]/;
// Mask characters bots use when announcing a used code (e.g. ABC-30-Register_85D░░░).
// Covers block elements, geometric shapes, misc symbols, dingbats, arrows, emoji,
// and common single-character masks (··· … ＊ × •)
const MASK_CHAR =
  /[▀-◿☀-➿⬀-⯿…⋯·•＊×]|[\u{1F000}-\u{1FAFF}]/u;
// Minimum characters after the prefix for a fresh code. Filters fragments of
// codes quoted in chat (e.g. someone pasting a truncated or masked code)
const MIN_CODE_SUFFIX = 4;

export type ExtractedCodes = {
  /** Complete, usable codes (prefix included) */
  codes: string[];
  /** Partial codes from used-code announcements; queued codes starting with one of these are burned */
  usedPartials: string[];
};

/** Builds a matcher for the code prefix; `*` matches any non-whitespace run,
 *  e.g. ABC-*-Register_ matches ABC-30-Register_ and ABC-7-Register_ */
function prefixToRegex(prefix: string): RegExp {
  const pattern = prefix
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\s]*?");
  return new RegExp(pattern, "g");
}

/** Compiles the operator's code regex, adding the global flag the scan needs. */
export function compileCodeRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  // `/pattern/flags` as well as a bare pattern, since either is natural to type
  const delimited = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  const source = delimited ? delimited[1] : trimmed;
  const flags = delimited ? delimited[2] : "";
  return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
}

/**
 * Pulls codes out of a message with the operator's own pattern, for groups that post codes
 * with no stable prefix to match on. Capture group 1 is the code where the pattern has one,
 * so the surrounding wording can be matched without ending up in the code.
 *
 * A mask character straight after the match means the post is announcing a code as used
 * rather than handing out a fresh one, the same as in prefix mode.
 */
function extractByRegex(text: string, re: RegExp): ExtractedCodes {
  const codes: string[] = [];
  const usedPartials: string[] = [];
  const scan = new RegExp(re.source, re.flags);
  scan.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    const token = (m[1] ?? m[0]).trim();
    const after = text.slice(m.index + m[0].length);
    const next = after ? String.fromCodePoint(after.codePointAt(0)!) : "";
    if (token) {
      if (next && MASK_CHAR.test(next)) usedPartials.push(token);
      else codes.push(token);
    }
    // Never stall on a zero-length match
    scan.lastIndex = Math.max(scan.lastIndex, m.index + Math.max(1, m[0].length));
  }
  return { codes, usedPartials };
}

/** Pulls registration codes out of a message. Decoy symbols inside the run are
 *  stripped, and a mask character marks a used-code announcement rather than a
 *  fresh code. Suffixes shorter than MIN_CODE_SUFFIX are quoted fragments, not
 *  codes, and are discarded. A regex, when given, replaces the prefix walk. */
export function extractCodes(
  text: string,
  prefix: string,
  codeRegex?: RegExp,
): ExtractedCodes {
  if (codeRegex) return extractByRegex(text, codeRegex);
  const codes: string[] = [];
  const usedPartials: string[] = [];
  const wanted = prefix?.trim();
  if (!wanted) return { codes, usedPartials };
  const re = prefixToRegex(wanted);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    let end = start + m[0].length;
    let token = m[0];
    let masked = false;
    // Walk the run one code point at a time; emoji masks are surrogate pairs
    while (end < text.length) {
      const ch = String.fromCodePoint(text.codePointAt(end)!);
      if (CODE_CHAR.test(ch)) {
        token += ch;
      } else if (MASK_CHAR.test(ch)) {
        masked = true;
        break;
      } else if (!DECOY_CHAR.test(ch)) {
        break; // whitespace or a delimiter ends the run
      }
      end += ch.length;
    }
    if (masked) {
      usedPartials.push(token);
    } else if (token.length >= m[0].length + MIN_CODE_SUFFIX) {
      codes.push(token);
    }
    // Skip past the whole code run and never stall on a zero-length match
    re.lastIndex = Math.max(end, re.lastIndex, start + 1);
  }
  return { codes, usedPartials };
}

/** Text to scan for codes: visible message text plus any URLs hidden in
 *  text-link entities or URL buttons (codes often arrive as ?start= deep links) */
function messageSearchText(msg: Api.Message): string {
  const parts = [msg.message ?? ""];
  for (const e of (msg.entities ?? []) as Array<{ url?: string }>) {
    if (e?.url) parts.push(e.url);
  }
  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  if (markup?.rows) {
    for (const row of markup.rows) {
      for (const b of row.buttons) {
        const url = (b as { url?: string }).url;
        if (url) parts.push(url);
      }
    }
  }
  return parts.join("\n");
}

/** Where a code was posted, which is what the AI reads for context. */
export type CodeSource = { msgId?: number; text?: string };

// Chinese characters and the punctuation that travels with them: ideographs and their
// extensions, CJK punctuation (（）、。), and full-width forms. Groups wrap or interleave
// codes with these, and the bot wants none of it.
const CHINESE_CHAR =
  /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2FA1F}]/gu;

/**
 * The fixed edits an operator can pick instead of paying for an AI call on every code:
 * drop Chinese characters, drop a named set of characters. Both are what the AI would be
 * asked to do most of the time, and they cost nothing.
 *
 * `stripChars` is read as a set of characters rather than a substring -- `~*` strips every
 * `~` and every `*` -- and whitespace in it is ignored, since a code never contains any.
 */
export function applyCodeEdits(
  code: string,
  edits: { stripChinese?: boolean; stripChars?: string },
): string {
  let out = code;
  if (edits.stripChinese) out = out.replace(CHINESE_CHAR, "");
  for (const ch of new Set((edits.stripChars ?? "").replace(/\s+/g, ""))) {
    out = out.split(ch).join("");
  }
  return out;
}

/** Group messages shown to the AI around the one carrying the code. */
const DEFAULT_AI_CONTEXT = 6;

export type CodeContext = {
  /** The message the code was pulled out of */
  message?: string;
  /** Nearby group messages, oldest first -- an instruction may come after the code */
  nearby: string[];
  /** The bot's own last prompt, which sometimes states how the code must be typed */
  botPrompt?: string;
};

/**
 * The prompt for adjusting a captured code. Groups hand codes out with a decoy symbol to
 * delete, a character to swap, or part of the code left in the wording around it, and the
 * rule is often stated in a nearby message rather than beside the code.
 */
export function buildCodeFixPrompt(
  code: string,
  context: CodeContext,
  hint?: string,
): string {
  const parts = [
    `A Telegram group hands out registration codes for a bot. Groups often obfuscate them: ` +
      `a decoy character to delete, a character to replace, a code split across lines, or ` +
      `part of it stated in the wording around it. The rule may be in the same message, in ` +
      `a message before or after it, or in the bot's own prompt.`,
    ``,
    `Code as captured: ${code}`,
  ];
  if (context.message) parts.push(``, `The message it came from:`, context.message);
  if (context.nearby.length)
    parts.push(``, `Other group messages, oldest first:`, context.nearby.join("\n---\n"));
  if (context.botPrompt) parts.push(``, `The bot's last prompt:`, context.botPrompt);
  if (hint) parts.push(``, `Operator note: ${hint}`);
  parts.push(
    ``,
    `Reply with ONLY the exact code to send to the bot -- no quotes, no label, no ` +
      `explanation. If nothing in the context calls for a change, reply with the code exactly ` +
      `as captured.`,
  );
  return parts.join("\n");
}

/**
 * Reads a code out of the AI's reply. Anything that does not look like a code -- empty, a
 * sentence, absurdly long -- means the model explained itself instead of answering, and the
 * captured code stands rather than sending prose to the bot.
 */
export function sanitizeAiCode(raw: string, fallback: string): string {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return fallback;
  const bare = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!bare || /\s/.test(bare) || bare.length > 128) return fallback;
  return bare;
}

/** The group messages around a code, for the AI to read the group's convention off. */
async function codeContext(
  client: TelegramClient,
  group: Api.TypeEntityLike,
  source: CodeSource | undefined,
  count: number,
  botPrompt?: string,
): Promise<CodeContext> {
  const context: CodeContext = { message: source?.text, nearby: [], botPrompt };
  if (count <= 0) return context;
  try {
    // Half the window sits after the code, since the instruction often follows it
    const half = Math.max(1, Math.ceil(count / 2));
    const msgs = (await client.getMessages(group, {
      limit: count,
      ...(source?.msgId ? { offsetId: source.msgId + half + 1 } : {}),
    })) as Api.Message[];
    context.nearby = [...msgs]
      .reverse()
      .map((m) => messageSearchText(m).trim())
      .filter(Boolean);
  } catch {
    /* history unavailable -- the code's own message is context enough to try with */
  }
  return context;
}

// FIFO of codes with a single async consumer. Live listener pushes, the register
// loop pulls; used-code announcements prune both queued and future codes.
class CodeQueue {
  private queue: string[] = [];
  private seen = new Set<string>();
  private sources = new Map<string, CodeSource>();
  private burnedPartials: string[] = [];
  private waiter: ((code: string | null) => void) | null = null;
  /** Debug trail: every unique code seen and what happened to it */
  readonly trail = new Map<string, "pending" | "tried" | "burned">();
  /** Used-code partials observed, for debug output */
  readonly partials: string[] = [];

  add(code: string, source?: CodeSource): boolean {
    if (this.seen.has(code)) return false;
    this.seen.add(code);
    if (source) this.sources.set(code, source);
    if (this.burnedPartials.some((p) => code.startsWith(p))) {
      this.trail.set(code, "burned");
      return false;
    }
    if (this.waiter) {
      this.trail.set(code, "tried");
      const w = this.waiter;
      this.waiter = null;
      w(code);
    } else {
      this.trail.set(code, "pending");
      this.queue.push(code);
    }
    return true;
  }

  sourceOf(code: string): CodeSource | undefined {
    return this.sources.get(code);
  }

  /** Puts a code back at the front (e.g. bot never replied and we re-arm) */
  requeueFront(code: string): void {
    this.trail.set(code, "pending");
    this.queue.unshift(code);
  }

  markUsed(partial: string): number {
    this.burnedPartials.push(partial);
    this.partials.push(partial);
    const before = this.queue.length;
    this.queue = this.queue.filter((c) => {
      if (!c.startsWith(partial)) return true;
      this.trail.set(c, "burned");
      return false;
    });
    return before - this.queue.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  stats(): { seen: number; pending: number; burned: number; tried: number } {
    let pending = 0;
    let burned = 0;
    let tried = 0;
    for (const s of this.trail.values()) {
      if (s === "pending") pending++;
      else if (s === "burned") burned++;
      else tried++;
    }
    return { seen: this.trail.size, pending, burned, tried };
  }

  /** Next code, waiting up to maxMs for one to arrive. Resolves null on timeout/abort. */
  next(maxMs: number, signal?: AbortSignal): Promise<string | null> {
    if (this.queue.length > 0) {
      const code = this.queue.shift() ?? null;
      if (code) this.trail.set(code, "tried");
      return Promise.resolve(code);
    }
    return new Promise((resolve) => {
      if (signal?.aborted || maxMs <= 0) {
        resolve(null);
        return;
      }
      const finish = (code: string | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
        resolve(code);
      };
      const timer = setTimeout(() => finish(null), maxMs);
      const onAbort = () => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = finish;
    });
  }
}

type ReplyVerdict = {
  verdict: "success" | "fail" | "timeout";
  messages: Api.Message[];
};

/** True when the text contains any of the |-separated keywords */
export function containsAny(text: string, keywords?: string): boolean {
  if (!keywords) return false;
  return keywords
    .split("|")
    .map((k) => k.trim())
    .filter(Boolean)
    .some((k) => text.includes(k));
}

// Collects bot messages until success/fail text is matched or the timeout fires.
// With no successContains, the first non-fail message counts as success.
// Listens for both new messages and edits: some bots respond by editing
// their previous message rather than replying.
function waitForVerdict(
  client: TelegramClient,
  botUsername: string,
  botPeerId: string,
  maxMs: number,
  successContains?: string,
  failContains?: string,
  signal?: AbortSignal,
): Promise<ReplyVerdict> {
  return new Promise((resolve) => {
    const collected: Api.Message[] = [];
    const finish = (verdict: ReplyVerdict["verdict"]) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(handler, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve({ verdict, messages: collected });
    };
    const timer = setTimeout(
      () => finish(collected.length ? "fail" : "timeout"),
      maxMs,
    );
    const onAbort = () => finish("timeout");
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      const text = msg.message ?? "";
      if (containsAny(text, failContains)) {
        finish("fail");
        return;
      }
      if (successContains) {
        if (containsAny(text, successContains)) finish("success");
        return;
      }
      finish("success");
    };
    // Scoped to the direct chat so group posts by the same bot are ignored.
    // Pre-resolved numeric IDs only: gramjs stringifies chats/fromUsers and
    // resolves them during update dispatch, where a failed lookup crashes.
    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      handler,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
  });
}

export type TextWait = {
  /** Resolves true once the wording appeared, false once the wait ran out */
  result: Promise<boolean>;
  cancel: () => void;
};

/**
 * Waits for the bot to say it is ready -- "对我发送注册码" and the like. Arm it BEFORE the
 * action that prompts the bot, or the message can land before anyone is listening.
 *
 * Edits count: a bot that keeps one message and rewrites it is announcing readiness the same
 * way as one that sends a new line.
 */
export function beginTextWait(
  client: TelegramClient,
  botPeerId: string,
  keywords: string,
  maxMs: number,
  signal?: AbortSignal,
  seed: Api.Message[] = [],
): TextWait {
  let settle: ((found: boolean) => void) | null = null;
  const result = new Promise<boolean>((resolve) => {
    const finish = (found: boolean) => {
      if (!settle) return;
      settle = null;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(handler, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };
    settle = finish;
    const timer = setTimeout(() => finish(false), maxMs);
    const onAbort = () => finish(false);
    const handler = async (event: NewMessageEvent) => {
      if (containsAny((event.message as Api.Message).message ?? "", keywords)) finish(true);
    };
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      handler,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    // Messages already in hand may carry it, in which case there is nothing to wait for
    if (seed.some((m) => containsAny(m.message ?? "", keywords))) finish(true);
  });
  return { result, cancel: () => settle?.(false) };
}

function hasInlineButtons(msg: Api.Message): boolean {
  return (msg as any).replyMarkup instanceof Api.ReplyInlineMarkup;
}

// Fallback poll cadence while waiting for the button prompt
const BUTTON_POLL_MS = 3_000;

export type ButtonWaitResult = {
  message: Api.Message;
  /** How the prompt arrived: a fresh reply, an edit of an existing message,
   *  or an unchanged existing message (bot ignored the repeated /start) */
  via: "reply" | "edit" | "existing";
};

/** Arms a wait for the bot to present inline buttons. Handles bots that reply
 *  with a new message AND bots that edit an existing one. Must be called
 *  BEFORE sending the trigger command so the chat baseline predates the reply.
 *  A polling fallback covers missed updates, and on timeout an unchanged
 *  existing prompt is accepted as a last resort. */
async function beginButtonWait(
  client: TelegramClient,
  botUsername: string,
  botPeerId: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<{ result: Promise<ButtonWaitResult | null> }> {
  // Snapshot recent messages so edits and new arrivals can be told apart
  // from what was already in the chat
  const baseline = new Map<number, number>();
  try {
    const recent = (await client.getMessages(botUsername, {
      limit: 10,
    })) as Api.Message[];
    for (const m of recent) baseline.set(m.id, m.editDate ?? 0);
  } catch {
    /* chat may not exist yet; everything counts as new */
  }

  const result = new Promise<ButtonWaitResult | null>((resolve) => {
    let done = false;
    let poll: NodeJS.Timeout | null = null;
    const finish = (found: ButtonWaitResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      client.removeEventHandler(onNew, new NewMessage({}));
      client.removeEventHandler(onEdit, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };
    const onTimeout = async () => {
      // Last resort: the bot may have ignored a repeated /start because its
      // prompt (with buttons) is already the latest state of the chat
      try {
        const recent = (await client.getMessages(botUsername, {
          limit: 5,
        })) as Api.Message[];
        const existing = recent.find(hasInlineButtons);
        if (existing) {
          finish({ message: existing, via: "existing" });
          return;
        }
      } catch {
        /* fall through to null */
      }
      finish(null);
    };
    const timer = setTimeout(onTimeout, maxMs);
    const onAbort = () => finish(null);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const onNew = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if (hasInlineButtons(msg)) finish({ message: msg, via: "reply" });
    };
    const onEdit = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if (hasInlineButtons(msg)) finish({ message: msg, via: "edit" });
    };
    // Scoped to the direct chat (pre-resolved ID; see waitForVerdict note)
    client.addEventHandler(
      onNew,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      onEdit,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    // Poll as a safety net in case an update never reaches the event loop
    let polling = false;
    poll = setInterval(async () => {
      if (polling || done) return;
      polling = true;
      try {
        const recent = (await client.getMessages(botUsername, {
          limit: 5,
        })) as Api.Message[];
        for (const m of recent) {
          if (!hasInlineButtons(m)) continue;
          const seenEdit = baseline.get(m.id);
          if (seenEdit === undefined) {
            finish({ message: m, via: "reply" });
            return;
          }
          if ((m.editDate ?? 0) > seenEdit) {
            finish({ message: m, via: "edit" });
            return;
          }
        }
      } catch {
        /* transient; next tick retries */
      } finally {
        polling = false;
      }
    }, BUTTON_POLL_MS);
  });
  return { result };
}

/**
 * What a bot offers after vetting a code: a callback button, a `?start=` deep link (as a URL
 * button or a link in the text), or a plain web link, which needs a browser and so cannot be
 * followed from here.
 */
export type AfterCodeTarget =
  | { kind: "callback"; text: string; button: Api.KeyboardButtonCallback; msg: Api.Message }
  | { kind: "startLink"; text: string; botUsername: string; startParam: string; msg: Api.Message }
  | { kind: "url"; text: string; url: string; msg: Api.Message };

/** `?start=` deep links in the message body, both plain URLs and text links. */
function startLinksInText(msg: Api.Message): Array<{ text: string; link: BotStartLink }> {
  const found: Array<{ text: string; link: BotStartLink }> = [];
  const body = msg.message ?? "";
  for (const e of (msg.entities ?? []) as Array<{
    offset?: number;
    length?: number;
    url?: string;
  }>) {
    // A text link carries its target on the entity; a bare URL is the slice it covers
    const href =
      e?.url ??
      (typeof e?.offset === "number" && typeof e?.length === "number"
        ? body.slice(e.offset, e.offset + e.length)
        : "");
    const link = href ? parseBotStartLink(href) : null;
    if (!link) continue;
    const label =
      typeof e?.offset === "number" && typeof e?.length === "number"
        ? body.slice(e.offset, e.offset + e.length)
        : href;
    found.push({ text: label, link });
  }
  return found;
}

/**
 * The thing to click on one message, preferring a callback button over a link. `match` is a
 * partial text match against the button/link label; blank takes the first of each kind.
 */
export function findAfterCodeTarget(
  msg: Api.Message,
  match: string,
): AfterCodeTarget | null {
  const wanted = match.trim();
  const hits = (text: string) => !wanted || text.includes(wanted);

  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  const buttons = markup?.rows?.flatMap((r) => r.buttons) ?? [];

  for (const b of buttons) {
    if (b instanceof Api.KeyboardButtonCallback && hits(b.text ?? "")) {
      return { kind: "callback", text: b.text ?? "", button: b, msg };
    }
  }
  for (const b of buttons) {
    const web = webButtonOf(b);
    if (!web || !hits(web.text)) continue;
    if (web.startLink) {
      return {
        kind: "startLink",
        text: web.text,
        botUsername: web.startLink.botUsername,
        startParam: web.startLink.startParam,
        msg,
      };
    }
    return { kind: "url", text: web.text, url: web.url, msg };
  }
  for (const { text, link } of startLinksInText(msg)) {
    if (!hits(text)) continue;
    return {
      kind: "startLink",
      text,
      botUsername: link.botUsername,
      startParam: link.startParam,
      msg,
    };
  }
  return null;
}

export type AfterCodeWait = {
  result: Promise<AfterCodeTarget | null>;
  cancel: () => void;
};

/**
 * Waits for the bot to offer the post-code button. Armed BEFORE the code is sent, since the
 * offer often rides in the very reply that accepts it. Edits count: a bot that rewrites its
 * own message to add the button is making the same offer as one that sends a new one.
 */
export function beginAfterCodeWait(
  client: TelegramClient,
  botPeerId: string,
  match: string,
  maxMs: number,
  signal?: AbortSignal,
  seed: Api.Message[] = [],
): AfterCodeWait {
  let settle: ((found: AfterCodeTarget | null) => void) | null = null;
  const result = new Promise<AfterCodeTarget | null>((resolve) => {
    const finish = (found: AfterCodeTarget | null) => {
      if (!settle) return;
      settle = null;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(handler, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };
    settle = finish;
    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    const handler = async (event: NewMessageEvent) => {
      const target = findAfterCodeTarget(event.message as Api.Message, match);
      if (target) finish(target);
    };
    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      handler,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    for (const m of seed) {
      const target = findAfterCodeTarget(m, match);
      if (target) {
        finish(target);
        return;
      }
    }
  });
  return { result, cancel: () => settle?.(null) };
}

/**
 * Performs the post-code click, recording on the step what it did. A callback button is
 * pressed; a `?start=` link is followed the way a real client does, by sending its payload
 * as a command. A plain web link needs a browser, so it throws rather than pretend.
 */
async function clickAfterCodeTarget(
  client: TelegramClient,
  target: AfterCodeTarget,
  step: CustomStepLog,
  botUsername: string,
): Promise<void> {
  if (target.kind === "callback") {
    const peer = await client.getInputEntity(botUsername);
    try {
      const answer = (await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer,
          msgId: target.msg.id,
          data: target.button.data,
        }),
      )) as Api.messages.BotCallbackAnswer;
      if (answer.message) step.callbackAnswer = answer.message;
    } catch (err: any) {
      // The click landed even when the bot never answered the callback
      if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) throw err;
    }
    step.result = `Clicked "${target.text}"`;
    return;
  }
  if (target.kind === "startLink") {
    await client.sendMessage(target.botUsername, {
      message: `/start ${target.startParam}`,
    });
    step.result = `Followed link "${target.text}": /start ${target.startParam} to @${target.botUsername}`;
    return;
  }
  throw new Error(
    `"${target.text}" opens a web page (${target.url}), which cannot be clicked from here -- registration that finishes on a website needs a custom job's "Open URL" action`,
  );
}

function findButton(
  msg: Api.Message,
  match: string,
): Api.KeyboardButtonCallback | null {
  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  if (!markup) return null;
  const flat = markup.rows.flatMap((r) => r.buttons);
  const clickable = flat.filter(
    (b): b is Api.KeyboardButtonCallback =>
      b instanceof Api.KeyboardButtonCallback,
  );
  const wanted = match.trim();
  if (wanted) {
    return clickable.find((b) => (b.text ?? "").includes(wanted)) ?? null;
  }
  // No text configured: the sole button, otherwise the first clickable one
  return clickable[0] ?? null;
}

export async function runAutoreg(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  startCommand: string,
  config: AutoregConfig,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  replyTimeoutMs = 40_000,
): Promise<AutoregJobLog> {
  const log: AutoregJobLog = { steps: [] };
  let stepNum = 0;

  const beginStep = (actionType: string, label: string): CustomStepLog => {
    const step: CustomStepLog = { step: ++stepNum, actionType, label };
    log.steps.push(step);
    return step;
  };

  const groupId = config.groupId?.trim();
  const codePrefix = config.codePrefix?.trim();
  const signupUsername = config.signupUsername?.trim();
  if (!groupId) throw new AutoregJobError("Group is required", log);
  if (!codePrefix && !config.codeRegex?.trim())
    throw new AutoregJobError("A code prefix or a code regex is required", log);
  if (!signupUsername)
    throw new AutoregJobError("Signup username is required", log);

  // Compiled once: a bad pattern must fail the job now, not on every message scanned
  let codeRegex: RegExp | undefined;
  if (config.codeRegex?.trim()) {
    try {
      codeRegex = compileCodeRegex(config.codeRegex);
    } catch (err: any) {
      throw new AutoregJobError(
        `Code regex is not valid: ${err?.message ?? String(err)}`,
        log,
      );
    }
  }

  const hasFixedEdits = Boolean(
    config.stripChinese || config.stripChars?.replace(/\s+/g, ""),
  );
  const codeReady = config.codeReadyContains?.trim();
  const usernameReady = config.usernameReadyContains?.trim();
  const clickAfterCode = config.clickAfterCode === true;
  const afterCodeButton = config.afterCodeButton?.trim() ?? "";
  const afterCodeRequired = config.afterCodeRequired === true;
  const listenMs =
    Math.max(1, config.listenMinutes ?? DEFAULT_LISTEN_MINUTES) * 60_000;
  const entryMode = config.entryMode === "command" ? "command" : "button";

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("Job cancelled");
  };

  try {
    // Bounded: an unreachable proxy otherwise leaves this pending with nothing to cancel it,
    // which stalls the account and everything queued behind it.
    await connectWithTimeout(client, "autoreg");
    checkCancelled();

    // 1. Resolve the group and make sure we are a member
    {
      const step = beginStep("join_group", `Join group: ${groupId}`);
      const t0 = Date.now();
      try {
        const inviteMatch = groupId.match(
          /(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/,
        );
        if (inviteMatch) {
          try {
            await client.invoke(
              new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }),
            );
            step.result = "Joined via invite link";
          } catch (err: any) {
            if (err?.message?.includes("ALREADY_PARTICIPANT")) {
              step.result = "Already a member";
            } else {
              throw err;
            }
          }
        } else {
          const entity = await resolvePeerTarget(client, groupId);
          if (entity instanceof Api.Chat) {
            // A basic group is reachable only from the chat list, so resolving it at all
            // means the account is in it
            step.result = "Already a member";
          } else {
            try {
              await client.invoke(
                new Api.channels.JoinChannel({ channel: entity as any }),
              );
              step.result = "Joined";
            } catch (err: any) {
              if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                step.result = "Already a member";
              } else {
                throw err;
              }
            }
          }
        }
      } finally {
        step.durationMs = Date.now() - t0;
      }
    }

    const groupEntity = await resolvePeerTarget(client, groupId);
    // Event filters need pre-resolved numeric IDs: gramjs stringifies whatever
    // is passed (an entity object becomes "[object Object]") and resolves it
    // during update dispatch, where a failed lookup crashes the update loop
    const groupPeerId = String(await client.getPeerId(groupEntity));
    const botPeerId = String(await client.getPeerId(botUsername));

    // 2. Start listening for codes immediately, before anything slower
    const queue = new CodeQueue();
    const listenStep = beginStep(
      "wait_reply",
      `Listen for codes with prefix "${codePrefix}"`,
    );
    const listenStart = Date.now();
    const queueSummary = () => {
      const s = queue.stats();
      return `${s.seen} code(s) seen · ${s.pending} pending · ${s.burned} burned as used · ${s.tried} tried`;
    };
    const onGroupMessage = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      const text = messageSearchText(msg);
      const { codes, usedPartials } = extractCodes(text, codePrefix, codeRegex);
      for (const p of usedPartials) queue.markUsed(p);
      for (const c of codes) queue.add(c, { msgId: msg.id, text });
      listenStep.result = queueSummary();
    };
    client.addEventHandler(
      onGroupMessage,
      new NewMessage({ chats: [groupPeerId] }),
    );

    try {
      // 3. Optionally seed the queue from recent group history (oldest first so
      // later used-code announcements prune correctly)
      const scanCount = config.scanHistoryCount ?? 0;
      if (scanCount > 0) {
        const scanStep = beginStep(
          "wait_reply",
          `Scan last ${scanCount} group message(s) for codes`,
        );
        const s0 = Date.now();
        const recent = (await client.getMessages(groupEntity, {
          limit: scanCount,
        })) as Api.Message[];
        for (const m of [...recent].reverse()) {
          const text = messageSearchText(m);
          const { codes, usedPartials } = extractCodes(text, codePrefix, codeRegex);
          for (const c of codes) queue.add(c, { msgId: m.id, text });
          for (const p of usedPartials) queue.markUsed(p);
        }
        scanStep.durationMs = Date.now() - s0;
        scanStep.result = `${recent.length} message(s) scanned · ${queueSummary()}`;
        // Debug: full list of extracted codes and used-code partials
        const lines = [...queue.trail.entries()].map(
          ([code, status]) => `${status === "pending" ? "✔" : "✘"} ${code}  [${status}]`,
        );
        if (queue.partials.length) {
          lines.push(
            "",
            `Used-code announcements seen (${queue.partials.length}), queued codes matching these are burned:`,
            ...queue.partials.map((p) => `  ${p}…`),
          );
        }
        if (lines.length) {
          // Codes derive from bot messages -- escape before rendering via v-html
          scanStep.responseHtml = `<pre style="white-space:pre-wrap">${escapeHtml(lines.join("\n"))}</pre>`;
        }
        listenStep.result = queueSummary();
      }

      // Arms the bot conversation for button mode: start command, then the
      // register button, leaving the bot waiting for a code.
      let armed = false;
      let armedAt = 0;
      // The bot's own prompt, which may state how a code has to be typed
      let lastBotPrompt = "";
      let readyReached = false;
      const arm = async (refresh = false) => {
        checkCancelled();
        armed = false;
        const sendStep = beginStep(
          "send_command",
          `${refresh ? "Refresh prompt, send" : "Send"}: "${startCommand}"`,
        );
        let t0 = Date.now();
        // Armed before /start so the baseline predates the bot's reply/edit
        const buttonWait = await beginButtonWait(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          signal,
        );
        await client.sendMessage(botUsername, { message: startCommand });
        sendStep.result = "Sent";
        sendStep.durationMs = Date.now() - t0;

        const clickStep = beginStep(
          "click_button",
          `Click register button${config.registerButton ? ` "${config.registerButton}"` : ""}`,
        );
        t0 = Date.now();
        try {
          const found = await buttonWait.result;
          checkCancelled();
          if (!found)
            throw new Error(
              `No new, edited, or existing message with buttons found within ${replyTimeoutMs}ms`,
            );
          const buttonsMsg = found.message;
          lastBotPrompt = buttonsMsg.message || lastBotPrompt;
          const parsed = await parseMessages([buttonsMsg], client, signal);
          if (parsed.html) clickStep.preClickHtml = parsed.html;
          if (parsed.buttons.length) clickStep.preClickButtons = parsed.buttons;
          const target = findButton(buttonsMsg, config.registerButton ?? "");
          if (!target)
            throw new Error(
              `Register button ${config.registerButton ? `"${config.registerButton}" ` : ""}not found`,
            );
          const peer = await client.getInputEntity(botUsername);
          // Armed before the click: the bot's "send me the code" often lands at once
          const readyWait = codeReady
            ? beginTextWait(client, botPeerId, codeReady, replyTimeoutMs, signal, [buttonsMsg])
            : null;
          try {
            const answer = (await client.invoke(
              new Api.messages.GetBotCallbackAnswer({
                peer,
                msgId: buttonsMsg.id,
                data: target.data,
              }),
            )) as Api.messages.BotCallbackAnswer;
            if (answer.message) clickStep.callbackAnswer = answer.message;
          } catch (err: any) {
            // Click was delivered even if the bot never answered the callback
            if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
              readyWait?.cancel();
              throw err;
            }
          }
          // The bot has to be waiting for a code before one is worth spending. Sent too
          // early it is simply ignored, and the code is gone.
          if (readyWait) {
            readyReached = await readyWait.result;
            checkCancelled();
          }
          clickStep.clickedButton = target.text;
          const viaNote =
            found.via === "edit"
              ? " (bot edited its message)"
              : found.via === "existing"
                ? " (existing prompt)"
                : "";
          const readyNote = !codeReady
            ? ""
            : readyReached
              ? ` · bot ready ("${codeReady}")`
              : ` · bot never said "${codeReady}" within ${replyTimeoutMs}ms, sending anyway`;
          clickStep.result = `Clicked "${target.text}"${viaNote}${readyNote}`;
          armed = true;
          armedAt = Date.now();
        } finally {
          clickStep.durationMs = Date.now() - t0;
        }
      };

      // 4. Race: try each code as soon as it is available
      const deadline = listenStart + listenMs;
      const retriedCodes = new Set<string>();

      while (true) {
        checkCancelled();

        const remaining = deadline - Date.now();
        const code = remaining > 0 ? await queue.next(remaining, signal) : null;
        checkCancelled();
        if (!code) {
          listenStep.durationMs = Date.now() - listenStart;
          const s = queue.stats();
          throw new Error(
            s.seen === 0
              ? `No registration codes appeared within ${Math.round(listenMs / 60_000)} minute(s)`
              : `All ${s.seen} captured code(s) were exhausted (${s.burned} burned by used-code announcements, ${s.tried} tried and rejected)`,
          );
        }

        // Button mode arms the prompt only once a code is in hand; a prompt
        // left over from a previous attempt is refreshed once stale
        if (
          entryMode === "button" &&
          (!armed || Date.now() - armedAt > ARM_STALE_MS)
        ) {
          await arm(armed);
        }

        // A posted code is not always the code to send: the group may have said to drop a
        // character, swap one, or read part of it out of the wording around it
        let toSend = code;
        if (hasFixedEdits) {
          const editStep = beginStep("edit_code", `Clean up code: "${code}"`);
          toSend = applyCodeEdits(code, config);
          editStep.result =
            toSend === code ? "Nothing to strip" : `Stripped to "${toSend}"`;
        }
        if (config.aiModifyCode) {
          const aiStep = beginStep("ai_modify_code", `AI check code: "${toSend}"`);
          const a0 = Date.now();
          try {
            const context = await codeContext(
              client,
              groupEntity,
              queue.sourceOf(code),
              config.aiContextCount ?? DEFAULT_AI_CONTEXT,
              lastBotPrompt || undefined,
            );
            const prompt = buildCodeFixPrompt(toSend, context, config.aiModifyCodeHint);
            aiStep.aiPrompt = prompt;
            const { response } = await callAI([], prompt, 200);
            aiStep.aiResponse = response;
            aiStep.aiDurationMs = Date.now() - a0;
            const before = toSend;
            toSend = sanitizeAiCode(response, before);
            aiStep.result =
              toSend === before ? "Unchanged" : `Adjusted to "${toSend}"`;
          } catch (err: any) {
            // A model that is down must not sink the run; the captured code still stands
            aiStep.error = `AI unavailable, sending the code as captured: ${err?.message ?? String(err)}`;
          } finally {
            aiStep.durationMs = Date.now() - a0;
          }
          checkCancelled();
        }

        // Command mode skips the button entirely: the code rides along with
        // the start command, e.g. /start ABC-30-Register_XYZ
        const payload =
          entryMode === "command" ? `${startCommand} ${toSend}` : toSend;
        const codeStep = beginStep("send_command", `Send code: "${payload}"`);
        const t0 = Date.now();
        const verdictPromise = waitForVerdict(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          config.successContains,
          config.failContains,
          signal,
        );
        // Armed before the code goes out: the bot's "now send the username" can arrive in
        // the very reply that accepts the code. With a click in between, the prompt comes
        // after it instead, so the wait is armed there -- on this side of the click its
        // timeout would be spent waiting for the click to happen.
        const usernameWait =
          usernameReady && !clickAfterCode
            ? beginTextWait(client, botPeerId, usernameReady, replyTimeoutMs, signal)
            : null;
        // Same reasoning: the button that opens registration often rides in the reply that
        // accepts the code, so the wait for it predates the send
        const afterCodeWait = clickAfterCode
          ? beginAfterCodeWait(
              client,
              botPeerId,
              afterCodeButton,
              replyTimeoutMs,
              signal,
            )
          : null;
        await client.sendMessage(botUsername, { message: payload });
        const { verdict, messages } = await verdictPromise;
        codeStep.durationMs = Date.now() - t0;
        if (messages.length) {
          const parsed = await parseMessages(messages, client, signal);
          codeStep.responseHtml = parsed.html || undefined;
          codeStep.responseImage = parsed.images[0];
        }

        if (verdict === "timeout") {
          // Bot went quiet: re-arm and give this code one more go
          usernameWait?.cancel();
          afterCodeWait?.cancel();
          codeStep.error = `No reply within ${replyTimeoutMs}ms`;
          armed = false;
          if (!retriedCodes.has(code)) {
            retriedCodes.add(code);
            queue.requeueFront(code);
          }
          continue;
        }
        if (verdict === "fail") {
          usernameWait?.cancel();
          afterCodeWait?.cancel();
          codeStep.error = "Code rejected (likely already used)";
          // The bot re-prompts after a bad code, so stay armed and fire the next one
          armedAt = Date.now();
          continue;
        }
        codeStep.result = "Code accepted";

        // 4b. Bots that vet the code first only open registration once the button on that
        // reply is clicked (or its t.me link followed). Messages seen so far are seeded in,
        // since the offer usually rides in the reply that just accepted the code.
        if (afterCodeWait) {
          const clickStep = beginStep(
            "click_button",
            `Click after code accepted${afterCodeButton ? ` "${afterCodeButton}"` : ""}`,
          );
          const c0 = Date.now();
          // Set once a wait for the username prompt has run, so the paths that skip the
          // click do not skip that wait with it
          let readyNoted = false;
          // The wait carries the timeout; what the verdict already collected is the
          // fallback, for an offer that arrived as an edit the wait's handler missed
          let target = await afterCodeWait.result;
          checkCancelled();
          if (!target) {
            target =
              messages
                .map((m) => findAfterCodeTarget(m, afterCodeButton))
                .find((t): t is AfterCodeTarget => t !== null) ?? null;
          }

          if (!target) {
            const missing = `No ${afterCodeButton ? `"${afterCodeButton}" ` : ""}button or link on the bot's reply within ${replyTimeoutMs}ms`;
            clickStep.durationMs = Date.now() - c0;
            if (afterCodeRequired) {
              clickStep.error = missing;
              // The bot is mid-flow and will not take a username, so this code is spent
              armed = false;
              continue;
            }
            clickStep.result = `${missing} -- optional, carrying on`;
          } else {
            const parsed = await parseMessages([target.msg], client, signal);
            if (parsed.html) clickStep.preClickHtml = parsed.html;
            if (parsed.buttons.length) clickStep.preClickButtons = parsed.buttons;
            // Both armed before the click: its answer, and the "now send the username"
            // prompt that often rides in that answer
            const clickReply = waitForVerdict(
              client,
              botUsername,
              botPeerId,
              replyTimeoutMs,
              undefined,
              config.failContains,
              signal,
            );
            const readyWait = usernameReady
              ? beginTextWait(client, botPeerId, usernameReady, replyTimeoutMs, signal)
              : null;
            let clickFailed: string | null = null;
            try {
              await clickAfterCodeTarget(client, target, clickStep, botUsername);
              clickStep.clickedButton = target.text;
            } catch (err: any) {
              if (err?.message === "Job cancelled") throw err;
              clickFailed = err?.message ?? String(err);
            }

            if (clickFailed) {
              readyWait?.cancel();
              // A click that would not go through spends the code either way; whether that
              // ends this attempt is the operator's call
              clickStep.error = clickFailed;
              clickStep.durationMs = Date.now() - c0;
              if (afterCodeRequired) {
                armed = false;
                continue;
              }
            } else {
              const clicked = await clickReply;
              checkCancelled();
              clickStep.durationMs = Date.now() - c0;
              if (clicked.messages.length) {
                const after = await parseMessages(clicked.messages, client, signal);
                clickStep.responseHtml = after.html || undefined;
                clickStep.responseImage = after.images[0];
              }
              // A bot that only vets the code on the click says so here, not earlier
              if (clicked.verdict === "fail") {
                readyWait?.cancel();
                clickStep.error = "Rejected after the click (likely already used)";
                armedAt = Date.now();
                continue;
              }
              if (readyWait) {
                const reached = await readyWait.result;
                checkCancelled();
                readyNoted = true;
                clickStep.result += reached
                  ? ` · bot ready for the username ("${usernameReady}")`
                  : ` · bot never said "${usernameReady}" within ${replyTimeoutMs}ms, sending anyway`;
              }
            }
          }

          // Carrying on past a click that did not happen still means waiting for the
          // username prompt; the reply that accepted the code may already carry it
          if (usernameReady && !readyNoted) {
            const reached = await beginTextWait(
              client,
              botPeerId,
              usernameReady,
              replyTimeoutMs,
              signal,
              messages,
            ).result;
            checkCancelled();
            clickStep.result = `${clickStep.result ?? ""}${
              reached
                ? ` · bot ready for the username ("${usernameReady}")`
                : ` · bot never said "${usernameReady}" within ${replyTimeoutMs}ms, sending anyway`
            }`;
          }
        }

        // The bot asks for the username in its own time; sent before it is listening, the
        // name is dropped and the accepted code is spent for nothing
        if (usernameWait) {
          const reached = await usernameWait.result;
          checkCancelled();
          codeStep.result += reached
            ? ` · bot ready for the username ("${usernameReady}")`
            : ` · bot never said "${usernameReady}" within ${replyTimeoutMs}ms, sending anyway`;
        }

        // 5. Finish signup with the username
        const username = expandCommand(signupUsername);
        const userStep = beginStep(
          "send_command",
          `Send username: "${username}"`,
        );
        const u0 = Date.now();
        const finalPromise = waitForVerdict(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          undefined,
          config.failContains,
          signal,
        );
        await client.sendMessage(botUsername, { message: username });
        const final = await finalPromise;
        userStep.durationMs = Date.now() - u0;
        if (final.messages.length) {
          const parsed = await parseMessages(final.messages, client, signal);
          userStep.responseHtml = parsed.html || undefined;
          userStep.responseImage = parsed.images[0];
        }
        if (final.verdict === "fail") {
          userStep.error = "Signup rejected after username";
          armed = false;
          continue;
        }
        userStep.result =
          final.verdict === "timeout"
            ? "Username sent (no confirmation received)"
            : "Registration completed";
        listenStep.durationMs = Date.now() - listenStart;
        return log;
      }
    } finally {
      client.removeEventHandler(onGroupMessage, new NewMessage({}));
    }
  } catch (err: any) {
    if (err?.message === "Job cancelled") throw err;
    if (err instanceof AutoregJobError) throw err;
    throw new AutoregJobError(err?.message ?? String(err), log);
  } finally {
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14).
    // Bounded: teardown runs over the same connection, so a dead proxy would hang it too.
    await destroyQuietly(client, "autoreg");
  }
}
