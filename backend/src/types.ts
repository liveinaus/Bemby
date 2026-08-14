export type AuthStatus =
  | "unauthenticated"
  | "pending_code"
  | "pending_2fa"
  | "authenticated"
  | "session_expired";
export type JobType = "checkin" | "embywatch" | "custom" | "autoreg";
export type LogStatus = "success" | "failed" | "running";

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

export type TgAccount = {
  id: number;
  name: string;
  phoneNumber: string;
  /** Null when the account relies on the global default from settings. */
  apiId: number | null;
  apiHash: string | null;
  sessionString: string | null;
  authStatus: AuthStatus;
  proxyId: string | null;
  disabled: boolean;
  appClientId: string | null;
  createdAt: string;
};

export type Job = {
  id: number;
  name: string;
  /** null for embywatch jobs that don't require a Telegram account */
  accountId: number | null;
  jobType: JobType;
  /** checkin: Telegram bot username. embywatch: Emby server URL */
  botUsername: string;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  /** IANA zone; empty means follow the default_timezone setting */
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
  /** Upper bound of the run-every-days range; null means a fixed interval. */
  runEveryDaysMax?: number | null;
  retired?: string | null;
  /** ISO timestamp of the last successful run; persisted so log purges don't lose it. */
  lastSuccessAt?: string | null;
  /** Icon-font class name, or "custom:<file>" for an uploaded one; null uses the default. */
  icon?: string | null;
};

export type JobTemplate = {
  id: number;
  name: string;
  jobType: JobType;
  botUsername: string;
  /** IANA zone; empty means follow the default_timezone setting */
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
  /** Upper bound of the run-every-days range; null means a fixed interval. */
  runEveryDaysMax?: number | null;
  /** Icon jobs created from this template start with; see Job.icon. */
  icon?: string | null;
};

