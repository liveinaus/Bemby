import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { cfTuning } from "./cfTuning";
import {
  chromiumExecutable,
  chromiumVersion,
  launchCfBrowser,
  type CfProfileVars,
  type LaunchedBrowser,
} from "./cfBrowser";
import {
  cfExitGeo,
  rememberCfExitGeo,
  type CfExitGeo,
  type ProxyCandidate,
} from "../tg/proxyProviders";
import { expandCommand, parseLabelAlternatives } from "./placeholders";
import {
  dataRefText,
  dataStoreOffReason,
  dataValueToText,
  deleteDataValue,
  isDataStoreEnabled,
  parseDataValue,
  readDataValue,
  recordAt,
  splitDataPath,
  valueAtPath,
  writeDataValue,
} from "../db/dataStore";
import { EMAIL_CODE_WAIT_MS } from "./emailCode";
import type { WebStep, WebStepLog } from "../types";

// Completes a checkin that hands back a URL behind Cloudflare's "I am not a bot"
// (managed challenge / Turnstile). CloakBrowser -- a Chromium whose fingerprint is patched
// at source rather than papered over from JavaScript -- loads the URL and works whatever
// challenge is in the way; because Bemby runs on the user's own host, the browser exits
// from the same IP (and proxy, if set) as expected, so simply loading the page registers
// the checkin server-side.
//
// The browser itself, its profiles and its fonts live in the data dir and are installed on
// demand: see cfBrowser.ts and cfFonts.ts, whose API is re-exported here so callers have
// one Cloudflare module to talk to.

export {
  CF_PROFILE_ID_DEFAULT,
  CF_PROFILE_ID_KEY,
  cfProfileKey,
  chromiumExecutable,
  chromiumVersion,
  cloakCacheDir,
  configuredProfileId,
  installCfChromium,
  installedBuildTier,
  isChromiumInstalled,
  keyedBuildPending,
  type CfProfileVars,
} from "./cfBrowser";
export {
  CF_FONTS,
  areCfFontsInstalled,
  cfFontsRoot,
  cfFontsStatus,
  installCfFonts,
} from "./cfFonts";


// Primary timezone and locale per country, for aligning the browser with its exit IP: a
// residential address in Japan reporting UTC and en-US is a cheap signal to check.
// Countries not listed are left alone rather than guessed at.
const COUNTRY_LOCALE: Record<string, { tz: string; lang: string }> = {
  AE: { tz: "Asia/Dubai", lang: "ar-AE" },
  AR: { tz: "America/Argentina/Buenos_Aires", lang: "es-AR" },
  AT: { tz: "Europe/Vienna", lang: "de-AT" },
  AU: { tz: "Australia/Sydney", lang: "en-AU" },
  BE: { tz: "Europe/Brussels", lang: "nl-BE" },
  BR: { tz: "America/Sao_Paulo", lang: "pt-BR" },
  CA: { tz: "America/Toronto", lang: "en-CA" },
  CH: { tz: "Europe/Zurich", lang: "de-CH" },
  CL: { tz: "America/Santiago", lang: "es-CL" },
  CN: { tz: "Asia/Shanghai", lang: "zh-CN" },
  CZ: { tz: "Europe/Prague", lang: "cs-CZ" },
  DE: { tz: "Europe/Berlin", lang: "de-DE" },
  DK: { tz: "Europe/Copenhagen", lang: "da-DK" },
  EE: { tz: "Europe/Tallinn", lang: "et-EE" },
  ES: { tz: "Europe/Madrid", lang: "es-ES" },
  FI: { tz: "Europe/Helsinki", lang: "fi-FI" },
  FR: { tz: "Europe/Paris", lang: "fr-FR" },
  GB: { tz: "Europe/London", lang: "en-GB" },
  HK: { tz: "Asia/Hong_Kong", lang: "zh-HK" },
  HU: { tz: "Europe/Budapest", lang: "hu-HU" },
  ID: { tz: "Asia/Jakarta", lang: "id-ID" },
  IE: { tz: "Europe/Dublin", lang: "en-IE" },
  IL: { tz: "Asia/Jerusalem", lang: "he-IL" },
  IN: { tz: "Asia/Kolkata", lang: "en-IN" },
  IT: { tz: "Europe/Rome", lang: "it-IT" },
  JP: { tz: "Asia/Tokyo", lang: "ja-JP" },
  KR: { tz: "Asia/Seoul", lang: "ko-KR" },
  MX: { tz: "America/Mexico_City", lang: "es-MX" },
  MY: { tz: "Asia/Kuala_Lumpur", lang: "ms-MY" },
  NL: { tz: "Europe/Amsterdam", lang: "nl-NL" },
  NO: { tz: "Europe/Oslo", lang: "nb-NO" },
  NZ: { tz: "Pacific/Auckland", lang: "en-NZ" },
  PH: { tz: "Asia/Manila", lang: "en-PH" },
  PL: { tz: "Europe/Warsaw", lang: "pl-PL" },
  PT: { tz: "Europe/Lisbon", lang: "pt-PT" },
  RO: { tz: "Europe/Bucharest", lang: "ro-RO" },
  RU: { tz: "Europe/Moscow", lang: "ru-RU" },
  SE: { tz: "Europe/Stockholm", lang: "sv-SE" },
  SG: { tz: "Asia/Singapore", lang: "en-SG" },
  TH: { tz: "Asia/Bangkok", lang: "th-TH" },
  TR: { tz: "Europe/Istanbul", lang: "tr-TR" },
  TW: { tz: "Asia/Taipei", lang: "zh-TW" },
  UA: { tz: "Europe/Kyiv", lang: "uk-UA" },
  US: { tz: "America/New_York", lang: "en-US" },
  VN: { tz: "Asia/Ho_Chi_Minh", lang: "vi-VN" },
  ZA: { tz: "Africa/Johannesburg", lang: "en-ZA" },
};

/** Cloudflare's own trace endpoint, which reports the country it sees the request from. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

export type CheckinPageResult = {
  /** Reached the destination with no Cloudflare interstitial remaining. */
  ok: boolean;
  /** A Cloudflare challenge was shown at some point. */
  challenged: boolean;
  /** Final page's visible text, for success/fail keyword matching. */
  text: string;
  /** Host of the final URL (kept for logs; full URL is sensitive). */
  finalHost: string;
  /** Label of the checkin control pressed inside a Mini App page, if any. */
  inAppAction?: string;
  /** Id of the proxy the accepted (or last) attempt went through. */
  proxyId?: string;
  /** Human-readable name of that proxy, for the job log. */
  proxyLabel?: string;
  /** How many exits were tried. */
  attempts?: number;
  /**
   * Exits that were used and did not get through. The accepted one is left out, so it
   * stays available, while a retry skips the ones already known to be refused.
   */
  refusedProxyIds?: string[];
  /**
   * The failure is about this exit -- a refused challenge, a page that never loaded -- so
   * another is worth trying. False for a failure inside the app, which every exit meets
   * alike: rotating through the pool then only wastes the budget.
   */
  exitRelated?: boolean;
  /**
   * The browser never started, so the attempt says nothing about the exit at all: the URL
   * was never requested through it. Such an attempt must not count as a refusal, or a
   * browser that cannot start burns the whole proxy pool and reports it as Cloudflare
   * turning every exit away.
   */
  browserFailed?: boolean;
  /**
   * The browser started but went away part-way through, so what the page was asked after
   * that answered with nothing. Reported apart from `browserFailed` only so the log can say
   * which of the two happened; both leave the exit untried.
   */
  browserGone?: boolean;
  /** Which browser build ran: the licensed one, or the unlicensed fallback. */
  browserTier?: "keyed" | "free";
  /**
   * The browser profile it ran on, once the name was resolved -- so the log can say whose
   * cookies these were. A login the site keeps asking for is nearly always a profile name
   * resolving to something other than what was intended.
   */
  profileKey?: string;
  /**
   * The device seed the browser ran on. Reported next to the profile because "the site still
   * knows me" is answered by whether this moved between runs: a kept profile holds it still on
   * purpose, and a throwaway one (`{noProfile}`) draws a new one every time.
   */
  deviceSeed?: number;
  /**
   * The locale the browser reported, and whether it was pinned in Settings rather than taken
   * from the exit. A page that comes up in the wrong language is one or the other: a pinned
   * locale beating the exit, or a remembered exit location that is out of date.
   */
  locale?: string;
  localePinned?: boolean;
  /** Why the attempt is not ok, in plain words, for the job log. */
  reason?: string;
  /** Navigation/renderer trouble seen while loading (page crash, failed request). */
  navError?: string;
  /** Title of the final page: tells a real app apart from a blank or crashed tab. */
  pageTitle?: string;
  /** data: URI screenshot of the final page, so a headless-only failure is visible. */
  screenshot?: string;
  /** One line per exit tried, for the job log. */
  trace?: string[];
  /** One entry per `open_url` sub-step run on the page, with its screenshot. */
  webSteps?: WebStepLog[];
};

/**
 * Browser state belonging to one job run rather than one attempt. A retry that offered
 * the same refused exits again would just replay the same refusals, so the exits are
 * remembered per host across every attempt of the run, and a budget started by an action
 * keeps running for its retries instead of restarting with each one.
 */
export type CfRunState = {
  /** Exits already refused, keyed by host. The accepted one is never in here. */
  refused: Map<string, Set<string>>;
  /** Deadlines the caller has started, keyed however the caller likes. */
  deadlines: Map<string, number>;
  /**
   * Why the last attempt on a host did not get through, kept so that running out of exits
   * can be reported with the failure that actually emptied the pool rather than as a bare
   * count -- "every proxy refused" says nothing about what went wrong.
   */
  lastFailure: Map<string, string>;
  /**
   * What this run is, for the things that are kept per job rather than per run: what a
   * `web_pick` has already handed to a loop, and the browser profile a name like
   * `{ip}-{jobId}` or `{tgId}` resolves to. Absent outside a job, where both fall back.
   */
  jobId?: number;
  templateId?: number;
  tgId?: number;
  /** Unique to this execution, which is what a viewer attaches to. */
  runId: string;
};

export function newCfRunState(
  identity: { jobId?: number; templateId?: number; tgId?: number } = {},
): CfRunState {
  return {
    refused: new Map(),
    deadlines: new Map(),
    lastFailure: new Map(),
    runId: randomBytes(9).toString("base64url"),
    ...(identity.jobId ? { jobId: identity.jobId } : {}),
    ...(identity.templateId ? { templateId: identity.templateId } : {}),
    ...(identity.tgId ? { tgId: identity.tgId } : {}),
  };
}

/**
 * The message for an action that has no exit left to try. What emptied the pool decides
 * how it reads: exits genuinely turned away by the site is the case the pool exists for,
 * while anything else -- a browser that would not start, an app that never had the control
 * being looked for -- is reported as itself, since no proxy was ever the problem.
 */
export function cfNoCandidatesMessage(state: CfRunState, host: string): string {
  const where = host || "the target site";
  const count = cfRefusedFor(state, host).size;
  const why = state.lastFailure.get(host || "*");
  if (!count) {
    return why
      ? `No proxy was available to try for ${where}. The attempt before it failed with: ${why}`
      : `No proxy was available to try for ${where}`;
  }
  return (
    `All ${count} available prox${count === 1 ? "y" : "ies"} have already been tried for ${where} in this run` +
    (why ? `, and the last one failed with: ${why}` : "")
  );
}

/** Notes why an attempt on `host` failed, for the message above. */
/** What a profile name's `{jobId}`, `{templateId}` and `{tgId}` are filled in from. */
export function cfProfileVars(state: CfRunState): CfProfileVars {
  return { jobId: state.jobId, templateId: state.templateId, tgId: state.tgId };
}

export function cfNoteFailure(state: CfRunState, host: string, reason?: string): void {
  if (reason) state.lastFailure.set(host || "*", reason);
}

/** The refused-exit set for `host`, created on first use. */
export function cfRefusedFor(state: CfRunState, host: string): Set<string> {
  const key = host || "*";
  let set = state.refused.get(key);
  if (!set) {
    set = new Set();
    state.refused.set(key, set);
  }
  return set;
}

export type LoadOptions = {
  /**
   * The URL is a signed Telegram Mini App URL: stub the webview bridge the app
   * expects, and press its checkin control once the page is up.
   */
  miniApp?: boolean;
  /**
   * Drop what the app itself kept in the profile before loading it, so the signed init data
   * is the only account it can see. Mini App only, and Cloudflare's own cookies are left
   * alone: the point is a fresh app session, not a fresh visitor.
   */
  clearAppSession?: boolean;
  /**
   * Steps to run inside the Mini App, in order. Each entry is the visible text of a
   * control to press, or a placeholder: `{input}` solves an arithmetic captcha locally,
   * `{aiInput}` hands the question to `solveQuestion`, and `scroll(x, y)` moves the page
   * so a control below the fold can be reached. Empty or omitted falls back to a
   * checkin-worded control.
   */
  inAppClicks?: string[];
  /** Answers a question read off the app (used by the `{aiInput}` step). */
  solveQuestion?: (question: string) => Promise<string>;
  /**
   * Exits to try, in order, when a challenge is refused. Cloudflare accepts some IPs and
   * not others, so a single proxy is often not enough.
   */
  proxyCandidates?: ProxyCandidate[];
  /** Re-mints the URL between attempts (signed Mini App init data ages). */
  refreshUrl?: () => Promise<string>;
  /**
   * Budget for the whole load, across every exit tried. Each internal wait is
   * clamped to what is left of it, so the step cannot run on indefinitely.
   * Defaults to the budget configured in Settings.
   */
  maxWaitMs?: number;
  /** Keep a screenshot of the final page on the result (diagnostics). */
  screenshot?: boolean;
  /**
   * Sub-steps to run against a plain web page once it is up (the `open_url` action).
   * Unlike `inAppClicks` these are typed rather than text, and each one is captured.
   */
  webSteps?: WebStep[];
  /** Hands a screenshot to the vision model, for the `ai_web_*` sub-steps. */
  aiLocate?: (image: string, prompt: string) => Promise<string>;
  /** What a `web_pick` with `skipUsed` should leave out, and where a used value is kept. */
  usedValues?: (varName: string) => string[];
  markUsed?: (varName: string, value: string) => void;
  /** Sends a message mid-run, for the `web_notify` sub-step. */
  notify?: (text: string, target?: string) => Promise<void>;
  /** Reads a code out of a mailbox, for the `web_email_code` sub-step. */
  emailCode?: WebStepHooks["emailCode"];
  /**
   * Which browser profile -- so which cookie jar and which device -- to run on. The name is
   * a template (`{ip}`, `{ip}-{jobId}`, `{tgId}`, free text); blank takes the configured
   * default. This is what decides whether a login is private to a job or pooled across
   * everything on the exit.
   */
  profile?: { template?: string; vars?: CfProfileVars };
  /**
   * X display to draw on. A job run gets one of its own so it can be watched by itself;
   * blank uses the shared one, which is what everything did before.
   */
  display?: string;
  /** The run these browsers belong to, so cancelling the run can close them. */
  runId?: string;
  /**
   * Stops the load when the job is cancelled. Checked between exits and between page steps,
   * and the run's browsers are closed from the outside, so a cancel lands in seconds rather
   * than at the end of the budget.
   */
  signal?: AbortSignal;
};

// Every timing and limit the browser side runs on lives in cfTuning, so it can be
// adjusted in Settings; the values there default to what this solver shipped with.
/**
 * Decides whether a Mini App pass actually did anything. A page that rendered nothing,
 * or one where the step the caller asked for was never carried out, is a failure even
 * though no challenge stood in the way -- reporting it as success logs a checkin that
 * never happened.
 */
export function miniAppVerdict(state: {
  /** A Cloudflare challenge was seen (and, per `solved`, how it went). */
  challenged: boolean;
  /** Verdict so far: the challenge cleared, or there was none. */
  solved: boolean;
  /** Visible text of the final page. */
  text: string;
  /** In-app steps that were carried out, if any. */
  inAppAction?: string;
  /**
   * Whether those steps actually acted on the app rather than only waiting or scrolling
   * into position. Omitted, any trace counts, which is how callers without the distinction
   * have always behaved.
   */
  inAppActed?: boolean;
  /** Why the in-app steps stopped short, if they did. */
  inAppFailure?: string;
  /** Navigation or renderer trouble seen on the way. */
  navError?: string;
  /** Visible text before the in-app steps ran, to tell a live prompt from page furniture. */
  priorText?: string;
  /** Overrides the configured "a page this short rendered nothing" length. */
  blankTextLen?: number;
}): { ok: boolean; reason?: string } {
  const { challenged, solved, text, inAppAction, inAppFailure, navError, priorText } = state;
  const blankLen = state.blankTextLen ?? cfTuning().blankTextLen;
  // A trace of nothing but waits and scrolls is not evidence the app was reached
  const acted = state.inAppActed ?? !!inAppAction;

  if (!challenged && text.trim().length < blankLen && !acted) {
    return {
      ok: false,
      reason: navError
        ? `the app page never rendered (${navError})`
        : "the app page came up blank -- the browser reached no readable content",
    };
  }
  if (solved && inAppFailure) return { ok: false, reason: inAppFailure };
  // The app's own wording wins over our reading of the page: if it is still asking to be
  // verified, the checkin did not go through, whatever the challenge detection saw. It has
  // to be a live prompt though -- a verify portal headed "Complete the verification" says
  // that whatever the outcome, and vetoing on it fails every exit in the pool. Wording that
  // was already there before the steps ran only counts when nothing else on the page moved.
  if (solved && VERIFY_REQUIRED_RE.test(text) && isLivePrompt(text, priorText)) {
    return {
      ok: false,
      reason:
        "the app is still asking for a human verification, so the checkin did not go " +
        "through -- add the verification step to the action (its control, or css:...)",
    };
  }
  if (!solved) {
    return {
      ok: false,
      reason: challenged
        ? 'Could not pass the Cloudflare "I am not a bot" challenge'
        : (navError ?? "the app page could not be loaded"),
    };
  }
  return { ok: true };
}

/**
 * Whether a verify-required prompt is the page answering what we just did, rather than
 * standing text. New wording is always live. Wording that was already there is only live
 * if the page is otherwise unchanged, which means the steps achieved nothing.
 */
function isLivePrompt(text: string, priorText?: string): boolean {
  if (priorText == null) return true;
  if (!VERIFY_REQUIRED_RE.test(priorText)) return true;
  return text.trim() === priorText.trim();
}

/**
 * The fallback wording for a browser step that failed without saying why. Only a page that
 * actually met a challenge is described as one: naming Cloudflare on a step where no
 * challenge ever appeared sends the reader after the wrong thing entirely.
 */
export function cfFailureFallback(challenged: boolean, miniApp = false): string {
  if (challenged) return 'Could not pass the Cloudflare "I am not a bot" challenge';
  return miniApp
    ? "The Mini App did not get through, and no challenge was involved -- see the step's page text and screenshot"
    : "The page did not get through, and no challenge was involved";
}

/** Why a plain page load did not get through, in plain words, for the job log. */
function challengeRefused(challenged: boolean, navError?: string): string {
  if (challenged) return 'Could not pass the Cloudflare "I am not a bot" challenge';
  return navError ?? "the page could not be loaded";
}

/** Millis left before `deadline`, never negative. */
function msLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** `ms`, cut down to what is left of the budget. */
function capped(ms: number, deadline: number): number {
  return Math.min(ms, msLeft(deadline));
}

/** Sleeps `ms`, or until the budget runs out. */
function sleep(ms: number, deadline?: number): Promise<void> {
  const wait = deadline ? capped(ms, deadline) : ms;
  return new Promise((r) => setTimeout(r, Math.max(0, wait)));
}

/**
 * Asks Cloudflare where this exit comes out, so the next launch can carry the matching
 * clock and language. Looked up once per exit and remembered: a proxy's country does not
 * move, and the lookup costs a page load.
 *
 * Nothing is emulated over CDP here -- that is detectable in itself. What is learnt is
 * handed to the browser as launch flags, which is why the caller relaunches once when an
 * exit turns out to be somewhere new.
 */
async function probeExitGeo(
  page: Page,
  key: string,
  deadline: number,
): Promise<CfExitGeo | undefined> {
  try {
    await page.goto(TRACE_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(5_000, capped(15_000, deadline)),
    });
    const body = await page.evaluate(() => document.body?.innerText ?? "");
    const loc = /(?:^|\n)loc=([A-Z]{2})/.exec(body)?.[1];
    if (!loc) return undefined;
    const geo: CfExitGeo = { loc, ...(COUNTRY_LOCALE[loc] ?? {}) };
    rememberCfExitGeo(key, geo);
    console.log(
      `[cloudflare] exit ${key} comes out in ${loc}` +
        (geo.tz ? ` -- using ${geo.tz} / ${geo.lang}` : " -- no locale mapped"),
    );
    return geo;
  } catch (err: any) {
    console.warn(`[cloudflare] exit lookup failed: ${err?.message ?? err}`);
    return undefined;
  }
}

/**
 * A browser for this exit, aligned with the country it comes out in.
 *
 * The timezone and locale are launch flags, so an exit being seen for the first time is
 * launched once to find out where it lands and then relaunched with that applied. The
 * answer is kept, so this costs one extra launch per exit ever -- not per job.
 */
async function launchAlignedBrowser(
  proxyUrl: string | undefined,
  deadline: number,
  profile?: { template?: string; vars?: CfProfileVars },
  display?: string,
  runId?: string,
): Promise<LaunchedBrowser> {
  const launched = await launchCfBrowser(proxyUrl, { profile, display, runId });
  if (launched.geo) return launched;

  const geo = await probeExitGeo(launched.page, launched.key, deadline);
  if (!geo?.tz || msLeft(deadline) <= 0) return launched;

  await launched.close();
  // A licence key is one session at a time, and the service does not always have the old
  // one torn down by the time the next launch asks for it -- relaunching straight away can
  // be refused, which the keyed build answers by quitting during startup. The seat is
  // already free locally; this is purely to let the far side catch up.
  await sleep(cfTuning().relaunchSettleMs, deadline);
  return launchCfBrowser(proxyUrl, { profile, display, runId });
}

/**
 * Clicks an element by moving the pointer to it, rather than through `page.click`.
 *
 * The driver's own click first waits for the element to be scrolled into view and stable,
 * both settled off frame callbacks. Under Xvfb, with a window Chromium believes is
 * occluded, those callbacks are throttled and never arrive: the call then hangs until the
 * timeout and the step reports a press that never happened. Scrolling synchronously in the
 * page and dispatching real pointer events avoids the wait entirely, and is closer to what
 * a person does anyway.
 */
async function elementCentre(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  return page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector)
    .catch(() => null);
}

/**
 * The anchor's box in viewport coordinates, for a step that presses at an offset from it
 * rather than on it. Scrolled into view first, exactly as `elementCentre` does, so the
 * figures the offset is measured from are the ones the screenshot will show.
 */
async function elementBox(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector)
    .catch(() => null);
}

/**
 * Walks the pointer from one point to another with the button already down, in small moves
 * that start slow, run on, and ease off, with a slight arc across the line of travel.
 *
 * A slider check does not only look at where the handle ended up: it watches the moves that
 * got it there, and a single jump -- or a constant speed in a dead straight line -- is what
 * marks one out as not a hand. The arc is a couple of pixels, enough to be there and not
 * enough to drag the handle off its rail.
 */
