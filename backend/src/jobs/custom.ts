import { TelegramClient, Api, Logger, utils } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from '../types';
import type { TgDeviceParams } from '../auth/tgAuth';
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import {
  expandCommand,
  selectButtonWithAI,
  selectMultipleButtonsWithAI,
  parseMessages,
  waitForBotMessageEdit,
  waitForNewBotMessage,
  isAiBtn,
  parseAiBtnHint,
  AI_INPUT_HINT_RE,
  AI_INPUT_RE,
  aiInputLengthRule,
  hasAiInput,
  hasAiInputHint,
  parseAiInputHint,
  parseAiInputLength,
  recognizeCaptchaWithAI,
  answerWithAI,
  buildAiInputPrompt,
  htmlToText,
  buildCaptchaPrompt,
  findUrlButton,
  callAI,
} from "./checkin";
import { escapeHtml } from "../tg/htmlEscape";
import {
  cfFailureFallback,
  cfNoCandidatesMessage,
  cfNoteFailure,
  cfRefusedFor,
  loadCheckinUrl,
  cfProfileVars,
  newCfRunState,
  type CfRunState,
  type LoadOptions,
} from "./cloudflare";
import {
  expandDatePlaceholders,
  matchesAnyLabel,
  parseLabelAlternatives,
  runSaysSuccess,
  textSaysFail,
  textSaysSuccess,
} from "./placeholders";
import {
  openableBotMenuApp,
  openableButtonUrl,
  openableMiniAppUrl,
  webButtonOf,
  type WebButton,
} from "../tg/miniApp";
import { pickMessageLink, type MessageLink } from "../tg/messageLinks";
import { resolvePeerTarget } from "../tg/peerTarget";
import {
  cfMaxCandidates,
  cfProxyCandidatesFor,
  rememberCfProxy,
  type ProxyChoice,
} from "../tg/proxyProviders";
import { cfTuning } from "./cfTuning";
import { rememberWebValue, usedWebValues } from "./webMemory";
import { handOverJob } from "./jobHandover";
import { getNotifyConfig, sendBotNotify } from "./notify";
import { EMAIL_CODE_LOOKBACK_MS, fetchGmailCode } from "./emailCode";
import {
  accountStatus,
  leaseEmail,
  msApiConfigured,
  msApiOffReason,
  pollForCode,
  pollForLink,
  startOauthFlow,
} from "./msOauth2api";
import { msOauthStepsIn } from "./msOauth2";
import { saveAccountApiCredentials, waitForTgLoginCode } from "./tgApiCredentials";
import { fillSecrets, missingSecretRefs } from "../db/secrets";
import { connectWithTimeout, destroyQuietly } from "../tg/clientTimeout";
import { displayForRun } from "./runDisplays";

import type {
  CustomAction,
  CustomCondition,
  CustomConfig,
  CustomStepLog,
} from "../types";

export type CustomJobLog = {
  steps: CustomStepLog[];
};

/** The account a run belongs to, as the page steps need to know it. */
export type CustomRunAccount = {
  id: number;
  name: string;
  phoneNumber: string;
};

type WebButtonOutcome = {
  /** Text of the page that was opened, empty when nothing was loaded. */
  text: string;
  /** Set when a `?start=` deep link was followed, so the caller can re-anchor. */
  deepLinkSent?: { botUsername: string; msg: Api.Message };
};

/**
 * Handles a button that opens something rather than firing a callback.
 *
 * A `?start=` deep link is followed inside Telegram, which is what a real client does. A
 * button that opens a page is not: a clicking action stays inside Telegram, and anything
 * needing a browser belongs to the actions built around one -- so this says so rather than
 * quietly starting a browser from a step that is not about the web.
 */
async function openWebButton(
  client: TelegramClient,
  web: WebButton,
  peer: Api.TypeEntityLike,
  msg: Api.Message | null,
  step: CustomStepLog,
): Promise<WebButtonOutcome> {
  // A `?start=` deep link is followed the way a real client does -- by sending the
  // command to that bot -- not by loading a page. Group bots use these to move a
  // verification into a private chat.
  if (web.startLink) {
    const { botUsername, startParam } = web.startLink;
    const sent = await client.sendMessage(botUsername, { message: `/start ${startParam}` });
    step.result = `Followed deep link: /start ${startParam} to @${botUsername}`;
    return { text: "", deepLinkSent: { botUsername, msg: sent } };
  }

  throw new Error(
    web.miniApp
      ? `"${web.text}" opens a Mini App, which this action cannot do. Use an "Open Mini App" action for it.`
      : `"${web.text}" opens a web page, which this action cannot do. Use an "Open URL" action for it.`,
  );
}

export class CustomJobError extends Error {
  constructor(
    message: string,
    public readonly log: CustomJobLog,
  ) {
    super(message);
    this.name = "CustomJobError";
  }
}

// Marker of the last message we sent: anything the bot delivered after this point
// (higher id, or an edit stamped after our send) is a candidate reply. Anchoring on the
// sent message's server-side id/date avoids local clock skew.
type SendAnchor = { msgId: number; dateSec: number };

const hasInlineButtons = (m: Api.Message | null | undefined): boolean =>
  !!m && (m as any).replyMarkup instanceof Api.ReplyInlineMarkup;

/** Poll text is TextWithEntities from layer 225 on, and was a bare string before it. */
const pollTextOf = (v: unknown): string =>
  typeof v === "string" ? v : (((v as any)?.text as string) ?? "");

const pollEntitiesOf = (v: unknown): any[] =>
  typeof v === "string" ? [] : (((v as any)?.entities as any[]) ?? []);

/**
 * The open poll a message carries. Verification bots pose their entry question either as an
 * inline keyboard or as a quiz whose answers are poll options -- the same question in two
 * shapes, so everything downstream treats them alike.
 */
const openPollOf = (m: Api.Message | null | undefined): Api.Poll | null => {
  const media = (m as any)?.media;
  if (!(media instanceof Api.MessageMediaPoll)) return null;
  const poll = media.poll as Api.Poll;
  return poll.closed ? null : poll;
};

/** Text a prompt addresses the joiner in, wherever the bot put it. */
const promptText = (m: Api.Message | null | undefined): string => {
  const poll = openPollOf(m);
  return [m?.message ?? "", poll ? pollTextOf(poll.question) : ""]
    .filter(Boolean)
    .join("\n");
};

/** Entities of that text -- a poll keeps its own, outside the message's. */
const promptEntities = (m: Api.Message | null | undefined): any[] => [
  ...(((m?.entities ?? []) as any[]) ?? []),
  ...pollEntitiesOf(openPollOf(m)?.question),
];

// Does a message's text/caption carry the wording an action is pinned to? A blank
// needle matches anything. Whitespace is ignored on both sides, so a keyword typed
// as "请在 180 秒内" still matches a message rendering it as "请在180秒内".
export const msgTextMatches = (
  m: Api.Message | null | undefined,
  needle?: string,
): boolean => {
  if (!needle?.trim()) return true;
  const strip = (s: string) => s.replace(/\s+/g, "");
  return strip(m?.message ?? "").includes(strip(needle));
};

/** This account, as the forms a group prompt can name it by. */
type SelfRef = { id: string; username?: string; names?: string[] };

const selfRef = async (client: TelegramClient): Promise<SelfRef> => {
  const me = (await client.getMe()) as Api.User;
  const first = me.firstName?.trim() ?? "";
  const last = me.lastName?.trim() ?? "";
  return {
    id: me.id.toString(),
    username: me.username || undefined,
    // Longest first, so a full name is tried before the first name alone.
    names: [[first, last].filter(Boolean).join(" "), first, last, me.username ?? ""].filter(Boolean),
  };
};

/**
 * Does this message name the account by display name, masked or not? Welcome bots post
 * the "阿**2" / "T***y" form, keeping only the first and last character -- but the same
 * bot leaves a two-character name whole, since there is no middle to hide.
 *
 * Masking usually preserves length, so a token of the same length whose ends match is
 * taken as ours. A bot using a fixed number of stars still identifies us when its prompt
 * carries only one masked name, so that case is accepted on the ends alone. A name that
 * reads as a substring of another member's can match their prompt -- the mention check is
 * the exact one.
 */
export function messageMasksUserName(
  m: Api.Message | null | undefined,
  me: SelfRef,
): boolean {
  const text = promptText(m);
  const names = me.names ?? [];
  if (!text || !names.length) return false;

  // Masking keeps the first and last character, so a name of two characters has no middle
  // to hide and is posted as it is ("小明"). The plain name has to count, or such an
  // account never recognises its own prompt.
  if (names.some((n) => n.length >= 2 && text.includes(n))) return true;

  const masked = [...text.matchAll(/(\S)\*+(\S)/gu)].map((x) => ({
    token: x[0],
    first: x[1],
    last: x[2],
  }));
  if (!masked.length) return false;

  const endsMatch = (name: string, t: (typeof masked)[number]): boolean =>
    name.length >= 2 && t.first === name[0] && t.last === name[name.length - 1];

  for (const name of names) {
    if (masked.some((t) => endsMatch(name, t) && t.token.length === name.length)) return true;
  }
  if (masked.length === 1) return names.some((name) => endsMatch(name, masked[0]));
  return false;
}

// Is this message addressed to this account? A group posting verification prompts for
// several joiners at once names each one -- as @username, as a text mention (the only
// form available when no username is set), or by numeric id -- and the server also
// stamps the `mentioned` flag on the ones that single us out.
export function messageAddressesUser(
  m: Api.Message | null | undefined,
  me: SelfRef,
): boolean {
  if (!m) return false;
  if ((m as any).mentioned) return true;
  const text = promptText(m);
  const entities = promptEntities(m);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A bare id, not part of a longer number (so "180" never matches an id ending in 180)
  const carriesId = (s: string): boolean =>
    new RegExp(`(?:^|\\D)${me.id}(?:\\D|$)`).test(s);
  if (me.username && new RegExp(`@${escape(me.username)}\\b`, "i").test(text))
    return true;
  if (text.includes(`tg://user?id=${me.id}`)) return true;
  if (carriesId(text)) return true;
  // Text mentions carry the user in an entity rather than the text
  if (entities.some((e) => e?.userId != null && e.userId.toString() === me.id))
    return true;
  // Some welcome bots name the joiner in a hidden link instead of a mention: a zero-width
  // text link whose URL carries {"userId":<id>}. It is exact, and on a prompt that masks
  // the display name it is the only signal that says which joiner it is for.
  return entities.some((e) => {
    if (typeof e?.url !== "string") return false;
    let url = e.url;
    try {
      url = decodeURIComponent(url);
    } catch {
      // Malformed escape sequence -- test the raw URL, the id is unescaped either way
    }
    return carriesId(url);
  });
}

// A wait for buttons can be pinned to a subset of messages: one carrying certain wording,
// or one addressed to this account. `describe` only shapes the timeout message.
type ButtonsFilter = {
  accept: (m: Api.Message) => boolean;
  describe: string;
};

const noButtonsError = (maxMs: number, filter?: ButtonsFilter): string =>
  `No message with buttons ${filter ? `${filter.describe} ` : ""}received within ${maxMs}ms`;

const anchorFromSent = (sent: Api.Message): SendAnchor => ({
  msgId: sent.id,
  dateSec: sent.date ?? Math.floor(Date.now() / 1000),
});

const isEditUpdate = (update: any): boolean =>
  update?.className === "UpdateEditMessage" ||
  update?.className === "UpdateEditChannelMessage";

// Lowest message id an action will accept for a given scope. scope 0 (default)
// admits only messages newer than the anchor -- the reply to what we just sent,
// which stops a stale menu from an earlier turn being clicked. scope -N also
// admits the N most recent incoming messages that predate the anchor, for bots
// whose live menu sits on an earlier message. anchorId 0 (nothing sent yet)
// falls back to accepting everything.
async function resolveScopeFloor(
  client: TelegramClient,
  target: Api.TypeEntityLike,
  anchorId: number,
  scope?: number,
): Promise<number> {
  const freshFloor = anchorId + 1;
  if (!scope || scope >= 0) return freshFloor;
  const n = -scope;
  const recent = (await client
    .getMessages(target, { limit: n + 20 })
    .catch(() => [])) as Api.Message[];
  const prior = recent
    .filter((m) => m && !m.out && m.id <= anchorId)
    .map((m) => m.id)
    .sort((a, b) => b - a); // newest first
  if (!prior.length) return freshFloor;
  return prior[Math.min(n, prior.length) - 1];
}

// Authoritative membership check: GetParticipant throws USER_NOT_PARTICIPANT for pending
// join requests, unlike the Channel.left flag which can lag behind actual state.
async function isChannelMember(client: TelegramClient, channel: Api.Channel): Promise<boolean> {
  try {
    const result = await client.invoke(
      new Api.channels.GetParticipant({ channel, participant: "me" }),
    );
    return !(result.participant instanceof Api.ChannelParticipantLeft);
  } catch (err: any) {
    if (err?.message?.includes("USER_NOT_PARTICIPANT")) return false;
    throw err;
  }
}

