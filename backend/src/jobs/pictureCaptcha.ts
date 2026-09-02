import type { Frame, Page } from "playwright-core";

/**
 * Solving a picture captcha -- the "click every tile that shows a bus" kind -- with a vision
 * model, for the `ai_web_captcha` step.
 *
 * The whole approach rests on one thing: the challenge is an iframe whose DOM can be read
 * from the outside. That gives the question in words, the tiles' boxes, the example picture
 * and the Verify button, so the model is never asked where anything is -- only *which*
 * pictures answer the question. It replies with tile numbers, drawn on the tiles themselves
 * before the shot is taken, and each number maps back to an exact click point.
 *
 * Asking for coordinates instead is what the earlier attempts did, and it does not work at
 * this size: a mid-weight model reading a 120px tile off a ruled page names a point in the
 * gap between tiles or in the instruction bar above them, and a captcha does not forgive
 * either. What a model of that weight *can* do is say what a picture shows.
 */

/** Frames hCaptcha draws its two halves in. */
const HCAPTCHA_CHECKBOX = /hcaptcha\.com.*frame=checkbox/i;
const HCAPTCHA_CHALLENGE = /hcaptcha\.com.*frame=challenge/i;

/** How long to wait for the tile pictures to arrive before asking about them. */
const TILE_LOAD_MS = 12_000;

/** How long the frame's own click may spend waiting for the thing to hold still. */
const FRAME_CLICK_MS = 8_000;

/** Times the challenge is read before it is called unreadable. */
const READ_TRIES = 4;

/** The badge drawn on each tile, and the class it goes on so it can all be taken off again. */
const BADGE_CLASS = "__bemby_tile_badge";

export type CaptchaTile = {
  n: number;
  /** Page coordinates, so a click needs no arithmetic. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CaptchaChallenge = {
  /** The question as the widget words it, e.g. "Select all bicycles". */
  question: string;
  tiles: CaptchaTile[];
  /** The reference picture some questions refer to ("more expensive than shown"). */
  example?: { x: number; y: number; width: number; height: number };
  /** The Verify/Next button, in page coordinates. */
  submit?: { x: number; y: number };
  /** Whatever the panel says besides the question -- "Please try again", most usefully. */
  note: string;
};

/**
 * Brings a frame into view before anything is measured off it.
 *
 * A press goes to page coordinates, and a widget sitting below the fold has none worth
 * pressing: the earlier attempt at this clicked where the checkbox would have been if the
 * page had been scrolled, which is nowhere. `instant` because the figures are read straight
 * after -- a smooth scroll is still moving when they are.
 */
async function scrollFrameIntoView(frame: Frame): Promise<void> {
  const holder = await frame.frameElement().catch(() => null);
  if (!holder) return;
  // Every evaluate here is written as source rather than a function on purpose: tsx wraps
  // compiled functions in its own `__name` helper, which does not exist inside a page or a
  // frame, and the call fails with `__name is not defined` -- silently, if the caller is
  // catching. The rest of the browser side is written the same way for the same reason.
  await holder
    .evaluate(`(function (el) {
       el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
     })`)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 350));
}

/** Where an element inside a frame sits on the page. */
async function frameElementBox(
  frame: Frame,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  const inner = (await frame
    .evaluate(`(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       var r = el.getBoundingClientRect();
       if (r.width < 1 || r.height < 1) return null;
       return { x: r.x, y: r.y, width: r.width, height: r.height };
     })()`)
    .catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
  if (!inner) return undefined;
  const holder = await frame.frameElement().catch(() => null);
  const outer = holder ? await holder.boundingBox().catch(() => null) : null;
  if (!outer) return undefined;
  return { ...inner, x: inner.x + outer.x, y: inner.y + outer.y };
}

export function checkboxFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => HCAPTCHA_CHECKBOX.test(f.url()));
}

export function challengeFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => HCAPTCHA_CHALLENGE.test(f.url()));
}

/** Whether a picture captcha is on the page at all, solved or not. */
export function hasPictureCaptcha(page: Page): boolean {
  return !!checkboxFrame(page) || !!challengeFrame(page);
}

/**
 * The token the widget writes back when it is satisfied, which is the only proof worth
 * having: the panel closing means nothing on its own, and the checkbox goes green a moment
 * before the field is filled.
 *
 * Read wherever it landed -- the host page names the field, and the name differs between the
 * classic embed and the React one.
 */
export async function captchaToken(page: Page): Promise<string> {
  return page
    .evaluate(`(function () {
       var fields = Array.prototype.slice.call(document.querySelectorAll(
         'textarea[name*="captcha-response"], input[name*="captcha-response"],' +
         'textarea[name*="captchaResponse"], input[name*="captchaResponse"]'
       ));
       for (var i = 0; i < fields.length; i++) if (fields[i].value) return fields[i].value;
       return '';
     })()`)
    .then((value) => (typeof value === "string" ? value : ""))
    .catch(() => "");
}