async function glideTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
  deadline: number,
): Promise<void> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy);
  const moves = Math.max(8, Math.min(40, Math.round(span / 12)));
  const pause = Math.max(0, Math.round(durationMs / moves));
  // Across the line of travel, so the arc bows off the path rather than along it
  const arc = Math.min(3, span / 20);
  const nx = span ? -dy / span : 0;
  const ny = span ? dx / span : 0;

  for (let i = 1; i <= moves; i++) {
    const t = i / moves;
    // Slow away, quick through the middle, slow into the target
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const bow = Math.sin(t * Math.PI) * arc;
    await page.mouse.move(from.x + dx * eased + nx * bow, from.y + dy * eased + ny * bow);
    if (pause) await sleep(pause, deadline);
  }
  // Land exactly on the target, whatever the arc did on the way
  await page.mouse.move(to.x, to.y);
}

async function clickElement(page: Page, selector: string): Promise<boolean> {
  const box = await elementCentre(page, selector);
  if (!box) return false;
  // Approach then press, as a pointer would
  let failure: string | undefined;
  await page.mouse.move(box.x - 8, box.y + 6).catch((err: any) => {
    failure = `move: ${err?.message ?? err}`;
  });
  await page.mouse.click(box.x, box.y).catch((err: any) => {
    failure = `click: ${err?.message ?? err}`;
  });
  if (failure) {
    console.warn(`[cloudflare] pointer ${failure}`);
    return false;
  }
  return true;
}

// Full-page Cloudflare interstitial ("Just a moment...").
async function isInterstitial(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) || "";
  if (/just a moment|checking your browser|attention required|请稍候|正在验证/i.test(title)) return true;
  return page
    .evaluate(() => !!document.querySelector("#challenge-form, #challenge-running"))
    .catch(() => false);
}

// Turnstile renders into a shadow root when a site calls turnstile.render() itself, and
// document.querySelector cannot see inside one -- so every widget lookup walks shadow
// roots as well, or an app's challenge looks absent while it sits there unsolved.
const DEEP_QUERY_FN = `
  function __deepQuery(selector) {
    var out = [];
    (function walk(root) {
      out.push.apply(out, Array.prototype.slice.call(root.querySelectorAll(selector)));
      Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    })(document);
    return out;
  }
`;

/**
 * An interactive Turnstile challenge is on the page. The response field is the reliable
 * marker: Turnstile creates it for every widget, including ones rendered explicitly into
 * the site's own element, whose iframe then lives in a closed shadow root that no
 * selector can reach.
 */
async function hasTurnstileWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(".cf-turnstile, iframe[src*='challenges.cloudflare.com'], [name='cf-turnstile-response']").length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** The Turnstile script is loaded, so a widget may still be rendered later. */
async function hasTurnstileScript(page: Page): Promise<boolean> {
  return page
    .evaluate(
      () => !!document.querySelector("script[src*='challenges.cloudflare.com/turnstile']"),
    )
    .catch(() => false);
}

// Either form counts when deciding whether a page is challenge-gated at all.
async function hasTurnstile(page: Page): Promise<boolean> {
  return (await hasTurnstileWidget(page)) || (await hasTurnstileScript(page));
}

/**
 * Nothing challenge-shaped is on the page any more, and there is something else there
 * instead. The second half matters: a document that is still loading has no interstitial
 * markers in it either, and calling that "cleared" logs a checkin that never happened.
 */
async function challengeGone(page: Page): Promise<boolean> {
  if (await isInterstitial(page)) return false;
  if (await hasTurnstileWidget(page)) return false;
  const rendered = await page
    .evaluate(() => (document.body?.innerText ?? "").trim().length)
    .catch(() => 0);
  return rendered > 0;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Locates the Turnstile widget's iframe through CDP with `pierce`, the only way to see
 * an element inside the closed shadow root Turnstile renders into. Returns its
 * on-screen box.
 */
async function turnstileBoxViaCdp(page: Page): Promise<Box | null> {
  let session: any;
  try {
    session = await page.context().newCDPSession(page);
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });

    let nodeId: number | null = null;
    const walk = (node: any) => {
      if (nodeId) return;
      if (node.nodeName === "IFRAME") {
        const attrs: string[] = node.attributes ?? [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === "src" && /challenges\.cloudflare\.com/.test(attrs[i + 1] ?? "")) {
            nodeId = node.nodeId;
            return;
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    if (!nodeId) return null;

    const { model } = await session.send("DOM.getBoxModel", { nodeId });
    const border = model.border as number[]; // x1,y1,x2,y2,x3,y3,x4,y4
    return {
      x: border[0],
      y: border[1],
      width: border[2] - border[0],
      height: border[5] - border[1],
    };
  } catch {
    return null;
  } finally {
    await session?.detach?.().catch(() => {});
  }
}

/**
 * Clicks an embedded Turnstile widget's checkbox with a real mouse click at its left
 * edge, where the checkbox sits.
 *
 * Nothing else clicks it: an interactive widget waits for a real press, and aiming at the
 * response field's parent does not work -- for an explicitly rendered widget that is a
 * wrapper holding nothing but a hidden input, a zero-sized box whose click lands nowhere.
 * Hence the CDP lookup, with the widget's sized ancestor as a fallback.
 */
export async function clickTurnstileWidget(page: Page): Promise<boolean> {
  let box = await turnstileBoxViaCdp(page);

  if (!box || box.width < 20) {
    box = (await page
      .evaluate(
        `(function () { ${DEEP_QUERY_FN}
           var el = __deepQuery("iframe[src*='challenges.cloudflare.com'], .cf-turnstile, [name='cf-turnstile-response']")[0];
           if (!el) return null;
           // Climb to something actually laid out: the widget's own slot in the page
           var node = el;
           for (var i = 0; node && i < 4; i++, node = node.parentElement) {
             var r = node.getBoundingClientRect();
             if (r.width >= 200 && r.height >= 30) {
               node.scrollIntoView({ block: 'center' });
               r = node.getBoundingClientRect();
               return { x: r.x, y: r.y, width: r.width, height: r.height };
             }
           }
           return null;
         })()`,
      )
      .catch(() => null)) as Box | null;
  }
  if (!box || box.width < 20) return false;

  // Approach the checkbox like a pointer would, then click it
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 8).catch(() => {});
  await page.mouse.click(box.x + 30, box.y + box.height / 2).catch(() => {});
  return true;
}

// A solved Turnstile fills its hidden response field with a token; the widget API is
// asked as well, since a site can render the widget somewhere this cannot reach.
export async function turnstileToken(page: Page): Promise<string> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var el = __deepQuery("[name='cf-turnstile-response']")[0];
         if (el && el.value) return el.value;
         try { return window.turnstile && window.turnstile.getResponse ? (window.turnstile.getResponse() || '') : ''; }
         catch (e) { return ''; }
       })()`,
    )
    .then((v) => (typeof v === "string" ? v : ""))
    .catch(() => "");
}

/**
 * Backs the `web_turnstile` page step and the `{turnstile}` in-app step: tick the checkbox
 * where it sits, and say what happened.
 *
 * A widget that is not there is a pass, not a failure. Turnstile clears itself for an
 * address it likes -- often without ever drawing a checkbox -- so a step that insisted on
 * one would fail exactly the runs that had nothing to do. The widget gets a short grace to
 * render; where an app raises the challenge later than that, put a delay before the step.
 */
async function tickTurnstile(
  page: Page,
  deadline: number,
): Promise<{ outcome: string; failure?: string }> {
  const tune = cfTuning();
  const graceBy = Math.min(Date.now() + tune.settleMs, deadline);
  let present = await hasTurnstileWidget(page);
  while (!present && Date.now() < graceBy) {
    await sleep(tune.readyPollMs, graceBy);
    present = await hasTurnstileWidget(page);
  }
  if (!present) return { outcome: "no Turnstile widget on the page, nothing to tick" };

  // Already solved: the widget rendered and satisfied itself, so pressing it does nothing.
  if (await turnstileToken(page)) return { outcome: "Turnstile was already solved" };

  if (!(await clickTurnstileWidget(page))) {
    return { outcome: "", failure: "the Turnstile widget has no on-screen box to press" };
  }

  // The token arrives a moment after the press and the site's own request carries it, so
  // wait for it rather than leaving an unsolved challenge behind the step.
  const tokenBy = Math.min(Date.now() + tune.confirmTimeoutMs, deadline);
  let token = await turnstileToken(page);
  while (!token && Date.now() < tokenBy) {
    await sleep(tune.pollMs, tokenBy);
    token = await turnstileToken(page);
  }
  return {
    outcome: `pressed the Turnstile checkbox${token ? " (token issued)" : " (no token yet)"}`,
  };
}

/**
 * Whether a Turnstile token means the page is through.
 *
 * A token issued to a widget the site itself put on its page is the deliverable: the site
 * takes it from there. On a full-page interstitial it proves nothing -- Cloudflare's own
 * widget satisfies itself and hands the token back, and the edge still refuses an address
 * it has decided against, leaving the interstitial up. Believing the token there reports a
 * challenge passed that never was, and whatever runs next acts on a page with none of the
 * site on it.
 */
export function turnstilePassed(token: string, onInterstitial: boolean): boolean {
  return !!token && !onInterstitial;
}

// Text a page shows when the challenge was refused outright. Recognising it ends the
// attempt at once instead of waiting out the timeout, so the next exit can be tried.
const REFUSED_RE =
  /人机验证失败|人機驗證失敗|验证失败|驗證失敗|verification failed|challenge failed|请刷新页面重试|請刷新頁面重試|invalid turnstile token|error occurred during verification/i;

// An app asking for a human check in its own wording, typically in a dialog raised by
// pressing the checkin control. The widget behind it renders a moment later, so this is
// also the signal to keep waiting for one.
const VERIFY_REQUIRED_RE =
  /请完成人机验证|請完成人機驗證|完成人机验证|完成人機驗證|需要人机验证|需要人機驗證|complete the (?:human )?verification|verify you are human/i;

// Text a verify portal shows once the identity check has gone through. An adverb may sit
// between the words ("驗證已經通過"), so a short gap is allowed -- but never one carrying a
// negation, which would read "驗證未通過" as a pass.
const NOT_NEGATED = "[^未不沒没無无失]";
const SUCCESS_RE = new RegExp(
  "success|verified|verification complete|completed|已(驗|验)[證证]" +
    `|(驗|验)[證证]${NOT_NEGATED}{0,3}(成功|完成|通過|通过)` +
    `|已${NOT_NEGATED}{0,2}(通過|通过)`,
  "i",
);

// Some verify portals only engage Turnstile after the user clicks a button. A
// real (CDP) click is required -- Turnstile ignores untrusted element.click()
// events. Generic: prefer a button whose label reads like a verify/continue
// action, otherwise fall back to the sole visible button (these portals almost
// always have exactly one), so it isn't tied to any one site's wording. Nothing is
// clicked on a page full of unrelated controls (e.g. a Mini App panel with a nav
// sidebar), where guessing would navigate away from the challenge.
const VERIFY_LABEL_RE =
  /verify|驗證|验证|continue|submit|確認|确认|start|begin|開始|开始|proceed/i;

/**
 * Which control to press to engage a verify portal's Turnstile, or null to press nothing.
 *
 * A verify portal is a near-empty page: a widget and a button. Anything with a site around
 * it is not one, and guessing there presses the site's own controls -- a login form's
 * "send verification code" reads exactly like a verify button, and pressing it submits the
 * form with whatever is in it.
 */
export function verifyPortalChoice(labels: string[]): number | null {
  if (labels.length > 3) return null;
  const named = labels.findIndex((label) => VERIFY_LABEL_RE.test(label));
  if (named >= 0) return named;
  return labels.length === 1 ? 0 : null;
}

// Visible controls, in document order, shared by the two passes below so the index one
// returns still means the same element to the other.
const VISIBLE_CONTROLS_FN = `
  function __visibleControls() {
    return Array.prototype.slice
      .call(document.querySelectorAll("button,a[href],[role=button],input[type=submit],input[type=button]"))
      .filter(function (el) { return el.offsetParent !== null || el.getClientRects().length > 0; });
  }
`;

async function clickVerifyButton(page: Page): Promise<boolean> {
  const labels = (await page
    .evaluate(
      `(function () { ${VISIBLE_CONTROLS_FN}
         return __visibleControls().map(function (el) { return el.textContent || el.value || ""; });
       })()`,
    )
    .catch(() => null)) as string[] | null;
  if (!labels) return false;

  const at = verifyPortalChoice(labels);
  if (at === null) return false;

  const sel = await page
    .evaluate(
      `(function () { ${VISIBLE_CONTROLS_FN}
         var el = __visibleControls()[${at}];
         if (!el) return null;
         el.setAttribute("data-cf-click", "1");
         return "[data-cf-click='1']";
       })()`,
    )
    .catch(() => null);
  if (!sel) return false;
  return clickElement(page, sel as string);
}


// Cap (capjs.js.org) is a self-hosted proof-of-work captcha some apps use instead of
// Turnstile: a checkbox reading "Verify you're human" inside a custom element's shadow
// root. Ticking it runs the work in the browser and the app proceeds on its own once a
// token is issued, so it needs no service and no key -- only a real click and patience.
const CAP_SELECTOR = "cap-widget,cap-floating-widget,[data-cap-api-endpoint]";
const CAP_ASKING_RE = /verify you'?re human|i'?m not a robot|请完成验证/i;
const CAP_SOLVED_RE = /you'?re human|verified|完成|成功/i;

/** A Cap widget is on the page (light DOM or inside a shadow root). */
async function hasCapWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(${JSON.stringify(CAP_SELECTOR)}).length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** What the Cap widget is showing, and whether it has produced a token. */
async function capState(page: Page): Promise<{ asking: boolean; solved: boolean }> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return { asking: false, solved: false };
         var root = w.shadowRoot || w;
         var text = (root.textContent || "") + " " + (w.textContent || "");
         var token = w.getAttribute("data-cap-token") || w.getAttribute("token") || "";
         if (!token) {
           var field = (root.querySelector ? root.querySelector("input") : null);
           token = (field && field.value) || "";
         }
         return {
           asking: ${CAP_ASKING_RE.toString()}.test(text),
           solved: !!token || (${CAP_SOLVED_RE.toString()}.test(text) && !${CAP_ASKING_RE.toString()}.test(text)),
         };
       })()`,
    )
    .then((v: any) => ({ asking: !!v?.asking, solved: !!v?.solved }))
    .catch(() => ({ asking: false, solved: false }));
}

/** Ticks the Cap checkbox: a real pointer press at its box, shadow root and all. */
async function clickCapWidget(page: Page): Promise<boolean> {
  const box = (await page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return null;
         w.scrollIntoView({ block: "center" });
         var r = w.getBoundingClientRect();
         if (r.width < 10 || r.height < 10) return null;
         return { x: r.x, y: r.y, width: r.width, height: r.height };
       })()`,
    )
    .catch(() => null)) as Box | null;
  if (!box) return false;
  // The checkbox sits at the left edge, as it does in Turnstile
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 6).catch(() => {});
  await page.mouse.click(box.x + 22, box.y + box.height / 2).catch(() => {});
  return true;
}

/**
 * Ticks a Cap checkbox and waits for the app to move on. The work happens in the browser
 * and takes a moment; the app is what completes the action once its token arrives, so the
 * app's own success wording counts as much as the widget's state.
 */
async function solveCap(page: Page, deadline: number): Promise<boolean> {
  const tune = cfTuning();
  if (!(await clickCapWidget(page))) return false;
  let clicks = 1;
  while (Date.now() < deadline) {
    await sleep(tune.pollMs, deadline);
    const state = await capState(page);
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (state.solved || SUCCESS_RE.test(body)) return true;
    if (REFUSED_RE.test(body)) return false;
    // Gone from the page altogether: the app took it and closed the dialog
    if (!state.asking && !VERIFY_REQUIRED_RE.test(body)) return true;
    // Nudge it a couple of times in case the first press missed the checkbox
    if (state.asking && clicks < 3 && Date.now() > deadline - tune.challengeTimeoutMs + clicks * 8_000) {
      clicks++;
      await clickCapWidget(page);
    }
  }
  return false;
}

// telegram-web-app.js posts events to the host client; with no host it either
// throws or silently drops them, and apps that call WebApp.ready() first then break.
// This stub is what a Telegram Android/iOS webview exposes, so the bridge works and
// the signed initData in the URL fragment is picked up as normal.
const WEBVIEW_PROXY_SHIM = `
  window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
    postEvent: function (type, data) {
      try { window.dispatchEvent(new CustomEvent('tg-post', { detail: { type: type, data: data } })); } catch (e) {}
    },
  };
