// The collect-and-loop pair: reading a list off a page once and working through it, which is
// what a round that leaves the list page behind needs. Driven against a stand-in page, the
// same way webRepeatSteps.test.ts drives the other loop, so the control flow is covered
// wherever CloakBrowser is not installed.
//
// Also here: the steps a page needs once the loop is opening things -- writing a reply with
// the AI into a field the config names, pressing a key to send it, choosing in a dropdown,
// and the pointer pair a verification widget wants: holding a control down, and dragging one.
//
// The tuning row keeps the between-step pauses out of the run: they are there for a real page
// to settle and are dead time against a stand-in.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 100 }),
      }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { normaliseKey, parseWebAiText, runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

const HOME = "https://forum.example/";

type Held = string | { value: string; text: string };

/** What the stand-in was asked to do outside `evaluate`, so a step can be checked. */
type PageCalls = {
  pressed: Array<{ selector?: string; key: string }>;
  selected: Array<{ selector: string; arg: { label?: string; value?: string } }>;
  typed: string[];
  /** Every pointer call in order: where it moved, and when the button went down and up. */
  pointer: Array<{ at: "move" | "down" | "up" | "click"; x?: number; y?: number }>;
};

/**
 * A page answering the handful of things these steps ask of a browser. `evaluate` tells its
 * callers apart by what they hand it: the collect step passes an argument object, and the
 * rest pass a bare selector and are told apart by what their body asks for -- a box to press,
 * whether the element is there at all, or the text on it.
 *
 * `present` says which elements this page holds, and is given the address as well, so a test
 * can have one page in a loop's run behave differently from the others.
 */
function fakePage(
  matches: Record<string, Held[] | (() => Held[])> = {},
  opts: {
    options?: Record<string, string[]>;
    noSuchElement?: string;
    present?: (selector: string, url: string) => boolean;
    /** Where each element sits, for the steps that aim the pointer at one. */
    centres?: Record<string, { x: number; y: number }>;
  } = {},
) {
  // `visited` is the browser's own stack, which going back pops; `opened` is every address
  // the run asked for, in order, which is what a test about a loop's path wants
  const visited: string[] = [HOME];
  const opened: string[] = [];
  const calls: PageCalls = { pressed: [], selected: [], typed: [], pointer: [] };

  const held = (sel: string): Array<{ value: string; text: string }> => {
    const found = matches[sel];
    const list = typeof found === "function" ? found() : (found ?? []);
    return list.map((h) => (typeof h === "string" ? { value: h, text: h } : h));
  };
  const there = (sel: string) =>
    sel !== opts.noSuchElement && (opts.present?.(sel, visited[visited.length - 1]) ?? true);

  const page = {
    title: async () => "",
    url: () => visited[visited.length - 1],
    goto: async (url: string) => {
      visited.push(url);
      opened.push(url);
    },
    goBack: async () => {
      if (visited.length > 1) visited.pop();
    },
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    press: async (selector: string, key: string) => {
      if (selector === opts.noSuchElement) throw new Error("locator resolved to no element");
      calls.pressed.push({ selector, key });
    },
    keyboard: {
      press: async (key: string) => {
        calls.pressed.push({ key });
      },
      type: async (text: string) => {
        calls.typed.push(text);
      },
    },
    selectOption: async (selector: string, arg: { label?: string; value?: string }) => {
      calls.selected.push({ selector, arg });
      const available = opts.options?.[selector] ?? [];
      const wanted = arg.label ?? arg.value ?? "";
      // The stand-in knows labels only, so a lookup by value finds nothing -- which is what
      // makes the step's second attempt visible
      return arg.label && available.includes(wanted) ? [wanted] : [];
    },
    // A pointer: the click that focuses a field before it is typed into, and the hold and
    // drag steps, whose whole worth is in the moves they make
    mouse: {
      move: async (x: number, y: number) => {
        calls.pointer.push({ at: "move", x, y });
      },
      click: async (x: number, y: number) => {
        calls.pointer.push({ at: "click", x, y });
      },
      down: async () => {
        calls.pointer.push({ at: "down" });
      },
      up: async () => {
        calls.pointer.push({ at: "up" });
      },
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      if (arg && typeof arg === "object" && "sel" in (arg as Record<string, unknown>))
        return held((arg as { sel: string }).sel);
      if (typeof arg === "string") {
        // What the pointer steps ask for: the middle of the element they aim at
        if (body.includes("scrollIntoView"))
          return there(arg) ? (opts.centres?.[arg] ?? { x: 20, y: 10 }) : null;
        // What the wait and the branch ask for: whether it is on the page at all
        if (body.includes("getBoundingClientRect")) return there(arg);
        return held(arg)[0]?.value ?? "";
      }
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it, rather than one still booting up";
    },
  };

  return { page: page as unknown as Page, visited, opened, calls };
}

const run = (page: Page, steps: WebStep[], hooks: Parameters<typeof runWebSteps>[3] = {}) =>
  runWebSteps(page, steps, Date.now() + 30_000, hooks);

const POSTS = ".post-list-item a";
const LIST = { [POSTS]: ["/post-859148-1", "/post-859149-1", "/post-859150-1"] };

const COLLECT: WebStep = {
  type: "web_collect",
  selector: POSTS,
  varName: "postId",
  attribute: "href",
  pattern: "/post-(\\d+)",
  skipUsed: true,
};

const OK_STEP: WebStep = { type: "web_delay", waitMs: 1 };

const forEach = (varName: string, steps: WebStep[], extra: Record<string, unknown> = {}): WebStep =>
  ({ type: "web_for_each", varName, steps, ...extra }) as WebStep;

describe("web_collect", () => {
  it("keeps every value the pattern describes, in page order", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [COLLECT], { usedValues: () => [] });

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe(
      "collected 3 value(s) into {postId}: 859148, 859149, 859150",
    );
  });

  it("leaves out what the job has already been through", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [COLLECT], { usedValues: () => ["859148"] });

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toContain("collected 2 value(s)");
    expect(out.logs[0].outcome).toContain("(1 of 3 already used)");
  });

  it("caps the list at the limit it was given", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [{ ...COLLECT, limit: 2 } as WebStep], { usedValues: () => [] });

    expect(out.logs[0].outcome).toContain("collected 2 value(s)");
    expect(out.logs[0].outcome).toContain("capped at 2");
  });

  it("reports a page with nothing new left, rather than failing", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [COLLECT, forEach("postId", [OK_STEP])], {
      usedValues: () => ["859148", "859149", "859150"],
    });

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toMatch(/nothing left to collect/);
    expect(out.logs[1].outcome).toBe("{postId} holds nothing to work through");
  });
});

