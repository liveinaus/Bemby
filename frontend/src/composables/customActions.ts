import type {
  CustomAction,
  CustomCondition,
  CustomConditionArm,
} from "../api/client";
import { appButtonsOf } from "./miniAppSteps";
import { proxyFields } from "./proxyPick";
import { webStepsFromConfig, webStepsToConfig, type WebStepForm } from "./webSteps";

// The custom job's action chain, as the job form and the template form both edit it. Every
// field lives on one flat object so switching an action's type does not throw away what was
// typed into the fields the other types use -- the same shape `webSteps` keeps. The exception
// is what a check holds: its arms are action forms of their own, edited one level down.

export type CustomActionType = CustomAction["type"];

export const ACTION_CMD_PRESETS = new Set(["/start", "/checkin"]);
export const ACTION_BTN_PRESETS = new Set(["签到", "{anyBtn}"]);

/** How deep checks may nest; the backend refuses a chain that goes further. */
export const MAX_ACTION_DEPTH = 3;

/** One condition an `if_check` arm asks. */
export type ConditionForm = {
  check: "reply_text" | "last_action";
  /** reply_text: words to look for, `|` separating alternatives. */
  text: string;
  /** last_action: which outcome counts as met. */
  outcome: "succeeded" | "failed";
  negate: boolean;
  /** reply_text: how long to wait for a reply. 0 reads what is already in view. */
  waitMs: number;
  scope: number;
  /** reply_text: whose chat to read. Blank reads the job's bot. */
  contact: string;
};

/**
 * A field the editor binds to an `<input type="number">`. Vue casts every such input to a
 * number whatever the modifier says, so what comes back is a number once anything is typed,
 * and the empty string while it is blank. Read one with `asText`.
 */
type NumericField = string | number;

/** The text form of a field bound to a number input, blank when it holds nothing. */
function asText(value: NumericField | null | undefined): string {
  return value == null ? "" : String(value).trim();
}

export type CustomActionForm = {
  type: CustomActionType;
  content: string;
  contentDropdown: string;
  contentCustom: string;
  contentAiInputLength: NumericField;
  /** send_command: what {aiInputWithCustomHint} should write, for a question asked in words. */
  contentAiInputHint: string;
  /** send_command: shortest answer {aiInputWithCustomHint} may come back with. Blank = any. */
  contentAiInputMinLen: NumericField;
  /** send_command: longest answer it may come back with. Blank = any. */
  contentAiInputMaxLen: NumericField;
  maxWaitMs: number;
  waitMs: number;
  /** ai_multiple_btn: pause between the clicks. */
  gapMs: number;
  button: string;
  buttonDropdown: string;
  buttonCustom: string;
  buttonAiHint: string;
  maxRetries: number;
  scope: number;
  captchaLength: NumericField;
  successContains: string;
  failContains: string;
  /** ai_multiple_btn: only a buttons message whose text contains this is picked. */
  messageContains: string;
  contact: string;
  groupId: string;
  checkMembership: boolean;
  verifyButton: string;
  verifyWaitMs: number;
  /** join_group: bounds the whole verification, private-chat hand-off included */
  verifyMaxWaitMs: number;
  /** join_group: only click a verification prompt naming this account */
  verifyMentionsMe: boolean;
  /** join_group: also accept a prompt naming this account with a masked name */
  verifyMaskedName: boolean;
  channelId: string;
  /** Mini App actions: the in-app steps, one per entry, run in order */
  appSteps: string[];
  /** Mini App actions: a step's label must be the control's whole text, not part of it */
  exactAppLabels: boolean;
  /** Mini App / open_url: browser budget, 0 = default */
  miniAppMaxWaitMs: number;
  miniAppProxyId: string;
  miniAppTryAllProxies: boolean;
  /** Ids a 'random' pick draws from; empty draws from the whole list */
  miniAppProxyPool: string[];
  profileId: string;
  /** Mini App actions: keep what the app stored last run instead of signing in afresh */
  keepAppSession: boolean;
  /** open_url: the page to open */
  url: string;
  /** open_message_url: which link to take, matched on its label and its address */
  linkText: string;
  /** open_message_url: how long to wait for a message carrying the link */
  linkWaitMs: number;
  /** open_url: sub-steps run on the page once it is up */
  webSteps: WebStepForm[];
  /** Carry on with the next action when this one fails, rather than failing the job. */
  continueOnError: boolean;
  /** if_check: the condition the `then` arm hangs off. */
  cond: ConditionForm;
  /** if_check: actions run when it holds. */
  then: CustomActionForm[];
  /** if_check: further conditions tried in order, each with actions of its own. */
  elseIfs: Array<{ cond: ConditionForm; then: CustomActionForm[] }>;
  /** if_check: actions run when nothing above held. */
  otherwise: CustomActionForm[];
  /** end_job / fail_job: what to write in the log. */
  reason: string;
};