`;

/**
 * Cookies Cloudflare issues, which are the whole reason several accounts share a profile:
 * the clearance is the exit's, not the account's, and dropping it buys a fresh challenge
 * on every run for nothing.
 */
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|__cflb|cf_chl_)/;

/** Would a request to `host` carry a cookie scoped to `domain`? The usual matching rule. */
function cookieAppliesTo(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === bare || h.endsWith(`.${bare}`);
}

/**
 * Of everything in the jar, the cookies that speak for the account rather than for the exit:
 * the app's own, and nothing belonging to another site or to Cloudflare.
 */
export function miniAppCookiesToDrop<T extends { name: string; domain: string }>(
  host: string,
  cookies: T[],
): T[] {
  return cookies.filter((c) => cookieAppliesTo(host, c.domain) && !CF_COOKIE_RE.test(c.name));
}

/**
 * Wipes the account the Mini App remembers, leaving the exit's clearance in place.
 *
 * A signed URL names one account, but that is only what the app sees on a first visit. Most
 * keep their own token afterwards -- localStorage, IndexedDB, a cookie of their own -- and
 * read that in preference on the next load. In a profile shared by several accounts (`{ip}`
 * with everything on one exit, above all) every run then lands on whoever signed in first,
 * however carefully Telegram signed the init data. A Mini App has no other way in, so with
 * nothing kept it must take the account it was handed.
 *
 * Scoped to the app's own origin, so nothing else in the profile is touched, and Cloudflare's
 * cookies are left where they are: the clearance belongs to the exit, not to the account.
 */
async function clearMiniAppSession(page: Page, url: string): Promise<string | null> {
  let origin: string;
  let host: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    host = parsed.hostname;
  } catch {
    return null; // not an address we can scope anything to
  }

  const cleared: string[] = [];
  try {
    // Where an app's token usually is. Service workers go too: one can hand back a cached
    // response (or a stashed token) after everything else has been dropped.
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "local_storage,indexeddb,websql,cache_storage,service_workers",
      });
      cleared.push("site storage");
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (err: any) {
    // Without CDP the cookie pass below still does most of the work, so this is worth
    // recording rather than failing the step over
    cleared.push(`site storage failed (${err?.message ?? err})`);
  }

  try {
    const context = page.context();
    const drop = miniAppCookiesToDrop(host, await context.cookies());
    for (const c of drop) {
      await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
    }
    if (drop.length) cleared.push(`${drop.length} cookie(s)`);
  } catch (err: any) {
    cleared.push(`cookies failed (${err?.message ?? err})`);
  }

  return cleared.length ? `cleared for ${host}: ${cleared.join(", ")}` : null;
}

// Labels that clearly mean "check in", and the states that mean it is already done.
// Deliberately narrow: only a control carrying such a label is pressed, so nothing
// else in the app (points spending, lotteries) can be triggered.
const IN_APP_LABEL_RE = /签到|簽到|打卡|领取|領取|check\s?-?in|sign\s?-?in/i;
const IN_APP_DONE_RE = /已签到|已簽到|已打卡|已领取|已領取|已完成|already/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOADING_RE = /loading|加载|加載|載入|please wait|请稍候|請稍候/i;

/**
 * Waits for the page to finish arriving before anything judges it.
 *
 * `goto` returns at DOMContentLoaded, which for a Mini App is still a spinner and for a
 * challenged page can be an empty document -- Cloudflare's interstitial writes its title
 * and markers a moment later. Judged at that instant the page looks challenge-free, and
 * the steps then run against an interstitial that will never show them what they want.
 *
 * Returns as soon as a challenge shows up, or once the rendered text has stopped changing.
 */
async function waitForPageReady(page: Page, budgetDeadline: number): Promise<void> {
  const tune = cfTuning();
  const deadline = Math.min(Date.now() + tune.appReadyTimeoutMs, budgetDeadline);
  let previous = "";
  while (Date.now() < deadline) {
    if ((await hasTurnstile(page)) || (await isInterstitial(page))) return;
    const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).trim();
    const booting = !text || text.length < 40 || LOADING_RE.test(text);
    if (!booting && text === previous) return;
    previous = text;
    await sleep(tune.readyPollMs, deadline);
  }
}

/**
 * A full-page challenge is up, so none of the site is on screen to act on.
 *
 * Deliberately not "a Turnstile widget is present": plenty of sites put one on their own
 * login form, where the page around it is perfectly usable and the widget verifies itself
 * while the steps get on with filling the form in.
 */
async function interstitialOnPage(page: Page): Promise<boolean> {
  return isInterstitial(page);
}

/** How the thing that got clicked was identified, worst last. */
type InAppTargetKind = "selector" | "control" | "pointer" | "in-card" | "text";

type InAppTarget = { label: string; kind: InAppTargetKind; done: boolean };

/**
 * Finds the control to press inside the Mini App.
 *
 * A label is not a control. These apps put the wording in several places at once -- a
 * card captioned "每日签到" over a heading "立即签到" beside a button reading "签到" -- and
 * taking the first match in document order lands on the caption, which clicks nothing
 * while looking like success. So every match is collected and the most control-like one
 * wins: a real button or link first, then an element that at least behaves like one, then
 * a button sitting in the same card as the label, and only then the bare text.
 *
 * `wanted` may instead be a CSS selector (`css:` prefix), which skips all of this and
 * presses exactly what the selector names.
 */
async function findInAppCheckin(
  page: Page,
  labelRe: RegExp,
  selector?: string,
): Promise<InAppTarget | null> {
  return page
    .evaluate(
      ({ labelSrc, doneSrc, sel }: { labelSrc: string; doneSrc: string; sel: string }) => {
        const label = new RegExp(labelSrc, "i");
        const done = new RegExp(doneSrc, "i");
        const CONTROL_SEL = "button,[role=button],a[href],input[type=submit],input[type=button]";

        // The helpers hang off an object rather than standing as named consts, and every
        // browser-side function in this file has to. The dev server loads it through tsx,
        // whose keep-names transform rewrites a function bound to a name into a
        // `__name(fn, "name")` call -- and that helper exists only in the module scope on
        // this side, never in the page. The body then throws on its first line, which the
        // catch below turns into "no checkin control here". A member assignment carries no
        // inferred name, so it comes through untouched under tsx and tsc alike.
        const fn = {} as {
          visible: (el: Element) => boolean;
          spent: (el: Element) => boolean;
          describe: (el: Element, fallback: string) => string;
          take: (
            el: Element,
            kind: string,
            fallbackLabel: string,
          ) => { label: string; kind: string; done: boolean };
          ownText: (el: Element) => string;
          candidatesFor: (el: Element) => Array<{ el: Element; kind: string }>;
        };

        fn.visible = (el) =>
          (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;

        fn.spent = (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.closest("[disabled],[aria-disabled='true']") !== null;

        fn.describe = (el, fallback) =>
          ((el.textContent ?? "").trim() || (el as HTMLInputElement).value || fallback).slice(0, 40);

        fn.take = (el, kind, fallbackLabel) => {
          if (fn.spent(el) || done.test(fn.describe(el, ""))) {
            return { label: fn.describe(el, fallbackLabel), kind: kind, done: true };
          }
          el.setAttribute("data-cf-checkin", "1");
          return { label: fn.describe(el, fallbackLabel), kind: kind, done: false };
        };

        // An explicit selector is taken at its word: first visible match.
        if (sel) {
          const hit = Array.from(document.querySelectorAll(sel)).find((el) => fn.visible(el));
          return hit ? fn.take(hit, "selector", sel) : null;
        }

        // Direct text nodes only, so the element holding the label is found rather than
        // every wrapper around it.
        fn.ownText = (el) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent ?? "")
            .join("")
            .trim();

        // Ranked candidates for one labelled element: the real control it sits in, an
        // ancestor that behaves like one, a control inside the same card, or the text.
        fn.candidatesFor = (el) => {
          const out: Array<{ el: Element; kind: string }> = [];
          const semantic = el.closest(CONTROL_SEL);
          if (semantic && fn.visible(semantic)) out.push({ el: semantic, kind: "control" });

          let node: Element | null = el;
          for (let i = 0; node && i < 3; i++, node = node.parentElement) {
            if (getComputedStyle(node as HTMLElement).cursor === "pointer") {
              out.push({ el: node, kind: "pointer" });
              break;
            }
          }

          // The label captions a card; the button that acts on it lives in that card.
          let box: Element | null = el;
          for (let i = 0; box && i < 4; i++, box = box.parentElement) {
            const inside = Array.from(box.querySelectorAll(CONTROL_SEL)).filter(
              (c) =>
                fn.visible(c) &&
                label.test((c.textContent ?? "") || (c as HTMLInputElement).value || ""),
            );
            if (inside.length) {
              out.push({ el: inside[0], kind: "in-card" });
              break;
            }
          }

          out.push({ el, kind: "text" });
          return out;
        };

        const RANK = ["control", "pointer", "in-card", "text"];
        let best: { el: Element; kind: string; fallback: string } | null = null;

        for (const el of Array.from(document.querySelectorAll("*"))) {
          const text = (fn.ownText(el) || (el as HTMLInputElement).value || "").trim();
          if (!text || text.length > 30 || !label.test(text)) continue;
          if (!fn.visible(el)) continue;

          for (const cand of fn.candidatesFor(el)) {
            if (!best || RANK.indexOf(cand.kind) < RANK.indexOf(best.kind)) {
              best = { el: cand.el, kind: cand.kind, fallback: text };
            }
            break; // only this element's best candidate competes
          }
          // A real control is as good as it gets; no need to look further
          if (best && best.kind === "control") break;
        }

        return best ? fn.take(best.el, best.kind, best.fallback) : null;
      },
      { labelSrc: labelRe.source, doneSrc: IN_APP_DONE_RE.source, sel: selector ?? "" },
    )
    .catch((err: any) => {
      // Swallowing this once cost a long hunt: a lookup that throws looks exactly like
      // an app with no checkin control on it.
      console.warn(`[cloudflare] in-app lookup failed: ${err?.message ?? err}`);
      return null;
    }) as Promise<InAppTarget | null>;
}

/** `css:<selector>` in a step names the element to press outright. */
function parseSelectorStep(step: string): string | undefined {
  const m = /^css:(.+)$/i.exec(step.trim());
  return m ? m[1].trim() : undefined;
}

type ClickOutcome = {
  /** What to show in the log. */
  outcome: string;
  /** The app said this action is already spent. */
  done: boolean;
  /** Nothing control-like was pressed, so the click may well have done nothing. */
  weak: boolean;
};

/**
 * Presses one control inside the Mini App: the one named by `wanted` (a label, or a
 * `css:` selector), or a checkin-worded one when nothing is given. Returns what happened,
 * or undefined when the label is nowhere on the page.
 */
async function clickInAppControl(
  page: Page,
  wanted?: string,
): Promise<ClickOutcome | undefined> {
  const selector = wanted ? parseSelectorStep(wanted) : undefined;
  // A CSS selector is taken whole -- `|` is a legitimate character in one (namespaces,
  // `[attr|=value]`), so only a plain label is read as a list of alternatives.
  const alternatives = wanted && !selector ? parseLabelAlternatives(wanted) : [];
  const labelRe = alternatives.length
    ? new RegExp(alternatives.map(escapeRe).join("|"), "i")
    : IN_APP_LABEL_RE;

  const target = await findInAppCheckin(page, labelRe, selector);
  if (target?.done) {
    return { outcome: `already done: ${target.label}`, done: true, weak: false };
  }

  // Nothing control-like matched. Before pressing inert text -- or giving up -- see
  // whether the app is saying the action is already spent: a checkin done earlier today
  // takes its button away but leaves the wording ("每日签到 … 今日已签到") behind, which
  // still matches the label the job names.
  if (!selector && (!target || target.kind === "text")) {
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (IN_APP_DONE_RE.test(text) && (labelRe.test(text) || IN_APP_LABEL_RE.test(text))) {
      return { outcome: "already done (from the page's own wording)", done: true, weak: false };
    }
  }

  if (target) {
    // Real (CDP) click: mini apps commonly bind pointer events, not synthetic clicks
    const landed = await clickElement(page, "[data-cf-checkin='1']");
    await page.evaluate(() =>
      document.querySelector("[data-cf-checkin]")?.removeAttribute("data-cf-checkin"),
    ).catch(() => {});
    if (!landed) {
      console.warn("[cloudflare] in-app click did not land: the control has no on-screen box");
      return { outcome: `${target.label} (could not be clicked)`, done: false, weak: true };
    }
    // "text" means the label itself was clicked for want of anything better, which for
    // an app that binds its handler to a button does nothing at all -- say so.
    const weak = target.kind === "text";
    return {
      outcome: weak ? `${target.label} (plain text, not a control)` : target.label,
      done: false,
      weak,
    };
  }

  return undefined;
}

// Text of the dialog the app is showing, or the whole page when there is none: the
// question to answer is almost always inside a modal raised by the previous step.
async function inAppQuestion(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const dialogs = Array.from(
        document.querySelectorAll("[role=dialog],dialog,[class*='dialog'],[class*='modal']"),
      ) as HTMLElement[];
      const open = dialogs.filter((d) => d.offsetParent !== null || d.getClientRects().length > 0);
      // Innermost open dialog holds the prompt; outer ones are just backdrops
      const inner = open.length ? open[open.length - 1] : null;
      return (inner?.innerText ?? document.body?.innerText ?? "").trim();
    })
    .catch(() => "");
}

/** Solves the arithmetic captchas mini apps use ("5 + 3 = ?"). */
export function solveArithmetic(text: string): string | undefined {
  const m = text.match(/(-?\d+)\s*([+\-*x×÷/])\s*(-?\d+)\s*(?:=\s*[?？]?|[?？])/);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case "+": return String(a + b);
    case "-": return String(a - b);
    case "*": case "x": case "×": return String(a * b);
    default: return b === 0 ? undefined : String(a / b);
  }
}

// Types an answer into the app's visible input, preferring one inside the open dialog.
async function fillInAppAnswer(page: Page, answer: string): Promise<boolean> {
  const ok = await page
    .evaluate(() => {
      const fields = Array.from(
        document.querySelectorAll("input:not([type=hidden]),textarea"),
      ) as HTMLInputElement[];
      const usable = fields.filter(
        (f) =>
          !f.disabled &&
          !f.readOnly &&
          !["checkbox", "radio", "submit", "button"].includes(f.type) &&
          (f.offsetParent !== null || f.getClientRects().length > 0),
      );
      // The last visible field is the one the newest dialog raised
      const target = usable.filter((f) => !f.value).pop() ?? usable.pop();
      if (!target) return false;
      target.setAttribute("data-cf-input", "1");
      return true;
    })
    .catch(() => false);
  if (!ok) return false;
  await clickElement(page, "[data-cf-input='1']");
  await typeIntoFocused(page, answer);
  await page
    .evaluate(() => document.querySelector("[data-cf-input]")?.removeAttribute("data-cf-input"))
    .catch(() => {});
  return true;
}

/**
 * Runs the configured in-app steps in order, letting the app settle between them so
 * each step can render what the next one needs (press checkin, answer its captcha,
 * confirm). Stops at the first step that cannot be carried out, and reports how far
 * it got. `ok` is false when a step the caller asked for could not be carried out,
 * so a page where nothing was pressed is not mistaken for a completed checkin.
 */
/**
 * `delay(2500)` (or `delay(2.5s)`) as a step: wait before the next one runs, for an app
 * that needs a moment to settle. Returns null for anything that is not a delay step.
 */
export function parseDelayStep(step: string | undefined): number | null {
  const m = /^delay\(\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*\)$/i.exec(step?.trim() ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2]?.toLowerCase() === "s" ? n * 1000 : n);
}

/**
 * `{aiBtn}`, or `{aiBtn:the checkin button}` to say which one. Returns null for anything
 * that is not an AI-button step.
 */
export function parseAiBtnStep(step: string | undefined): { hint?: string } | null {
  const m = /^\{\s*aibtn\s*(?::([\s\S]*))?\}$/i.exec(step?.trim() ?? "");
  if (!m) return null;
  const hint = m[1]?.trim();
  return hint ? { hint } : {};
}

/**
 * `{turnstile}` ticks the Cloudflare Turnstile checkbox where it sits, the same way the
 * `web_turnstile` page step does, and passes when the app raised no challenge at all. A
 * trailing `?` is accepted and means nothing: the step is already forgiving.
 * Returns false for anything that is not a Turnstile step.
 */
export function parseTurnstileStep(step: string | undefined): boolean {
  return /^\{\s*turnstile\s*\??\s*\}$/i.test(step?.trim() ?? "");
}

/**
 * `scroll(500)` moves down 500px; `scroll(120, 500)` moves both axes, and the named forms
 * (`scroll(y=500)`, `scroll(x:-120)`) move one. Negative figures scroll back. Returns null
 * for anything that is not a scroll step.
 */
export type ScrollStep = { x: number; y: number } | { selector: string };

/** Whether a parsed scroll step names an element rather than a distance. */
export function isScrollToSelector(s: ScrollStep): s is { selector: string } {
  return "selector" in s;
}

export function parseScrollStep(step: string | undefined): ScrollStep | null {
  const m = /^scroll\(([^)]*)\)$/i.exec(step?.trim() ?? "");
  if (!m) return null;

  // `scroll(css:#reply)` scrolls to an element instead of by a distance. Written with the
  // same `css:` prefix the other in-app steps use for a selector, so there is one way to
  // say "this exact element" throughout the vocabulary. A selector may contain a comma,
  // so this is settled before the argument is split on one.
  const inner = m[1].trim();
  const named = /^css\s*:\s*(.+)$/is.exec(inner);
  if (named) {
    const selector = named[1].trim();
    return selector ? { selector } : null;
  }

  const parts = m[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const bare: number[] = [];
  let x: number | undefined;
  let y: number | undefined;
  for (const part of parts) {
    const named = /^([xy])\s*[=:]\s*(-?\d+(?:\.\d+)?)$/i.exec(part);
    if (named) {
      const n = Math.round(Number(named[2]));
      if (named[1].toLowerCase() === "x") x = n;
      else y = n;
      continue;
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(part)) return null;
    bare.push(Math.round(Number(part)));
  }
  // Bare figures are positional, and cannot be mixed with named axes: `scroll(x=10, 20)`
  // reads either way, so it is rejected rather than guessed at.
  if (bare.length) {
    if (x !== undefined || y !== undefined) return null;
    // A lone figure is the vertical move, which is what a scroll almost always means
    if (bare.length === 1) y = bare[0];
    else if (bare.length === 2) [x, y] = bare;
    else return null;
  }
  return { x: x ?? 0, y: y ?? 0 };
}

/**
 * Scrolls the page by `x`/`y` pixels, clamped to the content: a figure past the end simply
 * lands at the end, which is how "scroll all the way down" is written.
 *
 * Picking *what* to scroll is the whole difficulty. Mini Apps pin the document
 * (`body { position: fixed; overflow: hidden }`) and scroll a container inside it, and they
 * commonly keep the other tabs mounted as hidden panes -- each a full-viewport box with a
 * scroll extent of its own. Choosing by size alone lands on one of those: the numbers in the
 * log look like a real scroll while nothing on screen has moved. So the target is taken from
 * what is actually painted at the centre of the viewport, walking up to the nearest
 * scrollable ancestor -- which is what a wheel there would have moved.
 */
async function scrollPageBy(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number; maxX: number; maxY: number; what: string } | null> {
  return await page
    .evaluate(
      ({ dx, dy }: { dx: number; dy: number }) => {
        // Hung off an object, not bound to names: see the note in `findInAppCheckin`. Named
        // here, the dev server's loader rewrites them into calls to a helper the page does
        // not have, and every scroll step reports that nothing on the page scrolls.
        const fn = {} as {
          isDoc: (el: Element) => boolean;
          scrollable: (el: Element) => boolean;
          underCentre: () => Element | null;
          largestOnScreen: () => Element | null;
        };

        fn.isDoc = (el) =>
          el === document.scrollingElement ||
          el === document.documentElement ||
          el === document.body;

        // The document scrolls on its own extent; anything else needs an overflow that
        // actually clips, or its scrollTop goes nowhere.
        fn.scrollable = (el) => {
          if (el.scrollHeight - el.clientHeight <= 1 && el.scrollWidth - el.clientWidth <= 1) {
            return false;
          }
          if (fn.isDoc(el)) return true;
          const style = getComputedStyle(el);
          return /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflowX}`);
        };

        // Whatever is painted at the middle of the screen, then up to the first ancestor
        // that scrolls. On an ordinary page this walk ends at the document.
        fn.underCentre = () => {
          let el = document.elementFromPoint(
            Math.floor(window.innerWidth / 2),
            Math.floor(window.innerHeight / 2),
          );
          while (el) {
            if (fn.scrollable(el)) return el;
            el = el.parentElement;
          }
          return null;
        };

        // Nothing under the centre (an overlay, a gap): the biggest scroller that is on
        // screen. Hidden panes are skipped, which is the point.
        fn.largestOnScreen = () => {
          let best: Element | null = null;
          let bestArea = 0;
          for (const el of Array.from(document.querySelectorAll("*"))) {
            if (!fn.scrollable(el)) continue;
            if (typeof (el as any).checkVisibility === "function" && !(el as any).checkVisibility())
              continue;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
          return best;
        };

        const doc = document.scrollingElement ?? document.documentElement;
        const target =
          fn.underCentre() ?? fn.largestOnScreen() ?? (fn.scrollable(doc) ? doc : null);
        if (!target) return null;

        const maxX = Math.max(0, target.scrollWidth - target.clientWidth);
        const maxY = Math.max(0, target.scrollHeight - target.clientHeight);
        target.scrollLeft = Math.min(Math.max(0, target.scrollLeft + dx), maxX);
        target.scrollTop = Math.min(Math.max(0, target.scrollTop + dy), maxY);

        // Named in the log: "scrolled 1071px" reads the same whether the right thing moved
        // or a hidden pane did, and telling those apart is the whole game here.
        const cls = String((target as HTMLElement).className ?? "")
          .split(/\s+/)
          .filter(Boolean)[0];
        return {
          x: Math.round(target.scrollLeft),
          y: Math.round(target.scrollTop),
          maxX: Math.round(maxX),
          maxY: Math.round(maxY),
          what: fn.isDoc(target)
            ? "the page"
            : `${target.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`,
        };
      },
      { dx: x, dy: y },
    )
    .catch(() => null);
}

/**
 * Carries out a scroll step and says where the page ended up, naming any axis that came to
 * rest against the end so a log can tell "moved 800px" from "there was nothing left to
 * move". Null means nothing on the page scrolls at all.
 */
/**
 * Brings the element a selector names into view, wherever it sits.
 *
 * Better than a distance whenever the target has one: a page whose length changes with its
 * content -- a thread with more replies today than yesterday -- puts the thing being scrolled
 * to somewhere different every run, and a fixed number of pixels lands somewhere arbitrary.
 * `scrollIntoView` also handles a target inside a scrollable panel rather than the page.
 *
 * Waits for the element, since the usual reason one is not there yet is that the page is
 * still filling in. Returns what happened, or null when it never appeared.
 */
async function scrollToSelector(
  page: Page,
  selector: string,
  waitMs: number,
  deadline: number,
): Promise<string | null> {
  const tune = cfTuning();
  const until = Math.min(Date.now() + Math.max(0, waitMs), deadline);
  for (;;) {
    const moved = await page
      .evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const before = { x: scrollX, y: scrollY };
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const box = el.getBoundingClientRect();
        return {
          from: before,
          to: { x: Math.round(scrollX), y: Math.round(scrollY) },
          // Where it ended up on screen, which is what the next step acts on
          at: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
          visible: box.width > 0 && box.height > 0,
        };
      }, selector)
      .catch(() => null);

    if (moved) {
      const shifted = moved.from.x !== moved.to.x || moved.from.y !== moved.to.y;
      return (
        `scrolled to \`${selector}\`` +
        (shifted ? `, page now at ${moved.to.x},${moved.to.y}` : " (already in view)") +
        (moved.visible ? `, centre ${moved.at.x},${moved.at.y}` : " -- but it has no box on screen")
      );
    }
    if (Date.now() >= until) return null;
    await sleep(Math.min(tune.readyPollMs, Math.max(50, until - Date.now())), until);
  }
}

async function scrollOutcome(page: Page, x: number, y: number): Promise<string | null> {
  const moved = await scrollPageBy(page, x, y);
  if (!moved) return null;
  const ends = [
    x !== 0 && moved.x === (x > 0 ? moved.maxX : 0) ? "x" : "",
    y !== 0 && moved.y === (y > 0 ? moved.maxY : 0) ? "y" : "",
  ]
    .filter(Boolean)
    .join("/");
  return `scrolled ${moved.what} to ${moved.x},${moved.y}${ends ? ` (${ends} at the end)` : ""}`;
}

async function runInAppClicks(
  page: Page,
  steps: string[],
  deadline: number,
  solveQuestion?: (question: string) => Promise<string>,
  aiLocate?: (image: string, prompt: string) => Promise<string>,
): Promise<{ trace?: string; ok: boolean; failure?: string; acted: boolean }> {
  const tune = cfTuning();
  const done: string[] = [];
  let failure: string | undefined;
  // Whether a step actually did something to the app. Waiting and scrolling are how a step
  // gets ready to act, not acting: counting them would let a page that rendered nothing
  // report a completed checkin on the strength of a delay.
  let acted = false;

  for (const step of steps.length ? steps : [undefined]) {
    if (msLeft(deadline) <= 0) {
      failure = "ran out of time before the in-app steps finished";
      break;
    }
    const pause = parseDelayStep(step);
    if (pause !== null) {
      // Bounded by the action budget, so a long delay cannot outlive it
      await sleep(pause, deadline);
      done.push(`waited ${pause}ms`);
      continue;
    }

    // Brings a control below the fold into view so the step after this one can press it.
    // A page with nothing to scroll is not a failure -- the app may already fit on screen,
    // and the step that wanted the control will say so itself.
    const scroll = parseScrollStep(step);
    if (scroll) {
      if (isScrollToSelector(scroll)) {
        const outcome = await scrollToSelector(page, scroll.selector, 5_000, deadline);
        done.push(outcome ?? `scroll(css:${scroll.selector}) found nothing to scroll to`);
      } else {
        const outcome = await scrollOutcome(page, scroll.x, scroll.y);
        done.push(outcome ?? `scroll(${scroll.x}, ${scroll.y}) found nothing that scrolls`);
      }
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    // Ticks a Turnstile checkbox mid-sequence. A challenge sitting on the page when the app
    // opens is already worked before these steps run, and again after them; this is for the
    // one an app raises between two steps of its own flow.
    if (parseTurnstileStep(step)) {
      const tick = await tickTurnstile(page, deadline);
      if (tick.failure) {
        failure = `{turnstile}: ${tick.failure}`;
        break;
      }
      // Deliberately not counted as having acted: ticking a checkbox is what makes the
      // checkin possible, not the checkin itself.
      done.push(`{turnstile} ${tick.outcome}`);
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    // Same machinery as the `ai_web_button` page step: outline every control, number it,
    // and let the model pick from the picture rather than guess at coordinates.
    const aiBtn = parseAiBtnStep(step);
    if (aiBtn) {
      if (!aiLocate) {
        failure = "{aiBtn} needs an AI model, and none is configured";
        break;
      }
      const marks = await markWebElements(page, CLICKABLE_SELECTOR, MAX_WEB_MARKS);
      if (!marks.length) {
        await clearWebMarkBadges(page);
        failure = "{aiBtn} found no control to press in the app";
        break;
      }
      const marked = await screenshotOf(page, 60);
      await clearWebMarkBadges(page);
      if (!marked) {
        failure = "{aiBtn} could not capture the app page for the AI";
        break;
      }
      const prompt = buildWebAiPrompt({ type: "ai_web_button", hint: aiBtn.hint }, marks, false);
      const reply = await aiLocate(marked, prompt).catch((err: any) => {
        throw new Error(`{aiBtn} could not reach the AI: ${err?.message ?? err}`);
      });
      const { mark } = parseWebAiReply(reply ?? "");
      const chosen = mark ? marks.find((m) => m.n === mark) : undefined;
      if (!chosen) {
        done.push(`{aiBtn} chose nothing usable`);
        failure = `{aiBtn}: the AI named no control on the page (replied "${oneLine(reply)}")`;
        break;
      }
      const what = chosen.text ? `<${chosen.tag}> "${chosen.text}"` : `<${chosen.tag}>`;
      if (!(await clickElement(page, `[data-bemby-mark='${mark}']`))) {
        failure = `{aiBtn}: ${what} has no on-screen box to press`;
        break;
      }
      done.push(`{aiBtn} pressed ${what}`);
      acted = true;
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    if (step === "{input}" || step === "{aiInput}") {
      const question = await inAppQuestion(page);
      let answer: string | undefined;
      if (step === "{input}") {
        answer = solveArithmetic(question);
      } else if (solveQuestion) {
        answer = (await solveQuestion(question).catch(() => undefined))?.trim();
      }
      if (!answer) {
        done.push(`${step} unanswered`);
        failure = `${step} could not be answered`;
        break;
      }
      if (!(await fillInAppAnswer(page, answer))) {
        done.push(`${step} has no field to fill`);
        failure = `${step} found no input to fill`;
        break;
      }
      done.push(`${step}="${answer}"`);
      acted = true;
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    // What the page reads now, so a click on something inert can be told from a real one
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const click = await clickInAppControl(page, step);
    if (!click) {
      // A label that never appears is worth reporting: the app may have changed
      if (step) done.push(`"${step}" not found`);
      const alts = step ? parseLabelAlternatives(step) : [];
      failure =
        alts.length > 1
          ? `none of ${alts.map((a) => `"${a}"`).join(", ")} are on the app page`
          : step
            ? `"${step}" is not on the app page`
            : "no checkin control was found in the app";
      break;
    }
    done.push(click.outcome);
    acted = true;
    await sleep(tune.inAppStepMs, deadline);

    // Pressing plain text is a guess. If the app did not react to it, nothing happened,
    // and reporting success would log a checkin that was never made.
    if (click.weak) {
      const after = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (after === before) {
        failure =
          `pressed "${click.outcome}" but it is not a control and the app did not react` +
          " -- name the control exactly, or give a CSS selector (css:...)";
        break;
      }
    }
    if (click.done) break;
  }

  // Let the last step's request round-trip before the page text is scraped
  if (done.length) await sleep(tune.inAppSettleMs, deadline);
  return { trace: done.length ? done.join(" → ") : undefined, ok: !failure, failure, acted };
}

// ── Driving a plain web page (the `open_url` action) ──────────────────────────
//
// The sub-steps either name their element with a CSS selector, or hand a screenshot to the
// vision model and let it choose. For the latter the page is marked up first: every
// candidate element is outlined and numbered, and the model replies with a number rather
// than a pixel position. Models are poor at reporting exact coordinates but good at
// reading a labelled picture, and a marker resolves back to the element's own box, so the
// press lands on something real and the log can say what was pressed.

/** Ceiling on screenshots kept for one action, so a long step list cannot bloat the log. */
const MAX_WEB_SHOTS = 24;

/** Ceiling on markers offered to the model: past this the picture is unreadable anyway. */
const MAX_WEB_MARKS = 60;

/**
 * Ceiling on the pictures one step keeps of what the model was shown, and on their size
 * together. Job logs are JSON in SQLite, so a step that took twenty close-ups keeps the
 * first few of them and no more.
 */
const MAX_WEB_AI_IMAGES = 6;
const MAX_WEB_AI_IMAGE_CHARS = 1_500_000;

/** Spacing of the ruler drawn over the whole page for `ai_web_click_xy`, in CSS pixels. */
const WEB_GRID_PX = 100;

/** Ceiling on positions one `ai_web_click_xy_multi` will click, however many the AI lists. */
const MAX_WEB_POINTS = 20;

/**
 * Side of the close-up the second pass looks at, and the ruler drawn on it.
 *
 * One look at a full page puts a small target tens of pixels out -- enough to miss a 22px
 * Turnstile checkbox -- because the model is judging a fraction of a wide picture. The
 * same judgement over a window this size is off by a few pixels instead.
 */
const WEB_REFINE_PX = 320;
const WEB_REFINE_GRID_PX = 20;

/**
 * The ruler drawn over a captcha panel the wide pass zooms into, and the padding kept
 * around the panel so its own edges stay in the shot.
 *
 * A picture captcha's tiles are around 70px on a page ruled every 100px, which is roughly
 * one gridline per tile: reading a tile centre off that is a toss-up between neighbours.
 */
const WEB_PANEL_GRID_PX = 20;
const WEB_PANEL_PAD_PX = 12;

/**
 * Frames a challenge draws itself in. Matched on `src` and on `title`, because hCaptcha
 * names its challenge frame in the title and serves it from more than one host.
 */
const CAPTCHA_PANEL_SELECTOR = [
  "iframe[src*='hcaptcha.com']",
  "iframe[title*='hCaptcha']",
  "iframe[title*='hcaptcha']",
  "iframe[src*='recaptcha']",
  "iframe[title*='recaptcha']",
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='arkoselabs']",
  "iframe[src*='funcaptcha']",
].join(",");

/** Elements a press can land on. */
const CLICKABLE_SELECTOR =
  "a[href],button,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab]," +
  "input[type=submit],input[type=button],input[type=checkbox],input[type=radio]," +
  "select,summary,label,[onclick]";

/** Elements text can be typed into. */
const TYPEABLE_SELECTOR =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox])" +
  ":not([type=radio]),textarea,[contenteditable=true],[contenteditable='']";

type WebMark = { n: number; tag: string; kind: string; text: string };

/**
 * Outlines and numbers every visible candidate element, and leaves a `data-bemby-mark`
 * attribute on each so a reply naming a number can be resolved back to the element.
 *
 * Only what is inside the viewport is marked, because that is all the screenshot shows;
 * offering the model a marker it cannot see is how it ends up picking at random.
 */
async function markWebElements(page: Page, selector: string, limit: number): Promise<WebMark[]> {
  return page
    .evaluate(
      ({ sel, max }: { sel: string; max: number }) => {
        for (const el of Array.from(document.querySelectorAll("[data-bemby-mark]")))
          el.removeAttribute("data-bemby-mark");
        for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();

        const out: { n: number; tag: string; kind: string; text: string }[] = [];
        let n = 0;
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const el = node as HTMLElement & { disabled?: boolean; value?: string; name?: string };
          if (el.disabled) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          if (Number(cs.opacity) < 0.05) continue;

          n++;
          el.setAttribute("data-bemby-mark", String(n));

          const ring = document.createElement("div");
          ring.className = "__bemby_mark";
          ring.style.cssText =
            "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #e11d48;" +
            `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
          const badge = document.createElement("div");
          badge.className = "__bemby_mark";
          badge.textContent = String(n);
          badge.style.cssText =
            "position:fixed;pointer-events:none;z-index:2147483647;background:#e11d48;color:#fff;" +
            "font:bold 12px/1.1 monospace;padding:2px 4px;border-radius:3px;" +
            `left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 14)}px`;
          document.body.appendChild(ring);
          document.body.appendChild(badge);

          const label =
            (el.innerText || el.value || el.getAttribute("placeholder") || "").trim() ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.name ||
            "";
          out.push({
            n,
            tag: el.tagName.toLowerCase(),
            kind: el.getAttribute("type") ?? "",
            text: label.replace(/\s+/g, " ").slice(0, 60),
          });
          if (n >= max) break;
        }
        return out;
      },
      { sel: selector, max: limit },
    )
    .catch(() => [] as WebMark[]);
}

/**
 * Rules the page with a labelled grid, for the step that asks for a position rather than a
 * marker. A model reads a coordinate off visible gridlines far better than it estimates one
 * from a bare picture, and the lines come off again before anything is clicked.
 *
 * Drawn at the top of the z order, not one below it. A captcha panel sits in a container of
 * its own at the maximum z-index, and a ruler one short of that is painted *under* the
 * challenge: lines and figures show in the margins around the panel and nowhere on the tiles
 * that needed measuring, which reads as a ruled picture while telling the model nothing. The
 * tie at the maximum goes to whatever came last in the document, which is this overlay.
 *
 * Figures go on every line only while they fit. At a 20px spacing three digits per line run
 * into each other and there is nothing to say which line owns which number, so only every
 * nth line is labelled -- and those lines are drawn stronger, so a figure can be traced to
 * its own line. Both edges carry the figures, because a tile in the middle of a tall panel
 * is otherwise 400px from the only number that describes it.
 *
 * The overlay carries the same `__bemby_mark` class as the marker badges, so
 * `clearWebMarkBadges` takes both away.
 */
export async function drawWebGrid(page: Page, gap: number, frame?: WebRect): Promise<void> {
  // Deliberately written without an inner helper function. The dev server runs this file
  // through tsx, whose keep-names transform wraps any named function in a `__name` helper
  // that does not exist inside the page -- which throws, and the catch below would hide it.
  const failure = await page
    .evaluate(
      ({ step, box }: { step: number; box: WebRect | null }) => {
        for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();

        // Labels hug the edges of what will actually be captured, not the edges of the
        // page: on the close-up pass the page's own left edge is outside the shot, and a
        // gridline whose figure is off-picture is a gridline the model cannot read
        const view = box ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
        const right = view.x + view.width;
        const bottom = view.y + view.height;
        // One label per 48px of picture at the closest, which is what a three-digit figure
        // in a 10px monospace needs to stand clear of the next one
        const every = Math.max(1, Math.ceil(48 / step));
        const base = "position:fixed;pointer-events:none;z-index:2147483647;";
        const faint = `${base}background:rgba(225,29,72,.22);`;
        const strong = `${base}background:rgba(225,29,72,.55);`;
        const label =
          `${base}color:#e11d48;font:bold 10px/1 monospace;` +
          "background:rgba(255,255,255,.8);padding:1px 2px;";

        let html = "";
        for (let x = Math.ceil(view.x / step) * step; x < right; x += step) {
          if (x <= view.x) continue;
          const named = Math.round(x / step) % every === 0;
          html += `<div style="${named ? strong : faint}left:${x}px;top:${view.y}px;width:1px;height:${view.height}px"></div>`;
          if (!named) continue;
          html += `<div style="${label}left:${x + 2}px;top:${view.y}px">${x}</div>`;
          html += `<div style="${label}left:${x + 2}px;top:${bottom - 12}px">${x}</div>`;
        }
        for (let y = Math.ceil(view.y / step) * step; y < bottom; y += step) {
          if (y <= view.y) continue;
          const named = Math.round(y / step) % every === 0;
          html += `<div style="${named ? strong : faint}left:${view.x}px;top:${y}px;width:${view.width}px;height:1px"></div>`;
          if (!named) continue;
          html += `<div style="${label}left:${view.x}px;top:${y + 2}px">${y}</div>`;
          html += `<div style="${label}left:${right - 26}px;top:${y + 2}px">${y}</div>`;
        }

        const holder = document.createElement("div");
        holder.className = "__bemby_mark";
        holder.innerHTML = html;
        document.body.appendChild(holder);
        return holder.childElementCount ? undefined : "the grid drew no lines";
      },
      { step: gap, box: frame ?? null },
    )
    .catch((err: any) => `the grid could not be drawn (${err?.message ?? err})`);
  // A missing ruler is the difference between a click on the target and one tens of pixels
  // off it, so the step fails here rather than asking the model to guess
  if (failure) throw new Error(failure);
}

