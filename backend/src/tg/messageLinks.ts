import { Api, TelegramClient } from "telegram";
import { matchesAnyLabel } from "../jobs/placeholders";
import { openableButtonUrl, webButtonOf, type WebButton } from "./miniApp";

// Links a bot puts in front of the account: on an inline button, or written into the
// message itself. A verification link is the case this exists for -- the address carries a
// one-time token, so nothing about it can be typed into a job in advance and the only way
// to reach it is to read it off the message that has just arrived.

/** A link a message offers, whichever way it was offered. */
export type MessageLink = {
  /** Button label, or the words the link sits under; the address itself when neither. */
  text: string;
  url: string;
  /** True when it came off an inline button rather than the message body. */
  fromButton: boolean;
  /** A Mini App button, whose address only works once Telegram has signed it. */
  app?: WebButton;
  /** A login button's id: the site is reached through Telegram's URL authorisation. */
  urlAuthButtonId?: number;
};

export type MessageLinkOpts = {
  /** Also offer Mini App buttons, from the inline keyboard and the one above the composer. */
  apps?: boolean;
};

/**
 * Telegram's own deep links, which are not web pages: t.me opens a chat, an app or a
 * command in a client, and loading it in a browser reaches a landing page instead of
 * whatever the button meant. `open_mini_app` and a `?start=` click handle those.
 */
export function isTelegramDeepLink(url: string): boolean {
  try {
    return /^(?:t|telegram)\.me$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Links written into the message body: text links, and bare addresses. */
function linksInText(msg: Api.Message): MessageLink[] {
  const body = msg.message ?? "";
  const found: MessageLink[] = [];
  for (const e of (msg.entities ?? []) as Array<{
    offset?: number;
    length?: number;
    url?: string;
  }>) {
    const hasSlice = typeof e?.offset === "number" && typeof e?.length === "number";
    const label = hasSlice ? body.slice(e.offset!, e.offset! + e.length!) : "";
    // A text link carries its target on the entity; a bare URL is the slice it covers
    const url = (e?.url ?? label).trim();
    if (!url) continue;
    found.push({ text: label.trim() || url, url, fromButton: false });
  }
  return found;
}

/**
 * Every link a message offers that a browser could open, buttons first and then the body,
 * each in the order it is shown. Mini App buttons are left out unless `apps` asks for them:
 * their address is opened signed, not loaded as a plain page.
 */
export function messageLinks(
  msg: Api.Message | null | undefined,
  opts: MessageLinkOpts = {},
): MessageLink[] {
  if (!msg) return [];
  const links: MessageLink[] = [];
  const apps: MessageLink[] = [];

  const markup = (msg as any).replyMarkup;
  const keyboard =
    markup instanceof Api.ReplyInlineMarkup ||
    (opts.apps && markup instanceof Api.ReplyKeyboardMarkup);
  if (keyboard) {
    for (const row of markup.rows) {
      for (const btn of row.buttons) {
        if (btn instanceof Api.KeyboardButtonUrlAuth) {
          links.push({ text: btn.text, url: btn.url, fromButton: true, urlAuthButtonId: btn.buttonId });
          continue;
        }
        const web = webButtonOf(btn);
        if (!web || web.startLink) continue;
        if (web.miniApp) {
          if (opts.apps) apps.push({ text: web.text, url: web.url, fromButton: true, app: web });
          continue;
        }
        links.push({ text: web.text, url: web.url, fromButton: true });
      }
    }
  }
  links.push(...linksInText(msg));

  return [
    ...apps,
    ...links.filter((l) => /^https?:\/\//i.test(l.url) && !isTelegramDeepLink(l.url)),
  ];
}

/**
 * The link to open, matched against the label first and the address second -- what is on
 * screen is the wording the operator has to go on, but a link whose words vary run to run
 * ("verify you are a human" / "点此验证") is still pinned down by its host. `|` separates
 * alternatives, as everywhere else; a blank match takes the first link the message offers.
 */
export function pickMessageLink(
  msg: Api.Message | null | undefined,
  match?: string,
  opts: MessageLinkOpts = {},
): MessageLink | undefined {
  const links = messageLinks(msg, opts);
  const wanted = match?.trim() ?? "";
  if (!wanted) return links[0];
  return (
    links.find((l) => matchesAnyLabel(l.text, wanted)) ??
    links.find((l) => matchesAnyLabel(l.url, wanted))
  );
}

/**
 * The address a link actually leads to once pressed. A login button goes through Telegram's
 * URL authorisation, the "Open this link?" / "Log in as" prompt the official app shows, and
 * comes back with the site's signed login address; a Mini App button is signed the same way
 * `open_mini_app` does. Anything else is the address as written.
 */
export async function resolveMessageLink(
  client: TelegramClient,
  peer: Api.TypeEntityLike,
  msg: Api.Message,
  link: MessageLink,
): Promise<{ url: string; signed: boolean }> {
  if (link.app) return openableButtonUrl(client, link.app, peer, msg);
  if (link.urlAuthButtonId == null) return { url: link.url, signed: false };

  const ref = { peer, msgId: msg.id, buttonId: link.urlAuthButtonId };
  let res = await client.invoke(new Api.messages.RequestUrlAuth(ref));
  if (res instanceof Api.UrlAuthResultRequest) {
    res = await client.invoke(
      new Api.messages.AcceptUrlAuth({ ...ref, writeAllowed: !!res.requestWriteAccess }),
    );
  }
  if (res instanceof Api.UrlAuthResultAccepted && res.url) return { url: res.url, signed: true };
  // UrlAuthResultDefault: the bot's domain is not set up for login, so the plain URL is it
  return { url: link.url, signed: false };
}
