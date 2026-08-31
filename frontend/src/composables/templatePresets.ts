import { computed } from "vue";
import type { CustomConfig, JobTemplate } from "../api/client";
import { dataStoreEnabled } from "./dataStore";
import { msApiConfigured } from "./msApi";

// Templates that come with Bemby, offered when a new one is being made: the form is filled in
// with a working chain, and whoever is making it reads it over and saves. Nothing is created
// behind anyone's back, and the copy is theirs to edit -- a preset is a starting point, not a
// managed template.

export type TemplatePreset = {
  /** Stable id, used as the option value. */
  id: string;
  /** What it is called in the picker; translated at the call site. */
  labelKey: string;
  /** One line on what it does and what it needs; translated at the call site. */
  hintKey: string;
  /** Only offered where the data store is switched on: the chain keeps its result there. */
  requiresDataStore?: boolean;
  /** Only offered where msOauth2api is configured: the chain takes an address from the pool. */
  requiresMsApi?: boolean;
  /** The template as the form reads one, with no id of its own. */
  template: () => JobTemplate;
};

/**
 * Where my.telegram.org shows the two values, once an app exists.
 *
 * Not an id: the page labels each value with `label[for=app_id]` but hangs the value itself on
 * an unnamed span beside it, so the group is found by its label and the span read out of it.
 * The same pair of selectors answers all three questions the chain asks -- has this account an
 * app already, did the one just created come up, and what does it say.
 */
const API_ID_VALUE = '.form-group:has(label[for="app_id"]) span.uneditable-input';
const API_HASH_VALUE = '.form-group:has(label[for="app_hash"]) span.uneditable-input';

/**
 * my.telegram.org, driven end to end: sign in as the account, take the API app it already has
 * or make one, and write the api_id/api_hash pair back onto the account.
 *
 * Two things make this possible without anybody typing a code: the login code arrives inside
 * Telegram on the very account being signed in as (`web_tg_code` reads it), and the pair goes
 * to the account rather than to a person to copy across (`web_tg_api_save` writes it). The
 * phone is `{accountPhone}`, so one template covers every account linked to it.
 *
 * The browser profile is pinned to `{tgId}` on purpose: my.telegram.org keeps its session in a
 * cookie, and a profile shared across accounts would sign the second run in as the first
 * account. Pinned to the account, a later run finds itself still signed in and skips the login
 * altogether -- which the first branch checks for.
 */
function tgApiTemplate(): JobTemplate {
  const config: CustomConfig = {
    actions: [
      {
        type: "open_url",
        url: "https://my.telegram.org/auth",
        // A run that has to wait for the login code needs room: the code alone is given 3
        // minutes, and the pages either side of it take their own time
        maxWaitMs: 420000,
        profileId: "{tgId}",
        steps: [
          {
            type: "web_if",
            check: "element",
            selector: "#my_login_phone",
            waitMs: 8000,
            then: [
              { type: "web_input", selector: "#my_login_phone", text: "{accountPhone}" },
              { type: "web_button", selector: "#my_send_form button[type=submit]" },
              // The code form starts hidden, so waiting for it is waiting for the site to
              // have accepted the number
              { type: "web_wait_element", selector: "#my_password", waitMs: 30000 },
              { type: "web_tg_code", varName: "tgCode", waitMs: 180000 },
              { type: "web_input", selector: "#my_password", text: "{tgCode}" },
              // Keeps the session cookie in this profile, which is what lets a later run
              // find itself already signed in
              { type: "web_button", selector: "#my_login_form input[name=remember]" },
              { type: "web_button", selector: "#my_login_form button[type=submit]" },
              { type: "web_delay", waitMs: 4000 },
            ],
          },
          { type: "web_goto", url: "https://my.telegram.org/apps", waitMs: 30000 },
          {
            type: "web_if",
            check: "element",
            selector: API_ID_VALUE,
            // Run the branch when the page does *not* already show an app: nothing to read
            // yet, so one is created first. The page it shows instead carries the same field
            // names, so this check is what keeps the create form from being typed into an
            // existing app's settings.
            negate: true,
            waitMs: 8000,
            then: [
              { type: "web_input", selector: "input[name=app_title]", text: "Bemby {num:4}" },
              // Alphanumeric, 5-32 characters, and taken by nobody else
              { type: "web_input", selector: "input[name=app_shortname]", text: "bemby{num:6}" },
              // Registered as a web app. Two selectors, since only the platform names the site
              // actually offers can be picked: whichever is there is clicked, web first.
              {
                type: "web_button",
                selector:
                  "input[name=app_platform][value=web], input[name=app_platform][value=other]",
              },
              { type: "web_input", selector: "textarea[name=app_desc]", text: "Bemby" },
              { type: "web_button", selector: "button.btn-primary" },
              { type: "web_wait_element", selector: API_ID_VALUE, waitMs: 30000 },
            ],
          },
          { type: "web_read", selector: API_ID_VALUE, varName: "apiId", maxChars: 32 },
          // The hash is a login in its own right, so it is held under a name without being
          // written into the run log
          { type: "web_read", selector: API_HASH_VALUE, varName: "apiHash", maxChars: 64, secret: true },
          {
            type: "web_tg_api_save",
            apiId: "{apiId}",
            apiHash: "{apiHash}",
            folder: "tgApi",
          },
        ],
      },
    ],
  };

  return {
    id: 0,
    name: "Telegram API credentials",
    jobType: "custom",
    botUsername: "",
    timezone: "",
    replyTimeoutMs: 40000,
    retryMax: 2,
    enabled: true,
    config: JSON.stringify(config),
    startCommand: "/start",
    checkinButton: "签到",
    createdAt: "",
    // Credentials are fetched once and then kept; a monthly job is only there to pick up an
    // account whose pair was cleared
    runEveryDays: 30,
    runEveryDaysMax: null,
    icon: null,
  };
}