/** Takes the outlines and numbers off again, leaving the `data-bemby-mark` attributes. */
async function clearWebMarkBadges(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();
    })
    .catch(() => {});
}

/** One line per marker, so the model can match a number in the picture to what it is. */
function describeMarks(marks: WebMark[]): string {
  return marks
    .map((m) => {
      const kind = m.kind ? `${m.tag}[${m.kind}]` : m.tag;
      return `${m.n}: <${kind}>${m.text ? ` "${m.text}"` : " (no label)"}`;
    })
    .join("\n");
}

/**
 * Pulls the marker number and any text out of the model's reply. A JSON object is what is
 * asked for, but models wrap it in prose or fences, and some answer with a bare number --
 * all of which are a usable answer and not worth failing a step over.
 */
export function parseWebAiReply(reply: string): { mark?: number; text?: string } {
  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { mark?: unknown; text?: unknown };
      const mark = Number(parsed.mark);
      return {
        mark: Number.isInteger(mark) && mark > 0 ? mark : undefined,
        text: typeof parsed.text === "string" ? parsed.text : undefined,
      };
    } catch {
      // fall through to the looser reads below
    }
  }
  const keyed = /"?mark"?\s*[:=]\s*(\d+)/i.exec(reply);
  if (keyed) {
    const mark = Number(keyed[1]);
    if (mark > 0) return { mark };
  }
  const bare = /^\D*(\d{1,2})\b/.exec(reply.trim());
  if (bare) {
    const mark = Number(bare[1]);
    if (mark > 0) return { mark };
  }
  return {};
}

/**
 * Pulls a position out of the model's reply. As with the marker reply a JSON object is what
 * is asked for, but a bare "412, 300" is just as usable an answer.
 */
export function parseWebAiPoint(
  reply: string,
): { x: number; y: number; what?: string } | undefined {
  // `Number(null)` and `Number("")` are both 0, so a model answering "not in view" the way
  // it was asked to would otherwise read as a click on the top-left corner of the page
  const ok = (x: unknown, y: unknown) => {
    for (const v of [x, y]) {
      if (v === null || v === undefined || v === "" || typeof v === "boolean") return undefined;
    }
    const px = Number(x);
    const py = Number(y);
    return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : undefined;
  };

  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { x?: unknown; y?: unknown; what?: unknown };
      const point = ok(parsed.x, parsed.y);
      if (point)
        return {
          ...point,
          ...(typeof parsed.what === "string" && parsed.what.trim()
            ? { what: parsed.what.trim().slice(0, 60) }
            : {}),
        };
    } catch {
      // fall through to the looser reads below
    }
  }
  const keyed = /\bx"?\s*[:=]\s*(-?\d+(?:\.\d+)?)[^\d-]+y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(reply);
  if (keyed) return ok(keyed[1], keyed[2]);
  const pair = /(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/.exec(reply);
  if (pair) return ok(pair[1], pair[2]);
  return undefined;
}

/**
 * Pulls a list of positions out of the model's reply, for `ai_web_click_xy_multi`. The
 * order is kept as given: a page that wants its characters clicked in a stated order gets
 * nothing out of the same points in a different one.
 *
 * A reply carrying a single position is a list of one, so a model that answers the
 * one-point way still works.
 */
export function parseWebAiPoints(reply: string): { x: number; y: number; what?: string }[] {
  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { points?: unknown };
      // A `points` list is the answer whether or not it holds anything. It shares the reply
      // with the candidates the model worked through in `seen`, and an empty list falling
      // through to the looser reads below would click every candidate it had just rejected
      if (Array.isArray(parsed.points))
        return parsed.points
          .map((p) => (p && typeof p === "object" ? parseWebAiPoint(JSON.stringify(p)) : undefined))
          .filter((p): p is { x: number; y: number; what?: string } => !!p);
    } catch {
      // fall through to the looser reads below
    }
  }
  // No list came back in one piece: read each `{...}` on its own, which is what a model
  // that answered in prose around its objects leaves behind
  const each = reply.match(/\{[^{}]*\}/g) ?? [];
  const points = each
    .map((one) => parseWebAiPoint(one))
    .filter((p): p is { x: number; y: number; what?: string } => !!p);
  if (points.length) return points;
  // Nor that: a line at a time, which is how a model listing "1. 412, 300" answers
  const listed = reply
    .split(/\r?\n/)
    .map((line) => parseWebAiPoint(line))
    .filter((p): p is { x: number; y: number; what?: string } => !!p);
  return listed;
}

type WebRect = { x: number; y: number; width: number; height: number };

/**
 * One look at the page: rule it, capture it (all of it, or the close-up window), take the
 * ruler off, and ask the model where the target is.
 *
 * Everything here is in CSS pixels, which is what the gridlines are labelled with and what
 * the mouse is aimed in. The screenshot may be larger than that on a scaled display, but
 * the model answers in the figures printed on the picture, so its own pixel count never
 * enters into it.
 */
async function locateWebPoint(
  page: Page,
  aiLocate: (image: string, prompt: string) => Promise<string>,
  prompt: string,
  gap: number,
  clip?: WebRect,
): Promise<{ reply: string; image: string; point?: { x: number; y: number; what?: string } }> {
  const asked = await askAboutWebShot(page, aiLocate, prompt, gap, clip);
  return { ...asked, point: parseWebAiPoint(asked.reply) };
}

/**
 * The look itself: rule the page, capture it, take the ruler off, and ask. The picture goes
 * back with the reply, because a prompt cannot be debugged against a page that has since
 * moved on -- what the model was shown has to be kept as it was shown.
 */
async function askAboutWebShot(
  page: Page,
  aiLocate: (image: string, prompt: string) => Promise<string>,
  prompt: string,
  gap: number,
  clip?: WebRect,
): Promise<{ reply: string; image: string }> {
  await drawWebGrid(page, gap, clip);
  // A close-up is a small picture to begin with, so it is not the place to save bytes:
  // JPEG mush over a 70px captcha tile is the difference between reading it and guessing
  const quality = clip && clip.width * clip.height < 400_000 ? 85 : 60;
  const shot = await screenshotOf(page, quality, clip);
  await clearWebMarkBadges(page);
  if (!shot) throw new Error("the page could not be captured for the AI");
  return { reply: (await aiLocate(shot, prompt)) ?? "", image: shot };
}

/**
 * Keeps a picture the model was shown on the step log, for the debug panel to re-ask with.
 * Bounded twice over: the passes of one step, and the bytes of them together. A step that
 * clicked twenty tiles would otherwise carry twenty-one screenshots into a log row.
 *
 * The wide pass is always the one kept, being the first, and it is the one that chose the
 * positions the close-ups only nudged.
 */
function keepAiImage(log: WebStepLog, image: string | undefined): void {
  if (!image) return;
  const kept = log.aiImages ?? [];
  if (kept.length >= MAX_WEB_AI_IMAGES) return;
  if (kept.reduce((n, one) => n + one.length, 0) + image.length > MAX_WEB_AI_IMAGE_CHARS) return;
  log.aiImages = [...kept, image];
}

/**
 * The challenge panel a picture captcha draws its tiles in, if one is on the page and worth
 * zooming into. Returned padded and clamped to the viewport, in the CSS pixels the grid is
 * labelled with, so an answer read off the zoomed shot needs no arithmetic to click.
 *
 * The biggest visible challenge frame wins, and it has to be tall: a checkbox widget frame
 * is wide and short, and holds nothing worth several clicks. A panel that fills most of the
 * viewport is left alone, because zooming into it buys no resolution and only hides the
 * rest of the page.
 */
async function captchaPanelBox(
  page: Page,
  view: { w: number; h: number },
): Promise<WebRect | undefined> {
  const box = (await page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var best = null;
         var frames = __deepQuery(${JSON.stringify(CAPTCHA_PANEL_SELECTOR)});
         for (var i = 0; i < frames.length; i++) {
           var r = frames[i].getBoundingClientRect();
           if (r.width < 120 || r.height < 180) continue;
           if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
           var cs = getComputedStyle(frames[i]);
           if (cs.visibility === 'hidden' || cs.display === 'none') continue;
           if (Number(cs.opacity) < 0.05) continue;
           if (!best || r.width * r.height > best.width * best.height)
             best = { x: r.x, y: r.y, width: r.width, height: r.height };
         }
         return best;
       })()`,
    )
    .catch(() => null)) as WebRect | null;
  if (!box) return undefined;

  const x = Math.max(0, Math.round(box.x - WEB_PANEL_PAD_PX));
  const y = Math.max(0, Math.round(box.y - WEB_PANEL_PAD_PX));
  const width = Math.min(view.w - x, Math.round(box.width + WEB_PANEL_PAD_PX * 2));
  const height = Math.min(view.h - y, Math.round(box.height + WEB_PANEL_PAD_PX * 2));
  if (width < 120 || height < 180) return undefined;
  if (width * height > view.w * view.h * 0.55) return undefined;
  return { x, y, width, height };
}

/**
 * One log entry per AI pass, each headed by which pass it was -- the first included, so the
 * log reader can split the passes back apart and debug one of them on its own.
 */
function joinAiPasses(parts: string[], labels: string[]): string {
  return parts.map((part, i) => `--- ${labels[i] ?? `pass ${i + 1}`} ---\n\n${part}`).join("\n\n");
}

/**
 * How far a close-up may move a wide answer: one cell of the ruler that answer was read
 * off, and never less than 30px. A jump bigger than the grid is not a correction of the
 * position, it is a different target -- the neighbouring tile that shares the close-up
 * window -- and taking it clicks something the wide pass never chose.
 */
function refineShiftLimit(wideGap: number): number {
  return Math.max(wideGap, 30);
}

/** The close-up window around a first guess, kept inside the page. */
function refineWindow(at: { x: number; y: number }, view: { w: number; h: number }): WebRect {
  const width = Math.min(WEB_REFINE_PX, view.w);
  const height = Math.min(WEB_REFINE_PX, view.h);
  return {
    x: Math.round(Math.min(Math.max(at.x - width / 2, 0), view.w - width)),
    y: Math.round(Math.min(Math.max(at.y - height / 2, 0), view.h - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Rings the position that was just clicked, so the screenshot kept for the step shows where
 * the pointer went rather than only what the page did about it. Green, to read apart from
 * the red measuring grid. Taken off again once that screenshot is captured.
 */
async function markClickPoint(
  page: Page,
  x: number,
  y: number,
  what = "clicked",
): Promise<void> {
  await page
    .evaluate(
      ({ px, py, label }: { px: number; py: number; label: string }) => {
        const base = "position:fixed;pointer-events:none;z-index:2147483647;";
        const hair = `${base}background:#22c55e;box-shadow:0 0 0 1px rgba(255,255,255,.9);`;
        const holder = document.createElement("div");
        holder.className = "__bemby_mark";
        holder.innerHTML =
          `<div style="${base}left:${px - 13}px;top:${py - 13}px;width:26px;height:26px;` +
          `border:2px solid #22c55e;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.9),inset 0 0 0 1px rgba(255,255,255,.9)"></div>` +
          `<div style="${hair}left:${px - 24}px;top:${py}px;width:48px;height:1px"></div>` +
          `<div style="${hair}left:${px}px;top:${py - 24}px;width:1px;height:48px"></div>` +
          `<div style="${base}left:${px + 16}px;top:${py + 16}px;color:#fff;background:#22c55e;` +
          `font:bold 11px/1.2 monospace;padding:2px 4px;border-radius:3px">${label} ${px},${py}</div>`;
        document.body.appendChild(holder);
      },
      { px: x, py: y, label: what },
    )
    .catch(() => {});
}

/** What is painted at a position, so the log can say what the click landed on. */
async function describePoint(page: Page, x: number, y: number): Promise<string> {
  return page
    .evaluate(
      ({ px, py }: { px: number; py: number }) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null;
        if (!el) return "nothing";
        const text = (el.innerText || el.getAttribute("aria-label") || el.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        return text ? `<${el.tagName.toLowerCase()}> "${text}"` : `<${el.tagName.toLowerCase()}>`;
      },
      { px: x, py: y },
    )
    .catch(() => "something the page would not name");
}

/**
 * Types into whatever the last click focused, keystroke by keystroke.
 *
 * Deliberately not `page.type(selector, ...)`: that first waits for the element to pass
 * Playwright's actionability checks, which settle off animation-frame callbacks the
 * browser throttles when it believes its window is occluded -- exactly the state a
 * challenge page under Xvfb tends to be in. Keyboard events go to the focused element
 * regardless, which is what a person's typing does too.
 */
async function typeIntoFocused(page: Page, text: string): Promise<boolean> {
  let failed = false;
  await page.keyboard.type(text, { delay: 60 }).catch(() => {
    failed = true;
  });
  return !failed;
}

/** Types into the element carrying `data-bemby-mark=n`, or a plain CSS selector. */
async function typeInto(page: Page, selector: string, text: string): Promise<boolean> {
  if (!(await clickElement(page, selector))) return false;
  // Replace rather than append: a field a previous attempt filled would otherwise
  // end up with both values concatenated
  await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      if (el.isContentEditable) el.textContent = "";
      else if (typeof el.value === "string") el.value = "";
    }, selector)
    .catch(() => {});
  return typeIntoFocused(page, text);
}

/** How a person writes a modifier, against the one name the browser answers to. */
const KEY_MODIFIERS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  win: "Meta",
  super: "Meta",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
};

/** The same for the key itself, for the ones that go by more than one name. */
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/**
 * Turns a key as a person writes it into the one spelling the browser takes: `ctrl + enter`,
 * `Ctrl+Enter` and `Control+Enter` all mean the same press, and only the last of them works
 * unaided. Spacing and case are free, `+` separates the modifiers from the key.
 *
 * A single character is left exactly as it was typed -- `a` and `A` are different presses,
 * and the shifted one is how a capital is asked for. Anything else the tables do not know is
 * passed through untouched, so a key name they have never heard of still reaches the browser
 * (which says so plainly enough when it is wrong).
 */