// Waits for a message carrying inline buttons in a specific chat (e.g. the group we just
// joined). Buttons can arrive on a brand-new message OR via an in-place edit of an
// existing message, so both update paths are watched. `filter` keeps the wait going until a
// buttons message the caller actually wants turns up.
async function waitForButtonsInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
  filter?: ButtonsFilter,
  /** What counts as carrying options; a group verification also stops for a quiz poll. */
  carriesOptions: (m: Api.Message) => boolean = hasInlineButtons,
): Promise<Api.Message[]> {
  const chatPeerId = await client.getPeerId(chat);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      cleanup();
      if (!collected.includes(msg)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(noButtonsError(maxMs, filter)));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const wanted = (msg: Api.Message): boolean =>
      carriesOptions(msg) && (!filter || filter.accept(msg));

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      // Match the chat by id here rather than through NewMessage({ chats }): that filter
      // stringifies an entity object to "[object Object]" and then throws an unhandled
      // rejection while resolving it on the next update -- immediate in a busy group.
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== chatPeerId) return;
      collected.push(msg);
      if (wanted(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== chatPeerId) return;
      if (wanted(msg)) succeed(msg);
    };

    client.addEventHandler(handler, new NewMessage({}));
    client.addEventHandler(editHandler, new Raw({}));
  });
}

// An action's maxWaitMs is the wall-clock budget for the whole action, not per wait:
// locating the button and waiting for the bot's response both draw from the same clock.
// Returns how much is left, never 0 -- a spent budget still gets one short look.
const DEFAULT_ACTION_WAIT_MS = 10_000;
const MIN_WAIT_SLICE_MS = 1_000;

function waitBudget(maxWaitMs?: number): () => number {
  const deadline =
    Date.now() + (maxWaitMs && maxWaitMs > 0 ? maxWaitMs : DEFAULT_ACTION_WAIT_MS);
  return () => Math.max(MIN_WAIT_SLICE_MS, deadline - Date.now());
}

/**
 * Fills whichever AI placeholder the content carries from the message the bot last sent:
 * `{aiInput}` / `{aiInput:N}` reads a captcha off its image, `{aiInputWithCustomHint:<hint>}`
 * has the model read the message and write the reply the hint asks for -- which is what a
 * bot asking its question in words needs. Content carrying neither is handed back untouched.
 */
async function fillAiInput(
  client: TelegramClient,
  messages: Api.Message[],
  content: string,
  step: CustomStepLog,
  signal?: AbortSignal,
): Promise<string> {
  const spec = hasAiInputHint(content) ? parseAiInputHint(content) : undefined;
  if (!spec && !hasAiInput(content)) return content;

  const length = spec ? undefined : parseAiInputLength(content);
  const parsed = await parseMessages(messages, client, signal);
  if (parsed.images[0]) step.preClickImage = parsed.images[0];
  // The wording is what a hinted answer is worked out from, so the log keeps it
  if (spec && parsed.html) step.preClickHtml = parsed.html;

  // Logged before the call, so a run that fails on the AI still shows what it was asked
  step.aiPrompt = spec
    ? buildAiInputPrompt(spec, htmlToText(parsed.html ?? ""), parsed.images.length > 0)
    : buildCaptchaPrompt(length);

  const aiStart = Date.now();
  const answer = await (spec
    ? answerWithAI(parsed.images, parsed.html ?? "", spec)
    : recognizeCaptchaWithAI(parsed.images, length))
    .then((r) => {
      step.aiResponse = r.response;
      return r;
    })
    .finally(() => {
      step.aiDurationMs = Date.now() - aiStart;
    });

  // A captcha is held to the length it was said to be; a hinted answer to the range the
  // placeholder asked for. Either way a wrong length is the step failing rather than a
  // half-read answer going out to the bot.
  if (length && answer.text.length !== length) {
    throw new Error(
      `AI returned ${answer.text.length} chars ("${answer.text}") but expected ${length}`,
    );
  }
  if (spec && (spec.minLen || spec.maxLen)) {
    const n = answer.text.length;
    if ((spec.minLen && n < spec.minLen) || (spec.maxLen && n > spec.maxLen)) {
      throw new Error(
        `AI answered ${n} chars ("${answer.text.slice(0, 80)}") but the step asks for ` +
          `${aiInputLengthRule(spec)}`,
      );
    }
  }
  return content.replace(spec ? AI_INPUT_HINT_RE : AI_INPUT_RE, answer.text);
}

/**
 * Waits for a message in a chat that offers a link the picker accepts. Edits count as
 * arrivals: a bot that sends its text first and then edits the link in is making the same
 * offer as one that sends both at once. Resolves null on timeout or abort -- what a missing
 * link means is the caller's to say.
 */
async function waitForLinkInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  pick: (msg: Api.Message) => MessageLink | undefined,
  signal?: AbortSignal,
): Promise<{ msg: Api.Message; link: MessageLink } | null> {
  const chatPeerId = await client.getPeerId(chat).catch(() => null);

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    const finish = (found: { msg: Api.Message; link: MessageLink } | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };

    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });

    // The chat is matched by id here rather than through NewMessage({ chats }), which
    // stringifies an entity to "[object Object]" and throws while resolving it.
    const consider = (msg: Api.Message | undefined) => {
      if (!msg?.peerId || (chatPeerId != null && utils.getPeerId(msg.peerId) !== chatPeerId))
        return;
      const link = pick(msg);
      if (link) finish({ msg, link });
    };

    const handler = async (event: NewMessageEvent) => consider(event.message as Api.Message);
    const editHandler = async (update: any) => {
      if (isEditUpdate(update)) consider(update.message as Api.Message);
    };

    client.addEventHandler(handler, new NewMessage({}));
    client.addEventHandler(editHandler, new Raw({}));
  });
}

// Waits for the next new message arriving in a specific chat. Never rejects -- resolves null
// on timeout or abort.
async function waitForNewMessageInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  // Resolve the chat id up front and match it manually. Passing an entity object into
  // NewMessage({ chats }) breaks GramJS -- its constructor stringifies each filter entry
  // to "[object Object]", then throws an unhandled rejection resolving it on the next update.
  const targetId = await client.getPeerId(chat).catch(() => null);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(msg);
    };
    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      if (
        targetId != null &&
        event.message?.chatId?.toString() !== targetId.toString()
      )
        return;
      finish(event.message as Api.Message);
    };
    client.addEventHandler(handler, new NewMessage({}));
  });
}

type GroupVerifyOpts = {
  /**
   * Button text to match in the group prompt; partial match, blank takes the sole button.
   * `{aiBtn}` (or `{aiBtn:hint}`) hands the choice to the AI, which reads the prompt.
   */
  buttonMatch: string;
  /** Bounds the wait for the in-group prompt to appear. */
  promptWaitMs: number;
  /** Bounds the whole verification: the prompt wait plus everything it leads to. */
  maxMs: number;
  /** Only prompts stamped at or after this second count as ours. */
  sinceSec?: number;
  /** Require the prompt to name this account (@username, text mention, or numeric id). */
  onlyMine?: boolean;
  /** Also accept a prompt naming this account through a masked name ("阿**2"). */
  maskedName?: boolean;
};

// The admin's verdict itself, not a member's "通过验证" -- so only an exact label counts,
// and only next to a decline, which is what marks the pair as the admins' rather than ours.
const VERIFY_ADMIN_VERDICT = /^(通过|同意|approve|accept)$/i;

/**
 * What the model is shown of a verification prompt's keyboard when `{aiBtn}` stands in
 * for the button text. The admin controls riding along with these prompts are withheld:
 * pressing 拒绝 fails the verification outright and 通过 is not this account's to press,
 * and no wording of the task is worth the risk of the model reaching for either.
 */
export function verifyAiButtonRows(rows: Api.TypeKeyboardButtonRow[]): string[][] {
  const labels = rows.flatMap((row) =>
    row.buttons.map((b) => ((b.text as string) ?? "").trim()),
  );
  const adminPair = labels.some((text) => VERIFY_DECLINE.test(text));
  const offered = (text: string) =>
    !!text &&
    !VERIFY_DECLINE.test(text) &&
    !(adminPair && VERIFY_ADMIN_VERDICT.test(text));
  return rows
    .map((row) => row.buttons.map((b) => ((b.text as string) ?? "").trim()).filter(offered))
    .filter((row) => row.length > 0);
}

// The default task, for an `{aiBtn}` given no hint of its own.
const VERIFY_AI_TASK =
  "complete the group entry verification for the member who has just joined: read the prompt " +
  "and press the button that answers it -- for an arithmetic question, the one carrying the " +
  "correct result. Never press a button that approves, rejects, reports or bans a member: " +
  "those belong to the group's admins";

// A model that answers with something no button carries gets another go or two -- these
// bots ban on a two-minute deadline, so the retries have to stay cheap.
const VERIFY_AI_RETRIES = 2;

/**
 * Lets the model read the prompt and name the button to press, for a verification whose
 * answer is only knowable from the message itself -- an arithmetic question answered by one
 * of a row of numbers, where no fixed button text could have been configured in advance.
 * Returns undefined when the prompt offers nothing pressable; AI failures throw, since a
 * join left unverified is worth reporting rather than passing over quietly.
 */
async function pickVerifyButtonWithAI(
  client: TelegramClient,
  prompt: Api.Message,
  flat: Api.TypeKeyboardButton[],
  hint: string | undefined,
  step: CustomStepLog,
  signal?: AbortSignal,
): Promise<Api.TypeKeyboardButton | undefined> {
  const rows = verifyAiButtonRows(
    ((prompt as any).replyMarkup as Api.ReplyInlineMarkup).rows,
  );
  const choices = rows.flat();
  if (!choices.length) return undefined;
  const byText = (text: string) =>
    flat.find((b) => ((b.text as string) ?? "").trim() === text);
  // Nothing to weigh up, and the deadline is short -- skip the round trip.
  if (choices.length === 1) return byText(choices[0]);

  // The question is often drawn in an image rather than written out, so the prompt goes
  // to the model as the message renders, pictures included.
  const parsed = await parseMessages([prompt], client, signal);
  if (parsed.html) step.preClickHtml = parsed.html;
  if (parsed.images.length) step.preClickImage = parsed.images[0];
  if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
  if (parsed.buttons.length) step.preClickButtons = parsed.buttons;

  const aiStart = Date.now();
  try {
    const picked = await selectButtonWithAI(
      rows,
      parsed.html || prompt.message || "",
      parsed.images,
      hint ?? VERIFY_AI_TASK,
      VERIFY_AI_RETRIES,
    );
    step.aiPrompt = picked.prompt;
    step.aiResponse = picked.response;
    if (picked.retries.length) step.aiRetries = picked.retries;
    return byText(picked.button);
  } finally {
    step.aiDurationMs = Date.now() - aiStart;
  }
}

