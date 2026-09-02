// Pulling the link out of a message, which is the half of `web_email_link` that decides
// whether the run opens the confirmation or the sender's logo.
import { describe, expect, it } from "vitest";
import { linkFromMessage } from "../jobs/msOauth2api";

const CF_MAIL = {
  html:
    '<a href="https://www.cloudflare.com/"><img src="logo.png"></a>' +
    '<a href="https://dash.cloudflare.com/email-verification?token=tok1">Verify your email</a>' +
    '<a href="https://dash.cloudflare.com/unintended-registration">not you?</a>',
  text: "Your account needs a confirmed email address",
};

describe("linkFromMessage", () => {
  it("takes the anchor carrying the fragment, not the logo above it", () => {
    expect(linkFromMessage(CF_MAIL, "email-verification")).toBe(
      "https://dash.cloudflare.com/email-verification?token=tok1",
    );
  });

  it("takes the first link at all when nothing is asked for", () => {
    expect(linkFromMessage(CF_MAIL)).toBe("https://www.cloudflare.com/");
  });

  it("answers nothing when no link carries the fragment", () => {
    expect(linkFromMessage(CF_MAIL, "confirm-account")).toBeUndefined();
  });

  it("unpicks the entities an href carries", () => {
    const html = '<a href="https://x.test/verify?a=1&amp;b=2&#38;c=3">go</a>';
    expect(linkFromMessage({ html }, "verify")).toBe("https://x.test/verify?a=1&b=2&c=3");
  });

  it("reads a bare URL out of the plain-text part", () => {
    const text = "Confirm here: https://x.test/confirm/9f8e7d then sign in";
    expect(linkFromMessage({ text }, "confirm")).toBe("https://x.test/confirm/9f8e7d");
  });

  it("prefers the HTML anchor over the text copy of it", () => {
    expect(
      linkFromMessage({ html: '<a href="https://x.test/verify/real">go</a>', text: "https://x.test/verify/tracked" }, "verify"),
    ).toBe("https://x.test/verify/real");
  });

  it("leaves a mailto or an inline image alone", () => {
    expect(
      linkFromMessage({ html: '<a href="mailto:someone@x.test">mail</a><img src="cid:logo">' }),
    ).toBeUndefined();
  });

  it("matches the fragment whatever its case", () => {
    expect(linkFromMessage({ html: '<a href="https://x.test/Email-Verification/1">go</a>' }, "email-verification")).toBe(
      "https://x.test/Email-Verification/1",
    );
  });

  it("answers nothing for a message with no body at all", () => {
    expect(linkFromMessage({}, "verify")).toBeUndefined();
  });
});