describe("web_for_each", () => {
  it("runs one round per collected value, with {name} standing for the one in hand", async () => {
    const f = fakePage(LIST);
    const used: string[] = [];
    const out = await run(
      f.page,
      [
        { type: "web_goto", url: HOME },
        COLLECT,
        forEach("postId", [
          { type: "web_goto", url: `${HOME}post-{postId}-1` },
          { type: "web_back" },
        ]),
      ],
      { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
    );

    expect(out.ok).toBe(true);
    // The front page once, then each post in turn, coming back to the list between them
    expect(f.opened).toEqual([
      HOME,
      `${HOME}post-859148-1`,
      `${HOME}post-859149-1`,
      `${HOME}post-859150-1`,
    ]);
    expect(f.page.url()).toBe(HOME);
    // Every round is labelled with the value it is on, so a log says which post it was
    expect(out.logs.filter((l) => l.type === "web_back").map((l) => l.iteration)).toEqual([
      "1/3 859148",
      "2/3 859149",
      "3/3 859150",
    ]);
    expect(used).toEqual(["859148", "859149", "859150"]);
    const summary = out.logs.find((l) => l.type === "web_for_each")!;
    expect(summary.outcome).toBe("3 of 3 round(s) got through");
    expect(summary.screenshot).toBeUndefined();
  });

  it("stops after the maximum it was given", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [COLLECT, forEach("postId", [OK_STEP], { max: 2 })], {
      usedValues: () => [],
    });

    expect(out.logs.find((l) => l.type === "web_for_each")!.outcome).toBe(
      "2 of 2 round(s) got through",
    );
  });

  it("only remembers a value whose round got through", async () => {
    // The second post never shows its reply box, so that round falls over: the post is worth
    // another go on the next run, and must not be written down as done
    const f = fakePage(LIST, {
      present: (sel, url) => sel !== ".reply-box" || !url.includes("859149"),
    });
    const used: string[] = [];
    const out = await run(
      f.page,
      [
        COLLECT,
        forEach("postId", [
          { type: "web_goto", url: `${HOME}post-{postId}-1` },
          { type: "web_wait_element", selector: ".reply-box", waitMs: 1 },
        ]),
      ],
      { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
    );

    expect(used).toEqual(["859148", "859150"]);
    const summary = out.logs.find((l) => l.type === "web_for_each")!;
    expect(summary.outcome).toMatch(/^2 of 3 round\(s\) got through; 1 failed/);
  });

  it("stops at the first failed round when told not to carry on", async () => {
    const f = fakePage(LIST);
    const bad: WebStep = { type: "web_button", selector: "" };
    const out = await run(
      f.page,
      [COLLECT, forEach("postId", [bad], { continueOnError: false })],
      { usedValues: () => [] },
    );

    expect(out.ok).toBe(false);
    expect(out.failure).toMatch(/1 of 3|0 of 3/);
    expect(out.logs.filter((l) => l.type === "web_button")).toHaveLength(1);
  });

  it("says so when nothing has been collected under that name", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [forEach("postId", [OK_STEP])]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/nothing has been collected into \{postId\}/);
  });

  it("fails a loop with nothing in it", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [COLLECT, forEach("postId", [])], { usedValues: () => [] });
    expect(out.logs[1].error).toBe("the loop has no steps to run");
  });

  it("refuses a loop inside a loop", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [COLLECT, forEach("postId", [forEach("postId", [OK_STEP])])],
      { usedValues: () => [] },
    );
    expect(out.ok).toBe(false);
    expect(out.failure).toMatch(/cannot be put inside another loop/);
  });
});

