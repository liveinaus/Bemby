// A bot that does the whole check-in from the command replies with text and no buttons. The
// wait for a buttons message runs out, but the reply is already the answer: where it carries
// the configured success text the run succeeded, and reporting a timeout called it a failure.
const { clients } = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) },
}));

vi.mock("telegram/sessions", () => ({ StringSession: class {} }));

// Everything but the client and its session is the real thing: Api.Message and the instanceof checks
// in parseMessages are what the code under test reads the reply with.
vi.mock("telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("telegram")>();
  return {
    ...actual,
    TelegramClient: class {
      handlers: Array<{ h: (event: any) => void; event: any }> = [];
      sent: string[] = [];
      connect = async () => {};
      destroy = async () => {};
      downloadMedia = async () => undefined;
      getInputEntity = async () => ({});
      getPeerId = async () => "1";
      callbackAnswer: string | Error = "签到成功，获得 65MB 流量";
      invoked: number[] = [];
      invoke = async (req: any) => {
        this.invoked.push(req?.msgId ?? 0);
        if (this.callbackAnswer instanceof Error) throw this.callbackAnswer;
        return { message: this.callbackAnswer };
      };
      getMessages = async () => [];
      addEventHandler = (h: (event: any) => void, event: any) =>
        this.handlers.push({ h, event });
      removeEventHandler = () => {};
      sendMessage = async (_peer: string, opts: { message: string }) => {
        this.sent.push(opts.message);
      };
      constructor() {
        clients.push(this);
      }
    },
  };
});

import { Api } from "telegram";
import { NewMessage, Raw } from "telegram/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheckin, CheckinError } from "../jobs/checkin";

const REPLY_TIMEOUT_MS = 40_000;

/** A bot message as GramJS hands one over: real class, only the fields the code reads. */
function botMessage(text: string, buttons?: string[], id = 11): Api.Message {
  const msg = Object.create(Api.Message.prototype) as any;
  msg.id = id;
  msg.peerId = new Api.PeerUser({ userId: BigInt(1) as any });
  msg.message = text;
  msg.entities = undefined;
  msg.media = undefined;
  msg.out = false;
  if (buttons) {
    msg.replyMarkup = new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardButtonRow({
          buttons: buttons.map(
            (text) => new Api.KeyboardButtonCallback({ text, data: Buffer.from(text) }),
          ),
        }),
      ],
    });
  }
  return msg as Api.Message;
}

/**
 * Runs a check-in against a bot that answers with `reply`, then lets the reply wait run out.
 * The run is started, the reply delivered to the handler the wait registered, and the clock
 * pushed past the timeout.
 */
async function checkinAnswering(
  reply: Api.Message,
  outcome: { successContains?: string; failContains?: string },
) {
  const run = runCheckin(
    1,
    "hash",
    "session",
    "xsDogeBot",
    REPLY_TIMEOUT_MS,
    "/checkin",
    "签到",
    1,
    0,
    undefined,
    undefined,
    undefined,
    outcome.successContains,
    outcome.failContains,
  );
  // Watched from the start: the run settles while the clock is being pushed forward below,
  // and an unwatched rejection at that point is reported as an unhandled one
  void run.catch(() => {});
  // Let connect() and the handler registration settle before the bot "answers"
  await vi.advanceTimersByTimeAsync(0);
  return { run, client: clients[clients.length - 1] };
}

/** Hands a message to the watcher that would have received it from Telegram. */
function sendTo(client: any, msg: Api.Message, kind: "new" | "edit" = "new") {
  for (const { h, event } of client.handlers) {
    if (kind === "new" && event instanceof NewMessage) h({ message: msg });
    if (kind === "edit" && event instanceof Raw) {
      h({ className: "UpdateEditMessage", message: msg });
    }
  }
}

/** The whole run: the bot answers, then the reply wait is allowed to run out. */
async function checkinTimingOutAfter(
  reply: Api.Message,
  outcome: { successContains?: string; failContains?: string },
) {
  const { run, client } = await checkinAnswering(reply, outcome);
  sendTo(client, reply);
  await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS + 10);
  return { run, client };
}

