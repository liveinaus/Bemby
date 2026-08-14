import type { WebStep } from "../api/client";

// Sub-steps of the `open_url` action. The form keeps every field on one flat object, the
// same way the action forms do, so switching a step's type does not throw away what was
// already typed into the fields the other types use. The one exception is `steps`, which a
// loop holds: those are forms of their own, edited by the same editor one level down.

export type WebStepType = WebStep["type"];

export type WebStepForm = {
  type: WebStepType;
  selector: string;
  text: string;
  hint: string;
  waitMs: number;
  scrollX: number;
  scrollY: number;
  url: string;
  varName: string;
  attribute: string;
  /** web_pick / web_collect: only consider candidates whose text contains this. */
  containsText: string;
  pattern: string;
  choose: "first" | "random";
  skipUsed: boolean;
  /** web_collect: keep at most this many values. 0 keeps the lot. */
  limit: number;
  maxChars: number;
  times: number;
  /** web_for_each: stop after this many values. 0 works through the whole list. */
  max: number;
  /** web_press: the key to press, e.g. `Enter` or `Control+Enter`. */
  key: string;
  /** web_select: the option to choose, by its label or its value. */
  option: string;
  /** web_set / web_data_save: what to hold under the name, or store. */
  value: string;
  /** web_set: a name and its value per row, set in the order shown. */
  vars: Array<{ name: string; value: string }>;
  /** The data steps: which folder of the data store, e.g. `example`. */
  folder: string;
  /** The data steps: which record, e.g. `email`. */
  recordKey: string;
  /** The data steps: field inside the record's value. Blank means the whole record. */
  path: string;
  /** The data steps: carry on when nothing is stored there. */
  optional: boolean;
  /** web_data_pick: which record of the folder, counting from 0. */
  index: string;
  /** web_data_pick: name to hold the record's value under; blank takes the key alone. */
  valueVar: string;
  /** web_notify: the chat to send to; blank uses the configured one. */
  target: string;
  /** web_email_code: the mailbox to read. */
  email: string;
  /** web_email_code: which service holds the mailbox. */
  emailSource: "gmail" | "msapi";
  /** web_email_code / web_email_lease: msOauth2api pool type; blank uses the default. */
  poolType: string;
  /** web_email_code: the secret holding the app password, e.g. `{gmailAppPassword}`. */
  appPassword: string;
  /** web_email_code: only consider mail from a sender containing this. */
  fromContains: string;
  /** web_email_code: only consider mail whose subject contains this. */
  subjectContains: string;
  /** web_read: keep what was read out of the log. */
  secret: boolean;
  /** web_totp: where the authenticator secret is, e.g. `{data.example.{jobId}.otp}`. */
  secretRef: string;
  /** web_totp: wait for the next code when this much of the window is not left. */
  minValidMs: number;
  /** web_tg_send: who the account sends to, e.g. `@some_bot`. */
  contact: string;
  /** web_tg_send: carry on once the reply holds one of these (`|` separated). */
  replyContains: string;
  /** web_tg_api_save: the api_id to write, e.g. `{apiId}`. */
  apiId: string;
  /** web_tg_api_save: the api_hash to write, e.g. `{apiHash}`. */
  apiHash: string;
  /** web_hold / web_hold_offset: how long to keep the pointer down. */
  holdMs: number;
  /** web_hold_offset: where on the anchor the offset is measured from. */
  holdFrom: "centre" | "topLeft";
  /** web_hold_offset: how far from the anchor to press. */
  offsetX: number;
  offsetY: number;
  /** web_drag: what to drop it on; blank drags by the offset below. */
  toSelector: string;
  /** web_drag: how far to drag when there is no drop target. */
  dragX: number;
  dragY: number;
  /** web_drag: how long the drag itself takes. */
  durationMs: number;
  /** ai_web_click_xy_multi: pause between one click and the next. */
  gapMs: number;
  /** ai_web_click_xy_multi: check each position with a close-up second look. */
  refine: boolean;
  /** ai_web_click_xy_multi: take the wide look at the captcha panel alone, ruled finely. */
  zoom: boolean;
  continueOnError: boolean;
  betweenMs: number;
  check: "element" | "text" | "url";
  negate: boolean;
  /** A loop's steps, or a `web_if`'s then branch; empty for every other type. */
  steps: WebStepForm[];
  /** A `web_if`'s else branch. */
  elseSteps: WebStepForm[];
};