describe("web_ai_input", () => {
  const reply: WebStep = {
    type: "web_ai_input",
    selector: "#reply",
    hint: "a short friendly reply to this post: {postText}",
    varName: "written",
  };

  it("hands the round's values to the model and types what comes back", async () => {
    const f = fakePage({ ".post-body": ["Anyone else on the beta?"] });
    let prompt = "";
    const out = await run(
      f.page,
      [{ type: "web_read", selector: ".post-body", varName: "postText" }, reply],
      {
        aiLocate: async (_image, p) => {
          prompt = p;
          return '{"text": "Been on it a week, no complaints."}';
        },
      },
    );

    expect(out.ok).toBe(true);
    // What the page said reaches the model as text, rather than being left to the screenshot
    expect(prompt).toContain("Anyone else on the beta?");
    expect(f.calls.typed).toEqual(["Been on it a week, no complaints."]);
    expect(out.logs[1].outcome).toContain("AI wrote 33 character(s) into `#reply`");
  });

  it("cuts the answer to the length it was given", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...reply, maxChars: 10 } as WebStep], {
      aiLocate: async () => "This answer runs on well past the limit.",
    });

    expect(out.ok).toBe(true);
    expect(f.calls.typed).toEqual(["This answe"]);
  });

  it("fails rather than typing nothing when the model answers empty", async () => {
    const f = fakePage();
    const out = await run(f.page, [reply], { aiLocate: async () => "   " });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/wrote nothing usable/);
    expect(f.calls.typed).toEqual([]);
  });

  it("needs a model to be configured", async () => {
    const f = fakePage();
    const out = await run(f.page, [reply]);
    expect(out.logs[0].error).toBe("no AI model is configured for this step");
  });
});

