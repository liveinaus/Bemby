import { TelegramClient, Api, Logger } from "telegram";
import { generateRandomBigInt } from "telegram/Helpers";
import { getInputUser } from "telegram/Utils";
import { CustomFile } from "telegram/client/uploads";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage, Raw, type NewMessageEvent } from "telegram/events";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import { escapeHtml as escHtml, safeHref } from "./htmlEscape";
import { parseTgProxy } from "../jobs/runner";
import { missingProxyMessage } from "./proxyProviders";
import { globalTgProxy } from "./globalProxy";
import { resolveAppClientParams } from "./appClient";
import { parseMiniAppLink, withClientLaunchParams } from "./miniApp";
import { displayPeerId } from "./peerTarget";
import {
  cachedChannelDm,
  forgetAccountChannelDms,
  monoforumEntity,
  rememberChannelDm,
  resolveChannelDm,
  type ChannelDmTarget,
} from "./monoforum";

export type TgLiveMessage = {
  chatId: string;
  message: TgMsgPayload;
};

export type TgReaction = {
  emoji: string;
  count: number;
  mine: boolean;
};

export type TgButton = {
  text: string;
  data: string | null; // base64-encoded callback data
  url: string | null;
  webApp: boolean; // Telegram Mini App button -- must open in a real browser
  send: boolean; // reply-keyboard button -- clicking sends its text as a message
  requestPhone: boolean; // reply-keyboard button -- shares our own phone as a contact
};

/** Media a quoted message carries, so the UI can word a quote with no text of its own. */
export type TgMediaKind =
  "photo" | "video" | "sticker" | "voice" | "audio" | "document" | "contact" | "poll";

export type TgPollAnswer = {
  /** base64 of the option bytes -- what a vote sends back. */
  option: string;
  text: string;
  voters: number;
  /** This account picked it. */
  chosen: boolean;
  /** Quiz only, and only once answered: this was the right one. */
  correct: boolean;
};

export type TgPoll = {
  id: string;
  question: string;
  quiz: boolean;
  multiple: boolean;
  closed: boolean;
  publicVoters: boolean;
  totalVoters: number;
  /** True once this account has voted, which is when Telegram reveals the tallies. */
  voted: boolean;
  answers: TgPollAnswer[];
};

/** Membership and housekeeping events Telegram reports as service messages. */
export type TgServiceKind =
  | "join"
  | "joinByRequest"
  | "added"
  | "left"
  | "removed"
  | "pinned"
  | "titleChanged"
  | "photoChanged"
  | "created";

/**
 * Who did what to whom. The UI writes the sentence, so it can be translated and can link
 * the names -- names are null when the peer is not resolvable.
 */
export type TgServiceInfo = {
  kind: TgServiceKind;
  actorId: string | null;
  actorName: string | null;
  targets: { chatId: string; name: string | null }[];
  /** New chat title for `titleChanged`, else null. */
  title: string | null;
};

export type TgMsgPayload = {
  id: number;
  text: string;
  html: string | null; // safe HTML with entity markup; null = plain text
  date: number;
  fromMe: boolean;
  isRead: boolean; // true when recipient has read this outgoing message
  fromId: string | null;
  fromName: string | null;
  hasPhoto: boolean;
  hasDocument: boolean;
  hasSticker: boolean;
  fileName: string | null;
  buttons: TgButton[][] | null;
  reactions: TgReaction[] | null;
  replyToId: number | null;
  replyToText: string | null;
  replyToName: string | null;
  replyCount: number | null;
  /** Media of the quoted message, when it has no text to quote. */
  replyToMedia?: TgMediaKind | null;
  replyToFileName?: string | null;
  /** Set on service messages (someone joined, left, renamed the group...); null otherwise. */
  service?: TgServiceInfo | null;
  /** When the sender last edited this message, so a sync can tell a change from a repeat. */
  editDate?: number | null;
  /** This message's own media, so video, voice and GIF stop rendering as a plain document. */
  media?: TgMediaKind | null;
  /** Shared by every message of an album, so the UI can group them into one block. */
  groupedId?: string | null;
  /** True while the message is pinned in its chat. */
  pinned?: boolean;
  /** Poll or quiz carried by this message; null on everything else. */
  poll?: TgPoll | null;
};

/**
 * A change to something already on screen. New messages keep their own channel
 * (`TgLiveMessage`); everything here patches a message, or a chat, that the client has
 * already been told about.
 */
export type TgLiveEvent =
  | { type: "edited"; chatId: string; message: TgMsgPayload }
  | { type: "deleted"; chatId: string; ids: number[] }
  | {
      type: "reactions";
      chatId: string;
      msgId: number;
      reactions: TgReaction[] | null;
    }
  | { type: "readInbox"; chatId: string; maxId: number; unreadCount: number }
  | { type: "pinned"; chatId: string; ids: number[]; pinned: boolean }
  | { type: "syncState"; state: TgSyncState };

/** What the account's connection is doing, so the UI can say so instead of guessing. */
export type TgSyncState = "live" | "catchingUp" | "reconnecting";

export type TgDialogItem = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  unreadCount: number;
  lastMessage: { text: string; date: number; fromMe: boolean } | null;
  left?: boolean; // true when the current user is not a member (search/resolve results)
  muted?: boolean;
  pinned?: boolean;
  /** A channel's direct-message chat, which the account reads and writes without joining. */
  dm?: boolean;
};

/** A Mini App a bot pins beside the composer. */
export type TgBotMenuButton = { text: string; url: string };

export type TgContactItem = {
  chatId: string;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string | null;
};

type LiveEntry = {
  accountId: number;
  client: TelegramClient;
  entityCache: Map<string, Api.User | Api.Chat | Api.Channel>;
  subscribers: Set<(msg: TgLiveMessage) => void>;
  dialogSubscribers: Set<(dialogs: TgDialogItem[]) => void>;
  // Per-entry avatar cache: chatId -> Buffer (has avatar) | null (no avatar) | undefined (not fetched)
  avatarCache: Map<string, Buffer | null>;
  // Tracks the highest outgoing message ID the recipient has read, per chatId
  readOutboxCache: Map<string, number>;
  // chatId -> where its direct messages go, or null when the channel has them off
  channelDmCache: Map<string, ChannelDmTarget | null>;
  readSubscribers: Set<(chatId: string, maxId: number) => void>;
  typingSubscribers: Set<(event: TgTypingEvent) => void>;
  eventSubscribers: Set<(event: TgLiveEvent) => void>;
  // What this account's connection is doing, replayed to each new subscriber
  syncState: TgSyncState;
  // Keeps the stored update state fresh; cleared with the client in disposeEntry
  syncStateTimer?: ReturnType<typeof setInterval>;
  // Full dialog list cached briefly so per-keystroke searches don't refetch
  dialogSearchCache?: { ts: number; items: TgDialogItem[] };
  // Last time this entry was requested or had subscribers -- drives idle eviction
  lastActiveAt: number;
};

export type TgTypingEvent = {
  chatId: string;
  userId: string | null;
  userName: string | null;
  cancelled: boolean;
};

const liveClients = new Map<number, LiveEntry>();

// --- Idle eviction and cache bounds (issue #14) ---
// A connected client receives every update for its account and GramJS's
// internal entity cache grows for as long as the client lives, so memory
// climbs steadily on long-running deployments. Evict clients nobody is
// watching and keep the per-entry caches bounded.

const IDLE_DISCONNECT_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
// GramJS bounds reconnect attempts but not wall-clock time, so a dead or slow proxy
// leaves connect() pending forever and every caller behind it waits with no error.
const CONNECT_TIMEOUT_MS =
  Number(process.env.TG_CONNECT_TIMEOUT_SECONDS ?? 90) * 1000;
const ENTITY_CACHE_MAX = 1_000;
const AVATAR_CACHE_MAX = 300;
const READ_OUTBOX_CACHE_MAX = 1_000;

// A live client per account is several MB of GramJS state plus a connection, so on a
// small host the account count, not idle time, is what runs memory out. Evict the
// least recently used client nobody is watching once past this many.
const LIVE_CLIENT_MAX = Number(process.env.TG_LIVE_CLIENT_MAX ?? 8);

// Inline media is buffered whole to serve it, so a large video would spike the heap by
// its full size. Anything bigger is refused rather than risking the process.
const MEDIA_MAX_BYTES = Number(process.env.TG_MEDIA_MAX_MB ?? 25) * 1024 * 1024;

function hasSubscribers(entry: LiveEntry): boolean {
  return (
    entry.subscribers.size > 0 ||
    entry.dialogSubscribers.size > 0 ||
    entry.readSubscribers.size > 0 ||
    entry.typingSubscribers.size > 0 ||
    entry.eventSubscribers.size > 0
  );
}

// Maps iterate in insertion order, so this drops the oldest entries first
function trimCache(cache: Map<string, unknown>, max: number): void {
  for (const key of cache.keys()) {
    if (cache.size <= max) return;
    cache.delete(key);
  }
}

/**
 * Drops the least recently used clients once the registry is over LIVE_CLIENT_MAX.
 * Entries with subscribers (someone is watching that account) and `keepId` (the one
 * just handed out) are never evicted, so the cap can be exceeded when more accounts
 * than that are genuinely being watched at once.
 */
/**
 * The one way a live client goes away. destroy() tears down the update loop and senders;
 * disconnect() alone would keep the client reusable and holding its internal caches. The
 * state timer has to go with it or an evicted account keeps polling forever.
 */
function disposeEntry(accountId: number, entry: LiveEntry): void {
  liveClients.delete(accountId);
  if (entry.syncStateTimer) {
    clearInterval(entry.syncStateTimer);
    entry.syncStateTimer = undefined;
  }
  entry.client.destroy().catch(() => {});
}

function evictSurplusClients(keepId?: number): void {
  if (liveClients.size <= LIVE_CLIENT_MAX) return;
  const candidates = [...liveClients.entries()]
    .filter(([id, e]) => id !== keepId && !hasSubscribers(e))
    .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);

  for (const [accountId, entry] of candidates) {
    if (liveClients.size <= LIVE_CLIENT_MAX) return;
    disposeEntry(accountId, entry);
    console.log(
      `[tg] Evicted idle live client for account ${accountId} (over LIVE_CLIENT_MAX)`,
    );
  }
}

export function sweepLiveClients(now = Date.now()): void {
  for (const [accountId, entry] of liveClients) {
    if (hasSubscribers(entry)) entry.lastActiveAt = now;

    if (now - entry.lastActiveAt >= IDLE_DISCONNECT_MS) {
      disposeEntry(accountId, entry);
      continue;
    }

    trimCache(entry.entityCache, ENTITY_CACHE_MAX);
    trimCache(entry.avatarCache, AVATAR_CACHE_MAX);
    trimCache(entry.readOutboxCache, READ_OUTBOX_CACHE_MAX);
  }
  // A client whose subscribers have gone becomes evictable, so re-check the cap here
  // rather than only when a new one is created.
  evictSurplusClients();
}

// unref() so the sweep never keeps the process (or test runner) alive
setInterval(() => sweepLiveClients(), SWEEP_INTERVAL_MS).unref();

type AccountRow = {
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  proxy_id: string | null;
  app_client_id: string | null;
};

// Derive a stable chatId string from an entity
export function entityToChatId(
  entity: Api.User | Api.Chat | Api.Channel,
): string {
  const id = entity.id.toString();
  if (entity instanceof Api.User) return `u${id}`;
  if (entity instanceof Api.Channel) return `c${id}`;
  return `g${id}`;
}

// Build chatId from a peer reference
export function peerToChatId(peer: Api.TypePeer): string {
  if (peer instanceof Api.PeerUser) return `u${peer.userId.toString()}`;
  if (peer instanceof Api.PeerChannel) return `c${peer.channelId.toString()}`;
  if (peer instanceof Api.PeerChat) return `g${peer.chatId.toString()}`;
  return "";
}

// Reverse of peerToChatId -- used as a fallback entity lookup key
function chatIdToPeer(chatId: string): Api.TypePeer | null {
  try {
    if (chatId.startsWith("u"))
      return new Api.PeerUser({ userId: BigInt(chatId.slice(1)) as any });
    if (chatId.startsWith("c"))
      return new Api.PeerChannel({ channelId: BigInt(chatId.slice(1)) as any });
    if (chatId.startsWith("g"))
      return new Api.PeerChat({ chatId: BigInt(chatId.slice(1)) as any });
  } catch {
    /* ignore malformed ids */
  }
  return null;
}

// Converts Telegram message entities to safe HTML. Returns null when there are
// no formatting entities (plain text can be rendered directly).
function entitiesToHtml(
  text: string,
  entities: Api.TypeMessageEntity[] | undefined,
): string | null {
  if (!entities?.length) return null;

  type Span = { offset: number; end: number; open: string; close: string };
  const spans: Span[] = [];

  for (const e of entities) {
    const end = e.offset + e.length;
    if (e instanceof Api.MessageEntityTextUrl) {
      const safe = safeHref(e.url ?? "");
      if (safe) {
        spans.push({
          offset: e.offset,
          end,
          open: `<a href="${escHtml(safe)}" class="tgc-link" data-tgurl>`,
          close: "</a>",
        });
      }
    } else if (e instanceof Api.MessageEntityUrl) {
      const url = text.slice(e.offset, end);
      const safe = safeHref(url);
      if (safe) {
        spans.push({
          offset: e.offset,
          end,
          open: `<a href="${escHtml(safe)}" class="tgc-link" data-tgurl>`,
          close: "</a>",
        });
      }
    } else if (e instanceof Api.MessageEntityMention) {
      const handle = text.slice(e.offset + 1, end); // strip leading @
      spans.push({
        offset: e.offset,
        end,
        open: `<a href="https://t.me/${escHtml(handle)}" class="tgc-link" data-tgurl>`,
        close: "</a>",
      });
    } else if (e instanceof Api.MessageEntityBold) {
      spans.push({
        offset: e.offset,
        end,
        open: "<strong>",
        close: "</strong>",
      });
    } else if (e instanceof Api.MessageEntityItalic) {
      spans.push({ offset: e.offset, end, open: "<em>", close: "</em>" });
    } else if (e instanceof Api.MessageEntityUnderline) {
      spans.push({ offset: e.offset, end, open: "<u>", close: "</u>" });
    } else if (e instanceof Api.MessageEntityStrike) {
      spans.push({ offset: e.offset, end, open: "<s>", close: "</s>" });
    } else if (e instanceof Api.MessageEntityCode) {
      spans.push({ offset: e.offset, end, open: "<code>", close: "</code>" });
    } else if (e instanceof Api.MessageEntityPre) {
      spans.push({ offset: e.offset, end, open: "<pre>", close: "</pre>" });
    }
  }

  if (!spans.length) return null;

  // Sort by offset ascending; longer spans first at same offset
  spans.sort((a, b) => a.offset - b.offset || b.end - a.end);

  let html = "";
  let pos = 0;
  for (const span of spans) {
    if (span.offset < pos) continue; // skip overlapping spans
    if (span.offset > pos)
      html += escHtml(text.slice(pos, span.offset)).replace(/\n/g, "<br>");
    html += span.open + escHtml(text.slice(span.offset, span.end)) + span.close;
    pos = span.end;
  }
  if (pos < text.length)
    html += escHtml(text.slice(pos)).replace(/\n/g, "<br>");
  return html;
}

