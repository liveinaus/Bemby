import axios from "axios";
import { ref } from "vue";

export const api = axios.create({ baseURL: "/api" });

// Credential for addresses the browser loads by itself (see tgClientApi.photoUrl). Renewed
// a little before it lapses so an image never asks with an expired one.
//
// A ref rather than a plain variable: photoUrl() is called from a template, so an <img>
// rendered before the ticket arrives has to be re-evaluated once it does. A bare `let` is
// invisible to Vue and those images would stay pointed at a ticket-less address for good.
const TICKET_REFRESH_MARGIN_MS = 60_000;
const mediaTicket = ref("");
let mediaTicketExpiry = 0;

function readRequirePwdChangeClaim(): boolean {
  const token = localStorage.getItem("token");
  if (!token) return false;
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return payload.requirePasswordChange === true;
  } catch {
    return false;
  }
}

// Reactive signal -- true when the active JWT has requirePasswordChange set.
// Shared between LoginView (sets it on login) and App.vue (watches it to show the modal).
export const requirePasswordChangeSignal = ref(readRequirePwdChangeClaim());

// Attach stored token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * A 401 from one of these means "those credentials are wrong", not "your session has
 * expired", so it belongs to the form that asked and must be left for it to display.
 *
 * Sending them through the redirect below reloaded the whole page on every failed sign-in,
 * which threw away the error before it could render: to the person typing, the login screen
 * simply refreshed itself, over and over, saying nothing about what was wrong. The same
 * applied to a wrong current password in Settings, which logged the operator out rather
 * than telling them they had mistyped it.
 */
function isCredentialCheck(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return (
    path.endsWith("/auth/login") ||
    path.endsWith("/auth/captcha") ||
    path.endsWith("/auth/credentials")
  );
}

// Redirect to login on 401; surface force-password-change on 403
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && !isCredentialCheck(err.config?.url)) {
      localStorage.removeItem("token");
      mediaTicket.value = "";
      mediaTicketExpiry = 0;
      // Already on the login screen, a reload only loses whatever it was showing
      if (window.location.pathname !== "/login") window.location.href = "/login";
    }
    if (
      err.response?.status === 403 &&
      err.response?.data?.requirePasswordChange
    ) {
      requirePasswordChangeSignal.value = true;
    }
    return Promise.reject(err);
  },
);

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthStatus =
  | "unauthenticated"
  | "pending_code"
  | "pending_2fa"
  | "authenticated"
  | "session_expired";

export type TgAppClient = {
  id: string;
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
  isDefault: boolean;
};

// ── Server-side list paging ──────────────────────────────────────────────────

export type Paged<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type ListParams = {
  page: number;
  pageSize: number;
  search?: string;
  sortKey?: string;
  sortDir?: "asc" | "desc";
};

// Drops empty/undefined values so query strings stay clean
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
}

export type Account = {
  id: number;
  name: string;
  phoneNumber: string;
  apiId: number;
  authStatus: AuthStatus;
  proxyId: string | null;
  disabled: boolean;
  appClientId: string | null;
  createdAt: string;
  sortOrder: number;
  tgDisplayName: string | null;
  tgUsername: string | null;
  notes: string | null;
  /** Device model Telegram sees, with template variables expanded (server-computed, read-only). */
  resolvedDeviceModel?: string | null;
  /** Generic per-account flags bag (UI-safe; never contains the passkey secret). */
  attributes?: Record<string, unknown>;
  /** True when the Telegram account has any passkey (any device/origin). */
  hasPasskey?: boolean;
  /** True when Bemby holds a stored passkey (key + known DC) usable for login. */
  hasBembyPasskey?: boolean;
};

export type BulkAddItemStatus =
  | "pending"
  | "requesting_code"
  | "fetching_code"
  | "submitting_code"
  | "submitting_2fa"
  | "waiting"
  | "created"
  | "skipped"
  | "retrying"
  | "done"
  | "failed";

export type BulkAddOptions = {
  gapSeconds?: number;
  namePrefix?: string;
  nameIndexMode?: "total" | "batch";
  namePadDigits?: number;
  notesTemplate?: string;
  codeFieldId?: string;
  codeRegex?: string;
  twoFaMode?: "api" | "fixed";
  twoFaFieldId?: string;
  twoFaRegex?: string;
  twoFaFixed?: string;
  deviceIds?: string[];
  proxyIds?: string[];
  apiCredentials?: { apiId: number; apiHash: string }[];
  maxRetries?: number;
  retryDelaySeconds?: number;
};

export type BulkAddItem = {
  index: number;
  phoneNumber: string;
  apiUrl: string;
  accountId: number | null;
  accountName: string | null;
  existing: boolean;
  attempts: number;
  status: BulkAddItemStatus;
  message: string;
  error: string | null;
};

export type BulkAddBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  total: number;
  items: BulkAddItem[];
};

export type BulkProfileItemStatus =
  | "pending"
  | "updating"
  | "waiting"
  | "retrying"
  | "done"
  | "failed";

export type BulkProfileEntry = {
  accountId: number;
  // Optional only when the batch is setting avatars or usernames: there is then
  // nothing to write to the name fields, and Telegram rejects a blank first name.
  firstName?: string;
  lastName?: string;
  about?: string;
  username?: string;
};

/** Where a random profile photo is drawn from; "any" prefers the pool. */
export type AvatarSourceMode = "pool" | "online" | "any";

export type BulkProfileOptions = {
  gapSeconds?: number;
  maxRetries?: number;
  retryDelaySeconds?: number;
  avatarSource?: AvatarSourceMode;
};

export type BulkProfileItem = {
  index: number;
  accountId: number;
  accountName: string;
  firstName: string;
  lastName: string;
  about: string;
  username: string;
  attempts: number;
  status: BulkProfileItemStatus;
  message: string;
  error: string | null;
  avatar: string | null;
};

export type AvatarPoolStatus = {
  dir: string;
  count: number;
  online: boolean;
  styles: number;
};

export type BulkProfileBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  total: number;
  items: BulkProfileItem[];
};

// The account's own editable Telegram profile
export type TgOwnProfile = {
  firstName: string;
  lastName: string;
  about: string;
  username: string;
};

export type PasswordInfo = {
  hasPassword: boolean;
  hasRecovery: boolean;
  hint: string | null;
  emailUnconfirmedPattern: string | null;
  loginEmailPattern: string | null;
};

export type Passkey = {
  id: string;
  name: string;
  date: number;
  softwareEmojiId: string | null;
  lastUsageDate: number | null;
};

export type PasskeySecret = {
  telegramPasskeyId: string;
  credentialId: string;
  privateKeyPem: string;
  rpId: string;
  userHandle: string;
  createdDate: number;
  dcId?: number;
  serverAddress?: string;
  port?: number;
};

export type AccountExportItem = {
  name: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString: string | null;
  authStatus: string;
  proxyId: string | null;
  appClientId: string | null;
  disabled: boolean;
  /** Operator-authored fields; absent in backups written before they were exported. */
  notes?: string | null;
  sortOrder?: number | null;
  tgDisplayName?: string | null;
  tgUsername?: string | null;
  passkey: PasskeySecret | null;
  additionalAttributes: Record<string, unknown> | null;
};

export type AccountExportPayload = {
  version: "1";
  exportedAt: string;
  accounts: AccountExportItem[];
};

export type SessionInfo = {
  hash: string;
  current: boolean;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  appName: string;
  appVersion: string;
  dateCreated: number;
  dateActive: number;
  ip: string;
  country: string;
  region: string;
};

export type TgSpamStatus = {
  spamStatus: "free" | "limited" | "blocked" | "frozen" | "unknown";
  rawMessage: string;
  /** Reply-keyboard labels SpamBot offered; the shape is the same in every language. */
  buttons?: string[];
  source?: "signature" | "buttons" | "text" | "ai" | "unknown";
  aiError?: string;
};

export type TgAccountStatus = {
  isActive: boolean;
  isDeleted: boolean;
  isRestricted: boolean;
  restrictions: Array<{ platform: string; reason: string; text: string }>;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  markWatched?: boolean;
  verifyPlayable?: boolean;
  realWatch?: boolean;
  sequencePlay?: boolean;
  library?: string;
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
  ignoreSslErrors?: boolean;
};

export type ProxyStatus = "ok" | "failed";

export type Proxy = {
  id: string;
  name: string;
  url: string;
  /**
   * Whether an unnamed random draw and a Cloudflare fall-through may reach for this exit.
   * Absent means yes. Tunnel exits imported from a subscription set it false.
   */
  autoPool?: boolean;
  /**
   * Turned off by hand. No test sets or clears it, and tests skip the exit entirely, so it
   * comes back only when the operator says so.
   */
  disabled?: boolean;
  /** What the last test made of it. `failed` disables the exit; absent means never tested. */
  status?: ProxyStatus;
  /** When that test ran, epoch ms. */
  testedAt?: number;
  testMs?: number;
  testError?: string;
};

/** One thing a test asked of an exit: `reach`, `cloudflare`, or `extra`. */
export type ProxyCheck = {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
};

export type ProxyTestResult = {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  /** Round trip of the SOCKS connect, in ms. */
  ms: number;
  checks?: ProxyCheck[];
  /** Address the exit comes out on, when the Cloudflare check read it back. */
  exitIp?: string;
};

/**
 * What an `if_check` asks. `reply_text` reads the chat -- what is already in view, or, when
 * given a wait, whatever arrives before it runs out. `last_action` asks how the action before
 * the check came out, which is what pairs with `continueOnError`.
 */
export type CustomCondition = {
  check: "reply_text" | "last_action";
  /** Words to look for, for `reply_text`. `|` separates alternatives. */
  text?: string;
  /** Which outcome counts as met, for `last_action`. Defaults to `failed`. */
  outcome?: "succeeded" | "failed";
  /** Take this arm when the condition is *not* met. */
  negate?: boolean;
  /** How long to give a reply that has yet to arrive. Blank/0 reads what is in view. */
  waitMs?: number;
  /** Messages considered, relative to the last one sent. */
  scope?: number;
  /** Whose chat to read. Blank reads the job's bot. */
  contact?: string;
};

/** One `else if` arm: a condition of its own and the actions it runs. */
export type CustomConditionArm = CustomCondition & { then?: CustomAction[] };

/** What every action carries, whatever its type. */
type CustomActionCommon = {
  /** Carry on with the next action when this one fails, rather than failing the job. */
  continueOnError?: boolean;
};