// The shape of a signup: settle on the credentials up front, fill the form in with them, and
// send them on at the end. Typing `{alpha:12}` straight into the field would work once and
// leave nothing able to say what the password had been.
describe("web_set and web_notify", () => {
  it("holds a value of its own, for later steps to use", async () => {
    const f = fakePage();
    const sent: Array<{ text: string; target?: string }> = [];
    const out = await run(
      f.page,
      [
        { type: "web_set", varName: "username", value: "bemby_{word:6}" },
        { type: "web_set", varName: "password", value: "{alpha:12}" },
        { type: "web_input", selector: "#user", text: "{username}" },
        { type: "web_input", selector: "#pass", text: "{password}" },
        { type: "web_notify", text: "signed up: {username}----{password}" },
      ],
      { notify: async (text, target) => void sent.push({ text, target }) },
    );

    expect(out.ok).toBe(true);
    const [user, pass] = f.calls.typed;
    expect(user).toMatch(/^bemby_[a-z]{6}$/);
    expect(pass).toMatch(/^[a-zA-Z0-9]{12}$/);
    // The same values reach the message: settled once, used three times over
    expect(sent).toEqual([{ text: `signed up: ${user}----${pass}`, target: undefined }]);
  });

  it("builds one value out of another", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_set", varName: "user", value: "sam" },
      { type: "web_set", varName: "email", value: "{user}+{num:3}@example.com" },
      { type: "web_input", selector: "#email", text: "{email}" },
    ]);

    expect(out.ok).toBe(true);
    expect(f.calls.typed[0]).toMatch(/^sam\+\d{3}@example\.com$/);
  });

  it("shows the value in the log, since remembering it is the point", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_set", varName: "password", value: "hunter2" },
    ]);

    expect(out.logs[0].outcome).toBe("{password} = hunter2");
  });

  // What a signup asks for: a given name, a surname, and a username made of the two. One step
  // per name would work as well; several rows in one is what the form is for.
  it("sets several names in one step, each row seeing the rows above it", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      {
        type: "web_set",
        vars: [
          { name: "fn", value: "{randomFirstName}" },
          { name: "ln", value: "{randomLastName}" },
          { name: "username", value: "{fn}_{ln}_{num:4}" },
        ],
      },
      { type: "web_input", selector: "#user", text: "{username}" },
    ]);

    expect(out.ok).toBe(true);
    const typed = f.calls.typed[0];
    expect(typed).toMatch(/^[A-Za-z]+_[A-Za-z]+_\d{4}$/);
    // Every pair reaches the log, the third of them built out of the two above it
    const [fn, ln] = typed.split("_");
    expect(out.logs[0].outcome).toBe(
      `{fn} = ${fn}, {ln} = ${ln}, {username} = ${typed}`,
    );
  });

  it("fails the step when a row has no name to hold its value under", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_set", vars: [{ name: "ok", value: "1" }, { name: " ", value: "2" }] },
    ]);

    expect(out.logs[0].error).toBe("no name given to hold the value under");
  });

  it("fails a step with no rows at all", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_set", vars: [] }]);

    expect(out.logs[0].error).toBe("no name given to hold the value under");
  });

  it("sends to the chat a step names, over the configured default", async () => {
    const f = fakePage();
    const sent: Array<{ text: string; target?: string }> = [];
    await run(f.page, [{ type: "web_notify", text: "done", target: "@ops_channel" }], {
      notify: async (text, target) => void sent.push({ text, target }),
    });

    expect(sent).toEqual([{ text: "done", target: "@ops_channel" }]);
  });

  it("fails the step when the notification cannot be sent", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_notify", text: "done" }], {
      notify: async () => {
        throw new Error("no chat to send to");
      },
    });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("no chat to send to");
  });

  it("says so when no notification bot is wired up at all", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_notify", text: "done" }]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no notification bot is configured/);
  });

  it("a value set before a loop is still there inside every round", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [
        { type: "web_set", varName: "tag", value: "batch-7" },
        COLLECT,
        forEach("postId", [
          { type: "web_input", selector: "#c", text: "{tag}: {postId}" },
        ]),
      ],
      { usedValues: () => [] },
    );

    expect(out.ok).toBe(true);
    expect(f.calls.typed).toEqual([
      "batch-7: 859148",
      "batch-7: 859149",
      "batch-7: 859150",
    ]);
  });

  it("keeps what a round set out of the rounds after it", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [
        COLLECT,
        forEach("postId", [
          { type: "web_input", selector: "#c", text: "[{leftover}]" },
          { type: "web_set", varName: "leftover", value: "round-{postId}" },
        ]),
      ],
      { usedValues: () => [] },
    );

    expect(out.ok).toBe(true);
    // Round two starts as round one did: an unset name stands as it was written
    expect(f.calls.typed).toEqual(["[{leftover}]", "[{leftover}]", "[{leftover}]"]);
  });
});

