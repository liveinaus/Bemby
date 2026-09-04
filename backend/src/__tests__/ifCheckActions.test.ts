// Branching in a custom job's action chain. The case it exists for: a site that only
// sometimes prints its success wording, where a plain retry then meets "already done today"
// and reports that as a failure too. The chain has to be able to let the flaky action fail,
// ask an extra question afterwards, and settle the run on the answer rather than on what the
// first action happened to say.
const { clients } = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) },
}));

vi.mock("telegram/sessions", () => ({ StringSession: class {} }));

// Only the client is a stand-in: Api.Message and the matchers the chain judges a reply by are
// the real thing, which is the part worth testing.
vi.mock("telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("telegram")>();
  return {
    ...actual,
    TelegramClient: class {
      /** Commands the bot refuses, which is how a step is made to fail. */
      rejects = new Set<string>();
      /** What `getMessages` hands back, i.e. what is sitting in the chat. */
      history: any[] = [];
      sent: string[] = [];
      nextId = 100;
      connect = async () => {};
      destroy = async () => {};
      getPeerId = async () => "1";
      getInputEntity = async () => ({});
      downloadMedia = async () => undefined;
      addEventHandler = () => {};
      removeEventHandler = () => {};
      invoke = async () => ({});
      getMessages = async () => this.history;
      sendMessage = async (_peer: string, opts: { message: string }) => {
        if (this.rejects.has(opts.message))
          throw new Error(`the bot refused ${opts.message}`);
        this.sent.push(opts.message);
        return { id: ++this.nextId, date: 1 };
      };
      constructor() {
        clients.push(this);
      }
    },
  };
});

import { Api } from "telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertActionDepth, runCustom, stepNeedingBot } from "../jobs/custom";
import type { CustomAction, CustomConfig } from "../types";

/** A bot message as GramJS hands one over: real class, only the fields the chain reads. */
function botMessage(text: string, id = 11): Api.Message {
  const msg = Object.create(Api.Message.prototype) as any;
  msg.id = id;
  msg.peerId = new Api.PeerUser({ userId: BigInt(1) as any });
  msg.message = text;
  msg.out = false;
  return msg as Api.Message;
}

const run = (
  actions: CustomAction[],
  extra: Partial<CustomConfig> = {},
  maxRetries = 1,
) =>
  runCustom(
    1,
    "hash",
    "session",
    "xsDogeBot",
    { actions, ...extra },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    maxRetries,
  );

const client = () => clients[clients.length - 1];

beforeEach(() => {
  clients.length = 0;
});