export function normaliseKey(key: string): string {
  const parts = key
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return key.trim();

  const pressed = parts.pop() as string;
  const modifiers = parts.map((m) => KEY_MODIFIERS[m.toLowerCase()] ?? m);
  const named =
    [...pressed].length === 1 ? pressed : (KEY_NAMES[pressed.toLowerCase()] ?? pressed);
  return [...modifiers, named].join("+");
}

export type WebStepHooks = {
  /**
   * Hands a screenshot and a prompt to the vision model and returns its reply. Supplied by
   * the caller so the browser side stays clear of AI credentials and settings.
   */
  aiLocate?: (image: string, prompt: string) => Promise<string>;
  /**
   * Values a `web_collect` with `skipUsed` should leave out, and where one is recorded once
   * the loop has been through it. Supplied by the caller for the same reason: what a job has
   * already worked through lives in the database, which this side does not touch.
   */
  usedValues?: (varName: string) => string[];
  markUsed?: (varName: string, value: string) => void;
  /**
   * Sends a message from the middle of a run. Supplied by the caller for the same reason as
   * the rest: the bot token and the chat to send to live in the settings, which this side
   * does not read. Absent, a `web_notify` step says so rather than passing silently.
   */
  notify?: (text: string, target?: string) => Promise<void>;
  /**
   * Reads a verification code out of a mailbox, for a `web_email_code` step. Supplied by the
   * caller for the same reason as the rest: the app password is a stored secret, which this
   * side does not read. Absent, the step says so rather than passing silently.
   */
  emailCode?: (query: {
    email: string;
    /** As written in the config, e.g. `{gmailAppPassword}`; resolved by the caller. */
    appPasswordRef: string;
    fromContains?: string;
    subjectContains?: string;
    pattern?: string;
    waitMs: number;
  }) => Promise<{ code: string; subject: string; from: string; mailbox?: string } | null>;
  /**
   * Works any Cloudflare challenge standing on the page right now, or returns null when
   * there is none. Called after a `web_goto`, since a fresh navigation is exactly what
   * raises one mid-run.
   */
  solveChallenge?: () => Promise<boolean | null>;
  /** Stops the list where it stands when the job is cancelled. */
  signal?: AbortSignal;
};

/** State one `runWebSteps` call carries through its steps, loops included. */
type WebStepRun = {
  logs: WebStepLog[];
  deadline: number;
  hooks: WebStepHooks;
  tune: ReturnType<typeof cfTuning>;
  /** What each name is holding for the round in progress. Cleared between rounds. */
  current: Map<string, string>;
  /** Lists a `web_collect` put together, for a `web_for_each` to work through. */
  lists: Map<string, string[]>;
  /** What a `web_pick` chose this round, for the loop to remember once the round is clean. */
  picked: Map<string, string>;
  /** `name value` for everything picked so far this run, so no two rounds coincide. */
  taken: Set<string>;
  /** Names whose `web_pick` asked for chosen values to be remembered. */
  remember: Set<string>;
  /** The round in progress, e.g. `2/5`, which a pick sharpens with the value it chose. */
  round?: string;
  /** Set when a pick finds the page holds nothing new: the loop stops rather than failing. */
  exhausted: boolean;
  /** Screenshots kept so far, so a loop's rounds cannot fill a job log with images. */
  shots: number;
};

/** A hard ceiling on the candidates one `web_pick` or `web_collect` reads off a page. */
const MAX_COLLECTED = 200;

/** Characters of page text a `web_read` keeps when it is not told a length. */
const WEB_READ_CHARS = 1000;

/**
 * Replaces `{name}` with the value of the round, for every loop currently running. A name
 * no loop is holding is left as it stands: a page step may well want a literal brace, and
 * `expandCommand`'s placeholders are spelled the same way.
 */
export function fillVars(text: string, vars: Map<string, string>): string {
  if (!text || !vars.size) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars.get(name) ?? whole);
}

/**
 * The same, for a field holding something a person wrote rather than a selector: the round's
 * values first, then the random tokens every other template in Bemby takes -- `{word:10}`,
 * `{num:6}`, `{alpha:8}`, `{uuid}` -- so a signup form can be given an address of its own.
 * One pass, with the round's names taking precedence, and anything neither knows left alone.
 */
export function fillContent(text: string, vars: Map<string, string>): string {
  if (!text) return text;
  return expandCommand(text, Object.fromEntries(vars));
}

/**
 * Where a data step is pointed, with the round's names filled in, and how to say so in the
 * log. Shared by the three of them so a reference reads the same whether it was read, written
 * or removed -- and so the switch in Settings is checked in one place.
 */
function dataTarget(
  step: { folder?: string; key?: string; path?: string },
  run: WebStepRun,
): { folder: string; key: string; path: string; label: string } {
  if (!isDataStoreEnabled()) throw new Error(dataStoreOffReason());
  const folder = fillVars(step.folder ?? "", run.current).trim();
  const key = fillVars(step.key ?? "", run.current).trim();
  const path = fillVars(step.path ?? "", run.current).trim();
  if (!folder) throw new Error("no data folder given");
  if (!key) throw new Error("no record key given");
  // The label is the reference a person would write for it, brackets and all
  return { folder, key, path, label: dataRefText(folder, key, path).slice(1, -1) };
}

/**
 * Turns what a `web_pick` read off the page into the candidates it may choose from:
 * narrowed to the part that matters, de-duplicated, and minus what has already been used.
 * Kept out of the step body because this is where a mis-configured pick goes wrong, and
 * none of it needs a browser to try.
 *
 * Throws for the cases worth stopping on: nothing matched the selector at all, the
 * expression cannot be compiled, or it described none of what was found. An empty list with
 * everything skipped is not one of them -- that is a page with nothing new on it, which the
 * pick reports and the loop stops on.
 */
/**
 * Drops the candidates that do not read `containsText`, which is how a list is narrowed by
 * what something is called while still taking its address. CSS has no way to ask about text,
 * so without this a selector can only reach "every post", never "the giveaway ones".
 *
 * An empty needle keeps everything. A needle that matches nothing is an error rather than an
 * empty list: silently picking from nothing would look like a page that had not loaded.
 */
export function keepMatchingText(
  collected: Array<{ value: string; text: string }>,
  containsText: string,
  selector: string,
): string[] {
  if (!containsText) return collected.map((c) => c.value);
  const needle = containsText.toLowerCase();
  const kept = collected.filter((c) => c.text.toLowerCase().includes(needle));
  if (!kept.length && collected.length) {
    throw new Error(
      `${collected.length} element(s) matched \`${selector}\`, but none of them read ` +
        `"${containsText}"`,
    );
  }
  return kept.map((c) => c.value);
}

/**
 * Everything a selector matches, as what each element is worth and what it reads -- both raw.
 * The text filter and the regular expression are far easier to get right in Node than
 * serialised into the page, so this only reads. Shared by `web_pick` and `web_collect`.
 */
async function readCandidates(
  page: Page,
  selector: string,
  attribute: string | undefined,
): Promise<Array<{ value: string; text: string }>> {
  return page
    .evaluate(
      (arg: { sel: string; attr: string; cap: number }) =>
        Array.from(document.querySelectorAll(arg.sel))
          .slice(0, arg.cap)
          .map((el) => {
            const value = arg.attr ? el.getAttribute(arg.attr) : (el as HTMLElement).innerText;
            return {
              value: (value ?? "").trim(),
              text: ((el as HTMLElement).innerText ?? "").trim(),
            };
          }),
      { sel: selector, attr: attribute?.trim() ?? "", cap: MAX_COLLECTED },
    )
    .catch(() => [] as Array<{ value: string; text: string }>);
}

export function narrowCollected(
  raw: string[],
  opts: { selector: string; pattern?: string; used?: string[] },
): { values: string[]; found: number; skipped: number } {
  if (!raw.length) throw new Error(`nothing matching \`${opts.selector}\` is on the page`);

  const source = opts.pattern?.trim();
  let pattern: RegExp | undefined;
  if (source) {
    try {
      pattern = new RegExp(source);
    } catch {
      throw new Error(`\`${source}\` is not a valid regular expression`);
    }
  }

  const seen = new Set<string>();
  const found: string[] = [];
  for (const value of raw) {
    let kept = value.trim();
    if (pattern) {
      const m = pattern.exec(kept);
      // A value the expression does not describe is not what was asked for: a list page
      // carries plenty of links that are not posts
      if (!m) continue;
      kept = (m[1] ?? m[0]).trim();
    }
    if (!kept || seen.has(kept)) continue;
    seen.add(kept);
    found.push(kept);
  }
  if (!found.length)
    throw new Error(
      pattern
        ? `${raw.length} element(s) matched \`${opts.selector}\`, but none of them matched \`${source}\``
        : `${raw.length} element(s) matched \`${opts.selector}\`, but all of them read empty`,
    );

  let values = found;
  let skipped = 0;
  if (opts.used?.length) {
    const used = new Set(opts.used);
    values = values.filter((v) => !used.has(v));
    skipped = found.length - values.length;
  }

  return { values, found: found.length, skipped };
}

/**
 * Runs the `open_url` sub-steps against the loaded page, capturing the page after each
 * one. Stops at the first step that cannot be carried out: the steps are usually a
 * sequence (type a name, type a password, press login), so carrying on past a failure
 * acts on a page that is not in the state the rest of them assume.
 */
export async function runWebSteps(
  page: Page,
  steps: WebStep[],
  deadline: number,
  hooks: WebStepHooks,
): Promise<{ logs: WebStepLog[]; ok: boolean; failure?: string }> {
  const run: WebStepRun = {
    logs: [],
    deadline,
    hooks,
    tune: cfTuning(),
    current: new Map(),
    lists: new Map(),
    picked: new Map(),
    taken: new Set(),
    remember: new Set(),
    exhausted: false,
    shots: 0,
  };
  const failure = await runStepList(page, steps, run, { depth: 0, inLoop: false });
  // Let the last step's request round-trip before the page text is read
  if (run.logs.length) await sleep(run.tune.inAppSettleMs, deadline);
  return { logs: run.logs, ok: !failure, failure };
}

/** How deep containers may go, so a config cannot nest itself into something unreadable. */
const MAX_WEB_DEPTH = 3;

/** Where in the nesting a list of steps sits, which decides what may appear in it. */
type WebStepNest = {
  /** Containers enclosing this list. */
  depth: number;
  /** Whether one of them is a loop, which is what stops a loop going inside a loop. */
  inLoop: boolean;
};

/**
 * Works through one list of steps, appending to the shared log. Called again for a branch of
 * a `web_if` and for each round of a `web_repeat`; `nest` is what keeps that nesting in
 * bounds.
 *
 * Returns the failure that stopped it, or undefined when every step got through.
 */