/** Order the editor offers them in: the selector steps first, then waits, then the AI ones. */
export const WEB_STEP_TYPES: WebStepType[] = [
  "web_input",
  "web_button",
  "web_press",
  "web_hold",
  "web_hold_offset",
  "web_drag",
  "web_select",
  "web_wait_element",
  "web_delay",
  "web_scroll",
  "web_scroll_to",
  "web_turnstile",
  "web_goto",
  "web_back",
  "web_pick",
  "web_collect",
  "web_read",
  "web_email_code",
  "web_email_lease",
  "web_totp",
  "web_tg_code",
  "web_tg_send",
  "web_tg_api_save",
  "web_set",
  "web_data_read",
  "web_data_pick",
  "web_data_save",
  "web_data_delete",
  "web_notify",
  "web_if",
  "web_repeat",
  "web_for_each",
  "web_ai_input",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
  "ai_web_click_xy_multi",
];

/** Types that need the vision model, so the editor can gate them on a configured key. */
export const AI_WEB_STEP_TYPES: WebStepType[] = [
  "web_ai_input",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
  "ai_web_click_xy_multi",
];

/** Types that reach the data store, so the editor can hide them while it is switched off. */
export const DATA_WEB_STEP_TYPES: WebStepType[] = [
  "web_data_read",
  "web_data_pick",
  "web_data_save",
  "web_data_delete",
];

/** Types that reach msOauth2api, so the editor can hide them while it is not configured. */
export const MSAPI_WEB_STEP_TYPES: WebStepType[] = ["web_email_lease"];

/** Types that hold other steps, and so decide what may be offered inside them. */
export const LOOP_WEB_STEP_TYPES: WebStepType[] = ["web_repeat", "web_for_each"];
export const BRANCH_WEB_STEP_TYPE: WebStepType = "web_if";

/** Matches the backend: containers may not nest deeper than this. */
export const MAX_WEB_STEP_DEPTH = 3;

/**
 * What the editor may offer at this point in the nesting. Neither loop can go inside a loop,
 * though both may go inside a branch; nothing may go past the depth limit. The data steps are
 * left out while the store is switched off, and the msOauth2api steps while it has no URL and
 * key, since the backend would refuse either anyway -- except on a step already saved as one,
 * which stays selectable so it is not silently changed.
 */
export function offeredWebStepTypes(
  depth: number,
  inLoop: boolean,
  opts: { dataEnabled?: boolean; msApiEnabled?: boolean; keep?: WebStepType } = {},
): WebStepType[] {
  return WEB_STEP_TYPES.filter((ty) => {
    const container = LOOP_WEB_STEP_TYPES.includes(ty) || ty === BRANCH_WEB_STEP_TYPE;
    if (LOOP_WEB_STEP_TYPES.includes(ty) && inLoop) return false;
    if (container && depth >= MAX_WEB_STEP_DEPTH) return false;
    if (DATA_WEB_STEP_TYPES.includes(ty) && !opts.dataEnabled && ty !== opts.keep) return false;
    if (MSAPI_WEB_STEP_TYPES.includes(ty) && !opts.msApiEnabled && ty !== opts.keep)
      return false;
    return true;
  });
}

export function defaultWebStep(): WebStepForm {
  return {
    type: "web_button",
    selector: "",
    text: "",
    hint: "",
    waitMs: 3000,
    scrollX: 0,
    scrollY: 500,
    url: "",
    varName: "",
    attribute: "",
    containsText: "",
    pattern: "",
    choose: "first",
    skipUsed: true,
    limit: 0,
    maxChars: 1000,
    times: 3,
    max: 0,
    key: "Enter",
    option: "",
    value: "",
    vars: [{ name: "", value: "" }],
    folder: "",
    recordKey: "",
    path: "",
    optional: false,
    index: "0",
    valueVar: "",
    target: "",
    email: "",
    emailSource: "gmail",
    poolType: "",
    appPassword: "{gmailAppPassword}",
    fromContains: "",
    subjectContains: "",
    secret: false,
    secretRef: "",
    minValidMs: 10000,
    contact: "",
    replyContains: "",
    apiId: "{apiId}",
    apiHash: "{apiHash}",
    holdMs: 1000,
    holdFrom: "centre",
    offsetX: 0,
    offsetY: 0,
    toSelector: "",
    dragX: 260,
    dragY: 0,
    durationMs: 600,
    gapMs: 500,
    refine: true,
    zoom: true,
    continueOnError: true,
    betweenMs: 45000,
    check: "element",
    negate: false,
    steps: [],
    elseSteps: [],
  };
}