/**
 * Signs in to a personal Outlook mailbox and connects it to msOauth2api, which is what keeps
 * the refresh token. A mailbox client cannot be handed a password and a second factor; a
 * token it can, and msOauth2api is what holds and refreshes them.
 *
 * Nothing here names an application. `web_ms_oauth2_start` asks the service for the sign-in
 * address, so the registration, the redirect address, the PKCE pair and the scopes are all
 * its; `web_ms_oauth2` then asks it whether the mailbox landed. No token passes through
 * Bemby at any point, and none is stored here.
 *
 * Works the `outlook` folder as a list: each round takes the record at its own position, and
 * one already marked `connectedAt` is passed over -- so a re-run only picks up the mailboxes
 * added since. Set the rounds to how many the folder holds; a round past the end fails on its
 * own and the ones before it stand.
 *
 * Each record is `{password, totp}` under the address as its key. The `totp` field is the
 * authenticator secret the account was enrolled with, not a code: `web_totp` works the six
 * digits out at the moment the page asks for them.
 *
 * Each round signs out of whoever was there first, since one browser signing in as several
 * accounts in turn would otherwise consent as the first of them. Should that happen anyway,
 * msOauth2api compares the sign-in against the address the flow was started for and stores
 * nothing on a mismatch, so the round fails rather than filing the wrong mailbox's token.
 */