beforeEach(() => {
  clients.length = 0;
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe("a bot that replies with text and no buttons", () => {
  const REPLY = "尊贵的二级会员，您获得了 65MB 流量。";

  it("counts as a success when the reply holds the success text", async () => {
    const { run, client } = await checkinTimingOutAfter(botMessage(REPLY), {
      successContains: "尊贵的二级会员",
      failContains: "您似乎已经签到过",
    });

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.commandResponseHtml).toContain("尊贵的二级会员");
    expect(client.sent).toEqual(["/checkin"]);
  });

  it("counts as a failure, and says why, when the reply holds the failure text", async () => {
    const { run } = await checkinTimingOutAfter(botMessage("您似乎已经签到过了"), {
      successContains: "尊贵的二级会员",
      failContains: "您似乎已经签到过",
    });

    await expect(run).rejects.toThrow(/Reply indicates failure/);
    await run.catch((err: CheckinError) => {
      // The reply is still on the log, and the reason is the bot's answer rather than the wait
      expect(err.log.commandResponseHtml).toContain("您似乎已经签到过了");
      expect(err.log.error).not.toMatch(/Timed out/);
    });
  });

  it("still reports the timeout when the reply settles nothing", async () => {
    const { run } = await checkinTimingOutAfter(botMessage("请稍后再试"), {
      successContains: "尊贵的二级会员",
      failContains: "您似乎已经签到过",
    });

    await expect(run).rejects.toThrow(/Timed out after 40000ms/);
  });

  it("still reports the timeout when the job set no outcome text to judge by", async () => {
    const { run } = await checkinTimingOutAfter(botMessage(REPLY), {});
    await expect(run).rejects.toThrow(/Timed out after 40000ms/);
  });
});

describe("a bot that does send buttons", () => {
  it("takes the button path even when its text holds the success word", async () => {
    // Guards the fix against overreach: a menu whose greeting happens to carry the success
    // text must still be pressed, not reported as a check-in that already happened.
    const { run } = await checkinTimingOutAfter(
      botMessage("尊贵的二级会员，请选择：", ["余额"]),
      { successContains: "尊贵的二级会员" },
    );

    await expect(run).rejects.toThrow(/not found in bot reply/);
  });
});

// A bot that posts its text first and edits that same message to attach the keyboard: the
// buttons never arrive as a new message, so an edit-blind wait would time out in front of them.
describe("a bot that edits its reply instead of sending another", () => {
  it("sees the buttons an edit brings", async () => {
    const { run, client } = await checkinAnswering(botMessage("正在处理…"), {
      successContains: "尊贵的二级会员",
    });
    sendTo(client, botMessage("正在处理…"));
    sendTo(client, botMessage("请签到：", ["余额"]), "edit");
    await vi.advanceTimersByTimeAsync(10);

    // Past the wait and into the button path, rather than stuck until the timeout
    await expect(run).rejects.toThrow(/not found in bot reply/);
  });

  it("judges the text as the edit left it", async () => {
    const { run, client } = await checkinAnswering(botMessage("正在处理…"), {
      successContains: "尊贵的二级会员",
    });
    sendTo(client, botMessage("正在处理…"));
    sendTo(client, botMessage("尊贵的二级会员，您获得了 65MB 流量。"), "edit");
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS + 10);

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.commandResponseHtml).toBe("尊贵的二级会员，您获得了 65MB 流量。");
  });

  it("ignores an edit from another chat", async () => {
    const { run, client } = await checkinAnswering(botMessage("正在处理…"), {
      successContains: "尊贵的二级会员",
    });
    sendTo(client, botMessage("正在处理…"));
    const elsewhere = botMessage("尊贵的二级会员", ["签到"]);
    (elsewhere as any).peerId = new Api.PeerUser({ userId: BigInt(99) as any });
    sendTo(client, elsewhere, "edit");
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS + 10);

    await expect(run).rejects.toThrow(/Timed out after 40000ms/);
  });
});