describe("normaliseKey", () => {
  it("settles the many spellings of one press on the browser's", () => {
    for (const written of ["Control+Enter", "ctrl+enter", "Ctrl + Enter", "CTRL+return"])
      expect(normaliseKey(written)).toBe("Control+Enter");
    expect(normaliseKey("cmd+a")).toBe("Meta+a");
    expect(normaliseKey("option + delete")).toBe("Alt+Delete");
    expect(normaliseKey(" down ")).toBe("ArrowDown");
  });

  it("leaves a single character exactly as it was typed", () => {
    // `A` is the shifted press and `a` the plain one -- they are not the same key
    expect(normaliseKey("a")).toBe("a");
    expect(normaliseKey("A")).toBe("A");
    expect(normaliseKey("7")).toBe("7");
    expect(normaliseKey("ctrl+A")).toBe("Control+A");
  });

  it("passes a name it does not know through to the browser", () => {
    expect(normaliseKey("F7")).toBe("F7");
    expect(normaliseKey("NumpadEnter")).toBe("NumpadEnter");
    expect(normaliseKey("ctrl+F5")).toBe("Control+F5");
  });

  it("gives nothing back for nothing, so the step can say so", () => {
    expect(normaliseKey("   ")).toBe("");
  });

  it("keeps a bare plus, which is a key in its own right", () => {
    expect(normaliseKey("+")).toBe("+");
  });
});

describe("parseWebAiText", () => {
  it("takes the text out of the JSON object it asked for", () => {
    expect(parseWebAiText('{"text": "Nicely put."}')).toBe("Nicely put.");
  });

  it("takes a plain reply as it stands", () => {
    expect(parseWebAiText("  Nicely put.  ")).toBe("Nicely put.");
  });

  it("strips a code fence a model wrapped its answer in", () => {
    expect(parseWebAiText("```\nNicely put.\n```")).toBe("Nicely put.");
  });

  it("keeps a reply whose JSON is unusable, rather than losing the answer", () => {
    expect(parseWebAiText('{"reply": "Nicely put."}')).toBe('{"reply": "Nicely put."}');
  });
});