function entityName(entity: Api.User | Api.Chat | Api.Channel): string {
  if (entity instanceof Api.User) {
    return (
      [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
      entity.username ||
      "Unknown"
    );
  }
  return (entity as any).title ?? (entity as any).username ?? "Unknown";
}

function extractButtons(msg: Api.Message): TgButton[][] | null {
  if (!msg.replyMarkup) return null;
  if (msg.replyMarkup instanceof Api.ReplyInlineMarkup) {
    return msg.replyMarkup.rows.map((row) =>
      row.buttons.map((btn: any): TgButton => ({
        text: btn.text ?? "",
        data: btn.data ? Buffer.from(btn.data).toString("base64") : null,
        url: btn.url ?? null,
        webApp:
          btn instanceof Api.KeyboardButtonWebView ||
          btn instanceof Api.KeyboardButtonSimpleWebView,
        send: false,
        requestPhone: false,
      })),
    );
  }
  // Reply keyboards (e.g. @SpamBot's "This is a mistake"): plain buttons whose
  // text is sent back as a message when tapped.
  if (msg.replyMarkup instanceof Api.ReplyKeyboardMarkup) {
    const rows = msg.replyMarkup.rows.map((row) =>
      row.buttons.map((btn: any): TgButton => ({
        text: btn.text ?? "",
        data: null,
        url: btn.url ?? null,
        webApp:
          btn instanceof Api.KeyboardButtonWebView ||
          btn instanceof Api.KeyboardButtonSimpleWebView,
        // Only plain text buttons can be fulfilled by sending their text;
        // location/poll/webview variants can't, so leave them inert.
        send: btn instanceof Api.KeyboardButton,
        requestPhone: btn instanceof Api.KeyboardButtonRequestPhone,
      })),
    );
    return rows.length ? rows : null;
  }
  return null;
}

/** Reaction counts off a MessageReactions block, whether it came on a message or an update. */
function reactionsFromApi(
  reactions: Api.TypeMessageReactions | null | undefined,
): TgReaction[] | null {
  const results = (reactions as any)?.results as any[] | undefined;
  if (!results?.length) return null;
  const out = results
    .filter((rc: any) => rc.reaction?.emoticon)
    .map((rc: any) => ({
      emoji: rc.reaction.emoticon as string,
      count: rc.count as number,
      mine: rc.chosenOrder !== undefined && rc.chosenOrder !== null,
    }));
  return out.length ? out : null;
}

function extractReactions(msg: Api.Message): TgReaction[] | null {
  return reactionsFromApi((msg as any).reactions);
}

function isStickerDoc(media: Api.TypeMessageMedia | null | undefined): boolean {
  if (!(media instanceof Api.MessageMediaDocument)) return false;
  const doc = (media as Api.MessageMediaDocument).document;
  if (!(doc instanceof Api.Document)) return false;
  return doc.attributes.some((a) => a instanceof Api.DocumentAttributeSticker);
}

// Contact cards carry no message text, so without this they render as an empty
// bubble once the history is reloaded from the server.
function contactMediaText(
  media: Api.TypeMessageMedia | null | undefined,
): string {
  if (!(media instanceof Api.MessageMediaContact)) return "";
  const c = media as Api.MessageMediaContact;
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  const phone = c.phoneNumber?.startsWith("+")
    ? c.phoneNumber
    : `+${c.phoneNumber ?? ""}`;
  return [name, phone]
    .filter((s) => s && s !== "+")
    .join(" ")
    .trim();
}

/** Text of a poll question or answer, which layer 225 carries as TextWithEntities. */
function pollText(value: unknown): string {
  if (typeof value === "string") return value;
  return ((value as any)?.text as string) ?? "";
}

/**
 * The poll behind a message, tallies included. Telegram withholds the per-answer counts
 * until the account has voted (or the poll closed), which is why `voted` is worth carrying:
 * it tells the UI whether zeroes mean "no votes" or "not shown yet".
 */
function extractPoll(
  media: Api.TypeMessageMedia | null | undefined,
): TgPoll | null {
  if (!(media instanceof Api.MessageMediaPoll)) return null;
  const poll = media.poll as Api.Poll;
  const results = (media.results as Api.PollResults) ?? null;
  const byOption = new Map<string, Api.PollAnswerVoters>();
  for (const r of (results?.results ?? []) as Api.PollAnswerVoters[]) {
    byOption.set(Buffer.from(r.option as any).toString("base64"), r);
  }
  const answers = (poll.answers ?? []).map((a): TgPollAnswer => {
    const option = Buffer.from((a as Api.PollAnswer).option as any).toString("base64");
    const voters = byOption.get(option);
    return {
      option,
      text: pollText((a as Api.PollAnswer).text),
      voters: voters?.voters ?? 0,
      chosen: Boolean(voters?.chosen),
      correct: Boolean(voters?.correct),
    };
  });
  return {
    id: poll.id?.toString() ?? "",
    question: pollText(poll.question),
    quiz: Boolean(poll.quiz),
    multiple: Boolean(poll.multipleChoice),
    closed: Boolean(poll.closed),
    publicVoters: Boolean(poll.publicVoters),
    totalVoters: results?.totalVoters ?? 0,
    voted: answers.some((a) => a.chosen),
    answers,
  };
}

/** Message text as shown in the UI, with a stand-in for text-less media. */
function displayText(
  msg: Api.Message | { message?: string; media?: any },
): string {
  const media = (msg as any).media;
  return (
    (msg as any).message ||
    contactMediaText(media) ||
    (media instanceof Api.MessageMediaPoll
      ? pollText((media.poll as Api.Poll).question)
      : "")
  );
}

/**
 * What kind of media a message carries, so a quote of a text-less message can still say
 * what it was. Anything not worth naming returns null and reads as a plain message.
 */
function mediaKind(
  media: Api.TypeMessageMedia | null | undefined,
): TgMediaKind | null {
  if (media instanceof Api.MessageMediaPhoto) return "photo";
  if (media instanceof Api.MessageMediaContact) return "contact";
  if (media instanceof Api.MessageMediaPoll) return "poll";
  if (media instanceof Api.MessageMediaDocument) {
    const doc = (media as Api.MessageMediaDocument).document;
    if (!(doc instanceof Api.Document)) return "document";
    if (doc.attributes.some((a) => a instanceof Api.DocumentAttributeSticker))
      return "sticker";
    const audio = doc.attributes.find(
      (a) => a instanceof Api.DocumentAttributeAudio,
    ) as Api.DocumentAttributeAudio | undefined;
    if (audio) return audio.voice ? "voice" : "audio";
    if (doc.attributes.some((a) => a instanceof Api.DocumentAttributeVideo))
      return "video";
    return "document";
  }
  return null;
}

/** Quote details for the message a reply points at. */
type TgQuoteInfo = {
  text: string;
  name: string | null;
  media: TgMediaKind | null;
  fileName: string | null;
};

/**
 * The one place a message becomes a payload. Live updates, history pages and edits all go
 * through it, so an edited message reads exactly like the same message loaded fresh --
 * which is the whole point of the sync work: no field can drift between the two paths.
 */
function buildMsgPayload(
  msg: Api.Message,
  opts: {
    fromName: string | null;
    readMaxId: number;
    replyToId: number | null;
    quote: TgQuoteInfo | null | undefined;
  },
): TgMsgPayload {
  const media = mediaKind(msg.media);
  return {
    id: msg.id,
    text: displayText(msg),
    html: entitiesToHtml(msg.message ?? "", msg.entities),
    date: msg.date,
    fromMe: Boolean(msg.out),
    isRead: Boolean(msg.out) && msg.id <= opts.readMaxId,
    fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
    fromName: opts.fromName,
    hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
    hasDocument:
      msg.media instanceof Api.MessageMediaDocument && !isStickerDoc(msg.media),
    hasSticker: isStickerDoc(msg.media),
    fileName: docFileName(msg.media),
    buttons: extractButtons(msg),
    reactions: extractReactions(msg),
    replyToId: opts.replyToId,
    replyToText: opts.quote?.text ?? null,
    replyToName: opts.quote?.name ?? null,
    replyToMedia: opts.quote?.media ?? null,
    replyToFileName: opts.quote?.fileName ?? null,
    replyCount: (msg as any).replies?.replies ?? null,
    service: null,
    editDate: msg.editDate ?? null,
    media,
    groupedId: msg.groupedId ? msg.groupedId.toString() : null,
    pinned: Boolean(msg.pinned),
    poll: extractPoll(msg.media),
  };
}

/** The message id a reply points at, or null when the message is not a reply. */
function replyTargetId(msg: Api.Message | Api.MessageService): number | null {
  const rt = (msg as any).replyTo;
  if (rt?.className !== "MessageReplyHeader") return null;
  return (rt.replyToMsgId as number | undefined) ?? null;
}

// Filename of a document attachment, if the sender provided one.
function docFileName(
  media: Api.TypeMessageMedia | null | undefined,
): string | null {
  if (!(media instanceof Api.MessageMediaDocument)) return null;
  const doc = (media as Api.MessageMediaDocument).document;
  if (!(doc instanceof Api.Document)) return null;
  const attr = doc.attributes.find(
    (a) => a instanceof Api.DocumentAttributeFilename,
  ) as Api.DocumentAttributeFilename | undefined;
  return attr?.fileName ?? null;
}

/**
 * The exit this account's Telegram connection leaves by.
 *
 * An account that names an exit it cannot use is an error, not a quiet fall back to the
 * server's own address. A session authorised through a proxy that then reconnects from a
 * different IP is two addresses on one session, which is what Telegram answers with
 * AUTH_KEY_DUPLICATED -- it kills the session, and nothing about the cause would be visible
 * afterwards. Going direct is only right when the account asks for it by naming no proxy at
 * all. Same rule as resolveAccountExit in jobs/accountOps, which cannot be imported here
 * without a cycle.
 */
function resolveProxy(proxyId: string | null) {
  // An account naming no exit follows the global one, which stands in for a direct
  // connection everywhere; only a SOCKS global exit can carry MTProto, and anything else
  // leaves this direct
  if (!proxyId) return globalTgProxy();

  let url: string | undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    const list: Array<{ id: string; url: string }> = row?.value
      ? JSON.parse(row.value)
      : [];
    url = list.find((p) => p.id === proxyId)?.url;
  } catch {
    url = undefined;
  }

  if (!url) throw new Error(missingProxyMessage(proxyId));

  const proxy = parseTgProxy(url);
  if (!proxy)
    throw new Error(
      "The account's proxy cannot carry Telegram (an account proxy must be socks5:// or socks4://)",
    );
  return proxy;
}

export async function reconnectClient(accountId: number): Promise<void> {
  const entry = liveClients.get(accountId);
  // The old client is discarded for good, so its state timer goes with it
  if (entry) disposeEntry(accountId, entry);
  await getLiveClient(accountId);
}

