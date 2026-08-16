// @SpamBot answers in the account's own language, so a wording-only check returned "unknown"
// for every account that was not English. The samples below are real replies pulled from the
// message cache (English, Russian, Spanish); the keyboards behind them are identical in shape,
// which is what the classifier leans on.

vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import { classifySpamReply, parseAiSpamAnswer } from "../jobs/checkin";

const FREE_EN = "Good news, no limits are currently applied to your account. You’re free as a bird!";
const FREE_RU = "Ваш аккаунт свободен от каких-либо ограничений.";
const LIMITED_EN =
  "Hello Scott!\n\nI’m very sorry that you had to contact me. Unfortunately, some actions can trigger a harsh response from our anti-spam systems. If you think your account was limited by mistake, you can submit a complaint to our moderators.";
const LIMITED_ES =
  "¡Hola, Sahil!\n\nSiento mucho que hayas tenido que contactarme. Lamentablemente, algunas acciones pueden generar una dura respuesta de nuestros sistemas antispam.";
const BLOCKED_EN =
  "Your account was blocked for violations of the Telegram Terms of Service based on user reports confirmed by our moderators.";

describe("classifySpamReply", () => {
  it("reads the free keyboard in any language", () => {
    expect(classifySpamReply({ text: FREE_EN, buttons: ["Cool, thanks", "But I can’t message non-contacts!"] }))
      .toEqual({ status: "free", source: "signature" });
    expect(classifySpamReply({ text: FREE_RU, buttons: ["Хорошо, спасибо", "Но я не могу писать неконтактам"] }))
      .toEqual({ status: "free", source: "signature" });
  });

  it("treats a four-button keyboard as limited whatever the wording", () => {
    expect(
      classifySpamReply({
        text: LIMITED_ES,
        buttons: ["OK", "¿Qué es el spam?", "Me equivoqué. Por favor, libérame", "Esto es un error"],
      }).status,
    ).toBe("limited");
    // A language with no seeded signature still lands on limited from the count alone
    expect(
      classifySpamReply({ text: "unbekannter text", buttons: ["OK", "Was ist Spam?", "Ich hatte unrecht", "Das ist ein Fehler"] }),
    ).toEqual({ status: "limited", source: "buttons" });
  });

  it("reads the blocked keyboard, which shares the free keyboard's button count", () => {
    expect(classifySpamReply({ text: BLOCKED_EN, buttons: ["I won't do it again", "My account was hacked"] }).status)
      .toBe("blocked");
  });

  it("falls back to the wording when the reply carries no keyboard", () => {
    expect(classifySpamReply({ text: FREE_EN, buttons: [] })).toEqual({ status: "free", source: "text" });
    expect(classifySpamReply({ text: LIMITED_EN, buttons: [] })).toEqual({ status: "limited", source: "text" });
    expect(classifySpamReply({ text: BLOCKED_EN, buttons: [] })).toEqual({ status: "blocked", source: "text" });
    expect(classifySpamReply({ text: FREE_RU, buttons: [] })).toEqual({ status: "free", source: "text" });
  });

  it("does not read the shared 'limits' root as a limitation", () => {
    // "свободен от каких-либо ограничений" contains the root of "ограничен" (limited)
    expect(classifySpamReply({ text: FREE_RU, buttons: [] }).status).not.toBe("limited");
  });

  it("reports unknown for a two-button reply in an unseen language, leaving it to the AI pass", () => {
    expect(
      classifySpamReply({ text: "متاسفانه حساب شما محدود شده است", buttons: ["باشه", "چرا؟"] }),
    ).toEqual({ status: "unknown", source: "unknown" });
  });
});

describe("parseAiSpamAnswer", () => {
  it("takes a one-word answer", () => {
    expect(parseAiSpamAnswer("limited")).toBe("limited");
    expect(parseAiSpamAnswer("  Free\n")).toBe("free");
  });

  it("takes the last line, which is where a reasoning model puts its answer", () => {
    expect(parseAiSpamAnswer("The reply mentions moderators.\nblocked")).toBe("blocked");
  });

  it("refuses an answer line naming more than one status", () => {
    expect(parseAiSpamAnswer("not limited, so free")).toBe("unknown");
    expect(parseAiSpamAnswer("I cannot tell")).toBe("unknown");
  });
});
