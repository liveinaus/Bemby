// Which in-group verification prompt belongs to this account. A group taking a rush of
// joiners posts one prompt per person, and clicking a stranger's does nothing for us -- so
// the match has to cover every way a prompt names someone, including the account with no
// username at all (a text mention, which carries the user in an entity, not in the text).
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { messageAddressesUser, messageMasksUserName } from "../jobs/custom";
import { Api } from "telegram";

const me = { id: "778899123", username: "my_account" };
const noUsername = { id: "778899123" };

const msg = (text: string, extra: Record<string, unknown> = {}) =>
  ({ message: text, ...extra }) as unknown as Api.Message;

describe("messageAddressesUser", () => {
  it("takes the prompt naming us by username and leaves someone else's alone", () => {
    expect(messageAddressesUser(msg("@my_account 请在60秒内点击下方按钮完成验证"), me)).toBe(true);
    expect(messageAddressesUser(msg("@someone_else 请在60秒内点击下方按钮完成验证"), me)).toBe(false);
  });

  it("is not fooled by a username that merely starts with ours", () => {
    expect(messageAddressesUser(msg("@my_account2 请验证"), me)).toBe(false);
  });

  it("matches case-insensitively, since bots echo usernames as typed", () => {
    expect(messageAddressesUser(msg("@My_Account please verify"), me)).toBe(true);
  });

  it("honours the mentioned flag the server stamps on prompts aimed at us", () => {
    expect(messageAddressesUser(msg("新成员请验证", { mentioned: true }), me)).toBe(true);
  });

  it("finds an account with no username through the text mention entity", () => {
    const textMention = msg("新成员 请点击验证", {
      entities: [{ className: "MessageEntityMentionName", userId: BigInt("778899123") }],
    });
    expect(messageAddressesUser(textMention, noUsername)).toBe(true);
    const othersMention = msg("新成员 请点击验证", {
      entities: [{ className: "MessageEntityMentionName", userId: BigInt("111222333") }],
    });
    expect(messageAddressesUser(othersMention, noUsername)).toBe(false);
  });

  it("accepts a tg://user link and a bare numeric id", () => {
    expect(messageAddressesUser(msg("请 tg://user?id=778899123 点击验证"), noUsername)).toBe(true);
    expect(messageAddressesUser(msg("用户 778899123 请点击验证"), noUsername)).toBe(true);
    expect(messageAddressesUser(msg("id: 778899123"), noUsername)).toBe(true);
  });

  it("does not read our id out of a longer number", () => {
    expect(messageAddressesUser(msg("用户 7788991234 请点击验证"), noUsername)).toBe(false);
    expect(messageAddressesUser(msg("请在 180 秒内点击"), noUsername)).toBe(false);
  });

  it("rejects a prompt that names nobody, and a missing message", () => {
    expect(messageAddressesUser(msg("请点击下方按钮完成验证"), me)).toBe(false);
    expect(messageAddressesUser(null, me)).toBe(false);
  });

  // Some verification bots name the joiner in a zero-width text link rather than a
  // mention, so the id
  // lives in an entity URL and never appears in the message text at all.
  it("finds our id inside a hidden text link's URL", () => {
    const hidden = (userId: string) =>
      msg("欢迎 小明 加入群组！请完成入群验证。", {
        entities: [
          {
            className: "MessageEntityTextUrl",
            url: `https://telegram.me/?verifyBotUserData=%7B%22userId%22%3A${userId}%2C%22groupId%22%3A-1001234567890%7D`,
          },
        ],
      });
    expect(messageAddressesUser(hidden("778899123"), me)).toBe(true);
    expect(messageAddressesUser(hidden("7788991234"), me)).toBe(false);
    expect(messageAddressesUser(hidden("111222333"), me)).toBe(false);
  });
});