describe("web_press and web_select", () => {
  it("presses a key on a field, and on the focus when no selector is given", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_press", key: "Control+Enter", selector: "#reply" },
      { type: "web_press", key: "Escape" },
    ]);

    expect(out.ok).toBe(true);
    expect(f.calls.pressed).toEqual([
      { selector: "#reply", key: "Control+Enter" },
      { key: "Escape" },
    ]);
  });

  it("takes a key written the way a person writes it", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_press", key: "ctrl + enter" },
      { type: "web_press", key: "esc" },
      { type: "web_press", key: "shift+Tab" },
      // A single character is a press of that character, capital and all
      { type: "web_press", key: "a" },
    ]);

    expect(out.ok).toBe(true);
    expect(f.calls.pressed.map((p) => p.key)).toEqual([
      "Control+Enter",
      "Escape",
      "Shift+Tab",
      "a",
    ]);
  });

  it("fails when the field to press on is not there", async () => {
    const f = fakePage({}, { noSuchElement: "#gone" });
    const out = await run(f.page, [{ type: "web_press", key: "Enter", selector: "#gone" }]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/could not be pressed on `#gone`/);
  });

  it("chooses a dropdown option by its label", async () => {
    const f = fakePage({}, { options: { "#reason": ["Daily check-in"] } });
    const out = await run(f.page, [
      { type: "web_select", selector: "#reason", option: "Daily check-in" },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe('chose "Daily check-in" in `#reason`');
  });

  it("tries the option's value when no label matches, then gives up", async () => {
    const f = fakePage({}, { options: { "#reason": ["Daily check-in"] } });
    const out = await run(f.page, [
      { type: "web_select", selector: "#reason", option: "weekly" },
    ]);

    expect(out.ok).toBe(false);
    expect(f.calls.selected.map((s) => s.arg)).toEqual([{ label: "weekly" }, { value: "weekly" }]);
    expect(out.logs[0].error).toBe('`#reason` has no option reading "weekly"');
  });
});

// What a person types into a step is a template, the same as a start command or an address:
// a signup form wants an address of its own each run, not the literal `{word:10}`.
describe("placeholders in what a step types", () => {
  it("expands the random tokens in the text a field is filled with", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_input", selector: "#email", text: "{word:10}@example.com" },
    ]);

    expect(out.ok).toBe(true);
    expect(f.calls.typed[0]).toMatch(/^[a-z]{10}@example\.com$/);
    // The log shows what was actually typed, not the template
    expect(out.logs[0].outcome).toMatch(/@example\.com/);
  });

  it("expands them in an address a step opens", async () => {
    const f = fakePage();
    await run(f.page, [{ type: "web_goto", url: `${HOME}search?q={alpha:6}` }]);

    expect(f.opened[0]).toMatch(/^https:\/\/forum\.example\/search\?q=[A-Za-z0-9]{6}$/);
  });

  it("gives a round's own value precedence over a random token", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [
        COLLECT,
        forEach("postId", [
          { type: "web_input", selector: "#comment", text: "re: {postId} ({num:4})" },
        ]),
      ],
      { usedValues: () => [] },
    );

    expect(out.ok).toBe(true);
    expect(f.calls.typed).toHaveLength(3);
    expect(f.calls.typed[0]).toMatch(/^re: 859148 \(\d{4}\)$/);
    // A fresh draw per round, rather than one expansion reused
    expect(f.calls.typed[1]).toMatch(/^re: 859149 \(\d{4}\)$/);
  });

  it("leaves a placeholder nothing knows about as it stands", async () => {
    const f = fakePage();
    await run(f.page, [{ type: "web_input", selector: "#c", text: "hi {notAToken}" }]);

    expect(f.calls.typed[0]).toBe("hi {notAToken}");
  });
});