const AUTH_ERROR_CODES = [
  "AUTH_KEY_DUPLICATED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

export function isAuthError(msg: string): boolean {
  return AUTH_ERROR_CODES.some((code) => msg.includes(code));
}

export function markSessionExpired(accountId: number): void {
  db.prepare(
    "UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?",
  ).run(accountId);
  const entry = liveClients.get(accountId);
  if (entry) disposeEntry(accountId, entry);
}

/**
 * Connections in progress, so two callers asking for the same idle account share one.
 *
 * Without this there was a gap between the map lookup above and the `set` at the end: both
 * callers saw no entry, both built and connected a TelegramClient, and the second overwrote
 * the first in `liveClients`. The first was then live, connected and unreachable, running
 * its update loop against Telegram until the process restarted.
 */
const connecting = new Map<number, Promise<LiveEntry>>();

/** Bounded connect: a dead proxy fails the caller instead of hanging it forever. */
async function connectWithTimeout(client: TelegramClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Connect timed out after ${CONNECT_TIMEOUT_MS}ms (proxy unreachable?)`,
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function getLiveClient(accountId: number): Promise<LiveEntry> {
  const existing = liveClients.get(accountId);
  if (existing) {
    existing.lastActiveAt = Date.now();
    if (!existing.client.connected) await connectWithTimeout(existing.client);
    return existing;
  }

  const inFlight = connecting.get(accountId);
  if (inFlight) return inFlight;

  const pending = connectLiveClient(accountId);
  connecting.set(accountId, pending);
  try {
    return await pending;
  } finally {
    // Cleared whether it resolved or threw, so a failed connect does not wedge the account
    connecting.delete(accountId);
  }
}

async function connectLiveClient(accountId: number): Promise<LiveEntry> {
  let entry: LiveEntry | undefined;
  const account = db
    .prepare(
      "SELECT api_id, api_hash, session_string, proxy_id, app_client_id FROM tg_accounts WHERE id = ?",
    )
    .get(accountId) as AccountRow | undefined;
  if (account) decryptAccountRow(account);

  if (!account?.session_string)
    throw new Error("Account not found or not authenticated");

  const ownCredentials =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  const apiId = credentials?.apiId;
  const apiHash = credentials?.apiHash;
  if (!apiId || !apiHash)
    throw new Error("No API credentials available for this account");

  const proxy = resolveProxy(account.proxy_id);
  const deviceParams = resolveAppClientParams(accountId, account.app_client_id);

  const client = new TelegramClient(
    new StringSession(account.session_string),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  try {
    await connectWithTimeout(client);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) {
      db.prepare(
        "UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?",
      ).run(accountId);
    }
    // Never stored in liveClients, so nothing else would tear it down
    client.destroy().catch(() => {});
    throw err;
  }

  // GetState also tells Telegram this session is active, which is what starts the update
  // stream. Both it and the catch-up below run fire-and-forget: neither should hold up the
  // first HTTP request, and the catch-up reports itself through the syncState event.

  entry = {
    accountId,
    client,
    entityCache: new Map(),
    subscribers: new Set(),
    dialogSubscribers: new Set(),
    avatarCache: new Map(),
    readOutboxCache: new Map(),
    channelDmCache: new Map(),
    readSubscribers: new Set(),
    typingSubscribers: new Set(),
    eventSubscribers: new Set(),
    syncState: "live",
    lastActiveAt: Date.now(),
  };
  liveClients.set(accountId, entry);
  evictSurplusClients(accountId);

  client.addEventHandler(async (event: NewMessageEvent) => {
    await applyNewMessage(entry!, event.message as Api.Message);
  }, new NewMessage({}));

  // Everything below arrives as a raw update because GramJS's NewMessage builder passes
  // only real new messages through. Each one delegates to the same function the catch-up
  // path uses, so a change replayed after a gap lands exactly as if it had arrived live.
  client.addEventHandler(
    // Returned, not fired and forgotten: GramJS awaits each handler, so returning the
    // promise keeps an edit from overtaking the message it edits.
    (update: Api.TypeUpdate) => applyUpdate(entry!, update),
    new Raw({
      types: [
        Api.UpdateEditMessage,
        Api.UpdateEditChannelMessage,
        Api.UpdateDeleteMessages,
        Api.UpdateDeleteChannelMessages,
        Api.UpdateMessageReactions,
        Api.UpdateReadHistoryInbox,
        Api.UpdateReadChannelInbox,
        Api.UpdatePinnedMessages,
        Api.UpdatePinnedChannelMessages,
        Api.UpdateChannelTooLong,
        // Membership and housekeeping notices (joins, leaves, renames) ride on the
        // new-message updates as MessageService, which the NewMessage builder filters out
        Api.UpdateNewMessage,
        Api.UpdateNewChannelMessage,
        Api.UpdateReadHistoryOutbox,
        Api.UpdateReadChannelOutbox,
      ],
    }),
  );

  // Typing notifications for private chats, basic groups and supergroups
  const emitTyping = (
    chatId: string,
    fromId: string | null,
    action: Api.TypeSendMessageAction,
  ) => {
    let userName: string | null = null;
    if (fromId) {
      const sender = entry!.entityCache.get(fromId);
      if (sender) userName = entityName(sender);
    }
    entry!.typingSubscribers.forEach((sub) =>
      sub({
        chatId,
        userId: fromId,
        userName,
        cancelled: action instanceof Api.SendMessageCancelAction,
      }),
    );
  };

  client.addEventHandler(
    (update: Api.UpdateUserTyping) => {
      const uid = `u${update.userId.toString()}`;
      emitTyping(uid, uid, update.action);
    },
    new Raw({ types: [Api.UpdateUserTyping] }),
  );

  client.addEventHandler(
    (update: Api.UpdateChatUserTyping) => {
      emitTyping(
        `g${update.chatId.toString()}`,
        update.fromId ? peerToChatId(update.fromId) : null,
        update.action,
      );
    },
    new Raw({ types: [Api.UpdateChatUserTyping] }),
  );

  client.addEventHandler(
    (update: Api.UpdateChannelUserTyping) => {
      emitTyping(
        `c${update.channelId.toString()}`,
        update.fromId ? peerToChatId(update.fromId) : null,
        update.action,
      );
    },
    new Raw({ types: [Api.UpdateChannelUserTyping] }),
  );

  // Replay whatever this account missed since it was last connected, then keep the stored
  // state fresh. Handlers are registered first so anything arriving mid-catch-up is applied
  // rather than dropped; duplicates are absorbed by the signature check in applyNewMessage.
  catchUpAccount(entry).catch(() => {});
  entry.syncStateTimer = setInterval(() => {
    const current = liveClients.get(accountId);
    if (current !== entry) return;
    storeCurrentState(entry!).catch(() => {});
  }, SYNC_STATE_INTERVAL_MS);
  entry.syncStateTimer.unref?.();

  return entry;
}

// --- Update dispatch -------------------------------------------------------------------
//
// One set of functions applies a change, whether it arrived live on the socket or was
// replayed by updates.getDifference after a gap. Keeping the two paths on the same code is
// the point: a message edited while the panel was disconnected has to land identically to
// one edited while it was watching, or the cache and the screen disagree again.

/** Fields whose change makes a message worth re-rendering. */
function messageSignature(p: TgMsgPayload): string {
  return JSON.stringify([
    p.text,
    p.html,
    p.editDate ?? null,
    p.pinned ?? false,
    p.reactions,
    p.buttons,
    p.media ?? null,
    p.fileName,
    p.poll ?? null,
  ]);
}

async function applyNewMessage(
  entry: LiveEntry,
  msg: Api.Message,
): Promise<void> {
  if (!msg?.peerId) return;
  const chatId = peerToChatId(msg.peerId);
  if (!chatId) return;

  const payload = await livePayload(entry, chatId, msg);
  // Freshly received -- the recipient cannot have read it yet
  if (!payload.fromMe) payload.isRead = false;

  const prev = getCachedMessage(entry.accountId, chatId, msg.id);
  cacheMessages(entry.accountId, chatId, [payload]);
  extendChatRange(entry.accountId, chatId, msg.id);

  // Already known: either the catch-up replayed it, or the send route cached a stub for
  // our own message and this is the server's fuller copy. Only the difference is news.
  if (!prev) {
    entry.subscribers.forEach((sub) => sub({ chatId, message: payload }));
  } else if (messageSignature(prev) !== messageSignature(payload)) {
    emitEvent(entry, { type: "edited", chatId, message: payload });
  }
}

async function applyServiceMessage(
  entry: LiveEntry,
  msg: Api.MessageService,
): Promise<void> {
  const chatId = peerToChatId(msg.peerId);
  if (!chatId) return;
  if (getCachedMessage(entry.accountId, chatId, msg.id)) return;
  const service = (await serviceInfoForPage(entry, [msg])).get(msg.id);
  if (!service) return;
  const payload = serviceMsgPayload(msg, service);
  cacheMessages(entry.accountId, chatId, [payload]);
  extendChatRange(entry.accountId, chatId, msg.id);
  entry.subscribers.forEach((sub) => sub({ chatId, message: payload }));
}

async function applyEdit(entry: LiveEntry, msg: Api.TypeMessage): Promise<void> {
  if (!(msg instanceof Api.Message) || !msg.peerId) return;
  const chatId = peerToChatId(msg.peerId);
  if (!chatId) return;
  const payload = await livePayload(entry, chatId, msg);
  const prev = getCachedMessage(entry.accountId, chatId, msg.id);
  if (prev && messageSignature(prev) === messageSignature(payload)) return;
  cacheMessages(entry.accountId, chatId, [payload]);
  emitEvent(entry, { type: "edited", chatId, message: payload });
}

function applyDeletes(
  entry: LiveEntry,
  chatId: string | null,
  rawIds: number[],
): void {
  const ids = rawIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return;

  // A deletion in a private chat or basic group names no peer -- only message ids, which
  // are unique per account there -- so the chat is recovered from what was cached.
  const byChat = chatId
    ? new Map([[chatId, ids]])
    : cachedChatsForMessages(entry.accountId, ids);

  for (const [id, chatIds] of byChat) {
    removeCachedMessages(entry.accountId, id, chatIds);
    emitEvent(entry, { type: "deleted", chatId: id, ids: chatIds });
  }
}

function applyPinned(
  entry: LiveEntry,
  chatId: string,
  rawIds: number[],
  pinned: boolean,
): void {
  const ids = rawIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return;
  for (const id of ids) {
    patchCachedMessage(entry.accountId, chatId, id, (p) => {
      p.pinned = pinned;
    });
  }
  emitEvent(entry, { type: "pinned", chatId, ids, pinned });
}

function applyReadOutbox(entry: LiveEntry, chatId: string, maxId: number): void {
  entry.readOutboxCache.set(chatId, maxId);
  entry.readSubscribers.forEach((sub) => sub(chatId, maxId));
}

/** Routes one raw update to whichever applier owns it. Unknown types are ignored. */
async function applyUpdate(
  entry: LiveEntry,
  update: Api.TypeUpdate,
): Promise<void> {
  try {
    if (
      update instanceof Api.UpdateNewMessage ||
      update instanceof Api.UpdateNewChannelMessage
    ) {
      // Real messages come through the NewMessage builder; only the grey service lines
      // it filters out are this handler's business.
      if (update.message instanceof Api.MessageService)
        await applyServiceMessage(entry, update.message);
      return;
    }
    if (
      update instanceof Api.UpdateEditMessage ||
      update instanceof Api.UpdateEditChannelMessage
    ) {
      await applyEdit(entry, update.message);
      return;
    }
    if (update instanceof Api.UpdateDeleteMessages) {
      applyDeletes(entry, null, update.messages);
      return;
    }
    if (update instanceof Api.UpdateDeleteChannelMessages) {
      applyDeletes(entry, `c${update.channelId.toString()}`, update.messages);
      return;
    }
    if (update instanceof Api.UpdateMessageReactions) {
      const chatId = peerToChatId(update.peer);
      if (!chatId) return;
      const reactions = reactionsFromApi(update.reactions);
      patchCachedMessage(entry.accountId, chatId, update.msgId, (p) => {
        p.reactions = reactions;
      });
      emitEvent(entry, {
        type: "reactions",
        chatId,
        msgId: update.msgId,
        reactions,
      });
      return;
    }
    if (update instanceof Api.UpdateReadHistoryInbox) {
      const chatId = peerToChatId(update.peer);
      if (chatId)
        emitEvent(entry, {
          type: "readInbox",
          chatId,
          maxId: update.maxId,
          unreadCount: update.stillUnreadCount,
        });
      return;
    }
    if (update instanceof Api.UpdateReadChannelInbox) {
      emitEvent(entry, {
        type: "readInbox",
        chatId: `c${update.channelId.toString()}`,
        maxId: update.maxId,
        unreadCount: update.stillUnreadCount,
      });
      return;
    }
    if (update instanceof Api.UpdateReadHistoryOutbox) {
      const chatId = peerToChatId(update.peer);
      if (chatId) applyReadOutbox(entry, chatId, update.maxId);
      return;
    }
    if (update instanceof Api.UpdateReadChannelOutbox) {
      applyReadOutbox(
        entry,
        `c${update.channelId.toString()}`,
        update.maxId,
      );
      return;
    }
    if (update instanceof Api.UpdatePinnedMessages) {
      const chatId = peerToChatId(update.peer);
      if (chatId)
        applyPinned(entry, chatId, update.messages, Boolean(update.pinned));
      return;
    }
    if (update instanceof Api.UpdatePinnedChannelMessages) {
      applyPinned(
        entry,
        `c${update.channelId.toString()}`,
        update.messages,
        Boolean(update.pinned),
      );
      return;
    }
    if (update instanceof Api.UpdateChannelTooLong) {
      // Telegram is saying "you missed too much of this channel to replay it". Per-channel
      // pts is not tracked, so the answer is to reconcile that one chat against the server.
      await reconcileChat(entry.accountId, `c${update.channelId.toString()}`);
      return;
    }
  } catch {
    // A dropped update is repaired by the next reconcile of that chat
  }
}

// --- Catch-up after a gap --------------------------------------------------------------
//
// GramJS ships catchUp() as an empty stub and tracks no update state of its own, so the
// common pts/qts/date is kept here. Gaps are routine rather than exceptional: idle clients
// are destroyed after IDLE_DISCONNECT_MS, surplus ones are evicted over LIVE_CLIENT_MAX,
// and the process restarts on every deploy. Without this, every update inside a gap was
// simply lost and the local cache kept the hole.

type SyncStateRow = { pts: number; qts: number; date: number; seq: number };

// How often the stored state is refreshed while connected. Storing it late can only cause
// a replay on the next connect, never a gap, and replays are idempotent.
const SYNC_STATE_INTERVAL_MS = 60_000;
// Difference pages to walk before giving up, so a very stale account cannot spin forever
const MAX_DIFFERENCE_ROUNDS = 20;

function loadSyncState(accountId: number): SyncStateRow | null {
  try {
    const row = db
      .prepare(
        "SELECT pts, qts, date, seq FROM tg_sync_state WHERE account_id = ?",
      )
      .get(accountId) as SyncStateRow | undefined;
    return row ?? null;
  } catch {
    return null; // No stored state reads as a first connect: record, do not replay
  }
}

function saveSyncState(accountId: number, state: SyncStateRow): void {
  try {
    db.prepare(
      `INSERT INTO tg_sync_state (account_id, pts, qts, date, seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET
         pts = excluded.pts, qts = excluded.qts, date = excluded.date,
         seq = excluded.seq, updated_at = excluded.updated_at`,
    ).run(
      accountId,
      state.pts,
      state.qts,
      state.date,
      state.seq,
      Math.floor(Date.now() / 1000),
    );
  } catch {}
}

export function clearSyncState(accountId: number): void {
  try {
    db.prepare("DELETE FROM tg_sync_state WHERE account_id = ?").run(accountId);
  } catch {}
}

async function storeCurrentState(entry: LiveEntry): Promise<void> {
  try {
    const state = await entry.client.invoke(new Api.updates.GetState());
    saveSyncState(entry.accountId, {
      pts: state.pts,
      qts: state.qts,
      date: state.date,
      seq: state.seq,
    });
  } catch {
    // Leaving the old state in place just means a longer replay next time
  }
}

/** Feeds one difference page through the same appliers the live socket uses. */
async function applyDifference(
  entry: LiveEntry,
  diff: Api.updates.Difference | Api.updates.DifferenceSlice,
): Promise<void> {
  for (const e of [...diff.users, ...diff.chats]) {
    if (
      e instanceof Api.User ||
      e instanceof Api.Chat ||
      e instanceof Api.Channel
    ) {
      entry.entityCache.set(entityToChatId(e), e);
    }
  }
  for (const msg of diff.newMessages) {
    if (msg instanceof Api.Message) await applyNewMessage(entry, msg);
    else if (msg instanceof Api.MessageService)
      await applyServiceMessage(entry, msg);
  }
  for (const update of diff.otherUpdates) {
    await applyUpdate(entry, update);
  }
}

/**
 * Replays everything the account missed since its stored state. A first-time account has no
 * stored state, so it just records where it is now -- there is no history to replay into an
 * empty cache.
 */
export async function catchUpAccount(entry: LiveEntry): Promise<void> {
  const stored = loadSyncState(entry.accountId);
  if (!stored) {
    await storeCurrentState(entry);
    return;
  }

  setSyncState(entry, "catchingUp");
  try {
    let { pts, qts, date } = stored;
    for (let round = 0; round < MAX_DIFFERENCE_ROUNDS; round++) {
      const diff = await entry.client.invoke(
        new Api.updates.GetDifference({ pts, qts, date }),
      );

      if (diff instanceof Api.updates.DifferenceEmpty) {
        saveSyncState(entry.accountId, {
          pts,
          qts,
          date: diff.date,
          seq: diff.seq,
        });
        break;
      }

      if (diff instanceof Api.updates.DifferenceTooLong) {
        // Too much missed to replay message by message. Drop the caches so the next open
        // refetches rather than showing a history with a hole in it.
        resetAccountSync(entry.accountId);
        await storeCurrentState(entry);
        break;
      }

      await applyDifference(entry, diff);
      const state =
        diff instanceof Api.updates.DifferenceSlice
          ? diff.intermediateState
          : diff.state;
      pts = state.pts;
      qts = state.qts;
      date = state.date;
      saveSyncState(entry.accountId, {
        pts,
        qts,
        date,
        seq: state.seq,
      });
      if (!(diff instanceof Api.updates.DifferenceSlice)) break;
    }
  } catch (err: any) {
    // A failed catch-up is recoverable: the per-chat reconcile still repairs what is open
    console.warn(
      `[tg] Catch-up failed for account ${entry.accountId}: ${err?.message ?? err}`,
    );
  } finally {
    setSyncState(entry, "live");
  }
}

/** Forgets everything cached about an account's history so it is refetched from scratch. */
function resetAccountSync(accountId: number): void {
  db.prepare("DELETE FROM tg_message_cache WHERE account_id = ?").run(accountId);
  try {
    db.prepare("DELETE FROM tg_chat_sync WHERE account_id = ?").run(accountId);
  } catch {}
  syncDialogsInBackground(accountId).catch(() => {});
}

// Load all dialogs into the entity cache
export async function loadDialogs(
  entry: LiveEntry,
  limit = 200,
): Promise<TgDialogItem[]> {
  const dialogs = await entry.client.getDialogs({ limit });
  const result: TgDialogItem[] = [];

  for (const d of dialogs) {
    if (!d.entity) continue;
    const entity = d.entity as Api.User | Api.Chat | Api.Channel;
    const chatId = entityToChatId(entity);
    entry.entityCache.set(chatId, entity);
    const roMaxId = (d.dialog as any).readOutboxMaxId as number | undefined;
    if (roMaxId) entry.readOutboxCache.set(chatId, roMaxId);

    const type: TgDialogItem["type"] =
      entity instanceof Api.User
        ? entity.bot
          ? "bot"
          : "user"
        : entity instanceof Api.Channel
          ? entity.megagroup
            ? "group"
            : "channel"
          : "group";

    const lastMsg = d.message as Api.Message | undefined;
    const muteUntil = (d.dialog as any).notifySettings?.muteUntil ?? 0;
    const muted = muteUntil > 0 && muteUntil > Math.floor(Date.now() / 1000);
    const pinned = Boolean((d.dialog as any).pinned);
    result.push({
      chatId,
      name: d.name ?? entityName(entity),
      type,
      username: (entity as any).username ?? null,
      unreadCount: d.dialog.unreadCount ?? 0,
      lastMessage: lastMsg
        ? {
            text: displayText(lastMsg),
            date: lastMsg.date,
            fromMe: Boolean(lastMsg.out),
          }
        : null,
      muted,
      pinned,
    });
  }

  return result;
}

export async function ensureEntityCached(
  entry: LiveEntry,
  chatId: string,
): Promise<void> {
  if (entry.entityCache.has(chatId)) return;
  await loadDialogs(entry);
  if (entry.entityCache.has(chatId)) return;
  // A channel's direct-message chat is joinless, so it stays out of the dialog list until it
  // has messages, and its ID alone resolves nowhere. The target carries the access hash.
  const dm = cachedChannelDm(entry.accountId, chatId);
  if (dm) {
    entry.entityCache.set(chatId, monoforumEntity(dm));
    return;
  }
  // Fallback for group members not in the user's dialogs (e.g. other participants).
  // GramJS keeps these in its internal session store after messages are fetched,
  // so getEntity resolves them without an extra network round-trip in most cases.
  try {
    const peer = chatIdToPeer(chatId);
    if (peer) {
      const entity = (await entry.client.getEntity(peer)) as
        Api.User | Api.Chat | Api.Channel;
      if (entity) entry.entityCache.set(chatId, entity);
    }
  } catch {
    /* not resolvable -- fetchAvatar will cache null and won't retry */
  }
}

/**
 * Payload for a message arriving live. History pages batch their name and quote lookups;
 * a single message resolves them one at a time, but it must resolve them: naming the sender
 * only when the entity happens to be cached is what made live group messages show a blank
 * name and "fix themselves" on refresh.
 */
async function livePayload(
  entry: LiveEntry,
  chatId: string,
  msg: Api.Message,
): Promise<TgMsgPayload> {
  const fromChatId = msg.fromId
    ? peerToChatId(msg.fromId as Api.TypePeer)
    : null;
  let fromName: string | null = null;
  if (fromChatId) {
    const names = await resolveEntityNames(entry, [fromChatId]);
    fromName = names.get(fromChatId) ?? null;
  }
  const replyToId = replyTargetId(msg);
  const quote = replyToId ? await replyQuote(entry, chatId, replyToId) : null;
  return buildMsgPayload(msg, {
    fromName,
    readMaxId: entry.readOutboxCache.get(chatId) ?? 0,
    replyToId,
    quote,
  });
}

function emitEvent(entry: LiveEntry, event: TgLiveEvent): void {
  entry.eventSubscribers.forEach((sub) => sub(event));
}

function setSyncState(entry: LiveEntry, state: TgSyncState): void {
  if (entry.syncState === state) return;
  entry.syncState = state;
  emitEvent(entry, { type: "syncState", state });
}

/**
 * Quote details for a single reply. Costs a round-trip, so it is only used for messages
 * arriving live -- history pages batch the same lookup.
 */
async function replyQuote(
  entry: LiveEntry,
  chatId: string,
  replyToId: number,
): Promise<{
  text: string;
  name: string | null;
  media: TgMediaKind | null;
  fileName: string | null;
} | null> {
  const entity = entry.entityCache.get(chatId);
  if (!entity) return null;
  try {
    const [rm] = await entry.client.getMessages(entity, { ids: [replyToId] });
    if (!rm?.id) return null;
    const rfid = rm.fromId ? peerToChatId(rm.fromId as Api.TypePeer) : null;
    const names = rfid ? await resolveEntityNames(entry, [rfid]) : null;
    return {
      text: displayText(rm),
      name: rfid ? (names?.get(rfid) ?? null) : entityName(entity),
      media: mediaKind(rm.media),
      fileName: docFileName(rm.media),
    };
  } catch {
    return null; // Quote unavailable -- the UI words it as a plain message
  }
}

/**
 * Maps a service action to a kind the UI knows how to word. Unsupported actions return null
 * and the message is dropped, so nothing renders as a blank grey line.
 */
function describeServiceAction(
  action: Api.TypeMessageAction,
  actorId: string | null,
): { kind: TgServiceKind; targetIds: string[]; title: string | null } | null {
  const plain = (kind: TgServiceKind) => ({ kind, targetIds: [], title: null });

  if (action instanceof Api.MessageActionChatAddUser) {
    const ids = action.users.map((u) => `u${u.toString()}`);
    // Joining by username or link is reported as the user adding themselves
    const selfJoin = ids.length === 1 && ids[0] === actorId;
    return selfJoin
      ? plain("join")
      : { kind: "added", targetIds: ids, title: null };
  }
  if (action instanceof Api.MessageActionChatJoinedByLink) return plain("join");
  if (action instanceof Api.MessageActionChatJoinedByRequest)
    return plain("joinByRequest");
  if (action instanceof Api.MessageActionChatDeleteUser) {
    const id = `u${action.userId.toString()}`;
    return id === actorId
      ? plain("left")
      : { kind: "removed", targetIds: [id], title: null };
  }
  if (action instanceof Api.MessageActionPinMessage) return plain("pinned");
  if (action instanceof Api.MessageActionChatEditTitle)
    return { kind: "titleChanged", targetIds: [], title: action.title };
  if (
    action instanceof Api.MessageActionChatEditPhoto ||
    action instanceof Api.MessageActionChatDeletePhoto
  )
    return plain("photoChanged");
  if (
    action instanceof Api.MessageActionChatCreate ||
    action instanceof Api.MessageActionChannelCreate
  )
    return plain("created");
  return null;
}

/**
 * Display names for peers a service message names. GramJS keeps the users from the history
 * response in its own store, so this normally costs no round-trip; loadDialogs is skipped
 * deliberately, since one grey line is not worth refetching the dialog list for.
 */
async function resolveEntityNames(
  entry: LiveEntry,
  chatIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(chatIds)) {
    const cached = entry.entityCache.get(id);
    if (cached) {
      names.set(id, entityName(cached));
      continue;
    }
    const peer = chatIdToPeer(id);
    if (!peer) continue;
    try {
      const entity = (await entry.client.getEntity(peer)) as
        Api.User | Api.Chat | Api.Channel;
      if (entity) {
        entry.entityCache.set(id, entity);
        names.set(id, entityName(entity));
      }
    } catch {
      // Unresolvable peer -- the UI words the line without a name
    }
  }
  return names;
}

/** Builds the service payload for each service message on a page, keyed by message id. */
async function serviceInfoForPage(
  entry: LiveEntry,
  msgs: Api.MessageService[],
): Promise<Map<number, TgServiceInfo>> {
  const result = new Map<number, TgServiceInfo>();
  if (!msgs.length) return result;

  const described = msgs.map((msg) => {
    const actorId = msg.fromId ? peerToChatId(msg.fromId) : null;
    return { msg, actorId, info: describeServiceAction(msg.action, actorId) };
  });

  const names = await resolveEntityNames(
    entry,
    described.flatMap((d) =>
      d.info ? [...(d.actorId ? [d.actorId] : []), ...d.info.targetIds] : [],
    ),
  );

  for (const { msg, actorId, info } of described) {
    if (!info) continue;
    result.set(msg.id, {
      kind: info.kind,
      actorId,
      actorName: actorId ? (names.get(actorId) ?? null) : null,
      targets: info.targetIds.map((id) => ({
        chatId: id,
        name: names.get(id) ?? null,
      })),
      title: info.title,
    });
  }
  return result;
}

/** An empty payload carrying only a service line -- no text, media, or reply of its own. */
function serviceMsgPayload(
  msg: Api.MessageService,
  service: TgServiceInfo,
): TgMsgPayload {
  return {
    id: msg.id,
    text: "",
    html: null,
    date: msg.date,
    fromMe: Boolean(msg.out),
    isRead: true,
    fromId: service.actorId,
    fromName: service.actorName,
    hasPhoto: false,
    hasDocument: false,
    hasSticker: false,
    fileName: null,
    buttons: null,
    reactions: null,
    replyToId: null,
    replyToText: null,
    replyToName: null,
    replyCount: null,
    service,
  };
}

export async function getMessages(
  entry: LiveEntry,
  chatId: string,
  limit: number,
  offsetId: number,
  search?: string,
): Promise<TgMsgPayload[]> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found -- open the dialogs list first");

  // Service messages we have no wording for are dropped, so keep fetching until a full
  // page is collected. Returning a short page would make the frontend believe history is
  // exhausted and stop paginating.
  const msgs: (Api.Message | Api.MessageService)[] = [];
  let cursor = offsetId;
  for (let hop = 0; hop < 5 && msgs.length < limit; hop++) {
    const batch = await entry.client.getMessages(entity, {
      limit,
      ...(cursor ? { offsetId: cursor } : {}),
      ...(search ? { search } : {}),
    });
    if (!batch.length) break;
    // GramJS types the batch as Api.Message[], but service messages come back in it too
    for (const m of batch as unknown as (Api.Message | Api.MessageService)[]) {
      if (msgs.length >= limit) break;
      if (m instanceof Api.Message) msgs.push(m);
      else if (
        m instanceof Api.MessageService &&
        describeServiceAction(
          m.action,
          m.fromId ? peerToChatId(m.fromId) : null,
        )
      )
        msgs.push(m);
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < limit) break; // genuine end of history
  }

  const serviceInfo = await serviceInfoForPage(
    entry,
    msgs.filter(
      (m): m is Api.MessageService => m instanceof Api.MessageService,
    ),
  );

  // Batch-fetch reply-to message texts for quote display
  const replyIdSet = new Set<number>();
  for (const msg of msgs) {
    const target = replyTargetId(msg);
    if (target) replyIdSet.add(target);
  }
  const replyMap = new Map<
    number,
    {
      text: string;
      name: string | null;
      media: TgMediaKind | null;
      fileName: string | null;
    }
  >();
  if (replyIdSet.size > 0) {
    try {
      const replyMsgs = await entry.client.getMessages(entity, {
        ids: [...replyIdSet],
      });
      // Quote senders are often not in the entity cache, and a quote naming nobody is
      // most of what makes a reply hard to place
      const names = await resolveEntityNames(
        entry,
        replyMsgs
          .filter((rm) => rm?.fromId)
          .map((rm) => peerToChatId(rm.fromId as Api.TypePeer)),
      );
      for (const rm of replyMsgs) {
        if (!rm?.id) continue;
        const rfid = rm.fromId ? peerToChatId(rm.fromId as Api.TypePeer) : null;
        replyMap.set(rm.id, {
          text: displayText(rm),
          // No sender means it was posted as the group itself
          name: rfid ? (names.get(rfid) ?? null) : entityName(entity),
          media: mediaKind(rm.media),
          fileName: docFileName(rm.media),
        });
      }
    } catch {
      // Best effort -- reply quotes may be missing
    }
  }

  const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
  const payloads = msgs.map((msg): TgMsgPayload | null => {
    if (msg instanceof Api.MessageService) {
      const service = serviceInfo.get(msg.id);
      return service ? serviceMsgPayload(msg, service) : null;
    }

    let fromName: string | null = null;
    if (msg.fromId) {
      const fid = peerToChatId(msg.fromId as Api.TypePeer);
      const sender = entry.entityCache.get(fid);
      if (sender) fromName = entityName(sender);
    }
    const replyToId = replyTargetId(msg);
    return buildMsgPayload(msg, {
      fromName,
      readMaxId,
      replyToId,
      quote: replyToId ? replyMap.get(replyToId) : null,
    });
  });

  return payloads.filter((p): p is TgMsgPayload => p !== null);
}

export async function getPinnedMessage(
  entry: LiveEntry,
  chatId: string,
): Promise<TgMsgPayload | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  let pinnedMsgId: number | null = null;

  if (entity instanceof Api.Channel) {
    const result = await entry.client.invoke(
      new Api.channels.GetFullChannel({ channel: entity as any }),
    );
    pinnedMsgId = (result.fullChat as any).pinnedMsgId ?? null;
  } else if (entity instanceof Api.Chat) {
    const result = await entry.client.invoke(
      new Api.messages.GetFullChat({ chatId: (entity as Api.Chat).id as any }),
    );
    pinnedMsgId = (result.fullChat as any).pinnedMsgId ?? null;
  }

  if (!pinnedMsgId) return null;

  const msgs = await entry.client.getMessages(entity, { ids: [pinnedMsgId] });
  if (!msgs.length || !msgs[0]) return null;

  const msg = msgs[0] as Api.Message;
  const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
  return {
    id: msg.id,
    text: displayText(msg),
    html: entitiesToHtml(msg.message ?? "", (msg as Api.Message).entities),
    date: msg.date,
    fromMe: Boolean(msg.out),
    isRead: Boolean(msg.out) && msg.id <= readMaxId,
    fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
    fromName: null,
    hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
    hasDocument:
      msg.media instanceof Api.MessageMediaDocument && !isStickerDoc(msg.media),
    hasSticker: isStickerDoc(msg.media),
    fileName: docFileName(msg.media),
    buttons: extractButtons(msg),
    reactions: null,
    replyToId: null,
    replyToText: null,
    replyToName: null,
    replyCount: null,
    poll: extractPoll(msg.media),
  };
}

/**
 * A mention of a group member who has no username. Telegram only carries these as an
 * entity, so the client sends the span it wrote into the text alongside the member.
 * Offsets are UTF-16 code units, which is what a JS string index already is.
 */
export type TgNameMention = { offset: number; length: number; chatId: string };

async function nameMentionEntities(
  entry: LiveEntry,
  mentions?: TgNameMention[],
): Promise<Api.TypeMessageEntity[] | undefined> {
  if (!mentions?.length) return undefined;
  const entities: Api.TypeMessageEntity[] = [];
  for (const mention of mentions) {
    await ensureEntityCached(entry, mention.chatId);
    const user = entry.entityCache.get(mention.chatId);
    if (!(user instanceof Api.User)) continue; // unresolvable -- send it as plain text
    entities.push(
      new Api.InputMessageEntityMentionName({
        offset: mention.offset,
        length: mention.length,
        userId: getInputUser(user),
      }),
    );
  }
  return entities.length ? entities : undefined;
}

export async function sendMessage(
  entry: LiveEntry,
  chatId: string,
  text: string,
  replyToMsgId?: number,
  mentions?: TgNameMention[],
): Promise<{ id: number; date: number }> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  const formattingEntities = await nameMentionEntities(entry, mentions);
  const result = await entry.client.sendMessage(entity, {
    message: text,
    parseMode: false, // disable markdown so characters like __ are sent verbatim
    ...(formattingEntities ? { formattingEntities } : {}),
    ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
  });
  return { id: result.id, date: result.date };
}

/**
 * Digits only, no leading +, which is how Telegram stores and compares numbers.
 * Returns null when the input isn't plausibly a phone number.
 */
export function normalisePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  return /^\d{5,20}$/.test(digits) ? digits : null;
}

/**
 * Answers a reply-keyboard "share phone number" button by sending a contact card,
 * which is what the official clients do. Bots only accept a number this way -- a
 * typed-out phone number is just text to them.
 *
 * `phoneNumber` overrides the account's own number. Telegram accepts any number
 * here, but it resolves the card's `userId` server-side by looking the number up:
 * our own number stamps our own id, anything unregistered stamps 0. Bots that
 * verify with `contact.user_id == from.id` therefore reject an override.
 */
export async function sharePhoneNumber(
  entry: LiveEntry,
  chatId: string,
  replyToMsgId?: number,
  phoneNumber?: string,
): Promise<{ id: number; date: number; text: string }> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  let phone: string;
  const me = (await entry.client.getMe()) as Api.User;
  if (phoneNumber) {
    const normalised = normalisePhoneNumber(phoneNumber);
    if (!normalised) throw new Error("Not a valid phone number");
    phone = normalised;
  } else {
    if (!me?.phone)
      throw new Error("This account has no phone number to share");
    phone = me.phone;
  }

  const updates = await entry.client.invoke(
    new Api.messages.SendMedia({
      peer: entity as any,
      media: new Api.InputMediaContact({
        phoneNumber: phone,
        firstName: me.firstName ?? "",
        lastName: me.lastName ?? "",
        vcard: "",
      }),
      message: "",
      randomId: generateRandomBigInt() as any,
      ...(replyToMsgId
        ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId }) }
        : {}),
    }),
  );

  const sent = sentMessageFromUpdates(updates);
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
  return { ...sent, text: [name, `+${phone}`].filter(Boolean).join(" ") };
}

/** Pulls the id/date of the message we just sent out of the Updates response. */
function sentMessageFromUpdates(updates: Api.TypeUpdates): {
  id: number;
  date: number;
} {
  const list: any[] = (updates as any).updates ?? [];
  for (const u of list) {
    const m = u?.message;
    if (
      (u instanceof Api.UpdateNewMessage ||
        u instanceof Api.UpdateNewChannelMessage) &&
      m instanceof Api.Message
    ) {
      return { id: m.id, date: m.date };
    }
  }
  const idUpdate = list.find((u) => u instanceof Api.UpdateMessageID);
  return {
    id: idUpdate?.id ?? 0,
    date: (updates as any).date ?? Math.floor(Date.now() / 1000),
  };
}

export async function sendFile(
  entry: LiveEntry,
  chatId: string,
  opts: {
    buffer: Buffer;
    filename: string;
    caption?: string;
    forceDocument?: boolean;
    replyToMsgId?: number;
  },
): Promise<{
  id: number;
  date: number;
  hasPhoto: boolean;
  hasDocument: boolean;
}> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  const toUpload = new CustomFile(
    opts.filename,
    opts.buffer.length,
    "",
    opts.buffer,
  );
  const result = await entry.client.sendFile(entity, {
    file: toUpload,
    caption: opts.caption,
    forceDocument: opts.forceDocument,
    ...(opts.replyToMsgId ? { replyTo: opts.replyToMsgId } : {}),
  });
  // Telegram sends images without forceDocument as photos, everything else as documents.
  const hasPhoto = result.photo != null;
  return {
    id: result.id,
    date: result.date,
    hasPhoto,
    hasDocument: !hasPhoto,
  };
}

export async function getContacts(entry: LiveEntry): Promise<TgContactItem[]> {
  const result = await entry.client.invoke(
    new Api.contacts.GetContacts({ hash: BigInt(0) as any }),
  );
  if (!("users" in result)) return [];

  return (result.users as Api.User[])
    .filter((u) => !u.deleted)
    .map((u) => {
      const chatId = entityToChatId(u);
      entry.entityCache.set(chatId, u);
      return {
        chatId,
        firstName: u.firstName ?? "",
        lastName: u.lastName ?? "",
        username: u.username ?? null,
        phone: u.phone ?? null,
      };
    });
}

export async function addContact(
  entry: LiveEntry,
  phone: string,
  firstName: string,
  lastName = "",
): Promise<TgContactItem | null> {
  const result = await entry.client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now() % 1_000_000) as any,
          phone,
          firstName,
          lastName,
        }),
      ],
    }),
  );

  const user = (result.users as Api.User[])[0];
  if (!user) return null;

  const chatId = entityToChatId(user);
  entry.entityCache.set(chatId, user);
  return {
    chatId,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    username: user.username ?? null,
    phone: user.phone ?? null,
  };
}

export async function editContact(
  entry: LiveEntry,
  chatId: string,
  firstName: string,
  lastName = "",
): Promise<TgContactItem | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!(entity instanceof Api.User)) return null;

  // ImportContacts updates an existing contact when the user is already known
  const result = await entry.client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now() % 1_000_000) as any,
          phone: (entity as any).phone ?? "",
          firstName,
          lastName,
        }),
      ],
    }),
  );

  const updated = ((result as any).users as Api.User[])[0] ?? entity;
  entry.entityCache.set(chatId, updated);
  return {
    chatId,
    firstName: (updated as any).firstName ?? "",
    lastName: (updated as any).lastName ?? "",
    username: (updated as any).username ?? null,
    phone: (updated as any).phone ?? null,
  };
}

// Full dialog list for name matching. Telegram's contacts.Search only matches
// username substrings reliably (titles, especially CJK ones, are often missed),
// so own chats must be matched locally the way official clients do. Cached for
// 60s per account to keep per-keystroke searches off the network.
const DIALOG_SEARCH_CACHE_MS = 60_000;
const DIALOG_SEARCH_LIMIT = 1000;

async function searchableDialogs(entry: LiveEntry): Promise<TgDialogItem[]> {
  const cached = entry.dialogSearchCache;
  if (cached && Date.now() - cached.ts < DIALOG_SEARCH_CACHE_MS) {
    return cached.items;
  }
  const items = await loadDialogs(entry, DIALOG_SEARCH_LIMIT);
  entry.dialogSearchCache = { ts: Date.now(), items };
  return items;
}

function entityToDialogItem(
  entity: Api.User | Api.Chat | Api.Channel,
): TgDialogItem {
  if (entity instanceof Api.User) {
    return {
      chatId: entityToChatId(entity),
      name: entityName(entity),
      type: entity.bot ? "bot" : "user",
      username: entity.username ?? null,
      unreadCount: 0,
      lastMessage: null,
    };
  }
  return {
    chatId: entityToChatId(entity),
    name: entityName(entity),
    type:
      entity instanceof Api.Channel
        ? entity.megagroup
          ? "group"
          : "channel"
        : "group",
    username: (entity as any).username ?? null,
    unreadCount: 0,
    lastMessage: null,
    left: entity instanceof Api.Channel ? Boolean(entity.left) : false,
  };
}

export async function searchPeers(
  entry: LiveEntry,
  query: string,
): Promise<TgDialogItem[]> {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const dialogMatches: TgDialogItem[] = [];
  const titleMatches: TgDialogItem[] = [];
  const globalMatches: TgDialogItem[] = [];
  const messageMatches: TgDialogItem[] = [];

  // The server matches strictly, so a query with extra trailing tokens (e.g.
  // "... v3") can return nothing while a shorter prefix matches -- retry with
  // trailing words dropped when a search comes back empty.
  const words = query.split(/\s+/).filter(Boolean);
  const attempts = [query];
  for (let n = words.length - 1; n >= 1 && attempts.length < 3; n--) {
    const sub = words.slice(0, n).join(" ");
    if (sub && sub !== query) attempts.push(sub);
  }

  // 1. Own chats by title/username substring across the full dialog list --
  // covers private groups and CJK titles the server-side search cannot find
  try {
    for (const d of await searchableDialogs(entry)) {
      if (
        d.name.toLowerCase().includes(q) ||
        d.username?.toLowerCase().includes(q)
      ) {
        if (!seen.has(d.chatId)) {
          seen.add(d.chatId);
          dialogMatches.push(d);
        }
      }
    }
  } catch {
    // Dialog fetch failed (e.g. flood wait) -- server searches below still run
  }

  // 2. Global message search -- the server also matches chats by TITLE here,
  // which is how official clients find member chats that are no longer in the
  // dialog list (e.g. removed/archived) and have no username
  for (const attempt of attempts) {
    let result: Api.messages.TypeMessages;
    try {
      result = await entry.client.invoke(
        new Api.messages.SearchGlobal({
          q: attempt,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit: 20,
        }),
      );
    } catch {
      continue;
    }

    const msgs = ((result as any).messages ?? []) as Api.TypeMessage[];
    const entities = new Map<string, Api.User | Api.Chat | Api.Channel>();
    for (const c of ((result as any).chats ?? []) as (
      Api.Chat | Api.Channel
    )[]) {
      entities.set(entityToChatId(c), c);
    }
    for (const u of ((result as any).users ?? []) as Api.User[]) {
      entities.set(entityToChatId(u), u);
    }

    // The server title-matches chats and returns them in the entity list even
    // when none of the matched messages belong to them (e.g. a group the user
    // left) -- surface those first, they are what the user is looking for
    const attemptLc = attempt.toLowerCase();
    for (const [chatId, ent] of entities) {
      if (seen.has(chatId) || ent instanceof Api.User) continue;
      if ((ent as any).deactivated || (ent as any).forbidden) continue;
      const item = entityToDialogItem(ent);
      const name = item.name.toLowerCase();
      if (name.includes(q) || name.includes(attemptLc)) {
        seen.add(chatId);
        entry.entityCache.set(chatId, ent);
        titleMatches.push(item);
      }
    }

    for (const m of msgs) {
      if (!(m instanceof Api.Message) || !m.peerId) continue;
      const chatId = peerToChatId(m.peerId);
      if (seen.has(chatId)) continue;
      const ent = entities.get(chatId);
      if (!ent) continue;
      if ((ent as any).deactivated || (ent as any).forbidden) continue;
      seen.add(chatId);
      entry.entityCache.set(chatId, ent);
      const item = entityToDialogItem(ent);
      item.lastMessage = {
        text: m.message ?? "",
        date: m.date,
        fromMe: Boolean(m.out),
      };
      // A mere mention in some message text ranks last
      messageMatches.push(item);
    }

    if (msgs.length > 0 || titleMatches.length > 0) break;
  }

  // 3. Global search for public chats/users by username
  for (const attempt of attempts) {
    let result: Api.contacts.TypeFound;
    try {
      result = await entry.client.invoke(
        new Api.contacts.Search({ q: attempt, limit: 20 }),
      );
    } catch {
      continue; // e.g. QUERY_TOO_SHORT on a shortened attempt
    }

    let found = false;

    for (const u of result.users as Api.User[]) {
      if (u.deleted) continue;
      found = true;
      const chatId = entityToChatId(u);
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      entry.entityCache.set(chatId, u);
      globalMatches.push(entityToDialogItem(u));
    }

    for (const c of result.chats as (Api.Chat | Api.Channel)[]) {
      if ((c as any).deactivated || (c as any).forbidden) continue;
      found = true;
      const chatId = entityToChatId(c as Api.Chat | Api.Channel);
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      entry.entityCache.set(chatId, c as Api.Chat | Api.Channel);
      globalMatches.push(entityToDialogItem(c as Api.Chat | Api.Channel));
    }

    if (found) break;
  }

  return [
    ...dialogMatches,
    ...titleMatches,
    ...globalMatches,
    ...messageMatches,
  ];
}

export async function fetchPhoto(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
): Promise<{ buf: Buffer; mimeType: string } | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) return null;

  const [msg] = await entry.client.getMessages(entity, { ids: [msgId] });
  if (!msg?.media) return null;

  let mimeType = "image/jpeg";
  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = (msg.media as Api.MessageMediaDocument).document;
    if (doc instanceof Api.Document) {
      if (doc.mimeType) mimeType = doc.mimeType;
      const size = Number(doc.size ?? 0);
      if (size > MEDIA_MAX_BYTES) {
        console.warn(
          `[tg] Refusing ${(size / 1048576).toFixed(0)}MB media in ${chatId}: over the ${(MEDIA_MAX_BYTES / 1048576).toFixed(0)}MB inline limit (TG_MEDIA_MAX_MB)`,
        );
        return null;
      }
    }
  }

  const data = await entry.client.downloadMedia(msg, {});
  if (!data) return null;
  let buf: Buffer;
  if (Buffer.isBuffer(data)) buf = data;
  else if (typeof data === "string") buf = Buffer.from(data, "binary");
  else buf = Buffer.from(data as Uint8Array);
  return { buf, mimeType };
}

export async function fetchAvatar(
  entry: LiveEntry,
  chatId: string,
): Promise<Buffer | null> {
  if (entry.avatarCache.has(chatId)) return entry.avatarCache.get(chatId)!;
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) {
    entry.avatarCache.set(chatId, null);
    return null;
  }
  try {
    // isBig must be provided -- GramJS throws TypeError if fileParams is undefined
    const data = await entry.client.downloadProfilePhoto(
      entity as any,
      { isBig: false } as any,
    );
    if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
      entry.avatarCache.set(chatId, null);
      return null;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as unknown as Uint8Array);
    entry.avatarCache.set(chatId, buf);
    return buf;
  } catch {
    entry.avatarCache.set(chatId, null);
    return null;
  }
}

// Fetch multiple avatars with bounded concurrency (10 at a time).
// Returns a map of chatId -> base64 jpeg string for chats that have an avatar.
export async function fetchAvatarsBatch(
  entry: LiveEntry,
  chatIds: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < chatIds.length; i += CONCURRENCY) {
    await Promise.all(
      chatIds.slice(i, i + CONCURRENCY).map(async (chatId) => {
        const buf = await fetchAvatar(entry, chatId);
        if (buf) result[chatId] = buf.toString("base64");
      }),
    );
  }
  return result;
}

export type TgProfileInfo = {
  chatId: string;
  /** The ID as Telegram clients and bots show it, which is what a job's chat field takes. */
  peerId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  phone: string | null;
  bio: string | null;
  memberCount: number | null;
  firstName: string | null;
  lastName: string | null;
  blocked: boolean | null;
};

export async function getEntityDetails(
  entry: LiveEntry,
  chatId: string,
): Promise<TgProfileInfo> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  const type: TgProfileInfo["type"] =
    entity instanceof Api.User
      ? (entity as any).bot
        ? "bot"
        : "user"
      : entity instanceof Api.Channel
        ? (entity as any).megagroup
          ? "group"
          : "channel"
        : "group";

  let bio: string | null = null;
  let memberCount: number | null = null;
  let blocked: boolean | null = null;

  try {
    if (entity instanceof Api.User) {
      const full = await entry.client.invoke(
        new Api.users.GetFullUser({ id: entity as any }),
      );
      bio = (full as any).fullUser?.about ?? null;
      blocked = Boolean((full as any).fullUser?.blocked);
    } else if (entity instanceof Api.Channel) {
      const full = await entry.client.invoke(
        new Api.channels.GetFullChannel({ channel: entity as any }),
      );
      bio = (full as any).fullChat?.about ?? null;
      memberCount = (full as any).fullChat?.participantsCount ?? null;
    } else {
      const full = await entry.client.invoke(
        new Api.messages.GetFullChat({ chatId: (entity as any).id as any }),
      );
      bio = (full as any).fullChat?.about ?? null;
      memberCount =
        (full as any).fullChat?.participants?.participants?.length ?? null;
    }
  } catch {
    // Full details unavailable -- basic info from entity cache is still returned
  }

  const isUser = entity instanceof Api.User;
  return {
    chatId,
    peerId: displayPeerId(chatId),
    name: entityName(entity),
    type,
    username: (entity as any).username ?? null,
    phone: (entity as any).phone ?? null,
    bio,
    memberCount,
    firstName: isUser ? ((entity as Api.User).firstName ?? null) : null,
    lastName: isUser ? ((entity as Api.User).lastName ?? null) : null,
    blocked,
  };
}

/**
 * Where a direct message to this channel goes: the hidden supergroup Telegram routes it to,
 * cached in the entity cache under its own chatId so sending, history and read receipts all
 * work through the ordinary chat calls. Null when the channel's owner has direct messages off.
 */
export async function getChannelDm(
  entry: LiveEntry,
  chatId: string,
): Promise<TgDialogItem | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!(entity instanceof Api.Channel) || entity.megagroup) return null;

  let target = entry.channelDmCache.get(chatId);
  if (target === undefined) {
    target = await resolveChannelDm(entry.client, entity).catch(() => null);
    entry.channelDmCache.set(chatId, target);
  }
  if (!target) return null;

  rememberChannelDm(entry.accountId, target);
  entry.entityCache.set(target.chatId, monoforumEntity(target));
  return {
    chatId: target.chatId,
    name: target.title,
    type: "channel",
    username: null,
    unreadCount: 0,
    lastMessage: null,
    left: false,
    dm: true,
  };
}

export type TgMemberInfo = {
  chatId: string;
  /** The ID as Telegram shows it, which is what a job's contact field takes. */
  peerId: string;
  name: string;
  username: string | null;
  isBot: boolean;
  status: "creator" | "admin" | "member";
};

/**
 * Participants of a group. `search` is Telegram's own filter, which only matches from the
 * start of a name or username -- the UI fuzzy-matches on top of what comes back.
 * Members are added to the entity cache, so their avatars and sender names resolve
 * without another round-trip.
 */
export async function getChatMembers(
  entry: LiveEntry,
  chatId: string,
  limit: number,
  offset: number,
  search?: string,
): Promise<{ members: TgMemberInfo[]; total: number }> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found -- open the dialogs list first");
  if (entity instanceof Api.User)
    throw new Error("Only groups and channels have members");

  const users = await entry.client.getParticipants(entity as any, {
    limit,
    offset,
    search: search || "",
  });

  const members = users.map((user) => {
    const memberChatId = `u${user.id.toString()}`;
    entry.entityCache.set(memberChatId, user);
    const participant = (user as any).participant;
    const status: TgMemberInfo["status"] =
      participant instanceof Api.ChannelParticipantCreator ||
      participant instanceof Api.ChatParticipantCreator
        ? "creator"
        : participant instanceof Api.ChannelParticipantAdmin ||
            participant instanceof Api.ChatParticipantAdmin
          ? "admin"
          : "member";
    return {
      chatId: memberChatId,
      peerId: displayPeerId(memberChatId),
      name: entityName(user),
      username: user.username ?? null,
      isBot: Boolean(user.bot),
      status,
    };
  });

  return { members, total: users.total ?? members.length };
}

// Block or unblock a user (contacts.Block / contacts.Unblock)
export async function setBlocked(
  entry: LiveEntry,
  chatId: string,
  blocked: boolean,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!(entity instanceof Api.User))
    throw new Error("Only users and bots can be blocked");
  if (blocked) {
    await entry.client.invoke(new Api.contacts.Block({ id: entity as any }));
  } else {
    await entry.client.invoke(new Api.contacts.Unblock({ id: entity as any }));
  }
}

export type TgReportReason =
  | "spam"
  | "violence"
  | "pornography"
  | "childAbuse"
  | "illegalDrugs"
  | "personalDetails"
  | "fake"
  | "copyright"
  | "other";

const REPORT_REASON_MAP: Record<TgReportReason, () => Api.TypeReportReason> = {
  spam: () => new Api.InputReportReasonSpam(),
  violence: () => new Api.InputReportReasonViolence(),
  pornography: () => new Api.InputReportReasonPornography(),
  childAbuse: () => new Api.InputReportReasonChildAbuse(),
  illegalDrugs: () => new Api.InputReportReasonIllegalDrugs(),
  personalDetails: () => new Api.InputReportReasonPersonalDetails(),
  fake: () => new Api.InputReportReasonFake(),
  copyright: () => new Api.InputReportReasonCopyright(),
  other: () => new Api.InputReportReasonOther(),
};

// Report a user, group or channel to Telegram
export async function reportPeer(
  entry: LiveEntry,
  chatId: string,
  reason: TgReportReason,
  comment = "",
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  const makeReason = REPORT_REASON_MAP[reason];
  if (!makeReason) throw new Error("Unknown report reason");
  await entry.client.invoke(
    new Api.account.ReportPeer({
      peer: entity as any,
      reason: makeReason(),
      message: comment,
    }),
  );
}

// Delete chat history. revoke=true also removes it for the other side
// (private chats only). Channels/supergroups clear the local copy only.
export async function deleteHistory(
  entry: LiveEntry,
  chatId: string,
  revoke: boolean,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (entity instanceof Api.Channel) {
    await entry.client.invoke(
      new Api.channels.DeleteHistory({ channel: entity as any, maxId: 0 }),
    );
  } else {
    await entry.client.invoke(
      new Api.messages.DeleteHistory({
        peer: entity as any,
        maxId: 0,
        revoke,
      }),
    );
  }
}

// Delete specific messages. revoke=true deletes for everyone
// (channel/supergroup deletes are always for everyone).
export async function deleteMessages(
  entry: LiveEntry,
  chatId: string,
  ids: number[],
  revoke: boolean,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (entity instanceof Api.Channel) {
    await entry.client.invoke(
      new Api.channels.DeleteMessages({ channel: entity as any, id: ids }),
    );
  } else {
    await entry.client.invoke(
      new Api.messages.DeleteMessages({ id: ids, revoke }),
    );
  }
}

// Edit the text of an own message
export async function editMessage(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  text: string,
  mentions?: TgNameMention[],
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  const entities = await nameMentionEntities(entry, mentions);
  await entry.client.invoke(
    new Api.messages.EditMessage({
      peer: entity as any,
      id: msgId,
      message: text,
      ...(entities ? { entities } : {}),
    }),
  );
}

// Broadcast that this account is typing in a chat (auto-expires after ~6s)
export async function sendTyping(
  entry: LiveEntry,
  chatId: string,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  await entry.client.invoke(
    new Api.messages.SetTyping({
      peer: entity as any,
      action: new Api.SendMessageTypingAction(),
    }),
  );
}

// Forward messages to another chat
export async function forwardMessages(
  entry: LiveEntry,
  fromChatId: string,
  toChatId: string,
  ids: number[],
): Promise<void> {
  await ensureEntityCached(entry, fromChatId);
  await ensureEntityCached(entry, toChatId);
  const fromEntity = entry.entityCache.get(fromChatId);
  const toEntity = entry.entityCache.get(toChatId);
  if (!fromEntity || !toEntity) throw new Error("Chat not found");
  await entry.client.forwardMessages(toEntity, {
    messages: ids,
    fromPeer: fromEntity,
  });
}

export type TgFolderItem = {
  id: number;
  title: string;
  emoticon: string | null;
  includeGroups: boolean;
  includeBroadcasts: boolean;
  includeBots: boolean;
  includeContacts: boolean;
  includeNonContacts: boolean;
  pinnedChatIds: string[];
  includedChatIds: string[];
  excludedChatIds: string[];
};

// Convert an InputPeer (from DialogFilter peer lists) to chatId format
function inputPeerToChatId(peer: any): string {
  if (!peer) return "";
  if (peer.userId !== undefined) return `u${peer.userId}`;
  if (peer.channelId !== undefined) return `c${peer.channelId}`;
  if (peer.chatId !== undefined) return `g${peer.chatId}`;
  return "";
}

// Mute a dialog -- pass muteSecs=0 to unmute
export async function muteDialog(
  entry: LiveEntry,
  chatId: string,
  muteSecs: number,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  let peer: any;
  if (entity instanceof Api.User) {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerUser({
        userId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else if (entity instanceof Api.Channel) {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerChannel({
        channelId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerChat({ chatId: (entity as any).id as any }),
    });
  }

  await entry.client.invoke(
    new Api.account.UpdateNotifySettings({
      peer,
      settings: new Api.InputPeerNotifySettings({
        muteUntil:
          muteSecs === 0 ? 0 : Math.floor(Date.now() / 1000) + muteSecs,
      }),
    }),
  );
}

// Pin or unpin a dialog in the user's dialog list
export async function pinDialog(
  entry: LiveEntry,
  chatId: string,
  pinned: boolean,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  let peer: any;
  if (entity instanceof Api.User) {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerUser({
        userId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else if (entity instanceof Api.Channel) {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerChannel({
        channelId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerChat({ chatId: (entity as any).id as any }),
    });
  }

  await entry.client.invoke(new Api.messages.ToggleDialogPin({ peer, pinned }));
}

export async function getFolders(entry: LiveEntry): Promise<TgFolderItem[]> {
  try {
    const raw = await entry.client.invoke(new Api.messages.GetDialogFilters());
    // Older layers return a plain array; newer layers wrap in { filters: [...] }
    const filters: any[] = Array.isArray(raw)
      ? raw
      : ((raw as any)?.filters ?? []);

    return filters
      .filter((f: any) => f.id && f.title !== undefined)
      .map((f: any) => ({
        id: f.id as number,
        title:
          typeof f.title === "string" ? f.title : (f.title?.text ?? "Folder"),
        emoticon: (f.emoticon as string | undefined) ?? null,
        includeGroups: Boolean(f.groups),
        includeBroadcasts: Boolean(f.broadcasts),
        includeBots: Boolean(f.bots),
        includeContacts: Boolean(f.contacts),
        includeNonContacts: Boolean(f.nonContacts),
        pinnedChatIds: ((f.pinnedPeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
        includedChatIds: ((f.includePeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
        excludedChatIds: ((f.excludePeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
      }));
  } catch {
    return [];
  }
}

export async function addChatToFolder(
  entry: LiveEntry,
  folderId: number,
  chatId: string,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  let inputPeer: any;
  if (entity instanceof Api.User) {
    inputPeer = new Api.InputPeerUser({
      userId: (entity as any).id,
      accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
    });
  } else if (entity instanceof Api.Channel) {
    inputPeer = new Api.InputPeerChannel({
      channelId: (entity as any).id,
      accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
    });
  } else {
    inputPeer = new Api.InputPeerChat({ chatId: (entity as any).id as any });
  }

  const raw = await entry.client.invoke(new Api.messages.GetDialogFilters());
  const filters: any[] = Array.isArray(raw)
    ? raw
    : ((raw as any)?.filters ?? []);
  const filter = filters.find((f: any) => f.id === folderId);
  if (!filter) throw new Error("Folder not found");

  // Avoid duplicates
  const alreadyIncluded = ((filter.includePeers ?? []) as any[]).some(
    (p: any) => inputPeerToChatId(p) === chatId,
  );
  if (!alreadyIncluded) {
    filter.includePeers = [...(filter.includePeers ?? []), inputPeer];
    // Remove from excludedPeers if present
    filter.excludePeers = ((filter.excludePeers ?? []) as any[]).filter(
      (p: any) => inputPeerToChatId(p) !== chatId,
    );
  }

  await entry.client.invoke(
    new Api.messages.UpdateDialogFilter({ id: folderId, filter }),
  );
}

export type TgButtonResult = {
  alert: boolean;
  message: string | null;
  url: string | null;
};

export type TgInvitePreview = {
  hash: string;
  title: string;
  memberCount: number;
  type: "group" | "channel";
  alreadyJoined: boolean;
  chatId?: string;
};

export type TgBotCommand = {
  command: string;
  description: string;
};

export async function clickButton(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  data: string,
): Promise<TgButtonResult> {
  const { client } = entry;
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  const dataBytes = Buffer.from(data, "base64");
  if (process.env.DEBUG === "1") {
    console.log(
      `[button] chatId=${chatId} msgId=${msgId} data_hex=${dataBytes.toString("hex")}`,
    );
  }
  const result = await client.invoke(
    new Api.messages.GetBotCallbackAnswer({
      peer: entity as any,
      msgId,
      data: dataBytes,
      game: false,
    }),
  );
  if (process.env.DEBUG === "1") {
    const safeUrl = result.url
      ? result.url.replace(
          /([?&](?:token|hash|tgaddr)=)[^&]*/gi,
          "$1[REDACTED]",
        )
      : "null";
    console.log(
      `[button] alert=${result.alert} msg=${JSON.stringify(result.message)} url=${safeUrl}`,
    );
  }
  return {
    alert: result.alert ?? false,
    message: result.message ?? null,
    url: result.url ?? null,
  };
}

/**
 * Casts this account's vote in a poll and hands back the message as it now stands.
 * Telegram only reveals the tallies once you have voted, so the fresh payload is the
 * answer -- the UI has nothing useful to show until it arrives.
 */
export async function votePoll(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  options: string[],
): Promise<TgMsgPayload | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  await entry.client.invoke(
    new Api.messages.SendVote({
      peer: entity as any,
      msgId,
      options: options.map((o) => Buffer.from(o, "base64")),
    }),
  );
  const [fresh] = await entry.client.getMessages(entity, { ids: [msgId] });
  if (!fresh?.id) return null;
  const payload = await livePayload(entry, chatId, fresh as Api.Message);
  cacheMessages(entry.accountId, chatId, [payload]);
  emitEvent(entry, { type: "edited", chatId, message: payload });
  return payload;
}

export async function sendReaction(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  emoji: string | null,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  await entry.client.invoke(
    new Api.messages.SendReaction({
      peer: entity as any,
      msgId,
      reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
    }),
  );
}

export async function getThreadMessages(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  limit: number,
  offsetId: number,
): Promise<TgMsgPayload[]> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  const result = await entry.client.invoke(
    new Api.messages.GetReplies({
      peer: entity as any,
      msgId,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as any,
    }),
  );

  const msgs = ((result as any).messages ?? []) as Api.Message[];
  const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
  return msgs.map((msg) => {
    let fromName: string | null = null;
    if (msg.fromId) {
      const fid = peerToChatId(msg.fromId as Api.TypePeer);
      const sender = entry.entityCache.get(fid);
      if (sender) fromName = entityName(sender);
    }
    return {
      id: msg.id,
      text: displayText(msg),
      html: entitiesToHtml(msg.message ?? "", msg.entities),
      date: msg.date,
      fromMe: Boolean(msg.out),
      isRead: Boolean(msg.out) && msg.id <= readMaxId,
      fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
      fromName,
      hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
      hasDocument:
        msg.media instanceof Api.MessageMediaDocument &&
        !isStickerDoc(msg.media),
      hasSticker: isStickerDoc(msg.media),
      fileName: docFileName(msg.media),
      buttons: extractButtons(msg),
      reactions: extractReactions(msg),
      replyToId: null,
      replyToText: null,
      replyToName: null,
      replyCount: null,
      poll: extractPoll(msg.media),
    };
  });
}

/**
 * What a bot offers beside the composer: its command list, and its menu button.
 *
 * The menu button is the Mini App a bot pins next to the input ("Misaya Media" and the
 * like). It is a property of the bot rather than of any message, so it appears nowhere in
 * the chat history -- without asking for it here there is nothing to render.
 *
 * Both come from the one GetFullUser call, since asking twice on every chat open is a
 * round trip for nothing.
 */
export async function getBotInfo(
  entry: LiveEntry,
  chatId: string,
): Promise<{ commands: TgBotCommand[]; menuButton: TgBotMenuButton | null }> {
  const empty = { commands: [] as TgBotCommand[], menuButton: null };
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!(entity instanceof Api.User) || !entity.bot) return empty;
  try {
    const full = await entry.client.invoke(
      new Api.users.GetFullUser({ id: entity as any }),
    );
    const info = (full as any).fullUser?.botInfo;
    const commands: any[] = info?.commands ?? [];

    // Three shapes come back here: the default and "commands" variants only say which
    // menu the client should show, and carry no app. Only botMenuButton has one, which is
    // the text and address of a Mini App.
    const raw = info?.menuButton;
    const menuButton: TgBotMenuButton | null =
      raw && typeof raw.url === "string" && raw.url
        ? { text: String(raw.text ?? "").trim() || "Mini App", url: raw.url }
        : null;

    return {
      commands: commands.map((c: any) => ({
        command: c.command as string,
        description: c.description as string,
      })),
      menuButton,
    };
  } catch {
    return empty;
  }
}

export async function resolvePeer(
  entry: LiveEntry,
  username: string,
): Promise<TgDialogItem | null> {
  const query = username.startsWith("@") ? username : `@${username}`;
  try {
    const entity = await entry.client.getEntity(query);
    if (!entity) return null;
    let chatId: string;
    let type: TgDialogItem["type"];
    let name: string;
    let uname: string | null = null;
    if (entity instanceof Api.User) {
      chatId = `u${entity.id}`;
      type = entity.bot ? "bot" : "user";
      name =
        [entity.firstName, entity.lastName].filter(Boolean).join(" ") || query;
      uname = entity.username ?? null;
    } else if (entity instanceof Api.Channel) {
      chatId = `c${entity.id}`;
      type = entity.megagroup ? "group" : "channel";
      name = entity.title ?? query;
      uname = entity.username ?? null;
    } else if (entity instanceof Api.Chat) {
      chatId = `g${(entity as Api.Chat).id}`;
      type = "group";
      name = (entity as Api.Chat).title ?? query;
    } else {
      return null;
    }
    entry.entityCache.set(chatId, entity as Api.User | Api.Chat | Api.Channel);
    const left = entity instanceof Api.Channel ? Boolean(entity.left) : false;
    return {
      chatId,
      name,
      type,
      username: uname,
      unreadCount: 0,
      lastMessage: null,
      left,
    };
  } catch {
    return null;
  }
}

export type JoinResult = { joined: true } | { requestSent: true };

// Opens a bot chat and sends the startParam, mirroring a t.me/bot?start=PARAM deep link.
// Tries messages.StartBot first (correct for first-time activation); falls back to sending
// /start PARAM as a plain message when the bot is already active.
export async function startBot(
  entry: LiveEntry,
  username: string,
  startParam: string,
): Promise<TgDialogItem> {
  const query = username.startsWith("@") ? username : `@${username}`;
  const entity = await entry.client.getEntity(query);
  if (!(entity instanceof Api.User) || !entity.bot) {
    throw new Error("Not a bot");
  }
  const chatId = `u${entity.id}`;
  entry.entityCache.set(chatId, entity);

  try {
    await entry.client.invoke(
      new Api.messages.StartBot({
        bot: entity as any,
        peer: entity as any,
        randomId: BigInt(Date.now() % 1_000_000_000) as any,
        startParam,
      }),
    );
  } catch {
    // Bot already started -- send the command as a regular message instead
    await entry.client.sendMessage(entity, {
      message: `/start ${startParam}`,
      parseMode: false,
    });
  }

  const name =
    [entity.firstName, entity.lastName].filter(Boolean).join(" ") || username;
  return {
    chatId,
    name,
    type: "bot",
    username: entity.username ?? null,
    unreadCount: 0,
    lastMessage: null,
  };
}

// Mini app link parsing is shared with the job runner (tg/miniApp.ts); re-exported
// here so existing callers keep working.
export { parseMiniAppLink };

// Resolves a mini app URL to an authenticated web app URL.
// Handles two cases:
//   - t.me/BotName?startapp=HASH            -- uses RequestMainWebView
//   - t.me/BotName/AppShortName?startapp=HASH -- uses RequestAppWebView
//   - Direct web app URL from a KeyboardButtonWebView -- uses RequestSimpleWebView
export async function resolveWebApp(
  entry: LiveEntry,
  tmeOrUrl: string,
  botChatId?: string, // for direct URLs we need to know which bot owns the app
  peerChatId?: string, // chat where the webview button lives (for RequestWebView)
  fromBotMenu?: boolean, // the address came from the bot's menu button, not a message
): Promise<{ url: string; resolved: boolean }> {
  const miniApp = parseMiniAppLink(tmeOrUrl);
  if (miniApp) {
    const { botUsername, appShortName, startParam } = miniApp;
    const bot = (await entry.client.getEntity(botUsername)) as Api.User;
    entry.entityCache.set(entityToChatId(bot), bot);

    if (appShortName) {
      // Named mini app: use RequestAppWebView with InputBotAppShortName
      const inputUser = new Api.InputUser({
        userId: bot.id,
        accessHash: bot.accessHash!,
      });
      const result = (await entry.client.invoke(
        new Api.messages.RequestAppWebView({
          peer: bot,
          app: new Api.InputBotAppShortName({
            botId: inputUser,
            shortName: appShortName,
          }),
          startParam,
          platform: "web",
          writeAllowed: true,
        }),
      )) as any;
      return {
        url: withClientLaunchParams(result.url as string),
        resolved: true,
      };
    }

    const result = (await entry.client.invoke(
      new Api.messages.RequestMainWebView({
        peer: bot,
        bot,
        platform: "web",
        startParam,
      }),
    )) as any;
    return {
      url: withClientLaunchParams(result.url as string),
      resolved: true,
    };
  }

  // Direct web app URL with a known bot
  if (botChatId) {
    try {
      await ensureEntityCached(entry, botChatId);
      const bot = entry.entityCache.get(botChatId) as Api.User | undefined;
      if (bot instanceof Api.User) {
        // Inline webview buttons need RequestWebView; its URL carries the full
        // signed init data (query_id included) that mini apps expect
        let peer: any = bot;
        if (peerChatId && peerChatId !== botChatId) {
          await ensureEntityCached(entry, peerChatId);
          peer = entry.entityCache.get(peerChatId) ?? bot;
        }
        try {
          const result = (await entry.client.invoke(
            new Api.messages.RequestWebView({
              peer,
              bot,
              url: tmeOrUrl,
              platform: "web",
              // Telegram signs a menu button's app only when told that is where the
              // address came from. Asked without it, the request is taken for an
              // inline-keyboard webview and what comes back carries no account data at
              // all, so the app loads and immediately fails on "No initData found".
              ...(fromBotMenu ? { fromBotMenu: true } : {}),
            } as any),
          )) as any;
          return {
            url: withClientLaunchParams(result.url as string),
            resolved: true,
          };
        } catch {
          const result = (await entry.client.invoke(
            new Api.messages.RequestSimpleWebView({
              bot,
              url: tmeOrUrl,
              platform: "web",
            } as any),
          )) as any;
          return {
            url: withClientLaunchParams(result.url as string),
            resolved: true,
          };
        }
      }
    } catch {
      // Bot rejected the webview request; treat as unresolved
    }
  }

  // Could not obtain an authenticated web app URL -- caller decides the fallback
  return { url: tmeOrUrl, resolved: false };
}

// Re-fetches the channel from TG to get the latest membership state.
export async function checkMembership(
  entry: LiveEntry,
  chatId: string,
): Promise<boolean> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity || !(entity instanceof Api.Channel)) return false;
  try {
    const result = (await entry.client.invoke(
      new Api.channels.GetChannels({ id: [entity as Api.Channel] }),
    )) as Api.messages.Chats;
    const fresh = result.chats?.[0] as Api.Channel | undefined;
    if (fresh) {
      entry.entityCache.set(chatId, fresh);
      return !fresh.left;
    }
  } catch {}
  return false;
}

// Matches t.me/+HASH and t.me/joinchat/HASH invite links
const INVITE_HASH_RE = /t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]{5,})/g;

function extractInviteHashes(msgs: Api.TypeMessage[]): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (!(m instanceof Api.Message)) continue;
    // Links can sit in plain text, behind text entities, or on inline buttons
    const sources: string[] = [m.message ?? ""];
    for (const ent of (m.entities ?? []) as any[]) {
      if (typeof ent?.url === "string") sources.push(ent.url);
    }
    for (const row of ((m as any).replyMarkup?.rows ?? []) as any[]) {
      for (const btn of (row?.buttons ?? []) as any[]) {
        if (typeof btn?.url === "string") sources.push(btn.url);
      }
    }
    for (const src of sources) {
      for (const match of src.matchAll(INVITE_HASH_RE)) {
        if (!seen.has(match[1])) {
          seen.add(match[1]);
          hashes.push(match[1]);
        }
      }
    }
  }
  return hashes;
}

// True when a message visibly references the channel (forward header, reply,
// or being its peer) -- the references InputChannelFromMessage accepts
function referencesChannel(m: Api.Message, channelId: any): boolean {
  const id = channelId.toString();
  const refs = [
    (m.peerId as any)?.channelId,
    (m.fwdFrom?.fromId as any)?.channelId,
    ((m.fwdFrom as any)?.savedFromPeer as any)?.channelId,
    ((m.replyTo as any)?.replyToPeerId as any)?.channelId,
  ];
  return refs.some((r) => r != null && r.toString() === id);
}

// Private chats reject channels.JoinChannel on a min entity (as cached from
// search results). Recover the way official clients can: derive a full channel
// reference from a message that mentions it (no invite needed), or find invite
// links in messages that mention the chat's title, verify each candidate
// resolves to this chat, then join through the newest valid one.
async function joinPrivateChannel(
  entry: LiveEntry,
  entity: Api.Channel,
): Promise<JoinResult | null> {
  const title = entityName(entity);
  if (!title) return null;
  const targetChatId = entityToChatId(entity);

  let msgs: Api.TypeMessage[] = [];
  try {
    const result = await entry.client.invoke(
      new Api.messages.SearchGlobal({
        q: title,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit: 50,
      }),
    );
    msgs = ((result as any).messages ?? []) as Api.TypeMessage[];
  } catch {
    /* fall through with no messages */
  }

  // Strategy 1: join via a message reference -- works without any invite link
  let fromMsgAttempts = 0;
  for (const m of msgs) {
    if (fromMsgAttempts >= 5) break;
    if (!(m instanceof Api.Message) || !m.peerId) continue;
    if (!referencesChannel(m, entity.id)) continue;
    fromMsgAttempts++;
    try {
      const peer = await entry.client.getInputEntity(m.peerId);
      await entry.client.invoke(
        new Api.channels.JoinChannel({
          channel: new Api.InputChannelFromMessage({
            peer,
            msgId: m.id,
            channelId: entity.id,
          }),
        }),
      );
      (entity as any).left = false;
      return { joined: true };
    } catch (err: any) {
      if (err?.message?.includes("INVITE_REQUEST_SENT")) {
        return { requestSent: true };
      }
      if (err?.message?.includes("FLOOD")) throw err;
      continue;
    }
  }

  // Strategy 2: invite links found in the same messages
  const hashes = extractInviteHashes(msgs);

  // Cap the invite checks -- CheckChatInvite flood-limits aggressively
  for (const hash of hashes.slice(0, 6)) {
    let preview: TgInvitePreview;
    try {
      preview = await checkInvite(entry, hash);
    } catch (err: any) {
      if (err?.message?.includes("FLOOD")) throw err;
      continue; // expired or revoked link
    }

    if (preview.alreadyJoined) {
      if (preview.chatId === targetChatId) {
        (entity as any).left = false;
        return { joined: true };
      }
      continue;
    }
    // ChatInvite previews carry no chat id -- match on the exact title
    if (preview.title !== title) continue;

    try {
      await joinInvite(entry, hash);
      (entity as any).left = false;
      return { joined: true };
    } catch (err: any) {
      if (err?.message?.includes("INVITE_REQUEST_SENT")) {
        return { requestSent: true };
      }
      if (err?.message?.includes("USER_ALREADY_PARTICIPANT")) {
        (entity as any).left = false;
        return { joined: true };
      }
      if (err?.message?.includes("FLOOD")) throw err;
      continue;
    }
  }
  return null;
}

export async function joinChannel(
  entry: LiveEntry,
  chatId: string,
): Promise<JoinResult> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (!(entity instanceof Api.Channel))
    throw new Error("Only channels and supergroups can be joined this way");
  try {
    await entry.client.invoke(
      new Api.channels.JoinChannel({ channel: entity }),
    );
    (entity as any).left = false;
    return { joined: true };
  } catch (err: any) {
    // INVITE_REQUEST_SENT = group requires admin approval; request was submitted
    if (err?.message?.includes("INVITE_REQUEST_SENT")) {
      return { requestSent: true };
    }
    // Private chat -- recover via a message reference or a discovered invite
    if (err?.message?.includes("CHANNEL_PRIVATE")) {
      const recovered = await joinPrivateChannel(entry, entity);
      if (recovered) return recovered;
    }
    throw err;
  }
}

// Leave a group or channel. Branches on entity type: supergroups/channels use
// channels.LeaveChannel; legacy basic groups use messages.DeleteChatUser.
export async function leaveChat(
  entry: LiveEntry,
  chatId: string,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (entity instanceof Api.Channel) {
    await entry.client.invoke(
      new Api.channels.LeaveChannel({ channel: entity }),
    );
    (entity as any).left = true;
  } else if (entity instanceof Api.Chat) {
    await entry.client.invoke(
      new Api.messages.DeleteChatUser({
        chatId: (entity as any).id,
        userId: new Api.InputUserSelf(),
      }),
    );
  } else {
    throw new Error("Only groups and channels can be left");
  }
}

export async function markRead(
  entry: LiveEntry,
  chatId: string,
  maxId: number,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (chatId.startsWith("c")) {
    await entry.client.invoke(
      new Api.channels.ReadHistory({ channel: entity as any, maxId }),
    );
  } else {
    await entry.client.invoke(
      new Api.messages.ReadHistory({ peer: entity as any, maxId }),
    );
  }
}

export async function checkInvite(
  entry: LiveEntry,
  hash: string,
): Promise<TgInvitePreview> {
  const result = await entry.client.invoke(
    new Api.messages.CheckChatInvite({ hash }),
  );
  if (
    result instanceof Api.ChatInviteAlready ||
    result instanceof Api.ChatInvitePeek
  ) {
    const chat = result.chat as Api.Chat | Api.Channel;
    let chatId = "";
    let title = "";
    let memberCount = 0;
    let type: "group" | "channel" = "group";
    if (chat instanceof Api.Channel) {
      chatId = `c${chat.id}`;
      title = chat.title ?? "";
      memberCount = (chat as any).participantsCount ?? 0;
      type = chat.megagroup ? "group" : "channel";
      entry.entityCache.set(chatId, chat);
    } else if (chat instanceof Api.Chat) {
      chatId = `g${chat.id}`;
      title = chat.title ?? "";
      memberCount = (chat as any).participantsCount ?? 0;
      entry.entityCache.set(chatId, chat);
    }
    return {
      hash,
      title,
      memberCount,
      type,
      alreadyJoined: true,
      chatId: chatId || undefined,
    };
  }
  const invite = result as Api.ChatInvite;
  const type: "group" | "channel" =
    (invite as any).channel && !(invite as any).megagroup ? "channel" : "group";
  return {
    hash,
    title: (invite as any).title ?? "",
    memberCount: (invite as any).participantsCount ?? 0,
    type,
    alreadyJoined: false,
  };
}

export async function joinInvite(
  entry: LiveEntry,
  hash: string,
): Promise<TgDialogItem> {
  const updates = await entry.client.invoke(
    new Api.messages.ImportChatInvite({ hash }),
  );
  const chats = (updates as any).chats as (Api.Chat | Api.Channel)[];
  const chat = chats?.[0];
  if (!chat) throw new Error("Failed to join: no chat in response");
  let chatId: string;
  let name: string;
  let type: TgDialogItem["type"];
  let username: string | null = null;
  if (chat instanceof Api.Channel) {
    chatId = `c${chat.id}`;
    name = chat.title ?? "";
    type = chat.megagroup ? "group" : "channel";
    username = chat.username ?? null;
    entry.entityCache.set(chatId, chat);
  } else {
    chatId = `g${(chat as Api.Chat).id}`;
    name = (chat as Api.Chat).title ?? "";
    type = "group";
    entry.entityCache.set(chatId, chat as Api.Chat);
  }
  return { chatId, name, type, username, unreadCount: 0, lastMessage: null };
}

export function getReadOutboxMaxId(accountId: number, chatId: string): number {
  return liveClients.get(accountId)?.readOutboxCache.get(chatId) ?? 0;
}

export function subscribeToReadOutbox(
  accountId: number,
  handler: (chatId: string, maxId: number) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.readSubscribers.add(handler);
  return () => entry.readSubscribers.delete(handler);
}

export function subscribeToMessages(
  accountId: number,
  handler: (msg: TgLiveMessage) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.subscribers.add(handler);
  return () => entry.subscribers.delete(handler);
}

export function subscribeToDialogs(
  accountId: number,
  handler: (dialogs: TgDialogItem[]) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.dialogSubscribers.add(handler);
  return () => entry.dialogSubscribers.delete(handler);
}

export function subscribeToTyping(
  accountId: number,
  handler: (event: TgTypingEvent) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.typingSubscribers.add(handler);
  return () => entry.typingSubscribers.delete(handler);
}

/**
 * Changes to messages the client already has: edits, deletions, reactions, read marks and
 * pins. New messages keep their own channel; this is everything that patches what is
 * already on screen.
 */
export function subscribeToEvents(
  accountId: number,
  handler: (event: TgLiveEvent) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.eventSubscribers.add(handler);
  // Replay the current connection state so a fresh subscriber starts out knowing it
  handler({ type: "syncState", state: entry.syncState });
  return () => entry.eventSubscribers.delete(handler);
}

export function getSyncState(accountId: number): TgSyncState {
  return liveClients.get(accountId)?.syncState ?? "reconnecting";
}

// --- Message cache helpers ---

const MSG_CACHE_MAX = 500;

/**
 * Cached messages, newest first. `fromId` is an inclusive floor: callers serving a page
 * pass the known-complete range's bottom edge, so rows left below a gap -- by an older
 * build, or by a range that was replaced -- can never be mixed into a page as if they
 * were contiguous with it.
 */
export function getCachedMessages(
  accountId: number,
  chatId: string,
  limit: number,
  beforeId?: number,
  fromId?: number,
): TgMsgPayload[] {
  const params: (number | string)[] = [accountId, chatId];
  let sql =
    "SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ?";
  if (beforeId !== undefined) {
    sql += " AND msg_id < ?";
    params.push(beforeId);
  }
  if (fromId !== undefined) {
    sql += " AND msg_id >= ?";
    params.push(fromId);
  }
  sql += " ORDER BY msg_id DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as TgMsgPayload);
}

export function getCachedMessage(
  accountId: number,
  chatId: string,
  msgId: number,
): TgMsgPayload | null {
  const row = db
    .prepare(
      "SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id = ?",
    )
    .get(accountId, chatId, msgId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as TgMsgPayload) : null;
}

/**
 * Which chats the given message ids were cached in, so a peerless deletion update can be
 * turned into per-chat deletions. Ids are unique per account outside channels, so a hit is
 * unambiguous; ids we never cached simply do not appear.
 */
export function cachedChatsForMessages(
  accountId: number,
  ids: number[],
): Map<string, number[]> {
  const byChat = new Map<string, number[]>();
  if (!ids.length) return byChat;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT chat_id, msg_id FROM tg_message_cache
       WHERE account_id = ? AND msg_id IN (${placeholders})`,
    )
    .all(accountId, ...ids) as { chat_id: string; msg_id: number }[];
  for (const r of rows) {
    const list = byChat.get(r.chat_id);
    if (list) list.push(r.msg_id);
    else byChat.set(r.chat_id, [r.msg_id]);
  }
  return byChat;
}

/** Rewrites one cached payload in place. No-op when the message was never cached. */
export function patchCachedMessage(
  accountId: number,
  chatId: string,
  msgId: number,
  mutate: (payload: TgMsgPayload) => void,
): void {
  const payload = getCachedMessage(accountId, chatId, msgId);
  if (!payload) return;
  mutate(payload);
  db.prepare(
    "UPDATE tg_message_cache SET payload = ? WHERE account_id = ? AND chat_id = ? AND msg_id = ?",
  ).run(JSON.stringify(payload), accountId, chatId, msgId);
}

export function cacheMessages(
  accountId: number,
  chatId: string,
  msgs: TgMsgPayload[],
): void {
  if (!msgs.length) return;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO tg_message_cache (account_id, chat_id, msg_id, msg_date, payload) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const msg of msgs) {
      insert.run(accountId, chatId, msg.id, msg.date, JSON.stringify(msg));
    }
  })();
  // Trim to keep only the most recent MSG_CACHE_MAX per chat
  const trimmed = db
    .prepare(
      `DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id NOT IN (
        SELECT msg_id FROM tg_message_cache WHERE account_id = ? AND chat_id = ? ORDER BY msg_id DESC LIMIT ?
      )`,
    )
    .run(accountId, chatId, accountId, chatId, MSG_CACHE_MAX);
  if ((trimmed?.changes ?? 0) > 0) clampChatRange(accountId, chatId);
}

