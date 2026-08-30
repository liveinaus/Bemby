import { Api } from "telegram";
import { matchesAnyLabel } from "../jobs/placeholders";
import { webButtonOf } from "./miniApp";

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
 * each in the order it is shown. Mini App buttons are left out: their address is opened
 * signed, through the Mini App actions, not loaded as a plain page.
 */
export function messageLinks(msg: Api.Message | null | undefined): MessageLink[] {
  if (!msg) return [];
  const links: MessageLink[] = [];

  const markup = (msg as any).replyMarkup;
  if (markup instanceof Api.ReplyInlineMarkup) {
    for (const row of markup.rows) {
      for (const btn of row.buttons) {
        const web = webButtonOf(btn);
        if (!web || web.miniApp) continue;
        links.push({ text: web.text, url: web.url, fromButton: true });
      }
    }
  }
  links.push(...linksInText(msg));

  return links.filter((l) => /^https?:\/\//i.test(l.url) && !isTelegramDeepLink(l.url));
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
): MessageLink | undefined {
  const links = messageLinks(msg);
  const wanted = match?.trim() ?? "";
  if (!wanted) return links[0];
  return (
    links.find((l) => matchesAnyLabel(l.text, wanted)) ??
    links.find((l) => matchesAnyLabel(l.url, wanted))
  );
}
