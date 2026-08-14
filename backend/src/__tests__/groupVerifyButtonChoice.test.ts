// Which button a verification prompt means for us to press. These prompts sit next to
// buttons that decline or report the joiner, and pressing one of those fails the
// verification on a real account -- so an unclear prompt must yield nothing at all.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { Api } from "telegram";
import { channelToJoinFromUrl, pressableVerifyButton } from "../jobs/custom";
import { findUrlButton } from "../jobs/checkin";
import { matchesAnyLabel } from "../jobs/placeholders";

const callback = (text: string) =>
  new Api.KeyboardButtonCallback({ text, data: Buffer.from(`cb:${text}`) });
const url = (text: string, link: string) => new Api.KeyboardButtonUrl({ text, url: link });

describe("pressableVerifyButton", () => {
  it("presses the confirm button of the private prompt, not the channel link", () => {
    // The shape a group's verification bot sends in a private chat: join the channel,
    // then verify.
    const chosen = pressableVerifyButton([
      url("加入频道", "https://telegram.me/+AbCd--Ef1234567"),
      callback("完成验证"),
    ]);
    expect(chosen?.text).toBe("完成验证");
  });

  it("leaves an admin prompt alone rather than pressing 拒绝", () => {
    // The in-group prompt's other buttons are the admins' approve/reject controls.
    const chosen = pressableVerifyButton([
      callback("通过"),
      callback("拒绝"),
      callback("拒绝并举报骚扰"),
    ]);
    expect(chosen).toBeUndefined();
  });

  it("takes the sole callback button whatever it is worded as", () => {
    expect(pressableVerifyButton([callback("我是人类")])?.text).toBe("我是人类");
  });

  it("picks the confirming button when a decline sits beside it", () => {
    expect(
      pressableVerifyButton([callback("完成验证"), callback("取消")])?.text,
    ).toBe("完成验证");
  });

  it("yields nothing when no button is pressable", () => {
    expect(pressableVerifyButton([])).toBeUndefined();
    expect(pressableVerifyButton([url("打开网页", "https://example.com")])).toBeUndefined();
    expect(pressableVerifyButton([callback("取消"), callback("举报")])).toBeUndefined();
  });
});

// Which button URL names a channel the prompt wants joined, versus one that just opens
// something. Joining is a side effect on a real account, so this errs towards not joining.
describe("channelToJoinFromUrl", () => {
  it("reads the invite link a verification prompt asks us to join", () => {
    expect(channelToJoinFromUrl("https://telegram.me/+AbCd--Ef1234567")).toEqual({
      invite: "AbCd--Ef1234567",
    });
    expect(channelToJoinFromUrl("https://t.me/joinchat/AbCdEf123")).toEqual({ invite: "AbCdEf123" });
  });

  it("reads a public channel link", () => {
    expect(channelToJoinFromUrl("https://t.me/samplechannel")).toEqual({ username: "samplechannel" });
  });

  it("leaves a link to a post inside a channel alone", () => {
    // The "wiki" button these groups post -- something to read, not to join.
    expect(channelToJoinFromUrl("https://t.me/sample_channel/54")).toBeNull();
  });

  it("leaves bot links alone, deep link and Mini App alike", () => {
    expect(channelToJoinFromUrl("https://telegram.me/verifybot?start=joinverify_-1001234567890")).toBeNull();
    expect(
      channelToJoinFromUrl("https://telegram.me/verifybot/panel?startapp=L3dlYi12ZXJpZnk"),
    ).toBeNull();
  });

  it("leaves a non-Telegram address alone", () => {
    expect(channelToJoinFromUrl("https://verify.example.com/#/web-verify/-1001234567890/78")).toBeNull();
  });
});

// A bot that follows each account's language words the same button differently, so one job
// has to be able to name every wording it might carry -- the `|` convention the Mini App
// in-app steps already use.
describe("`|` alternatives in a button matcher", () => {
  const msgWith = (...labels: string[]) =>
    ({
      replyMarkup: new Api.ReplyInlineMarkup({
        rows: [
          new Api.KeyboardButtonRow({
            buttons: labels.map((t) => new Api.KeyboardButtonUrl({ text: t, url: "https://t.me/b/app?startapp=x" })),
          }),
        ],
      }),
    }) as unknown as Api.Message;

  it("matches whichever language the bot rendered the Mini App button in", () => {
    const want = "中验证|in App";
    expect(findUrlButton(msgWith("在 App 中验证"), want)?.text).toBe("在 App 中验证");
    expect(findUrlButton(msgWith("Verify in App"), want)?.text).toBe("Verify in App");
    expect(findUrlButton(msgWith("打开浏览器验证"), want)).toBeUndefined();
  });

  it("still takes any openable button when nothing is named", () => {
    expect(findUrlButton(msgWith("whatever"), "")?.text).toBe("whatever");
    expect(findUrlButton(msgWith("whatever"), undefined)?.text).toBe("whatever");
  });

  it("matches the group verify button in either language", () => {
    const want = "在私信中验证|Verify in private chat";
    expect(matchesAnyLabel("在私信中验证", want)).toBe(true);
    expect(matchesAnyLabel("Verify in private chat", want)).toBe(true);
    expect(matchesAnyLabel("通过", want)).toBe(false);
  });
});