/**
 * Presses something inside a challenge frame.
 *
 * The frame's own click is tried first, and it is the one that works: it re-measures at the
 * moment of pressing, so a widget the host page has just nudged is still hit -- a press aimed
 * at figures read a second earlier lands beside it and the panel never opens, which is what
 * the first version of this did.
 *
 * It is not trusted alone, though. That click waits for the element to be still, and under
 * Xvfb a window Chromium believes is occluded has the frame callbacks it waits on throttled,
 * so the wait can outlast anything useful. Hence the short timeout and the pointer press at
 * measured coordinates behind it.
 */
async function pressInFrame(page: Page, frame: Frame, selector: string): Promise<boolean> {
  const pressed = await frame
    .click(selector, { timeout: FRAME_CLICK_MS })
    .then(() => true)
    .catch(() => false);
  if (pressed) return true;

  const box = await frameElementBox(frame, selector);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2 - 6, box.y + box.height / 2 + 5).catch(() => {});
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
  return true;
}

/** Presses the "I am human" box, so the challenge opens. */
export async function pressCaptchaCheckbox(page: Page): Promise<boolean> {
  const frame = checkboxFrame(page);
  if (!frame) return false;
  await scrollFrameIntoView(frame);
  return pressInFrame(page, frame, "#checkbox");
}

/**
 * Waits until every tile has a picture in it.
 *
 * hCaptcha fills the grid a moment after the panel opens, spinners first. A shot taken over
 * those asks the model about nine loading icons, and it correctly answers that none of them
 * match -- which reads exactly like a model that cannot do the task.
 */