export function defaultCondition(): ConditionForm {
  return {
    check: "reply_text",
    text: "",
    outcome: "failed",
    negate: false,
    waitMs: 0,
    scope: 0,
    contact: "",
  };
}

export function defaultAction(): CustomActionForm {
  return {
    type: "send_command",
    content: "/start",
    contentDropdown: "/start",
    contentCustom: "",
    contentAiInputLength: "",
    contentAiInputHint: "",
    contentAiInputMinLen: "",
    contentAiInputMaxLen: "",
    maxWaitMs: 30000,
    waitMs: 2000,
    gapMs: 1000,
    button: "签到",
    buttonDropdown: "签到",
    buttonCustom: "",
    buttonAiHint: "",
    maxRetries: 3,
    scope: 0,
    captchaLength: "",
    successContains: "",
    failContains: "",
    messageContains: "",
    contact: "",
    groupId: "",
    checkMembership: false,
    verifyButton: "",
    verifyWaitMs: 30000,
    verifyMaxWaitMs: 120000,
    verifyMentionsMe: false,
    verifyMaskedName: false,
    channelId: "",
    appSteps: [],
    exactAppLabels: false,
    miniAppMaxWaitMs: 300000,
    miniAppProxyId: "",
    miniAppProxyPool: [],
    miniAppTryAllProxies: true,
    profileId: "",
    keepAppSession: false,
    url: "",
    linkText: "",
    linkWaitMs: 30000,
    webSteps: [],
    continueOnError: false,
    cond: defaultCondition(),
    then: [],
    elseIfs: [],
    otherwise: [],
    reason: "",
  };
}

/**
 * Which action types may be offered at this depth. Only a check is barred, and only at the
 * cap: everything else runs the same wherever it sits.
 *
 * `keep` is the type the row already holds, always offered whatever the rules say -- opening
 * a chain saved elsewhere must not quietly rewrite an action the form would not have offered.
 */
export function offeredActionTypes(
  depth: number,
  opts: { aiMultipleBtn?: boolean; keep?: CustomActionType } = {},
): CustomActionType[] {
  const types: CustomActionType[] = [
    "send_command",
    "send_contact_message",
    "wait_reply",
    "delay",
    "click_button",
    "click_message_button",
    ...(opts.aiMultipleBtn ? (["ai_multiple_btn"] as CustomActionType[]) : []),
    "enter_captcha",
    "join_group",
    "subscribe_channel",
    "open_mini_app",
    "open_mini_app_url",
    "open_bot_menu_app",
    "open_url",
    "open_message_url",
    "end_job",
    "fail_job",
  ];
  if (depth < MAX_ACTION_DEPTH) types.push("if_check");
  if (opts.keep && !types.includes(opts.keep)) types.push(opts.keep);
  return types;
}

function conditionFromConfig(cond: CustomCondition): ConditionForm {
  return {
    check: cond.check,
    text: cond.text ?? "",
    outcome: cond.outcome ?? "failed",
    negate: cond.negate ?? false,
    waitMs: cond.waitMs ?? 0,
    scope: cond.scope ?? 0,
    contact: cond.contact ?? "",
  };
}

function conditionToConfig(cond: ConditionForm): CustomCondition {
  if (cond.check === "last_action")
    return {
      check: "last_action",
      outcome: cond.outcome,
      ...(cond.negate ? { negate: true } : {}),
    };
  return {
    check: "reply_text",
    text: cond.text.trim(),
    ...(cond.negate ? { negate: true } : {}),
    ...(cond.waitMs > 0 ? { waitMs: cond.waitMs } : {}),
    ...(cond.scope ? { scope: cond.scope } : {}),
    ...(cond.contact.trim() ? { contact: cond.contact.trim() } : {}),
  };
}