// --- What the cache actually holds ------------------------------------------------------
//
// tg_message_cache alone cannot say whether it holds a whole page or three stray rows, so
// a chat with three cached messages used to answer a fifty-message request with three.
// A range says "every message between min_id and max_id that still exists is here", which
// is what makes serving from cache safe.

export type TgChatRange = {
  minId: number;
  maxId: number;
  hasStart: boolean;
};

// The range and sync-state tables are created inside a swallowed try, matching the rest of
// database.ts. If either one is missing on some deployment, reading it must degrade to
// "nothing known" -- always refetch, never catch up -- rather than throwing through every
// messenger request. Same reason the writers below never propagate.
export function getChatRange(
  accountId: number,
  chatId: string,
): TgChatRange | null {
  try {
    const row = db
      .prepare(
        "SELECT min_id, max_id, has_start FROM tg_chat_sync WHERE account_id = ? AND chat_id = ?",
      )
      .get(accountId, chatId) as
      | { min_id: number; max_id: number; has_start: number }
      | undefined;
    if (!row) return null;
    return {
      minId: row.min_id,
      maxId: row.max_id,
      hasStart: row.has_start === 1,
    };
  } catch {
    return null;
  }
}

function writeChatRange(
  accountId: number,
  chatId: string,
  range: TgChatRange,
): void {
  try {
    db.prepare(
    `INSERT INTO tg_chat_sync (account_id, chat_id, min_id, max_id, has_start, reconciled_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, chat_id) DO UPDATE SET
       min_id = excluded.min_id, max_id = excluded.max_id,
       has_start = excluded.has_start, reconciled_at = excluded.reconciled_at`,
    ).run(
      accountId,
      chatId,
      range.minId,
      range.maxId,
      range.hasStart ? 1 : 0,
      Math.floor(Date.now() / 1000),
    );
  } catch {
    // Range unknown from here on, so pages come from Telegram
  }
}