function outlookOauthTemplate(): JobTemplate {
  const config: CustomConfig = {
    actions: [
      {
        type: "open_url",
        // Somewhere harmless to start: every round navigates itself
        url: "https://login.live.com/logout.srf",
        // Eight mailboxes, each with a sign-in, a second factor and a consent screen in it
        maxWaitMs: 1800000,
        // No profile: nothing here is worth keeping between runs, and a fresh browser is one
        // that cannot be holding another mailbox's session
        profileId: "{noProfile}",
        steps: [
          {
            type: "web_repeat",
            times: 8,
            // A mailbox that will not sign in is not the rest of the folder's problem
            continueOnError: true,
            betweenMs: 5000,
            steps: [
              // The record at this round's position: its key is the address, and whether it
              // already holds a token is what decides if there is anything to do
              {
                type: "web_data_pick",
                folder: "outlook",
                index: "{i}",
                varName: "email",
                valueVar: "savedMarker",
                path: "connectedAt",
                optional: true,
              },
              {
                type: "web_if",
                check: "value",
                value: "{savedMarker}",
                negate: true,
                then: [
                  { type: "web_data_read", folder: "outlook", key: "{email}", path: "password", varName: "password" },
                  {
                    type: "web_data_read",
                    folder: "outlook",
                    key: "{email}",
                    path: "totp",
                    varName: "otpSecret",
                    // An account without two-factor authentication is never asked for a code
                    optional: true,
                  },
                  // Out of whoever was signed in a moment ago, before asking for this one
                  { type: "web_goto", url: "https://login.live.com/logout.srf", waitMs: 20000 },
                  { type: "web_ms_oauth2_start", email: "{email}" },
                  {
                    type: "web_if",
                    check: "element",
                    selector: "input[name=loginfmt]",
                    waitMs: 15000,
                    // The address is usually taken from `login_hint`; this is for when it is not
                    then: [
                      { type: "web_input", selector: "input[name=loginfmt]", text: "{email}" },
                      { type: "web_button", selector: "#idSIButton9" },
                      { type: "web_delay", waitMs: 3000 },
                    ],
                  },
                  { type: "web_wait_element", selector: "input[name=passwd]", waitMs: 30000 },
                  { type: "web_input", selector: "input[name=passwd]", text: "{password}" },
                  { type: "web_button", selector: "#idSIButton9" },
                  {
                    type: "web_if",
                    check: "element",
                    selector: "input[name=otc]",
                    waitMs: 20000,
                    then: [
                      { type: "web_totp", secretRef: "{otpSecret}", varName: "otpCode" },
                      { type: "web_input", selector: "input[name=otc]", text: "{otpCode}" },
                      {
                        type: "web_button",
                        selector: "#idSubmit_SAOTCC_Continue, #iVerifyCodeAction, #idSIButton9",
                      },
                    ],
                  },
                  // "Set up a passwordless account": offered, not required
                  {
                    type: "web_if",
                    check: "element",
                    selector: "#iShowSkip",
                    waitMs: 8000,
                    then: [{ type: "web_button", selector: "#iShowSkip" }],
                  },
                  // "Stay signed in?" -- answered no, so the next round starts clean. The
                  // checkbox is what names the page: its Yes button is `#idSIButton9`, which
                  // half the pages in this flow also use
                  {
                    type: "web_if",
                    check: "element",
                    selector: "#KmsiCheckboxField, input[name=DontShowAgain]",
                    waitMs: 10000,
                    then: [{ type: "web_button", selector: "#idBtn_Back" }],
                  },
                  // The consent screen, shown the first time this app asks for these scopes
                  {
                    type: "web_if",
                    check: "element",
                    selector: "input[type=submit][value=Accept], #idSIButton9",
                    waitMs: 10000,
                    then: [
                      {
                        type: "web_button",
                        selector: "input[type=submit][value=Accept], #idSIButton9",
                      },
                    ],
                  },
                  // Nothing to run, so this is a wait: it holds until the browser lands back
                  // on the redirect address, which is where the code is
                  {
                    type: "web_if",
                    check: "url",
                    text: "/api/oauth/callback",
                    waitMs: 60000,
                  },
                  // Straight into the record it belongs to: the token is never logged, so a
                  // run that only held it under a name would have nothing to show for itself
                  {
                    type: "web_ms_oauth2",
                    email: "{email}",
                    varName: "connectedAt",
                    folder: "outlook",
                    key: "{email}",
                    path: "connectedAt",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  return {
    id: 0,
    name: "Outlook OAuth2 refresh token",
    jobType: "custom",
    botUsername: "",
    timezone: "",
    replyTimeoutMs: 40000,
    retryMax: 1,
    enabled: true,
    config: JSON.stringify(config),
    startCommand: "/start",
    checkinButton: "签到",
    createdAt: "",
    // A token is minted once and kept; the weekly run is there to pick up the mailboxes added
    // since, and passes over every record that already has one
    runEveryDays: 7,
    runEveryDaysMax: null,
    icon: null,
  };
}

/** Where a personal account's sign-in methods are managed. */
const MS_PROOFS_URL = "https://account.live.com/proofs/manage/additional";

/**
 * Fills in what a fresh mailbox is missing: a recovery address and an authenticator secret.
 * A record with neither is one that cannot be recovered and cannot pass a sign-in that asks
 * for a second factor -- so this is what turns a bare `{password}` record into a usable one.
 *
 * The recovery address is taken from the msOauth2api pool rather than typed in, which is what
 * makes this worth running unattended: the pool hands out an address nothing has used, the
 * code Microsoft sends to it is read back through the same service, and the address is written
 * onto the record. The authenticator secret is captured off the enrolment page itself and
 * saved before it is verified, since the page shows it once and an account half-enrolled with
 * a secret nobody kept is worse off than one never touched.
 *
 * Each part is skipped for a record that already has it, so a re-run only fills the gaps.
 *
 * Microsoft's account pages are drawn by script and reworded often, so the steps that press a
 * named control go through the vision model (`hint`) rather than a selector that would be
 * stale within the month. That means an AI key is needed. Run it once in debug and expect to
 * adjust: this is a starting point, and the screenshots on the run tell you what to change.
 */
function outlookProofsTemplate(): JobTemplate {
  const config: CustomConfig = {
    actions: [
      {
        type: "open_url",
        url: "https://login.live.com/logout.srf",
        // A sign-in, a mailed code and two enrolment flows per mailbox
        maxWaitMs: 1800000,
        profileId: "{noProfile}",
        steps: [
          {
            type: "web_repeat",
            times: 5,
            continueOnError: true,
            betweenMs: 8000,
            steps: [
              {
                type: "web_data_pick",
                folder: "outlook",
                index: "{i}",
                varName: "email",
                valueVar: "savedRecovery",
                path: "recovery",
                optional: true,
              },
              {
                type: "web_data_read",
                folder: "outlook",
                key: "{email}",
                path: "totp",
                varName: "savedTotp",
                optional: true,
              },
              { type: "web_data_read", folder: "outlook", key: "{email}", path: "password", varName: "password" },

              // Signed in fresh each round: one browser signing in as several accounts in turn
              // would otherwise manage the first one's security settings under the next one's name
              { type: "web_goto", url: "https://login.live.com/logout.srf", waitMs: 20000 },
              { type: "web_goto", url: MS_PROOFS_URL, waitMs: 30000 },
              {
                type: "web_if",
                check: "element",
                selector: "input[name=loginfmt]",
                waitMs: 20000,
                then: [
                  { type: "web_input", selector: "input[name=loginfmt]", text: "{email}" },
                  { type: "web_button", selector: "button[type=submit], #idSIButton9" },
                  { type: "web_delay", waitMs: 4000 },
                ],
              },
              { type: "web_wait_element", selector: "input[name=passwd]", waitMs: 30000 },
              { type: "web_input", selector: "input[name=passwd]", text: "{password}" },
              { type: "web_button", selector: "button[type=submit], #idSIButton9" },
              { type: "web_delay", waitMs: 12000 },
              // Only an account that already has an authenticator is asked, and then only the
              // stored secret can answer -- a record without one fails here, which is the truth
              // of it rather than something to paper over
              {
                type: "web_if",
                check: "element",
                selector: "input[name=otc]",
                waitMs: 15000,
                then: [
                  { type: "web_totp", secretRef: "{savedTotp}", varName: "otpCode" },
                  { type: "web_input", selector: "input[name=otc]", text: "{otpCode}" },
                  { type: "web_button", selector: "button[type=submit], #idSubmit_SAOTCC_Continue" },
                  { type: "web_delay", waitMs: 8000 },
                ],
              },
              {
                type: "web_if",
                check: "element",
                selector: "#iShowSkip",
                waitMs: 8000,
                then: [{ type: "web_button", selector: "#iShowSkip" }],
              },
              {
                type: "web_if",
                check: "element",
                selector: "#KmsiCheckboxField, input[name=DontShowAgain]",
                waitMs: 10000,
                then: [{ type: "web_button", selector: "#idBtn_Back" }],
              },

              // ── A recovery address, for a record with none ──────────────────────────────
              {
                type: "web_if",
                check: "value",
                value: "{savedRecovery}",
                negate: true,
                then: [
                  { type: "web_goto", url: MS_PROOFS_URL, waitMs: 30000 },
                  // Claimed before it is typed anywhere: the claim lapses on its own if the
                  // code never arrives, so an abandoned round does not consume an address
                  { type: "web_email_lease", varName: "recoveryEmail" },
                  { type: "ai_web_button", hint: "the control that adds a new way to sign in or verify" },
                  { type: "ai_web_button", hint: "the option to verify with an email address, e.g. \"Email a code\"" },
                  {
                    type: "web_wait_element",
                    selector: "input[type=email], input[name=EmailAddress], input[name=Email]",
                    waitMs: 25000,
                  },
                  {
                    type: "web_input",
                    selector: "input[type=email], input[name=EmailAddress], input[name=Email]",
                    text: "{recoveryEmail}",
                  },
                  { type: "ai_web_button", hint: "the Next or Send code button" },
                  {
                    type: "web_email_code",
                    source: "msapi",
                    email: "{recoveryEmail}",
                    varName: "proofCode",
                    fromContains: "microsoft",
                    waitMs: 180000,
                  },
                  {
                    type: "web_wait_element",
                    selector: "input[name=ProofConfirmation], input[name=otc], input[type=tel]",
                    waitMs: 30000,
                  },
                  {
                    type: "web_input",
                    selector: "input[name=ProofConfirmation], input[name=otc], input[type=tel]",
                    text: "{proofCode}",
                  },
                  { type: "ai_web_button", hint: "the Next or Verify button" },
                  { type: "web_delay", waitMs: 6000 },
                  {
                    type: "web_data_save",
                    folder: "outlook",
                    key: "{email}",
                    path: "recovery",
                    value: "{recoveryEmail}",
                  },
                ],
              },

              // ── An authenticator secret, for a record with none ─────────────────────────
              {
                type: "web_if",
                check: "value",
                value: "{savedTotp}",
                negate: true,
                then: [
                  { type: "web_goto", url: MS_PROOFS_URL, waitMs: 30000 },
                  { type: "ai_web_button", hint: "the control that adds a new way to sign in or verify" },
                  { type: "ai_web_button", hint: "the authenticator app option, e.g. \"Use an app\"" },
                  { type: "ai_web_button", hint: "the link to set up a different authenticator app" },
                  // The secret is behind "can't scan": the QR alone says nothing a page step
                  // can read, and a canvas-drawn code says nothing at all
                  { type: "ai_web_button", hint: "the link that says the barcode or QR code cannot be scanned" },
                  { type: "web_otp_secret", varName: "newSecret", waitMs: 25000 },
                  // Kept before it is proved: the page shows it once, and an enrolment that
                  // falls over after this point is recoverable only with the secret in hand
                  {
                    type: "web_data_save",
                    folder: "outlook",
                    key: "{email}",
                    path: "totp",
                    value: "{newSecret}",
                  },
                  { type: "ai_web_button", hint: "the Next or Continue button" },
                  {
                    type: "web_wait_element",
                    selector: "input[name=otc], input[name=Code], input[type=tel]",
                    waitMs: 30000,
                  },
                  { type: "web_totp", secretRef: "{newSecret}", varName: "newCode" },
                  {
                    type: "web_input",
                    selector: "input[name=otc], input[name=Code], input[type=tel]",
                    text: "{newCode}",
                  },
                  { type: "ai_web_button", hint: "the Next or Verify button" },
                  { type: "web_delay", waitMs: 6000 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  return {
    id: 0,
    name: "Outlook recovery email and 2FA",
    jobType: "custom",
    botUsername: "",
    timezone: "",
    replyTimeoutMs: 40000,
    retryMax: 1,
    enabled: true,
    config: JSON.stringify(config),
    startCommand: "/start",
    checkinButton: "签到",
    createdAt: "",
    // Set once per mailbox; the weekly run is there for the records added since
    runEveryDays: 7,
    runEveryDaysMax: null,
    icon: null,
  };
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "tg-api",
    labelKey: "templates.presets.tgApi",
    hintKey: "templates.presets.tgApiHint",
    requiresDataStore: true,
    template: tgApiTemplate,
  },
  {
    id: "outlook-oauth",
    labelKey: "templates.presets.outlookOauth",
    hintKey: "templates.presets.outlookOauthHint",
    requiresDataStore: true,
    template: outlookOauthTemplate,
  },
  {
    id: "outlook-proofs",
    labelKey: "templates.presets.outlookProofs",
    hintKey: "templates.presets.outlookProofsHint",
    requiresDataStore: true,
    requiresMsApi: true,
    template: outlookProofsTemplate,
  },
];

/** What the picker offers right now; an empty list means the picker is not shown at all. */
export const availableTemplatePresets = computed(() =>
  TEMPLATE_PRESETS.filter(
    (p) =>
      (!p.requiresDataStore || dataStoreEnabled.value) &&
      (!p.requiresMsApi || msApiConfigured.value),
  ),
);