export type CustomAction = CustomActionCommon &
  (
  | { type: "send_command"; content: string; maxRetries?: number }
  | {
      type: "send_contact_message";
      contact: string;
      content: string;
      maxRetries?: number;
    }
  | {
      type: "wait_reply";
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      scope?: number;
    }
  | { type: "delay"; waitMs: number }
  | {
      type: "click_button";
      button: string;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
    }
  | {
      type: "click_message_button";
      contact: string;
      button: string;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
    }
  | {
      type: "ai_multiple_btn";
      contact?: string;
      hint?: string;
      /** Only a buttons message whose text contains this is picked */
      messageContains?: string;
      gapMs: number;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
    }
  | {
      type: "enter_captcha";
      maxWaitMs: number;
      captchaLength?: number;
      maxRetries?: number;
    }
  | {
      type: "join_group";
      groupId: string;
      checkMembership?: boolean;
      verifyButton?: string;
      verifyWaitMs?: number;
      /** Bounds the whole verification, including a hand-off to the bot's private chat */
      verifyMaxWaitMs?: number;
      /** Only click a verification prompt naming this account */
      verifyMentionsMe?: boolean;
      /** Also accept a prompt naming this account with a masked name ("阿**2") */
      verifyMaskedName?: boolean;
    }
  | {
      /** Mini App opened at a given address rather than one found on a button. */
      type: "open_mini_app_url";
      url: string;
      /** Bot that owns the app, used to sign the URL. Blank uses the job's bot. */
      contact?: string;
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      maxWaitMs?: number;
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares: a name built from
       * {ip}, {jobId}, {templateId}, {tgId} and any text. Blank takes the Settings default.
       */
      profileId?: string;
      /**
       * Keep what the app itself stored in the profile last run. Off by default, so the
       * signed init data is the only account the app can see.
       */
      keepAppSession?: boolean;
    }
  | {
      /** The Mini App a bot pins beside the composer, opened without naming an address. */
      type: "open_bot_menu_app";
      /** Bot whose menu button to open. Blank uses the job's bot. */
      contact?: string;
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      maxWaitMs?: number;
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares: a name built from
       * {ip}, {jobId}, {templateId}, {tgId} and any text. Blank takes the Settings default.
       */
      profileId?: string;
      /**
       * Keep what the app itself stored in the profile last run. Off by default, so the
       * signed init data is the only account the app can see.
       */
      keepAppSession?: boolean;
    }
  | {
      type: "open_mini_app";
      contact?: string;
      button?: string;
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part, across every proxy tried. 0/blank uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy id, or "direct". Blank uses the job proxy. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares: a name built from
       * {ip}, {jobId}, {templateId}, {tgId} and any text. Blank takes the Settings default.
       */
      profileId?: string;
      /**
       * Keep what the app itself stored in the profile last run. Off by default, so the
       * signed init data is the only account the app can see.
       */
      keepAppSession?: boolean;
    }
  | {
      type: "open_url";
      url: string;
      steps?: WebStep[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part, across every proxy tried. 0/blank uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy id, or "direct". Blank uses the job proxy. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares: a name built from
       * {ip}, {jobId}, {templateId}, {tgId} and any text. Blank takes the Settings default.
       */
      profileId?: string;
    }
  | { type: "subscribe_channel"; channelId: string; checkMembership?: boolean }
  | ({
      /**
       * Run one set of actions or another, going on what the run has just seen -- the way a
       * chain proves for itself whether a flaky step really failed.
       */
      type: "if_check";
      /** Actions run when the condition holds. */
      then?: CustomAction[];
      /** Further conditions tried in order when it does not, each with actions of its own. */
      elseIfs?: CustomConditionArm[];
      /** Actions run when neither the condition nor any of `elseIfs` held. */
      otherwise?: CustomAction[];
    } & CustomCondition)
  | {
      /** Stop the chain here and call the run a success, whatever comes after it. */
      type: "end_job";
      reason?: string;
    }
  | {
      /** Stop the chain here and fail the attempt, retried like any other failure. */
      type: "fail_job";
      reason?: string;
    }
  );

/** One sub-step of `open_url`, run against the loaded page. */
export type WebStep =
  | { type: "web_input"; selector: string; text: string }
  | { type: "web_button"; selector: string }
  | { type: "web_delay"; waitMs: number }
  | { type: "web_scroll"; x?: number; y?: number }
  | { type: "web_scroll_to"; selector: string; waitMs?: number }
  | { type: "web_wait_element"; selector: string; waitMs?: number }
  | { type: "web_turnstile" }
  | {
      type: "web_if";
      check: "element" | "text" | "url" | "value";
      selector?: string;
      text?: string;
      /** What to test, for `value`: `{name}` or `{data.folder.key}`. */
      value?: string;
      negate?: boolean;
      waitMs?: number;
      then?: WebStep[];
      otherwise?: WebStep[];
    }
  | {
      type: "web_repeat";
      times: number;
      steps?: WebStep[];
      continueOnError?: boolean;
      betweenMs?: number;
    }
  | {
      type: "web_for_each";
      /** Name of the collected list to work through. */
      varName: string;
      steps?: WebStep[];
      /** Stop after this many values. Blank/0 works through the whole list. */
      max?: number;
      continueOnError?: boolean;
      betweenMs?: number;
    }
  | {
      type: "web_pick";
      selector: string;
      varName: string;
      attribute?: string;
      pattern?: string;
      /** Only consider candidates whose own text contains this. */
      containsText?: string;
      choose?: "first" | "random";
      skipUsed?: boolean;
    }
  | {
      /** Read every match into a named list, for a `web_for_each` to work through. */
      type: "web_collect";
      selector: string;
      varName: string;
      attribute?: string;
      pattern?: string;
      containsText?: string;
      /** Keep at most this many, in page order. Blank/0 keeps everything. */
      limit?: number;
      skipUsed?: boolean;
    }
  | {
      /** Hold values of your own under names, for later steps to use as {name}. */
      type: "web_set";
      /** Set in order, so one may be built out of those above it. */
      vars?: Array<{ name: string; value: string }>;
      /** The one pair a config saved before `vars` carries. */
      varName?: string;
      value?: string;
    }
  | {
      /** Send a message through the notification bot mid-run, with {name} filled in. */
      type: "web_notify";
      text: string;
      /** Chat to send to. Blank uses the one set in Settings. */
      target?: string;
    }
  | {
      type: "web_read";
      selector: string;
      varName: string;
      maxChars?: number;
      /** Keep what was read out of the log, for a value that is a login in its own right. */
      secret?: boolean;
    }
  | {
      /**
       * Read a record out of the data store into a name. The same value is readable inline as
       * {data.folder.key} in any text field; the step is what a job wants when the value has
       * to reach a selector, or when the run should stop if nothing is stored.
       */
      type: "web_data_read";
      folder: string;
      key: string;
      /** Field inside the record's value. Blank reads the whole record. */
      path?: string;
      varName: string;
      /** Carry on with nothing stored, rather than failing the step. */
      optional?: boolean;
    }
  | {
      /**
       * Take a record by its place in a folder, oldest first, rather than by its key: a folder
       * kept as a queue. The record's own key lands in a name, which is what a later delete
       * step needs to move the queue on.
       */
      type: "web_data_pick";
      folder: string;
      /** Which one, counting from 0. Takes {name}. Blank means 0. */
      index?: string;
      /** Name to hold the record's key under. */
      varName: string;
      /** Name to hold its value under. Blank reads the key alone. */
      valueVar?: string;
      /** Field inside the value. Blank takes the whole value. */
      path?: string;
      optional?: boolean;
    }
  | {
      /** Write a value to the data store, making the folder and the record if need be. */
      type: "web_data_save";
      folder: string;
      key: string;
      /** Field inside the record's value. Blank replaces the whole record. */
      path?: string;
      /** Text that reads as JSON is stored as JSON. Takes {name} and {data.folder.key}. */
      value: string;
    }
  | {
      /** Remove a record from the data store, or one field of it. */
      type: "web_data_delete";
      folder: string;
      key: string;
      path?: string;
      optional?: boolean;
    }
  | {
      /**
       * Read a verification code out of a mailbox and hold it under a name. Gmail over IMAP,
       * or the msOauth2api mailbox a `web_email_lease` took. The app password is not stored
       * here: `appPassword` names a secret set in Settings, written {gmailAppPassword}, and
       * only the backend ever reads its value; the msOauth2api key is a setting.
       */
      type: "web_email_code";
      /** Where to read from; blank is Gmail. */
      source?: "gmail" | "msapi";
      email: string;
      appPassword?: string;
      /** msOauth2api pool type; blank uses the configured default. */
      poolType?: string;
      varName: string;
      fromContains?: string;
      subjectContains?: string;
      /** Expression pulling the code out; group 1 wins. Blank looks for a digit run. */
      pattern?: string;
      /** How long to wait for the mail. Blank/0 waits 120s. */
      waitMs?: number;
    }
  | {
      /**
       * Take an address from the msOauth2api pool and hold it under a name, for a signup form
       * to type and a later `web_email_code` to read the code from.
       */
      type: "web_email_lease";
      varName: string;
      /** Pool type to lease from, e.g. Telegram. Blank uses the configured default. */
      poolType?: string;
    }
  | {
      /**
       * Point this job at another template and rename it: what a job that exists to register an
       * account does last, so the same row carries on as that account's daily job. It keeps its
       * id, so a record filed under `{jobId}` is still the one the new template reads.
       */
      type: "web_job_handover";
      /** The template to run from now on: its name, or its id. */
      template: string;
      /** What to call the job now. Blank keeps its name. */
      name?: string;
      /** Whether it runs on the schedule from now on. Left out, its own setting stands. */
      enabled?: boolean;
    }
  | {
      /**
       * Find the enrolment secret on a two-factor setup page and hold it under a name, for a
       * `web_data_save` to keep and a `web_totp` to work codes out of. Needs no selector: every
       * attribute and the page text are searched, an `otpauth://` URL first and the printed
       * base32 secret second.
       */
      type: "web_otp_secret";
      varName: string;
      /** Only look inside this element. Blank asks the whole page. */
      selector?: string;
      /** How long to give the page to draw it. Blank/0 waits 15s. */
      waitMs?: number;
    }
  | {
      /**
       * Work out the code an authenticator app would be showing and hold it under a name, for a
       * login guarded by two-factor authentication to type. The secret is read from the data
       * store rather than typed in here, and a code with little of its window left is passed
       * over in favour of the next one.
       */
      type: "web_totp";
      /** Where the secret is, e.g. `{data.example.{jobId}.otp}`: an `otpauth://` URL or base32. */
      secretRef: string;
      varName: string;
      /** Wait for the next code when this much is not left. Blank waits under 10s. */
      minValidMs?: number;
    }
  | {
      /**
       * Wait for the login code Telegram delivers to this account and hold it under a name.
       * Read off Telegram's own service chat on the account the job belongs to, which is where
       * my.telegram.org posts its code -- so the step needs no address of its own.
       */
      type: "web_tg_code";
      varName: string;
      /** Expression pulling the code out; group 1 wins. Blank looks for a 5-6 digit run. */
      pattern?: string;
      /** How long to wait for the message. Blank/0 waits 180s. */
      waitMs?: number;
    }
  | {
      /**
       * Send a message as the account this job belongs to, with the page still open: a site's
       * linking command has to come from the account itself.
       */
      type: "web_tg_send";
      /** Who to send to: @username, a t.me link, or a numeric id. */
      contact: string;
      /** The message, with `{name}` filled in, e.g. `/start join_{joinCode}`. */
      text: string;
      /** Carry on only once the reply holds one of these (`|` separated). */
      replyContains?: string;
      /** Name to hold the reply text under. */
      varName?: string;
      /** How long to wait for the reply. Blank/0 waits 60s. */
      waitMs?: number;
    }
  | {
      /**
       * Write an api_id/api_hash pair onto the account this job belongs to, the hash
       * encrypted as every other login is. Anything that does not look like a pair is refused.
       */
      type: "web_tg_api_save";
      apiId: string;
      apiHash: string;
      /** Data-store folder to keep a copy in. Blank writes to the account alone. */
      folder?: string;
      /** Record key inside that folder. Blank uses the account's phone number. */
      key?: string;
    }
  | {
      /**
       * Trade the sign-in the browser has just completed for an OAuth2 refresh token. Run it
       * on the redirect address, where the one-time code sits in the query string; the
       * exchange happens on the backend, which holds the client secret.
       */
      type: "web_ms_oauth2";
      /** Name to hold the refresh token under. */
      varName: string;
      /** Sign-in authority: `common`, `consumers`, or a tenant id. */
      tenant?: string;
      /** Application (client) id. Blank takes the one set in Settings. */
      clientId?: string;
      /** Secret holding the client secret, e.g. `{msOauthClientSecret}`. */
      clientSecret?: string;
      /** Redirect address the app is registered with. */
      redirectUri?: string;
      /** Scopes to ask the token for. Blank takes what the sign-in consented to. */
      scope?: string;
      /** Where the code is. Blank reads the address the browser is on. */
      codeFrom?: string;
      /** Data-store folder to write the token to. Blank holds it under the name alone. */
      folder?: string;
      /** Record key inside that folder, e.g. `{email}`. */
      key?: string;
      /** Field inside the record, e.g. `refreshToken`. */
      path?: string;
      /** Hold the access token under this name too. */
      accessVar?: string;
    }
  | { type: "web_goto"; url: string; waitMs?: number }
  | { type: "web_back"; waitMs?: number }
  | {
      /** Hold the pointer down on something and let go after a while. */
      type: "web_hold";
      selector: string;
      /** How long to keep it down. Blank/0 holds 1s. */
      holdMs?: number;
    }
  | {
      /**
       * Press and hold at a point measured from an element, without pressing the element
       * itself. The point is drawn on this step's screenshot so the offset can be corrected.
       */
      type: "web_hold_offset";
      selector: string;
      /** Where on the anchor the offset starts. Defaults to its centre. */
      from?: "centre" | "topLeft";
      x?: number;
      y?: number;
      /** How long to keep it down. Blank/0 holds 1s. */
      holdMs?: number;
    }
  | {
      /** Press on something, drag it to a target or by a distance, and let go. */
      type: "web_drag";
      selector: string;
      /** Where to drop it. Blank drags by the offset below instead. */
      toSelector?: string;
      x?: number;
      y?: number;
      /** How long the drag itself takes. Blank/0 takes 600ms. */
      durationMs?: number;
    }
  | {
      /** Press a key, e.g. to send a box that has no button. Blank selector uses the focus. */
      type: "web_press";
      key: string;
      selector?: string;
    }
  | { type: "web_select"; selector: string; option: string }
  | {
      /** AI writes what belongs in the field this selector names, and types it. */
      type: "web_ai_input";
      selector: string;
      hint: string;
      maxChars?: number;
      varName?: string;
    }
  | { type: "ai_web_button"; hint?: string }
  | { type: "ai_web_click_xy"; hint?: string }
  | {
      /** AI gives back several positions, each clicked in turn with a pause between. */
      type: "ai_web_click_xy_multi";
      hint?: string;
      /** Pause between clicks. Blank/0 waits 500ms. */
      gapMs?: number;
      /** Click at most this many. Blank/0 takes what the AI gives, up to 20. */
      max?: number;
      /** Check each position with a close-up second look. Defaults to true. */
      refine?: boolean;
      /** Take the wide look at the captcha panel alone, ruled finely. Defaults to true. */
      zoom?: boolean;
    }
  | { type: "ai_web_input"; hint?: string; text?: string };

/** What one `open_url` sub-step did, with the page as it looked afterwards. */
export type WebStepLog = {
  type: WebStep["type"];
  label: string;
  /** Which round of a `web_for_each` this step belongs to, e.g. `2/5 859148`. */
  iteration?: string;
  outcome?: string;
  error?: string;
  screenshot?: string;
  aiPrompt?: string;
  aiResponse?: string;
  /** The ruled or marked-up pictures the model was shown, in the order of the passes. */
  aiImages?: string[];
};

export type CustomConfig = {
  actions: CustomAction[];
  maxRetries?: number;
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type CheckinConfig = {
  successContains?: string;
  failContains?: string;
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type AutoregConfig = {
  groupId: string;
  codePrefix: string;
  /** Matches codes with no stable prefix; capture group 1 is the code. Replaces codePrefix. */
  codeRegex?: string;
  /** Strip Chinese characters and punctuation out of a code before sending. */
  stripChinese?: boolean;
  /** Characters to strip out of a code before sending, e.g. `~*`. */
  stripChars?: string;
  /** Have the AI adjust each code before sending, going on the surrounding chat. */
  aiModifyCode?: boolean;
  aiModifyCodeHint?: string;
  aiContextCount?: number;
  /** Bot text meaning it is ready for a code, waited for after the register button. */
  codeReadyContains?: string;
  /** Bot text meaning it is ready for the username, waited for after a code is accepted. */
  usernameReadyContains?: string;
  registerButton?: string;
  /** Click a button or t.me link on the bot's reply once a code is accepted. */
  clickAfterCode?: boolean;
  /** Text of that button or link (partial match); blank takes the sole/first one. */
  afterCodeButton?: string;
  /** On, a reply with no such button spends the code and the next one is tried. */
  afterCodeRequired?: boolean;
  signupUsername: string;
  listenMinutes?: number;
  scanHistoryCount?: number;
  entryMode?: "button" | "command";
  successContains?: string;
  failContains?: string;
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type CustomStepLog = {
  step: number;
  actionType: string;
  label: string;
  /** How many `if_check` branches this action sat inside; absent at the top level. */
  depth?: number;
  /** The action failed but was marked to carry on, so the chain went past it. */
  continued?: boolean;
  preClickHtml?: string;
  preClickImage?: string;
  preClickButtons?: string[][];
  preClickHasMedia?: boolean;
  clickedButton?: string;
  responseHtml?: string;
  responseImage?: string;
  responseButtons?: string[][];
  responseHasMedia?: boolean;
  callbackAnswer?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  aiPrompt?: string;
  aiResponse?: string;
  aiDurationMs?: number;
  aiRetries?: string[];
  // Dev fields
  msgCount?: number;
  responseSource?: "edit" | "new_message";
  retryCount?: number;
  errorName?: string;
  /** 1-based job attempt number (only set when job maxRetries > 1) */
  jobAttempt?: number;
  /** 1-based action attempt number (only set when action maxRetries > 0) */
  actionAttempt?: number;
  // Browser (Cloudflare / Mini App) fields
  cfHost?: string;
  cfChallenged?: boolean;
  cfPassed?: boolean;
  cfMiniApp?: boolean;
  cfMiniAppSigned?: boolean;
  cfMiniAppAction?: string;
  cfProxy?: string;
  /** Which browser build ran the step: the licensed one, or the free fallback. */
  cfBuild?: "keyed" | "free";
  /** The browser profile the step ran on, i.e. whose cookies it had. */
  cfProfile?: string;
  /** The device fingerprint seed it ran on; it moves only where the profile does. */
  cfDevice?: number;
  /** The locale it reported, and whether that was pinned in Settings or came from the exit. */
  cfLocale?: string;
  cfLocalePinned?: boolean;
  cfAttempts?: number;
  cfPageTitle?: string;
  cfNavError?: string;
  cfTrace?: string[];
  /** Screenshot of the page the browser ended up on. */
  cfScreenshot?: string;
  /** For open_url: one entry per sub-step run on the page, in order. */
  webSteps?: WebStepLog[];
};

export type JobProxyKind = "direct" | "proxy" | "provider" | "random";

/** Which of the three settings a job's exit came from. */
export type JobProxySource = "job" | "template" | "account";

/**
 * The exit a job leaves by, worked out from the job, its template and its account. A pool is
 * named by its supplier or counted rather than listed out.
 */
export type JobProxy = {
  kind: JobProxyKind;
  /** Exit or supplier name; empty for `direct` and for an unnamed draw. */
  label: string;
  source: JobProxySource;
  /** Exits a draw may reach. Absent for a pinned exit and for direct. */
  poolSize?: number;
  /** The account's own exit, named only when the job or template overrides it. */
  tgLabel?: string;
  /** Set when the exit named here is no longer in the proxy list, so `label` is a bare id. */
  missing?: boolean;
  /** The same, for the account's exit in `tgLabel`. */
  tgMissing?: boolean;
};

export type Job = {
  id: number;
  name: string;
  accountId: number | null;
  accountName?: string;
  jobType: "checkin" | "embywatch" | "custom" | "autoreg";
  /** checkin: Telegram bot username. embywatch: Emby server URL */
  botUsername: string;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  createdAt: string;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  templateId?: number | null;
  runEveryDays: number;
  runEveryDaysMax?: number | null;
  retired?: string | null;
  /** ISO timestamp of the last successful run; null when it has never succeeded */
  lastSuccessAt?: string | null;
  /** Icon-font class name, or "custom:<file>" for an uploaded one; null uses the default. */
  icon?: string | null;
  /** Exit the job leaves by; sent with list responses only. */
  effectiveProxy?: JobProxy;
};

export type JobTemplate = {
  id: number;
  name: string;
  jobType: "checkin" | "embywatch" | "custom" | "autoreg";
  botUsername: string;
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  createdAt: string;
  linkedJobCount?: number;
  runEveryDays: number;
  runEveryDaysMax?: number | null;
  /** Icon jobs created from this template start with; see Job.icon. */
  icon?: string | null;
};

/** A custom icon an operator uploaded, ready to render. */
export type JobIcon = {
  name: string;
  size: number;
  dataUrl: string;
};

// Why Real Watch pulled no bytes, when the toggle was on.
export type RealWatchNote = "no-stream-url" | "stream-failed";

export type EmbywatchEpisode = {
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeSeconds: number;
  startSeconds: number;
  endSeconds: number;
  watchedSeconds: number;
  markedWatched: boolean;
  streamedBytes?: number;
  realWatchNote?: RealWatchNote;
  realWatchTranscoded?: boolean;
};

export type EmbywatchLog = EmbywatchEpisode & {
  sequencePlay?: boolean;
  episodesCompleted?: number;
  episodes?: EmbywatchEpisode[];
};

export type CheckinAttemptLog = {
  attempt: number;
  commandSent: string;
  hasMedia: boolean;
  commandResponseHtml: string;
  commandResponseImages?: string[];
  availableButtons: string[][];
  buttonClicked?: string;
  callbackAnswer?: string;
  buttonResponseHtml?: string;
  buttonResponseHasMedia?: boolean;
  buttonResponseImage?: string;
  buttonResponseButtons?: string[][];
  aiDurationMs?: number;
  aiPrompt?: string;
  aiResponse?: string;
  aiRetries?: string[];
  error?: string;
  // Dev timing fields
  connectMs?: number;
  replyLatencyMs?: number;
  buttonClickMs?: number;
  buttonResponseMs?: number;
  buttonResponseSource?: "edit" | "new_message";
  totalMs?: number;
  replyTimeoutMs?: number;
  errorName?: string;
};

export type Log = {
  id: number;
  jobId: number;
  jobName: string | null;
  jobType: string | null;
  accountName: string | null;
  ranAt: string;
  status: "success" | "failed" | "running";
  message: string | null;
  retired: boolean;
  detail?:
    CheckinAttemptLog[] | EmbywatchLog[] | { steps: CustomStepLog[] } | null;
};

export type ScheduleStatus = {
  jobId: number;
  jobName: string;
  /** checkin | embywatch | custom | autoreg -- drives the icon and colour on the chip. */
  jobType: string;
  nextRun: string;
  /** The job's own icon; null falls back to the type glyph. */
  icon?: string | null;
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  getCaptcha: () =>
    api
      .get<{ svg: string; captchaToken: string }>("/auth/captcha")
      .then((r) => r.data),
  login: (
    username: string,
    password: string,
    captchaToken: string,
    captchaAnswer: string,
  ) =>
    api
      .post<{
        token: string;
        requirePasswordChange?: boolean;
      }>("/auth/login", { username, password, captchaToken, captchaAnswer })
      .then((r) => r.data),
  changeCredentials: (
    currentPassword: string,
    username?: string,
    newPassword?: string,
  ) =>
    api
      .put<{
        message: string;
        token?: string;
      }>("/auth/credentials", { currentPassword, username, newPassword })
      .then((r) => r.data),
  // Retires every session token issued so far. The reply carries a new one for this tab,
  // so signing everyone else out does not sign the operator out of the page they did it on.
  revokeSessions: () =>
    api
      .post<{ message: string; token: string }>("/auth/revoke-sessions")
      .then((r) => r.data),
};

// ── Accounts ─────────────────────────────────────────────────────────────────

export const accountsApi = {
  list: () => api.get<Account[]>("/accounts").then((r) => r.data),
  listPaged: (
    params: ListParams & { authStatus?: string; disabled?: "0" | "1" | "" },
  ) =>
    api
      .get<Paged<Account>>("/accounts", { params: cleanParams(params) })
      .then((r) => r.data),
  create: (
    data: Omit<
      Account,
      | "id"
      | "authStatus"
      | "createdAt"
      | "disabled"
      | "sortOrder"
      | "tgDisplayName"
      | "tgUsername"
    > & {
      apiHash: string;
    },
  ) => api.post<Account>("/accounts", data).then((r) => r.data),
  update: (
    id: number,
    data: Partial<Account> & { apiHash?: string; proxyId?: string | null },
  ) => api.put<Account>(`/accounts/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/accounts/${id}`),
  requestCode: (id: number) =>
    api
      .post<{
        method: "passkey" | "code";
        step?: "2fa" | "done";
        message?: string;
        isCodeViaApp?: boolean;
      }>(`/accounts/${id}/auth/request`)
      .then((r) => r.data),
  resendCode: (id: number) =>
    api.post(`/accounts/${id}/auth/resend`).then((r) => r.data),
  verify: (id: number, data: { code?: string; password?: string }) =>
    api
      .post<{ step: string }>(`/accounts/${id}/auth/verify`, data)
      .then((r) => r.data),
  checkStatus: (id: number) =>
    api
      .post<TgAccountStatus>(`/accounts/${id}/check-status`)
      .then((r) => r.data),
  refreshTgMeta: (id: number) =>
    api
      .post<{ tgDisplayName: string | null; tgUsername: string | null }>(
        `/accounts/${id}/refresh-tg-meta`,
      )
      .then((r) => r.data),
  fetchAttributes: (id: number) =>
    api
      .post<{ account: Account; warnings: string[]; authExpired: boolean }>(
        `/accounts/${id}/fetch-attributes`,
      )
      .then((r) => r.data),
  getProfile: (id: number) =>
    api.get<TgOwnProfile>(`/accounts/${id}/profile`).then((r) => r.data),
  updateProfile: (
    id: number,
    data: { firstName: string; lastName?: string; about?: string },
  ) =>
    api
      .post<TgOwnProfile & { tgDisplayName: string | null }>(
        `/accounts/${id}/update-profile`,
        data,
      )
      .then((r) => r.data),
  /** Sets the public @handle; an empty string removes it. */
  updateUsername: (id: number, username: string) =>
    api
      .post<{ username: string }>(`/accounts/${id}/update-username`, { username })
      .then((r) => r.data),
  checkUsername: (id: number, username: string) =>
    api
      .get<{ available: boolean; reason: string | null }>(
        `/accounts/${id}/check-username`,
        { params: { username } },
      )
      .then((r) => r.data),
  /** Current profile photo as a data URL, or null when the account has none. */
  getAvatar: (id: number) =>
    api
      .get<{ dataUrl: string | null }>(`/accounts/${id}/avatar`)
      .then((r) => r.data),
  setAvatar: (id: number, file: File) =>
    api
      .post<{ ok: boolean }>(
        `/accounts/${id}/avatar?filename=${encodeURIComponent(file.name)}`,
        file,
        { headers: { "Content-Type": "application/octet-stream" } },
      )
      .then((r) => r.data),
  avatarPool: () =>
    api.get<AvatarPoolStatus>("/accounts/avatar-pool").then((r) => r.data),
  export: (ids?: number[], secret?: string) =>
    api
      .post<AccountExportPayload>("/accounts/export", {
        ids: ids ?? [],
        secret: secret || undefined,
      })
      .then((r) => r.data),
  import: (data: unknown, secret?: string, forceReauth = true) =>
    api
      .post<{ imported: number; skipped: number }>("/accounts/import", {
        data,
        secret: secret || undefined,
        forceReauth,
      })
      .then((r) => r.data),
  updateTwoFa: (
    id: number,
    opts: { currentPassword?: string; newPassword?: string; hint?: string },
  ) =>
    api
      .post<{ success: true }>(`/accounts/${id}/update-2fa`, opts)
      .then((r) => r.data),
  getSessions: (id: number) =>
    api.get<SessionInfo[]>(`/accounts/${id}/sessions`).then((r) => r.data),
  terminateSession: (id: number, hash: string) =>
    api
      .post<{ success: true }>(`/accounts/${id}/terminate-session`, { hash })
      .then((r) => r.data),
  terminateOtherSessions: (id: number) =>
    api
      .post<{ success: true }>(`/accounts/${id}/terminate-other-sessions`)
      .then((r) => r.data),
  checkSpam: (id: number) =>
    api.post<TgSpamStatus>(`/accounts/${id}/check-spam`).then((r) => r.data),
  checkEnabledSessions: () =>
    api
      .post<{
        checked: number;
        expired: number[];
      }>("/accounts/check-enabled-sessions")
      .then((r) => r.data),
  reorder: (items: Array<{ id: number; sortOrder: number }>) =>
    api.put("/accounts/reorder", { items }).then((r) => r.data),
  bulkUpdateNotes: (ids: number[], notes: string | null) =>
    api.put("/accounts/bulk-notes", { ids, notes }).then((r) => r.data),
  bulkRename: (items: Array<{ id: number; name: string }>) =>
    api.put("/accounts/bulk-rename", { items }).then((r) => r.data),
  bulkAdd: (text: string, options?: BulkAddOptions) =>
    api
      .post<BulkAddBatch>("/accounts/bulk-add", { text, options })
      .then((r) => r.data),
  bulkAddStatus: () =>
    api
      .get<BulkAddBatch | null>("/accounts/bulk-add/status")
      .then((r) => r.data),
  bulkAddCancel: () =>
    api
      .post<{ cancelled: boolean }>("/accounts/bulk-add/cancel")
      .then((r) => r.data),
  bulkProfile: (items: BulkProfileEntry[], options?: BulkProfileOptions) =>
    api
      .post<BulkProfileBatch>("/accounts/bulk-profile", { items, options })
      .then((r) => r.data),
  bulkProfileStatus: () =>
    api
      .get<BulkProfileBatch | null>("/accounts/bulk-profile/status")
      .then((r) => r.data),
  /**
   * AI-written profiles, already cleaned to what Telegram and the bulk form accept. One
   * request covers the whole batch; `includeAbout: false` asks for names only.
   */
  bulkProfileGenerate: (count: number, hint?: string, includeAbout = true) =>
    api
      .post<{
        profiles: { firstName: string; lastName: string; about: string }[];
      }>("/accounts/bulk-profile/generate", { count, hint, includeAbout })
      .then((r) => r.data),
  bulkProfileCancel: () =>
    api
      .post<{ cancelled: boolean }>("/accounts/bulk-profile/cancel")
      .then((r) => r.data),
  forceReauth: (id: number) =>
    api.post<Account>(`/accounts/${id}/force-reauth`).then((r) => r.data),
  getPasswordInfo: (id: number) =>
    api.get<PasswordInfo>(`/accounts/${id}/password-info`).then((r) => r.data),
  sendLoginEmailCode: (id: number, email: string) =>
    api
      .post<{ emailPattern: string; codeLength: number }>(
        `/accounts/${id}/login-email/send-code`,
        { email },
      )
      .then((r) => r.data),
  // `email` is what the code was sent to: the server records it against the account when
  // Telegram's own response does not name it.
  verifyLoginEmail: (id: number, code: string, email?: string) =>
    api
      .post<{ email: string | null }>(`/accounts/${id}/login-email/verify`, { code, email })
      .then((r) => r.data),
  autoLoginEmail: (
    id: number,
    opts:
      | { source?: "gmail"; gmail: string; appPassword: string; tag: string }
      | { source: "msapi"; poolType?: string },
  ) =>
    api
      .post<{ email: string }>(`/accounts/${id}/login-email/auto`, opts)
      .then((r) => r.data),
  testGmail: (gmail: string, appPassword: string) =>
    api
      .post<{ ok: boolean; error?: string }>("/accounts/gmail/test", {
        gmail,
        appPassword,
      })
      .then((r) => r.data),
  getPasskeys: (id: number) =>
    api
      .get<{ passkeys: Passkey[]; storedIds: string[] }>(
        `/accounts/${id}/passkeys`,
      )
      .then((r) => r.data),
  deletePasskey: (id: number, passkeyId: string) =>
    api
      .delete<{ ok: boolean }>(
        `/accounts/${id}/passkeys/${encodeURIComponent(passkeyId)}`,
      )
      .then((r) => r.data),
  registerPasskey: (id: number, origin?: string) =>
    api
      .post<{ passkey: Passkey }>(`/accounts/${id}/passkeys`, { origin })
      .then((r) => r.data),
  verifyPasskey: (id: number, passkeyId: string, origin?: string) =>
    api
      .post<{
        ok: boolean;
        passwordRequired: boolean;
        userId: string;
        firstName: string | null;
        username: string | null;
      }>(
        `/accounts/${id}/passkeys/${encodeURIComponent(passkeyId)}/verify`,
        { origin },
      )
      .then((r) => r.data),
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type JobFacets = {
  botUsernames: string[];
  templates: Array<{ id: number; name: string }>;
};

export const jobsApi = {
  list: () => api.get<Job[]>("/jobs").then((r) => r.data),
  listPaged: (
    params: ListParams & {
      jobType?: string;
      accountId?: number | "";
      botUsername?: string;
      templateId?: number | "";
      enabled?: "0" | "1" | "";
    },
  ) =>
    api
      .get<Paged<Job> & { facets: JobFacets }>("/jobs", {
        params: cleanParams(params),
      })
      .then((r) => r.data),
  create: (data: Partial<Job>) =>
    api.post<Job>("/jobs", data).then((r) => r.data),
  update: (id: number, data: Partial<Job>) =>
    api.put<Job>(`/jobs/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/jobs/${id}`),
  /**
   * One patch, many jobs, one request. The per-job route rebuilds the scheduler on every
   * call, so a selection of a couple of hundred has to go in a single trip.
   */
  bulkUpdate: (
    ids: number[],
    patch: {
      enabled?: boolean;
      scheduleWindowStart?: number;
      scheduleWindowEnd?: number;
    },
  ) =>
    api
      .put<{ updated: number }>("/jobs/bulk", { ids, ...patch })
      .then((r) => r.data),
  bulkRetire: (ids: number[]) =>
    api
      .post<{ retired: number }>("/jobs/bulk-retire", { ids })
      .then((r) => r.data),
  run: (id: number) =>
    api
      .post<{ message: string; logId: number }>(`/jobs/${id}/run`)
      .then((r) => r.data),
  testEmby: (data: {
    serverUrl: string;
    username: string;
    password: string;
    userAgent?: string;
    proxyId?: string;
    proxyPool?: string[];
    ignoreSslErrors?: boolean;
  }) =>
    api
      .post<{ ok: boolean; userName?: string; error?: string }>(
        "/jobs/test-emby",
        data,
      )
      .then((r) => r.data),
};

// ── Templates ────────────────────────────────────────────────────────────────

export type AvailableAccount = {
  id: number;
  name: string;
  phoneNumber: string;
  authStatus: AuthStatus;
  tgDisplayName: string | null;
};

// Custom job icons come back as data URLs: the API sits behind a bearer-token guard and
// an <img> cannot send the header, so file URLs would not render.
export const jobIconsApi = {
  list: () =>
    api
      .get<{ dir: string; icons: JobIcon[] }>("/job-icons")
      .then((r) => r.data),
  upload: (file: File) =>
    api
      .post<JobIcon>("/job-icons", file, {
        headers: { "Content-Type": "application/octet-stream" },
      })
      .then((r) => r.data),
  remove: (name: string) =>
    api
      .delete<{ deleted: boolean }>(`/job-icons/${encodeURIComponent(name)}`)
      .then((r) => r.data),
};

export const templatesApi = {
  list: () => api.get<JobTemplate[]>("/templates").then((r) => r.data),
  // search is fuzzy-matched server side against template name and bot username
  listPaged: (
    params: ListParams & { jobType?: string; enabled?: "0" | "1" | "" },
  ) =>
    api
      .get<Paged<JobTemplate>>("/templates", { params: cleanParams(params) })
      .then((r) => r.data),
  create: (data: Partial<JobTemplate>) =>
    api.post<JobTemplate>("/templates", data).then((r) => r.data),
  update: (id: number, data: Partial<JobTemplate>) =>
    api.put<JobTemplate>(`/templates/${id}`, data).then((r) => r.data),
  duplicate: (id: number) =>
    api.post<JobTemplate>(`/templates/${id}/duplicate`).then((r) => r.data),
  delete: (id: number) => api.delete(`/templates/${id}`),
  setLinkedJobsEnabled: (id: number, enabled: boolean) =>
    api
      .put<{ ok: boolean }>(`/templates/${id}/jobs/enabled`, { enabled })
      .then((r) => r.data),
  availableAccounts: (id: number) =>
    api
      .get<AvailableAccount[]>(`/templates/${id}/available-accounts`)
      .then((r) => r.data),
  createJobs: (
    id: number,
    data: {
      jobs: Array<{
        accountId: number;
        name: string;
        config?: Record<string, unknown>;
      }>;
      scheduleWindowStart: number;
      scheduleWindowEnd: number;
      /** false creates them switched off; absent creates them running, as it always did. */
      enabled?: boolean;
    },
  ) =>
    api
      .post<{
        created: number;
        ids: number[];
      }>(`/templates/${id}/create-jobs`, data)
      .then((r) => r.data),
};

// ── Logs ─────────────────────────────────────────────────────────────────────

export const logsApi = {
  list: (params?: {
    jobId?: number;
    limit?: number;
    offset?: number;
    showRetired?: boolean;
  }) =>
    api
      .get<Log[]>("/logs", {
        params: { ...params, showRetired: params?.showRetired ? "1" : "0" },
      })
      .then((r) => r.data),
  listPaged: (params: {
    page: number;
    pageSize: number;
    jobId?: number | "";
    showRetired?: boolean;
    status?: string;
    search?: string;
  }) =>
    api
      .get<Paged<Log>>("/logs", {
        params: cleanParams({
          ...params,
          showRetired: params.showRetired ? "1" : "0",
        }),
      })
      .then((r) => r.data),
  getOne: (id: number) => api.get<Log>(`/logs/${id}`).then((r) => r.data),
  cancel: (id: number) =>
    api.post<{ message: string }>(`/logs/${id}/cancel`).then((r) => r.data),
  retire: (id: number) =>
    api.patch<{ retired: boolean }>(`/logs/${id}/retire`).then((r) => r.data),
};

// ── Status ────────────────────────────────────────────────────────────────────

export type MemorySample = {
  at: string;
  rssMb: number;
  externalMb: number;
  heapUsedMb: number;
  runs: Array<{ logId: number; jobName: string }>;
};

export type MemoryReport = {
  limitMb: number | null;
  current: MemorySample;
  peak: MemorySample | null;
  // Only set when the previous process was killed rather than stopped, which is how an
  // OOM shows up: the process itself never gets to report it.
  lastBeforeCrash: MemorySample | null;
};

export const statusApi = {
  get: () => api.get<ScheduleStatus[]>("/status").then((r) => r.data),
  /** Calls off one upcoming run; the job keeps its schedule and returns on its next day. */
  skipRun: (jobId: number) =>
    api
      .post<{ ok: boolean; nextRun?: string }>(`/status/skip/${jobId}`)
      .then((r) => r.data),
  memory: () => api.get<MemoryReport>("/status/memory").then((r) => r.data),
};

// ── Settings ──────────────────────────────────────────────────────────────────

export type UAPreset = {
  name: string;
  value: string;
};

export type Settings = {
  default_timezone: string;
  default_max_retry: string;
  check_daily_run: string;
  default_ua: string;
  default_play_duration: string;
  default_device_name: string;
  /** Server-computed: "true" when any AI supplier, legacy setting or env provides a key. */
  ai_key_configured?: string;
  /** Server-computed: "true" when bulk account management is enabled via the BULK_ACCOUNT_MANAGEMENT env var. */
  bulk_account_management?: string;
  /** Server-computed: "true" when the data store is enabled via the DATA_MANAGEMENT env var. */
  data_management?: string;
  ai_model: string;
  /** ai_models row id pinning the default model to an exact supplier. */
  ai_default_model_id?: string;
  ai_fallback_enabled?: string;
  /**
   * Target for the account-session sender, used only when no bot token is set.
   * @deprecated That sender is due for removal; use notify_bot_token + notify_bot_target.
   */
  notify_tg_username: string;
  notify_tg_events: string;
  /** Bot API token from BotFather. Write-only: reads come back as notify_bot_token_masked. */
  notify_bot_token?: string;
  /** Chat the bot notifies: a numeric chat id, or @name for a public channel. */
  notify_bot_target?: string;
  /** Server-computed: "true" when a notification bot token is stored. */
  notify_bot_configured?: string;
  /** Server-computed: the stored token as 12345678:****wXyZ. Never the raw value. */
  notify_bot_token_masked?: string;
  ua_presets: string;
  proxies: string;
  tg_app_clients: string;
  tg_client_mode: string; // 'default' | 'random'
  default_tg_api_id?: string;
  /** Masked value returned by the server (e.g. abcd****efgh). Never the raw hash. */
  default_tg_api_hash?: string;
  /** "true" to show accounts as "{Bemby name} - {TG name}" throughout the app. */
  account_display_with_tg_name?: string;
  /** "true" moves the upcoming-runs list to its own menu entry. */
  schedule_separate_page?: string;
  /** "true" adds a template-edit button to templated jobs on the jobs page. */
  jobs_template_edit_button?: string;
  /**
   * "false" makes a provider refresh drop an entry whose remote identity changed and import it
   * afresh. Unset or "true" keeps the id, matching on the name, so a job pinned to it is not
   * left with no proxy.
   */
  proxy_sync_match_by_name?: string;
  /**
   * Minutes between automatic provider refreshes, which re-fetch each enabled provider's list
   * and test what came back. "0" leaves refreshing to the operator.
   */
  proxy_provider_sync_interval_minutes?: string;
  /** "true" makes a proxy test also require the exit to reach challenges.cloudflare.com. */
  proxy_test_cf?: string;
  /** One more https URL a proxy test must fetch through the exit. Blank for none. */
  proxy_test_extra_url?: string;
  /** Minutes between automatic proxy tests. "0" leaves testing to the operator. */
  proxy_test_interval_minutes?: string;
  /** "true" makes a run verify its exit before going out through it. */
  proxy_check_before_use?: string;
  /** "true" turns on the data store: its menu entry, its API and its job steps. */
  data_store_enabled?: string;
  /**
   * Application (client) id of the Microsoft app a `web_ms_oauth2` step signs in against. Its
   * secret is not here: that is a stored secret, named `{msOauthClientSecret}` on the step.
   */
  ms_oauth_client_id?: string;
  /** Server-computed: "true" when the deployment offers msOauth2api (MSOAUTH2API). */
  msapi_available?: string;
  /** Base URL of a msOauth2api install, e.g. http://host:3000. */
  msapi_base_url?: string;
  /** msOauth2api API key. Write-only: reads come back as msapi_api_key_masked. */
  msapi_api_key?: string;
  /** Pool type leases are scoped to, e.g. Telegram. Blank uses msapi_pool_type_default. */
  msapi_pool_type?: string;
  /** Server-computed: "true" when both a base URL and an API key are stored. */
  msapi_configured?: string;
  /** Server-computed: the stored key as msk_ab****wxyz. Never the raw value. */
  msapi_api_key_masked?: string;
  /** Server-computed: the pool type used when none is set. */
  msapi_pool_type_default?: string;
  /** Days to keep job logs; "0" keeps all logs. */
  log_retention_days?: string;
  /** Minimum minutes between scheduled runs; "0" disables staggering. */
  schedule_min_gap_minutes?: string;
  /** "true" once the user has enabled the on-demand Cloudflare solver. */
  cf_solver_enabled?: string;
  /** Server-computed: "true" when the Cloudflare-solver browser is installed. */
  cf_chromium_installed?: string;
  /** Server-computed: version of that browser, e.g. "Chromium 151.0.7922.34". */
  cf_chromium_version?: string;
  /** Server-computed: "keyed" when the installed build is the one a licence key unlocks. */
  cf_chromium_tier?: string;
  /** Server-computed: path of the browser a job will actually launch. */
  cf_chromium_path?: string;
  /** Server-computed: "true" when a key is stored but its build is not downloaded yet. */
  cf_chromium_keyed_pending?: string;
  /** Server-computed: "true" when the unlicensed build is on disk to fall back on. */
  cf_chromium_free_installed?: string;
  /** Server-computed: how many solver browsers are open right now. */
  cf_browsers_running?: string;
  /** Server-computed: "true" when something is set to start the backend again after a restart. */
  restart_supervised?: string;
  /** Server-computed JSON: every installed build, with its tier, version and path. */
  cf_chromium_builds?: string;
  /** Server-computed: how many browser profiles are on disk. */
  cf_profile_count?: string;
  /** Locale the browser reports; blank follows the country its exit comes out in. */
  cf_browser_lang?: string;
  /** x11vnc, needed to show a hand-driven browser. */
  vnc_installed?: string;
  vnc_source?: string;
  vnc_version?: string;
  vnc_bytes?: string;
  cf_profile_id?: string;
  /** Server-computed: "true" when the CJK/emoji faces are in the data dir. */
  cf_fonts_installed?: string;
  /** Server-computed: comma-separated faces still to download. */
  cf_fonts_missing?: string;
  /** Server-computed JSON: stored CloakBrowser licence keys, masked. */
  cf_cloak_keys_masked?: string;
  /** Server-computed: how many licence keys are held by a running browser. */
  cf_cloak_keys_in_use?: string;
  /** JSON: the browser timings and limits in force. */
  cf_tuning?: string;
  /** Server-computed JSON: the values the solver ships with. */
  cf_tuning_defaults?: string;
  /** Server-computed JSON: `{min,max}` each timing is held to. */
  cf_tuning_limits?: string;
  proxy_providers_count?: string;
};

export type CfBrowserTestRun = {
  running: boolean;
  ok?: boolean;
  error?: string;
  /** One entry per installed build, appended as each finishes. */
  builds: CfBrowserTest[];
  message?: string;
};

export type CfBrowserTest = {
  ok: boolean;
  /** Which build this result is for. */
  tier?: "keyed" | "free";
  executable?: string;
  version?: string;
  renderedText?: string;
  error?: string;
  env?: Record<string, unknown>;
  warnings?: string[];
  notes?: string[];
  exitCountry?: string;
};

/** A browser opened on a job's own profile, for signing in by hand. */
export type ManualSession = {
  id: string;
  kind: "drive" | "watch";
  jobId: number;
  runId?: string;
  jobName: string;
  profileKey: string;
  /** The exit it goes out through, by the name the proxy list gives it, or `direct`. */
  proxyLabel?: string;
  /** The job runs on {noProfile}: this session has a throwaway profile and keeps nothing. */
  ephemeral?: boolean;
  vncPort: number;
  startedAt: number;
  lastSeenAt: number;
  url: string;
};

/** A job run that has a screen up, which a viewer can attach to. */
export type RunDisplay = {
  runId: string;
  jobId?: number;
  jobName?: string;
  display: string;
  startedAt: number;
};

export const manualBrowserApi = {
  /**
   * The open session and every run with a screen up. `watching: false` says this poll is
   * only after the list, so it does not hold an idle hand-driven session open.
   */
  status: (opts?: { watching?: boolean }) =>
    api
      .get<{ session: ManualSession | null; runs: RunDisplay[] }>("/manual-browser", {
        params: opts?.watching === false ? { watching: "0" } : undefined,
      })
      .then((r) => r.data),
  /** Attaches to a job already running, instead of opening a browser. */
  watch: (runId: string) =>
    api
      .post<{ session: ManualSession; ticket: string }>("/manual-browser/watch", { runId })
      .then((r) => r.data),
  start: (jobId: number, url?: string) =>
    api
      .post<{ session: ManualSession; ticket: string }>("/manual-browser/start", { jobId, url })
      .then((r) => r.data),
  /** A viewer that reconnects needs a fresh ticket: they are single-use. */
  ticket: () =>
    api
      .post<{ session: ManualSession; ticket: string }>("/manual-browser/ticket")
      .then((r) => r.data),
  /** Sends the open browser to an address; there is no address bar inside it. */
  goto: (url: string) =>
    api.post<{ url: string }>("/manual-browser/goto", { url }).then((r) => r.data),
  stop: () => api.post("/manual-browser/stop").then((r) => r.data),
};

/** A browser profile on disk: the cookies and site data a run carries over from the last. */
export type CfProfile = {
  name: string;
  sizeBytes: number;
  /** Epoch ms of the last run that opened it, or null when none ever has. */
  lastUsedAt: number | null;
  /** A browser has it open, so it cannot be deleted or overwritten right now. */
  inUse: boolean;
  /** Created or imported by hand, and so exempt from automatic trimming. */
  managed: boolean;
};

export type CfProfileDeleteResult = {
  ok: boolean;
  removed: string[];
  refused: Array<{ name: string; reason: string }>;
  profiles?: CfProfile[];
};

export type CfProfileImportResult = {
  ok?: boolean;
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
  profiles?: CfProfile[];
};

/** A stored secret, as the panel is allowed to see it: the name and when it was written. */
export type SecretSummary = { key: string; updatedAt: string | null };

// Values are write-only by design -- there is no endpoint that reads one back, so nothing
// here can display or export a secret.
export const secretsApi = {
  list: () => api.get<SecretSummary[]>("/secrets").then((r) => r.data),
  save: (key: string, value: string) =>
    api.put<{ ok: boolean }>(`/secrets/${encodeURIComponent(key)}`, { value }).then((r) => r.data),
  remove: (key: string) =>
    api.delete<{ ok: boolean }>(`/secrets/${encodeURIComponent(key)}`).then((r) => r.data),
};

export const settingsApi = {
  get: () => api.get<Settings>("/settings").then((r) => r.data),
  update: (data: Partial<Settings>) =>
    api.put<Settings>("/settings", data).then((r) => r.data),
  /** Fetches x11vnc into the data dir, where it survives an upgrade. */
  installVnc: () =>
    api
      .post<{ ok: boolean; error?: string; log?: string[] }>("/settings/vnc/install")
      .then((r) => r.data),
  removeVnc: () => api.post("/settings/vnc/remove").then((r) => r.data),
  testProxy: (url: string) =>
    api
      .post<{ ok: boolean; error?: string }>("/settings/test-proxy", { url })
      .then((r) => r.data),
  /**
   * Tests every stored proxy; the server reads the URLs, since ours are masked. The list
   * comes back with the results: a test writes each exit's status, so the copy on screen is
   * stale the moment they land.
   */
  testAllProxies: () =>
    api
      .post<{ results: ProxyTestResult[]; ok: number; proxies: string }>("/settings/test-proxies")
      .then((r) => r.data),
  /** Turns an exit off by hand: no test puts it back, only enableProxy does. */
  disableProxy: (id: string) =>
    api
      .post<{ proxies: string }>(`/settings/proxies/${encodeURIComponent(id)}/disable`)
      .then((r) => r.data),
  /** Puts an exit back in service, clearing a manual switch and a failed verdict alike. */
  enableProxy: (id: string) =>
    api
      .post<{ proxies: string }>(`/settings/proxies/${encodeURIComponent(id)}/enable`)
      .then((r) => r.data),
  /** `force` downloads the browser again over an existing one, i.e. updates it. */
  installCfSolver: (force = false, tier?: "free") =>
    api
      .post<{
        ok: boolean;
        installed?: boolean;
        version?: string;
        output?: string;
        message?: string;
        fontsInstalled?: boolean;
      }>("/settings/cf-solver/install", { force, ...(tier ? { tier } : {}) })
      .then((r) => r.data),
  /** Closes every solver browser that is open, failing the jobs holding them. */
  stopCfBrowsers: () =>
    api
      .post<{ ok: boolean; stopped: number }>("/settings/cf-solver/stop")
      .then((r) => r.data),
  /**
   * Closes every browser, kills any left behind by an earlier backend, and restarts the
   * server. The response arrives just before it goes, so the caller should expect the
   * connection to drop straight after.
   *
   * `force` kills the browsers instead of asking them to close, for when a wedged browser
   * is what makes the ordinary restart hang.
   */
  restartSystem: (force = false) =>
    api
      .post<{
        ok: boolean;
        stopped: number;
        killed: number;
        supervised: boolean;
        forced: boolean;
      }>("/settings/system/restart", { force })
      .then((r) => r.data),
  /** What is running, and whether a newer build is out on the same release line. */
  updateStatus: (refresh = false) =>
    api
      .get<UpdateStatus>("/settings/system/update", {
        params: refresh ? { refresh: 1 } : undefined,
      })
      .then((r) => r.data),
  /** Forgets where each exit comes out, so the next launch looks it up again. */
  clearCfExitGeo: () =>
    api
      .post<{ ok: boolean; cleared?: number }>("/settings/cf-solver/clear-exit-geo")
      .then((r) => r.data),
  /** Deletes the per-exit browser profiles (cookies, cache, site data). */
  clearCfProfiles: () =>
    api
      .post<{ ok: boolean; removed?: number; message?: string }>(
        "/settings/cf-solver/clear-profiles",
      )
      .then((r) => r.data),
  /** Every browser profile on disk, with size, last use and whether one is open. */
  cfProfiles: () =>
    api
      .get<{ profiles: CfProfile[] }>("/settings/cf-solver/profiles")
      .then((r) => r.data.profiles),
  /** Reserves a profile name; the browser fills the directory in on first launch. */
  createCfProfile: (name: string) =>
    api
      .post<{ ok: boolean; profiles?: CfProfile[] }>("/settings/cf-solver/profiles", { name })
      .then((r) => r.data),
  /** Moves a profile to another name, keeping its cookies, storage and device. */
  renameCfProfile: (from: string, to: string) =>
    api
      .post<{ ok: boolean; profiles?: CfProfile[] }>("/settings/cf-solver/profiles/rename", {
        from,
        to,
      })
      .then((r) => r.data),
  deleteCfProfiles: (names: string[]) =>
    api
      .post<CfProfileDeleteResult>("/settings/cf-solver/profiles/delete", { names })
      .then((r) => r.data),
  /** Downloads the selected profiles as one .tar.gz (caches excluded). */
  exportCfProfiles: (names: string[]) =>
    api
      .post("/settings/cf-solver/profiles/export", { names }, { responseType: "blob" })
      .then((r) => r.data as Blob),
  /** Uploads a .tar.gz of profiles; the body is the file itself, streamed server-side. */
  importCfProfiles: (file: File, replace: boolean) =>
    api
      .post<CfProfileImportResult>(
        `/settings/cf-solver/profiles/import?replace=${replace ? 1 : 0}`,
        file,
        { headers: { "Content-Type": "application/gzip" } },
      )
      .then((r) => r.data),
  /** Deletes every downloaded browser build, reclaiming the space in the data dir. */
  uninstallCfSolver: () =>
    api
      .post<{ ok: boolean; removed?: string[]; message?: string }>(
        "/settings/cf-solver/uninstall",
      )
      .then((r) => r.data),
  /**
   * Starts a test of every installed build. It runs in the background -- a browser launch
   * plus a real page load, once per build, outlives what a proxy will hold a request open
   * for -- so this returns straight away and `cfSolverTestStatus` reports on it.
   */
  testCfSolver: () =>
    api.post<CfBrowserTestRun>("/settings/cf-solver/test").then((r) => r.data),
  /** How the run started above is going, with each build's result as it lands. */
  cfSolverTestStatus: () =>
    api.get<CfBrowserTestRun>("/settings/cf-solver/test").then((r) => r.data),
  getCfKeys: () =>
    api.get<CfKeysResponse>("/settings/cf-solver/keys").then((r) => r.data),
  /** Send the masked value back unchanged to keep a stored key while editing its label. */
  saveCfKeys: (keys: Array<{ label: string; key: string }>) =>
    api.put<CfKeysResponse>("/settings/cf-solver/keys", { keys }).then((r) => r.data),
  checkCfKeys: () =>
    api
      .post<{ results: CfKeyCheck[] }>("/settings/cf-solver/keys/check")
      .then((r) => r.data.results),
  getProxyProviders: () =>
    api
      .get<{ providers: ProxyProvider[] }>("/settings/proxy-providers")
      .then((r) => r.data.providers),
  saveProxyProviders: (providers: ProxyProvider[]) =>
    api
      .put<{ providers: ProxyProvider[] }>("/settings/proxy-providers", { providers })
      .then((r) => r.data.providers),
  syncProxyProviders: (providerId?: string) =>
    api
      .post<ProxySyncResult>(
        "/settings/proxy-providers/sync",
        providerId ? { providerId } : {},
      )
      .then((r) => r.data),
  /** Who the stored notification token belongs to, so a bad token is visible. */
  getNotifyBot: () =>
    api.get<NotifyBotInfo>("/settings/notify/bot").then((r) => r.data),
  /** Chats the bot has heard from lately, for filling in the default target. */
  getNotifyBotChats: () =>
    api
      .get<{ ok: boolean; chats?: NotifyBotChat[]; error?: string }>(
        "/settings/notify/bot/chats",
      )
      .then((r) => r.data),
  /**
   * Sends a real message now: the only check that proves the whole path works. An unsaved
   * token or target can be passed to try it before committing to it.
   */
  testNotifyBot: (target?: string, token?: string) =>
    api
      .post<{ ok: boolean; error?: string }>("/settings/notify/bot/test", {
        ...(target ? { target } : {}),
        ...(token ? { token } : {}),
      })
      .then((r) => r.data),
  /** Asks the msOauth2api address pool for its counts: proves URL, key and type together. */
  testMsApi: (type?: string) =>
    api
      .post<{
        ok: boolean;
        error?: string;
        available?: number;
        leased?: number;
        confirmed?: number;
      }>("/settings/msapi/test", { ...(type ? { type } : {}) })
      .then((r) => r.data),
};

export type NotifyBotInfo = {
  configured: boolean;
  ok?: boolean;
  id?: number;
  username?: string;
  name?: string;
  error?: string;
};

export type NotifyBotChat = {
  id: number;
  type: string;
  title: string;
  /** Set when the chat was seen inside a forum topic. */
  threadId?: number;
  /** Target string to store for this chat, topic included. */
  target: string;
};

/** A stored CloakBrowser licence key as the server will show it: never the raw value. */
export type CfKeyView = { label: string; masked: string };

export type CfKeysResponse = { keys: CfKeyView[]; total: number; inUse: number };

export type CfKeyCheck = {
  label: string;
  masked: string;
  valid: boolean;
  plan?: string;
  expires?: string;
  error?: string;
};

export type ProxyProviderType = "webshare" | "list" | "subscription";

export type ProxyProvider = {
  id: string;
  name: string;
  type: ProxyProviderType;
  /** Never returned by the server; send a value to set or change it. */
  apiKey?: string;
  /** True when the server holds a key for this provider. */
  hasKey?: boolean;
  url?: string;
  scheme?: "http" | "socks5";
  enabled?: boolean;
};

export type ProxySyncResult = {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  removed?: number;
  total?: number;
  providers?: Array<{
    providerId: string;
    name: string;
    ok: boolean;
    fetched?: number;
    error?: string;
  }>;
  /** How many of the imported exits the health test that follows a sync covered. */
  tested?: number;
  /** How many of those passed; the rest are disabled until a later test clears them. */
  reachable?: number;
  /** The proxy list as the sync and its test left it, masked. */
  proxies?: string;
};

// ── AI Suppliers ──────────────────────────────────────────────────────────────

export type AiModel = {
  id: number;
  supplier_id: number;
  model_id: string;
  label: string | null;
};

export type AiSupplier = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
  models: AiModel[];
};

export const aiSuppliersApi = {
  list: () => api.get<AiSupplier[]>("/ai-suppliers").then((r) => r.data),
  create: (data: Omit<AiSupplier, "id" | "models">) =>
    api.post<AiSupplier>("/ai-suppliers", data).then((r) => r.data),
  update: (id: number, data: Partial<Omit<AiSupplier, "id" | "models">>) =>
    api.put<AiSupplier>(`/ai-suppliers/${id}`, data).then((r) => r.data),
  remove: (id: number) => api.delete(`/ai-suppliers/${id}`).then((r) => r.data),
  addModel: (supplierId: number, model_id: string, label?: string) =>
    api
      .post<AiModel>(`/ai-suppliers/${supplierId}/models`, { model_id, label })
      .then((r) => r.data),
  removeModel: (supplierId: number, modelId: number) =>
    api
      .delete(`/ai-suppliers/${supplierId}/models/${modelId}`)
      .then((r) => r.data),
};

// ── Data Import / Export ───────────────────────────────────────────────────────

export type ExportPayload = {
  version: "1";
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  jobs: Array<{
    accountIndex: number | null;
    templateIndex?: number | null;
    name: string;
    jobType: string;
    botUsername: string;
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  aiSuppliers?: Array<{
    name: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }>;
  aiModels?: Array<{
    supplierIndex: number;
    modelId: string;
    label: string | null;
  }>;
  settings: Record<string, string>;
};

export type EncryptedEnvelope = {
  encrypted: true;
  version: "1";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export type ImportResult = {
  message: string;
  accountsImported: number;
  accountsSkipped: number;
  templatesImported: number;
  jobsImported: number;
  aiSuppliersImported: number;
  aiModelsImported: number;
  dataFoldersImported?: number;
  dataRecordsImported?: number;
  settingsUpdated: number;
};

export const dataApi = {
  export: (secret?: string) =>
    api
      .post<ExportPayload | EncryptedEnvelope>("/data/export", { secret })
      .then((r) => r.data),
  import: (
    data: ExportPayload | EncryptedEnvelope,
    mode: "merge" | "replace",
    secret?: string,
    forceReauth = true,
    confirmPassword?: string,
  ) =>
    api
      .post<ImportResult>("/data/import", { data, mode, secret, forceReauth, confirmPassword })
      .then((r) => r.data),
};

// ── Data store ────────────────────────────────────────────────────────────────

/** A folder of the data store, as the list shows it. */
export type DataFolder = {
  id: number;
  name: string;
  recordCount: number;
  updatedAt: string | null;
  /** Line format its text export was last written with, absent until it has had one. */
  exportFormat?: string;
};

/** A folder rendered as a text file: one line per record, to the format asked for. */
export type DataTextExport = {
  name: string;
  format: string;
  text: string;
  /** Records in the folder, which is more than the lines when a preview asked for a few. */
  lineCount: number;
};

/** One record: a key, and a value that may be an object, a string or a number. */
export type DataRecord = {
  id: number;
  folderId: number;
  key: string;
  value: unknown;
  updatedAt: string | null;
};

export type DataStoreExport = {
  version: "1";
  exportedAt: string;
  folders: Array<{ name: string; records: Array<{ key: string; value: unknown }> }>;
};

// `valueText` rather than a parsed value: whether `{"a":1}` is an object or the text of one is
// settled on the backend, so the panel and a job's save step cannot disagree about it.
export const dataStoreApi = {
  folders: () => api.get<DataFolder[]>("/data-store/folders").then((r) => r.data),
  createFolder: (name: string) =>
    api.post<{ id: number; name: string }>("/data-store/folders", { name }).then((r) => r.data),
  renameFolder: (id: number, name: string) =>
    api.patch<{ ok: boolean }>(`/data-store/folders/${id}`, { name }).then((r) => r.data),
  deleteFolder: (id: number) =>
    api.delete<{ ok: boolean }>(`/data-store/folders/${id}`).then((r) => r.data),
  records: (folderId: number) =>
    api.get<DataRecord[]>(`/data-store/folders/${folderId}/records`).then((r) => r.data),
  createRecord: (folderId: number, key: string, valueText: string) =>
    api
      .post<{ id: number; key: string }>(`/data-store/folders/${folderId}/records`, {
        key,
        valueText,
      })
      .then((r) => r.data),
  updateRecord: (id: number, changes: { key?: string; valueText?: string }) =>
    api.patch<{ ok: boolean }>(`/data-store/records/${id}`, changes).then((r) => r.data),
  deleteRecord: (id: number) =>
    api.delete<{ ok: boolean }>(`/data-store/records/${id}`).then((r) => r.data),
  export: (folderId?: number) =>
    api
      .get<DataStoreExport>("/data-store/export", {
        params: folderId ? { folderId } : undefined,
      })
      .then((r) => r.data),
  /** `save` keeps the format on the folder; `limit` asks for the first lines, for a preview. */
  exportText: (folderId: number, opts: { format: string; save?: boolean; limit?: number }) =>
    api
      .post<DataTextExport>(`/data-store/folders/${folderId}/export-text`, opts)
      .then((r) => r.data),
};

// ── TG Live Client ────────────────────────────────────────────────────────────

export type TgDialog = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  unreadCount: number;
  lastMessage: { text: string; date: number; fromMe: boolean } | null;
  left?: boolean; // not a member; join required to send messages
  muted?: boolean;
  pinned?: boolean;
};

export type TgButton = {
  text: string;
  data: string | null;
  url: string | null;
  webApp: boolean; // Telegram Mini App -- must open in a real browser
  send: boolean; // reply-keyboard button -- clicking sends its text as a message
  requestPhone: boolean; // reply-keyboard button -- shares our own phone as a contact
};

export type TgReaction = {
  emoji: string;
  count: number;
  mine: boolean;
};

export type TgInvitePreview = {
  hash: string;
  title: string;
  memberCount: number;
  type: "group" | "channel";
  alreadyJoined: boolean;
  chatId?: string;
};

/** Media a quoted message carries, so the UI can word a quote with no text of its own. */
export type TgMediaKind =
  | "photo"
  | "video"
  | "sticker"
  | "voice"
  | "audio"
  | "document"
  | "contact";

/** Membership and housekeeping events Telegram reports as service messages. */
export type TgServiceKind =
  | "join"
  | "joinByRequest"
  | "added"
  | "left"
  | "removed"
  | "pinned"
  | "titleChanged"
  | "photoChanged"
  | "created";

export type TgServiceInfo = {
  kind: TgServiceKind;
  actorId: string | null;
  actorName: string | null;
  targets: { chatId: string; name: string | null }[];
  title: string | null;
};

export type TgMessage = {
  id: number;
  text: string;
  html: string | null;
  date: number;
  fromMe: boolean;
  isRead: boolean;
  fromId: string | null;
  fromName: string | null;
  hasPhoto: boolean;
  hasDocument: boolean;
  hasSticker: boolean;
  fileName: string | null;
  buttons: TgButton[][] | null;
  reactions: TgReaction[] | null;
  replyToId: number | null;
  replyToText: string | null;
  replyToName: string | null;
  replyCount: number | null;
  /** Media of the quoted message, when it has no text to quote. */
  replyToMedia?: TgMediaKind | null;
  replyToFileName?: string | null;
  /** Set on service messages; absent on payloads cached before they were supported. */
  service?: TgServiceInfo | null;
};

export type TgContact = {
  chatId: string;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string | null;
};

export type TgProfile = {
  chatId: string;
  /** The ID as Telegram shows it, which is what a job's chat field takes. */
  peerId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  phone: string | null;
  bio: string | null;
  memberCount: number | null;
  firstName: string | null;
  lastName: string | null;
  blocked: boolean | null;
};

export type TgMember = {
  chatId: string;
  /** The ID as Telegram shows it, which is what a job's contact field takes. */
  peerId: string;
  name: string;
  username: string | null;
  isBot: boolean;
  status: "creator" | "admin" | "member";
};

export type TgReportReason =
  | "spam"
  | "violence"
  | "pornography"
  | "childAbuse"
  | "illegalDrugs"
  | "personalDetails"
  | "fake"
  | "copyright"
  | "other";

/** A Mini App a bot pins beside the composer. */
export type TgBotMenuButton = { text: string; url: string };

export type TgBotCommand = {
  command: string;
  description: string;
};

export type TgFolder = {
  id: number;
  title: string;
  emoticon: string | null;
  includeGroups: boolean;
  includeBroadcasts: boolean;
  includeBots: boolean;
  includeContacts: boolean;
  includeNonContacts: boolean;
  pinnedChatIds: string[];
  includedChatIds: string[];
  excludedChatIds: string[];
};

export const tgClientApi = {
  dialogs: (
    accountId: number,
    params?: { limit?: number },
    signal?: AbortSignal,
  ) =>
    api
      .get<TgDialog[]>(`/tg-client/${accountId}/dialogs`, { params, signal })
      .then((r) => r.data),

  messages: (
    accountId: number,
    chatId: string,
    params?: { limit?: number; offsetId?: number; fresh?: 1 },
    signal?: AbortSignal,
  ) =>
    api
      .get<TgMessage[]>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}`,
        { params, signal },
      )
      .then((r) => r.data),

  searchMessages: (
    accountId: number,
    chatId: string,
    q: string,
    params?: { limit?: number },
    signal?: AbortSignal,
  ) =>
    api
      .get<TgMessage[]>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/search`,
        { params: { q, ...params }, signal },
      )
      .then((r) => r.data),

  send: (
    accountId: number,
    chatId: string,
    text: string,
    replyToMsgId?: number,
  ) =>
    api
      .post<{
        id: number;
        date: number;
      }>(`/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}`, {
        text,
        ...(replyToMsgId ? { replyToMsgId } : {}),
      })
      .then((r) => r.data),

  sendFile: (
    accountId: number,
    chatId: string,
    file: File,
    opts?: { caption?: string; asDocument?: boolean; replyToMsgId?: number },
  ) =>
    file.arrayBuffer().then((buf) =>
      api
        .post<{
          id: number;
          date: number;
          hasPhoto: boolean;
          hasDocument: boolean;
        }>(
          `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/file`,
          buf,
          {
            headers: { "Content-Type": "application/octet-stream" },
            params: {
              filename: file.name,
              ...(opts?.caption ? { caption: opts.caption } : {}),
              ...(opts?.asDocument ? { asDocument: "1" } : {}),
              ...(opts?.replyToMsgId ? { replyToMsgId: opts.replyToMsgId } : {}),
            },
          },
        )
        .then((r) => r.data),
    ),

  contacts: (accountId: number) =>
    api
      .get<TgContact[]>(`/tg-client/${accountId}/contacts`)
      .then((r) => r.data),

  addContact: (
    accountId: number,
    phone: string,
    firstName: string,
    lastName?: string,
  ) =>
    api
      .post<TgContact>(`/tg-client/${accountId}/contacts`, {
        phone,
        firstName,
        lastName,
      })
      .then((r) => r.data),

  editContact: (
    accountId: number,
    userId: string,
    firstName: string,
    lastName?: string,
  ) =>
    api
      .put<TgContact>(
        `/tg-client/${accountId}/contacts/${encodeURIComponent(userId)}`,
        { firstName, lastName },
      )
      .then((r) => r.data),

  search: (accountId: number, q: string) =>
    api
      .get<TgDialog[]>(`/tg-client/${accountId}/search`, { params: { q } })
      .then((r) => r.data),

  // An <img src> cannot set an Authorization header, so the address carries a short-lived
  // media ticket. The session token used to go here, which put a seven-day credential into
  // the browser's history and the server's access log for every image on screen.
  photoUrl: (accountId: number, chatId: string, msgId: number) =>
    `/api/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/photo?ticket=${encodeURIComponent(mediaTicket.value)}`,

  /** Fetches (or refreshes) the media ticket. Cheap, and idempotent enough to call on open. */
  ensureMediaTicket: async (): Promise<void> => {
    if (mediaTicket.value && Date.now() < mediaTicketExpiry - TICKET_REFRESH_MARGIN_MS) return;
    const { ticket, expiresAt } = await api
      .post<{ ticket: string; expiresAt: number }>("/tg-client/media-ticket")
      .then((r) => r.data);
    mediaTicket.value = ticket;
    mediaTicketExpiry = expiresAt;
  },

  folders: (accountId: number) =>
    api.get<TgFolder[]>(`/tg-client/${accountId}/folders`).then((r) => r.data),

  addChatToFolder: (accountId: number, folderId: number, chatId: string) =>
    api
      .post(`/tg-client/${accountId}/folders/${folderId}/chats`, { chatId })
      .then((r) => r.data),

  avatarsBatch: (accountId: number, chatIds: string[]) =>
    api
      .get<Record<string, string>>(
        `/tg-client/${accountId}/avatars?ids=${chatIds.map(encodeURIComponent).join(",")}`,
      )
      .then((r) => r.data),

  profile: (accountId: number, chatId: string) =>
    api
      .get<TgProfile>(
        `/tg-client/${accountId}/profile/${encodeURIComponent(chatId)}`,
      )
      .then((r) => r.data),

  members: (
    accountId: number,
    chatId: string,
    params: { limit?: number; offset?: number; query?: string } = {},
  ) =>
    api
      .get<{ members: TgMember[]; total: number }>(
        `/tg-client/${accountId}/members/${encodeURIComponent(chatId)}`,
        { params },
      )
      .then((r) => r.data),

  mute: (accountId: number, chatId: string, muteSecs: number) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/mute/${encodeURIComponent(chatId)}`, {
        muteSecs,
      })
      .then((r) => r.data),

  pin: (accountId: number, chatId: string, pinned: boolean) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/pin/${encodeURIComponent(chatId)}`, {
        pinned,
      })
      .then((r) => r.data),

  // phoneNumber overrides the account's own number; bots that verify the card's
  // user_id against the sender will reject anything but the account's own.
  sharePhone: (
    accountId: number,
    chatId: string,
    replyToMsgId?: number,
    phoneNumber?: string,
  ) =>
    api
      .post<{ id: number; date: number; text: string }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/share-phone`,
        { replyToMsgId, phoneNumber },
      )
      .then((r) => r.data),

  clickButton: (
    accountId: number,
    chatId: string,
    msgId: number,
    data: string,
  ) =>
    api
      .post<{
        alert: boolean;
        message: string | null;
        url: string | null;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/button`,
        { data },
      )
      .then((r) => r.data),

  sendTyping: (accountId: number, chatId: string) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/typing/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  setBlocked: (accountId: number, chatId: string, blocked: boolean) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/block/${encodeURIComponent(chatId)}`, {
        blocked,
      })
      .then((r) => r.data),

  report: (
    accountId: number,
    chatId: string,
    reason: TgReportReason,
    comment?: string,
  ) =>
    api
      .post<{
        ok: boolean;
      }>(`/tg-client/${accountId}/report/${encodeURIComponent(chatId)}`, {
        reason,
        ...(comment ? { comment } : {}),
      })
      .then((r) => r.data),

  frameable: (url: string) =>
    api
      .get<{ frameable: boolean }>("/tg-client/frameable", { params: { url } })
      .then((r) => r.data),

  // An address for the viewer iframe carrying a ticket instead of the session token, which
  // the page itself would be able to read off its own URL
  webviewTicket: (url: string, mode: "app" | "page") =>
    api
      .post<{ proxyUrl: string; isolated: boolean; expiresAt: number }>("/tg-client/webview/ticket", {
        url,
        mode,
      })
      .then((r) => r.data),

  clearAccountCache: (accountId: number) =>
    api
      .delete<{ ok: boolean }>(`/tg-client/${accountId}/cache`)
      .then((r) => r.data),

  cleanAccount: (accountId: number) =>
    api
      .post<{
        ok: boolean;
        left: number;
        deleted: number;
        contacts: number;
        folders: number;
        failed: { chatId: string; name: string; error: string }[];
      }>(`/tg-client/${accountId}/clean`)
      .then((r) => r.data),

  deleteHistory: (accountId: number, chatId: string, revoke: boolean) =>
    api
      .delete<{
        ok: boolean;
      }>(`/tg-client/${accountId}/history/${encodeURIComponent(chatId)}`, {
        params: revoke ? { revoke: 1 } : {},
      })
      .then((r) => r.data),

  deleteMessages: (
    accountId: number,
    chatId: string,
    ids: number[],
    revoke: boolean,
  ) =>
    api
      .post<{
        ok: boolean;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/delete`,
        { ids, revoke },
      )
      .then((r) => r.data),

  editMessage: (accountId: number, chatId: string, msgId: number, text: string) =>
    api
      .post<{
        ok: boolean;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/edit`,
        { text },
      )
      .then((r) => r.data),

  forwardMessages: (
    accountId: number,
    chatId: string,
    toChatId: string,
    ids: number[],
  ) =>
    api
      .post<{
        ok: boolean;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/forward`,
        { toChatId, ids },
      )
      .then((r) => r.data),

  clearCache: (accountId: number, chatId: string) =>
    api
      .delete(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/cache`,
      )
      .then((r) => r.data),

  sendReaction: (
    accountId: number,
    chatId: string,
    msgId: number,
    emoji: string | null,
  ) =>
    api
      .post<{
        ok: boolean;
      }>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/reaction`,
        { emoji },
      )
      .then((r) => r.data),

  /** The bot's commands and its menu button (the Mini App pinned beside the composer). */
  botInfo: (accountId: number, chatId: string) =>
    api
      .get<{ commands: TgBotCommand[]; menuButton: TgBotMenuButton | null }>(
        `/tg-client/${accountId}/bot-info/${encodeURIComponent(chatId)}`,
      )
      .then((r) => r.data),

  threadMessages: (
    accountId: number,
    chatId: string,
    msgId: number,
    params?: { limit?: number; offsetId?: number },
  ) =>
    api
      .get<TgMessage[]>(
        `/tg-client/${accountId}/messages/${encodeURIComponent(chatId)}/${msgId}/thread`,
        { params },
      )
      .then((r) => r.data),

  markRead: (accountId: number, chatId: string, maxId: number) =>
    api
      .post(`/tg-client/${accountId}/mark-read/${encodeURIComponent(chatId)}`, {
        maxId,
      })
      .then((r) => r.data),

  resolvePeer: (accountId: number, username: string) =>
    api
      .post<TgDialog>(`/tg-client/${accountId}/resolve-peer`, { username })
      .then((r) => r.data),

  reconnect: (accountId: number) =>
    api.post(`/tg-client/${accountId}/reconnect`).then((r) => r.data),

  checkInvite: (accountId: number, hash: string) =>
    api
      .get<TgInvitePreview>(
        `/tg-client/${accountId}/invite/${encodeURIComponent(hash)}`,
      )
      .then((r) => r.data),

  joinInvite: (accountId: number, hash: string) =>
    api
      .post<TgDialog>(
        `/tg-client/${accountId}/invite/${encodeURIComponent(hash)}`,
      )
      .then((r) => r.data),

  join: (accountId: number, chatId: string) =>
    api
      .post<{
        ok: boolean;
        joined?: boolean;
        requestSent?: boolean;
      }>(`/tg-client/${accountId}/join/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  leave: (accountId: number, chatId: string) =>
    api
      .post<{ ok: boolean }>(
        `/tg-client/${accountId}/leave/${encodeURIComponent(chatId)}`,
      )
      .then((r) => r.data),

  membership: (accountId: number, chatId: string) =>
    api
      .get<{
        member: boolean;
      }>(`/tg-client/${accountId}/membership/${encodeURIComponent(chatId)}`)
      .then((r) => r.data),

  pinnedMessage: (accountId: number, chatId: string) =>
    api
      .get<TgMessage | null>(
        `/tg-client/${accountId}/chats/${encodeURIComponent(chatId)}/pinned`,
      )
      .then((r) => r.data),

  startBot: (accountId: number, username: string, startParam: string) =>
    api
      .post<TgDialog>(
        `/tg-client/${accountId}/start-bot/${encodeURIComponent(username)}`,
        {
          startParam,
        },
      )
      .then((r) => r.data),

  webviewResolve: (
    accountId: number,
    url: string,
    botChatId?: string | null,
    peerChatId?: string | null,
    /** The address came from the bot's menu button; Telegram signs that case only when told. */
    fromBotMenu?: boolean,
  ) =>
    api
      .post<{
        webAppUrl: string;
        resolved: boolean;
        frameable: boolean;
        /** Telegram attached the account data. False means the app will load logged out. */
        signed: boolean;
      }>(`/tg-client/${accountId}/webview/resolve`, {
        url,
        botChatId,
        peerChatId,
        fromBotMenu,
      })
      .then((r) => r.data),
};

// ── AI Debug ──────────────────────────────────────────────────────────────────

export const debugApi = {
  runAi: (
    images: string[],
    prompt: string,
    maxTokens?: number,
    model?: string,
  ) =>
    api
      .post<{
        response: string;
        durationMs: number;
      }>("/debug/ai", { images, prompt, maxTokens, model })
      .then((r) => r.data),
};

// ── Background bulk tasks ─────────────────────────────────────────────────────
// Long bulk actions run on the server, so the page can be closed while they
// work. Progress is polled from here and any running task can be terminated.

export type BulkTaskKind =
  | "spam-check"
  | "fetch-attributes"
  | "login-email"
  | "credentials"
  | "passkey"
  | "privacy"
  | "clean"
  | "extract-messages"
  | "run-jobs"
  /** Bulk add and bulk profile update: their own runners, surfaced in the same list. */
  | "add"
  | "profile";

/** The three levels Telegram offers for each privacy key. */
export type PrivacyLevel = "nobody" | "contacts" | "everybody";

export type BulkTaskItemStatus =
  | "pending"
  | "waiting"
  | "working"
  | "done"
  | "failed"
  | "cancelled";

export type BulkTaskState = "running" | "completed" | "cancelled";

export type BulkTaskItem = {
  index: number;
  /** Account id, or job id for "run-jobs". */
  refId: number;
  refName: string;
  status: BulkTaskItemStatus;
  message: string;
  error: string | null;
  /** Op-specific result, rendered by the view in its own wording. */
  data?: Record<string, any>;
};

export type BulkTask = {
  id: string;
  kind: BulkTaskKind;
  /** Queues of one kind run side by side while their scopes differ (job runs: by template). */
  scope: string;
  /** Readable name for the scope, shown beside the task title. */
  label: string;
  createdAt: string;
  finishedAt: string | null;
  state: BulkTaskState;
  cancelRequested: boolean;
  gapSeconds: number;
  total: number;
  items: BulkTaskItem[];
};

/** Where an extraction writes what it finds, alongside the lines it collects. */
export type BulkExtractStore = {
  folder: string;
  keyFormat?: string;
  valueFormat?: string;
};

export type BulkExtractOptions = {
  /** @username, t.me link, invite link or chat ID. */
  target: string;
  /** ISO date or datetime; blank reads the whole history. */
  after?: string;
  maxMessages?: number;
  search?: string;
  pattern?: string;
  keepUnmatched?: boolean;
  lineFormat?: string;
  store?: BulkExtractStore | null;
};

export type ExtractLine = {
  accountId: number;
  accountName: string;
  chat: string;
  messageId: number;
  date: string;
  sender: string;
  senderName: string;
  text: string;
  value: string;
  line: string;
};

export type ExtractResults = {
  lines: ExtractLine[];
  total: number;
  truncated: boolean;
  placeholders: string[];
};

/** The three release lines the publish workflow builds, each with its own image alias. */
export type ReleaseChannel = "latest" | "beta" | "dev";

export type UpdateStatus = {
  /** What is running; empty when this is not a published image. */
  current: string;
  channel: ReleaseChannel;
  /** Newest published build on this channel, or empty when it could not be worked out. */
  latest: string;
  updateAvailable: boolean;
  url: string;
  checkedAt: number;
  /** Why there is no answer: the check is off, the build is unstamped, or the fetch failed. */
  reason?: "disabled" | "unstamped" | "error";
  error?: string;
};

export const bulkTasksApi = {
  list: () =>
    api.get<{ tasks: BulkTask[] }>("/bulk-tasks").then((r) => r.data.tasks),
  get: (id: string) => api.get<BulkTask>(`/bulk-tasks/${id}`).then((r) => r.data),
  cancel: (id: string) =>
    api
      .post<{ cancelled: boolean }>(`/bulk-tasks/${id}/cancel`)
      .then((r) => r.data),
  dismiss: (id: string) =>
    api.delete<{ dismissed: boolean }>(`/bulk-tasks/${id}`).then((r) => r.data),
  spamCheck: (ids: number[], gapSeconds?: number) =>
    api
      .post<BulkTask>("/bulk-tasks/spam-check", { ids, gapSeconds })
      .then((r) => r.data),
  fetchAttributes: (ids: number[], gapSeconds?: number) =>
    api
      .post<BulkTask>("/bulk-tasks/fetch-attributes", { ids, gapSeconds })
      .then((r) => r.data),
  loginEmail: (
    ids: number[],
    opts:
      | { source?: "gmail"; gmail: string; appPassword: string; tag: string }
      | { source: "msapi"; poolType?: string },
    gapSeconds?: number,
  ) =>
    api
      .post<BulkTask>("/bulk-tasks/login-email", { ids, ...opts, gapSeconds })
      .then((r) => r.data),
  credentials: (
    ids: number[],
    opts: {
      currentPassword?: string;
      newPassword: string;
      removeDevices?: boolean;
      removePasskeys?: boolean;
      notesAppend?: string;
    },
    gapSeconds?: number,
  ) =>
    api
      .post<BulkTask>("/bulk-tasks/credentials", { ids, ...opts, gapSeconds })
      .then((r) => r.data),
  passkey: (ids: number[], gapSeconds?: number) =>
    api
      .post<BulkTask>("/bulk-tasks/passkey", { ids, gapSeconds })
      .then((r) => r.data),
  privacy: (
    ids: number[],
    settings: Record<string, PrivacyLevel>,
    gapSeconds?: number,
  ) =>
    api
      .post<BulkTask>("/bulk-tasks/privacy", { ids, settings, gapSeconds })
      .then((r) => r.data),
  clean: (ids: number[], gapSeconds?: number) =>
    api.post<BulkTask>("/bulk-tasks/clean", { ids, gapSeconds }).then((r) => r.data),
  extractMessages: (
    ids: number[],
    opts: BulkExtractOptions,
    gapSeconds?: number,
  ) =>
    api
      .post<BulkTask>("/bulk-tasks/extract-messages", { ids, ...opts, gapSeconds })
      .then((r) => r.data),
  /** The lines an extraction task collected; kept off the polled task list for size. */
  extractResults: (id: string) =>
    api
      .get<ExtractResults>(`/bulk-tasks/${id}/extract`)
      .then((r) => r.data),
  extractText: (id: string) =>
    api
      .get<string>(`/bulk-tasks/${id}/extract`, {
        params: { format: "text" },
        // Axios would try to JSON-parse a plain-text body and hand back an object
        responseType: "text",
        transformResponse: [(d) => d],
      })
      .then((r) => r.data),
  runJobs: (ids: number[], gapSeconds?: number, maxRunSeconds?: number) =>
    api
      .post<BulkTask>("/bulk-tasks/run-jobs", { ids, gapSeconds, maxRunSeconds })
      .then((r) => r.data),
};