/** Turns a saved chain into the forms the editor works on. */
export function actionsFromConfig(actions: CustomAction[] | undefined): CustomActionForm[] {
  return (actions ?? []).map((a) => {
    const base = defaultAction();
    const common = { continueOnError: a.continueOnError ?? false };

    if (a.type === "send_command" || a.type === "send_contact_message") {
      const contactField = a.type === "send_contact_message" ? { contact: a.contact } : {};
      const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
      if (aiInputMatch)
        return {
          ...base,
          ...common,
          ...contactField,
          type: a.type,
          content: a.content,
          contentDropdown: "{aiInput}",
          contentCustom: "",
          contentAiInputLength: aiInputMatch[1] ?? "",
          maxRetries: a.maxRetries ?? 0,
        };
      // The hinted one, with the length range that may lead its payload. Only a leading
      // segment reading as a range counts, so a hint of its own may carry colons.
      const aiHintMatch = a.content.match(/^\{aiInputWithCustomHi(?:n)?t:([\s\S]*)\}$/);
      if (aiHintMatch) {
        const payload = aiHintMatch[1];
        const ranged = payload.match(/^\s*(\d*)-(\d*)\s*:([\s\S]*)$/);
        const ranges = ranged && (ranged[1] || ranged[2]) ? ranged : null;
        return {
          ...base,
          ...common,
          ...contactField,
          type: a.type,
          content: a.content,
          contentDropdown: "{aiInputWithCustomHint}",
          contentCustom: "",
          contentAiInputHint: (ranges ? ranges[3] : payload).trim(),
          contentAiInputMinLen: ranges?.[1] ?? "",
          contentAiInputMaxLen: ranges?.[2] ?? "",
          maxRetries: a.maxRetries ?? 0,
        };
      }
      const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : "custom";
      return {
        ...base,
        ...common,
        ...contactField,
        type: a.type,
        content: a.content,
        contentDropdown,
        contentCustom: contentDropdown === "custom" ? a.content : "",
        contentAiInputLength: "",
        contentAiInputHint: "",
        maxRetries: a.maxRetries ?? 0,
      };
    }
    if (a.type === "wait_reply")
      return {
        ...base,
        ...common,
        type: a.type,
        maxWaitMs: a.maxWaitMs,
        successContains: a.successContains ?? "",
        failContains: a.failContains ?? "",
        maxRetries: a.maxRetries ?? 0,
        scope: a.scope ?? 0,
      };
    if (a.type === "delay") return { ...base, ...common, type: a.type, waitMs: a.waitMs };
    if (a.type === "enter_captcha")
      return {
        ...base,
        ...common,
        type: a.type,
        maxWaitMs: a.maxWaitMs,
        captchaLength: String(a.captchaLength ?? ""),
        maxRetries: a.maxRetries ?? 0,
      };
    if (a.type === "join_group")
      return {
        ...base,
        ...common,
        type: a.type,
        groupId: a.groupId,
        checkMembership: a.checkMembership ?? false,
        verifyButton: a.verifyButton ?? "",
        verifyWaitMs: a.verifyWaitMs ?? 30000,
        verifyMaxWaitMs: a.verifyMaxWaitMs ?? 120000,
        verifyMentionsMe: a.verifyMentionsMe ?? false,
        verifyMaskedName: a.verifyMaskedName ?? false,
      };
    if (a.type === "subscribe_channel")
      return {
        ...base,
        ...common,
        type: a.type,
        channelId: a.channelId,
        checkMembership: a.checkMembership ?? false,
      };
    if (
      a.type === "open_mini_app" ||
      a.type === "open_mini_app_url" ||
      a.type === "open_bot_menu_app"
    )
      return {
        ...base,
        ...common,
        type: a.type,
        contact: a.contact ?? "",
        button: a.type === "open_mini_app" ? (a.button ?? "") : "",
        url: a.type === "open_mini_app_url" ? (a.url ?? "") : "",
        appSteps: [...(a.appButtons ?? [])],
        exactAppLabels: a.exactAppLabels ?? false,
        successContains: a.successContains ?? "",
        failContains: a.failContains ?? "",
        maxRetries: a.maxRetries ?? 0,
        miniAppMaxWaitMs: a.maxWaitMs ?? 0,
        miniAppProxyId: a.proxyId ?? "",
        miniAppProxyPool: [...(a.proxyPool ?? [])],
        miniAppTryAllProxies: a.tryAllProxies ?? true,
        profileId: a.profileId ?? "",
        keepAppSession: a.keepAppSession ?? false,
      };
    if (a.type === "open_url" || a.type === "open_message_url")
      return {
        ...base,
        ...common,
        type: a.type,
        url: a.type === "open_url" ? (a.url ?? "") : "",
        ...(a.type === "open_message_url"
          ? {
              contact: a.contact ?? "",
              linkText: a.linkText ?? "",
              messageContains: a.messageContains ?? "",
              scope: a.scope ?? 0,
              linkWaitMs: a.linkWaitMs ?? 30000,
            }
          : {}),
        webSteps: webStepsFromConfig(a.steps),
        successContains: a.successContains ?? "",
        failContains: a.failContains ?? "",
        maxRetries: a.maxRetries ?? 0,
        miniAppMaxWaitMs: a.maxWaitMs ?? 0,
        miniAppProxyId: a.proxyId ?? "",
        miniAppProxyPool: [...(a.proxyPool ?? [])],
        miniAppTryAllProxies: a.tryAllProxies ?? true,
        profileId: a.profileId ?? "",
      };
    if (a.type === "ai_multiple_btn")
      return {
        ...base,
        ...common,
        type: a.type,
        contact: a.contact ?? "",
        buttonAiHint: a.hint ?? "",
        messageContains: a.messageContains ?? "",
        gapMs: a.gapMs ?? 1000,
        maxRetries: a.maxRetries,
        maxWaitMs: a.maxWaitMs,
        successContains: a.successContains ?? "",
        failContains: a.failContains ?? "",
        scope: a.scope ?? 0,
      };
    if (a.type === "click_button" || a.type === "click_message_button") {
      const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
      let buttonDropdown: string,
        buttonCustom = "",
        buttonAiHint = "";
      if (aiMatch) {
        buttonDropdown = "{aiBtn}";
        buttonAiHint = aiMatch[1]?.trim() ?? "";
      } else if (ACTION_BTN_PRESETS.has(a.button)) {
        buttonDropdown = a.button;
      } else {
        buttonDropdown = "custom";
        buttonCustom = a.button;
      }
      return {
        ...base,
        ...common,
        type: a.type,
        ...(a.type === "click_message_button" ? { contact: a.contact } : {}),
        button: a.button,
        buttonDropdown,
        buttonCustom,
        buttonAiHint,
        maxRetries: a.maxRetries,
        maxWaitMs: a.maxWaitMs,
        successContains: a.successContains ?? "",
        failContains: a.failContains ?? "",
        scope: a.scope ?? 0,
      };
    }
    if (a.type === "if_check")
      return {
        ...base,
        ...common,
        type: a.type,
        cond: conditionFromConfig(a),
        then: actionsFromConfig(a.then),
        elseIfs: (a.elseIfs ?? []).map((arm) => ({
          cond: conditionFromConfig(arm),
          then: actionsFromConfig(arm.then),
        })),
        otherwise: actionsFromConfig(a.otherwise),
      };
    if (a.type === "end_job" || a.type === "fail_job")
      return { ...base, ...common, type: a.type, reason: a.reason ?? "" };
    return base;
  });
}

