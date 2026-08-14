// Page steps that reach into the browser, driven against a real one.
//
// These cover a failure that no amount of unit testing catches: anything defined as a named
// function inside a `page.evaluate` body is rewritten by tsx (the dev server's loader) into
// a call to a `__name` helper that exists only on this side, so the body throws on its first
// line. Both callers below swallow that -- a scroll reports "nothing scrolls", a click asks
// the model to judge a screenshot with no grid on it -- which reads as a page that behaved
// oddly rather than as a broken step. Only running the real thing tells them apart.
// The settings row the stub hands back is the tuning one: the pauses a step leaves for a
// real page to settle are dead time against a local one, and they dominate the run.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({ value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0 }) }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { chromiumExecutable } from "../jobs/cfBrowser";
import { drawWebGrid, runWebSteps } from "../jobs/cloudflare";

// The keyed build quits without a licence seat, so these drive the unlicensed one
const exe = chromiumExecutable("free");

const page = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0">${html}</body>`)}`;

describe.skipIf(!exe)("page steps in a real browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (html: string, size = { width: 800, height: 600 }): Promise<Page> => {
    const p = await browser.newPage({ viewport: size });
    await p.goto(page(html), { waitUntil: "domcontentloaded" });
    return p;
  };

  it(
    "scrolls the page, rather than reporting that nothing scrolls",
    async () => {
      const p = await open(`<div style="height:3000px">tall</div>`);
      const run = await runWebSteps(p, [{ type: "web_scroll", y: 500 }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("500");
      expect(await p.evaluate(() => window.scrollY)).toBe(500);
      await p.close();
    },
    60_000,
  );

  it(
    "corrects the wide guess against the close-up, and clicks what it settled on",
    async () => {
      // A 22px box centred at 355,457 -- the size and place of a Turnstile checkbox
      const p = await open(
        `<input id="cb" type="checkbox" style="position:absolute;left:344px;top:446px;width:22px;height:22px;margin:0">` +
          `<span style="position:absolute;left:385px;top:450px">Verify you are human</span>`,
        { width: 945, height: 939 },
      );
      const truth = await p.evaluate(() => {
        const r = document.getElementById("cb")!.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });

      const shots: string[] = [];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the verify you are human checkbox" }],
        Date.now() + 30_000,
        {
          aiLocate: async (image, prompt) => {
            shots.push(image);
            pass++;
            // The wide pass answers off-target, the way the live model did; the close-up
            // is the one that has to be believed
            return pass === 1
              ? '{"x": 360, "y": 485}'
              : `{"x": ${truth.x}, "y": ${truth.y}}`;
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      expect(pass).toBe(2);
      // The close-up is a window on the page, so it must be the smaller picture of the two
      expect(shots[1].length).toBeLessThan(shots[0].length);
      expect(run.logs[0].outcome).toContain(`AI clicked ${truth.x},${truth.y}`);
      expect(run.logs[0].outcome).toContain("close-up moved it");
      expect(await p.evaluate(() => (document.getElementById("cb") as HTMLInputElement).checked))
        .toBe(true);
      // The ring drawn over the click is left for this step's screenshot and then taken off
      expect(run.logs[0].screenshot).toBeTruthy();
      expect(await p.evaluate(() => document.querySelectorAll(".__bemby_mark").length)).toBe(0);
      await p.close();
    },
    60_000,
  );

  it(
    "keeps the wide guess when the close-up cannot see the target, rather than reading null as 0,0",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const replies: string[] = ['{"x": 360, "y": 485}', '{"x": null, "y": null, "what": "not in view"}'];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the go button" }],
        Date.now() + 30_000,
        { aiLocate: async () => replies[pass++] },
      );
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("AI clicked 360,485");
      expect(run.logs[0].outcome).toContain("could not see it");
      await p.close();
    },
    60_000,
  );

  it(
    "does not tell the close-up what the wide pass answered, which is what made it echo",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const prompts: string[] = [];
      let pass = 0;
      await runWebSteps(p, [{ type: "ai_web_click_xy" }], Date.now() + 30_000, {
        aiLocate: async (_image, prompt) => {
          prompts.push(prompt);
          return pass++ === 0 ? '{"x": 360, "y": 485}' : '{"x": 312, "y": 210}';
        },
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain("360");
      expect(prompts[1]).not.toContain("485");
      await p.close();
    },
    60_000,
  );

  it(
    "clicks every position the AI listed, in order, with one look at the page",
    async () => {
      const boxes = [
        { id: "a", left: 100, top: 100 },
        { id: "b", left: 300, top: 100 },
        { id: "c", left: 500, top: 100 },
      ];
      const p = await open(
        boxes
          .map(
            (b) =>
              `<input id="${b.id}" type="checkbox" style="position:absolute;left:${b.left}px;` +
              `top:${b.top}px;width:22px;height:22px;margin:0">`,
          )
          .join(""),
      );
      const at = (id: string) =>
        p.evaluate((el: string) => {
          const r = document.getElementById(el)!.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }, id);
      const want = [await at("a"), await at("b"), await at("c")];

      let calls = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "every checkbox", gapMs: 0, refine: false }],
        Date.now() + 30_000,
        {
          aiLocate: async () => {
            calls++;
            return JSON.stringify({ points: want });
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      // One screenshot for the lot: a shot per target would show a page the earlier clicks
      // had already changed, and with the close-up off there is nothing else to ask
      expect(calls).toBe(1);
      expect(run.logs[0].outcome).toContain("AI clicked 3 position(s)");
      for (const [i, point] of want.entries())
        expect(run.logs[0].outcome).toContain(`${i + 1}) ${point.x},${point.y}`);
      expect(
        await p.evaluate(() =>
          ["a", "b", "c"].map((id) => (document.getElementById(id) as HTMLInputElement).checked),
        ),
      ).toEqual([true, true, true]);
      expect(await p.evaluate(() => document.querySelectorAll(".__bemby_mark").length)).toBe(0);
      await p.close();
    },
    60_000,
  );

  it(
    "takes a close-up of each position when asked, and clicks what it corrected to",
    async () => {
      const p = await open(
        `<input id="a" type="checkbox" style="position:absolute;left:100px;top:100px;width:22px;height:22px;margin:0">` +
          `<input id="b" type="checkbox" style="position:absolute;left:400px;top:300px;width:22px;height:22px;margin:0">`,
      );
      const truth = await p.evaluate(() =>
        ["a", "b"].map((id) => {
          const r = document.getElementById(id)!.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }),
      );

      // The wide pass is 20px out on both, the way the live model is on a small target
      const prompts: string[] = [];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "both checkboxes", gapMs: 0 }],
        Date.now() + 30_000,
        {
          aiLocate: async (_image, prompt) => {
            prompts.push(prompt);
            if (pass++ === 0)
              return JSON.stringify({
                points: truth.map((t, i) => ({ x: t.x + 20, y: t.y + 20, what: `checkbox ${i}` })),
              });
            return JSON.stringify(truth[pass - 2]);
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      // One wide look, then one close-up per position
      expect(prompts).toHaveLength(3);
      // One kept picture per pass, in the order the prompt lists them, and every pass headed
      // so the log reader can split them apart and debug one on its own
      expect(run.logs[0].aiImages).toHaveLength(3);
      expect(run.logs[0].aiPrompt).toMatch(/^--- whole-page pass ---/);
      expect(run.logs[0].aiPrompt).toContain("\n\n--- close-up pass 1 ---\n\n");
      expect(run.logs[0].aiPrompt).toContain("\n\n--- close-up pass 2 ---\n\n");
      expect(run.logs[0].aiResponse).toMatch(/^--- whole-page pass ---/);
      expect(run.logs[0].outcome).toContain("moved from");
      expect(
        await p.evaluate(() =>
          ["a", "b"].map((id) => (document.getElementById(id) as HTMLInputElement).checked),
        ),
      ).toEqual([true, true]);
      await p.close();
    },
    60_000,
  );

  // A challenge frame the size hCaptcha draws one, with a checkbox inside the page behind it
  // standing in for a tile: the frame is only there to be found and measured.
  const panelPage = () =>
    open(
      `<iframe title="hCaptcha challenge" style="position:absolute;left:125px;top:265px;` +
        `width:320px;height:460px;border:0"></iframe>` +
        `<input id="a" type="checkbox" style="position:absolute;left:600px;top:100px;` +
        `width:22px;height:22px;margin:0">`,
      { width: 945, height: 939 },
    );

  it(
    "rules at the top of the z order, and names only the lines a figure fits beside",
    async () => {
      // A panel at the maximum z-index, which is where a captcha container sits. A ruler one
      // below that is painted under the challenge: figures in the margins, nothing on the
      // tiles that needed measuring, which is a ruled picture that measures nothing.
      const p = await open(
        `<div style="position:fixed;left:100px;top:100px;width:200px;height:200px;` +
          `background:#123;z-index:2147483647"></div>`,
        { width: 400, height: 400 },
      );
      await drawWebGrid(p, 20, { x: 100, y: 100, width: 200, height: 200 });
      const ruler = await p.evaluate(() =>
        Array.from(document.querySelectorAll(".__bemby_mark > div")).map((d) => ({
          z: getComputedStyle(d).zIndex,
          text: d.textContent ?? "",
        })),
      );

      expect(ruler.length).toBeGreaterThan(0);
      expect(ruler.every((d) => d.z === "2147483647")).toBe(true);
      // Three digits per 20px line is an unreadable run of figures, so only every third line
      // is named, and each named line carries its figure at both edges of the shot
      const figures = ruler.filter((d) => d.text).map((d) => Number(d.text));
      expect(figures.length).toBeGreaterThan(0);
      expect(figures.every((n) => n % 60 === 0)).toBe(true);
      // 180 is a named line on both axes, and each carries its figure at both edges
      expect(figures.filter((n) => n === 180)).toHaveLength(4);
      // And a coarse ruler still names every line, three digits fitting easily in 100px
      await drawWebGrid(p, 100);
      const coarse = await p.evaluate(() =>
        Array.from(document.querySelectorAll(".__bemby_mark > div"))
          .map((d) => d.textContent ?? "")
          .filter(Boolean),
      );
      expect(coarse).toContain("100");
      expect(coarse).toContain("200");
      await p.close();
    },
    60_000,
  );

  it(
    "takes the wide look at the captcha panel alone, ruled finely",
    async () => {
      const p = await panelPage();
      const prompts: string[] = [];
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "each tile", gapMs: 0, refine: false }],
        Date.now() + 30_000,
        {
          aiLocate: async (_image, prompt) => {
            prompts.push(prompt);
            return JSON.stringify({ points: [{ x: 200, y: 400, what: "a watering can" }] });
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      // One look, at the panel: its own region, and the fine ruler rather than the 100px one
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("the panel");
      expect(prompts[0]).toContain("x=113");
      expect(prompts[0]).toContain("A red grid every 20 pixels");
      expect(run.logs[0].outcome).toContain("found in the captcha panel");
      // The ruled shot is kept as it was sent: a prompt cannot be debugged without it
      expect(run.logs[0].aiImages).toHaveLength(1);
      expect(run.logs[0].aiImages?.[0]).toMatch(/^data:image\/jpeg;base64,/);
      expect(run.logs[0].aiImages?.[0]).not.toBe(run.logs[0].screenshot);
      await p.close();
    },
    60_000,
  );

  it(
    "falls back to the whole page when the panel look answers off the panel",
    async () => {
      const p = await panelPage();
      const prompts: string[] = [];
      const at = await p.evaluate(() => {
        const r = document.getElementById("a")!.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "the checkbox", gapMs: 0, refine: false }],
        Date.now() + 30_000,
        {
          aiLocate: async (_image, prompt) => {
            prompts.push(prompt);
            return JSON.stringify({ points: [at] });
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      // The panel look answered outside the panel, so the page got its own look
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("The screenshot is a web page, 945 by 939.");
      expect(run.logs[0].outcome).toContain("the captcha panel look having found nothing");
      expect(
        await p.evaluate(() => (document.getElementById("a") as HTMLInputElement).checked),
      ).toBe(true);
      await p.close();
    },
    60_000,
  );

  it(
    "keeps the prompt and the picture on a step that failed, which is when they are wanted",
    async () => {
      const p = await panelPage();
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "each tile", gapMs: 0 }],
        Date.now() + 30_000,
        { aiLocate: async () => "I cannot see any of them" },
      );

      expect(run.logs[0].error).toContain("no usable position");
      // Both looks are on the log, each with the picture it was shown, so the failure can be
      // debugged rather than only reported
      expect(run.logs[0].aiPrompt).toContain("--- captcha panel pass ---");
      expect(run.logs[0].aiPrompt).toContain("--- whole-page pass ---");
      expect(run.logs[0].aiResponse).toContain("I cannot see any of them");
      expect(run.logs[0].aiImages).toHaveLength(2);
      await p.close();
    },
    60_000,
  );

  it(
    "ignores a close-up that jumps further than the wide grid could have been misread by",
    async () => {
      const p = await open(
        `<input id="a" type="checkbox" style="position:absolute;left:389px;top:289px;` +
          `width:22px;height:22px;margin:0">`,
        { width: 945, height: 939 },
      );
      const at = await p.evaluate(() => {
        const r = document.getElementById("a")!.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });

      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy_multi", hint: "the checkbox", gapMs: 0, zoom: false }],
        Date.now() + 30_000,
        {
          aiLocate: async () =>
            pass++ === 0
              ? JSON.stringify({ points: [{ ...at, what: "a checkbox" }] })
              : // Inside the 320px close-up window, but 120px along it: the neighbour, not
                // a better reading of the same target
                JSON.stringify({ x: at.x + 120, y: at.y, what: "a checkbox" }),
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("close-up jump of 120px ignored");
      expect(
        await p.evaluate(() => (document.getElementById("a") as HTMLInputElement).checked),
      ).toBe(true);
      await p.close();
    },
    60_000,
  );

  it(
    "passes the Turnstile step on a page that shows no checkbox",
    async () => {
      // Turnstile clears itself for an address it likes, often without drawing a checkbox,
      // so nothing to tick is nothing to do -- not a failed step.
      const p = await open(`<div>no widget here</div>`);
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("no Turnstile widget");
      await p.close();
    },
    60_000,
  );

  it(
    "ticks the checkbox where the widget sits, and waits for its token",
    async () => {
      // A widget rendered into the site's own element: a sized wrapper holding nothing but
      // the hidden response field, which is the shape the CDP lookup cannot help with and
      // the ancestor fallback has to handle.
      const p = await open(
        `<div id="w" style="width:300px;height:65px;background:#eee"` +
          ` onclick="document.getElementsByName('cf-turnstile-response')[0].value='tok-1'">` +
          `<input type="hidden" name="cf-turnstile-response"></div>`,
      );
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("token issued");
      await p.close();
    },
    60_000,
  );

  it(
    "leaves a widget that has already solved itself alone",
    async () => {
      const p = await open(
        `<div style="width:300px;height:65px"` +
          ` onclick="window.__pressed = true">` +
          `<input type="hidden" name="cf-turnstile-response" value="tok-already"></div>`,
      );
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].outcome).toContain("already solved");
      expect(await p.evaluate(() => (window as any).__pressed)).toBeUndefined();
      await p.close();
    },
    60_000,
  );

  // A forum index, cut down to the shape that matters: post links to read ids off, one link
  // that is not a post, a control per post standing in for its reply form, and the body of
  // the post a round would be replying to.
  const LIST = `
    <ul>
      <li class="post-list-item"><div class="post-title"><a href="/post-859148-1">one</a></div></li>
      <li class="post-list-item"><div class="post-title"><a href="/post-859149-1">two</a></div></li>
      <li class="post-list-item"><div class="post-title"><a href="/user/1234">a profile</a></div></li>
    </ul>
    <div class="post-content">Has anyone tried this on a small VPS?</div>
    <button id="reply-859148" onclick="window.__hits=(window.__hits||[]).concat('859148')">r1</button>
    <button id="reply-859149" onclick="window.__hits=(window.__hits||[]).concat('859149')">r2</button>`;

  const PICK_POST = {
    type: "web_pick" as const,
    selector: ".post-list-item a",
    varName: "postId",
    attribute: "href",
    pattern: "/post-(\\d+)",
    skipUsed: true,
  };

  it(
    "picks a post per round and fills {postId} into the steps that follow",
    async () => {
      const p = await open(LIST);
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
      );

      expect(run.ok).toBe(true);
      // The profile link matched the selector but not the pattern, so it is not an id
      const picks = run.logs.filter((l) => l.type === "web_pick");
      expect(picks[0].outcome).toContain("picked 859148 for {postId}, out of 2 to choose from");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859148", "859149"]);
      // A round's steps log under it, labelled with the round and the post it settled on
      const presses = run.logs.filter((l) => l.type === "web_button");
      expect(presses.map((l) => l.iteration)).toEqual(["1/2 859148", "2/2 859149"]);
      expect(presses[0].label).toBe("Press `#reply-859148`");
      expect(used).toEqual(["859148", "859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "leaves out an id the job has already been through",
    async () => {
      const p = await open(LIST);
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 1,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => ["859148"], markUsed: (_name, value) => used.push(value) },
      );

      expect(run.ok).toBe(true);
      expect(run.logs[1].outcome).toContain("1 of 2 already used");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859149"]);
      expect(used).toEqual(["859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "carries on after a round that fails, and does not remember that post as used",
    async () => {
      // The first post picked has nothing to press, so that round cannot finish
      const p = await open(LIST.replace(`<button id="reply-859148"`, `<button id="gone-859148"`));
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
      );

      // One round short is not the action failing: the other post still got its reply
      expect(run.ok).toBe(true);
      const loop = run.logs.find((l) => l.type === "web_repeat")!;
      expect(loop.error).toBeUndefined();
      expect(loop.outcome).toContain("1 of 2");
      expect(loop.outcome).toContain("1 failed");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859149"]);
      expect(used).toEqual(["859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "scrolls to an element rather than a distance, and reports where it landed",
    async () => {
      // The case pixels cannot serve: the target sits below content of unknown length
      const p = await open(
        `<div style="height:3000px">filler</div>` +
          `<button id="reply" style="height:40px">reply</button>` +
          `<div style="height:2000px">more</div>`,
      );
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#reply" }],
        Date.now() + 30_000,
        {},
      );

      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("scrolled to `#reply`");
      // In view, and near the middle rather than just barely on screen
      const box = await p.evaluate(() => {
        const r = document.getElementById("reply")!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: innerHeight };
      });
      expect(box.top).toBeGreaterThan(0);
      expect(box.bottom).toBeLessThan(box.height);
      await p.close();
    },
    60_000,
  );

  it(
    "reaches a target inside a scrollable panel, not just the page",
    async () => {
      // A distance scrolls the page; the element here moves only if its own panel does
      const p = await open(
        `<div id="panel" style="height:200px;overflow:auto">` +
          `<div style="height:1500px">filler</div>` +
          `<button id="deep">deep</button></div>`,
      );
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#deep" }],
        Date.now() + 30_000,
        {},
      );

      expect(run.ok).toBe(true);
      expect(await p.evaluate(() => document.getElementById("panel")!.scrollTop)).toBeGreaterThan(0);
      await p.close();
    },
    60_000,
  );

  it(
    "waits for a target the page has yet to draw",
    async () => {
      const p = await open(`<div style="height:2000px">filler</div>`);
      await p.evaluate(() => {
        setTimeout(() => {
          const b = document.createElement("button");
          b.id = "late";
          document.body.appendChild(b);
        }, 400);
      });
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#late", waitMs: 5000 }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(true);
      await p.close();
    },
    60_000,
  );

  it(
    "fails when the target never appears, rather than scrolling somewhere arbitrary",
    async () => {
      const p = await open(`<div style="height:2000px">filler</div>`);
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#nope", waitMs: 300 }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/appeared to scroll to/);
      await p.close();
    },
    60_000,
  );

  it(
    "reads the post body off the page for a later step to quote",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [{ type: "web_read", selector: ".post-content", varName: "postText" }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("Has anyone tried this on a small VPS?");
      await p.close();
    },
    60_000,
  );

  it(
    "refuses a loop inside a loop rather than recursing",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [{ type: "web_repeat", times: 2, steps: [{ type: "web_back" }] }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => [] },
      );

      expect(run.ok).toBe(false);
      expect(run.failure).toMatch(/cannot be put inside another loop/);
      await p.close();
    },
    60_000,
  );

  it(
    "fails a pick whose pattern matches none of the elements it found",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [{ ...PICK_POST, pattern: "/thread-(\\d+)" }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toContain("none of them matched");
      await p.close();
    },
    60_000,
  );

  // The my.telegram.org chain: the account's own number goes in the form, Telegram's login
  // code goes in the next field, and the pair the site shows lands on the account.
  const LOGIN_FORM = `
    <form>
      <input id="my_login_phone">
      <input id="my_password">
    </form>
    <span id="app_id">2040</span>
    <span id="app_hash">0123456789abcdef0123456789abcdef</span>
  `;

  it(
    "fills a form in with the account the run belongs to",
    async () => {
      const p = await open(LOGIN_FORM);
      const run = await runWebSteps(
        p,
        [{ type: "web_input", selector: "#my_login_phone", text: "{accountPhone}" }],
        Date.now() + 30_000,
        {},
        { accountPhone: "+61412345678" },
      );
      expect(run.ok).toBe(true);
      expect(
        await p.evaluate(
          () => (document.querySelector("#my_login_phone") as HTMLInputElement).value,
        ),
      ).toBe("+61412345678");
      await p.close();
    },
    60_000,
  );

  it(
    "types the login code Telegram delivered into the confirmation field",
    async () => {
      const p = await open(LOGIN_FORM);
      const run = await runWebSteps(
        p,
        [
          { type: "web_tg_code", varName: "tgCode" },
          { type: "web_input", selector: "#my_password", text: "{tgCode}" },
        ],
        Date.now() + 30_000,
        { tgCode: async () => ({ code: "47281", text: "Web login code: 47281" }) },
      );
      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("47281");
      expect(
        await p.evaluate(() => (document.querySelector("#my_password") as HTMLInputElement).value),
      ).toBe("47281");
      await p.close();
    },
    60_000,
  );

  it(
    "says the code never arrived rather than carrying on with an empty field",
    async () => {
      const p = await open(LOGIN_FORM);
      const run = await runWebSteps(
        p,
        [
          { type: "web_tg_code", varName: "tgCode", waitMs: 1000 },
          { type: "web_input", selector: "#my_password", text: "{tgCode}" },
        ],
        Date.now() + 30_000,
        { tgCode: async () => null },
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/no login code/);
      // The step after it never ran, so nothing was submitted half-filled
      expect(run.logs).toHaveLength(1);
      await p.close();
    },
    60_000,
  );

  it(
    "sends the command the page showed as the account, and keeps the reply",
    async () => {
      const p = await open(LOGIN_FORM);
      const sent: unknown[] = [];
      const run = await runWebSteps(
        p,
        [
          { type: "web_set", vars: [{ name: "joinCode", value: "abc123" }] },
          {
            type: "web_tg_send",
            contact: "@some_bot",
            text: "/start join_{joinCode}",
            replyContains: "linked",
            varName: "botReply",
          },
          { type: "web_input", selector: "#my_password", text: "{botReply}" },
        ],
        Date.now() + 30_000,
        {
          tgSend: async (q) => {
            sent.push(q);
            return { reply: "Account linked" };
          },
        },
      );
      expect(run.ok).toBe(true);
      expect(sent).toEqual([
        {
          contact: "@some_bot",
          text: "/start join_abc123",
          replyContains: "linked",
          waitMs: expect.any(Number),
        },
      ]);
      expect(
        await p.evaluate(() => (document.querySelector("#my_password") as HTMLInputElement).value),
      ).toBe("Account linked");
      await p.close();
    },
    60_000,
  );

  it(
    "sends without waiting when no reply was asked for, and stops when the send fails",
    async () => {
      const p = await open(LOGIN_FORM);
      const waits: number[] = [];
      const run = await runWebSteps(
        p,
        [{ type: "web_tg_send", contact: "@some_bot", text: "/start" }],
        Date.now() + 30_000,
        {
          tgSend: async (q) => {
            waits.push(q.waitMs);
            return {};
          },
        },
      );
      expect(run.ok).toBe(true);
      expect(waits).toEqual([0]);

      const failed = await runWebSteps(
        p,
        [
          { type: "web_tg_send", contact: "@some_bot", text: "/start", replyContains: "linked" },
          { type: "web_input", selector: "#my_password", text: "never" },
        ],
        Date.now() + 30_000,
        {
          tgSend: async () => {
            throw new Error("Expected reply not received within 1000ms");
          },
        },
      );
      expect(failed.ok).toBe(false);
      expect(failed.logs).toHaveLength(1);
      await p.close();
    },
    60_000,
  );

  it(
    "hands the pair read off the page to the account, keeping the hash out of the log",
    async () => {
      const p = await open(LOGIN_FORM);
      const saved: unknown[] = [];
      const run = await runWebSteps(
        p,
        [
          { type: "web_read", selector: "#app_id", varName: "apiId" },
          { type: "web_read", selector: "#app_hash", varName: "apiHash", secret: true },
          { type: "web_tg_api_save", apiId: "{apiId}", apiHash: "{apiHash}", folder: "tgApi" },
        ],
        Date.now() + 30_000,
        {
          saveTgApi: async (creds) => {
            saved.push(creds);
            return { summary: "saved api_id 2040 to acc" };
          },
        },
      );

      expect(run.ok).toBe(true);
      expect(saved).toEqual([
        {
          apiId: "2040",
          apiHash: "0123456789abcdef0123456789abcdef",
          folder: "tgApi",
          key: undefined,
        },
      ]);
      // The hash reached the hook but not the log, which travels with the run
      expect(run.logs[1].outcome).not.toContain("0123456789abcdef");
      expect(run.logs[2].outcome).toBe("saved api_id 2040 to acc");
      await p.close();
    },
    60_000,
  );

  it(
    "fails a save whose values never got read, rather than saving blanks",
    async () => {
      const p = await open(LOGIN_FORM);
      const run = await runWebSteps(
        p,
        [{ type: "web_tg_api_save", apiId: "", apiHash: "{apiHash}" }],
        Date.now() + 30_000,
        { saveTgApi: async () => ({ summary: "saved" }) },
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/no api_id/);
      await p.close();
    },
    60_000,
  );

  it(
    "fails the step when the ruler cannot be drawn, instead of asking for a blind guess",
    async () => {
      const p = await open(`<div>plain</div>`);
      // A page with no body is the one case that leaves nothing to draw the grid into
      await p.evaluate(() => document.body.remove());
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "anything" }],
        Date.now() + 30_000,
        { aiLocate: async () => '{"x": 10, "y": 10}' },
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/grid/i);
      await p.close();
    },
    60_000,
  );
});