async function runStepList(
  page: Page,
  steps: WebStep[],
  run: WebStepRun,
  nest: WebStepNest,
): Promise<string | undefined> {
  const { deadline, tune, hooks } = run;

  for (const step of steps) {
    if (hooks.signal?.aborted) return "cancelled before the page steps finished";
    if (msLeft(deadline) <= 0) return "ran out of time before the page steps finished";
    // A pick that found nothing new ends the round: the steps after it have no value to
    // work with, and the loop is about to stop anyway
    if (run.exhausted) return undefined;

    const log: WebStepLog = {
      type: step.type,
      label: describeWebStep(step, run),
      ...(run.round ? { iteration: run.round } : {}),
    };
    run.logs.push(log);
    // Set when a step leaves something drawn on the page for its own screenshot to show
    let marked = false;
    // A loop or a branch only holds other steps: what it runs does the waiting and
    // capturing itself
    const container =
      step.type === "web_repeat" || step.type === "web_for_each" || step.type === "web_if";

    // A challenge raised by the previous step (a login press is exactly what raises one)
    // leaves nothing of the site on screen for this one to act on
    if (!container && step.type !== "web_delay" && (await interstitialOnPage(page))) {
      log.error = "a full-page Cloudflare challenge is covering the site";
      log.screenshot = await screenshotOf(page);
      return `${log.label}: ${log.error}`;
    }

    try {
      switch (step.type) {
        case "web_button": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          if (!(await clickElement(page, selector)))
            throw new Error(`nothing matching \`${selector}\` is on the page`);
          log.outcome = `pressed \`${selector}\``;
          break;
        }

        case "web_input": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const text = fillContent(step.text, run.current);
          if (!(await typeInto(page, selector, text)))
            throw new Error(`nothing matching \`${selector}\` could be typed into`);
          log.outcome = `typed ${maskForLog(text, selector)} into \`${selector}\``;
          break;
        }

        case "web_delay": {
          const ms = Math.max(0, step.waitMs || 0);
          await sleep(ms, deadline);
          log.outcome = `waited ${Math.round(ms / 1000)}s`;
          break;
        }

        case "web_scroll": {
          const x = Math.round(step.x || 0);
          const y = Math.round(step.y || 0);
          if (!x && !y) throw new Error("no distance to scroll was given");
          // A page with nothing to scroll is not a failure: it may already fit on screen,
          // and the step that wanted the element will say so itself.
          log.outcome = (await scrollOutcome(page, x, y)) ?? "nothing on the page scrolls";
          break;
        }

        case "web_scroll_to": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 5_000;
          const outcome = await scrollToSelector(page, selector, waitMs, deadline);
          if (!outcome) throw new Error(`nothing matching \`${selector}\` appeared to scroll to`);
          log.outcome = outcome;
          break;
        }

        case "web_wait_element": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 30_000;
          const until = Math.min(Date.now() + waitMs, deadline);
          let seen = false;
          for (;;) {
            seen = await page
              .evaluate((sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }, selector)
              .catch(() => false);
            if (seen || Date.now() >= until) break;
            // Nothing the site owns is on an interstitial, so waiting out the rest of the
            // timeout only delays the real answer -- and buries it under a step error
            // about a selector that was never going to appear.
            if (await interstitialOnPage(page)) {
              throw new Error(
                `a full-page Cloudflare challenge took over before \`${selector}\` appeared`,
              );
            }
            await sleep(Math.min(tune.readyPollMs, Math.max(50, until - Date.now())), until);
          }
          if (!seen)
            throw new Error(
              `\`${selector}\` did not appear within ${Math.round(waitMs / 1000)}s`,
            );
          log.outcome = `\`${selector}\` appeared`;
          break;
        }

        case "web_turnstile": {
          const tick = await tickTurnstile(page, deadline);
          if (tick.failure) throw new Error(tick.failure);
          log.outcome = tick.outcome;
          break;
        }

        case "web_pick": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold the chosen value under");

          const collected = await readCandidates(page, selector, step.attribute);

          const raw = keepMatchingText(
            collected,
            fillVars(step.containsText ?? "", run.current).trim(),
            selector,
          );

          if (step.skipUsed) run.remember.add(name);
          else run.remember.delete(name);

          // Earlier rounds of this run count as used too, not just earlier runs: a value is
          // only written to the store once its round finishes, so without this two rounds in
          // a row would pick the same post, and a round that keeps failing would be retried
          // to the last one. Both halves hang off `skipUsed`, which is the one switch for
          // "do not pick this again" -- a pick without it is free to find the same thing
          // every round, which is what one naming a control on the page does.
          const used = step.skipUsed
            ? [
                ...(hooks.usedValues?.(name) ?? []),
                ...[...run.taken]
                  .filter((k) => k.startsWith(`${name} `))
                  .map((k) => k.slice(name.length + 1)),
              ]
            : undefined;
          const { values, found, skipped } = narrowCollected(raw, {
            selector,
            pattern: step.pattern,
            used,
          });

          if (!values.length) {
            // Nothing new on the page is a quiet end to the loop, not a failure: it is what
            // a job that has already replied to everything on the front page should look like
            run.exhausted = true;
            log.outcome = `nothing left to pick: all ${found} value(s) on the page have been used`;
            break;
          }

          const value =
            (step.choose ?? "first") === "random"
              ? values[Math.floor(Math.random() * values.length)]
              : values[0];
          run.current.set(name, value);
          run.picked.set(name, value);
          if (step.skipUsed) run.taken.add(`${name} ${value}`);
          // Sharpen the round's label, so every step after this one says which post it is on
          if (run.round) run.round = `${run.round.split(" ")[0]} ${value}`;

          log.outcome =
            `picked ${value} for {${name}}, out of ${values.length} to choose from` +
            (skipped ? ` (${skipped} of ${found} already used)` : "");
          break;
        }

        case "web_collect": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold the list under");

          const collected = await readCandidates(page, selector, step.attribute);
          const raw = keepMatchingText(
            collected,
            fillVars(step.containsText ?? "", run.current).trim(),
            selector,
          );

          // The loop marks a value used once the round holding it finishes cleanly, so what
          // to remember is decided here and read there
          if (step.skipUsed) run.remember.add(name);
          else run.remember.delete(name);

          const { values, found, skipped } = narrowCollected(raw, {
            selector,
            pattern: step.pattern,
            used: step.skipUsed ? (hooks.usedValues?.(name) ?? []) : undefined,
          });

          const limit = Math.floor(step.limit || 0);
          const kept = limit > 0 ? values.slice(0, limit) : values;
          run.lists.set(name, kept);

          // Nothing new is not a failure: it is what a job that has already been through
          // everything on the page looks like, and the loop over it simply runs no rounds
          log.outcome = kept.length
            ? `collected ${kept.length} value(s) into {${name}}` +
              (skipped ? ` (${skipped} of ${found} already used)` : "") +
              (limit > 0 && values.length > limit ? `, capped at ${limit}` : "") +
              `: ${kept.slice(0, 5).join(", ")}${kept.length > 5 ? " ..." : ""}`
            : `nothing left to collect into {${name}}: all ${found} value(s) on the page have been used`;
          break;
        }

        case "web_for_each": {
          if (nest.inLoop) throw new Error("a loop cannot be put inside another loop");
          if (nest.depth >= MAX_WEB_DEPTH)
            throw new Error(`steps cannot be nested more than ${MAX_WEB_DEPTH} deep`);
          const inner = step.steps ?? [];
          if (!inner.length) throw new Error("the loop has no steps to run");
          const name = step.varName.trim();
          if (!name) throw new Error("no list name given to work through");
          const list = run.lists.get(name);
          if (!list)
            throw new Error(
              `nothing has been collected into {${name}} -- put a collect step before the loop`,
            );

          const max = Math.floor(step.max || 0);
          const values = max > 0 ? list.slice(0, max) : list;
          const carryOn = step.continueOnError ?? true;
          const between = Math.max(0, step.betweenMs || 0);
          let done = 0;
          const failures: string[] = [];
          // As in a repeat: what was set before the loop is still there in every round
          const outer = new Map(run.current);

          for (let n = 1; n <= values.length; n++) {
            if (msLeft(deadline) <= 0) {
              failures.push(`ran out of time after ${done} of ${values.length}`);
              break;
            }
            const value = values[n - 1];
            // Each round starts clean but for the value it is on, so nothing a previous one
            // read is still standing when this one fills a field in
            run.current = new Map(outer);
            run.picked.clear();
            run.current.set(name, value);
            run.picked.set(name, value);
            run.round = `${n}/${values.length} ${value}`;
            const roundFailure = await runStepList(page, inner, run, {
              depth: nest.depth + 1,
              inLoop: true,
            });
            const label = run.round;
            run.round = undefined;

            // A `web_pick` inside the round saying the page holds nothing new ends the loop,
            // the same as it does in a repeat: the rounds after it have nothing to work on
            if (run.exhausted) break;
            if (roundFailure) {
              failures.push(`${label}: ${roundFailure}`);
              if (!carryOn) break;
            } else {
              done++;
              // Only a clean round counts as used, the same rule the repeat loop follows: a
              // round that fell over halfway may not have got as far as doing anything
              for (const [pickedName, pickedValue] of run.picked)
                if (run.remember.has(pickedName)) hooks.markUsed?.(pickedName, pickedValue);
            }
            if (between && n < values.length) await sleep(between, deadline);
          }
          run.current = new Map(outer);
          run.picked.clear();

          if (!values.length) {
            log.outcome = `{${name}} holds nothing to work through`;
            break;
          }
          const summary = `${done} of ${values.length} round(s) got through`;
          if (run.exhausted) {
            log.outcome = `${summary}; nothing left to pick`;
            break;
          }
          if (!done) throw new Error(`${summary} (${failures[0] ?? "no round ran"})`);
          log.outcome = failures.length
            ? `${summary}; ${failures.length} failed (${failures[0]})`
            : summary;
          break;
        }

        case "web_set": {
          const pairs = setVarPairs(step);
          if (!pairs.length) throw new Error("no name given to hold the value under");
          const done: string[] = [];
          for (const pair of pairs) {
            const name = pair.name.trim();
            if (!name) throw new Error("no name given to hold the value under");
            // Drawn once, here: a value settled up front is one later steps can all use, which
            // is the difference between this and putting `{alpha:12}` in the field itself. Each
            // pair is filled against what is set so far, so `{fn}_{ln}` reads the two names
            // this same step has just settled
            const value = fillContent(pair.value ?? "", run.current);
            run.current.set(name, value);
            done.push(`{${name}} = ${oneLine(value).slice(0, 120)}`);
          }
          log.outcome = done.join(", ");
          break;
        }

        case "web_data_read": {
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold what was read under");
          const where = dataTarget(step, run);
          const value = readDataValue(where.folder, where.key, where.path);
          if (value === null) {
            if (!step.optional) throw new Error(`nothing is stored at ${where.label}`);
            log.outcome = `nothing is stored at ${where.label}; carried on`;
            break;
          }
          run.current.set(name, value);
          log.outcome = `{${name}} = ${oneLine(value).slice(0, 120)} (from ${where.label})`;
          break;
        }

        case "web_data_pick": {
          if (!isDataStoreEnabled()) throw new Error(dataStoreOffReason());
          const folder = fillVars(step.folder ?? "", run.current).trim();
          if (!folder) throw new Error("no data folder given");
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold the record's key under");
          const indexText = fillVars(step.index ?? "", run.current).trim() || "0";
          const index = Number(indexText);
          if (!Number.isInteger(index) || index < 0) {
            throw new Error(`\`${indexText}\` is not a position in the folder`);
          }
          const record = recordAt(folder, index);
          if (!record) {
            if (!step.optional) throw new Error(`${folder} holds nothing at position ${index}`);
            log.outcome = `${folder} holds nothing at position ${index}; carried on`;
            break;
          }
          run.current.set(name, record.key);
          const held = [`{${name}} = ${oneLine(record.key).slice(0, 120)}`];
          const valueName = step.valueVar?.trim();
          if (valueName) {
            const path = fillVars(step.path ?? "", run.current).trim();
            const value = path
              ? valueAtPath(record.value, splitDataPath(path))
              : record.value;
            if (value === undefined && !step.optional) {
              throw new Error(`\`${record.key}\` holds nothing at \`${path}\``);
            }
            const text = dataValueToText(value);
            run.current.set(valueName, text);
            held.push(`{${valueName}} = ${oneLine(text).slice(0, 120)}`);
          }
          log.outcome = `${held.join(", ")} (position ${index} of ${folder})`;
          break;
        }

        case "web_data_save": {
          const where = dataTarget(step, run);
          const text = fillContent(step.value ?? "", run.current);
          writeDataValue(where.folder, where.key, where.path, parseDataValue(text));
          log.outcome = `saved ${oneLine(text).slice(0, 120)} to ${where.label}`;
          break;
        }

        case "web_data_delete": {
          const where = dataTarget(step, run);
          const removed = deleteDataValue(where.folder, where.key, where.path);
          if (!removed && !step.optional) throw new Error(`nothing is stored at ${where.label}`);
          log.outcome = removed
            ? `removed ${where.label}`
            : `nothing was stored at ${where.label}; carried on`;
          break;
        }

        case "web_notify": {
          if (!hooks.notify)
            throw new Error("no notification bot is configured (see Settings)");
          const text = fillContent(step.text ?? "", run.current).trim();
          if (!text) throw new Error("no message given to send");
          const target = fillVars(step.target ?? "", run.current).trim();
          await hooks.notify(text, target || undefined);
          log.outcome = `sent ${oneLine(text).slice(0, 160)}${target ? ` to ${target}` : ""}`;
          break;
        }

        case "web_read": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold the text under");

          const text = await page
            .evaluate(
              (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? "",
              selector,
            )
            .catch(() => "");
          const trimmed = text.trim().replace(/\s+\n/g, "\n");
          if (!trimmed)
            throw new Error(`nothing matching \`${selector}\` has any text on the page`);

          const max = step.maxChars && step.maxChars > 0 ? step.maxChars : WEB_READ_CHARS;
          const kept = trimmed.slice(0, max);
          run.current.set(name, kept);
          log.outcome = `read ${kept.length} character(s) into {${name}}: ${oneLine(kept).slice(0, 120)}`;
          break;
        }

        case "web_email_code": {
          if (!hooks.emailCode)
            throw new Error("reading a mailbox is not available here");
          const name = step.varName.trim();
          if (!name) throw new Error("no name given to hold the code under");
          const email = fillVars(step.email ?? "", run.current).trim();
          if (!email) throw new Error("no mailbox given to read");
          // Only a `{name}` reference: a password pasted in here would sit in the config,
          // in every export of it, and in anything the template is shared with -- which is
          // the whole reason the value lives in the secrets store instead
          const ref = (step.appPassword ?? "").trim();
          if (!ref) throw new Error("no app-password secret named");
          if (!/^\{\w+\}$/.test(ref))
            throw new Error(
              "the app password must name a secret, e.g. `{gmailAppPassword}`, not the password itself",
            );

          // Capped at what is left of the action's budget: waiting for mail past the
          // deadline only means the steps after it have no time to use the code
          const asked = step.waitMs && step.waitMs > 0 ? step.waitMs : EMAIL_CODE_WAIT_MS;
          const waitMs = Math.max(0, Math.min(asked, msLeft(deadline)));
          const found = await hooks.emailCode({
            email,
            appPasswordRef: ref,
            fromContains: fillVars(step.fromContains ?? "", run.current).trim() || undefined,
            subjectContains:
              fillVars(step.subjectContains ?? "", run.current).trim() || undefined,
            pattern: step.pattern?.trim() || undefined,
            waitMs,
          });
          if (!found)
            throw new Error(
              `no matching mail reached ${email} within ${Math.round(waitMs / 1000)}s`,
            );
          run.current.set(name, found.code);
          // Where it was found is worth saying when it was not the inbox: a code the
          // provider files as spam is the difference between a step that is slow and one
          // that is about to stop working
          const where =
            found.mailbox && found.mailbox !== "INBOX" ? `, in ${found.mailbox}` : "";
          log.outcome = `{${name}} = ${found.code} (from ${oneLine(found.from)}${where})`;
          break;
        }

        case "web_if": {
          if (nest.depth >= MAX_WEB_DEPTH)
            throw new Error(`conditions cannot be nested more than ${MAX_WEB_DEPTH} deep`);

          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 5_000;
          const selector = fillVars(step.selector ?? "", run.current).trim();
          const wanted = fillVars(step.text ?? "", run.current).trim();

          let look: () => Promise<boolean>;
          let what: string;
          if (step.check === "element") {
            if (!selector) throw new Error("no CSS selector given to look for");
            what = `\`${selector}\``;
            // Same test as `web_wait_element`: a hidden login form is not a login form
            look = () =>
              page
                .evaluate((sel: string) => {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (!el) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }, selector)
                .catch(() => false);
          } else if (step.check === "text") {
            if (!wanted) throw new Error("no words given to look for");
            what = `"${wanted}" in the page text`;
            look = () =>
              page
                .evaluate(() => document.body?.innerText ?? "")
                .then((body: string) => body.toLowerCase().includes(wanted.toLowerCase()))
                .catch(() => false);
          } else {
            if (!wanted) throw new Error("no words given to look for");
            what = `"${wanted}" in the address`;
            look = async () => page.url().toLowerCase().includes(wanted.toLowerCase());
          }

          // Held open for the whole wait: something the page has yet to draw is the case this
          // wait exists for, and calling it absent too early takes the wrong branch
          const until = Math.min(Date.now() + waitMs, deadline);
          let met = false;
          for (;;) {
            met = await look();
            if (met || Date.now() >= until) break;
            await sleep(Math.min(tune.readyPollMs, Math.max(50, until - Date.now())), until);
          }

          const took = step.negate ? !met : met;
          const branch = took ? (step.then ?? []) : (step.otherwise ?? []);
          const which = took ? "then" : "else";
          const saw = met ? `${what} is there` : `${what} is not there`;

          if (!branch.length) {
            log.outcome = `${saw}, and there are no ${which} steps to run`;
            break;
          }

          log.outcome = `${saw}, running the ${branch.length} ${which} step(s)`;
          const branchFailure = await runStepList(page, branch, run, {
            depth: nest.depth + 1,
            inLoop: nest.inLoop,
          });
          if (branchFailure) throw new Error(branchFailure);
          break;
        }

        case "web_repeat": {
          if (nest.inLoop) throw new Error("a loop cannot be put inside another loop");
          if (nest.depth >= MAX_WEB_DEPTH)
            throw new Error(`steps cannot be nested more than ${MAX_WEB_DEPTH} deep`);
          const inner = step.steps ?? [];
          if (!inner.length) throw new Error("the loop has no steps to run");
          const times = Math.floor(step.times || 0);
          if (times < 1) throw new Error("no number of rounds given");

          const carryOn = step.continueOnError ?? true;
          const between = Math.max(0, step.betweenMs || 0);
          let done = 0;
          const failures: string[] = [];
          // What was set before the loop stays set inside it -- a username settled up front
          // is still `{username}` in round three -- while what a round reads is its own
          const outer = new Map(run.current);

          for (let n = 1; n <= times; n++) {
            if (msLeft(deadline) <= 0) {
              failures.push(`ran out of time after ${done} of ${times}`);
              break;
            }
            // Each round starts clean: it loads the list itself and picks its own value
            run.current = new Map(outer);
            run.picked.clear();
            run.round = `${n}/${times}`;
            const roundFailure = await runStepList(page, inner, run, {
              depth: nest.depth + 1,
              inLoop: true,
            });
            const label = run.round;
            run.round = undefined;

            if (run.exhausted) break;
            if (roundFailure) {
              failures.push(`${label}: ${roundFailure}`);
              if (!carryOn) break;
            } else {
              done++;
              // Only a clean round counts as used. A round that fell over halfway may not
              // have got as far as doing anything, and the post is worth another go.
              for (const [pickedName, value] of run.picked)
                if (run.remember.has(pickedName)) hooks.markUsed?.(pickedName, value);
            }
            if (between && n < times) await sleep(between, deadline);
          }
          run.current = new Map(outer);
          run.picked.clear();

          const summary = `${done} of ${times} round(s) got through`;
          if (run.exhausted) {
            log.outcome = `${summary}; nothing left to pick`;
            break;
          }
          if (!done) throw new Error(`${summary} (${failures[0] ?? "no round ran"})`);
          log.outcome = failures.length
            ? `${summary}; ${failures.length} failed (${failures[0]})`
            : summary;
          break;
        }

        case "web_goto": {
          const url = fillContent(step.url, run.current).trim();
          if (!url) throw new Error("no address given");
          if (!/^https?:\/\//i.test(url))
            throw new Error(`the address must start with http:// or https:// (got "${url}")`);
          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 30_000;
          const from = page.url();

          let navError: string | undefined;
          await page
            .goto(url, {
              waitUntil: "domcontentloaded",
              timeout: Math.max(5_000, capped(waitMs, deadline)),
            })
            .catch((err: any) => {
              navError = err?.message ?? String(err);
            });
          // A page that never moved is a genuine failure; one that moved and merely took
          // an odd route there (a challenge redirect aborts the first load) is not
          if (navError && page.url() === from)
            throw new Error(`could not open ${url} (${navError})`);
          await waitForPageReady(page, Math.min(Date.now() + waitMs, deadline));

          // Navigating is what makes a site raise a challenge, so it is worked here rather
          // than left for the steps that follow to run into
          if ((await run.hooks.solveChallenge?.()) === false)
            throw new Error("a Cloudflare challenge on the new page could not be passed");

          log.outcome =
            `opened ${page.url()}` + (navError ? ` (navigation warning: ${navError})` : "");
          break;
        }

        case "web_back": {
          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 30_000;
          const from = page.url();
          let navError: string | undefined;
          await page
            .goBack({
              waitUntil: "domcontentloaded",
              timeout: Math.max(5_000, capped(waitMs, deadline)),
            })
            .catch((err: any) => {
              navError = err?.message ?? String(err);
            });
          if (page.url() === from)
            throw new Error(
              navError
                ? `could not go back (${navError})`
                : "there was no previous page to go back to",
            );
          await waitForPageReady(page, Math.min(Date.now() + waitMs, deadline));
          if ((await run.hooks.solveChallenge?.()) === false)
            throw new Error("a Cloudflare challenge on the previous page could not be passed");
          log.outcome = `went back to ${page.url()}`;
          break;
        }

        case "web_hold": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const at = await elementCentre(page, selector);
          if (!at) throw new Error(`nothing matching \`${selector}\` is on the page`);
          const ms = step.holdMs && step.holdMs > 0 ? step.holdMs : 1_000;

          // Approach as a pointer would, then keep it down. The release is in a `finally`:
          // a button left held would sit under every step that follows.
          await page.mouse.move(at.x - 6, at.y + 4);
          await page.mouse.move(at.x, at.y);
          await page.mouse.down();
          try {
            await sleep(Math.min(ms, Math.max(0, msLeft(deadline))), deadline);
          } finally {
            await page.mouse.up().catch(() => {});
          }
          log.outcome = `held \`${selector}\` down for ${(ms / 1000).toFixed(1)}s`;
          break;
        }

        case "web_hold_offset": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given for the anchor");
          const box = await elementBox(page, selector);
          if (!box) throw new Error(`nothing matching \`${selector}\` is on the page`);

          const dx = Math.round(step.x || 0);
          const dy = Math.round(step.y || 0);
          const origin =
            step.from === "topLeft"
              ? { x: box.x, y: box.y }
              : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const x = Math.round(origin.x + dx);
          const y = Math.round(origin.y + dy);

          // A point off the page cannot be pressed, and Playwright's own error for it says
          // nothing about the offset that put it there
          const view = await page
            .evaluate(() => ({ w: innerWidth, h: innerHeight }))
            .catch(() => ({ w: 0, h: 0 }));
          if (view.w && (x < 0 || y < 0 || x > view.w || y > view.h))
            throw new Error(
              `the offset lands at ${x},${y}, which is off a ${view.w}×${view.h} page ` +
                `(the anchor is ${Math.round(box.width)}×${Math.round(box.height)} at ` +
                `${Math.round(box.x)},${Math.round(box.y)})`,
            );

          const ms = step.holdMs && step.holdMs > 0 ? step.holdMs : 1_000;
          // What sits there, read before the press: a control that swaps itself out on
          // being held would otherwise be logged as whatever replaced it
          const under = await describePoint(page, x, y);

          // Approach as a pointer would, then keep it down. The release is in a `finally`:
          // a button left held would sit under every step that follows.
          await page.mouse.move(x - 6, y + 4);
          await page.mouse.move(x, y);
          await page.mouse.down();
          try {
            await sleep(Math.min(ms, Math.max(0, msLeft(deadline))), deadline);
          } finally {
            await page.mouse.up().catch(() => {});
          }

          // Drawn for this step's screenshot alone, so the offset can be corrected by
          // looking at where it actually landed
          await markClickPoint(page, x, y, "held");
          marked = true;

          const anchoredAt = step.from === "topLeft" ? "top-left" : "centre";
          log.outcome =
            `held ${x},${y} for ${(ms / 1000).toFixed(1)}s -- ${dx},${dy} from the ` +
            `${anchoredAt} of \`${selector}\`, on ${under}`;
          break;
        }

        case "web_drag": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const from = await elementCentre(page, selector);
          if (!from) throw new Error(`nothing matching \`${selector}\` is on the page`);

          const toSelector = fillVars(step.toSelector ?? "", run.current).trim();
          let to: { x: number; y: number };
          let where: string;
          if (toSelector) {
            const target = await elementCentre(page, toSelector);
            if (!target) throw new Error(`nothing matching \`${toSelector}\` is on the page`);
            to = target;
            where = `onto \`${toSelector}\``;
          } else {
            const dx = Math.round(step.x || 0);
            const dy = Math.round(step.y || 0);
            if (!dx && !dy)
              throw new Error("no drop target and no distance to drag were given");
            to = { x: from.x + dx, y: from.y + dy };
            where = `by ${dx},${dy}px`;
          }

          const ms = step.durationMs && step.durationMs > 0 ? step.durationMs : 600;
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          try {
            await glideTo(page, from, to, ms, deadline);
          } finally {
            await page.mouse.up().catch(() => {});
          }
          log.outcome = `dragged \`${selector}\` ${where}`;
          break;
        }

        case "web_press": {
          const key = normaliseKey(fillVars(step.key ?? "", run.current));
          if (!key) throw new Error("no key given to press");
          const selector = fillVars(step.selector ?? "", run.current).trim();
          const timeout = Math.max(1_000, capped(5_000, deadline));
          let pressError: string | undefined;
          if (selector) {
            await page.press(selector, key, { timeout }).catch((err: any) => {
              pressError = err?.message ?? String(err);
            });
          } else {
            await page.keyboard.press(key).catch((err: any) => {
              pressError = err?.message ?? String(err);
            });
          }
          if (pressError)
            throw new Error(
              selector
                ? `\`${key}\` could not be pressed on \`${selector}\` (${oneLine(pressError)})`
                : `\`${key}\` could not be pressed (${oneLine(pressError)})`,
            );
          log.outcome = selector ? `pressed ${key} on \`${selector}\`` : `pressed ${key}`;
          break;
        }

        case "web_select": {
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          const option = fillVars(step.option ?? "", run.current).trim();
          if (!option) throw new Error("no option given to choose");
          const timeout = Math.max(1_000, capped(5_000, deadline));
          const choose = (arg: { label: string } | { value: string }) =>
            page.selectOption(selector, arg, { timeout }).catch(() => [] as string[]);
          // A dropdown is written either way round -- the label is what a person reads, the
          // value what the form sends -- so whichever of them matches is taken
          let picked = await choose({ label: option });
          if (!picked.length) picked = await choose({ value: option });
          if (!picked.length)
            throw new Error(`\`${selector}\` has no option reading "${option}"`);
          log.outcome = `chose "${option}" in \`${selector}\``;
          break;
        }

        case "web_ai_input": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const selector = fillVars(step.selector, run.current).trim();
          if (!selector) throw new Error("no CSS selector given");
          // The hint takes the round's values, so a reply can be asked for in terms of the
          // post a `web_read` put in `{postText}` rather than left to a screenshot
          const hint = fillVars(step.hint ?? "", run.current).trim();
          if (!hint) throw new Error("nothing was said about what to write");

          const shot = await screenshotOf(page, 60);
          if (!shot) throw new Error("the page could not be captured for the AI");
          const prompt = buildWebWritePrompt(hint);
          log.aiPrompt = prompt;
          keepAiImage(log, shot);
          const reply = await hooks.aiLocate(shot, prompt);
          log.aiResponse = reply;

          const written = parseWebAiText(reply ?? "");
          if (!written)
            throw new Error(`the AI wrote nothing usable (replied "${oneLine(reply)}")`);
          const max = step.maxChars && step.maxChars > 0 ? step.maxChars : 0;
          const typed = max > 0 ? written.slice(0, max) : written;
          if (!(await typeInto(page, selector, typed)))
            throw new Error(`nothing matching \`${selector}\` could be typed into`);
          const holdAs = step.varName?.trim();
          if (holdAs) run.current.set(holdAs, typed);
          log.outcome =
            `AI wrote ${typed.length} character(s) into \`${selector}\`` +
            (holdAs ? ` and into {${holdAs}}` : "") +
            `: ${oneLine(typed).slice(0, 120)}`;
          break;
        }

        case "ai_web_button":
        case "ai_web_input": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const wantInput = step.type === "ai_web_input";
          const marks = await markWebElements(
            page,
            wantInput ? TYPEABLE_SELECTOR : CLICKABLE_SELECTOR,
            MAX_WEB_MARKS,
          );
          if (!marks.length) {
            await clearWebMarkBadges(page);
            throw new Error(
              wantInput
                ? "no field to type into is visible on the page"
                : "no control to press is visible on the page",
            );
          }
          // The model is shown the marked-up page; the clean shot is kept for the log
          const marked = await screenshotOf(page, 60);
          await clearWebMarkBadges(page);
          if (!marked) throw new Error("the page could not be captured for the AI");

          const wantText = wantInput && !step.text?.trim();
          // A hint takes the round's values, so it can hand the model the post being replied
          // to as text -- what a `web_read` put in `{postText}` -- rather than leaving it to
          // make the wording out in a screenshot of the page
          const prompt = buildWebAiPrompt(
            { ...step, hint: fillVars(step.hint ?? "", run.current) },
            marks,
            wantText,
          );
          log.aiPrompt = prompt;
          keepAiImage(log, marked);
          const reply = await hooks.aiLocate(marked, prompt);
          log.aiResponse = reply;

          const { mark, text: aiText } = parseWebAiReply(reply ?? "");
          if (!mark) throw new Error(`the AI named no usable marker (replied "${oneLine(reply)}")`);
          const chosen = marks.find((m) => m.n === mark);
          if (!chosen) throw new Error(`the AI chose marker ${mark}, which is not on the page`);

          const selector = `[data-bemby-mark='${mark}']`;
          const what = chosen.text ? `<${chosen.tag}> "${chosen.text}"` : `<${chosen.tag}>`;

          if (!wantInput) {
            if (!(await clickElement(page, selector)))
              throw new Error(`marker ${mark} (${what}) has no on-screen box to press`);
            log.outcome = `AI pressed marker ${mark}, ${what}`;
            break;
          }

          const typed = step.text?.trim() ? fillContent(step.text, run.current) : aiText;
          if (!typed) throw new Error("the AI did not say what to type, and no text was configured");
          if (!(await typeInto(page, selector, typed)))
            throw new Error(`marker ${mark} (${what}) could not be typed into`);
          log.outcome = `AI typed ${maskForLog(typed, `${chosen.text} ${chosen.kind}`)} into marker ${mark}, ${what}`;
          break;
        }

        case "ai_web_click_xy": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const view = await page
            .evaluate(() => ({ w: innerWidth, h: innerHeight }))
            .catch(() => undefined);
          if (!view?.w || !view.h) throw new Error("the page size could not be read");

          // First look: the whole page, ruled coarsely. Enough to say which part of the
          // page the target is in, and reliably a few tens of pixels out on a small one.
          const xyPasses = ["whole-page pass", "close-up pass"];
          const widePrompt = buildWebPointPrompt(step.hint, view, WEB_GRID_PX);
          const wide = await locateWebPoint(page, hooks.aiLocate, widePrompt, WEB_GRID_PX);
          // Logged the moment it comes back, not once the step has worked. A step that fails
          // on this answer is precisely the one whose prompt and picture need reading after
          log.aiPrompt = joinAiPasses([widePrompt], xyPasses);
          log.aiResponse = joinAiPasses([wide.reply], xyPasses);
          keepAiImage(log, wide.image);
          if (!wide.point)
            throw new Error(`the AI named no usable position (replied "${oneLine(wide.reply)}")`);
          if (
            wide.point.x < 0 ||
            wide.point.y < 0 ||
            wide.point.x > view.w ||
            wide.point.y > view.h
          )
            throw new Error(
              `the AI chose ${Math.round(wide.point.x)},${Math.round(wide.point.y)}, which is off a ${view.w}×${view.h} page`,
            );

          // Second look: a close-up around that answer, ruled finely, to correct it. The
          // window is clamped to the page, so a first guess near an edge still gets one.
          const window = refineWindow(wide.point, view);
          const refinePrompt = buildWebRefinePrompt(step.hint, window, WEB_REFINE_GRID_PX);
          const close = await locateWebPoint(
            page,
            hooks.aiLocate,
            refinePrompt,
            WEB_REFINE_GRID_PX,
            window,
          );
          log.aiPrompt = joinAiPasses([widePrompt, refinePrompt], xyPasses);
          log.aiResponse = joinAiPasses([wide.reply, close.reply], xyPasses);
          keepAiImage(log, close.image);

          // A correction outside the window it was shown is not a correction, so the wide
          // answer stands rather than the click going somewhere nobody looked at
          const refined =
            close.point &&
            close.point.x >= window.x &&
            close.point.x <= window.x + window.width &&
            close.point.y >= window.y &&
            close.point.y <= window.y + window.height
              ? close.point
              : undefined;
          const aimed = refined ?? wide.point;
          const x = Math.round(aimed.x);
          const y = Math.round(aimed.y);

          // Read what is there before pressing it: a checkbox that swaps itself for a tick
          // the moment it is clicked would otherwise be logged as whatever replaced it
          const under = await describePoint(page, x, y);

          // Approach then press, as a pointer would -- the same shape as clickElement,
          // except nothing here resolves to an element to aim at
          let pointerFailure: string | undefined;
          await page.mouse.move(x - 8, y + 6).catch((err: any) => {
            pointerFailure = `move: ${err?.message ?? err}`;
          });
          await page.mouse.click(x, y).catch((err: any) => {
            pointerFailure = `click: ${err?.message ?? err}`;
          });
          if (pointerFailure) throw new Error(`the pointer could not be used (${pointerFailure})`);

          // Left on the page just long enough for this step's screenshot to catch it
          await markClickPoint(page, x, y);
          marked = true;

          // Spelled out, because "which pass decided this" is the first thing worth knowing
          // when a click lands somewhere unexpected
          const from = `${Math.round(wide.point.x)},${Math.round(wide.point.y)}`;
          const shift = !refined
            ? `the close-up could not see it, so the wide guess at ${from} stands`
            : x === Math.round(wide.point.x) && y === Math.round(wide.point.y)
              ? "the close-up agreed with the wide guess"
              : `the close-up moved it from ${from}`;
          const called = refined?.what ? `, which the AI called "${refined.what}"` : "";
          log.outcome = `AI clicked ${x},${y}, on ${under}${called} (${shift})`;
          break;
        }

        case "ai_web_click_xy_multi": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const view = await page
            .evaluate(() => ({ w: innerWidth, h: innerHeight }))
            .catch(() => undefined);
          if (!view?.w || !view.h) throw new Error("the page size could not be read");

          const wanted =
            step.max && step.max > 0
              ? Math.min(Math.floor(step.max), MAX_WEB_POINTS)
              : MAX_WEB_POINTS;
          const gapMs = step.gapMs && step.gapMs > 0 ? step.gapMs : 500;
          const refining = step.refine !== false;

          // The wide look goes at the challenge panel alone where there is one, so tiles a
          // 100px ruler cannot separate get a 20px one. Anything the panel shot puts outside
          // the panel is a guess about a part of the page the model was not shown
          const panel = step.zoom === false ? undefined : await captchaPanelBox(page, view);
          const onPage: { x: number; y: number; what?: string }[] = [];
          const prompts: string[] = [];
          const replies: string[] = [];
          // What each pass was, so the log reads as the sequence it was
          const passes: string[] = [];
          // Every pass goes on the log as it happens, rather than once the clicking is done.
          // A step that throws part way -- no usable position, no time left, a pointer that
          // would not press -- is the one whose prompts and pictures are worth reading, and
          // writing them at the end is writing them only when they are least needed
          const notePass = (prompt: string, reply: string, label: string, image?: string) => {
            prompts.push(prompt);
            replies.push(reply);
            passes.push(label);
            keepAiImage(log, image);
            log.aiPrompt = joinAiPasses(prompts, passes);
            log.aiResponse = joinAiPasses(replies, passes);
          };
          let wideGap = WEB_GRID_PX;
          let looked = panel ? "in the captcha panel" : "on the page";
          for (const area of panel ? [panel, undefined] : [undefined]) {
            // One wide look for the lot: a shot per target would show a page the earlier
            // clicks had already changed, and lose the order the first one was read in
            wideGap = area ? WEB_PANEL_GRID_PX : WEB_GRID_PX;
            const widePrompt = buildWebPointsPrompt(step.hint, area ?? view, wideGap, wanted);
            const wide = await askAboutWebShot(page, hooks.aiLocate, widePrompt, wideGap, area);
            const wideReply = wide.reply;
            notePass(
              widePrompt,
              wideReply,
              area ? "captcha panel pass" : "whole-page pass",
              wide.image,
            );
            const box = area ?? { x: 0, y: 0, width: view.w, height: view.h };
            onPage.push(
              ...parseWebAiPoints(wideReply).filter(
                (p) =>
                  p.x >= box.x &&
                  p.y >= box.y &&
                  p.x <= box.x + box.width &&
                  p.y <= box.y + box.height,
              ),
            );
            // A panel look that found nothing is a panel that was the wrong thing to zoom
            // into, so the whole page gets its turn rather than the step failing
            if (onPage.length) break;
            if (area) looked = "on the page, the captcha panel look having found nothing";
          }

          const found = onPage.slice(0, wanted);
          if (!found.length)
            throw new Error(
              `the AI named no usable position (replied "${oneLine(replies[replies.length - 1])}")`,
            );

          const shiftLimit = refineShiftLimit(wideGap);
          const done: string[] = [];
          for (const [i, at] of found.entries()) {
            if (msLeft(deadline) <= 0)
              throw new Error(`ran out of time after ${i} of ${found.length} click(s)`);

            // The close-up asks after this point's own target rather than the step's hint:
            // a window around one tile may well hold another, and "each tile" would let the
            // model correct towards the neighbour
            let aimed = at;
            let moved: string | undefined;
            if (refining) {
              const window = refineWindow(at, view);
              const refinePrompt = buildWebRefinePrompt(
                at.what || step.hint,
                window,
                WEB_REFINE_GRID_PX,
              );
              const close = await locateWebPoint(
                page,
                hooks.aiLocate,
                refinePrompt,
                WEB_REFINE_GRID_PX,
                window,
              );
              notePass(refinePrompt, close.reply, `close-up pass ${i + 1}`, close.image);
              const inside =
                close.point &&
                close.point.x >= window.x &&
                close.point.x <= window.x + window.width &&
                close.point.y >= window.y &&
                close.point.y <= window.y + window.height;
              const shift = close.point
                ? Math.max(Math.abs(close.point.x - at.x), Math.abs(close.point.y - at.y))
                : 0;
              if (inside && close.point && shift > shiftLimit) {
                // Further than the wide ruler could have been misread by: the close-up has
                // picked out a different thing, not a better spot on this one
                moved = `a close-up jump of ${Math.round(shift)}px ignored`;
              } else if (inside && close.point) {
                moved =
                  Math.round(close.point.x) !== Math.round(at.x) ||
                  Math.round(close.point.y) !== Math.round(at.y)
                    ? `moved from ${Math.round(at.x)},${Math.round(at.y)}`
                    : undefined;
                aimed = { ...close.point, what: close.point.what || at.what };
              }
            }

            const x = Math.round(aimed.x);
            const y = Math.round(aimed.y);
            const under = await describePoint(page, x, y);

            let pointerFailure: string | undefined;
            await page.mouse.move(x - 8, y + 6).catch((err: any) => {
              pointerFailure = `move: ${err?.message ?? err}`;
            });
            await page.mouse.click(x, y).catch((err: any) => {
              pointerFailure = `click: ${err?.message ?? err}`;
            });
            if (pointerFailure)
              throw new Error(`the pointer could not be used (${pointerFailure})`);

            // Numbered, so the screenshot shows the order as well as the places
            await markClickPoint(page, x, y, `${i + 1}`);
            marked = true;
            done.push(
              `${i + 1}) ${x},${y} on ${under}` +
                (aimed.what ? `, called "${aimed.what}"` : "") +
                (moved ? ` (${moved})` : ""),
            );

            // The page needs the same moment between presses a person would leave it
            if (i < found.length - 1) await sleep(gapMs, deadline);
          }

          const dropped =
            onPage.length > found.length
              ? `, ${onPage.length - found.length} past the limit ignored`
              : "";
          log.outcome =
            `AI clicked ${done.length} position(s) ${gapMs}ms apart, found ${looked}${dropped}: ` +
            done.join("; ");
          break;
        }
      }
    } catch (err: any) {
      log.error = err?.message ?? String(err);
    }

    if (!container) {
      // The page as it stands after the step, whether it worked or not. A failed step is
      // exactly the one whose screenshot is worth having, so those keep a small allowance
      // of their own past the cap -- a loop's rounds would otherwise spend it all.
      await sleep(tune.inAppStepMs, deadline);
      if (run.shots < MAX_WEB_SHOTS || (log.error && run.shots < MAX_WEB_SHOTS + 8)) {
        log.screenshot = await screenshotOf(page);
        if (log.screenshot) run.shots++;
      }
      if (marked) await clearWebMarkBadges(page);
    }
    if (log.error) return `${log.label}: ${log.error}`;
  }

  return undefined;
}