// Welcome bots that mask the joiner's name ("欢迎 阿**2 加入群组") never @-mention anyone,
// so the mention match above cannot see them at all -- the name has to be matched in the
// masked form instead, without claiming a prompt that belongs to someone else.
describe("messageMasksUserName", () => {
  const masked = { id: "778899123", username: "my_account", names: ["阿凡达2"] };

  it("takes the prompt masking our name and leaves another joiner's alone", () => {
    expect(messageMasksUserName(msg("欢迎 阿**达2 加入群组！请完成入群验证。"), masked)).toBe(false);
    expect(messageMasksUserName(msg("欢迎 阿**2 加入群组！请完成入群验证。"), masked)).toBe(true);
    expect(messageMasksUserName(msg("欢迎 王**明 加入群组！请完成入群验证。"), masked)).toBe(false);
  });

  it("matches a latin name of the same length", () => {
    const tim = { id: "1", names: ["Timothy"] };
    expect(messageMasksUserName(msg("欢迎 T*****y 加入群组"), tim)).toBe(true);
    expect(messageMasksUserName(msg("欢迎 T*****r 加入群组"), tim)).toBe(false);
  });

  it("requires the ends to line up even when only one masked name is present", () => {
    const tim = { id: "1", names: ["Timothy"] };
    // A bot using a fixed star count still identifies us unambiguously here.
    expect(messageMasksUserName(msg("欢迎 T***y 加入群组"), tim)).toBe(true);
    expect(messageMasksUserName(msg("欢迎 B***b 加入群组"), tim)).toBe(false);
  });

  it("will not guess between several masked names of the wrong length", () => {
    const tim = { id: "1", names: ["Timothy"] };
    expect(messageMasksUserName(msg("欢迎 T***y 和 T***y 加入群组"), tim)).toBe(false);
  });

  // The same bot that masks "思***绪" posts "小明" whole -- two characters have no middle
  // to hide -- so a short-named account has to recognise its own prompt from the plain name.
  it("takes a two-character name the bot could not mask", () => {
    const short = { id: "1", names: ["小明"] };
    expect(messageMasksUserName(msg("欢迎 小明 加入群组！请完成入群验证。"), short)).toBe(true);
    expect(messageMasksUserName(msg("欢迎 思***绪 ⭐️ 加入群组！请完成入群验证。"), short)).toBe(false);
  });

  it("ignores a message with no name of ours in it, and an account with no name", () => {
    expect(messageMasksUserName(msg("欢迎 Bobby 加入群组"), { id: "1", names: ["Timothy"] })).toBe(false);
    expect(messageMasksUserName(msg("欢迎 T*****y 加入群组"), { id: "1" })).toBe(false);
    expect(messageMasksUserName(null, masked)).toBe(false);
  });
});

// The same welcome bot sometimes poses its check as a quiz poll rather than a keyboard.
// The joiner's name is then in the poll question, where the message text is empty, so a
// prompt-matching filter that only reads m.message never recognises its own prompt.
describe("a prompt posed as a quiz poll", () => {
  const pollMsg = (question: string, entities: unknown[] = []) => {
    const media = Object.create(Api.MessageMediaPoll.prototype);
    media.poll = { closed: false, question: { text: question, entities } };
    media.results = {};
    return { message: "", media } as unknown as Api.Message;
  };

  it("reads the name out of the question", () => {
    expect(messageAddressesUser(pollMsg("@my_account 请选择正确的答案 4 + 8?"), me)).toBe(true);
    expect(messageAddressesUser(pollMsg("@someone_else 请选择正确的答案 4 + 8?"), me)).toBe(false);
  });

  it("reads a text mention out of the question's own entities", () => {
    const mention = [{ userId: { toString: () => "778899123" } }];
    expect(messageAddressesUser(pollMsg("请选择正确的答案 4 + 8?", mention), noUsername)).toBe(true);
  });

  it("recognises the plain display name these quizzes address people by", () => {
    const rachel = { id: "1", names: ["Rachel"] };
    expect(messageMasksUserName(pollMsg("Rachel, 请选择正确的答案 4 + 8?"), rachel)).toBe(true);
    expect(messageMasksUserName(pollMsg("Jimmy, 请选择正确的答案 4 + 8?"), rachel)).toBe(false);
  });
});