/**
 * Folds a freshly fetched page into the known range. Pages that touch or overlap merge;
 * a page separated from the range by a gap replaces it, because claiming completeness
 * across a gap is exactly the bug this table exists to prevent.
 */
export function recordChatRange(
  accountId: number,
  chatId: string,
  page: TgChatRange,
): void {
  const existing = getChatRange(accountId, chatId);
  if (!existing) {
    writeChatRange(accountId, chatId, page);
    return;
  }
  const touches =
    page.minId <= existing.maxId + 1 && page.maxId >= existing.minId - 1;
  writeChatRange(
    accountId,
    chatId,
    touches
      ? {
          minId: Math.min(existing.minId, page.minId),
          maxId: Math.max(existing.maxId, page.maxId),
          hasStart: existing.hasStart || page.hasStart,
        }
      : page,
  );
}

export function forgetChatRange(accountId: number, chatId: string): void {
  try {
    db.prepare(
      "DELETE FROM tg_chat_sync WHERE account_id = ? AND chat_id = ?",
    ).run(accountId, chatId);
  } catch {}
}

/** Grows the range's top edge as live messages arrive. */
function extendChatRange(
  accountId: number,
  chatId: string,
  msgId: number,
): void {
  const existing = getChatRange(accountId, chatId);
  if (!existing) return; // Nothing cached to be contiguous with
  if (msgId <= existing.maxId) return;
  writeChatRange(accountId, chatId, { ...existing, maxId: msgId });
}