/**
 * The pairs a `web_set` holds: the list it carries, or the single `varName`/`value` of a
 * config saved before one step could set several names.
 */
function setVarPairs(
  step: Extract<WebStep, { type: "web_set" }>,
): Array<{ name: string; value: string }> {
  if (step.vars?.length) return step.vars;
  return step.varName === undefined ? [] : [{ name: step.varName, value: step.value ?? "" }];
}

/** The reference a data step points at, for the log line, before the step has run. */
function dataLabel(
  step: { folder?: string; key?: string; path?: string },
  fill: (text: string) => string,
): string {
  return dataRefText(
    fill(step.folder?.trim() ?? ""),
    fill(step.key?.trim() ?? ""),
    fill(step.path?.trim() ?? ""),
  ).slice(1, -1);
}

/** What the step is trying to do, for the log line. */
function describeWebStep(step: WebStep, run: WebStepRun): string {
  const fill = (text: string) => fillVars(text, run.current);
  switch (step.type) {
    case "web_button":
      return `Press \`${fill(step.selector)}\``;
    case "web_input":
      return `Type into \`${fill(step.selector)}\``;
    case "web_delay":
      return `Wait ${Math.round((step.waitMs || 0) / 1000)}s`;
    case "web_scroll":
      return `Scroll ${Math.round(step.x || 0)},${Math.round(step.y || 0)}px`;
    case "web_scroll_to":
      return `Scroll to \`${fill(step.selector)}\``;
    case "web_wait_element":
      return `Wait for \`${fill(step.selector)}\``;
    case "web_turnstile":
      return "Press the Turnstile checkbox";
    case "web_pick":
      return (
        `Pick one \`${fill(step.selector)}\`` +
        `${step.attribute?.trim() ? ` [${step.attribute.trim()}]` : ""}` +
        `${step.containsText?.trim() ? ` reading "${fill(step.containsText.trim())}"` : ""}` +
        ` into {${step.varName}}`
      );
    case "web_collect":
      return (
        `Collect every \`${fill(step.selector)}\`` +
        `${step.attribute?.trim() ? ` [${step.attribute.trim()}]` : ""}` +
        `${step.containsText?.trim() ? ` reading "${fill(step.containsText.trim())}"` : ""}` +
        ` into {${step.varName}}`
      );
    case "web_set": {
      const names = setVarPairs(step).map((pair) => `{${pair.name}}`);
      return `Set ${names.join(", ") || "a variable"}`;
    }
    case "web_data_read":
      return `Read ${dataLabel(step, fill)} into {${step.varName}}`;
    case "web_data_pick":
      return (
        `Take record ${fill(step.index ?? "").trim() || "0"} of ` +
        `\`${fill(step.folder ?? "")}\` into {${step.varName}}` +
        `${step.valueVar?.trim() ? ` and {${step.valueVar.trim()}}` : ""}`
      );
    case "web_data_save":
      return `Save to ${dataLabel(step, fill)}`;
    case "web_data_delete":
      return `Remove ${dataLabel(step, fill)}`;
    case "web_notify":
      return `Send a notification${step.target?.trim() ? ` to ${fill(step.target)}` : ""}`;
    case "web_read":
      return `Read \`${fill(step.selector)}\` into {${step.varName}}`;
    case "web_email_code":
      return `Read a code from ${fill(step.email ?? "")} into {${step.varName}}`;
    case "web_repeat":
      return `Repeat ${step.steps?.length ?? 0} step(s) ${Math.floor(step.times || 0)} time(s)`;
    case "web_for_each":
      return `For each {${step.varName}}, run ${step.steps?.length ?? 0} step(s)`;
    case "web_hold":
      return `Press and hold \`${fill(step.selector)}\``;
    case "web_hold_offset":
      return (
        `Press and hold ${Math.round(step.x || 0)},${Math.round(step.y || 0)} from the ` +
        `${step.from === "topLeft" ? "top-left" : "centre"} of \`${fill(step.selector)}\``
      );
    case "web_drag":
      return (
        `Drag \`${fill(step.selector)}\` ` +
        (step.toSelector?.trim()
          ? `onto \`${fill(step.toSelector)}\``
          : `by ${Math.round(step.x || 0)},${Math.round(step.y || 0)}px`)
      );
    case "web_press":
      return (
        `Press ${step.key}` + (step.selector?.trim() ? ` on \`${fill(step.selector)}\`` : "")
      );
    case "web_select":
      return `Choose "${fill(step.option ?? "")}" in \`${fill(step.selector)}\``;
    case "web_ai_input":
      return `AI writes into \`${fill(step.selector)}\`${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "web_if": {
      const what =
        step.check === "element"
          ? `\`${fill(step.selector ?? "")}\``
          : `"${fill(step.text ?? "")}" in the ${step.check === "url" ? "address" : "page text"}`;
      return `If ${what} is ${step.negate ? "not " : ""}there, run ${step.then?.length ?? 0} step(s), else ${step.otherwise?.length ?? 0}`;
    }
    case "web_goto":
      return `Go to ${fill(step.url)}`;
    case "web_back":
      return "Go back";
    case "ai_web_button":
      return `AI presses a control${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "ai_web_input":
      return `AI fills a field${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "ai_web_click_xy":
      return `AI clicks a position${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "ai_web_click_xy_multi":
      return (
        `AI clicks ${step.max && step.max > 0 ? `up to ${Math.floor(step.max)} ` : ""}positions` +
        `${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`
      );
  }
}

/**
 * What to write, for a `web_ai_input`. The field is already named by a selector, so nothing
 * has to be found on the screenshot -- it is there for context, as what the page looks like
 * says a good deal about the register a reply should be in.
 */
export function buildWebWritePrompt(hint: string): string {
  return [
    "The screenshot is a web page. Write the text that belongs in one of its fields.",
    "",
    `What to write: ${hint}`,
    "",
    'Reply with ONLY a JSON object: {"text": "<what to write>"}. Write it as the person using',
    "this page would: no quotes around it, no preamble, no explanation of your answer, and",
    "nothing that reads as though a machine wrote it. No code fences.",
  ].join("\n");
}

/**
 * Pulls the written text out of the model's reply. The JSON object asked for is the good
 * case; a model that simply writes the sentence back is just as usable, so a plain reply is
 * taken as it stands once any code fence around it is off.
 */
export function parseWebAiText(reply: string): string {
  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
    } catch {
      // fall through: a reply that is not JSON is still an answer
    }
  }
  return reply
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function buildWebAiPrompt(
  step: Extract<WebStep, { type: "ai_web_button" | "ai_web_input" }>,
  marks: WebMark[],
  wantText: boolean,
): string {
  const wantInput = step.type === "ai_web_input";
  const hint = step.hint?.trim();
  const noun = wantInput ? "text field" : "control";
  return [
    `The screenshot is a web page. Every ${noun} on it has been outlined in red and given a`,
    `number shown just above it. The numbered ${noun}s are:`,
    "",
    describeMarks(marks),
    "",
    hint
      ? `Choose the one that matches this description: ${hint}`
      : `Read the page and choose the one a person would use next to get through this page.`,
    "",
    wantText
      ? 'Reply with ONLY a JSON object: {"mark": <number>, "text": "<the text to type>"}. ' +
        "Work out the text from the page itself: the answer to a question it asks, the " +
        "characters shown in a captcha image, or whatever the description above asks for -- " +
        "a description can say both which field to use and what belongs in it."
      : 'Reply with ONLY a JSON object: {"mark": <number>}.',
    "No explanation, no code fences.",
  ].join("\n");
}

/** How the step names its target, for a prompt and for the log. */
function webPointTarget(hint: string | undefined): string {
  return hint?.trim() || "the control a person would press next to get through this page";
}

/**
 * The first, wide look. The grid is named so the model reads the figures off the lines
 * rather than estimating a fraction of the picture, and the labels are the coordinate
 * system asked for -- so a display that paints more device pixels than CSS ones cannot put
 * the answer in a different scale from the one the mouse works in.
 */
function buildWebPointPrompt(
  hint: string | undefined,
  view: { w: number; h: number },
  gap: number,
): string {
  return [
    `The screenshot is a web page, ${view.w} by ${view.h}.`,
    `A red grid every ${gap} pixels is drawn over it for measuring, and the figures along`,
    `its edges are the coordinates to answer in.`,
    "",
    `Click this: ${webPointTarget(hint)}`,
    "",
    `Give the position at its centre, not at its edge or the words beside it.`,
    "",
    'Reply with ONLY a JSON object: {"x": <number>, "y": <number>}. No explanation, no code',
    "fences.",
  ].join("\n");
}

/**
 * The wide look for `ai_web_click_xy_multi`, which asks for every match at once rather than
 * one. A cap goes in the prompt as well as being applied to the reply: a model told to find
 * "each tile" with no ceiling will pad its list out with near-misses.
 *
 * Kept short on purpose. The reply is capped at a few hundred tokens, and asking the model to
 * think on paper first -- every candidate named and judged before the answer -- spent the
 * whole allowance on the working out and truncated the list of positions mid-object. Only the
 * positions are asked for now.
 *
 * Order is spelled out because it is often the whole task -- a captcha asking for characters
 * in a stated order is failed by the right positions in the wrong sequence. What is *not* a
 * target is spelled out for a plainer reason: asked for "the pictures matching the
 * instruction", models answer with the example picture printed in the instruction bar, which
 * matches the words better than anything else in the shot does.
 *
 * `area` is the region the screenshot actually covers, which is the panel alone on a zoomed
 * pass; the labels carry page coordinates either way.
 */
function buildWebPointsPrompt(
  hint: string | undefined,
  area: { w: number; h: number } | WebRect,
  gap: number,
  max: number,
): string {
  const zoomed = "x" in area;
  const opening = zoomed
    ? [
        `The screenshot is the part of a web page from x=${area.x} to x=${area.x + area.width},`,
        `y=${area.y} to y=${area.y + area.height} -- the panel holding the challenge.`,
        `A red grid every ${gap} pixels is drawn over it for measuring, and the figures along`,
        `its edges are the page coordinates to answer in.`,
      ]
    : [
        `The screenshot is a web page, ${area.w} by ${area.h}.`,
        `A red grid every ${gap} pixels is drawn over it for measuring, and the figures along`,
        `its edges are the coordinates to answer in.`,
      ];
  return [
    ...opening,
    "",
    `Click these: ${webPointTarget(hint)}`,
    "",
    `Give the centre of each, at most ${max}, in the order they should be clicked. Nothing else`,
    `on the page is a target -- not an instruction, an example picture beside one, a caption or`,
    `a button -- and no two positions may be on the same thing.`,
    "",
    'Reply with ONLY a JSON object: {"points": [{"x": <number>, "y": <number>, "what": "<what',
    'it is>"}, ...]}, or {"points": []} if there is nothing to click. No explanation, no code',
    "fences.",
  ].join("\n");
}

/**
 * The second, close look. The window is small enough that the same eyeballing lands within
 * a few pixels, and the labels still carry page coordinates, so the answer needs no
 * arithmetic against where the window was cut from.
 *
 * It is deliberately not told what the first pass answered. Told, models simply hand the
 * same figure back -- a run of this went out with an identical reply to both passes, and a
 * click 30px under the checkbox -- and a prompt that offers "repeat the earlier position"
 * as a way out gets taken up on it. Asking cold is what makes the second look a second
 * opinion. It has to name what it sees at the position for the same reason: a model that
 * must describe the thing it is pointing at cannot point at nothing.
 */
function buildWebRefinePrompt(hint: string | undefined, window: WebRect, gap: number): string {
  return [
    `The screenshot is the close-up of a web page from x=${window.x} to`,
    `x=${window.x + window.width}, y=${window.y} to y=${window.y + window.height}.`,
    `A red grid every ${gap} pixels is drawn over it for measuring, and the figures along`,
    `its edges are the page coordinates to answer in.`,
    "",
    `Click this: ${webPointTarget(hint)}`,
    "",
    `Give the position at its exact centre -- the middle of the thing itself, not the words`,
    `beside it and not the edge of the panel around it -- and say what is there.`,
    "",
    'Reply with ONLY a JSON object: {"x": <number>, "y": <number>, "what": "<what is there>"},',
    'or {"x": null, "y": null, "what": "not in view"} if it is not in this close-up.',
    "No explanation, no code fences.",
  ].join("\n");
}

/**
 * Renders a typed value for the log, withheld when the field it went into looks like a
 * secret. Judged from the field (its selector, or how the AI described it) rather than the
 * value: a password does not contain the word "password", but the box it goes in usually does.
 */
function maskForLog(text: string, field: string): string {
  if (/pass|pwd|secret|token|otp|credential/i.test(field)) return "*** (hidden)";
  return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
}

function oneLine(text: string | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

/**
 * What a challenge actually looks at: the browser's own account of itself. Read in one
 * page so two installs (a dev machine and the container) can be compared line by line --
 * a missing GL stack or a browser with no fonts is invisible from the outside but reads
 * as automation from Cloudflare's side.
 */
const FINGERPRINT_PROBE = `(function () {
  var out = {};
  try {
    out.ua = navigator.userAgent;
    out.uaData = navigator.userAgentData
      ? navigator.userAgentData.brands.map(function (b) { return b.brand + " " + b.version; }).join(", ")
      : null;
    out.platform = navigator.platform;
    out.languages = (navigator.languages || []).join(",");
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.cores = navigator.hardwareConcurrency;
    out.memoryGb = navigator.deviceMemory || null;
    out.webdriver = navigator.webdriver;
    out.screen = screen.width + "x" + screen.height + "@" + window.devicePixelRatio;
    out.plugins = navigator.plugins.length;
  } catch (e) { out.navError = String(e); }

  // WebGL: a challenge reads the unmasked vendor/renderer. No GL stack at all is a
  // stronger signal than any UA string.
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) {
      out.webgl = "unavailable";
    } else {
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.webgl = dbg
        ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) + " / " + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.VENDOR) + " / " + gl.getParameter(gl.RENDERER);
      out.webglVersion = gl.getParameter(gl.VERSION);
    }
    out.webgl2 = !!c.getContext("webgl2");
  } catch (e) { out.webgl = "error: " + e; }

  // Fonts, without fontconfig: a glyph the browser cannot draw measures the same as a
  // private-use character, so equal widths mean the font is missing (tofu).
  try {
    var cv = document.createElement("canvas").getContext("2d");
    var width = function (text, font) { cv.font = font; return cv.measureText(text).width; };
    var missing = width("\\uE000\\uE000", "16px sans-serif");
    out.latinOk = width("Bemby", "16px sans-serif") !== width("\\uE000\\uE000\\uE000\\uE000\\uE000", "16px sans-serif");
    out.cjkOk = width("\\u7B7E\\u5230", "16px sans-serif") !== missing;
    out.emojiOk = width("\\uD83C\\uDFAF", "16px sans-serif") !== width("\\uE000", "16px sans-serif");
    out.fontFamilies = ["sans-serif", "DejaVu Sans", "FreeSans", "Noto Sans CJK SC", "Noto Color Emoji"]
      .filter(function (f) { return document.fonts.check('16px "' + f + '"'); })
      .join(", ") || "none";
  } catch (e) { out.fontError = String(e); }

  return out;
})()`;

export type BrowserEnvReport = Record<string, unknown>;

/**
 * Reads the probe. `warnings` are things that stop the browser being useful or are a
 * direct automation tell; `notes` are differences worth seeing when comparing two
 * installs but which are not known to fail on their own -- a working setup passes
 * challenges with no GL stack at all, so that belongs in notes, not warnings.
 */
export function envReview(env: BrowserEnvReport): { warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];

  if (env.probeError) warnings.push(`The page could not be read: ${env.probeError}`);
  if (env.webdriver === true) {
    warnings.push("navigator.webdriver is true, which is a direct automation tell.");
  }
  if (env.latinOk === false) {
    warnings.push(
      "No usable fonts at all: fontconfig is finding none of the installed ones, so every " +
        "glyph is a box and text measures unlike any real browser.",
    );
  }
  if (typeof env.cores === "number" && env.cores <= 1) {
    warnings.push(`hardwareConcurrency is ${env.cores}: a real desktop reports more.`);
  }

  const webgl = String(env.webgl ?? "");
  if (!webgl || webgl === "unavailable" || webgl.startsWith("error")) {
    notes.push(
      "No WebGL. Worth comparing between installs, but not a blocker on its own: " +
        "challenges are passed on setups that report none.",
    );
  }
  if (env.webgl2 === false) notes.push("No WebGL2.");
  if (env.latinOk !== false && env.cjkOk === false) {
    notes.push("CJK glyphs are missing, so Chinese text renders as boxes (matching still works).");
  }
  if (env.emojiOk === false) notes.push("Emoji glyphs are missing.");
  if (env.uaData === null) {
    notes.push("No User-Agent Client Hints: expected off a secure origin, a real gap on one.");
  }
  return { warnings, notes };
}

/**
 * Launches the installed browser and checks that it actually renders: the same thing a
 * Mini App step depends on, told apart from a Cloudflare or network problem. Handy on a
 * server where the browser is an on-demand install and nothing else can be seen.
 * `env` reports what the page sees of itself, for comparing one install against another.
 */
export async function testBrowser(
  proxyUrl?: string,
  tier?: "keyed" | "free",
): Promise<{
  ok: boolean;
  /** Which build was exercised, when the caller asked for one in particular. */
  tier?: "keyed" | "free";
  executable?: string;
  version?: string;
  renderedText?: string;
  screenshot?: string;
  error?: string;
  env?: BrowserEnvReport;
  /** Things that stop the browser being useful, or read as automation outright. */
  warnings?: string[];
  /** Differences worth comparing between installs, none fatal on its own. */
  notes?: string[];
  /** Country the exit came out in, which also proves TLS and the proxy work. */
  exitCountry?: string;
}> {
  const executable = chromiumExecutable(tier);
  if (!executable) {
    return {
      ok: false,
      tier,
      error: tier
        ? `The ${tier === "keyed" ? "keyed" : "free"} build is not installed`
        : "Chromium is not installed",
    };
  }

  let launched: LaunchedBrowser | undefined;
  try {
    launched = await launchCfBrowser(proxyUrl, tier ? { tier } : {});
    const page = launched.page;
    const version = launched.context.browser()?.version() ?? chromiumVersion();
    await page.setContent("<h1 id=probe>bemby browser ok</h1>").catch(() => {});
    const renderedText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch((err: any) => `evaluate failed: ${err?.message ?? err}`);
    // Read the fingerprint off a real https page: client hints and anything else gated on
    // a secure context do not exist on about:blank, and reporting them as absent there
    // would send someone chasing a difference that is only in the probe.
    let exitCountry: string | undefined;
    const secure = await page
      .goto(TRACE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (secure) {
      const trace = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      exitCountry = /(?:^|\n)loc=([A-Z]{2})/.exec(trace)?.[1];
    }
    const env = (await page.evaluate(FINGERPRINT_PROBE).catch((err: any) => ({
      probeError: err?.message ?? String(err),
    }))) as BrowserEnvReport;
    if (!secure) env.secureOrigin = false;
    const review = envReview(env);
    return {
      ok: typeof renderedText === "string" && renderedText.includes("bemby browser ok"),
      tier: tier ?? launched.tier,
      executable,
      version,
      env,
      exitCountry,
      warnings: review.warnings,
      notes: review.notes,
      renderedText,
      screenshot: await screenshotOf(page),
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const diagnosis = launchFailureReason(message);
    return {
      ok: false,
      tier,
      executable,
      // Chromium's whole stderr rides along on a launch failure; keep enough to work with
      error: message.length > 1200 ? `${message.slice(0, 1200)}…` : message,
      warnings: diagnosis ? [diagnosis] : undefined,
    };
  } finally {
    await launched?.close();
  }
}

/**
 * Names a launch failure whose cause is buried in the browser log it carries, so the panel
 * leads with something to act on rather than a wall of Chromium stderr.
 */
function launchFailureReason(message: string): string | undefined {
  if (/GLX is not present|EGL_NOT_INITIALIZED|ANGLE Display::initialize/i.test(message)) {
    return (
      "The browser could not start a GL display. This image ships no system GL, so the " +
      "browser has to run on its own bundled SwiftShader -- check the --use-gl=angle and " +
      "--use-angle=swiftshader launch flags are still in place, or reinstall the image."
    );
  }
  // The keyed build takes its licence at startup and quits on the spot if it cannot hold a
  // session -- before any page is opened, so the log is all startup noise and a signal.
  if (/SIGTRAP/.test(message) && /-pro\/chrome|licen[cs]e/i.test(message)) {
    return (
      "The licensed browser build quit during startup, before opening a page. It does that " +
      "when it cannot take a licence session: a free-plan key allows one browser at a time, " +
      "so check that no other instance is using the same key, that the key is still valid " +
      "in Settings, and that this host can reach the CloakBrowser licence service"
    );
  }
  if (/Failed to launch|ENOENT|no such file or directory/i.test(message)) {
    return "The browser binary could not be started. Re-download it from this panel.";
  }
  return undefined;
}

/** What Playwright says once the browser it was driving is no longer there. */
const BROWSER_GONE_RE =
  /Target (?:page|closed)|(?:context or )?browser has been closed|Browser closed|browser has disconnected/i;

/**
 * The browser did not survive the attempt. Nothing here is the exit's doing: the driver
 * calls that followed the exit answered with nothing, so the page reads as blank however
 * good the proxy was. Marked like a launch failure so the pool is left alone -- working
 * through it would only kill the same browser a dozen more times.
 */
function browserGoneResult(
  finalHost: string,
  detail: string,
  about: Pick<
    CheckinPageResult,
    "browserTier" | "profileKey" | "deviceSeed" | "locale" | "localePinned"
  >,
): CheckinPageResult {
  return {
    ok: false,
    challenged: false,
    text: "",
    finalHost,
    ...about,
    reason:
      "The solver browser exited part-way through the attempt, so the page was never " +
      "driven to the end. A licensed build does that when it loses its licence session " +
      "(a free-plan key allows one browser at a time), and any build does when a second " +
      "process opens the same profile -- check nothing else is running against this data " +
      `dir (${oneLine(detail).slice(0, 200)})`,
    navError: detail,
    exitRelated: false,
    browserFailed: true,
    browserGone: true,
  };
}

/**
 * JPEG of what the browser is looking at, small enough to keep in a job log. `clip` narrows
 * it to one region, for the close-up the `ai_web_click_xy` step takes.
 */
async function screenshotOf(
  page: Page,
  quality = 45,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<string | undefined> {
  const buffer = await page
    .screenshot({ type: "jpeg", quality, ...(clip ? { clip } : {}) })
    .catch(() => undefined);
  const shot = buffer?.toString("base64");
  if (!shot) return undefined;
  // Job logs are stored as JSON in SQLite; an oversized image is not worth keeping
  if (shot.length > 700_000) return undefined;
  return `data:image/jpeg;base64,${shot}`;
}

/** One load-and-solve pass through a single exit (the proxy, or direct). */
async function attemptLoad(
  url: string,
  proxyUrl: string | undefined,
  opts: LoadOptions,
  budgetDeadline: number,
): Promise<CheckinPageResult> {
  const tune = cfTuning();
  const finalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  let launched: LaunchedBrowser | undefined;
  // Tells a browser that never started from one that started and then hit trouble: only
  // the latter says anything about the exit.
  let launchOk = false;
  let browserTier: "keyed" | "free" | undefined;
  // The profile it ran on, so a log can say whose cookies these were: a login that
  // keeps being asked for is almost always a name resolving to other than intended.
  let profileKey: string | undefined;
  // And the device it ran as, which is the other half of "why does the site still know me"
  let deviceSeed: number | undefined;
  // And the locale it presented, which is the other question a page in the wrong language asks
  let locale: string | undefined;
  let localePinned: boolean | undefined;
  // Renderer trouble the page reports on its own: a crashed tab or a main request
  // that never arrived both leave a blank page that otherwise looks challenge-free.
  const troubles: string[] = [];
  const note = (msg: string) => {
    // A challenge page aborts its own load on the way to the destination, so an
    // aborted request says nothing about whether the page came up
    if (/ERR_ABORTED/i.test(msg)) return;
    if (troubles.length < 5 && !troubles.includes(msg)) troubles.push(msg);
  };
  try {
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    // The clock and language of the exit are launch flags, so this settles them before
    // anything on the target is loaded
    launched = await launchAlignedBrowser(
      proxyUrl,
      budgetDeadline,
      opts.profile,
      opts.display,
      opts.runId,
    );
    launchOk = true;
    browserTier = launched.tier;
    profileKey = launched.profileKey;
    deviceSeed = launched.deviceSeed;
    locale = launched.locale;
    localePinned = launched.localePinned;
    const page = launched.page;

    page.on("crash", () => note("page crashed"));
    page.on("pageerror", (err: Error) => note(`page script error: ${err?.message ?? err}`));
    page.on("requestfailed", (req) => {
      if (req.isNavigationRequest()) note(`request failed: ${req.failure()?.errorText}`);
    });

    // In dev the backend runs via tsx/esbuild, which wraps functions passed to
    // page.evaluate() with a __name() helper that doesn't exist in the browser.
    // Shim it (string form, so this injection itself isn't instrumented) so the
    // evaluate() calls below work under tsx too; tsc production builds don't need it.
    await page
      .addInitScript("window.__name = window.__name || function (a) { return a; };")
      .catch(() => {});

    if (opts.miniApp) {
      await page.addInitScript(WEBVIEW_PROXY_SHIM).catch(() => {});
      // Before the app loads, so it has nothing to prefer over the account just signed for
      if (opts.clearAppSession) {
        const said = await clearMiniAppSession(page, url);
        if (said) console.log(`[cf] app session ${said}`);
      }
    }

    await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(5_000, capped(tune.navTimeoutMs, budgetDeadline)),
      })
      .catch((err: any) => {
        // The challenge page may abort/redirect mid-load; the poll below is the
        // real signal, so a goto rejection isn't fatal -- but it is recorded, since
        // a page that never loaded looks exactly like one with no challenge on it.
        note(`navigation: ${err?.message ?? err}`);
      });

    // Compare without the fragment: a Mini App rewriting its hash route is not the
    // portal navigating away, and counting it would call the challenge solved at once.
    const withoutHash = (u: string) => u.split("#")[0];
    const startUrl = withoutHash(page.url());
    await waitForPageReady(page, budgetDeadline);

    // Works a challenge that is on the page right now. Returns null when there is
    // none, so callers can tell "nothing to do" from "tried and failed".
    const solveChallenge = async (): Promise<boolean | null> => {
      const interstitial = await isInterstitial(page);
      let widget = await hasTurnstileWidget(page);

      // Not every app uses Turnstile: a Cap checkbox is solved in the browser instead.
      if (!interstitial && !widget && (await hasCapWidget(page))) {
        return solveCap(page, Math.min(Date.now() + tune.challengeTimeoutMs, budgetDeadline));
      }

      // A verify portal may load the Turnstile script and only render the widget once
      // its single button is pressed, so try that before concluding there is nothing.
      if (!interstitial && !widget && (await hasTurnstileScript(page))) {
        if (await clickVerifyButton(page)) {
          for (let i = 0; i < 6 && !widget; i++) {
            await sleep(tune.readyPollMs, budgetDeadline);
            widget = await hasTurnstileWidget(page);
          }
        }
      }
      if (!interstitial && !widget) return null;

      // Custom verify portals only engage Turnstile after a real click.
      if (widget) await clickVerifyButton(page);

      const challengeStart = Date.now();
      const deadline = Math.min(challengeStart + tune.challengeTimeoutMs, budgetDeadline);
      let widgetClicks = 0;
      while (Date.now() < deadline) {
        await sleep(tune.pollMs, deadline);
        if (turnstilePassed(await turnstileToken(page), await isInterstitial(page))) return true;
        // Nudge a widget that is sitting there unsolved: it may be an interactive
        // checkbox that nothing has clicked yet. Spaced out, so a widget that is
        // verifying on its own is not interrupted.
        if (widget && widgetClicks < 3 && Date.now() > challengeStart + (widgetClicks + 1) * 4_000) {
          widgetClicks++;
          await clickTurnstileWidget(page);
        }
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        // The site has already rejected this exit; waiting the rest out gains nothing
        if (REFUSED_RE.test(body)) return false;
        // Nothing below means anything while the interstitial is still up: a managed
        // challenge navigates to its own URL to run, so the address changing is the
        // challenge working, not the portal letting us through.
        if (await isInterstitial(page)) continue;
        // A challenge that cleared and left no widget behind is done -- but mid-reload
        // the document has no title and no widget in it either, which reads exactly the
        // same, so it has to still be gone one poll later before this counts.
        if (await challengeGone(page)) {
          await sleep(tune.pollMs, deadline);
          if (await challengeGone(page)) return true;
          continue;
        }
        // Portal navigated away or shows a success message.
        if (withoutHash(page.url()) !== startUrl) return true;
        if (SUCCESS_RE.test(body)) return true;
      }
      return false;
    };

    // The challenge may be up already, or an app may only raise it once a provider or
    // action is chosen inside it -- so try before the in-app steps and again after.
    const before = await solveChallenge();
    let solved = before ?? true;
    let challenged = before !== null;

    // Some apps render their own "verification failed" instead of a challenge widget
    if (solved) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (REFUSED_RE.test(body)) {
        solved = false;
        challenged = true;
      }
    }

    await sleep(tune.settleMs, budgetDeadline);

    // A plain page is driven by its own typed sub-steps rather than the Mini App's
    // label-matching, and the challenge is worked again afterwards: pressing a login or
    // submit control is exactly what makes a site raise one.
    let webSteps: WebStepLog[] | undefined;
    let webFailure: string | undefined;
    if (opts.webSteps?.length && solved) {
      const run = await runWebSteps(page, opts.webSteps, budgetDeadline, {
        aiLocate: opts.aiLocate,
        usedValues: opts.usedValues,
        markUsed: opts.markUsed,
        notify: opts.notify,
        emailCode: opts.emailCode,
        // A `web_goto` lands on a page that may have its own challenge, and the solver for
        // this attempt is right here -- so the steps work it through rather than the run
        // only noticing once every step has already failed against an interstitial
        solveChallenge,
        signal: opts.signal,
      });
      webSteps = run.logs;
      webFailure = run.failure;

      const after = await solveChallenge();
      if (after !== null) {
        challenged = true;
        solved = after;
      }
    }

    // A Mini App checkin is a tap inside the app, not the page load itself.
    let inAppAction: string | undefined;
    let inAppFailure: string | undefined;
    // Whether any of those steps actually acted on the app, as opposed to only waiting or
    // scrolling into position.
    let inAppActed = false;
    // Standing text, captured before the steps run, so a verify prompt the page has always
    // shown can be told from one raised by pressing the control.
    let priorText: string | undefined;
    if (opts.miniApp && solved) {
      priorText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const clicks = await runInAppClicks(
        page,
        opts.inAppClicks ?? [],
        budgetDeadline,
        opts.solveQuestion,
        opts.aiLocate,
      );
      inAppAction = clicks.trace;
      inAppFailure = clicks.failure;
      inAppActed = clicks.acted;

      // A verification the app raises only once the checkin is pressed needs a moment to
      // render. Asking once, immediately, sees nothing there and calls the step done --
      // so while the app says it wants one, keep looking for it.
      const challengeBy = Math.min(Date.now() + tune.postClickChallengeMs, budgetDeadline);
      let after: boolean | null = null;
      for (;;) {
        after = await solveChallenge();
        if (after !== null) break;
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        // Standing wording is not the app asking; waiting it out just spends the budget.
        if (!VERIFY_REQUIRED_RE.test(body) || !isLivePrompt(body, priorText)) break;
        if (Date.now() >= challengeBy) break;
        await sleep(tune.pollMs, challengeBy);
      }
      if (after !== null) {
        challenged = true;
        solved = after;
      }
    }

    // A widget-based challenge is verified server-side after the token is issued, so
    // the app's own wording is the outcome. Give it a bounded wait rather than closing
    // the browser while the request is still in flight.
    let text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (solved && challenged && !SUCCESS_RE.test(text)) {
      const deadline = Math.min(Date.now() + tune.confirmTimeoutMs, budgetDeadline);
      while (Date.now() < deadline) {
        await sleep(tune.pollMs, deadline);
        text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (SUCCESS_RE.test(text)) break;
      }
    }

    const pageTitle = (await page.title().catch(() => "")) || undefined;
    const navError = troubles.length ? troubles.join("; ") : undefined;

    // Asked before the verdict: a browser that went away answers every question with
    // nothing, and the verdict below would read that as a page this exit failed to render.
    if (launched.died()) {
      return browserGoneResult(finalHost, navError ?? "the browser exited mid-run", {
        browserTier,
        profileKey,
        deviceSeed,
        locale,
        localePinned,
      });
    }

    const verdict = opts.miniApp
      ? miniAppVerdict({
          challenged,
          solved,
          text,
          inAppAction,
          inAppActed,
          inAppFailure,
          navError,
          priorText,
        })
      : webSteps
        ? // A sub-step that could not be carried out is a failure even with no challenge in
          // the way: the page was never driven to where the caller wanted it.
          { ok: solved && !webFailure, reason: solved ? webFailure : challengeRefused(challenged, navError) }
        : { ok: solved, reason: solved ? undefined : challengeRefused(challenged, navError) };

    return {
      ok: verdict.ok,
      challenged,
      text,
      finalHost,
      inAppAction,
      webSteps,
      reason: verdict.reason,
      navError,
      pageTitle,
      // A challenge this exit was refused, or a page it never loaded, is worth retrying
      // elsewhere; a control that is not on the page is not. A sub-step that failed once
      // the challenge was already cleared is the page's doing, so every other exit would
      // meet it alike -- rotating the pool there only spends the budget.
      browserTier,
      profileKey,
      deviceSeed,
      locale,
      localePinned,
      exitRelated: solved && webFailure ? false : !!navError || (challenged && !verdict.ok) || !text.trim(),
      screenshot: opts.screenshot ? await screenshotOf(page) : undefined,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/not installed|executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available: ${msg}`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    // A browser that never started is not the exit's doing, and no other exit can fix it
    if (!launchOk) {
      return {
        ok: false,
        challenged: false,
        text: "",
        finalHost,
        reason: `${launchFailureReason(msg) ?? "the solver browser could not be started"} (${oneLine(msg).slice(0, 200)})`,
        navError: msg,
        exitRelated: false,
        browserFailed: true,
      };
    }
    // Nor is one that started and then went away: it took the exit nowhere either
    if (launched?.died() || BROWSER_GONE_RE.test(msg)) {
      return browserGoneResult(finalHost, msg, {
        browserTier,
        profileKey,
        deviceSeed,
        locale,
        localePinned,
      });
    }
    return {
      ok: false,
      challenged: false,
      text: "",
      finalHost,
      reason: msg,
      navError: msg,
      browserTier,
      exitRelated: true,
    };
  } finally {
    await launched?.close();
  }
}

