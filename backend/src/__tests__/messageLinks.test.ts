// Which link a message is offering, as the "Open link from message" step reads it. The case
// it exists for: a bot answering with a one-time verification address, where nothing about
// the URL can be typed into the job in advance.

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
  getDefaultTimezone: () => "UTC",
}));

import { describe, it, expect, vi } from "vitest";
import { Api } from "telegram";
import { messageLinks, pickMessageLink } from "../tg/messageLinks";

const CAPTCHA = "https://telegram.org/captcha?scope=sbot_spam&actor=26152912a98bbc4f68";

/** A message whose body carries a text link under `label`. */
const textLink = (body: string, label: string, url: string) =>
  ({
    id: 1,
    message: body,
    entities: [
      new Api.MessageEntityTextUrl({ offset: body.indexOf(label), length: label.length, url }),
    ],
  }) as unknown as Api.Message;

const withButtons = (buttons: Api.TypeKeyboardButton[]) =>
  ({
    id: 2,
    message: "",
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: [new Api.KeyboardButtonRow({ buttons })],
    }),
  }) as unknown as Api.Message;

describe("messageLinks", () => {
  it("reads a link written into the message text", () => {
    const msg = textLink("Please verify you are a human.", "verify you are a human", CAPTCHA);
    expect(messageLinks(msg)).toEqual([
      { text: "verify you are a human", url: CAPTCHA, fromButton: false },
    ]);
  });

  it("reads a bare address sitting in the text", () => {
    const body = `Open ${CAPTCHA} to continue`;
    const msg = {
      id: 3,
      message: body,
      entities: [
        new Api.MessageEntityUrl({ offset: body.indexOf("https"), length: CAPTCHA.length }),
      ],
    } as unknown as Api.Message;
    expect(messageLinks(msg)[0]).toMatchObject({ url: CAPTCHA, fromButton: false });
  });

  it("reads a URL button, and says it came off one", () => {
    const msg = withButtons([
      new Api.KeyboardButtonUrl({ text: "Verify", url: "https://example.com/v?t=1" }),
    ]);
    expect(messageLinks(msg)).toEqual([
      { text: "Verify", url: "https://example.com/v?t=1", fromButton: true },
    ]);
  });

  it("leaves out what a browser cannot usefully open", () => {
    // A Mini App is opened signed, through the Mini App actions; a t.me link is a deep
    // link into a client rather than a page; a callback button goes nowhere at all.
    const msg = withButtons([
      new Api.KeyboardButtonWebView({ text: "App", url: "https://app.example.com" }),
      new Api.KeyboardButtonUrl({ text: "Join", url: "https://t.me/somebot?start=abc" }),
      new Api.KeyboardButtonCallback({ text: "Done", data: Buffer.from("done") }),
    ]);
    expect(messageLinks(msg)).toEqual([]);
  });
});

describe("pickMessageLink", () => {
  const msg = textLink("Please verify you are a human.", "verify you are a human", CAPTCHA);

  it("takes the first link when no text is given", () => {
    expect(pickMessageLink(msg)).toMatchObject({ url: CAPTCHA });
  });

  it("matches on the wording the link sits under, alternatives included", () => {
    expect(pickMessageLink(msg, "点此验证|verify you are")).toMatchObject({ url: CAPTCHA });
  });

  it("falls back to the address when the wording does not match", () => {
    // Which is what a link whose words change run to run needs
    expect(pickMessageLink(msg, "telegram.org/captcha")).toMatchObject({ url: CAPTCHA });
  });

  it("offers nothing when neither matches", () => {
    expect(pickMessageLink(msg, "unsubscribe")).toBeUndefined();
  });

  it("picks the button asked for out of several", () => {
    const many = withButtons([
      new Api.KeyboardButtonUrl({ text: "Terms", url: "https://example.com/terms" }),
      new Api.KeyboardButtonUrl({ text: "Verify", url: "https://example.com/verify" }),
    ]);
    expect(pickMessageLink(many, "Verify")).toMatchObject({
      url: "https://example.com/verify",
      fromButton: true,
    });
  });
});