/** Pulls the range's bottom edge up after the cache trim drops the oldest rows. */
function clampChatRange(accountId: number, chatId: string): void {
  const range = getChatRange(accountId, chatId);
  if (!range) return;
  const row = db
    .prepare(
      "SELECT MIN(msg_id) AS lo FROM tg_message_cache WHERE account_id = ? AND chat_id = ?",
    )
    .get(accountId, chatId) as { lo: number | null };
  if (row.lo === null) {
    forgetChatRange(accountId, chatId);
    return;
  }
  if (row.lo > range.minId) {
    writeChatRange(accountId, chatId, {
      ...range,
      minId: row.lo,
      hasStart: false,
    });
  }
}

/**
 * Whether the cache can answer this request in full. Anything less falls through to
 * Telegram rather than returning a short page, which the frontend would read as the end
 * of history and stop paginating.
 */
export function cacheCoversRequest(
  accountId: number,
  chatId: string,
  limit: number,
  beforeId?: number,
): boolean {
  const range = getChatRange(accountId, chatId);
  if (!range) return false;
  if (beforeId !== undefined && beforeId <= range.minId) return false;
  const params: (number | string)[] = [accountId, chatId, range.minId];
  let sql =
    "SELECT COUNT(*) AS n FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id >= ?";
  if (beforeId !== undefined) {
    sql += " AND msg_id < ?";
    params.push(Math.min(beforeId, range.maxId + 1));
  } else {
    sql += " AND msg_id <= ?";
    params.push(range.maxId);
  }
  const { n } = db.prepare(sql).all(...params)[0] as { n: number };
  // A short run is still complete when the cache reaches the start of the chat
  return n >= limit || range.hasStart;
}