// Some groups post an in-group verification message with a button that must be clicked to
// gain real access after joining. Best-effort: waits for that message, clicks the button whose
// text contains buttonMatch (or the sole button), and appends the outcome to step.result.
//
// With onlyMine set, only a prompt naming this account counts: a busy group verifying several
// joiners at once posts one prompt each, and clicking someone else's does nothing for us (and
// may burn their attempt), so the wait continues past prompts addressed to other people.
async function clickGroupVerification(
  client: TelegramClient,
  chat: Api.Channel,
  step: CustomStepLog,
  opts: GroupVerifyOpts,
  signal?: AbortSignal,
): Promise<void> {
  const { buttonMatch, promptWaitMs, sinceSec, onlyMine, maskedName } = opts;
  // One budget for the whole verification, so a slow prompt cannot leave the private
  // hand-off with no time left -- these bots ban on their own deadline.
  const deadline = Date.now() + opts.maxMs;
  const remainingMs = () => deadline - Date.now();
  const maxMs = Math.min(promptWaitMs, Math.max(0, remainingMs()));
  const me = onlyMine || maskedName ? await selfRef(client) : null;
  // Either signal alone is enough to call a prompt ours: a bot that masks the name
  // never @-mentions, and one that @-mentions never masks.
  const filter: ButtonsFilter | undefined = me
    ? {
        accept: (m) =>
          (!!onlyMine && messageAddressesUser(m, me)) ||
          (!!maskedName && messageMasksUserName(m, me)),
        describe: maskedName && !onlyMine ? "naming this account (masked)" : "addressed to this account",
      }
    : undefined;
  // A quiz poll is the same verification in another shape, so it counts as a prompt.
  const carriesOptions = (m: Api.Message | null | undefined): boolean =>
    hasInlineButtons(m) || !!openPollOf(m);
  const wanted = (m: Api.Message | null | undefined): boolean =>
    carriesOptions(m) && (!filter || filter.accept(m as Api.Message));

  const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
    [...msgs].reverse().find((m) => wanted(m)) ?? null;

  // A group verifying a rush of joiners buries our prompt under theirs, so look back
  // further when only ours will do.
  const scanLimit = filter ? 50 : 10;

  // Waiter catches prompts that arrive (or get edited in) from now on; the scan catches a
  // prompt that landed in the gap before the listener attached. Whichever finds one first wins.
  const waitAbort = new AbortController();
  const forwardAbort = () => waitAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const waiterPromise = waitForButtonsInChat(
    client,
    chat,
    maxMs,
    waitAbort.signal,
    0,
    filter,
    (m) => carriesOptions(m),
  )
    .then(findButtonsMsg)
    .catch(() => null);

  const earlyScan = client
    .getMessages(chat, { limit: scanLimit })
    .then(
      (recent) =>
        (recent as Api.Message[]).find(
          (m) =>
            m &&
            !m.out &&
            wanted(m) &&
            (!sinceSec || Math.max(m.editDate ?? 0, m.date ?? 0) >= sinceSec),
        ) ?? null,
    )
    .catch(() => null);

  let buttonsMsg = await Promise.race([
    waiterPromise,
    earlyScan.then((m) => m ?? waiterPromise),
  ]);
  waitAbort.abort();
  signal?.removeEventListener("abort", forwardAbort);
  if (signal?.aborted) throw new Error("Job cancelled");

  // Last resort: any recent prompt regardless of age
  if (!buttonsMsg) {
    const recent = (await client.getMessages(chat, { limit: scanLimit })) as Api.Message[];
    buttonsMsg = findButtonsMsg(recent);
  }

  if (!buttonsMsg) {
    step.result = `${step.result} (no verification prompt${filter ? ` ${filter.describe}` : ""})`;
    return;
  }

  const poll = openPollOf(buttonsMsg);
  if (poll) {
    await answerVerifyPoll(client, chat, buttonsMsg, poll, buttonMatch, step, signal);
    return;
  }

  const rows = ((buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup).rows;
  const flat = rows.flatMap((r) => r.buttons);
  let target: Api.TypeKeyboardButton | undefined;
  if (isAiBtn(buttonMatch)) {
    target = await pickVerifyButtonWithAI(
      client,
      buttonsMsg,
      flat,
      parseAiBtnHint(buttonMatch),
      step,
      signal,
    );
    if (!target) {
      step.result = `${step.result} (no verification button for the AI to pick)`;
      return;
    }
  } else {
    // `|`-separated wordings all count, so one job covers a bot that words the button in
    // whichever language the joining account is set to.
    const wantedLabels = parseLabelAlternatives(buttonMatch);
    target = wantedLabels.length
      ? flat.find((b: any) => wantedLabels.some((w) => ((b.text as string) ?? "").includes(w)))
      : undefined;
    // Fall back to the sole button for single-button verifications.
    if (!target && flat.length === 1) target = flat[0];
    if (!target) {
      step.result = `${step.result} (verification button not found)`;
      return;
    }
  }

  step.clickedButton = (target as any).text as string;

  const data = (target as Api.KeyboardButtonCallback).data;
  if (data) {
    const peer = await client.getInputEntity(chat);
    step.result = `${step.result} + ${await clickCallback(client, peer, buttonsMsg.id, data, step)}`;
    return;
  }

  // No callback data: the button opens something. A `?start=` deep link hands the
  // verification to a private chat with the bot, which is a flow we can follow.
  const web = webButtonOf(target as Api.TypeKeyboardButton);
  if (web?.startLink) {
    await verifyInPrivateChat(client, web.startLink, step, remainingMs, signal);
    return;
  }
  step.result = `${step.result} (verification button "${(target as any).text}" opens ${
    web?.miniApp ? "a Mini App" : web?.url ? "a web page" : "nothing clickable"
  })`;
}

// The default task for a quiz poll standing in for a keyboard: the same job as
// VERIFY_AI_TASK, worded for options rather than buttons.
const VERIFY_AI_POLL_TASK =
  "answer the group entry verification quiz for the member who has just joined: read the " +
  "question and pick the option that answers it correctly -- for an arithmetic question, " +
  "the one carrying the correct result";

/**
 * Answers a verification posed as a poll: the same choice a keyboard prompt asks for, cast
 * as a vote instead of a click. The AI reads the question exactly as it does a keyboard's,
 * so `{aiBtn}` covers both shapes and a template says nothing about which one it faces.
 */
async function answerVerifyPoll(
  client: TelegramClient,
  chat: Api.Channel,
  prompt: Api.Message,
  poll: Api.Poll,
  buttonMatch: string,
  step: CustomStepLog,
  signal?: AbortSignal,
): Promise<void> {
  const options = (poll.answers ?? []).map((a) => ({
    text: pollTextOf((a as Api.PollAnswer).text).trim(),
    option: (a as Api.PollAnswer).option,
  }));
  if (!options.length) {
    step.result = `${step.result} (verification poll has no options)`;
    return;
  }
  const question = pollTextOf(poll.question).trim();

  let target: (typeof options)[number] | undefined;
  if (isAiBtn(buttonMatch)) {
    if (options.length === 1) {
      target = options[0];
    } else {
      // The question lives in the poll rather than in the message text, so it is spelled
      // out for the model here; a picture riding along still goes through parseMessages.
      const parsed = await parseMessages([prompt], client, signal);
      const text = [parsed.html, question].filter(Boolean).join("<br>");
      step.preClickHtml = text;
      if (parsed.images.length) step.preClickImage = parsed.images[0];
      if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
      step.preClickButtons = [options.map((o) => o.text)];

      const aiStart = Date.now();
      try {
        const picked = await selectButtonWithAI(
          [options.map((o) => o.text)],
          text,
          parsed.images,
          parseAiBtnHint(buttonMatch) ?? VERIFY_AI_POLL_TASK,
          VERIFY_AI_RETRIES,
        );
        step.aiPrompt = picked.prompt;
        step.aiResponse = picked.response;
        if (picked.retries.length) step.aiRetries = picked.retries;
        target = options.find((o) => o.text === picked.button);
      } finally {
        step.aiDurationMs = Date.now() - aiStart;
      }
    }
  } else {
    const wantedLabels = parseLabelAlternatives(buttonMatch);
    target = wantedLabels.length
      ? options.find((o) => wantedLabels.some((w) => o.text.includes(w)))
      : undefined;
    if (!target && options.length === 1) target = options[0];
  }

  if (!target) {
    step.result = `${step.result} (no verification poll option matched)`;
    return;
  }
  step.clickedButton = target.text;

  await client.invoke(
    new Api.messages.SendVote({
      peer: await client.getInputEntity(chat),
      msgId: prompt.id,
      options: [target.option],
    }),
  );

  // A quiz only reveals which option was right once a vote is in, so the verdict is read
  // back from the message rather than assumed from the vote going through.
  const [fresh] = (await client
    .getMessages(chat, { ids: [prompt.id] })
    .catch(() => [])) as Api.Message[];
  const results = (fresh?.media as Api.MessageMediaPoll | undefined)?.results as
    | Api.PollResults
    | undefined;
  const mine = ((results?.results ?? []) as Api.PollAnswerVoters[]).find((r) =>
    Buffer.from(r.option as any).equals(Buffer.from(target!.option as any)),
  );
  const verdict =
    poll.quiz && mine?.chosen
      ? mine.correct
        ? `answered "${target.text}" (correct)`
        : `answered "${target.text}" (wrong)`
      : `voted "${target.text}"`;
  step.result = `${step.result} + ${verdict}`;
}

/** Presses a callback button and reports what came back, in step.result's voice. */
async function clickCallback(
  client: TelegramClient,
  peer: Api.TypeEntityLike,
  msgId: number,
  data: Buffer,
  step: CustomStepLog,
): Promise<string> {
  try {
    const answer = (await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer, msgId, data }),
    )) as Api.messages.BotCallbackAnswer;
    if (answer.message) step.callbackAnswer = answer.message;
    return "verified";
  } catch (err: any) {
    // The callback reached the bot but it never answered -- common for verification bots
    // that process the click without calling answerCallbackQuery. The click was delivered,
    // so treat the verification as done rather than failing the whole join.
    if (err?.message?.includes("BOT_RESPONSE_TIMEOUT")) return "verify clicked (no bot confirmation)";
    throw err;
  }
}

/**
 * The channel a verification prompt wants joined, read off one of its buttons. Only a
 * link to a channel itself counts: a link to a post inside one (`t.me/name/54`, the "wiki"
 * button these groups also post) is something to read, not something to join, and a
 * `?start=`/`?startapp=` link addresses the bot rather than a channel.
 */
export function channelToJoinFromUrl(
  url: string,
): { invite: string } | { username: string } | null {
  const invite = url.match(/t(?:elegram)?\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  if (invite) return { invite: invite[1] };
  if (/[?&]start(app)?=/i.test(url)) return null;
  const publicLink = url.match(/t(?:elegram)?\.me\/([A-Za-z]\w+)\/?(?:\?|$)/i);
  return publicLink ? { username: publicLink[1] } : null;
}

// Buttons a private verification prompt offers besides the one to press: an invite to a
// channel the bot then checks you subscribed to. Anything else it opens is not ours to open.
async function joinFromButtonUrl(client: TelegramClient, url: string): Promise<string | null> {
  const target = channelToJoinFromUrl(url);
  if (!target) return null;
  try {
    if ("invite" in target) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: target.invite }));
    } else {
      const entity = await client.getEntity(target.username);
      await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
    }
    return "joined channel";
  } catch (err: any) {
    if (err?.message?.includes("ALREADY_PARTICIPANT")) return "already in channel";
    if (err?.message?.includes("INVITE_REQUEST_SENT")) return "channel join pending approval";
    throw err;
  }
}

// Wording these bots use to say the verification passed, so a confirmed run says so
// instead of reporting a bare click.
const VERIFY_PASSED = /已通过|通过验证|验证成功|verified|success/i;
// A prompt pairs the button to press with ones that decline. Pressing the wrong one fails
// the verification outright, so an ambiguous prompt is reported rather than guessed at.
const VERIFY_DECLINE = /拒绝|取消|举报|cancel|reject|decline/i;
const VERIFY_CONFIRM = /验证|verify|完成|确认|done|confirm/i;

/**
 * The callback button to press on a verification prompt: a prompt offering one button
 * means that one, and a prompt offering several means the one worded as confirmation.
 * Returns undefined when the choice is unclear -- better to report that than to press
 * "拒绝" (or an admin's "通过") on someone's account.
 */
export function pressableVerifyButton(
  buttons: Api.TypeKeyboardButton[],
): Api.KeyboardButtonCallback | undefined {
  const callbacks = buttons.filter(
    (b): b is Api.KeyboardButtonCallback => !!(b as Api.KeyboardButtonCallback).data,
  );
  const pressable = callbacks.filter((b) => !VERIFY_DECLINE.test(b.text ?? ""));
  // Sole survivor of a longer list is not the same as a sole button: the admin controls
  // that ride along with these prompts leave "通过" standing once declines are dropped.
  if (callbacks.length === 1) return pressable[0];
  return pressable.find((b) => VERIFY_CONFIRM.test(b.text ?? ""));
}

/**
 * Everything the bot has said past minId, waiting up to maxMs for it. The listener is
 * attached before the history is scanned, so a bot that answers `/start` faster than the
 * round trip completes is caught by the scan rather than waited for until the timeout.
 */
