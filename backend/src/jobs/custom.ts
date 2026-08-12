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
  hasAiInput,
  parseAiInputLength,
  recognizeCaptchaWithAI,
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
} from "./cloudflare";
import {
  openableBotMenuApp,
  openableButtonUrl,
  openableMiniAppUrl,
  webButtonOf,
  type WebButton,
} from "../tg/miniApp";
import { resolvePeerTarget } from "../tg/peerTarget";
import {
  cfMaxCandidates,
  cfProxyCandidatesFor,
  rememberCfProxy,
  type ProxyChoice,
} from "../tg/proxyProviders";
import { cfTuning } from "./cfTuning";
import { rememberWebValue, usedWebValues } from "./webMemory";
import { getNotifyConfig, sendBotNotify } from "./notify";
import { EMAIL_CODE_LOOKBACK_MS, fetchGmailCode } from "./emailCode";
import { fillSecrets, missingSecretRefs } from "../db/secrets";
import { displayForRun } from "./runDisplays";

import type { CustomAction, CustomConfig, CustomStepLog } from "../types";

export type CustomJobLog = {
  steps: CustomStepLog[];
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
type SelfRef = { id: string; username?: string };

const selfRef = async (client: TelegramClient): Promise<SelfRef> => {
  const me = (await client.getMe()) as Api.User;
  return { id: me.id.toString(), username: me.username || undefined };
};

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
  const text = m.message ?? "";
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (me.username && new RegExp(`@${escape(me.username)}\\b`, "i").test(text))
    return true;
  if (text.includes(`tg://user?id=${me.id}`)) return true;
  // A bare id, not part of a longer number (so "180" never matches an id ending in 180)
  if (new RegExp(`(?:^|\\D)${me.id}(?:\\D|$)`).test(text)) return true;
  // Text mentions carry the user in an entity rather than the text
  return ((m.entities ?? []) as any[]).some(
    (e) => e?.userId != null && e.userId.toString() === me.id,
  );
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
      hasInlineButtons(msg) && (!filter || filter.accept(msg));

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
  buttonMatch: string,
  maxMs: number,
  step: CustomStepLog,
  signal?: AbortSignal,
  sinceSec?: number,
  onlyMine?: boolean,
): Promise<void> {
  const me = onlyMine ? await selfRef(client) : null;
  const filter: ButtonsFilter | undefined = me
    ? {
        accept: (m) => messageAddressesUser(m, me),
        describe: "addressed to this account",
      }
    : undefined;
  const wanted = (m: Api.Message | null | undefined): boolean =>
    hasInlineButtons(m) && (!filter || filter.accept(m as Api.Message));

  const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
    [...msgs].reverse().find((m) => wanted(m)) ?? null;

  // A group verifying a rush of joiners buries our prompt under theirs, so look back
  // further when only ours will do.
  const scanLimit = onlyMine ? 50 : 10;

  // Waiter catches prompts that arrive (or get edited in) from now on; the scan catches a
  // prompt that landed in the gap before the listener attached. Whichever finds one first wins.
  const waitAbort = new AbortController();
  const forwardAbort = () => waitAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const waiterPromise = waitForButtonsInChat(client, chat, maxMs, waitAbort.signal, 0, filter)
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
    step.result = `${step.result} (no verification prompt${onlyMine ? " addressed to this account" : ""})`;
    return;
  }

  const rows = ((buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup).rows;
  const flat = rows.flatMap((r) => r.buttons);
  const match = buttonMatch.trim();
  let target = match
    ? flat.find((b: any) => ((b.text as string) ?? "").includes(match))
    : undefined;
  // Fall back to the sole button for single-button verifications.
  if (!target && flat.length === 1) target = flat[0];
  if (!target) {
    step.result = `${step.result} (verification button not found)`;
    return;
  }

  const data = (target as Api.KeyboardButtonCallback).data;
  if (!data) {
    step.result = `${step.result} (verification button not clickable)`;
    return;
  }

  const peer = await client.getInputEntity(chat);
  step.clickedButton = (target as any).text as string;
  try {
    const answer = (await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer, msgId: buttonsMsg.id, data }),
    )) as Api.messages.BotCallbackAnswer;
    if (answer.message) step.callbackAnswer = answer.message;
    step.result = `${step.result} + verified`;
  } catch (err: any) {
    // The callback reached the bot but it never answered -- common for verification bots
    // that process the click without calling answerCallbackQuery. The click was delivered,
    // so treat the verification as done rather than failing the whole join.
    if (err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
      step.result = `${step.result} + verify clicked (no bot confirmation)`;
    } else {
      throw err;
    }
  }
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

      if (failContains && text.includes(failContains)) {
        cleanup();
        reject(
          new Error(`Reply indicates failure: "${failContains}" detected`),
        );
        return;
      }

      if (successContains) {
        if (text.includes(successContains)) {
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
  const at = actions.findIndex((a) => {
    switch (a.type) {
      // Both need to know whose: one hunts a button in a conversation, the other asks a
      // bot what it pins beside the composer. Neither has anything to work from otherwise.
      case "open_mini_app":
      case "open_bot_menu_app":
        return !a.contact?.trim();
      case "open_mini_app_url":
      case "send_contact_message":
      case "join_group":
      case "subscribe_channel":
      case "open_url":
      case "delay":
        return false;
      default:
        return true;
    }
  });
  return at >= 0 ? { at, type: actions[at].type } : null;
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
    await client.connect();

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
      let jobAttemptFailed = false;

      for (let i = 0; i < config.actions.length; i++) {
        if (signal?.aborted) throw new Error("Job cancelled");

        const action = config.actions[i];
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
            step: i + 1,
            actionType: action.type,
            label: "",
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
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
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
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
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
                const hints = [
                  successContains ? `success: "${successContains}"` : "",
                  failContains ? `fail: "${failContains}"` : "",
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

              case "click_button": {
                step.label = `Click button "${action.button}"`;

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
                    action.maxWaitMs,
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
                          action.maxWaitMs,
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
                        if (action.failContains && cfText.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !cfText.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
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
                        10_000,
                        clickAbort.signal,
                        botPeerId,
                      );
                      const newMsgPromise = waitForNewBotMessage(
                        client,
                        botUsername,
                        10_000,
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
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
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
                    action.maxWaitMs,
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
                        action.maxWaitMs,
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
                        if (action.failContains && cfText.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !cfText.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
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
                        10_000,
                        clickAbort.signal,
                        chatPeerId,
                      );
                      const newMsgPromise = waitForNewMessageInChat(
                        client,
                        entity,
                        10_000,
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
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
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
                const waitButtons = (
                  excludeId?: number,
                ): Promise<Api.Message[]> =>
                  botMode
                    ? waitForButtonsMessage(
                        client,
                        botUsername,
                        action.maxWaitMs,
                        signal,
                        minId,
                        excludeId,
                        buttonsFilter,
                      )
                    : waitForButtonsInChat(
                        client,
                        target,
                        action.maxWaitMs,
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
                          10_000,
                          clickAbort.signal,
                          editPeerId,
                        );
                        const newMsgPromise = waitNewMsg(10_000);

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
                  if (
                    action.failContains &&
                    responseText.includes(action.failContains)
                  ) {
                    throw new Error(
                      `Reply indicates failure: "${action.failContains}" detected`,
                    );
                  }
                  const isLast = k === aiResult.buttons.length - 1;
                  if (
                    isLast &&
                    action.successContains &&
                    !responseText.includes(action.successContains)
                  ) {
                    throw new Error(
                      `Expected success indicator "${action.successContains}" not found in response`,
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
                    await clickGroupVerification(
                      client,
                      entity,
                      action.verifyButton,
                      action.verifyWaitMs ?? 30000,
                      step,
                      signal,
                      joinStartSec,
                      action.verifyMentionsMe,
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

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  // The signed URL names this account; anything the app kept from the last
                  // run would speak for another one, so it goes unless asked for
                  clearAppSession: !action.keepAppSession,
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
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
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
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
                step.result = cf.inAppAction
                  ? `Opened "${hit.web.text}", pressed "${cf.inAppAction}"`
                  : `Opened "${hit.web.text}" (nothing pressed inside the app)`;

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found in the Mini App page`,
                  );
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

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  // The signed URL names this account; anything the app kept from the last
                  // run would speak for another one, so it goes unless asked for
                  clearAppSession: !action.keepAppSession,
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
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
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
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
                step.result = cf.inAppAction
                  ? `Opened the Mini App, pressed "${cf.inAppAction}"${how}`
                  : `Opened the Mini App (nothing pressed inside it)${how}`;

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found in the Mini App page`,
                  );
                }
                break;
              }

              case "open_url": {
                // Placeholders are expanded the same way a command's are, so a URL can carry
                // a random query value per run
                const url = expandCommand(action.url ?? "").trim();
                const webSteps = action.steps ?? [];
                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();
                // Named before the checks below, so a misconfigured URL still logs a step
                // that says which one it was
                step.label = `Open ${cfHost || url || "(no URL)"}${webSteps.length ? ` (${webSteps.length} page step${webSteps.length > 1 ? "s" : ""})` : ""}`;
                if (!url) throw new Error("No URL configured for this step");
                if (!/^https?:\/\//i.test(url))
                  throw new Error(`URL must start with http:// or https:// (got "${url}")`);

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
                  // The vision model lives on this side of the browser, so the page steps
                  // reach it through a callback rather than the solver importing it
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
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
                  // secret, which the browser side neither reads nor is handed. The config
                  // carries the name of one (`{gmailAppPassword}`) and it is resolved here.
                  emailCode: async (q) => {
                    const missing = missingSecretRefs(q.appPasswordRef);
                    if (missing.length)
                      throw new Error(
                        `no secret is stored under ${missing.map((m) => `{${m}}`).join(", ")} (see Settings)`,
                      );
                    const appPassword = fillSecrets(q.appPasswordRef).trim();
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
                step.result = webSteps.length
                  ? `Opened ${cf.finalHost}, ran ${ran}/${webSteps.length} page step(s)`
                  : `Opened ${cf.finalHost}`;

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found on the page`,
                  );
                }
                break;
              }
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
              // All action retries exhausted -- fail this job attempt
              jobAttemptFailed = true;
              lastJobError = err;
            }
          } finally {
            step.durationMs = Date.now() - t0;
          }
        }

        if (jobAttemptFailed) break;
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
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14)
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }

  return log;
}