describe("web_hold", () => {
  it("keeps the button down for the time it was given, then lets go", async () => {
    const f = fakePage({}, { centres: { "#verify": { x: 100, y: 50 } } });
    const started = Date.now();
    const out = await run(f.page, [{ type: "web_hold", selector: "#verify", holdMs: 120 }]);

    expect(out.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    // Approached, pressed, held, released -- a click would have no gap in the middle
    expect(f.calls.pointer.map((p) => p.at)).toEqual(["move", "move", "down", "up"]);
    expect(f.calls.pointer[1]).toEqual({ at: "move", x: 100, y: 50 });
    expect(out.logs[0].outcome).toBe("held `#verify` down for 0.1s");
  });

  it("does not hold past the time the whole run has left", async () => {
    const f = fakePage();
    const started = Date.now();
    // Held for 5s on a run with a fraction of that left: it lets go and moves on, rather
    // than sitting on the button until the budget is gone
    const out = await runWebSteps(
      f.page,
      [{ type: "web_hold", selector: "#verify", holdMs: 5_000 }],
      Date.now() + 80,
      {},
    );

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.calls.pointer.at(-1)).toEqual({ at: "up" });
    expect(out.logs[0].outcome).toBe("held `#verify` down for 5.0s");
  });

  it("fails when there is nothing to hold", async () => {
    const f = fakePage({}, { noSuchElement: "#gone" });
    const out = await run(f.page, [{ type: "web_hold", selector: "#gone" }]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("nothing matching `#gone` is on the page");
    expect(f.calls.pointer).toEqual([]);
  });
});

describe("web_drag", () => {
  const trail = (f: ReturnType<typeof fakePage>) =>
    f.calls.pointer.filter((p) => p.at === "move");

  it("drags a slider handle the distance it was given, in moves rather than a jump", async () => {
    const f = fakePage({}, { centres: { ".slider-handle": { x: 40, y: 200 } } });
    const out = await run(f.page, [
      { type: "web_drag", selector: ".slider-handle", x: 260, y: 0, durationMs: 40 },
    ]);

    expect(out.ok).toBe(true);
    expect(f.calls.pointer.map((p) => p.at).filter((a) => a !== "move")).toEqual(["down", "up"]);
    // Many small moves, not two: a single jump is what a slider check is watching for
    expect(trail(f).length).toBeGreaterThan(8);
    expect(trail(f)[0]).toEqual({ at: "move", x: 40, y: 200 });
    expect(trail(f).at(-1)).toEqual({ at: "move", x: 300, y: 200 });
    // The path bows off the straight line on the way, and comes back to it at the end
    expect(trail(f).some((p) => p.y !== 200)).toBe(true);
    expect(out.logs[0].outcome).toBe("dragged `.slider-handle` by 260,0px");
  });

  it("drops onto another element when one is named", async () => {
    const f = fakePage(
      {},
      { centres: { "#piece": { x: 30, y: 30 }, "#slot": { x: 180, y: 90 } } },
    );
    const out = await run(f.page, [
      { type: "web_drag", selector: "#piece", toSelector: "#slot", durationMs: 20 },
    ]);

    expect(out.ok).toBe(true);
    expect(trail(f).at(-1)).toEqual({ at: "move", x: 180, y: 90 });
    expect(out.logs[0].outcome).toBe("dragged `#piece` onto `#slot`");
  });

  it("needs somewhere to drag to", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_drag", selector: "#piece" }]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("no drop target and no distance to drag were given");
    expect(f.calls.pointer).toEqual([]);
  });

  it("lets go of the button even when a move fails part way across", async () => {
    const f = fakePage({}, { centres: { "#piece": { x: 10, y: 10 } } });
    let moves = 0;
    const page = f.page as unknown as { mouse: { move: (x: number, y: number) => Promise<void> } };
    const realMove = page.mouse.move;
    page.mouse.move = async (x: number, y: number) => {
      if (++moves === 4) throw new Error("the pointer went out of the window");
      return realMove(x, y);
    };

    const out = await run(f.page, [
      { type: "web_drag", selector: "#piece", x: 200, y: 0, durationMs: 20 },
    ]);

    expect(out.ok).toBe(false);
    // A button left down would sit under every step after this one
    expect(f.calls.pointer.at(-1)).toEqual({ at: "up" });
  });

  it("fails before taking hold when the drop target is not there", async () => {
    const f = fakePage({}, { noSuchElement: "#slot" });
    const out = await run(f.page, [
      { type: "web_drag", selector: "#piece", toSelector: "#slot" },
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("nothing matching `#slot` is on the page");
    expect(f.calls.pointer).toEqual([]);
  });
});