/** Drops the fields the chosen type does not use, so the saved config stays readable. */
export function webStepToConfig(s: WebStepForm): WebStep {
  switch (s.type) {
    case "web_input":
      return { type: "web_input", selector: s.selector.trim(), text: s.text };
    case "web_button":
      return { type: "web_button", selector: s.selector.trim() };
    case "web_delay":
      return { type: "web_delay", waitMs: s.waitMs };
    case "web_turnstile":
      return { type: "web_turnstile" };
    case "web_scroll":
      return {
        type: "web_scroll",
        ...(s.scrollX ? { x: s.scrollX } : {}),
        ...(s.scrollY ? { y: s.scrollY } : {}),
      };
    case "web_scroll_to":
      return {
        type: "web_scroll_to",
        selector: s.selector.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_wait_element":
      return {
        type: "web_wait_element",
        selector: s.selector.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_goto":
      return {
        type: "web_goto",
        url: s.url.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_back":
      return { type: "web_back", ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}) };
    case "web_pick":
      return {
        type: "web_pick",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.attribute.trim() ? { attribute: s.attribute.trim() } : {}),
        ...(s.containsText.trim() ? { containsText: s.containsText.trim() } : {}),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.choose === "random" ? { choose: "random" as const } : {}),
        ...(s.skipUsed ? { skipUsed: true } : {}),
      };
    case "web_collect":
      return {
        type: "web_collect",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.attribute.trim() ? { attribute: s.attribute.trim() } : {}),
        ...(s.containsText.trim() ? { containsText: s.containsText.trim() } : {}),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.limit > 0 ? { limit: s.limit } : {}),
        ...(s.skipUsed ? { skipUsed: true } : {}),
      };
    case "web_set":
      return {
        type: "web_set",
        // A row with no name is one the person has not filled in yet, not a variable
        vars: s.vars
          .filter((v) => v.name.trim())
          .map((v) => ({ name: v.name.trim(), value: v.value })),
      };
    case "web_data_read":
      return {
        type: "web_data_read",
        folder: s.folder.trim(),
        key: s.recordKey.trim(),
        varName: s.varName.trim(),
        ...(s.path.trim() ? { path: s.path.trim() } : {}),
        ...(s.optional ? { optional: true } : {}),
      };
    case "web_data_pick":
      return {
        type: "web_data_pick",
        folder: s.folder.trim(),
        varName: s.varName.trim(),
        ...(s.index.trim() && s.index.trim() !== "0" ? { index: s.index.trim() } : {}),
        ...(s.valueVar.trim() ? { valueVar: s.valueVar.trim() } : {}),
        ...(s.path.trim() ? { path: s.path.trim() } : {}),
        ...(s.optional ? { optional: true } : {}),
      };
    case "web_data_save":
      return {
        type: "web_data_save",
        folder: s.folder.trim(),
        key: s.recordKey.trim(),
        value: s.value,
        ...(s.path.trim() ? { path: s.path.trim() } : {}),
      };
    case "web_data_delete":
      return {
        type: "web_data_delete",
        folder: s.folder.trim(),
        key: s.recordKey.trim(),
        ...(s.path.trim() ? { path: s.path.trim() } : {}),
        ...(s.optional ? { optional: true } : {}),
      };
    case "web_email_code":
      return {
        type: "web_email_code",
        email: s.email.trim(),
        varName: s.varName.trim(),
        // The pool holds its own credentials, so only the Gmail source carries a secret name
        ...(s.emailSource === "msapi"
          ? {
              source: "msapi" as const,
              ...(s.poolType.trim() ? { poolType: s.poolType.trim() } : {}),
            }
          : { appPassword: s.appPassword.trim() }),
        ...(s.fromContains.trim() ? { fromContains: s.fromContains.trim() } : {}),
        ...(s.subjectContains.trim() ? { subjectContains: s.subjectContains.trim() } : {}),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_email_lease":
      return {
        type: "web_email_lease",
        varName: s.varName.trim(),
        ...(s.poolType.trim() ? { poolType: s.poolType.trim() } : {}),
      };
    case "web_totp":
      return {
        type: "web_totp",
        secretRef: s.secretRef.trim(),
        varName: s.varName.trim(),
        // 0 is a choice of its own -- hand on whatever the window is showing -- so only the
        // default is left out
        ...(s.minValidMs !== 10000 ? { minValidMs: Math.max(0, s.minValidMs) } : {}),
      };
    case "web_tg_code":
      return {
        type: "web_tg_code",
        varName: s.varName.trim(),
        ...(s.pattern.trim() ? { pattern: s.pattern.trim() } : {}),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_tg_send":
      return {
        type: "web_tg_send",
        contact: s.contact.trim(),
        text: s.text,
        ...(s.replyContains.trim() ? { replyContains: s.replyContains.trim() } : {}),
        ...(s.varName.trim() ? { varName: s.varName.trim() } : {}),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "web_tg_api_save":
      return {
        type: "web_tg_api_save",
        apiId: s.apiId.trim(),
        apiHash: s.apiHash.trim(),
        ...(s.folder.trim() ? { folder: s.folder.trim() } : {}),
        ...(s.recordKey.trim() ? { key: s.recordKey.trim() } : {}),
      };
    case "web_notify":
      return {
        type: "web_notify",
        text: s.text,
        ...(s.target.trim() ? { target: s.target.trim() } : {}),
      };
    case "web_read":
      return {
        type: "web_read",
        selector: s.selector.trim(),
        varName: s.varName.trim(),
        ...(s.maxChars > 0 ? { maxChars: s.maxChars } : {}),
        ...(s.secret ? { secret: true } : {}),
      };
    case "web_press":
      return {
        type: "web_press",
        key: s.key.trim(),
        ...(s.selector.trim() ? { selector: s.selector.trim() } : {}),
      };
    case "web_hold":
      return {
        type: "web_hold",
        selector: s.selector.trim(),
        ...(s.holdMs > 0 ? { holdMs: s.holdMs } : {}),
      };
    case "web_hold_offset":
      return {
        type: "web_hold_offset",
        selector: s.selector.trim(),
        ...(s.holdFrom === "topLeft" ? { from: "topLeft" as const } : {}),
        ...(s.offsetX ? { x: s.offsetX } : {}),
        ...(s.offsetY ? { y: s.offsetY } : {}),
        ...(s.holdMs > 0 ? { holdMs: s.holdMs } : {}),
      };
    case "web_drag":
      return {
        type: "web_drag",
        selector: s.selector.trim(),
        ...(s.toSelector.trim()
          ? { toSelector: s.toSelector.trim() }
          : {
              ...(s.dragX ? { x: s.dragX } : {}),
              ...(s.dragY ? { y: s.dragY } : {}),
            }),
        ...(s.durationMs > 0 ? { durationMs: s.durationMs } : {}),
      };
    case "web_select":
      return { type: "web_select", selector: s.selector.trim(), option: s.option.trim() };
    case "web_ai_input":
      return {
        type: "web_ai_input",
        selector: s.selector.trim(),
        hint: s.hint.trim(),
        ...(s.maxChars > 0 ? { maxChars: s.maxChars } : {}),
        ...(s.varName.trim() ? { varName: s.varName.trim() } : {}),
      };
    case "web_if":
      return {
        type: "web_if",
        check: s.check,
        ...(s.check === "element" ? { selector: s.selector.trim() } : { text: s.text.trim() }),
        ...(s.negate ? { negate: true } : {}),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
        ...(s.steps.length ? { then: webStepsToConfig(s.steps) } : {}),
        ...(s.elseSteps.length ? { otherwise: webStepsToConfig(s.elseSteps) } : {}),
      };
    case "web_repeat":
      return {
        type: "web_repeat",
        times: s.times,
        ...(s.steps.length ? { steps: webStepsToConfig(s.steps) } : {}),
        ...(s.continueOnError ? {} : { continueOnError: false }),
        ...(s.betweenMs > 0 ? { betweenMs: s.betweenMs } : {}),
      };
    case "web_for_each":
      return {
        type: "web_for_each",
        varName: s.varName.trim(),
        ...(s.steps.length ? { steps: webStepsToConfig(s.steps) } : {}),
        ...(s.max > 0 ? { max: s.max } : {}),
        ...(s.continueOnError ? {} : { continueOnError: false }),
        ...(s.betweenMs > 0 ? { betweenMs: s.betweenMs } : {}),
      };
    case "ai_web_button":
      return { type: "ai_web_button", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_click_xy":
      return { type: "ai_web_click_xy", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_click_xy_multi":
      return {
        type: "ai_web_click_xy_multi",
        ...(s.hint.trim() ? { hint: s.hint.trim() } : {}),
        ...(s.gapMs > 0 ? { gapMs: s.gapMs } : {}),
        ...(s.max > 0 ? { max: s.max } : {}),
        ...(s.refine ? {} : { refine: false }),
        ...(s.zoom ? {} : { zoom: false }),
      };
    case "ai_web_input":
      return {
        type: "ai_web_input",
        ...(s.hint.trim() ? { hint: s.hint.trim() } : {}),
        ...(s.text ? { text: s.text } : {}),
      };
  }
}

export function webStepsToConfig(steps: WebStepForm[]): WebStep[] {
  return steps.map(webStepToConfig);
}

/** Fills the fields a saved step does not carry with the defaults, so the form is complete. */
export function webStepFromConfig(s: WebStep): WebStepForm {
  const base = defaultWebStep();
  switch (s.type) {
    case "web_input":
      return { ...base, type: s.type, selector: s.selector, text: s.text };
    case "web_button":
      return { ...base, type: s.type, selector: s.selector };
    case "web_delay":
      return { ...base, type: s.type, waitMs: s.waitMs };
    case "web_turnstile":
      return { ...base, type: s.type };
    case "web_scroll":
      return { ...base, type: s.type, scrollX: s.x ?? 0, scrollY: s.y ?? 0 };
    case "web_scroll_to":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 5000 };
    case "web_wait_element":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 30000 };
    case "web_goto":
      return { ...base, type: s.type, url: s.url, waitMs: s.waitMs ?? 30000 };
    case "web_back":
      return { ...base, type: s.type, waitMs: s.waitMs ?? 30000 };
    case "web_pick":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        attribute: s.attribute ?? "",
        containsText: s.containsText ?? "",
        pattern: s.pattern ?? "",
        choose: s.choose ?? "first",
        skipUsed: s.skipUsed ?? false,
      };
    case "web_collect":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        attribute: s.attribute ?? "",
        containsText: s.containsText ?? "",
        pattern: s.pattern ?? "",
        limit: s.limit ?? 0,
        skipUsed: s.skipUsed ?? false,
      };
    case "web_set":
      return {
        ...base,
        type: s.type,
        // A config saved before one step could set several names carries the single pair
        vars: s.vars?.length
          ? s.vars.map((v) => ({ name: v.name, value: v.value }))
          : [{ name: s.varName ?? "", value: s.value ?? "" }],
      };
    case "web_data_read":
      return {
        ...base,
        type: s.type,
        folder: s.folder,
        recordKey: s.key,
        path: s.path ?? "",
        varName: s.varName,
        optional: s.optional ?? false,
      };
    case "web_data_pick":
      return {
        ...base,
        type: s.type,
        folder: s.folder,
        varName: s.varName,
        index: s.index ?? "0",
        valueVar: s.valueVar ?? "",
        path: s.path ?? "",
        optional: s.optional ?? false,
      };
    case "web_data_save":
      return {
        ...base,
        type: s.type,
        folder: s.folder,
        recordKey: s.key,
        path: s.path ?? "",
        value: s.value,
      };
    case "web_data_delete":
      return {
        ...base,
        type: s.type,
        folder: s.folder,
        recordKey: s.key,
        path: s.path ?? "",
        optional: s.optional ?? false,
      };
    case "web_email_code":
      return {
        ...base,
        type: s.type,
        email: s.email,
        emailSource: s.source === "msapi" ? "msapi" : "gmail",
        poolType: s.poolType ?? "",
        appPassword: s.appPassword ?? base.appPassword,
        varName: s.varName,
        fromContains: s.fromContains ?? "",
        subjectContains: s.subjectContains ?? "",
        pattern: s.pattern ?? "",
        waitMs: s.waitMs ?? 120000,
      };
    case "web_email_lease":
      return {
        ...base,
        type: s.type,
        varName: s.varName,
        poolType: s.poolType ?? "",
      };
    case "web_totp":
      return {
        ...base,
        type: s.type,
        secretRef: s.secretRef,
        varName: s.varName,
        minValidMs: s.minValidMs ?? 10000,
      };
    case "web_tg_code":
      return {
        ...base,
        type: s.type,
        varName: s.varName,
        pattern: s.pattern ?? "",
        waitMs: s.waitMs ?? 180000,
      };
    case "web_tg_send":
      return {
        ...base,
        type: s.type,
        contact: s.contact,
        text: s.text,
        replyContains: s.replyContains ?? "",
        varName: s.varName ?? "",
        waitMs: s.waitMs ?? 60000,
      };
    case "web_tg_api_save":
      return {
        ...base,
        type: s.type,
        apiId: s.apiId,
        apiHash: s.apiHash,
        folder: s.folder ?? "",
        recordKey: s.key ?? "",
      };
    case "web_notify":
      return { ...base, type: s.type, text: s.text, target: s.target ?? "" };
    case "web_read":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        varName: s.varName,
        maxChars: s.maxChars ?? 0,
        secret: s.secret ?? false,
      };
    case "web_press":
      return { ...base, type: s.type, key: s.key, selector: s.selector ?? "" };
    case "web_hold":
      return { ...base, type: s.type, selector: s.selector, holdMs: s.holdMs ?? 1000 };
    case "web_hold_offset":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        holdFrom: s.from === "topLeft" ? "topLeft" : "centre",
        offsetX: s.x ?? 0,
        offsetY: s.y ?? 0,
        holdMs: s.holdMs ?? 1000,
      };
    case "web_drag":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        toSelector: s.toSelector ?? "",
        dragX: s.x ?? 0,
        dragY: s.y ?? 0,
        durationMs: s.durationMs ?? 600,
      };
    case "web_select":
      return { ...base, type: s.type, selector: s.selector, option: s.option };
    case "web_ai_input":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        hint: s.hint,
        maxChars: s.maxChars ?? 0,
        varName: s.varName ?? "",
      };
    case "web_if":
      return {
        ...base,
        type: s.type,
        check: s.check,
        selector: s.selector ?? "",
        text: s.text ?? "",
        negate: s.negate ?? false,
        waitMs: s.waitMs ?? 5000,
        steps: webStepsFromConfig(s.then),
        elseSteps: webStepsFromConfig(s.otherwise),
      };
    case "web_repeat":
      return {
        ...base,
        type: s.type,
        times: s.times,
        steps: webStepsFromConfig(s.steps),
        continueOnError: s.continueOnError ?? true,
        betweenMs: s.betweenMs ?? 0,
      };
    case "web_for_each":
      return {
        ...base,
        type: s.type,
        varName: s.varName,
        steps: webStepsFromConfig(s.steps),
        max: s.max ?? 0,
        continueOnError: s.continueOnError ?? true,
        betweenMs: s.betweenMs ?? 0,
      };
    case "ai_web_button":
    case "ai_web_click_xy":
      return { ...base, type: s.type, hint: s.hint ?? "" };
    case "ai_web_click_xy_multi":
      return {
        ...base,
        type: s.type,
        hint: s.hint ?? "",
        gapMs: s.gapMs ?? 500,
        max: s.max ?? 0,
        refine: s.refine ?? true,
        zoom: s.zoom ?? true,
      };
    case "ai_web_input":
      return { ...base, type: s.type, hint: s.hint ?? "", text: s.text ?? "" };
  }
}

export function webStepsFromConfig(steps: WebStep[] | undefined): WebStepForm[] {
  return (steps ?? []).map(webStepFromConfig);
}