/** Turns the editor's forms back into the chain that is saved and run. */
export function actionsToConfig(forms: CustomActionForm[]): CustomAction[] {
  return forms.map((a) => {
    const common = a.continueOnError ? { continueOnError: true } : {};

    if (a.type === "send_command" || a.type === "send_contact_message") {
      let content: string;
      if (a.contentDropdown === "{aiInput}") {
        const length = asText(a.contentAiInputLength);
        content = length ? `{aiInput:${length}}` : "{aiInput}";
      } else if (a.contentDropdown === "{aiInputWithCustomHint}") {
        // Braces would end the placeholder early, and the range only goes in front of the
        // hint when one of its two ends was actually given
        const hint = a.contentAiInputHint.trim().replace(/[{}]/g, "");
        const min = asText(a.contentAiInputMinLen);
        const max = asText(a.contentAiInputMaxLen);
        const range = min || max ? `${min}-${max}:` : "";
        content = `{aiInputWithCustomHint:${range}${hint}}`;
      } else {
        content = a.contentDropdown === "custom" ? a.contentCustom : a.contentDropdown;
      }
      const retries = a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {};
      return a.type === "send_command"
        ? { ...common, type: "send_command" as const, content, ...retries }
        : {
            ...common,
            type: "send_contact_message" as const,
            contact: a.contact,
            content,
            ...retries,
          };
    }
    if (a.type === "wait_reply")
      return {
        ...common,
        type: "wait_reply" as const,
        maxWaitMs: a.maxWaitMs,
        ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
        ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
      };
    if (a.type === "delay")
      return { ...common, type: "delay" as const, waitMs: a.waitMs };
    if (a.type === "enter_captcha")
      return {
        ...common,
        type: "enter_captcha" as const,
        maxWaitMs: a.maxWaitMs,
        captchaLength: parseInt(asText(a.captchaLength)) || undefined,
        ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
      };
    if (a.type === "join_group")
      return {
        ...common,
        type: "join_group" as const,
        groupId: a.groupId,
        ...(a.checkMembership ? { checkMembership: true } : {}),
        ...(a.verifyButton.trim()
          ? {
              verifyButton: a.verifyButton.trim(),
              verifyWaitMs: a.verifyWaitMs,
              verifyMaxWaitMs: a.verifyMaxWaitMs,
            }
          : {}),
        ...(a.verifyMentionsMe ? { verifyMentionsMe: true } : {}),
        ...(a.verifyMaskedName ? { verifyMaskedName: true } : {}),
      };
    if (a.type === "subscribe_channel")
      return {
        ...common,
        type: "subscribe_channel" as const,
        channelId: a.channelId,
        ...(a.checkMembership ? { checkMembership: true } : {}),
      };
    if (
      a.type === "open_mini_app" ||
      a.type === "open_mini_app_url" ||
      a.type === "open_bot_menu_app"
    ) {
      const shared = {
        ...common,
        ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
        ...appButtonsOf(a.appSteps),
        ...(a.exactAppLabels ? { exactAppLabels: true } : {}),
        ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
        ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
        ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
        ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
        ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        ...(a.profileId ? { profileId: a.profileId } : {}),
        ...(a.keepAppSession ? { keepAppSession: true } : {}),
      };
      if (a.type === "open_mini_app")
        return {
          ...shared,
          type: "open_mini_app" as const,
          ...(a.button.trim() ? { button: a.button.trim() } : {}),
        };
      if (a.type === "open_mini_app_url")
        return { ...shared, type: "open_mini_app_url" as const, url: a.url.trim() };
      return { ...shared, type: "open_bot_menu_app" as const };
    }
    if (a.type === "open_url" || a.type === "open_message_url") {
      const shared = {
        ...common,
        ...(a.webSteps.length ? { steps: webStepsToConfig(a.webSteps) } : {}),
        ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
        ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
        ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
        ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
        ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
        ...(a.profileId ? { profileId: a.profileId } : {}),
      };
      if (a.type === "open_url")
        return { ...shared, type: "open_url" as const, url: a.url.trim() };
      return {
        ...shared,
        type: "open_message_url" as const,
        ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
        ...(a.linkText.trim() ? { linkText: a.linkText.trim() } : {}),
        ...(a.messageContains.trim() ? { messageContains: a.messageContains.trim() } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.linkWaitMs > 0 ? { linkWaitMs: a.linkWaitMs } : {}),
      };
    }
    if (a.type === "ai_multiple_btn")
      return {
        ...common,
        type: "ai_multiple_btn" as const,
        gapMs: a.gapMs,
        maxRetries: a.maxRetries,
        maxWaitMs: a.maxWaitMs,
        ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
        ...(a.buttonAiHint.trim() ? { hint: a.buttonAiHint.trim() } : {}),
        ...(a.messageContains.trim() ? { messageContains: a.messageContains.trim() } : {}),
        ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
        ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
      };
    if (a.type === "if_check") {
      const arms: CustomConditionArm[] = a.elseIfs.map((arm) => ({
        ...conditionToConfig(arm.cond),
        ...(arm.then.length ? { then: actionsToConfig(arm.then) } : {}),
      }));
      return {
        ...common,
        type: "if_check" as const,
        ...conditionToConfig(a.cond),
        ...(a.then.length ? { then: actionsToConfig(a.then) } : {}),
        ...(arms.length ? { elseIfs: arms } : {}),
        ...(a.otherwise.length ? { otherwise: actionsToConfig(a.otherwise) } : {}),
      };
    }
    if (a.type === "end_job" || a.type === "fail_job")
      return {
        ...common,
        type: a.type,
        ...(a.reason.trim() ? { reason: a.reason.trim() } : {}),
      };

    let button: string;
    if (a.buttonDropdown === "custom") button = a.buttonCustom;
    else if (a.buttonDropdown === "{aiBtn}")
      button = a.buttonAiHint.trim() ? `{aiBtn:${a.buttonAiHint.trim()}}` : "{aiBtn}";
    else button = a.buttonDropdown || "签到";
    const clickShared = {
      ...common,
      button,
      maxRetries: a.maxRetries,
      maxWaitMs: a.maxWaitMs,
      ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
      ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
      ...(a.scope ? { scope: a.scope } : {}),
    };
    return a.type === "click_message_button"
      ? { ...clickShared, type: "click_message_button" as const, contact: a.contact }
      : { ...clickShared, type: "click_button" as const };
  });
}