// The ordinary flow, unchanged by any of the above: the command brings buttons, the button is
// pressed, and the text that comes back decides the outcome.
describe("command, buttons, click, check the text", () => {
  const withButton = () => botMessage("请点击下方按钮签到", ["签到"]);

  it("presses the button and takes the callback answer as the outcome", async () => {
    const { run, client } = await checkinAnswering(withButton(), {
      successContains: "签到成功",
      failContains: "已经签到",
    });
    sendTo(client, withButton());
    // Past the click, then the grace window for a follow-up message
    await vi.advanceTimersByTimeAsync(6_000);

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.buttonClicked).toBe("签到");
    expect(log.callbackAnswer).toBe("签到成功，获得 65MB 流量");
    expect(log.availableButtons).toEqual([["签到"]]);
    expect(client.invoked).toEqual([11]);
  });

  it("fails when the answer carries the failure text", async () => {
    const { run, client } = await checkinAnswering(withButton(), {
      successContains: "签到成功",
      failContains: "已经签到",
    });
    client.callbackAnswer = "您今天已经签到过了";
    sendTo(client, withButton());
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(run).rejects.toThrow(/Reply indicates failure/);
  });

  it("fails when the answer never shows the success text", async () => {
    const { run, client } = await checkinAnswering(withButton(), {
      successContains: "签到成功",
    });
    client.callbackAnswer = "请稍后再试";
    sendTo(client, withButton());
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(run).rejects.toThrow(/Expected success indicator/);
  });

  it("takes the outcome from a follow-up message when the answer is silent", async () => {
    const { run, client } = await checkinAnswering(withButton(), {
      successContains: "签到成功",
    });
    client.callbackAnswer = "";
    sendTo(client, withButton());
    await vi.advanceTimersByTimeAsync(0);
    sendTo(client, botMessage("签到成功，明天再来", undefined, 12));
    await vi.advanceTimersByTimeAsync(10);

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.buttonResponseSource).toBe("new_message");
    expect(log.buttonResponseHtml).toContain("签到成功");
  });

  it("takes it from an edit of the buttons message just as well", async () => {
    const { run, client } = await checkinAnswering(withButton(), {
      successContains: "签到成功",
    });
    client.callbackAnswer = "";
    sendTo(client, withButton());
    await vi.advanceTimersByTimeAsync(0);
    sendTo(client, botMessage("签到成功，已记录"), "edit");
    await vi.advanceTimersByTimeAsync(10);

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.buttonResponseSource).toBe("edit");
  });

  it("still says the button is missing when the label does not match", async () => {
    const { run, client } = await checkinAnswering(botMessage("菜单", ["余额", "邀请"]), {
      successContains: "签到成功",
    });
    sendTo(client, botMessage("菜单", ["余额", "邀请"]));
    await vi.advanceTimersByTimeAsync(10);

    await expect(run).rejects.toThrow(/Button "签到" not found in bot reply/);
  });
});

// A bot with more than one wording for the same outcome: `|` lists them, and any one counts.
describe("a success matcher listing alternatives", () => {
  it("matches the wording that actually turned up", async () => {
    const { run, client } = await checkinAnswering(botMessage("菜单", ["签到"]), {
      successContains: "签到成功|签到中",
    });
    client.callbackAnswer = "签到中...";
    sendTo(client, botMessage("菜单", ["签到"]));
    await vi.advanceTimersByTimeAsync(6_000);

    const log = await run;
    expect(log.error).toBeUndefined();
    expect(log.callbackAnswer).toBe("签到中...");
  });

  it("matches the other wording just as well", async () => {
    const { run, client } = await checkinAnswering(botMessage("菜单", ["签到"]), {
      successContains: "签到成功|签到中",
    });
    client.callbackAnswer = "🎉 签到成功！获得 145 积分";
    sendTo(client, botMessage("菜单", ["签到"]));
    await vi.advanceTimersByTimeAsync(6_000);

    expect((await run).error).toBeUndefined();
  });

  it("fails when neither wording turns up", async () => {
    const { run, client } = await checkinAnswering(botMessage("菜单", ["签到"]), {
      successContains: "签到成功|签到中",
    });
    client.callbackAnswer = "请稍后再试";
    sendTo(client, botMessage("菜单", ["签到"]));
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(run).rejects.toThrow(/Expected success indicator/);
  });

  it("settles a text-only reply by any of the wordings too", async () => {
    const { run } = await checkinTimingOutAfter(botMessage("签到中，请稍候"), {
      successContains: "签到成功|签到中",
    });
    expect((await run).error).toBeUndefined();
  });
});
