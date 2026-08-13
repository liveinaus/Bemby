import type { CustomConfig, JobTemplate } from "../api/client";

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

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "tg-api",
    labelKey: "templates.presets.tgApi",
    hintKey: "templates.presets.tgApiHint",
    template: tgApiTemplate,
  },
];