/**
 * Load `url` in the installed Chromium, pass any Cloudflare challenge (full-page
 * interstitial or embedded Turnstile widget), and return the final page's visible
 * text so the caller can match success/fail keywords.
 *
 * Cloudflare judges the exit IP as much as the browser, so when the caller offers a pool
 * of proxies (`opts.proxyCandidates`) each is tried until one is accepted. Only a refused
 * challenge moves on to the next -- a page that loads with no challenge, or one that
 * clears it, is done. `opts.refreshUrl` re-mints the address between attempts, which a
 * signed Mini App URL needs since its init data ages.
 *
 * `opts.maxWaitMs` bounds the whole thing: exits are tried only while budget remains,
 * so a hunt through a large pool cannot run for an unbounded stretch.
 */
export async function loadCheckinUrl(
  url: string,
  proxyUrl?: string,
  opts: LoadOptions = {},
): Promise<CheckinPageResult> {
  const tune = cfTuning();
  const candidates: ProxyCandidate[] = opts.proxyCandidates?.length
    ? opts.proxyCandidates
    : [{ id: proxyUrl ? "job" : "direct", label: proxyUrl ? "job proxy" : "direct", url: proxyUrl }];

  const budget = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : tune.budgetMs;
  const deadline = Date.now() + budget;

  let target = url;
  let last: CheckinPageResult | undefined;
  const trace: string[] = [];
  const refusedProxyIds: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    // Cancelling has to stop the whole load, not just the exit in hand: another exit would
    // launch another browser and start the wait over
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    if (i > 0) {
      if (msLeft(deadline) < tune.minAttemptMs) {
        trace.push(`out of time after ${i} exit(s) (budget ${Math.round(budget / 1000)}s)`);
        console.log(`[cloudflare] budget spent after ${i} exit(s), giving up`);
        break;
      }
      console.log(
        `[cloudflare] challenge refused, retrying via ${candidate.label} (${i + 1}/${candidates.length})`,
      );
      // A signed Mini App URL ages, so mint a fresh one for this attempt when possible
      if (opts.refreshUrl) {
        const fresh = await opts.refreshUrl().catch(() => undefined);
        if (fresh) target = fresh;
      }
    }

    const result = await attemptLoad(target, candidate.url, opts, deadline);
    // Only a failure the exit had a hand in counts against it. A browser that never
    // started, or an app that simply does not have the control being looked for, is the
    // same through every exit -- marking them refused empties the pool over something no
    // proxy was ever going to fix, and the next attempt then reports "every proxy refused"
    // in place of the real fault.
    const exitAtFault = !result.ok && !result.browserFailed && result.exitRelated !== false;
    if (exitAtFault) refusedProxyIds.push(candidate.id);
    trace.push(
      [
        `${candidate.label}: ${result.ok ? "ok" : "failed"}`,
        result.challenged ? "challenged" : undefined,
        // Which profile and device this exit ran as: a site that keeps knowing the visitor,
        // or keeps forgetting a login, is nearly always one of these two not being what was
        // intended -- and neither is visible on the page
        result.profileKey ? `profile ${result.profileKey}` : undefined,
        result.deviceSeed ? `device ${result.deviceSeed}` : undefined,
        result.locale
          ? `locale ${result.locale}${result.localePinned ? " (pinned)" : ""}`
          : undefined,
        result.pageTitle ? `title="${result.pageTitle}"` : undefined,
        `text ${result.text.trim().length} chars`,
        result.inAppAction ? `in-app: ${result.inAppAction}` : undefined,
        result.webSteps?.length
          ? `page steps: ${result.webSteps.map((s) => s.outcome ?? `${s.label} FAILED`).join(" → ")}`
          : undefined,
        result.reason,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    last = {
      ...result,
      proxyId: candidate.id,
      proxyLabel: candidate.label,
      attempts: i + 1,
      trace: [...trace],
      refusedProxyIds: [...refusedProxyIds],
    };
    if (result.ok) return last;

    // The browser is what failed; working through the pool would only repeat it
    if (result.browserFailed) {
      const what = result.browserGone
        ? "the solver browser exited part-way through, so no other exit was tried"
        : "the solver browser could not start, so no exit was tried";
      trace.push(what);
      console.error(`[cloudflare] ${what}; leaving the pool alone`);
      break;
    }

    // Nothing another exit can do about a failure inside the app itself
    if (result.exitRelated === false) {
      trace.push("failed inside the app, so no other exit was tried");
      console.log("[cloudflare] failure is not about the exit; leaving the rest of the pool alone");
      break;
    }
  }

  // A browser closed from under the load fails the attempt like any other; say what it
  // actually was rather than reporting the collateral as the fault
  if (opts.signal?.aborted) throw new Error("Job cancelled");

  return { ...last!, trace: [...trace], refusedProxyIds: [...refusedProxyIds] };
}
