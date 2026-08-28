// Running a script on the page, the way the browser console runs one. What matters here is
// the wrapping: a console line is not a function body, so a one-line expression has to hand
// back what it evaluates to while a longer script keeps its own `return` -- and a script that
// returns nothing at all still has whatever it printed worth keeping.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 50 }),
      }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { runWebSteps, webEvalExpression } from "../jobs/cloudflare";
import type { WebStep } from "../types";

type ConsoleListener = (msg: { text: () => string }) => void;

/**
 * A page that really runs what it is handed. The expression is compiled against a stand-in
 * `document` and a `console` that feeds the listeners the step attaches, which is what the
 * console fallback is read from.
 */
function fakePage(doc: Record<string, unknown> = {}) {
  const listeners: ConsoleListener[] = [];
  const visited: string[] = [];
  const print = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    for (const fn of listeners) fn({ text: () => line });
  };

  const page = {
    title: async () => "",
    url: () => visited[visited.length - 1] ?? "https://example.test/",
    goto: async (url: string) => {
      visited.push(url);
    },
    screenshot: async () => {
      throw new Error("the stand-in page takes no screenshots");
    },
    on: (event: string, fn: ConsoleListener) => {
      if (event === "console") listeners.push(fn);
    },
    off: (event: string, fn: ConsoleListener) => {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      // The challenge check and the page-text reads pass a function, not a script
      if (typeof fn !== "string") {
        if (String(fn).includes("challenge-")) return false;
        return typeof arg === "string" ? false : "a page with words on it";
      }
      const compiled = new Function("document", "console", `return ${fn}`);
      return await compiled(doc, { log: print, error: print });
    },
  };

  return { page: page as unknown as Page, listeners, visited };
}

const run = (page: Page, steps: WebStep[], seed?: Record<string, string>) =>
  runWebSteps(page, steps, Date.now() + 30_000, {}, seed);

describe("webEvalExpression", () => {
  it("hands a lone expression back as itself", () => {
    expect(webEvalExpression("document.title")).toContain("(async () => (");
  });

  it("runs anything longer as a function body", () => {
    expect(webEvalExpression("const a = 1;\nreturn a")).toContain("(async () => {");
    expect(webEvalExpression("console.log('a'); console.log('b')")).toContain("(async () => {");
  });

  it("keeps a script that returns to a function body, expression or not", () => {
    // `return x` is not an expression, so compiling it as one would fail anyway -- this is
    // about a script whose whole point is the return, e.g. `return {a: 1}`
    expect(webEvalExpression("return { a: 1 }")).toContain("(async () => {");
  });
});

describe("web_eval", () => {
  it("holds what one expression comes to", async () => {
    const f = fakePage({ title: "Bemby" });
    const out = await run(f.page, [
      { type: "web_eval", script: "document.title", varName: "pageTitle" },
      { type: "web_goto", url: "https://example.test/{pageTitle}" },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe("ran the script into {pageTitle}: Bemby");
    // The name is there for the steps after it, which is the whole point of holding one
    expect(f.visited).toEqual(["https://example.test/Bemby"]);
  });

  it("holds what a longer script returns", async () => {
    const f = fakePage({ posts: 7 });
    const out = await run(f.page, [
      {
        type: "web_eval",
        script: "const n = document.posts;\nreturn n * 2;",
        varName: "count",
      },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe("ran the script into {count}: 14");
  });

  it("keeps an object as its JSON", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_eval", script: "return { a: 1, b: 'two' }", varName: "obj" },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe('ran the script into {obj}: {"a":1,"b":"two"}');
  });

  it("falls back to what the script printed", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_eval", script: 'console.log("this is a test")', varName: "printed" },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe(
      "ran the script into {printed} from the console: this is a test",
    );
  });

  it("stops listening to the console once the step is over", async () => {
    const f = fakePage();
    await run(f.page, [{ type: "web_eval", script: 'console.log("once")' }]);
    expect(f.listeners).toHaveLength(0);
  });

  it("runs for its effect alone when no name is given", async () => {
    const f = fakePage({ clicked: false });
    const out = await run(f.page, [
      { type: "web_eval", script: "document.clicked = true;" },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe("ran the script");
  });

  it("fills {name} in before the script runs", async () => {
    const f = fakePage();
    const out = await run(
      f.page,
      [{ type: "web_eval", script: "return '{postId}-ok'", varName: "tag" }],
      { postId: "42" },
    );

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe("ran the script into {tag}: 42-ok");
  });

  it("fails when a named step gets nothing back", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_eval", script: "const a = 1;\na + 1;", varName: "sum" },
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toContain("needs its own `return`");
  });

  it("reports what the page said when the script falls over", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_eval", script: "return nothingAtAll.here", varName: "x" },
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toContain("the script failed:");
  });

  it("gives up on a script that never finishes", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      {
        type: "web_eval",
        script: "await new Promise(() => {});\nreturn 1",
        varName: "never",
        waitMs: 150,
      },
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("the script did not finish within 150ms");
  });

  it("keeps a result marked secret out of the log", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_eval", script: "return 'sk-abcdef'", varName: "token", secret: true },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toBe(
      "ran the script into {token}: 9 character(s), kept out of the log",
    );
  });
});