export type CustomAction =
  | { type: "send_command"; content: string; maxRetries?: number }
  | {
      // Send a message/command to a specific contact (bot/group/user), rather than the
      // job's configured bot. Supports the same {aiInput} and command expansion as send_command.
      type: "send_contact_message";
      contact: string;
      content: string;
      maxRetries?: number;
    }
  // `scope` limits which messages an action considers, relative to the last
  // message we sent (the anchor). 0 (default) = only replies newer than the
  // anchor; -N = also the N most recent incoming messages before the anchor.
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
      // Click a button on the latest message from a specific contact (bot/group/user),
      // rather than from the job's configured bot. Seeds from the contact's last received
      // message and otherwise waits up to maxWaitMs for an incoming one with buttons.
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
      // AI selects and clicks multiple buttons in order. The AI returns a JSON array of
      // exact button texts; each is clicked in sequence with `gapMs` between clicks.
      // `contact` empty/undefined targets the job's bot chat; otherwise that peer.
      type: "ai_multiple_btn";
      contact?: string;
      hint?: string;
      /**
       * Only a buttons message whose text contains this string is picked, so a
       * stale or unrelated menu in the same chat is never clicked. Blank takes
       * the most recent in-scope buttons message.
       */
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
      // When set, after joining, wait for an in-group verification message and click the
      // button whose text contains this string (bot-gated groups). verifyWaitMs bounds the wait.
      verifyButton?: string;
      verifyWaitMs?: number;
      /**
       * Bounds the whole verification, not just the wait for the prompt: a button that
       * hands verification to a private chat with the bot leads to more steps, and those
       * bots ban on their own deadline. Defaults to verifyWaitMs + 60s.
       */
      verifyMaxWaitMs?: number;
      /**
       * Click only a prompt that names this account (@username, a text mention, or its
       * numeric id), so a group verifying several joiners at once never has someone
       * else's prompt clicked. Prompts for other people are waited past.
       */
      verifyMentionsMe?: boolean;
      /**
       * Also treat a prompt that masks the name ("阿**2" -- first and last character kept)
       * as ours. Welcome bots that mask never @-mention, so verifyMentionsMe cannot see them.
       */
      verifyMaskedName?: boolean;
    }
  | {
      // Open a Mini App button's page in the installed browser (passing Cloudflare on
      // the way) and press a control inside the app, which is where such bots put the
      // actual checkin. `contact` empty/undefined targets the job's bot chat.
      type: "open_mini_app";
      contact?: string;
      /** Inline button that opens the Mini App; blank takes the most recent one. */
      button?: string;
      /**
       * Steps to run inside the app, in order: a control's visible text, `css:<selector>`,
       * `delay(2500)`, `scroll(x, y)` to reach something below the fold, `{turnstile}` to
       * tick a Cloudflare checkbox where one is shown, or an `{aiBtn}` / `{input}` /
       * `{aiInput}` placeholder. Blank auto-detects a checkin-worded control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /**
       * Budget for the browser part of this action, across every proxy tried.
       * Blank/0 uses the built-in default (5 minutes).
       */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, "direct" for none, or "random" for a draw from `proxyPool`. Blank uses the job's. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares. A name built from
       * `{ip}` (the exit), `{jobId}`, `{templateId}`, `{tgId}` (the account) and any text you
       * like: `{ip}` pools one profile per exit, `{ip}-{jobId}` gives this job its own,
       * `{tgId}` follows the account across its jobs, `user1-{ip}` is a name of your own.
       * Blank takes the default from Settings.
       */
      profileId?: string;
      /**
       * Keep whatever the app itself stored in the profile last run. Off by default: the
       * signed URL names this account, but an app that kept its own login in localStorage
       * (or a cookie) reads that instead and shows whoever signed in first -- which is what
       * several accounts sharing an `{ip}` profile all end up looking like. Cleared before
       * the page loads, Cloudflare's own cookies excepted, so the app has nothing to go on
       * but the init data. Tick this only for an app whose stored state is worth keeping.
       */
      keepAppSession?: boolean;
    }
  | {
      // Same as `open_mini_app`, but the address is given rather than hunted from a button
      // in the chat. Telegram still signs it for the job's own account, so the app sees
      // that user -- which is what makes one template usable across many accounts.
      type: "open_mini_app_url";
      /** Mini App address, or a t.me/<bot>/<app> link, which names its own bot. */
      url: string;
      /** Bot that owns the app, used to sign the URL. Blank uses the job's bot. */
      contact?: string;
      /**
       * Steps to run inside the app, in order, same vocabulary as `open_mini_app`
       * (control text, `css:`, `delay()`, `scroll()`, `{turnstile}`, `{aiBtn}`, `{input}`,
       * `{aiInput}`). Blank auto-detects a checkin control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part of this action. Blank/0 uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, "direct" for none, or "random" for a draw from `proxyPool`. Blank uses the job's. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares. A name built from
       * `{ip}` (the exit), `{jobId}`, `{templateId}`, `{tgId}` (the account) and any text you
       * like: `{ip}` pools one profile per exit, `{ip}-{jobId}` gives this job its own,
       * `{tgId}` follows the account across its jobs, `user1-{ip}` is a name of your own.
       * Blank takes the default from Settings.
       */
      profileId?: string;
      /**
       * Keep whatever the app itself stored in the profile last run. Off by default: the
       * signed URL names this account, but an app that kept its own login in localStorage
       * (or a cookie) reads that instead and shows whoever signed in first -- which is what
       * several accounts sharing an `{ip}` profile all end up looking like. Cleared before
       * the page loads, Cloudflare's own cookies excepted, so the app has nothing to go on
       * but the init data. Tick this only for an app whose stored state is worth keeping.
       */
      keepAppSession?: boolean;
    }
  | {
      // Open the Mini App a bot pins beside the composer -- the button at the bottom left
      // of its chat, next to the attachment clip. It belongs to the bot rather than to any
      // message, so nothing in the chat history points at it and no address needs typing:
      // the bot is asked what its button is, and Telegram signs it for this account.
      type: "open_bot_menu_app";
      /** Bot whose menu button to open. Blank uses the job's bot. */
      contact?: string;
      /**
       * Steps to run inside the app, in order, same vocabulary as `open_mini_app`
       * (control text, `css:`, `delay()`, `scroll()`, `{turnstile}`, `{aiBtn}`, `{input}`,
       * `{aiInput}`). Blank auto-detects a checkin control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part of this action. Blank/0 uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, "direct" for none, or "random" for a draw from `proxyPool`. Blank uses the job's. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares. A name built from
       * `{ip}` (the exit), `{jobId}`, `{templateId}`, `{tgId}` (the account) and any text you
       * like: `{ip}` pools one profile per exit, `{ip}-{jobId}` gives this job its own,
       * `{tgId}` follows the account across its jobs, `user1-{ip}` is a name of your own.
       * Blank takes the default from Settings.
       */
      profileId?: string;
      /**
       * Keep whatever the app itself stored in the profile last run. Off by default: the
       * signed URL names this account, but an app that kept its own login in localStorage
       * (or a cookie) reads that instead and shows whoever signed in first -- which is what
       * several accounts sharing an `{ip}` profile all end up looking like. Cleared before
       * the page loads, Cloudflare's own cookies excepted, so the app has nothing to go on
       * but the init data. Tick this only for an app whose stored state is worth keeping.
       */
      keepAppSession?: boolean;
    }
  | {
      // Open a plain web page in the installed browser, passing any Cloudflare challenge,
      // and drive it with the sub-steps below. Nothing about this action goes through
      // Telegram: the URL is opened directly.
      type: "open_url";
      url: string;
      /** Sub-steps run on the page once it is up, in order. */
      steps?: WebStep[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /**
       * Budget for the browser part of this action, across every proxy tried.
       * Blank/0 uses the built-in default (5 minutes).
       */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, "direct" for none, or "random" for a draw from `proxyPool`. Blank uses the job's. */
      proxyId?: string;
      /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
      proxyPool?: string[];
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
      /**
       * Which browser profile to run on, and so whose cookies this shares. A name built from
       * `{ip}` (the exit), `{jobId}`, `{templateId}`, `{tgId}` (the account) and any text you
       * like: `{ip}` pools one profile per exit, `{ip}-{jobId}` gives this job its own,
       * `{tgId}` follows the account across its jobs, `user1-{ip}` is a name of your own.
       * Blank takes the default from Settings.
       */
      profileId?: string;
    }
  | { type: "subscribe_channel"; channelId: string; checkMembership?: boolean };

/**
 * One sub-step of `open_url`, run against the loaded page.
 *
 * The `ai_*` variants hand a screenshot to the vision model rather than naming an element.
 * `ai_web_button` and `ai_web_input` number the interactive elements on the shot first, so
 * what comes back is a marker to press rather than a raw pixel guess, and the click lands
 * on a real element. `ai_web_click_xy` asks for a position instead, for what that cannot
 * reach: a control inside a cross-origin iframe or a closed shadow root (a Turnstile
 * checkbox), or one painted on a canvas, none of which any selector can number.
 *
 * `web_if` branches on what is on the page, which is what lets a job log in only when it has
 * to. The browser keeps one profile per exit, so the session cookie a login leaves behind is
 * still there on the next run -- and a site that rations logins does not want another one.
 *
 * `web_repeat` and `web_pick` are the pair that works a list the way a person does. The loop
 * runs a set number of rounds, and each round loads the list afresh and picks one value off
 * it -- rather than reading the whole list once at the start and working down a copy. That is
 * the point: a forum's front page moves while the job is on it, so a list collected up front
 * goes stale, and a round that falls over does not cost the post it was working on. `web_pick`
 * leaves out what has already been replied to, both on earlier runs and earlier rounds of
 * this one, and `{name}` in any later field of the round stands for what it chose.
 *
 * `web_collect` and `web_for_each` are the other pair, for when the list is what matters
 * rather than the page it came from: the collect reads every match into a name, and the loop
 * runs its steps once per value, `{name}` standing for the one in hand. Reach for these when
 * the round leaves the list page behind (open each post in turn), and for the `web_pick` pair
 * when it does not.
 */
export type WebStep =
  | {
      /** Type text into a field named by a CSS selector. */
      type: "web_input";
      selector: string;
      text: string;
    }
  | {
      /** Press a control named by a CSS selector. */
      type: "web_button";
      selector: string;
    }
  | {
      /** Sit still for a while, for a page that needs a moment between steps. */
      type: "web_delay";
      waitMs: number;
    }
  | {
      /**
       * Scroll the page by pixels, to bring something below the fold within reach of the
       * steps after it. Either figure may be negative to scroll back, and one past the end
       * of the page simply lands at the end.
       */
      type: "web_scroll";
      /** Horizontal move in pixels. Blank/0 leaves the column alone. */
      x?: number;
      /** Vertical move in pixels. Blank/0 leaves the row alone. */
      y?: number;
    }
  | {
      /**
       * Scroll until the element a selector names is in view, rather than by a distance.
       *
       * Better than pixels whenever the target has a selector: a page whose length depends on
       * its content puts it somewhere different every run, and a fixed distance then lands
       * somewhere arbitrary. Works for a target inside a scrollable panel as well as the page.
       */
      type: "web_scroll_to";
      selector: string;
      /** How long to wait for it to appear before giving up. Blank/0 waits 5s. */
      waitMs?: number;
    }
  | {
      /**
       * Hold until a CSS selector is on the page and has a box, so the next step is not run
       * against a page that has not finished rendering what it needs.
       */
      type: "web_wait_element";
      selector: string;
      /** How long to wait before giving up. Blank/0 waits 30s. */
      waitMs?: number;
    }
  | {
      /**
       * Run one set of steps or another, going on what the page shows. The obvious use is a
       * login: ask whether the site still knows this browser, and only fill the form in when
       * it does not.
       */
      type: "web_if";
      /**
       * What to look at: an element the page holds, the words on it, or the address the
       * browser is on.
       */
      check: "element" | "text" | "url";
      /** CSS selector, for `element`. It must have a box on screen to count as there. */
      selector?: string;
      /** Words to look for, for `text` and `url`. Case is ignored. */
      text?: string;
      /** Run `then` when the condition is *not* met instead, e.g. "if not logged in". */
      negate?: boolean;
      /**
       * How long to give the condition before calling it unmet. Blank/0 waits 5s. Worth
       * having: a page that has only just loaded may not have drawn the thing being looked
       * for yet, and calling it absent too early takes the wrong branch.
       */
      waitMs?: number;
      /** Steps run when the condition holds. */
      then?: WebStep[];
      /** Steps run when it does not. Blank simply carries on with the steps after the `if`. */
      otherwise?: WebStep[];
    }
  | {
      /**
       * Run the sub-steps a set number of times. Nothing is iterated over: each round is a
       * fresh pass, which is what lets a round load the list again and pick off it. A loop
       * cannot go inside another loop, though it may go inside an `if`.
       */
      type: "web_repeat";
      /** How many rounds to run. */
      times: number;
      /** Steps run per round, in order. */
      steps?: WebStep[];
      /** Carry on with the next round when one fails. Defaults to true. */
      continueOnError?: boolean;
      /** Wait between rounds, so the site is not hit as fast as the browser can go. */
      betweenMs?: number;
    }
  | {
      /**
       * Pick one value off the page and hold it under a name for the rest of the round,
       * written `{name}` in any field of the steps that follow. Run inside a `web_repeat`,
       * against a list that has just been loaded: what it chooses is what the round works on.
       */
      type: "web_pick";
      /** Matches every candidate, e.g. `.post-list-item .post-title a`. */
      selector: string;
      /** Name to hold the chosen value under. */
      varName: string;
      /** Attribute to read from each match, e.g. `href`. Blank reads the element's text. */
      attribute?: string;
      /**
       * Regular expression narrowing each value down to the part worth keeping, e.g.
       * `/post-(\d+)` against an href. Capture group 1 is kept when there is one, otherwise
       * the whole match; a value the expression does not match is dropped. Blank keeps the
       * value as read.
       */
      pattern?: string;
      /**
       * Only consider candidates whose own text contains this, which is how a list is
       * narrowed by what a post is called rather than by where it links. CSS cannot ask
       * about text, so a selector alone cannot express "the giveaway ones"; this reads
       * each match's text and drops the rest before `pattern` runs. Case is ignored.
       */
      containsText?: string;
      /**
       * Which of the usable candidates to take. `first` is the top of the list and is
       * predictable; `random` spreads the choice about, which is both more like a person
       * reading a forum and less likely to keep retrying whatever sits at the top.
       * Defaults to `first`.
       */
      choose?: "first" | "random";
      /**
       * Leave out what this job has already been through, and remember the chosen value once
       * the round finishes cleanly. Kept per job, so another account's copy of the job still
       * has the whole page to choose from. Rounds earlier in this same run are left out too,
       * which is what stops two of them landing on the same post before either has been
       * written down. Off, the pick is free to find the same value every round -- which is
       * what one naming a control on the page rather than a post wants.
       */
      skipUsed?: boolean;
    }
  | {
      /**
       * Read every match off the page into a named list, for a `web_for_each` to work
       * through. Unlike `web_pick` this is read once and kept, so the loop can leave the page
       * it came from: collect the post ids on a forum's front page, then open each in turn.
       */
      type: "web_collect";
      /** Matches every candidate, e.g. `.post-list-item a`. */
      selector: string;
      /** Name to hold the list under; `{name}` is the value in hand inside the loop. */
      varName: string;
      /** Attribute to read from each match, e.g. `href`. Blank reads the element's text. */
      attribute?: string;
      /**
       * Regular expression narrowing each value down to the part worth keeping, e.g.
       * `/post-(\d+)` against an href. Capture group 1 is kept when there is one, otherwise
       * the whole match; a value the expression does not match is dropped.
       */
      pattern?: string;
      /** Only keep candidates whose own text contains this. Case is ignored. */
      containsText?: string;
      /** Keep at most this many, in page order. Blank/0 keeps everything it found. */
      limit?: number;
      /**
       * Leave out what this job has already been through, and remember each value once the
       * round that had it finishes cleanly. Kept per job, the same store `web_pick` uses.
       */
      skipUsed?: boolean;
    }
  | {
      /**
       * Run the sub-steps once per value of a list a `web_collect` put together, `{name}`
       * standing for the one in hand. A loop cannot go inside another loop, though it may go
       * inside an `if`.
       */
      type: "web_for_each";
      /** Name of the collected list to work through. */
      varName: string;
      /** Steps run per value, in order. */
      steps?: WebStep[];
      /** Stop after this many values. Blank/0 works through the whole list. */
      max?: number;
      /** Carry on with the next value when one round fails. Defaults to true. */
      continueOnError?: boolean;
      /** Wait between rounds, so the site is not hit as fast as the browser can go. */
      betweenMs?: number;
    }
  | {
      /**
       * Hold a value of your own under a name, without reading anything off the page. What a
       * signup needs: settle on a username and a password up front, fill the form in with
       * `{username}` and `{password}`, and send them on at the end -- rather than typing a
       * generated value straight into a field, where nothing afterwards can see what it was.
       */
      type: "web_set";
      /**
       * The names and their values, set in the order given: one may be built out of those
       * above it (`{fn}_{ln}_{num:4}`), which is why a signup's handful of them belongs in
       * one step rather than a step each.
       */
      vars?: Array<{
        /** Name to hold it under. */
        name: string;
        /**
         * What to hold. Takes the names already set (`{username}-{num:3}`) and the random
         * tokens every other template takes (`{word:4}`, `{alpha:12}`, `{randomFirstName}`),
         * drawn once here -- which is the point, since a name can then be used twice over.
         */
        value: string;
      }>;
      /** The one pair a config saved before `vars` carries. Read when `vars` is not there. */
      varName?: string;
      value?: string;
    }
  | {
      /**
       * Read a record out of the data store and hold it under a name, for the steps after it
       * to use as `{name}`. The same value is readable inline as `{data.folder.key}` in any
       * text field; a step of its own is what a job wants when the value is needed in a
       * selector, or when the run should stop outright if nothing is stored.
       */
      type: "web_data_read";
      /** Folder holding the record, e.g. `example`. */
      folder: string;
      /** The record's key, e.g. `email`. */
      key: string;
      /** Field inside the record's value, e.g. `password`. Blank reads the whole record. */
      path?: string;
      /** Name to hold what was read under. */
      varName: string;
      /** Carry on with nothing stored under that name, rather than failing the step. */
      optional?: boolean;
    }
  | {
      /**
       * Take a record by its place in a folder rather than by its key, for a folder kept as a
       * queue: the accounts to sign in as, the addresses to use up. The record's own key is
       * held under a name -- which is the part `{data.folder.key}` cannot reach and the part a
       * later `web_data_delete` needs, since deleting number 0 is what moves the queue on.
       *
       * Oldest first, so a record added part-way goes to the back of the queue.
       */
      type: "web_data_pick";
      /** Folder to take from, e.g. `outlook`. */
      folder: string;
      /**
       * Which one, counting from 0. Takes the round's names (`{i}`), so a loop may walk the
       * folder without deleting as it goes. Blank means 0.
       */
      index?: string;
      /** Name to hold the record's key under. */
      varName: string;
      /** Name to hold the record's value under. Blank reads the key alone. */
      valueVar?: string;
      /** Field inside the value, e.g. `password`. Blank takes the whole value. */
      path?: string;
      /** Carry on when the folder holds nothing there, rather than failing the step. */
      optional?: boolean;
    }
  | {
      /**
       * Write a value to the data store, so it outlives the run: the account a signup just
       * made, or the address a site handed out. The folder and the record are made if they
       * are not there yet.
       */
      type: "web_data_save";
      folder: string;
      key: string;
      /** Field inside the record's value to write. Blank replaces the whole record. */
      path?: string;
      /**
       * What to store. Takes the round's names (`{username}`), the random tokens
       * (`{alpha:12}`) and other records (`{data.folder.key}`). Text that reads as JSON is
       * stored as JSON, so `{"a":1}` becomes an object rather than a string.
       */
      value: string;
    }
  | {
      /** Remove a record from the data store, or just one field of it. */
      type: "web_data_delete";
      folder: string;
      key: string;
      /** Field inside the record's value to remove. Blank removes the whole record. */
      path?: string;
      /** Carry on when there was nothing there, rather than failing the step. */
      optional?: boolean;
    }
  | {
      /**
       * Read a verification code out of a mailbox and hold it under a name, for a later
       * `web_input` to type as `{name}`. What a signup that emails a code needs: without it
       * the run stops at the confirmation box.
       *
       * Two sources. Gmail, over IMAP with an app password, reading the inbox and the junk
       * folder -- a code from an unfamiliar domain is often filtered as spam. Or msOauth2api,
       * which reads the mailbox for the address a `web_email_lease` step took, so a signup
       * gets an address of its own rather than a plus-tag on a shared inbox.
       *
       * The Gmail password is not part of the config: `appPassword` names a secret set in
       * Settings, written `{gmailAppPassword}`, and the value is read on the backend where
       * the step runs. Nothing hands it to the browser, and a shared or exported template
       * carries the name alone. The msOauth2api key is a setting, so it is never in a
       * template at all.
       */
      type: "web_email_code";
      /** Where to read from; blank is Gmail. */
      source?: "gmail" | "msapi";
      /** The mailbox to read, e.g. me@gmail.com, or `{name}` from a `web_email_lease`. */
      email: string;
      /** Secret holding the Gmail app password, written `{gmailAppPassword}`. Gmail only. */
      appPassword?: string;
      /** Pool type the address was leased under; blank uses the configured default. */
      poolType?: string;
      /** Name to hold the code under. */
      varName: string;
      /** Only consider mail whose sender contains this. Case is ignored. */
      fromContains?: string;
      /** Only consider mail whose subject contains this. Case is ignored. */
      subjectContains?: string;
      /**
       * Expression pulling the code out of the message, e.g. `Your code is (\d{6})`. Capture
       * group 1 is kept when there is one, otherwise the whole match. Blank looks for a 4-8
       * digit run, preferring one next to the word "code".
       */
      pattern?: string;
      /** How long to wait for the mail to arrive. Blank/0 waits 120s. */
      waitMs?: number;
    }
  | {
      /**
       * Take an address from the msOauth2api pool and hold it under a name, for a later
       * `web_input` to type as `{name}`. What a signup needs before it can ask for a code:
       * an address nothing has used for this service yet.
       *
       * The claim lapses on its own if no code ever arrives, so an abandoned run does not
       * consume an address. A `web_email_code` step pointed at the same name reads the code
       * back, which is also what makes the claim permanent.
       */
      type: "web_email_lease";
      /** Name to hold the address under. */
      varName: string;
      /** Pool type to lease from, e.g. Telegram. Blank uses the configured default. */
      poolType?: string;
    }
  | {
      /**
       * Wait for the login code Telegram delivers to this account and hold it under a name,
       * for a later `web_input` to type as `{name}`. What my.telegram.org needs: it posts its
       * code to the account inside Telegram rather than to an email address, so nothing a
       * mailbox step can read ever arrives.
       *
       * Read off Telegram's own service chat on the account the job belongs to, so the step
       * needs no address and no password of its own. The code the site sent is the newest
       * message there; anything sent before the step began is left alone.
       */
      type: "web_tg_code";
      /** Name to hold the code under. */
      varName: string;
      /**
       * Expression pulling the code out of the message, e.g. `code is (\S+)`. Capture group 1
       * is kept when there is one, otherwise the whole match. Blank covers both codes Telegram
       * sends: the token a web login gets (`Q6mq_4re-8s`) and the 5-6 digit run a phone login
       * gets, in that order.
       */
      pattern?: string;
      /** How long to wait for the message. Blank/0 waits 180s. */
      waitMs?: number;
    }
  | {
      /**
       * Send a message as the account this job belongs to, from the middle of a page run, and
       * hold the reply under a name. What a site's "link your Telegram" needs: the page puts a
       * one-off command on screen and the account itself has to send it, which `web_notify`
       * cannot do -- that goes out from the notification bot, and would link the wrong account.
       *
       * Sent over MTProto on the account's own client, so nothing about it reaches the browser.
       * A run that has to press "I have linked it" back on the page carries straight on: the
       * page is still open while this happens.
       */
      type: "web_tg_send";
      /** Who to send to: @username, a t.me link, or a numeric id. */
      contact: string;
      /** The message, with `{name}` filled in, e.g. `/start join_{joinCode}`. */
      text: string;
      /**
       * Carry on only once a reply holds one of these (`|` separated, any one of them).
       * Blank sends without waiting for anything.
       */
      replyContains?: string;
      /** Name to hold the reply text under. Waits for a reply even when blank matchers are set. */
      varName?: string;
      /** How long to wait for the reply. Blank/0 waits 60s. Nothing waits when neither is set. */
      waitMs?: number;
    }
  | {
      /**
       * Write an api_id/api_hash pair onto the account this job belongs to, the way Settings
       * writes the global pair: the hash goes in encrypted, and every job the account runs
       * uses the pair from then on. Reach for it at the end of a my.telegram.org run, once a
       * `web_read` has the two values off the page.
       *
       * Refuses anything that does not look like a pair, since a selector that has drifted
       * reads a label rather than a value -- and credentials that are junk only show up later
       * as an account that can no longer log in.
       */
      type: "web_tg_api_save";
      /** The api_id, e.g. `{apiId}` from a `web_read`. */
      apiId: string;
      /** The api_hash, e.g. `{apiHash}`. */
      apiHash: string;
      /**
       * Data-store folder to keep a copy in, e.g. `tgApi`. Blank writes to the account alone.
       * The copy is what puts the pair somewhere readable outside the account form.
       */
      folder?: string;
      /** Record key inside that folder. Blank uses the account's phone number. */
      key?: string;
    }
  | {
      /**
       * Send a message through the notification bot from the middle of a run, with `{name}`
       * standing for whatever the steps have gathered. What makes a signup worth running:
       * the account it just made is of no use if nothing says what the credentials were.
       */
      type: "web_notify";
      /** The message, e.g. `signed up: {username}----{password}`. */
      text: string;
      /** Chat to send to. Blank uses the one set in Settings. */
      target?: string;
    }
  | {
      /**
       * Read text off the page and hold it under a name, written `{name}` in any later field
       * of the round -- an AI hint, most usefully, so the model is given the post it is
       * replying to as text rather than having to make it out in a screenshot.
       */
      type: "web_read";
      /** Matches what to read; the first match is used, e.g. `.post-content`. */
      selector: string;
      /** Name to hold the text under. */
      varName: string;
      /** Cut the text to this many characters. Blank/0 keeps 1000. */
      maxChars?: number;
      /**
       * Keep what was read out of the log, showing its length alone. For a value that is a
       * login in its own right -- an api_hash, a token a page hands out -- which would
       * otherwise sit in the run log in full, and in every export of it.
       */
      secret?: boolean;
    }
  | {
      /**
       * Go to another address in the same browser, so whatever the page steps have already
       * logged into stays logged in. `{name}` is filled in from the loop's current value.
       */
      type: "web_goto";
      url: string;
      /** How long to wait for the page. Blank/0 waits 30s. */
      waitMs?: number;
    }
  | {
      /** Go back to the previous page, as the browser's back button does. */
      type: "web_back";
      /** How long to wait for the page to come back. Blank/0 waits 30s. */
      waitMs?: number;
    }
  | {
      /**
       * Hold the pointer down on something and let go after a while, which is what a
       * "press and hold to verify" control wants. A plain click presses and releases in the
       * same instant, so it never satisfies one.
       */
      type: "web_hold";
      selector: string;
      /** How long to keep it down. Blank/0 holds 1s. */
      holdMs?: number;
    }
  | {
      /**
       * Press and hold at a point measured from an element, rather than on the element
       * itself. What a widget with nothing to aim at wants: the checkbox, the handle or the
       * blank spot that has to be held is often unreachable by selector -- it lives in a
       * canvas, a shadow root or a frame -- while some steady container around it is not.
       * The anchor is only ever measured, never pressed.
       *
       * The point is drawn on this step's screenshot, so the offset can be read off the log
       * and corrected rather than guessed at twice.
       */
      type: "web_hold_offset";
      /** Element the offset is measured from. Nothing is clicked on it. */
      selector: string;
      /** Where on the anchor the offset starts. Defaults to its centre. */
      from?: "centre" | "topLeft";
      /** Rightward offset in pixels. May be negative. */
      x?: number;
      /** Downward offset in pixels. May be negative. */
      y?: number;
      /** How long to keep the pointer down. Blank/0 holds 1s. */
      holdMs?: number;
    }
  | {
      /**
       * Press on something, drag it, and let go -- a slider puzzle's handle pulled to the
       * right, or a piece dropped on its slot. The pointer is walked across in small moves
       * with a slight arc rather than teleported, since an instant jump from one point to
       * another is exactly what a slider check is watching for.
       */
      type: "web_drag";
      /** What to take hold of. */
      selector: string;
      /** Where to drop it. Blank drags by the offset below instead. */
      toSelector?: string;
      /** Horizontal distance in pixels, when there is no drop target. May be negative. */
      x?: number;
      /** Vertical distance in pixels, when there is no drop target. May be negative. */
      y?: number;
      /** How long the drag itself takes. Blank/0 takes 600ms. */
      durationMs?: number;
    }
  | {
      /**
       * Press a key, which is how a box that has no send button is sent: a comment field
       * that takes Ctrl+Enter, a search box that takes Enter. With a selector the key goes to
       * that element; without one it goes wherever the focus already is, which is the field
       * the step before it typed into.
       */
      type: "web_press";
      /** Key to press, Playwright's spelling: `Enter`, `Control+Enter`, `Escape`, `Tab`. */
      key: string;
      /** CSS selector to press it on. Blank presses wherever the focus is. */
      selector?: string;
    }
  | {
      /**
       * Choose an option in a dropdown. A `<select>` is not a field that can be typed into,
       * so `web_input` cannot work one.
       */
      type: "web_select";
      selector: string;
      /** The option's visible label, or its value. Whichever matches is used. */
      option: string;
    }
  | {
      /**
       * AI writes what belongs in a field named by a CSS selector, and types it. The field is
       * the caller's to name -- unlike `ai_web_input`, which has the model pick it off a
       * screenshot -- so this is what a page whose reply box is known but whose wording is not
       * wants: the hint says what to write, and `{name}` in it hands the model what a
       * `web_read` put there, e.g. the post being replied to.
       */
      type: "web_ai_input";
      selector: string;
      /** What to write, e.g. "a short friendly reply to this post: {postText}". */
      hint: string;
      /** Cut the model's answer to this many characters. Blank/0 types all of it. */
      maxChars?: number;
      /** Hold what was written under this name too, for a later step to reuse. */
      varName?: string;
    }
  | {
      /** AI reads a screenshot and decides which control to press. */
      type: "ai_web_button";
      /** Optional steer, e.g. "the login button". Blank lets the AI judge on its own. */
      hint?: string;
    }
  | {
      /**
       * Press a Cloudflare Turnstile checkbox on the page ("Verify you are human"), wherever
       * it sits. No AI: the widget is found through the browser's own protocol, which reaches
       * inside the cross-origin frame it draws in, and the checkbox is clicked at its known
       * place in the widget. Prefer this to `ai_web_click_xy` for a Turnstile.
       */
      type: "web_turnstile";
    }
  | {
      /**
       * AI reads a screenshot and gives back a pixel position, which is clicked exactly.
       * The page is ruled with a labelled grid before the shot so the figure is read off
       * the picture rather than estimated.
       */
      type: "ai_web_click_xy";
      /** Optional steer, e.g. "the verify-you-are-human checkbox". Blank lets the AI judge. */
      hint?: string;
    }
  | {
      /**
       * The same look, asking for several positions at once, each clicked in the order the
       * AI gave them with a pause between. For a page that wants more than one press to be
       * satisfied -- a picture captcha's matching tiles, or characters clicked in a stated
       * order -- where one `ai_web_click_xy` per target would take a fresh screenshot each
       * time and lose the order the first shot showed.
       */
      type: "ai_web_click_xy_multi";
      /** Optional steer, e.g. "each traffic light, left to right". Blank lets the AI judge. */
      hint?: string;
      /** Pause between one click and the next. Blank/0 waits 500ms. */
      gapMs?: number;
      /** Click at most this many positions. Blank/0 takes what the AI gives, up to 20. */
      max?: number;
      /**
       * Check each position with a close-up second look, as `ai_web_click_xy` does. Costs
       * one more AI call per position, and is what small targets need. Defaults to true.
       */
      refine?: boolean;
      /**
       * When a captcha panel is on the page, take the wide look at that panel alone rather
       * than the whole viewport, ruled finely. Nine 70px tiles under a 100px grid cannot be
       * told apart; the same tiles under a 20px one can. Defaults to true, and falls back to
       * the whole page whenever no panel is found or the panel look yields nothing. Turn it
       * off for a step whose targets sit outside the panel.
       */
      zoom?: boolean;
    }
  | {
      /** AI reads a screenshot and decides which field to type into. */
      type: "ai_web_input";
      /** Optional steer, e.g. "the password box". Blank lets the AI judge on its own. */
      hint?: string;
      /** Text to type. Blank lets the AI decide from the page (e.g. a captcha it can read). */
      text?: string;
    };

/** What one `open_url` sub-step did, with the page as it looked afterwards. */
export type WebStepLog = {
  type: WebStep["type"];
  /** What was attempted, e.g. `web_button css: #login`. */
  label: string;
  /** Which round of a `web_for_each` this step belongs to, e.g. `2/5 859148`. */
  iteration?: string;
  /** What happened, e.g. the element pressed or the text typed. */
  outcome?: string;
  error?: string;
  /** data: URI of the page right after the step. */
  screenshot?: string;
  /** Prompt sent to the vision model (`ai_*` steps only). */
  aiPrompt?: string;
  /** What the model replied (`ai_*` steps only). */
  aiResponse?: string;
  /**
   * data: URIs of the pictures the model was actually shown, in the order of the passes in
   * `aiPrompt` -- the ruled and marked-up shots, not the clean one kept as `screenshot`.
   * Without these a prompt cannot be debugged: half of what was asked is the image.
   */
  aiImages?: string[];
};

export type CustomConfig = {
  actions: CustomAction[];
  maxRetries?: number;
  /** Exit for the browser side: a proxy list id, or "random" for a draw from `proxyPool`. */
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type CheckinConfig = {
  successContains?: string;
  failContains?: string;
  /** Exit for the browser side: a proxy list id, or "random" for a draw from `proxyPool`. */
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type AutoregConfig = {
  /** Group to watch for registration codes: @username or t.me invite link */
  groupId: string;
  /** Line prefix identifying a registration code, e.g. ABC-30-Register_ */
  codePrefix: string;
  /**
   * Regular expression identifying a code, for groups whose codes carry no stable prefix.
   * Capture group 1 is the code when present, else the whole match. Takes the place of
   * `codePrefix` when set.
   */
  codeRegex?: string;
  /** Strip Chinese characters and punctuation out of a code before sending it. */
  stripChinese?: boolean;
  /** Characters to strip out of a code before sending, e.g. `~*·`. */
  stripChars?: string;
  /** Have the AI adjust each code before it is sent, going on the surrounding chat. */
  aiModifyCode?: boolean;
  /** What the AI should watch for, when the group's convention needs saying. */
  aiModifyCodeHint?: string;
  /** Group messages around the code shown to the AI as context. Default 6. */
  aiContextCount?: number;
  /** Bot text that means it is ready for a code; waited for after the register button. */
  codeReadyContains?: string;
  /** Bot text that means it is ready for the username; waited for after a code is accepted. */
  usernameReadyContains?: string;
  /** Button on the bot's start reply that opens registration (partial match). Blank clicks the sole button. */
  registerButton?: string;
  /**
   * Some bots vet the code first and only then offer a button (or a t.me link) that actually
   * opens registration. On, that click happens between the code being accepted and the
   * username being sent.
   */
  clickAfterCode?: boolean;
  /** Button or link text to click once a code is accepted (partial match). Blank takes the sole/first one. */
  afterCodeButton?: string;
  /**
   * Whether that button has to be there. On, a code whose reply never offers one is treated
   * as spent and the next code is tried; off, the run carries on to the username -- which is
   * what a bot that only sometimes asks for the extra click needs.
   */
  afterCodeRequired?: boolean;
  /** Username sent to finish signup; supports {word:N} {num:N} {num:1-30} {alpha:N} {uuid} placeholders */
  signupUsername: string;
  /** How long to keep listening for codes before giving up, in minutes. Default 30. */
  listenMinutes?: number;
  /** Recent group messages scanned for codes at startup. Default 0 (live only). */
  scanHistoryCount?: number;
  /** How a code reaches the bot: "button" sends the start command and clicks the register button first; "command" appends the code to the start command (e.g. /start CODE). Default "button". */
  entryMode?: "button" | "command";
  /** Reply text marking a code as accepted; blank treats any non-fail reply as accepted. Multiple keywords separated by | */
  successContains?: string;
  /** Reply text marking a code as used/invalid, e.g. 已被使用|错误. Multiple keywords separated by | */
  failContains?: string;
  /** Exit for the browser side: a proxy list id, or "random" for a draw from `proxyPool`. */
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
};

export type CustomStepLog = {
  step: number;
  actionType: string;
  label: string;
  /** For click_button: the bot message we clicked on, when we had to wait for it */
  preClickHtml?: string;
  preClickImage?: string;
  preClickButtons?: string[][];
  preClickHasMedia?: boolean;
  clickedButton?: string;
  /** For ai_multiple_btn: every button clicked, in order */
  clickedButtons?: string[];
  /** Bot response after the action */
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
  /** For wait_reply: number of messages received during the wait */
  msgCount?: number;
  /** For click_button: 'edit' or 'new_message' — which response path fired */
  responseSource?: "edit" | "new_message";
  /** For click_button: how many retries were needed (0 = first attempt succeeded) */
  retryCount?: number;
  errorName?: string;
  /** Which job-level attempt this step belongs to, 1-based (only set when job maxRetries > 1) */
  jobAttempt?: number;
  /** Which action-level attempt this is, 1-based (only set when action maxRetries > 0) */
  actionAttempt?: number;
  /** Host of the Cloudflare-gated URL opened for this click (full URL is sensitive). */
  cfHost?: string;
  /** A Cloudflare "I am not a bot" challenge was encountered. */
  cfChallenged?: boolean;
  /** The challenge was cleared (or the page loaded with none). */
  cfPassed?: boolean;
  /** The page was opened as a Telegram Mini App (WebView button). */
  cfMiniApp?: boolean;
  /** Telegram returned a signed Mini App URL (the app loads logged in). */
  cfMiniAppSigned?: boolean;
  /** Label of the checkin control pressed inside the Mini App page. */
  cfMiniAppAction?: string;
  /** Proxy whose exit IP the challenge was cleared through. */
  cfProxy?: string;
  /**
   * Which browser build ran this step: "keyed" is the licensed build, "free" the
   * unlicensed fallback used when no licence seat was available. The free build is older
   * and passes fewer challenges, so a run that quietly fell back is worth seeing.
   */
  cfBuild?: "keyed" | "free";
  /**
   * The browser profile the step ran on, i.e. whose cookies it had. Worth seeing whenever a
   * site asks a job to log in again: the usual cause is a profile name resolving to
   * something other than what was meant.
   */
  cfProfile?: string;
  /**
   * The device fingerprint seed the browser ran on. The answer to "why does the site still
   * see the same machine": a kept profile holds this still on purpose, so it only changes
   * between runs where the profile does -- `{noProfile}` draws a new one every time.
   */
  cfDevice?: number;
  /**
   * The locale the browser reported, with a mark when it was pinned in Settings rather than
   * taken from the exit. A page in the wrong language is one of those two: a pinned locale
   * beating the exit's own, or a remembered exit location that has gone out of date.
   */
  cfLocale?: string;
  cfLocalePinned?: boolean;
  /** How many exits were tried before the page loaded. */
  cfAttempts?: number;
  /** Title of the page the browser ended up on. */
  cfPageTitle?: string;
  /** Navigation or renderer trouble seen while loading (crashed tab, failed request). */
  cfNavError?: string;
  /** One line per exit tried: outcome, page title, text length, in-app steps. */
  cfTrace?: string[];
  /** Screenshot of the final page, so a server-only failure can be seen. */
  cfScreenshot?: string;
  /** For open_url: one entry per sub-step run on the page, in order. */
  webSteps?: WebStepLog[];
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  /** Mark the episode as watched after playback completes. Defaults to true. */
  markWatched?: boolean;
  /** ID of a proxy from the settings list, or "random" for a draw from `proxyPool`. */
  proxyId?: string;
  /** Ids a "random" pick draws from. Empty draws from the whole proxy list. */
  proxyPool?: string[];
  /**
   * Verify the media is actually streamable (disk online) before reporting
   * playback, so an offline file is never reported as watched. Defaults to true.
   */
  verifyPlayable?: boolean;
  /**
   * Real Watch: continuously stream the actual media bytes from Emby at real
   * playback pace (direct play), so the server sees genuine streaming traffic
   * like a real client instead of progress reports alone. Defaults to false.
   */
  realWatch?: boolean;
  /**
   * Sequence Play: resume from the user's last position (Emby "Continue
   * Watching"), falling back to Next Up then a random item; when an episode
   * finishes it plays the next one until the play duration is used up.
   * Defaults to false.
   */
  sequencePlay?: boolean;
  /**
   * Restrict watching to one Emby library, by its name or its 1-based index in
   * the user's library list. If it doesn't resolve, the whole server is used.
   */
  library?: string;
  /**
   * Skip TLS certificate verification for this server (self-signed or expired
   * certificates). Only affects this job's requests. Defaults to false.
   */
  ignoreSslErrors?: boolean;
};

/**
 * Why Real Watch pulled no bytes, when the toggle was on. Recorded so a run that
 * streamed nothing explains itself instead of just showing 0 MB.
 */
export type RealWatchNote =
  /** No direct-play, direct-stream or transcode URL the server would serve. */
  | 'no-stream-url'
  /** A stream URL resolved, but every ranged read failed. */
  | 'stream-failed';

// One played item within a run (a single episode/movie segment).
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
  /** True when the bytes came from the transcode fallback, not direct play. */
  realWatchTranscoded?: boolean;
};

export type EmbywatchLog = EmbywatchEpisode & {
  /** True when this run used Sequence Play (resume + next-episode chaining). */
  sequencePlay?: boolean;
  /** Episodes fully finished this run (Sequence Play chaining). */
  episodesCompleted?: number;
  /**
   * Every item played this run, in order. Present for Sequence Play so the log
   * can recall each episode; the top-level fields mirror the last entry.
   */
  episodes?: EmbywatchEpisode[];
};

export type TgProxy = {
  ip: string;
  port: number;
  socksType: 4 | 5;
  username?: string;
  password?: string;
};