// Rewrite the cached payload text after an edit so reloads show the new text
export function updateCachedMessageText(
  accountId: number,
  chatId: string,
  msgId: number,
  text: string,
): void {
  const row = db
    .prepare(
      "SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id = ?",
    )
    .get(accountId, chatId, msgId) as { payload: string } | undefined;
  if (!row) return;
  const payload = JSON.parse(row.payload) as TgMsgPayload;
  payload.text = text;
  payload.html = entitiesToHtml(text, undefined);
  db.prepare(
    "UPDATE tg_message_cache SET payload = ? WHERE account_id = ? AND chat_id = ? AND msg_id = ?",
  ).run(JSON.stringify(payload), accountId, chatId, msgId);
}

export function removeCachedMessages(
  accountId: number,
  chatId: string,
  ids: number[],
): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id IN (${placeholders})`,
  ).run(accountId, chatId, ...ids);
}

export function clearCachedMessages(accountId: number, chatId: string): void {
  db.prepare(
    "DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ?",
  ).run(accountId, chatId);
  forgetChatRange(accountId, chatId);
}

// How many recent messages a reconcile compares against the cache. Deep enough to catch a
// bot editing a message a few turns back, shallow enough to stay one round trip.
const RECONCILE_LIMIT = 40;
// Reconciles of the same chat closer together than this are collapsed, so a burst of
// triggers (chat opened, socket reopened, watchdog tick) costs one fetch, not three.
const RECONCILE_MIN_GAP_MS = 2_000;

const reconcileInFlight = new Map<string, Promise<void>>();
const reconciledAt = new Map<string, number>();

/**
 * Brings one chat back in line with the server: appends what arrived, re-emits what was
 * edited, and drops what was deleted. This is what the manual refresh button used to do by
 * hand. It replaces the old blind poll, which only ever looked for ids above the newest
 * cached one and so could not see an edit or a deletion at all.
 */
export async function reconcileChat(
  accountId: number,
  chatId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const key = `${accountId}:${chatId}`;
  const running = reconcileInFlight.get(key);
  if (running) return running;
  if (!opts.force) {
    const last = reconciledAt.get(key) ?? 0;
    if (Date.now() - last < RECONCILE_MIN_GAP_MS) return;
  }

  const run = (async () => {
    const entry = liveClients.get(accountId);
    if (!entry) return;

    let fresh: TgMsgPayload[];
    try {
      fresh = await getMessages(entry, chatId, RECONCILE_LIMIT, 0);
    } catch {
      return; // Offline or not permitted -- the next trigger tries again
    }
    if (!fresh.length) return;

    // getMessages returns newest-first, so the last entry bounds the compared window
    const windowFrom = fresh[fresh.length - 1].id;
    const cached = getCachedMessages(
      accountId,
      chatId,
      RECONCILE_LIMIT * 2,
    ).filter((m) => m.id >= windowFrom);

    cacheMessages(accountId, chatId, fresh);
    recordChatRange(accountId, chatId, {
      minId: windowFrom,
      maxId: fresh[0].id,
      hasStart: fresh.length < RECONCILE_LIMIT,
    });

    // A cold cache has nothing to diff against: fill it, but do not announce forty
    // messages as if they had just arrived.
    if (!cached.length) return;

    const cachedById = new Map(cached.map((m) => [m.id, m]));
    const freshIds = new Set(fresh.map((m) => m.id));

    // Oldest-first so the frontend appends in chronological order
    for (const msg of [...fresh].reverse()) {
      const prev = cachedById.get(msg.id);
      if (!prev) {
        entry.subscribers.forEach((sub) => sub({ chatId, message: msg }));
      } else if (messageSignature(prev) !== messageSignature(msg)) {
        emitEvent(entry, { type: "edited", chatId, message: msg });
      }
    }

    const deleted = cached
      .filter((m) => !freshIds.has(m.id))
      .map((m) => m.id);
    if (deleted.length) {
      removeCachedMessages(accountId, chatId, deleted);
      emitEvent(entry, { type: "deleted", chatId, ids: deleted });
    }
  })().finally(() => {
    reconcileInFlight.delete(key);
    reconciledAt.set(key, Date.now());
  });

  reconcileInFlight.set(key, run);
  return run;
}


// --- Dialog cache helpers ---

export function getCachedDialogs(accountId: number): TgDialogItem[] {
  const rows = db
    .prepare(
      "SELECT payload FROM tg_dialog_cache WHERE account_id = ? ORDER BY sort_order ASC",
    )
    .all(accountId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as TgDialogItem);
}

export function cacheDialogs(accountId: number, dialogs: TgDialogItem[]): void {
  if (!dialogs.length) return;
  const upsert = db.prepare(
    `INSERT INTO tg_dialog_cache (account_id, chat_id, sort_order, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, chat_id) DO UPDATE SET sort_order = excluded.sort_order, payload = excluded.payload`,
  );
  db.transaction(() => {
    for (let i = 0; i < dialogs.length; i++) {
      upsert.run(accountId, dialogs[i].chatId, i, JSON.stringify(dialogs[i]));
    }
  })();
}

// Drop everything cached for an account: SQLite message/dialog caches and the
// live client's in-memory entity, avatar and read-state caches. All of it is
// refetched from Telegram on demand.
export function clearAccountCache(accountId: number): void {
  db.prepare("DELETE FROM tg_message_cache WHERE account_id = ?").run(
    accountId,
  );
  db.prepare("DELETE FROM tg_dialog_cache WHERE account_id = ?").run(accountId);
  try {
    db.prepare("DELETE FROM tg_chat_sync WHERE account_id = ?").run(accountId);
  } catch {}
  const entry = liveClients.get(accountId);
  if (entry) {
    entry.entityCache.clear();
    entry.avatarCache.clear();
    entry.readOutboxCache.clear();
    entry.channelDmCache.clear();
  }
  forgetAccountChannelDms(accountId);
}

export function removeCachedDialog(accountId: number, chatId: string): void {
  db.prepare(
    "DELETE FROM tg_dialog_cache WHERE account_id = ? AND chat_id = ?",
  ).run(accountId, chatId);
}

// Removes cached rows for chats no longer in a full dialog load
// (deleted chats, left groups). Upserts alone never drop them.
function pruneCachedDialogs(accountId: number, dialogs: TgDialogItem[]): void {
  if (!dialogs.length) return;
  const keep = new Set(dialogs.map((d) => d.chatId));
  const rows = db
    .prepare("SELECT chat_id FROM tg_dialog_cache WHERE account_id = ?")
    .all(accountId) as { chat_id: string }[];
  const del = db.prepare(
    "DELETE FROM tg_dialog_cache WHERE account_id = ? AND chat_id = ?",
  );
  for (const r of rows) {
    if (!keep.has(r.chat_id)) del.run(accountId, r.chat_id);
  }
}

export async function syncDialogsInBackground(
  accountId: number,
): Promise<void> {
  const entry = liveClients.get(accountId);
  if (!entry) return;
  try {
    const dialogs = await loadDialogs(entry);
    pruneCachedDialogs(accountId, dialogs);
    cacheDialogs(accountId, dialogs);
    entry.dialogSubscribers.forEach((sub) => sub(dialogs));
  } catch {}
}

export type TgCleanResult = {
  left: number;
  deleted: number;
  contacts: number;
  folders: number;
  failed: { chatId: string; name: string; error: string }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bulk-clean an account: leave every group and channel, delete every private
// chat for both sides, remove all contacts and all custom chat folders.
// Saved Messages is kept. Destructive and irreversible -- the caller is
// responsible for confirming with the user first.
// Dialog loads are capped, so process in rounds until nothing is pending.
export async function cleanAccount(
  entry: LiveEntry,
  accountId: number,
): Promise<TgCleanResult> {
  const result: TgCleanResult = {
    left: 0,
    deleted: 0,
    contacts: 0,
    folders: 0,
    failed: [],
  };
  const failedIds = new Set<string>();

  for (let round = 0; round < 10; round++) {
    const dialogs = await loadDialogs(entry);
    const pending = dialogs.filter((d) => {
      if (failedIds.has(d.chatId)) return false;
      const entity = entry.entityCache.get(d.chatId);
      if (entity instanceof Api.User) {
        // Never wipe the user's own Saved Messages
        if (entity.self) return false;
        // Keep Telegram service notifications (u777000) and SpamBot --
        // both are needed for account status and appeal messages
        if (entity.id.toString() === "777000") return false;
        if ((entity.username ?? "").toLowerCase() === "spambot") return false;
      }
      return true;
    });
    if (!pending.length) break;

    for (const d of pending) {
      try {
        if (d.type === "group" || d.type === "channel") {
          await leaveChat(entry, d.chatId);
          // Leaving does not always drop the dialog -- clear the leftover copy
          try {
            await deleteHistory(entry, d.chatId, false);
          } catch {}
          result.left++;
        } else {
          await deleteHistory(entry, d.chatId, true);
          result.deleted++;
        }
        removeCachedDialog(accountId, d.chatId);
        clearCachedMessages(accountId, d.chatId);
        // Pace the calls to stay clear of Telegram flood limits
        await sleep(250);
      } catch (err: any) {
        failedIds.add(d.chatId);
        result.failed.push({
          chatId: d.chatId,
          name: d.name,
          error: err?.message ?? String(err),
        });
      }
    }
  }

  // Remove all custom chat folders (the default "All chats" view has no id).
  // UpdateDialogFilter without a filter payload deletes the folder.
  try {
    const raw = await entry.client.invoke(new Api.messages.GetDialogFilters());
    const filters: any[] = Array.isArray(raw)
      ? raw
      : ((raw as any)?.filters ?? []);
    for (const f of filters) {
      if (!f.id) continue;
      await entry.client.invoke(
        new Api.messages.UpdateDialogFilter({ id: f.id }),
      );
      result.folders++;
      await sleep(250);
    }
  } catch (err: any) {
    result.failed.push({
      chatId: "folders",
      name: "Folders",
      error: err?.message ?? String(err),
    });
  }

  // Remove all contacts, deleted accounts included
  try {
    const res = await entry.client.invoke(
      new Api.contacts.GetContacts({ hash: BigInt(0) as any }),
    );
    if ("users" in res) {
      const ids = (res.users as Api.User[]).map(
        (u) =>
          new Api.InputUser({
            userId: u.id,
            accessHash: u.accessHash ?? (BigInt(0) as any),
          }),
      );
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await entry.client.invoke(
          new Api.contacts.DeleteContacts({ id: batch }),
        );
        result.contacts += batch.length;
        await sleep(250);
      }
    }
  } catch (err: any) {
    result.failed.push({
      chatId: "contacts",
      name: "Contacts",
      error: err?.message ?? String(err),
    });
  }

  return result;
}