describe("if_check", () => {
  it("clears a flaky failure when the chat proves the work was already done", async () => {
    const actions: CustomAction[] = [
      { type: "send_command", content: "/checkin", continueOnError: true },
      {
        type: "if_check",
        check: "reply_text",
        text: "签到成功|今日已签到",
        then: [{ type: "end_job", reason: "already checked in" }],
        otherwise: [{ type: "fail_job", reason: "the check-in did not take" }],
      },
      { type: "send_command", content: "/never" },
    ];

    const started = run(actions, {}, 3);
    // The chain's first step is refused, and the chat says it did not matter
    client().rejects.add("/checkin");
    client().history = [botMessage("今日已签到，明天再来")];

    const log = await started;

    expect(log.steps.map((s) => s.actionType)).toEqual([
      "send_command",
      "if_check",
      "end_job",
    ]);
    expect(log.steps[0].error).toContain("refused");
    expect(log.steps[0].result).toBe("Failed, carrying on");
    expect(log.steps[1].result).toContain("then branch");
    expect(log.steps[2].result).toBe("already checked in");
    // `end_job` stops the chain outright, so neither the action after it nor a second job
    // attempt runs -- the retry is exactly what was producing the false alarm
    expect(client().sent).toEqual([]);
  });

  it("fails through the else arm when nothing proves the work was done", async () => {
    const actions: CustomAction[] = [
      { type: "send_command", content: "/checkin", continueOnError: true },
      {
        type: "if_check",
        check: "reply_text",
        text: "签到成功|今日已签到",
        then: [{ type: "end_job" }],
        otherwise: [{ type: "fail_job", reason: "the check-in did not take" }],
      },
    ];

    const started = run(actions);
    client().rejects.add("/checkin");
    client().history = [botMessage("服务器开小差了")];

    await expect(started).rejects.toThrow("the check-in did not take");
  });

  it("branches on how the action before it came out", async () => {
    const actions: CustomAction[] = [
      { type: "send_command", content: "/checkin", continueOnError: true },
      {
        type: "if_check",
        check: "last_action",
        outcome: "failed",
        then: [{ type: "send_command", content: "/retry" }],
        otherwise: [{ type: "send_command", content: "/thanks" }],
      },
    ];

    const started = run(actions);
    client().rejects.add("/checkin");
    const log = await started;

    expect(client().sent).toEqual(["/retry"]);
    // The branch's own action is logged as a step of its own, one level in
    expect(log.steps[2].depth).toBe(1);
  });

  it("takes an else-if arm before falling through to the else", async () => {
    const actions: CustomAction[] = [
      { type: "send_command", content: "/checkin", continueOnError: true },
      {
        type: "if_check",
        check: "reply_text",
        text: "签到成功",
        then: [{ type: "send_command", content: "/first" }],
        elseIfs: [
          {
            check: "reply_text",
            text: "今日已签到",
            then: [{ type: "send_command", content: "/second" }],
          },
        ],
        otherwise: [{ type: "send_command", content: "/third" }],
      },
    ];

    const started = run(actions);
    client().rejects.add("/checkin");
    client().history = [botMessage("今日已签到，明天再来")];

    const log = await started;
    expect(client().sent).toEqual(["/second"]);
    expect(log.steps[1].result).toContain("else if 1");
  });

  it("takes the then arm when a negated condition is not met", async () => {
    const actions: CustomAction[] = [
      {
        type: "if_check",
        check: "reply_text",
        text: "签到成功",
        negate: true,
        then: [{ type: "send_command", content: "/again" }],
      },
    ];

    const started = run(actions);
    client().history = [botMessage("服务器开小差了")];

    await started;
    expect(client().sent).toEqual(["/again"]);
  });
});

describe("continueOnError", () => {
  it("still fails the job when the action is not marked to carry on", async () => {
    const started = run([
      { type: "send_command", content: "/checkin" },
      { type: "send_command", content: "/after" },
    ]);
    client().rejects.add("/checkin");

    await expect(started).rejects.toThrow("refused");
    expect(client().sent).toEqual([]);
  });
});

describe("assertActionDepth", () => {
  it("accepts checks nested to the cap", () => {
    const nest = (depth: number): CustomAction =>
      depth === 0
        ? { type: "delay", waitMs: 1 }
        : { type: "if_check", check: "last_action", then: [nest(depth - 1)] };
    expect(() => assertActionDepth([nest(3)])).not.toThrow();
    expect(() => assertActionDepth([nest(4)])).toThrow(/nested more than 3/);
  });
});

describe("stepNeedingBot", () => {
  it("looks inside a branch for a step with no bot to work from", () => {
    const actions: CustomAction[] = [
      {
        type: "if_check",
        check: "last_action",
        then: [{ type: "send_command", content: "/checkin" }],
      },
    ];
    expect(stepNeedingBot(actions, "")).toEqual({ at: 0, type: "if_check" });
    expect(stepNeedingBot(actions, "xsDogeBot")).toBeNull();
  });

  it("is content with a chain whose branches name their own contacts", () => {
    const actions: CustomAction[] = [
      {
        type: "if_check",
        check: "reply_text",
        text: "ok",
        contact: "someBot",
        then: [{ type: "send_contact_message", contact: "someBot", content: "/hi" }],
        otherwise: [{ type: "end_job" }],
      },
    ];
    expect(stepNeedingBot(actions, "")).toBeNull();
  });
});