async function waitForTilePictures(frame: Frame, until: number): Promise<boolean> {
  for (;;) {
    const ready = await frame
      .evaluate(`(function () {
         var images = Array.prototype.slice.call(document.querySelectorAll('.task .image'));
         if (!images.length) return false;
         for (var i = 0; i < images.length; i++) {
           var url = getComputedStyle(images[i]).backgroundImage || '';
           if (!/url\(["']?https/.test(url)) return false;
         }
         return true;
       })()`)
      .then((value) => value === true)
      .catch(() => false);
    if (ready) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Whether the challenge panel is actually up, with tiles in it.
 *
 * Not the same question as whether the frame is there, which is what the first version of
 * this asked and got wrong: hCaptcha builds both of its frames when the widget loads and
 * leaves the challenge one hidden and empty until the box is pressed. Read as "a challenge is
 * open", that meant the box never got pressed and the step worked nothing.
 */
export async function challengePanelOpen(page: Page): Promise<boolean> {
  const frame = challengeFrame(page);
  if (!frame) return false;
  const holder = await frame.frameElement().catch(() => null);
  const box = holder ? await holder.boundingBox().catch(() => null) : null;
  if (!box || box.width < 100 || box.height < 100) return false;
  return frame
    .evaluate(`document.querySelectorAll('.task').length > 0`)
    .then((open) => open === true)
    .catch(() => false);
}

/**
 * Waits for the panel to open after the box is pressed.
 *
 * It is not instant and it is not certain: hCaptcha lets an address it likes through with no
 * challenge at all, in which case the token turns up instead and there is nothing to solve.
 */
export async function waitForChallenge(page: Page, until: number): Promise<boolean> {
  for (;;) {
    if (await challengePanelOpen(page)) return true;
    if (await captchaToken(page)) return false;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Everything about the challenge as it stands, in page coordinates.
 *
 * Tried a few times over, and the frame looked up afresh each time. hCaptcha replaces the
 * challenge document as the panel opens and between rounds, which leaves any frame held
 * across an await pointing at a context that has gone -- every read against it throws, and
 * the panel sitting open on screen makes that look like a panel that cannot be read at all.
 */
export async function readChallenge(
  page: Page,
  waitForPictures = true,
): Promise<CaptchaChallenge | undefined> {
  for (let attempt = 1; attempt <= READ_TRIES; attempt++) {
    const one = await readChallengeOnce(page, waitForPictures);
    if (one) return one;
    if (attempt < READ_TRIES) await new Promise((r) => setTimeout(r, 700));
  }
  return undefined;
}

/** Tries to see all of it once. */
async function readChallengeOnce(
  page: Page,
  waitForPictures: boolean,
): Promise<CaptchaChallenge | undefined> {
  const frame = challengeFrame(page);
  if (!frame) return undefined;
  // The panel opens over the form, and where the form was near the bottom of the page it
  // opens partly off it: the tiles have to be on screen to be shot and to be clicked
  await scrollFrameIntoView(frame);
  if (waitForPictures) await waitForTilePictures(frame, Date.now() + TILE_LOAD_MS);

  const holder = await frame.frameElement().catch(() => null);
  const outer = holder ? await holder.boundingBox().catch(() => null) : null;
  if (!outer) {
    console.log("[captcha] the challenge frame has no box on the page yet");
    return undefined;
  }

  const read = (await frame
    .evaluate(`(function () {
       function rect(el) {
         var r = el.getBoundingClientRect();
         return { x: r.x, y: r.y, width: r.width, height: r.height };
       }
       var question = document.querySelector('.prompt-text, #prompt-question');
       var tasks = Array.prototype.slice.call(document.querySelectorAll('.task'));
       var tiles = tasks.map(function (el, i) {
         var box = rect(el);
         return { n: i + 1, x: box.x, y: box.y, width: box.width, height: box.height };
       });
       var example = document.querySelector('.challenge-example .image-wrapper, .challenge-example');
       var submit = document.querySelector('.button-submit, .button-v2');
       return {
         question: question ? (question.textContent || '').trim() : '',
         note: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 200),
         tiles: tiles,
         example: example ? rect(example) : null,
         submit: submit ? rect(submit) : null,
       };
     })()`)
    .catch((err: any) => {
      console.log(`[captcha] the challenge frame could not be read: ${err?.message ?? err}`);
      return null;
    })) as {
    question: string;
    note: string;
    tiles: CaptchaTile[];
    example: { x: number; y: number; width: number; height: number } | null;
    submit: { x: number; y: number; width: number; height: number } | null;
  } | null;
  if (!read) return undefined;
  if (!read.tiles.length) {
    console.log(`[captcha] no tiles in the panel yet (it says: ${read.note.slice(0, 80)})`);
    return undefined;
  }

  const shift = <T extends { x: number; y: number }>(box: T): T => ({
    ...box,
    x: box.x + outer.x,
    y: box.y + outer.y,
  });

  return {
    question: read.question,
    note: read.note,
    tiles: read.tiles.map(shift),
    example: read.example ? shift(read.example) : undefined,
    submit: read.submit
      ? {
          x: read.submit.x + outer.x + read.submit.width / 2,
          y: read.submit.y + outer.y + read.submit.height / 2,
        }
      : undefined,
  };
}

/**
 * Numbers the tiles for the model, in the host page rather than inside the widget.
 *
 * Drawn outside the challenge's own document on purpose: hCaptcha watches its DOM, and a
 * solver that edits it is a solver the next version notices. From the screenshot's point of
 * view it makes no difference -- the badge sits over the tile either way.
 */
export async function drawTileBadges(page: Page, tiles: CaptchaTile[]): Promise<void> {
  await page
    .evaluate(`(function () {
       var tiles = ${JSON.stringify(tiles)};
       var cls = ${JSON.stringify(BADGE_CLASS)};
       Array.prototype.slice.call(document.querySelectorAll('.' + cls)).forEach(function (old) {
         old.remove();
       });
       tiles.forEach(function (tile) {
         var badge = document.createElement('div');
         badge.className = cls;
         badge.textContent = String(tile.n);
         badge.style.cssText =
           'position:fixed;z-index:2147483647;left:' + tile.x + 'px;top:' + tile.y + 'px;' +
           'width:22px;height:22px;line-height:22px;text-align:center;' +
           'font:bold 15px monospace;color:#fff;background:rgba(210,0,0,.92);' +
           'border-radius:4px;pointer-events:none;';
         document.body.appendChild(badge);
       });
     })()`)
    .catch(() => {});
}

export async function clearTileBadges(page: Page): Promise<void> {
  await page
    .evaluate(`(function () {
       Array.prototype.slice.call(
         document.querySelectorAll('.' + ${JSON.stringify(BADGE_CLASS)})
       ).forEach(function (old) { old.remove(); });
     })()`)
    .catch(() => {});
}

/** The box around the whole grid, with a little air, for the shot the model is shown. */
export function tileGridBox(tiles: CaptchaTile[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const pad = 4;
  const left = Math.min(...tiles.map((t) => t.x));
  const top = Math.min(...tiles.map((t) => t.y));
  const right = Math.max(...tiles.map((t) => t.x + t.width));
  const bottom = Math.max(...tiles.map((t) => t.y + t.height));
  return {
    x: Math.max(0, Math.round(left - pad)),
    y: Math.max(0, Math.round(top - pad)),
    width: Math.round(right - left + pad * 2),
    height: Math.round(bottom - top + pad * 2),
  };
}

/**
 * What to ask about the grid.
 *
 * Two things in here were worth the runs it took to find them. The model is made to work
 * through every tile and commit to a verdict on each, rather than hand back a list: asked
 * for a list it names the one obvious tile and stops, and a captcha wants all of them. And
 * the descriptions are kept to a few words, because the same reply also has to carry the
 * list -- an answer that spends its tokens describing gets cut off before the list arrives.
 */
export function buildCaptchaTilesPrompt(
  question: string,
  tileCount: number,
  hasExample: boolean,
  hint?: string,
): string {
  return [
    `A picture captcha shows a grid of ${tileCount} tiles. Each tile carries its number in a`,
    `red box in its top-left corner.`,
    hasExample
      ? `The first picture given is the example the captcha refers to as "shown", "the reference"` +
        ` or "the item shown". The second is the grid.`
      : "",
    "",
    `The captcha asks: "${question}"`,
    hint?.trim() ? `Extra context: ${hint.trim()}` : "",
    "",
    `Work through the tiles one at a time. For each, say in at most four words what it shows,`,
    `and whether it answers the question. Then list the numbers of the ones that do.`,
    "",
    `These captchas usually have 2 to 4 matching tiles out of ${tileCount}. Include every tile`,
    `that answers the question, not only the clearest one -- if two tiles show the same kind of`,
    `thing, both count. Missing one fails the check as surely as picking a wrong one does.`,
    "",
    `Reply with ONLY JSON:`,
    `{"seen": [{"n": 1, "is": "<a few words>", "match": true|false}, ... all ${tileCount}],`,
    ` "tiles": [<the numbers whose match is true>]}`,
    `No prose outside the JSON, no code fences.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The tile numbers out of a reply.
 *
 * `tiles` is the answer when it is there. Failing that -- and it does fail, since nine
 * descriptions and a list can run past the token budget -- the verdicts are read instead,
 * which is why the model is asked for them in the first place. A truncated reply is still
 * mostly readable: the objects that arrived whole are matched one by one.
 */
export function parseCaptchaTiles(reply: string, tileCount: number): number[] {
  const keep = (numbers: number[]): number[] => [
    ...new Set(numbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= tileCount)),
  ];

  const whole = /\{[\s\S]*\}/.exec(reply);
  if (whole) {
    try {
      const parsed = JSON.parse(whole[0]) as { tiles?: unknown; seen?: unknown };
      if (Array.isArray(parsed.tiles)) return keep(parsed.tiles.map((n) => Number(n)));
      if (Array.isArray(parsed.seen)) {
        return keep(
          parsed.seen
            .filter((one): one is { n: unknown; match: unknown } => !!one && typeof one === "object")
            .filter((one) => one.match === true)
            .map((one) => Number(one.n)),
        );
      }
    } catch {
      // A cut-off reply never parses; read what did arrive below
    }
  }

  // `"tiles": [1, 4, 7]` on its own, wherever it sits in the text
  const listed = /"tiles"\s*:\s*\[([^\]]*)\]/.exec(reply);
  if (listed) {
    const numbers = keep((listed[1].match(/\d+/g) ?? []).map(Number));
    if (numbers.length) return numbers;
  }

  // The verdicts, object by object, for a reply that stopped mid-list
  const verdicts = [...reply.matchAll(/\{[^{}]*\}/g)]
    .map((m) => m[0])
    .filter((one) => /"match"\s*:\s*true/i.test(one))
    .map((one) => Number(/"n"\s*:\s*(\d+)/.exec(one)?.[1]))
    .filter((n) => !Number.isNaN(n));
  return keep(verdicts);
}

/** Presses the challenge's own Verify, which is the only thing that submits a round. */
export async function pressCaptchaSubmit(
  page: Page,
  at: { x: number; y: number },
): Promise<void> {
  const frame = challengeFrame(page);
  if (frame && (await pressInFrame(page, frame, ".button-submit, .button-v2"))) return;
  await page.mouse.move(at.x - 8, at.y + 5).catch(() => {});
  await page.mouse.click(at.x, at.y).catch(() => {});
}

/**
 * Clicks one tile.
 *
 * By its place in the grid where the frame will do it -- the tiles are read in that order, so
 * number four is the fourth `.task` -- and at its measured centre otherwise.
 */
export async function clickCaptchaTile(page: Page, tile: CaptchaTile): Promise<void> {
  const frame = challengeFrame(page);
  if (frame) {
    const clicked = await frame
      .locator(".task")
      .nth(tile.n - 1)
      .click({ timeout: FRAME_CLICK_MS })
      .then(() => true)
      .catch(() => false);
    if (clicked) return;
  }
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height / 2;
  await page.mouse.move(x - 7, y + 6).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
}