async function repliesFromBot(
  client: TelegramClient,
  botUsername: string,
  minId: number,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message[]> {
  const waitAbort = new AbortController();
  const forwardAbort = () => waitAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const waiter = waitForButtonsInChat(
      client,
      botUsername,
      Math.max(0, maxMs),
      waitAbort.signal,
      minId,
    ).catch(() => [] as Api.Message[]);

    const scan = client
      .getMessages(botUsername, { limit: 10 })
      .then((ms) => (ms as Api.Message[]).filter((m) => m && !m.out && m.id > minId))
      .catch(() => [] as Api.Message[]);

    return await Promise.race([waiter, scan.then((m) => (m.length ? m : waiter))]);
  } finally {
    waitAbort.abort();
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Follows a group's "verify in a private chat" button the way a real client does: sends
 * `/start <payload>` to the bot, then works through what it replies with -- joining the
 * channel it asks for and pressing its verify button -- until it confirms or the budget runs out.
 */
async function verifyInPrivateChat(
  client: TelegramClient,
  startLink: { botUsername: string; startParam: string },
  step: CustomStepLog,
  remainingMs: () => number,
  signal?: AbortSignal,
): Promise<void> {
  const { botUsername, startParam } = startLink;
  const notes: string[] = [`deep link to @${botUsername}`];
  const say = () => {
    step.result = `${step.result} + ${notes.join(", ")}`;
  };

  const sent = await client.sendMessage(botUsername, { message: `/start ${startParam}` });
  let minId = sent.id;

  // The bot answers in rounds: a prompt, then a confirmation once its conditions are met.
  // Three is enough for the join-a-channel-then-verify shape without looping on a bot
  // that keeps re-posting the same prompt.
  for (let round = 0; round < 3; round++) {
    if (signal?.aborted) throw new Error("Job cancelled");
    if (remainingMs() <= 0) {
      notes.push("verification timed out");
      say();
      return;
    }

    const msgs = await repliesFromBot(client, botUsername, minId, remainingMs(), signal);

    // A confirmation carries no buttons, so check everything that arrived, not just prompts.
    if (msgs.some((m) => VERIFY_PASSED.test(m.message ?? ""))) {
      notes.push("verified in private chat");
      say();
      return;
    }

    const prompt = [...msgs].reverse().find((m) => hasInlineButtons(m));
    if (!prompt) {
      notes.push(round === 0 ? "bot sent no verification prompt" : "no further prompt");
      say();
      return;
    }
    minId = prompt.id;

    const flat = ((prompt as any).replyMarkup as Api.ReplyInlineMarkup).rows.flatMap(
      (r) => r.buttons,
    );

    // Satisfy the prompt's precondition first: these bots check the subscription when
    // the verify button is pressed, so joining afterwards would fail the check.
    for (const btn of flat) {
      const web = webButtonOf(btn);
      if (!web?.url || web.miniApp || web.startLink) continue;
      const joined = await joinFromButtonUrl(client, web.url).catch(() => null);
      if (joined) notes.push(joined);
    }

    const target = pressableVerifyButton(flat);
    if (!target) {
      notes.push("private prompt has no clear verify button");
      say();
      return;
    }

    const peer = await client.getInputEntity(botUsername);
    step.clickedButton = target.text;
    notes.push(await clickCallback(client, peer, prompt.id, target.data, step));

    // A pass usually lands as a follow-up message; give it what is left of the budget,
    // but never fail the join over a bot that simply stays quiet.
    const confirm = await waitForNewMessageInChat(
      client,
      botUsername,
      Math.min(15_000, Math.max(0, remainingMs())),
      signal,
    );
    if (confirm && VERIFY_PASSED.test(confirm.message ?? "")) {
      notes.push("verified in private chat");
      say();
      return;
    }
    if (!confirm) {
      say();
      return;
    }
    // Something else came back -- loop and let the next round read it.
  }
  say();
}

// Collects messages from the target until one has buttons or timeout fires.
// When successContains/failContains are set, checks message text to resolve or reject early.
// Watches new messages AND in-place edits; when sinceAnchor is given, also scans recent
// history so a reply that landed before the listener attached is not lost.
async function waitForReply(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  successContains?: string,
  failContains?: string,
  signal?: AbortSignal,
  minId = 0,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    const useTextMatch = !!(successContains || failContains);
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      if (useTextMatch) {
        reject(new Error(`Expected reply not received within ${maxMs}ms`));
      } else if (collected.length > 0) {
        resolve(collected);
      } else {
        reject(new Error(`No reply received within ${maxMs}ms`));
      }
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Replace an earlier copy on edit, otherwise append
    const upsert = (msg: Api.Message) => {
      const i = collected.findIndex((c) => c.id === msg.id);
      if (i >= 0) collected[i] = msg;
      else collected.push(msg);
    };

    const consider = (msg: Api.Message) => {
      if (done) return;
      upsert(msg);
      const text = msg.message ?? "";

      if (textSaysFail(text, failContains)) {
        cleanup();
        reject(
          new Error(`Reply indicates failure: "${expandDatePlaceholders(failContains ?? "")}" detected`),
        );
        return;
      }

      if (successContains) {
        if (matchesAnyLabel(text, successContains)) {
          cleanup();
          resolve(collected);
        }
        // Keep waiting for a message that matches the success text
        return;
      }

      // failContains only (no successContains) -- any non-fail message is a success
      if (failContains) {
        cleanup();
        resolve(collected);
        return;
      }

      // No text matching -- original behaviour: resolve immediately on buttons, else rely on timeout
      if (hasInlineButtons(msg)) {
        cleanup();
        resolve(collected);
      }
    };

    const handler = async (event: NewMessageEvent) =>
      consider(event.message as Api.Message);

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      consider(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: pick up replies delivered in the send-to-listen gap
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const missed = (recent as Api.Message[])
            .filter(
              (m) =>
                m &&
                !m.out &&
                m.id >= minId &&
                !collected.some((c) => c.id === m.id),
            )
            .reverse(); // process oldest first
          for (const m of missed) consider(m);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

// Waits specifically for a message with inline buttons from the target. Buttons may show
// up on a brand-new message OR via an in-place edit of an earlier one; when sinceAnchor is
// given, recent history is also scanned to cover the gap before the listeners attached.
// excludeId skips one known message (e.g. the one whose buttons we already tried).
// `filter` keeps the wait going until a buttons message the caller actually wants arrives.
async function waitForButtonsMessage(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
  excludeId?: number,
  filter?: ButtonsFilter,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      if (done) return;
      cleanup();
      if (!collected.some((c) => c.id === msg.id)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(noButtonsError(maxMs, filter)));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const wanted = (msg: Api.Message): boolean =>
      hasInlineButtons(msg) && (!filter || filter.accept(msg));

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if (wanted(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      if (wanted(msg)) succeed(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: a buttons message may have landed in the send-to-listen gap.
    // getMessages returns newest-first, so this seeds the most recent in-scope
    // match ("last available button").
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const seed = (recent as Api.Message[]).find(
            (m) =>
              m &&
              !m.out &&
              m.id !== excludeId &&
              m.id >= minId &&
              hasInlineButtons(m) &&
              (!filter || filter.accept(m)),
          );
          if (seed) succeed(seed);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

/**
 * The first step that cannot run without a target bot, or null when the job is fine as it
 * stands. A custom job need not target one: its steps can each name their own contact, or
 * drive a page that never touches Telegram. Checked up front rather than failing later on a
 * peer that cannot be resolved from "".
 *
 * `open_mini_app_url` is deliberately not on the list. It is handed a full address, and one
 * is openable without a bot to sign it -- a `t.me/<bot>/<app>` link names its own bot, an
 * https one may already carry its account data, and an app that signs its own users in
 * needs neither. Naming no bot is the operator saying so; the step opens the address on
 * this account's browser and exit, and says in the log that it went unsigned.
 */
export function stepNeedingBot(
  actions: CustomAction[],
  botUsername: string,
): { at: number; type: CustomAction["type"] } | null {
  if (botUsername.trim()) return null;
  const needsBot = (a: CustomAction): boolean => {
    switch (a.type) {
      // Both need to know whose: one hunts a button in a conversation, the other asks a
      // bot what it pins beside the composer. Neither has anything to work from otherwise.
      case "open_mini_app":
      case "open_bot_menu_app":
      // And this one reads a chat for the link it opens, so it needs to know whose.
      case "open_message_url":
        return !a.contact?.trim();
      case "open_mini_app_url":
      case "send_contact_message":
      case "join_group":
      case "subscribe_channel":
      case "open_url":
      case "delay":
      case "end_job":
      case "fail_job":
        return false;
      // The check needs one only to read a bot's chat; whatever its arms hold is asked the
      // same question, since a branch runs as ordinary steps once it is taken.
      case "if_check": {
        const armNeedsBot = (c: CustomCondition) =>
          c.check === "reply_text" && !c.contact?.trim();
        return (
          armNeedsBot(a) ||
          (a.elseIfs ?? []).some(armNeedsBot) ||
          branchesOf(a).some((branch) => branch.some(needsBot))
        );
      }
      default:
        return true;
    }
  };
  const at = actions.findIndex(needsBot);
  return at >= 0 ? { at, type: actions[at].type } : null;
}

/** Every arm of a check, the `else` included, so a walk can reach what they hold. */
function branchesOf(
  action: Extract<CustomAction, { type: "if_check" }>,
): CustomAction[][] {
  return [
    action.then ?? [],
    ...(action.elseIfs ?? []).map((arm) => arm.then ?? []),
    action.otherwise ?? [],
  ];
}

/** How deep checks may nest, so a config cannot fold itself into something unreadable. */
const MAX_ACTION_DEPTH = 3;

/**
 * Throws when checks nest past the cap. Done up front rather than part-way through a run:
 * a chain that would stop halfway is better refused before anything is sent.
 */
export function assertActionDepth(actions: CustomAction[], depth = 0): void {
  for (const action of actions) {
    if (action.type !== "if_check") continue;
    if (depth >= MAX_ACTION_DEPTH)
      throw new Error(`Checks cannot be nested more than ${MAX_ACTION_DEPTH} deep.`);
    for (const branch of branchesOf(action)) assertActionDepth(branch, depth + 1);
  }
}

/**
 * The one-line result of a Mini App action, which now has two kinds of step to account for:
 * the typed page steps that ran on the app, and the label steps that pressed things in it.
 * Written together so a run driven entirely by typed steps does not read as one where
 * nothing happened.
 */
function miniAppOutcome(
  opened: string,
  pressed: string | undefined,
  asked: number,
  ran: { outcome?: string }[] | undefined,
  suffix = "",
): string {
  const parts: string[] = [];
  if (asked) {
    const done = (ran ?? []).filter((s) => s.outcome).length;
    parts.push(`ran ${done}/${asked} page step${asked > 1 ? "s" : ""}`);
  }
  if (pressed) parts.push(`pressed "${pressed}"`);
  return parts.length
    ? `${opened}, ${parts.join(", ")}${suffix}`
    : `${opened} (nothing pressed inside the app)${suffix}`;
}

export async function runCustom(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  config: CustomConfig,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  webProxyUrl?: string,
  // Shared with the runner's outer retries, so an exit refused on an earlier attempt of
  // this run is not offered again and an action's browser budget spans its retries
  cfRun: CfRunState = newCfRunState(),
  // What the job (or its template) picked, so an action left on "follow the job's proxy"
  // draws from the same pool a random job pick draws from
  jobProxy: ProxyChoice = {},
  // Which account this run is for. The page steps need it twice over: `{accountPhone}` fills
  // a form in with whoever the run belongs to, and a `web_tg_api_save` writes back to it.
  account?: CustomRunAccount,
): Promise<CustomJobLog> {
  const log: CustomJobLog = { steps: [] };
  const jobMaxRetries = config.maxRetries ?? 1;

  /** The action's own pick when it has one, and the job's when it is left blank. */
  const proxyChoiceFor = (action: {
    proxyId?: string;
    proxyPool?: string[];
  }): { proxyId?: string; proxyPool?: string[] } =>
    action.proxyId
      ? { proxyId: action.proxyId, proxyPool: action.proxyPool }
      : { proxyId: jobProxy.proxyId, proxyPool: jobProxy.pool };

  assertActionDepth(config.actions ?? []);

  const missing = stepNeedingBot(config.actions ?? [], botUsername);
  if (missing) {
    throw new Error(
      `Step ${missing.at + 1} (${missing.type}) needs a target bot, but this job has none. ` +
        "Set one on the job, or give the step its own contact.",
    );
  }

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

  try {
    // Bounded: an unreachable proxy otherwise leaves this pending with nothing to cancel it,
    // which stalls the account and everything queued behind it.
    await connectWithTimeout(client, "custom job");

    let lastJobError: unknown = null;

    for (let jobAttempt = 1; jobAttempt <= jobMaxRetries; jobAttempt++) {
      if (signal?.aborted) throw new Error("Job cancelled");

      // State shared across actions within this job attempt
      let lastMessages: Api.Message[] = [];
      let lastButtonsMsg: Api.Message | null = null;
      let sendAnchor: SendAnchor | null = null;
      // Last message we sent to each specific contact, keyed by the trimmed
      // contact handle -- the scope anchor for click_message_button.
      const contactAnchors = new Map<string, SendAnchor>();

      /**
       * Everything the page sub-steps need that lives on this side of the browser: the vision
       * model, this job's own memory of what it has looped over, the notification bot, the
       * mailbox pool, the account's Telegram client, the data store.
       *
       * Built once and spread into every action that drives a page. A Mini App is a page too --
       * `open_mini_app` and its two siblings take the same typed steps as `open_url`, which is
       * the only way an app sequence gets a branch or a step that may fail without ending the
       * run -- so all four hand the solver the same hooks rather than each growing its own copy.
       */
      const pageStepHooks = (): Partial<LoadOptions> => ({
      // The vision model lives on this side of the browser, so the page steps
      // reach it through a callback rather than the solver importing it
      // One picture or several -- a picture captcha's example and its grid go together --
      // and a token budget the caller sets, since nine tile verdicts do not fit in the
      // default
      aiLocate: async (images, prompt, maxTokens) => {
        const { response } = await callAI(
          Array.isArray(images) ? images : [images],
          prompt,
          maxTokens ?? 512,
        );
        return response;
      },
      // Same reason: what this job has already looped over lives in the
      // database, which the browser side does not reach into
      usedValues: (varName) => usedWebValues(cfRun.jobId, varName),
      markUsed: (varName, value) =>
        rememberWebValue(cfRun.jobId, varName, value),
      // And the same again for a `web_notify` step: the bot token and the chat
      // to send to are settings, which the browser side does not read. Sent
      // outright rather than through notifyJobEvent -- a step that says to send
      // is an instruction, not something the success/failure switches govern.
      notify: async (text, target) => {
        const cfg = getNotifyConfig();
        if (!cfg.botToken)
          throw new Error("no notification bot token is set (see Settings)");
        const chat = target?.trim() || cfg.botTarget;
        if (!chat)
          throw new Error(
            "no chat to send to: set a default in Settings, or name one on the step",
          );
        await sendBotNotify(cfg.botToken, chat, text);
      },
      // And once more for a `web_email_code` step: the app password is a stored
      // secret and the msOauth2api credentials are settings, neither of which the
      // browser side reads. The config carries the name of a secret
      // (`{gmailAppPassword}`) and it is resolved here.
      emailCode: async (q) => {
        if (q.source === "msapi") {
          const found = await pollForCode({
            email: q.email,
            type: q.poolType,
            fromContains: q.fromContains,
            subjectContains: q.subjectContains,
            waitMs: q.waitMs,
            signal,
          });
          return found
            ? {
                code: found.code,
                subject: found.subject ?? "",
                from: found.from ?? "",
                mailbox: found.mailbox,
              }
            : null;
        }
        const missing = missingSecretRefs(q.appPasswordRef ?? "");
        if (missing.length)
          throw new Error(
            `no secret is stored under ${missing.map((m) => `{${m}}`).join(", ")} (see Settings)`,
          );
        const appPassword = fillSecrets(q.appPasswordRef ?? "").trim();
        if (!appPassword) throw new Error("the app-password secret is empty");
        return fetchGmailCode({
          email: q.email,
          appPassword,
          fromContains: q.fromContains,
          subjectContains: q.subjectContains,
          pattern: q.pattern,
          waitMs: q.waitMs,
          // Look a little before now, so a code sent by an earlier step counts
          sinceMs: Date.now() - EMAIL_CODE_LOOKBACK_MS,
        });
      },
      // And for a `web_email_link` step, which reads the mail itself rather than
      // asking the service for a code: a signup that confirms by link has nothing
      // to type, and the URL is in the message body
      emailLink: async (q) => {
        const found = await pollForLink({
          email: q.email,
          type: q.poolType,
          fromContains: q.fromContains,
          subjectContains: q.subjectContains,
          urlContains: q.urlContains,
          waitMs: q.waitMs,
          signal,
        });
        return found
          ? {
              url: found.url,
              subject: found.subject ?? "",
              from: found.from ?? "",
              mailbox: found.mailbox,
            }
          : null;
      },
      // And for a `web_email_lease` step: which pool to draw from, and the key to
      // draw with, are settings this side reads
      emailLease: async (q) => leaseEmail(q.poolType, signal),
      // And for a `web_tg_code` step: my.telegram.org posts its login code to
      // the account inside Telegram, so the client this job is already running
      // on is what reads it -- nothing about it reaches the browser
      tgCode: async (q) =>
        waitForTgLoginCode({
          client,
          sinceMs: Date.now(),
          pattern: q.pattern,
          waitMs: q.waitMs,
          signal,
        }),
      // And for a `web_tg_send` step: the page shows a command the account itself
      // has to send (a site linking a Telegram account reads who sent it), so it
      // goes out on this same client while the page stays open
      tgSend: async (q) => {
        const entity = await resolvePeerTarget(client, q.contact);
        const sent = await client.sendMessage(entity, {
          message: q.text,
        });
        contactAnchors.set(q.contact, anchorFromSent(sent));
        if (!q.waitMs) return {};
        // Polled rather than event-driven, as the login-code step is: only what
        // came back to the message just sent counts (`minId`), and a bot that
        // answers in two goes gets until the deadline to say the wording asked
        // for rather than the first line settling it
        const deadline = Date.now() + q.waitMs;
        let latest: string | undefined;
        for (;;) {
          if (signal?.aborted) throw new Error("Job cancelled");
          const msgs = (await client
            .getMessages(entity, { limit: 5, minId: sent.id })
            .catch(() => [])) as Api.Message[];
          // Oldest first, so a two-part answer reads in the order it was said
          for (const msg of [...msgs].reverse()) {
            const text = (msg?.message ?? "").trim();
            if (!text || msg.out) continue;
            latest = text;
            if (matchesAnyLabel(text, q.replyContains)) return { reply: text };
          }
          const left = deadline - Date.now();
          if (left <= 0) break;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(3000, left)),
          );
        }
        if (q.replyContains)
          throw new Error(
            `${q.contact} did not reply with "${q.replyContains}" within ` +
              `${Math.round(q.waitMs / 1000)}s` +
              (latest ? `; it said "${latest.slice(0, 120)}"` : ""),
          );
        return { reply: latest };
      },
      // And for a `web_job_handover`: which job is running is this side's to know,
      // and the row it rewrites is one the browser side never sees
      jobHandover: async (q) => {
        // A debug or manual-browser run belongs to no job, so there is no row to
        // point anywhere -- said plainly rather than rewriting whatever id turns up
        if (!cfRun.jobId) throw new Error("this run has no job to hand over");
        return handOverJob({
          jobId: cfRun.jobId,
          template: q.template,
          name: q.name,
          enabled: q.enabled,
        });
      },
      // And for a `web_tg_api_save`: which account the run belongs to, and how
      // its api_hash is stored, is this side's business
      saveTgApi: async (creds) => {
        if (!account)
          throw new Error(
            "this run has no account to save credentials to",
          );
        return saveAccountApiCredentials({
          accountId: account.id,
          ...creds,
        });
      },
      // And for the `web_ms_oauth2_start` / `web_ms_oauth2` pair: the service's
      // base URL and API key are settings, which the browser side never reads.
      // Nothing about the OAuth2 application is Bemby's business any more --
      // msOauth2api owns the registration and does the exchange on its callback.
      msOauth2Start: async (q) => {
        const flow = await startOauthFlow(q.email, q.authType, signal);
        return { authorizeUrl: flow.authorizeUrl, redirectUri: flow.redirectUri };
      },
      msOauth2Verify: async (q) => accountStatus(q.email, signal),
      // What the steps start with: one template drives my.telegram.org for every
      // account linked to it, and the phone is the only thing that differs.
      // `{jobId}` for the same reason a profile name takes one -- a site's
      // credentials filed under the job that signs in with them are reachable as
      // `{data.folder.{jobId}.password}`, so one template covers every job
      webVars: {
        jobId: String(cfRun.jobId),
        ...(account
          ? { accountPhone: account.phoneNumber, accountName: account.name }
          : {}),
      },
      });

      let jobAttemptFailed = false;
      // Set by `end_job`: the chain is finished and the run counts as a success, so neither
      // the actions left nor another job attempt should follow.
      let jobDone = false;
      // How the last action that was not itself a check came out, which `last_action` reads.
      // Null until something has run, so a check placed first says so rather than guessing.
      let lastActionOk: boolean | null = null;

      /**
       * Answers one arm of an `if_check`, and says what it looked at so the log reads as the
       * question that was asked rather than just its answer.
       */
      const evaluateCondition = async (
        cond: CustomCondition,
      ): Promise<{ met: boolean; what: string }> => {
        if (cond.check === "last_action") {
          const wanted = cond.outcome ?? "failed";
          if (lastActionOk === null)
            return { met: false, what: `the step before came out ${wanted} (nothing ran before it)` };
          return {
            met: wanted === "succeeded" ? lastActionOk : !lastActionOk,
            what: `the step before came out ${wanted}`,
          };
        }

        const wanted = cond.text?.trim() ?? "";
        if (!wanted) throw new Error("No words given to look for in the reply");
        const contact = cond.contact?.trim();
        const peer = contact || botUsername;
        if (!peer)
          throw new Error("No contact to read a reply from, and the job has no bot");
        const what = `"${wanted}" in ${contact ? `@${contact}'s reply` : "the reply"}`;

        const anchor = contact ? contactAnchors.get(contact) : sendAnchor;
        const minId = await resolveScopeFloor(
          client,
          peer,
          anchor?.msgId ?? 0,
          cond.scope,
        );

        let msgs: Api.Message[];
        if (cond.waitMs && cond.waitMs > 0) {
          // A wait that runs out is the condition not being met, not a failure: deciding
          // which arm to take is the whole job of this step.
          msgs = await waitForReply(
            client,
            peer,
            cond.waitMs,
            wanted,
            undefined,
            signal,
            minId,
          ).catch((err: any) => {
            if (err?.message === "Job cancelled") throw err;
            return [] as Api.Message[];
          });
        } else if (!contact && lastMessages.length) {
          // What a `wait_reply` or a button click already captured, so the usual "check what
          // the bot just said" costs no round trip
          msgs = lastMessages;
        } else {
          msgs = (await client
            .getMessages(peer, { limit: 10 })
            .catch(() => [])) as Api.Message[];
          msgs = msgs.filter((m) => m && !m.out && m.id >= minId);
        }
        if (msgs.length && !contact) lastMessages = msgs;
        return { met: msgs.some((m) => matchesAnyLabel(m.message ?? "", wanted)), what };
      };

      // Actions still to run this attempt. The arm an `if_check` takes is spliced in where
      // the check sat, so one flat loop runs a nested chain -- the alternative, recursing
      // through the switch below, would have to carry all the conversation state above with
      // it. `config.actions` is never touched, so the next attempt starts from the config.
      const queue: CustomAction[] = [...(config.actions ?? [])];
      // Where each queued action sits in the nesting, for the log to indent by
      const depths: number[] = queue.map(() => 0);
      let stepSeq = 0;

      for (let i = 0; i < queue.length; i++) {
        if (signal?.aborted) throw new Error("Job cancelled");

        const action = queue[i];
        const depth = depths[i] ?? 0;
        const stepNo = ++stepSeq;
        const actionMaxRetries =
          action.type !== "delay" && "maxRetries" in action
            ? (action.maxRetries ?? 0)
            : 0;

        let actionSucceeded = false;

        for (
          let actionAttempt = 1;
          actionAttempt <= actionMaxRetries + 1 && !actionSucceeded;
          actionAttempt++
        ) {
          const step: CustomStepLog = {
            step: stepNo,
            actionType: action.type,
            label: "",
            ...(depth > 0 ? { depth } : {}),
            ...(jobMaxRetries > 1 ? { jobAttempt } : {}),
            ...(actionMaxRetries > 0 ? { actionAttempt } : {}),
          };
          log.steps.push(step);
          const t0 = Date.now();

          try {
            switch (action.type) {
              case "enter_captcha": {
                const lengthHint = action.captchaLength
                  ? ` (${action.captchaLength} chars)`
                  : "";
                step.label = `Enter captcha${lengthHint}`;
                let msgs: Api.Message[];
                if (lastMessages.length > 0) {
                  msgs = lastMessages;
                } else {
                  msgs = await waitForReply(
                    client,
                    botUsername,
                    action.maxWaitMs,
                    undefined,
                    undefined,
                    signal,
                    sendAnchor ? sendAnchor.msgId + 1 : 0,
                  );
                  lastMessages = msgs;
                }
                const parsed = await parseMessages(msgs, client, signal);
                if (parsed.html) step.preClickHtml = parsed.html;
                if (parsed.images[0]) step.preClickImage = parsed.images[0];
                if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
                step.aiPrompt = buildCaptchaPrompt(action.captchaLength);
                const aiStart = Date.now();
                const aiResult = await recognizeCaptchaWithAI(
                  parsed.images,
                  action.captchaLength,
                )
                  .then((r) => {
                    step.aiResponse = r.response;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });
                if (
                  action.captchaLength &&
                  aiResult.text.length !== action.captchaLength
                ) {
                  throw new Error(
                    `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${action.captchaLength}`,
                  );
                }
                const sentCaptcha = await client.sendMessage(botUsername, {
                  message: aiResult.text,
                });
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCaptcha);
                step.result = `Sent: "${aiResult.text}"`;
                break;
              }

              case "send_command": {
                const content = await fillAiInput(
                  client,
                  lastMessages,
                  action.content,
                  step,
                  signal,
                );
                const expanded = expandCommand(content);
                step.label = `Send: "${expanded}"`;
                const sentCmd = await client.sendMessage(botUsername, {
                  message: expanded,
                });
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCmd);
                step.result = "Sent";
                break;
              }

              case "send_contact_message": {
                const contact = action.contact.trim();
                const entity = await resolvePeerTarget(client, contact);
                const content = await fillAiInput(
                  client,
                  lastMessages,
                  action.content,
                  step,
                  signal,
                );
                const expanded = expandCommand(content);
                step.label = `Send to ${contact}: "${expanded}"`;
                const sentContact = await client.sendMessage(entity, {
                  message: expanded,
                });
                contactAnchors.set(contact, anchorFromSent(sentContact));
                step.result = "Sent";
                break;
              }

              case "wait_reply": {
                const { successContains, failContains } = action;
                // Shown expanded, so the log says which date the run was actually looking for
                const hints = [
                  successContains ? `success: "${expandDatePlaceholders(successContains)}"` : "",
                  failContains ? `fail: "${expandDatePlaceholders(failContains)}"` : "",
                ]
                  .filter(Boolean)
                  .join(", ");
                step.label = `Wait reply (max ${action.maxWaitMs}ms)${hints ? ` [${hints}]` : ""}`;
                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                const msgs = await waitForReply(
                  client,
                  botUsername,
                  action.maxWaitMs,
                  successContains,
                  failContains,
                  signal,
                  minId,
                );
                lastMessages = msgs;
                step.msgCount = msgs.length;
                const btnMsg =
                  [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                if (btnMsg) lastButtonsMsg = btnMsg;
                const parsed = await parseMessages(msgs, client, signal);
                step.responseHtml = parsed.html || undefined;
                step.responseImage = parsed.images[0];
                step.responseHasMedia = parsed.hasMedia || undefined;
                step.responseButtons = parsed.buttons.length
                  ? parsed.buttons
                  : undefined;
                step.result = `Received ${msgs.length} message(s)`;
                break;
              }

              case "delay": {
                step.label = `Delay ${action.waitMs}ms`;
                await new Promise<void>((res, rej) => {
                  if (signal?.aborted) {
                    rej(new Error("Job cancelled"));
                    return;
                  }
                  const timer = setTimeout(res, action.waitMs);
                  signal?.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(timer);
                      rej(new Error("Job cancelled"));
                    },
                    { once: true },
                  );
                });
                step.result = "Done";
                break;
              }

              case "if_check": {
                const arms: Array<{ cond: CustomCondition; then?: CustomAction[] }> = [
                  { cond: action, then: action.then },
                  ...(action.elseIfs ?? []).map((arm) => ({ cond: arm, then: arm.then })),
                ];
                const asked: string[] = [];
                let taken: { at: number; actions: CustomAction[] } | null = null;
                for (let a = 0; a < arms.length && !taken; a++) {
                  const { cond } = arms[a];
                  const { met, what } = await evaluateCondition(cond);
                  asked.push(cond.negate ? `not ${what}` : what);
                  if (cond.negate ? !met : met)
                    taken = { at: a, actions: arms[a].then ?? [] };
                }
                const branch = taken ? taken.actions : (action.otherwise ?? []);
                const which = !taken
                  ? "else"
                  : taken.at === 0
                    ? "then"
                    : `else if ${taken.at}`;
                step.label = `Check ${asked.join(", then ")}`;
                step.result = branch.length
                  ? `Took the ${which} branch, running ${branch.length} action(s)`
                  : `Took the ${which} branch, which holds nothing`;
                if (branch.length) {
                  queue.splice(i + 1, 0, ...branch);
                  depths.splice(i + 1, 0, ...branch.map(() => depth + 1));
                }
                break;
              }

              case "end_job": {
                step.label = "End the job as a success";
                step.result = action.reason?.trim() || "Chain ended early";
                jobDone = true;
                break;
              }

              case "fail_job": {
                step.label = "Fail the job";
                throw new Error(action.reason?.trim() || "Chain failed by a fail step");
              }

              case "click_button": {
                step.label = `Click button "${action.button}"`;
                const waitLeft = waitBudget(action.maxWaitMs);

                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                // Ignore a cached buttons message that falls outside the scope
                // (e.g. a menu from before the command we just sent).
                let buttonsMsg: Api.Message | null =
                  lastButtonsMsg && lastButtonsMsg.id >= minId
                    ? lastButtonsMsg
                    : null;
                let preClickImages: string[] = [];
                if (buttonsMsg) {
                  // The bot may have edited the message since we captured it (swapped or
                  // added buttons); refresh so we click against the current markup
                  const currentId: number = buttonsMsg.id;
                  const fresh: Api.Message | null = await client
                    .getMessages(botUsername, { ids: [currentId] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                  if (hasInlineButtons(fresh)) {
                    buttonsMsg = fresh;
                    lastButtonsMsg = fresh;
                  }
                }
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsMessage(
                    client,
                    botUsername,
                    waitLeft(),
                    signal,
                    minId,
                  );
                  lastMessages = msgs;
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                  if (buttonsMsg) lastButtonsMsg = buttonsMsg;
                  const preParsed = await parseMessages(msgs, client, signal);
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  if (!step.preClickHtml && !preClickImages.length) {
                    const parsed = await parseMessages(
                      [buttonsMsg],
                      client,
                      signal,
                    );
                    if (parsed.html) step.preClickHtml = parsed.html;
                    if (parsed.images.length) {
                      step.preClickImage = parsed.images[0];
                      preClickImages = parsed.images;
                    }
                    if (parsed.hasMedia)
                      step.preClickHasMedia = parsed.hasMedia;
                    if (parsed.buttons.length)
                      step.preClickButtons = parsed.buttons;
                  }
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                const peer = await client.getInputEntity(botUsername);
                const botPeerId = await client.getPeerId(botUsername);
                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs: Api.Message[] | null =
                        await waitForButtonsMessage(
                          client,
                          botUsername,
                          waitLeft(),
                          signal,
                          minId,
                          buttonsMsg?.id,
                        ).catch(() => null);
                      if (msgs) {
                        lastMessages = msgs;
                        const bm: Api.Message | undefined = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) {
                          buttonsMsg = bm;
                          lastButtonsMsg = bm;
                        }
                      }
                    }
                  }

                  // The target may already have arrived on an earlier follow-up (e.g.
                  // a "Verify" prompt sent alongside other messages), so it isn't the
                  // "current" buttons message. Scan recent history before matching.
                  if (!markupContainsTarget(buttonsMsg)) {
                    const recent = (await client
                      .getMessages(botUsername, { limit: 8 })
                      .catch(() => [])) as Api.Message[];
                    const hit = recent.find((m) => markupContainsTarget(m));
                    if (hit) {
                      buttonsMsg = hit;
                      lastButtonsMsg = hit;
                    }
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                      // "Verify", a "打开小程序签到" app) carries the web address; open it
                      // in a browser to pass the Cloudflare check.
                      const web = webButtonOf(btn);
                      if (web) {
                        const opened = await openWebButton(
                          client, web, botUsername, buttonsMsg, step,
                        );
                        const cfText = opened.text;
                        // Following a deep link starts a private chat with that bot;
                        // re-anchor so a later wait_reply looks past this send
                        if (opened.deepLinkSent) {
                          const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                          const anchor = anchorFromSent(sentMsg);
                          if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                            sendAnchor = anchor;
                          }
                          contactAnchors.set(linkBot, anchor);
                          contactAnchors.set(`@${linkBot}`, anchor);
                        }
                        clicked = true;
                        step.clickedButton = btnText;
                        // A deep-link button records its own result inside openWebButton
                        if (!step.result) step.result = `Opened "${btnText}"`;
                        if (textSaysFail(cfText, action.failContains)) {
                          throw new Error(`Reply indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                        }
                        if (!textSaysSuccess(cfText, action.successContains)) {
                          throw new Error(`Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in response`);
                        }
                        break;
                      }

                      // Abort controller scoped to this click attempt -- prevents stale listeners
                      // from interfering with later steps if GetBotCallbackAnswer throws.
                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        waitLeft(),
                        clickAbort.signal,
                        botPeerId,
                      );
                      const newMsgPromise = waitForNewBotMessage(
                        client,
                        botUsername,
                        waitLeft(),
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message, or acted via a Cloudflare page).
                        // Fall through and let the edit/new-message watchers below decide.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // Bots often edit the clicked message AND send a follow-up; when the
                      // first response carries no buttons, give the other source a short
                      // window -- the next step's buttons are usually there
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        lastMessages = responses.map((r) => r.msg);
                        if (hasInlineButtons(primary.msg))
                          lastButtonsMsg = primary.msg;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        lastMessages = [fresh!];
                        if (hasInlineButtons(fresh)) lastButtonsMsg = fresh;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A URL in the reply is left alone: this action clicks inside
                      // Telegram, and a page belongs to an action built around a browser.
                      const cfText = '';

                      // Check success/fail text in callback answer, response, or CF page
                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                        if (textSaysFail(texts, action.failContains)) {
                          throw new Error(`Reply indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                        }
                        if (!textSaysSuccess(texts, action.successContains)) {
                          throw new Error(`Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "click_message_button": {
                const contact = action.contact.trim();
                step.label = `Click button "${action.button}" from ${contact}`;
                const waitLeft = waitBudget(action.maxWaitMs);

                const entity = await resolvePeerTarget(client, contact);
                const peer = await client.getInputEntity(entity);
                const chatPeerId = await client.getPeerId(entity);

                const minId = await resolveScopeFloor(
                  client,
                  entity,
                  contactAnchors.get(contact)?.msgId ?? 0,
                  action.scope,
                );
                const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
                  msgs.find((m) => m.id >= minId && hasInlineButtons(m)) ?? null;

                // Seed from the contact's most recent messages (newest first); otherwise wait
                // for an incoming message carrying buttons.
                let buttonsMsg: Api.Message | null = findButtonsMsg(
                  (await client.getMessages(entity, { limit: 10 })) as Api.Message[],
                );
                let preClickImages: string[] = [];
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsInChat(
                    client,
                    entity,
                    waitLeft(),
                    signal,
                    minId,
                  );
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                }
                if (buttonsMsg) {
                  const preParsed = await parseMessages(
                    [buttonsMsg],
                    client,
                    signal,
                  );
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(entity, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) buttonsMsg = fresh;
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs = await waitForButtonsInChat(
                        client,
                        entity,
                        waitLeft(),
                        signal,
                        minId,
                      ).catch(() => null);
                      if (msgs) {
                        const bm = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) buttonsMsg = bm;
                      }
                    }
                  }

                  // The target may already have arrived on an earlier follow-up, so it
                  // isn't the "current" buttons message. Scan recent chat history.
                  if (!markupContainsTarget(buttonsMsg)) {
                    const recent = (await client
                      .getMessages(entity, { limit: 8 })
                      .catch(() => [])) as Api.Message[];
                    const hit = recent.find((m) => markupContainsTarget(m));
                    if (hit) buttonsMsg = hit;
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                      // "Verify", a "打开小程序签到" app) carries the web address; open it
                      // in a browser to pass the Cloudflare check.
                      const web = webButtonOf(btn);
                      if (web) {
                        const opened = await openWebButton(
                          client, web, entity, buttonsMsg, step,
                        );
                        const cfText = opened.text;
                        // Following a deep link starts a private chat with that bot;
                        // re-anchor so a later wait_reply looks past this send
                        if (opened.deepLinkSent) {
                          const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                          const anchor = anchorFromSent(sentMsg);
                          if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                            sendAnchor = anchor;
                          }
                          contactAnchors.set(linkBot, anchor);
                          contactAnchors.set(`@${linkBot}`, anchor);
                        }
                        clicked = true;
                        step.clickedButton = btnText;
                        // A deep-link button records its own result inside openWebButton
                        if (!step.result) step.result = `Opened "${btnText}"`;
                        if (textSaysFail(cfText, action.failContains)) {
                          throw new Error(`Reply indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                        }
                        if (!textSaysSuccess(cfText, action.successContains)) {
                          throw new Error(`Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in response`);
                        }
                        break;
                      }

                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        waitLeft(),
                        clickAbort.signal,
                        chatPeerId,
                      );
                      const newMsgPromise = waitForNewMessageInChat(
                        client,
                        entity,
                        waitLeft(),
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message, or acted via a Cloudflare page).
                        // Fall through and let the edit/new-message watchers below decide.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // When the first response carries no buttons, give the other source
                      // a short window in case it delivers the next step's buttons
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        const parsed = await parseMessages(
                          responses.map((r) => r.msg),
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(entity, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        const parsed = await parseMessages(
                          [fresh!],
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A URL in the reply is left alone: this action clicks inside
                      // Telegram, and a page belongs to an action built around a browser.
                      const cfText = '';

                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                        if (textSaysFail(texts, action.failContains)) {
                          throw new Error(`Reply indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                        }
                        if (!textSaysSuccess(texts, action.successContains)) {
                          throw new Error(`Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "ai_multiple_btn": {
                const contact = action.contact?.trim() ?? "";
                const botMode = contact.length === 0;
                // Pins the action to one wording so an unrelated menu in the same
                // chat is never the one the AI clicks.
                const mustContain = action.messageContains?.trim() || undefined;
                const buttonsFilter: ButtonsFilter | undefined = mustContain
                  ? {
                      accept: (m) => msgTextMatches(m, mustContain),
                      describe: `containing "${mustContain}"`,
                    }
                  : undefined;
                step.label = botMode
                  ? "AI multi-click buttons"
                  : `AI multi-click buttons from ${contact}`;

                // Chat context: the job's bot by default, otherwise a named contact.
                const target: Api.TypeEntityLike = botMode
                  ? botUsername
                  : await resolvePeerTarget(client, contact);
                const peer = await client.getInputEntity(target);
                const editPeerId = await client.getPeerId(target);
                const anchor = botMode
                  ? sendAnchor
                  : (contactAnchors.get(contact) ?? null);
                const minId = await resolveScopeFloor(
                  client,
                  target,
                  anchor?.msgId ?? 0,
                  action.scope,
                );

                const refetch = (id: number): Promise<Api.Message | null> =>
                  client
                    .getMessages(target, { ids: [id] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                let waitLeft = waitBudget(action.maxWaitMs);
                const waitButtons = (
                  excludeId?: number,
                ): Promise<Api.Message[]> =>
                  botMode
                    ? waitForButtonsMessage(
                        client,
                        botUsername,
                        waitLeft(),
                        signal,
                        minId,
                        excludeId,
                        buttonsFilter,
                      )
                    : waitForButtonsInChat(
                        client,
                        target,
                        waitLeft(),
                        signal,
                        minId,
                        buttonsFilter,
                      );
                const waitNewMsg = (
                  timeoutMs: number,
                ): Promise<Api.Message | null> =>
                  botMode
                    ? waitForNewBotMessage(
                        client,
                        botUsername,
                        timeoutMs,
                        signal,
                      )
                    : waitForNewMessageInChat(
                        client,
                        target,
                        timeoutMs,
                        signal,
                      );

                // ── Obtain the message carrying the buttons ──
                let buttonsMsg: Api.Message | null = null;
                let preClickImages: string[] = [];
                if (botMode) {
                  buttonsMsg =
                    lastButtonsMsg && lastButtonsMsg.id >= minId
                      ? lastButtonsMsg
                      : null;
                  if (buttonsMsg) {
                    const fresh = await refetch(buttonsMsg.id);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                    // Carried-over menu isn't the one this action targets: wait for it.
                    if (!msgTextMatches(buttonsMsg, mustContain))
                      buttonsMsg = null;
                  }
                } else {
                  const recent = (await client.getMessages(target, {
                    limit: 10,
                  })) as Api.Message[];
                  buttonsMsg =
                    recent.find(
                      (m) =>
                        m.id >= minId &&
                        hasInlineButtons(m) &&
                        msgTextMatches(m, mustContain),
                    ) ?? null;
                }
                if (!buttonsMsg) {
                  const msgs = await waitButtons();
                  if (botMode) lastMessages = msgs;
                  buttonsMsg =
                    [...msgs]
                      .reverse()
                      .find(
                        (m) =>
                          hasInlineButtons(m) &&
                          msgTextMatches(m, mustContain),
                      ) ?? null;
                  if (buttonsMsg && botMode) lastButtonsMsg = buttonsMsg;
                }
                if (!buttonsMsg)
                  throw new Error(
                    mustContain
                      ? `No message with buttons containing "${mustContain}" available`
                      : "No message with buttons available",
                  );

                const preParsed = await parseMessages(
                  [buttonsMsg],
                  client,
                  signal,
                );
                if (preParsed.html) step.preClickHtml = preParsed.html;
                if (preParsed.images.length) {
                  step.preClickImage = preParsed.images[0];
                  preClickImages = preParsed.images;
                }
                if (preParsed.hasMedia) step.preClickHasMedia = preParsed.hasMedia;
                if (preParsed.buttons.length)
                  step.preClickButtons = preParsed.buttons;

                // ── AI picks the ordered list of buttons to click ──
                const buttonRows: string[][] = (
                  (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                ).rows.map((row) => row.buttons.map((b: any) => b.text as string));
                const aiStart = Date.now();
                const aiResult = await selectMultipleButtonsWithAI(
                  buttonRows,
                  step.preClickHtml ?? buttonsMsg.message ?? "",
                  preClickImages,
                  action.hint,
                  action.maxRetries,
                )
                  .then((r) => {
                    step.aiPrompt = r.prompt;
                    step.aiResponse = r.response;
                    if (r.retries.length) step.aiRetries = r.retries;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });

                // Clicks one button by exact text against the current message, refreshing the
                // markup on retry, and advances buttonsMsg to the reply so the next click sees
                // the updated markup. Throws if the button never clicks (aborts the action).
                const clickTarget = async (
                  targetText: string,
                ): Promise<{ clickedText: string; responseText: string }> => {
                  // Each button in the sequence gets its own budget.
                  waitLeft = waitBudget(action.maxWaitMs);
                  let clicked = false;
                  let retryCount = 0;
                  let clickedText = "";
                  let responseText = "";

                  const markupHasTarget = (m: Api.Message | null): boolean =>
                    hasInlineButtons(m) &&
                    (
                      (m as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows.some((row) =>
                      row.buttons.some(
                        (b: any) => ((b.text as string) ?? "") === targetText,
                      ),
                    );

                  for (
                    let attempt = 0;
                    attempt <= action.maxRetries && !clicked;
                    attempt++
                  ) {
                    if (attempt > 0) {
                      retryCount = attempt;
                      const fresh = await refetch(buttonsMsg!.id);
                      if (hasInlineButtons(fresh)) {
                        buttonsMsg = fresh;
                        if (botMode) lastButtonsMsg = fresh;
                      }
                      if (!markupHasTarget(buttonsMsg)) {
                        const msgs = await waitButtons(buttonsMsg?.id).catch(
                          () => null,
                        );
                        if (msgs) {
                          if (botMode) lastMessages = msgs;
                          const bm = [...msgs]
                            .reverse()
                            .find(
                              (m) =>
                                hasInlineButtons(m) &&
                                msgTextMatches(m, mustContain),
                            );
                          if (bm) {
                            buttonsMsg = bm;
                            if (botMode) lastButtonsMsg = bm;
                          }
                        }
                      }
                    }

                    const rows = (
                      (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows;
                    for (const row of rows) {
                      for (const btn of row.buttons) {
                        const btnText = (btn as any).text as string;
                        if (btnText !== targetText) continue;

                        const clickAbort = new AbortController();
                        const forwardAbort = () => clickAbort.abort();
                        signal?.addEventListener("abort", forwardAbort, {
                          once: true,
                        });

                        const editPromise = waitForBotMessageEdit(
                          client,
                          buttonsMsg!.id,
                          waitLeft(),
                          clickAbort.signal,
                          editPeerId,
                        );
                        const newMsgPromise = waitNewMsg(waitLeft());

                        const callbackData = (btn as Api.KeyboardButtonCallback)
                          .data;
                        const preClickEditDate = (buttonsMsg as any).editDate as
                          | number
                          | undefined;
                        let answer: Api.messages.BotCallbackAnswer | null = null;
                        let callbackTimedOut = false;
                        try {
                          answer = (await client.invoke(
                            new Api.messages.GetBotCallbackAnswer({
                              peer,
                              msgId: buttonsMsg!.id,
                              data: callbackData,
                            }),
                          )) as Api.messages.BotCallbackAnswer;
                        } catch (err: any) {
                          if (
                            !err?.message?.includes("BOT_RESPONSE_TIMEOUT")
                          ) {
                            clickAbort.abort();
                            signal?.removeEventListener("abort", forwardAbort);
                            throw err;
                          }
                          callbackTimedOut = true;
                        }

                        if (answer?.message)
                          step.callbackAnswer = answer.message;
                        clicked = true;
                        step.retryCount = retryCount;

                        const taggedEdit = editPromise.then((m) => ({
                          msg: m,
                          src: "edit" as const,
                        }));
                        const taggedNew = newMsgPromise.then((m) => ({
                          msg: m,
                          src: "new_message" as const,
                        }));
                        const first = await Promise.race([
                          taggedEdit,
                          taggedNew,
                        ]);
                        let second:
                          | {
                              msg: Api.Message | null;
                              src: "edit" | "new_message";
                            }
                          | null = null;
                        if (first.msg && !hasInlineButtons(first.msg)) {
                          const other =
                            first.src === "edit" ? taggedNew : taggedEdit;
                          second = await Promise.race([
                            other,
                            new Promise<null>((r) =>
                              setTimeout(() => r(null), 1_500),
                            ),
                          ]);
                        }
                        clickAbort.abort();
                        signal?.removeEventListener("abort", forwardAbort);

                        const responses = [first, second].filter(
                          (
                            r,
                          ): r is {
                            msg: Api.Message;
                            src: "edit" | "new_message";
                          } => !!r?.msg && !signal?.aborted,
                        );
                        if (responses.length) {
                          const primary =
                            responses.find((r) => hasInlineButtons(r.msg)) ??
                            responses[0];
                          step.responseSource = primary.src;
                          if (hasInlineButtons(primary.msg)) {
                            buttonsMsg = primary.msg;
                            if (botMode) lastButtonsMsg = primary.msg;
                          }
                          if (botMode)
                            lastMessages = responses.map((r) => r.msg);
                          const parsed = await parseMessages(
                            responses.map((r) => r.msg),
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        if (callbackTimedOut && !responses.length) {
                          const fresh = await refetch(buttonsMsg!.id);
                          const freshEditDate = (fresh as any)?.editDate as
                            | number
                            | undefined;
                          const wasEdited =
                            !!fresh &&
                            !!freshEditDate &&
                            freshEditDate !== preClickEditDate;
                          if (!wasEdited)
                            throw new Error(
                              `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                            );
                          step.responseSource = "edit";
                          if (hasInlineButtons(fresh)) {
                            buttonsMsg = fresh;
                            if (botMode) lastButtonsMsg = fresh;
                          }
                          if (botMode) lastMessages = [fresh!];
                          const parsed = await parseMessages(
                            [fresh!],
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        // Success/fail text is judged by the caller: the success indicator
                        // typically only appears after the whole sequence is clicked.
                        responseText = [
                          answer?.message ?? "",
                          ...responses.map((r) => r.msg.message ?? ""),
                        ]
                          .filter(Boolean)
                          .join("\n");

                        clickedText = btnText;
                        step.clickedButton = btnText;
                        break;
                      }
                      if (clicked) break;
                    }
                  }

                  if (!clicked)
                    throw new Error(
                      `Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`,
                    );
                  return { clickedText, responseText };
                };

                // ── Click each selected button in order, gap between clicks ──
                const clickedButtons: string[] = [];
                step.clickedButtons = clickedButtons;
                for (let k = 0; k < aiResult.buttons.length; k++) {
                  if (k > 0 && action.gapMs > 0) {
                    await new Promise<void>((res, rej) => {
                      if (signal?.aborted) {
                        rej(new Error("Job cancelled"));
                        return;
                      }
                      const timer = setTimeout(res, action.gapMs);
                      signal?.addEventListener(
                        "abort",
                        () => {
                          clearTimeout(timer);
                          rej(new Error("Job cancelled"));
                        },
                        { once: true },
                      );
                    });
                  }
                  const { clickedText, responseText } = await clickTarget(
                    aiResult.buttons[k],
                  );
                  clickedButtons.push(clickedText);

                  // failContains aborts as soon as any reply signals failure; successContains
                  // is only required on the final reply, since bots usually confirm success
                  // once the whole sequence is done.
                  if (textSaysFail(responseText, action.failContains)) {
                    throw new Error(
                      `Reply indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`,
                    );
                  }
                  const isLast = k === aiResult.buttons.length - 1;
                  if (isLast && !textSaysSuccess(responseText, action.successContains)) {
                    throw new Error(
                      `Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in response`,
                    );
                  }
                }

                step.result = `Clicked ${clickedButtons.length} button(s): ${clickedButtons
                  .map((b) => `"${b}"`)
                  .join(", ")}`;
                break;
              }

              case "join_group": {
                const raw = action.groupId.trim();
                step.label = `Join group: ${raw}`;

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already a member
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already a member (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Joined via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");
                } else {
                  // A username, or an ID naming a group the account is already in
                  const entity = await resolvePeerTarget(client, raw);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already a member (verified)";
                      break;
                    }
                  }
                  // A basic group cannot be joined by ID or name; being in the chat list is
                  // the only way one was reachable in the first place
                  if (entity instanceof Api.Chat) {
                    step.result = "Already a member";
                    break;
                  }

                  let pendingApproval = false;
                  let freshlyJoined = false;
                  // Small tolerance for clock skew against Telegram server time
                  const joinStartSec = Math.floor(Date.now() / 1000) - 10;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Joined";
                    freshlyJoined = true;
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");

                  // Only wait for the in-group verification prompt on a genuine fresh join --
                  // an already-joined account won't get a new prompt, so don't stall on it.
                  if (action.verifyButton && freshlyJoined && entity instanceof Api.Channel) {
                    const promptWaitMs = action.verifyWaitMs ?? 30000;
                    await clickGroupVerification(
                      client,
                      entity,
                      step,
                      {
                        buttonMatch: action.verifyButton,
                        promptWaitMs,
                        maxMs: action.verifyMaxWaitMs ?? promptWaitMs + 60000,
                        sinceSec: joinStartSec,
                        onlyMine: action.verifyMentionsMe,
                        maskedName: action.verifyMaskedName,
                      },
                      signal,
                    );
                  }
                }
                break;
              }

              case "subscribe_channel": {
                const raw = action.channelId.trim();
                step.label = `Subscribe to channel: ${raw}`;

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already subscribed
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Subscribed via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                } else {
                  // A username, or an ID naming a channel the account is already in
                  const entity = await resolvePeerTarget(client, raw);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Subscribed";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                }
                break;
              }

              case "open_mini_app": {
                const target = action.contact?.trim() || botUsername;
                const wantBtn = action.button?.trim();
                step.label = `Open Mini App${wantBtn ? ` "${wantBtn}"` : ""} from ${target}`;

                // Pass `target` through rather than pre-resolving it: GramJS resolves
                // and caches the peer itself, and the extra ResolveUsername round-trip
                // is what tends to time out here.
                const msgs = (await client.getMessages(target, { limit: 10 })) as Api.Message[];
                let hit: { web: WebButton; msg: Api.Message } | undefined;
                for (const m of msgs) {
                  const web = findUrlButton(m, wantBtn);
                  if (web?.miniApp) {
                    hit = { web, msg: m };
                    break;
                  }
                }
                if (!hit) {
                  throw new Error(
                    `No Mini App button${wantBtn ? ` matching "${wantBtn}"` : ""} in the last 10 messages from ${target}`,
                  );
                }

                step.clickedButton = hit.web.text;
                const { url, signed } = await openableButtonUrl(client, hit.web, target, hit.msg);
                step.cfMiniApp = true;
                step.cfMiniAppSigned = signed;
                if (!signed) {
                  throw new Error(
                    `Telegram would not sign the Mini App behind "${hit.web.text}"; it cannot be opened logged in`,
                  );
                }

                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();

                // The budget covers this action's whole browser life, retries included
                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `mini:${i}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  ...proxyChoiceFor(action),
                  tryAll: action.tryAllProxies ?? true,
                  // An exit that was already refused this run is not offered again, so a
                  // retry moves further into the pool instead of replaying the same few
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                // The same check the plain-page action makes: a step that connects a mailbox
                // has nothing to connect it to without the service configured
                if (msOauthStepsIn(action.steps ?? []).length && !msApiConfigured()) {
                  throw new Error(
                    `Connecting a mailbox needs msOauth2api: ${msApiOffReason()}`,
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  // The signed URL names this account; anything the app kept from the last
                  // run would speak for another one, so it goes unless asked for
                  clearAppSession: !action.keepAppSession,
                  // An app is a page, so it takes the same typed sub-steps a plain one does:
                  // that is where a branch and a step allowed to fail come from. They run
                  // before the label steps below, and the hooks they need are the same
                  // bundle the `open_url` action hands over
                  webSteps: action.steps ?? [],
                  ...pageStepHooks(),
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                  exactAppLabels: action.exactAppLabels,
                  // Given to the browser side as well, so a step that presses an outcome
                  // the app already shows is not read as a press that did nothing
                  successContains: action.successContains,
                  maxWaitMs: budgetLeft,
                  profile: { template: action.profileId, vars: cfProfileVars(cfRun) },
                  display: await displayForRun(cfRun),
                  runId: cfRun.runId,
                  signal,
                  // The browser side is invisible from here, so keep what it saw
                  screenshot: true,
                  solveQuestion: async (question) => {
                    const prompt =
                      `A Telegram Mini App is asking a verification question before it will ` +
                      `complete a checkin. The screen reads:\n\n${question}\n\n` +
                      `Reply with ONLY the answer to type into the input, nothing else.`;
                    const { response } = await callAI([], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  // Backs the {aiBtn} in-app step: the model is shown the marked-up app
                  // page and names the control to press
                  aiLocate: async (images, prompt, maxTokens) => {
                    const { response } = await callAI(
                      Array.isArray(images) ? images : [images],
                      prompt,
                      maxTokens ?? 512,
                    );
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  // Cloudflare judges the exit IP too, so the action can pin an exit of
                  // its own and decide whether the rest of the pool stands by
                  proxyCandidates: candidates,
                  // Init data ages, so each attempt gets a freshly signed URL
                  refreshUrl: async () =>
                    (await openableButtonUrl(client, hit!.web, target, hit!.msg)).url,
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfMiniAppAction = cf.inAppAction;
                step.webSteps = cf.webSteps;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfProfile = cf.profileKey;
                step.cfDevice = cf.deviceSeed;
                step.cfLocale = cf.locale;
                step.cfLocalePinned = cf.localePinned;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                step.result = miniAppOutcome(
                  `Opened "${hit.web.text}"`,
                  cf.inAppAction,
                  action.steps?.length ?? 0,
                  cf.webSteps,
                );

                if (textSaysFail(cf.text, action.failContains)) {
                  throw new Error(`Page indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                }
                const said = runSaysSuccess(cf.text, cf.seenText, action.successContains);
                if (!said.ok) {
                  throw new Error(
                    `Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in the Mini App page`,
                  );
                }
                // Worth saying which one it was: the app showed the wording and took it away
                // again, so the final page the log keeps does not carry it
                if (said.transient) {
                  step.result = `${step.result ?? ""} (success wording seen, then cleared)`;
                }
                break;
              }

              case "open_bot_menu_app":
              case "open_mini_app_url": {
                // Both open a signed Mini App in the browser and differ only in where the
                // address comes from -- one is typed, the other asked of the bot -- so the
                // resolution is per type and everything past it is shared.
                let url: string;
                let unsigned = false;
                // Init data ages, so each browser attempt is signed afresh
                let refresh: () => Promise<string>;

                if (action.type === "open_bot_menu_app") {
                  const owner = action.contact?.trim() || botUsername.trim();
                  if (!owner) {
                    throw new Error(
                      "This action needs the bot whose menu button to open. Set one on the " +
                        "job, or give the step its own contact.",
                    );
                  }
                  const app = await openableBotMenuApp(client, owner);
                  if (!app) {
                    throw new Error(
                      `${owner} pins no Mini App beside the composer, so it has no menu ` +
                        "button to open. Use “Open Mini App by URL” with its address instead.",
                    );
                  }
                  step.label = `Open "${app.text}" (${owner} menu button)`;
                  step.cfMiniApp = true;
                  step.cfMiniAppSigned = app.signed;
                  if (!app.signed) {
                    throw new Error(
                      `Telegram would not sign ${owner}'s menu Mini App, so it cannot be ` +
                        "opened logged in.",
                    );
                  }
                  url = app.url;
                  refresh = async () => (await openableBotMenuApp(client, owner))?.url ?? app.url;
                } else {
                  // Placeholders expand as they do for a command, so one template URL can
                  // still carry a per-run value
                  const rawUrl = expandCommand(action.url ?? "").trim();
                  if (!rawUrl) throw new Error("This action needs a Mini App URL");
                  // Blank names the job's own bot, which is the common case: a template set
                  // up for one bot works for every account linked to it
                  const owner = action.contact?.trim() || botUsername.trim();
                  step.label = `Open Mini App ${rawUrl}`;

                  // An address that already carries its account data needs no signing: it
                  // is what Telegram would have handed back anyway
                  const carriesAccount = /[#&]tgWebAppData=/.test(rawUrl);
                  const resolved = await openableMiniAppUrl(client, rawUrl, owner || undefined);
                  step.cfMiniApp = true;
                  step.cfMiniAppSigned = resolved.signed || carriesAccount;

                  // Naming a bot and being refused by it is a misconfiguration worth
                  // stopping for. Naming none is a deliberate choice -- the page is opened
                  // on this account's browser and exit as it stands, which some apps need.
                  if (!resolved.signed && owner) {
                    throw new Error(
                      `Telegram would not sign this Mini App URL through ${owner}, so it cannot be ` +
                        "opened logged in. Check the bot owns the app, use its t.me/<bot>/<app> link, " +
                        "or clear the contact to open the address as it stands.",
                    );
                  }
                  url = resolved.url;
                  unsigned = !resolved.signed && !carriesAccount;
                  refresh = async () =>
                    (await openableMiniAppUrl(client, rawUrl, owner || undefined)).url;
                }

                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();

                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `mini:${i}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  ...proxyChoiceFor(action),
                  tryAll: action.tryAllProxies ?? true,
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                // The same check the plain-page action makes: a step that connects a mailbox
                // has nothing to connect it to without the service configured
                if (msOauthStepsIn(action.steps ?? []).length && !msApiConfigured()) {
                  throw new Error(
                    `Connecting a mailbox needs msOauth2api: ${msApiOffReason()}`,
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  // The signed URL names this account; anything the app kept from the last
                  // run would speak for another one, so it goes unless asked for
                  clearAppSession: !action.keepAppSession,
                  // An app is a page, so it takes the same typed sub-steps a plain one does:
                  // that is where a branch and a step allowed to fail come from. They run
                  // before the label steps below, and the hooks they need are the same
                  // bundle the `open_url` action hands over
                  webSteps: action.steps ?? [],
                  ...pageStepHooks(),
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                  exactAppLabels: action.exactAppLabels,
                  // Given to the browser side as well, so a step that presses an outcome
                  // the app already shows is not read as a press that did nothing
                  successContains: action.successContains,
                  maxWaitMs: budgetLeft,
                  profile: { template: action.profileId, vars: cfProfileVars(cfRun) },
                  display: await displayForRun(cfRun),
                  runId: cfRun.runId,
                  signal,
                  screenshot: true,
                  solveQuestion: async (question) => {
                    const prompt =
                      `A Telegram Mini App is asking a verification question before it will ` +
                      `complete a checkin. The screen reads:\n\n${question}\n\n` +
                      `Reply with ONLY the answer to type into the input, nothing else.`;
                    const { response } = await callAI([], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  aiLocate: async (images, prompt, maxTokens) => {
                    const { response } = await callAI(
                      Array.isArray(images) ? images : [images],
                      prompt,
                      maxTokens ?? 512,
                    );
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  proxyCandidates: candidates,
                  refreshUrl: refresh,
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfMiniAppAction = cf.inAppAction;
                step.webSteps = cf.webSteps;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfProfile = cf.profileKey;
                step.cfDevice = cf.deviceSeed;
                step.cfLocale = cf.locale;
                step.cfLocalePinned = cf.localePinned;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                // Said plainly: an app that turns out to need an account will fail inside
                // the page, and "opened, nothing pressed" alone would not explain why
                const how = unsigned ? " (no bot named, so opened without account data)" : "";
                step.result = miniAppOutcome(
                  "Opened the Mini App",
                  cf.inAppAction,
                  action.steps?.length ?? 0,
                  cf.webSteps,
                  how,
                );

                if (textSaysFail(cf.text, action.failContains)) {
                  throw new Error(`Page indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                }
                const saidOk = runSaysSuccess(cf.text, cf.seenText, action.successContains);
                if (!saidOk.ok) {
                  throw new Error(
                    `Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found in the Mini App page`,
                  );
                }
                if (saidOk.transient) {
                  step.result = `${step.result ?? ""} (success wording seen, then cleared)`;
                }
                break;
              }

              case "open_message_url":
              case "open_url": {
                // Both open a page in the browser and differ only in where the address comes
                // from -- one is typed, the other read off a message -- so the resolution is
                // per type and everything past it is shared.
                const webSteps = action.steps ?? [];
                const stepsNote = webSteps.length
                  ? ` (${webSteps.length} page step${webSteps.length > 1 ? "s" : ""})`
                  : "";
                let url: string;
                // What the log calls the thing that was opened: the wording the link was
                // offered under, which is what the operator sees in the chat
                let linkLabel = "";

                if (action.type === "open_message_url") {
                  const contact = action.contact?.trim() ?? "";
                  const target = contact || botUsername;
                  const want = action.linkText?.trim() ?? "";
                  const mustContain = action.messageContains?.trim() ?? "";
                  step.label = `Open link${want ? ` "${want}"` : ""} from ${target || "the bot"}${stepsNote}`;
                  if (!target)
                    throw new Error(
                      "No contact to read a link from, and the job has no bot",
                    );

                  const entity: Api.TypeEntityLike = contact
                    ? await resolvePeerTarget(client, contact)
                    : botUsername;
                  const anchor = contact ? contactAnchors.get(contact) : sendAnchor;
                  const minId = await resolveScopeFloor(
                    client,
                    entity,
                    anchor?.msgId ?? 0,
                    action.scope,
                  );
                  // Our own messages carry links too (a command we sent back), and a stale
                  // link from an earlier turn is exactly what the scope floor keeps out
                  const pick = (m: Api.Message): MessageLink | undefined =>
                    m && !m.out && m.id >= minId && msgTextMatches(m, mustContain)
                      ? pickMessageLink(m, want)
                      : undefined;

                  // Newest first: the link the bot has just sent, not one further back
                  const recent = (await client.getMessages(entity, {
                    limit: 10,
                  })) as Api.Message[];
                  let hit: { msg: Api.Message; link: MessageLink } | null = null;
                  for (const m of recent) {
                    const link = pick(m);
                    if (link) {
                      hit = { msg: m, link };
                      break;
                    }
                  }
                  if (!hit)
                    hit = await waitForLinkInChat(
                      client,
                      entity,
                      waitBudget(action.linkWaitMs)(),
                      pick,
                      signal,
                    );
                  if (signal?.aborted) throw new Error("Job cancelled");
                  if (!hit)
                    throw new Error(
                      `No link${want ? ` matching "${want}"` : ""} from ${target}` +
                        `${mustContain ? ` in a message containing "${mustContain}"` : ""}. ` +
                        "Mini App buttons and t.me links are not web pages; the Mini App " +
                        "actions open those.",
                    );

                  url = hit.link.url;
                  linkLabel = hit.link.text;
                  if (hit.link.fromButton) step.clickedButton = hit.link.text;
                  // The message the link was taken from, so the log shows the offer as it
                  // was made rather than just the address that came out of it
                  const parsed = await parseMessages([hit.msg], client, signal);
                  if (parsed.html) step.preClickHtml = parsed.html;
                  if (parsed.buttons.length) step.preClickButtons = parsed.buttons;
                } else {
                  // Placeholders are expanded the same way a command's are, so a URL can carry
                  // a random query value per run
                  url = expandCommand(action.url ?? "").trim();
                  // Named before the checks below, so a misconfigured URL still logs a step
                  // that says which one it was
                  step.label = `Open ${url || "(no URL)"}${stepsNote}`;
                }

                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();
                if (action.type === "open_url" && cfHost)
                  step.label = `Open ${cfHost}${stepsNote}`;
                if (!url) throw new Error("No URL configured for this step");
                if (!/^https?:\/\//i.test(url))
                  throw new Error(`URL must start with http:// or https:// (got "${url}")`);

                // msOauth2api owns the application registration now, so what has to be in
                // place is the service itself. Checked before the browser starts: the whole
                // sign-in wait would otherwise be spent before the step needing it is reached.
                if (msOauthStepsIn(webSteps).length && !msApiConfigured()) {
                  throw new Error(
                    `Connecting a mailbox needs msOauth2api: ${msApiOffReason()}`,
                  );
                }

                // The budget covers this action's whole browser life, retries included
                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `url:${i}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  ...proxyChoiceFor(action),
                  tryAll: action.tryAllProxies ?? true,
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  webSteps,
                  maxWaitMs: budgetLeft,
                  screenshot: true,
                  proxyCandidates: candidates,
                  ...pageStepHooks(),
                  // Which cookie jar this runs on, and so what a login here belongs to
                  profile: { template: action.profileId, vars: cfProfileVars(cfRun) },
                  display: await displayForRun(cfRun),
                  runId: cfRun.runId,
                  signal,
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfProfile = cf.profileKey;
                step.cfDevice = cf.deviceSeed;
                step.cfLocale = cf.locale;
                step.cfLocalePinned = cf.localePinned;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                step.webSteps = cf.webSteps;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                const ran = (cf.webSteps ?? []).filter((s) => s.outcome).length;
                // The link's own wording is worth keeping: the address is a one-time token,
                // so the label is the only part of it a later read will recognise
                const opened = linkLabel
                  ? `"${linkLabel}" (${cf.finalHost})`
                  : cf.finalHost;
                step.result = webSteps.length
                  ? `Opened ${opened}, ran ${ran}/${webSteps.length} page step(s)`
                  : `Opened ${opened}`;

                if (textSaysFail(cf.text, action.failContains)) {
                  throw new Error(`Page indicates failure: "${expandDatePlaceholders(action.failContains ?? "")}" detected`);
                }
                if (!textSaysSuccess(cf.text, action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${expandDatePlaceholders(action.successContains ?? "")}" not found on the page`,
                  );
                }
                break;
              }

              default:
                // An action this build has no case for. Silence here is the dangerous
                // answer: the step would fall past the switch, be counted a success and
                // leave a blank line in the log -- which is exactly what a config saved by
                // a newer panel than the running server looks like.
                throw new Error(
                  `This build does not know the "${(action as CustomAction).type}" action. ` +
                    "The server is likely older than the panel that saved this job.",
                );
            }

            actionSucceeded = true;
          } catch (err: any) {
            // Cancellation is never retried
            if (err?.message === "Job cancelled") throw err;

            step.error = err?.message ?? String(err);
            step.errorName = err?.name ?? err?.constructor?.name;
            if (Array.isArray(err?.aiRetries) && err.aiRetries.length)
              step.aiRetries = err.aiRetries;
            if (err?.aiPrompt != null && step.aiPrompt == null)
              step.aiPrompt = err.aiPrompt;
            if (err?.aiResponse != null && step.aiResponse == null)
              step.aiResponse = err.aiResponse;

            if (actionAttempt > actionMaxRetries) {
              if (action.continueOnError) {
                // Left to fail on purpose: the chain carries on to whatever judges it, and
                // the error stays on the step so the log still shows what went wrong
                step.result = "Failed, carrying on";
                step.continued = true;
              } else {
                // All action retries exhausted -- fail this job attempt
                jobAttemptFailed = true;
                lastJobError = err;
              }
            }
          } finally {
            step.durationMs = Date.now() - t0;
          }
        }

        // A check is not itself an outcome to branch on: leaving this alone is what lets
        // one check read how the action before it came out, and a second read the same.
        if (action.type !== "if_check") lastActionOk = actionSucceeded;

        if (jobAttemptFailed || jobDone) break;
      }

      if (!jobAttemptFailed) {
        lastJobError = null;
        break;
      }
    }

    if (lastJobError) throw lastJobError;
  } catch (err: any) {
    if (err?.message === "Job cancelled") throw err;
    throw new CustomJobError(err?.message ?? String(err), log);
  } finally {
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14).
    // Bounded: teardown runs over the same connection, so a dead proxy would hang it too.
    await destroyQuietly(client, "custom job");
  }

  return log;
}
