import { Router } from "express";
import { db } from "../db/database";
import { refreshScheduler, purgeOldLogs } from "../scheduler";
import { SocksClient } from "socks";
import { parseTgProxy } from "../jobs/runner";
import { isBulkAccountManagementEnabled } from "../jobs/bulkAdd";
import { isDataManagementEnabled } from "../db/dataStore";
import {
  areCfFontsInstalled,
  cfFontsStatus,
  chromiumVersion,
  installCfChromium,
  installCfFonts,
  isChromiumInstalled,
  testBrowser,
} from "../jobs/cloudflare";
import {
  CF_TUNING_DEFAULTS,
  CF_TUNING_KEY,
  CF_TUNING_LIMITS,
  cfTuning,
  invalidateCfTuning,
  resolveCfTuning,
} from "../jobs/cfTuning";
import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";
import {
  cfBrowsersRunning,
  cfProfileCount,
  checkCfLicenseKey,
  clearCfProfiles,
  chromiumExecutable,
  chromiumPath,
  createCfProfile,
  deleteCfProfiles,
  listCfProfiles,
  renameCfProfile,
  CF_BROWSER_LANG_KEY,
  CF_PROFILE_ID_KEY,
  CF_PROFILE_NAME_RE,
  installedBuildTier,
  installedCfBuilds,
  keyedBuildPending,
  removeAllCfBuilds,
  stopAllCfBrowsers,
} from "../jobs/cfBrowser";
import { restartBemby, restartSupervised } from "../system/restart";
import { exportCfProfiles, importCfProfiles } from "../jobs/cfProfileArchive";
import { installVnc, removeVnc, vncInstallLog, vncStatus } from "../jobs/vncInstall";
import {
  clearCfExitGeo,
  providersForClient,
  saveProviders,
  syncProviders,
  type ProxyProvider,
} from "../tg/proxyProviders";
import {
  DEFAULT_MSAPI_POOL_TYPE,
  isMsApiEnabled,
  maskApiKey,
  msApiConfig,
  msApiConfigured,
  msApiOffReason,
  MSAPI_API_KEY_SETTING,
  MSAPI_BASE_URL_KEY,
  MSAPI_POOL_TYPE_KEY,
  poolStatus,
} from "../jobs/msOauth2api";
import {
  getBotInfo,
  getNotifyConfig,
  maskBotToken,
  NOTIFY_BOT_TARGET_KEY,
  NOTIFY_BOT_TOKEN_KEY,
  recentBotChats,
  sendBotNotify,
} from "../jobs/notify";

const router = Router();

type SettingRow = { key: string; value: string };

export const ALLOWED_KEYS = [
  "default_timezone",
  "default_max_retry",
  "check_daily_run",
  "default_ua",
  "default_play_duration",
  "default_device_name",
  "ai_model",
  "ai_default_model_id",
  "ai_fallback_enabled",
  // Deprecated: target for the account-session sender, kept until that sender is removed
  "notify_tg_username",
  "notify_tg_events",
  NOTIFY_BOT_TOKEN_KEY,
  NOTIFY_BOT_TARGET_KEY,
  "ua_presets",
  "proxies",
  "tg_app_clients",
  "tg_client_mode",
  "default_tg_api_id",
  "default_tg_api_hash",
  "account_display_with_tg_name",
  "schedule_separate_page",
  "jobs_template_edit_button",
  "data_store_enabled",
  "log_retention_days",
  "schedule_min_gap_minutes",
  "cf_solver_enabled",
  CF_PROFILE_ID_KEY,
  CF_BROWSER_LANG_KEY,
  CF_TUNING_KEY,
  MSAPI_BASE_URL_KEY,
  MSAPI_API_KEY_SETTING,
  MSAPI_POOL_TYPE_KEY,
];

/** Settings keys that must never be sent to the client. */
export const CLIENT_HIDDEN_KEYS = new Set([
  "admin_password_hash",
  "admin_username",
  "jwt_secret",
  // Legacy single-key AI credential (superseded by the ai_suppliers table);
  // never echo it back to the client on upgraded installs.
  "ai_api_key",
  // CloakBrowser licence keys: served separately, masked
  CF_KEYS_SETTING,
  // Proxy provider credentials: served separately, with keys replaced by a flag
  "webshare_api_key",
  "proxy_providers",
  // Notification bot token: served masked, under a separate key
  NOTIFY_BOT_TOKEN_KEY,
  // msOauth2api API key: served masked, under a separate key
  MSAPI_API_KEY_SETTING,
]);

/** True when an AI key exists anywhere the runtime looks: a supplier, the legacy setting or the env. */
function aiKeyConfigured(): boolean {
  const suppliers = db
    .prepare("SELECT COUNT(*) AS n FROM ai_suppliers WHERE api_key != ''")
    .get() as { n: number };
  if (suppliers.n > 0) return true;
  const legacy = db
    .prepare("SELECT value FROM settings WHERE key = 'ai_api_key'")
    .get() as { value: string } | undefined;
  return Boolean(legacy?.value || process.env.AI_API_KEY);
}

/** Returns first 4 chars + **** + last 4 chars, or **** for short values. */
function maskApiHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 8) return "****";
  return `${hash.slice(0, 4)}****${hash.slice(-4)}`;
}

// A proxy is stored as a URL with its credentials inside it, so sending the list to the
// client sent the passwords with it -- while the seller's API key beside it was already held
// back. The password is replaced by this sentinel on the way out and restored on the way
// back in, the same round trip the API hash above already makes.
export const PROXY_PASSWORD_MASK = "********";

type ProxyEntry = { id?: string; url?: string; [key: string]: unknown };

function parseProxyList(raw: string | undefined): ProxyEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as ProxyEntry[]) : [];
  } catch {
    return [];
  }
}

/** Rewrites a proxy URL's password, leaving everything else about it intact. */
function withProxyPassword(url: string, password: string | null): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    if (password === null) return url;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return url;
  }
}

function proxyPassword(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

/** The proxies setting with every password replaced by the sentinel. */
export function maskProxies(raw: string | undefined): string {
  const list = parseProxyList(raw);
  if (!list.length) return raw ?? "[]";
  return JSON.stringify(
    list.map((p) =>
      typeof p.url === "string" && proxyPassword(p.url)
        ? { ...p, url: withProxyPassword(p.url, PROXY_PASSWORD_MASK) }
        : p,
    ),
  );
}

/**
 * Puts the real passwords back where the client sent the sentinel unchanged. An entry whose
 * id is not already stored has nothing to restore from, so its value is taken at face value.
 */
export function unmaskProxies(incoming: string, storedRaw: string | undefined): string {
  const list = parseProxyList(incoming);
  if (!list.length) return incoming;
  const stored = new Map(
    parseProxyList(storedRaw)
      .filter((p) => typeof p.id === "string" && typeof p.url === "string")
      .map((p) => [p.id as string, p.url as string]),
  );
  return JSON.stringify(
    list.map((p) => {
      if (typeof p.url !== "string" || proxyPassword(p.url) !== PROXY_PASSWORD_MASK) return p;
      const previous = typeof p.id === "string" ? stored.get(p.id) : undefined;
      const password = previous ? proxyPassword(previous) : "";
      return { ...p, url: withProxyPassword(p.url, password) };
    }),
  );
}

/** Returns client-safe settings: migration flags and secret keys removed, API hash masked. */
function getClientSettings(): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'migration:%'")
    .all() as SettingRow[];
  const result = Object.fromEntries(
    rows.filter((r) => !CLIENT_HIDDEN_KEYS.has(r.key)).map((r) => [r.key, r.value]),
  );
  // Never expose the raw hash to the client
  if (result.default_tg_api_hash) {
    result.default_tg_api_hash = maskApiHash(result.default_tg_api_hash);
  }
  // Nor the passwords sitting inside the proxy URLs
  if (result.proxies) {
    result.proxies = maskProxies(result.proxies);
  }
  // Synthetic flag so the client can gate AI features without seeing the key
  result.ai_key_configured = aiKeyConfigured() ? "true" : "false";
  // Env-gated feature flag for bulk account management (add + clean)
  result.bulk_account_management = isBulkAccountManagementEnabled()
    ? "true"
    : "false";
  // Same for the data store: off hides its menu entry, its Settings toggle and its job steps
  result.data_management = isDataManagementEnabled() ? "true" : "false";
  // Whether the on-demand Cloudflare-solver browser is present, and which build
  result.cf_chromium_installed = isChromiumInstalled() ? "true" : "false";
  // x11vnc, which the hand-driven browser needs to show its screen. Installed on demand
  // into the data dir, so an image without it is a button press away rather than a rebuild.
  {
    const vnc = vncStatus();
    result.vnc_installed = vnc.available ? "true" : "false";
    result.vnc_source = vnc.source;
    result.vnc_version = vnc.version ?? "";
    result.vnc_bytes = vnc.bytes ? String(vnc.bytes) : "";
  }
  result.cf_chromium_version = chromiumVersion() ?? "";
  // Which build is on disk, and whether a configured key unlocks one that is not yet
  // downloaded -- downloads are deliberate, so this is what surfaces the outstanding one
  result.cf_chromium_tier = installedBuildTier() ?? "";
  result.cf_chromium_path = chromiumPath() ?? "";
  result.cf_chromium_keyed_pending = keyedBuildPending() ? "true" : "false";
  // Whether the unlicensed build is also on disk. It is what a launch falls back to when
  // no licence seat is free -- without it, such a launch has nothing that can run.
  result.cf_chromium_free_installed = chromiumExecutable("free") ? "true" : "false";
  // Every build on disk, so the panel can list the keyed and free ones side by side
  result.cf_chromium_builds = JSON.stringify(installedCfBuilds());
  // Browser profiles on disk: state carried between runs, and the thing to clear when a
  // browser starts failing for no reason that changed elsewhere
  result.cf_profile_count = String(cfProfileCount());
  // How many solver browsers are open right now, so the panel can offer to stop them
  result.cf_browsers_running = String(cfBrowsersRunning());
  // Whether a restart from the panel would bring the backend back, or leave it down until
  // someone starts it again. The button says which, rather than looking the same either way.
  result.restart_supervised = restartSupervised() ? "true" : "false";
  // The CJK/emoji faces are not in the image either; they sit beside the browser in the
  // data dir. Reported separately so a browser that can only draw Latin is visible.
  result.cf_fonts_installed = areCfFontsInstalled() ? "true" : "false";
  result.cf_fonts_missing = cfFontsStatus().missing.join(", ");
  // Licence keys, masked, plus how many seats are taken right now: a free key is one
  // concurrent session, so the count is what tells the operator whether to add another
  result.cf_cloak_keys_masked = JSON.stringify(cfLicenseKeysForClient());
  result.cf_cloak_keys_in_use = String(cfLicenseUsage().inUse);
  // The browser timings in force, alongside the shipped defaults and the range each is
  // held to, so the client can render every field without a second source of truth
  result.cf_tuning = JSON.stringify(cfTuning());
  result.cf_tuning_defaults = JSON.stringify(CF_TUNING_DEFAULTS);
  result.cf_tuning_limits = JSON.stringify(CF_TUNING_LIMITS);
  // Synthetic count so the client can show whether proxy importing is set up
  result.proxy_providers_count = String(providersForClient().length);
  // The notification bot's token, masked. Its presence is what decides whether job
  // notifications go out as the bot or fall back to the job's own account session.
  const botToken = getNotifyConfig().botToken;
  result.notify_bot_configured = botToken ? "true" : "false";
  result.notify_bot_token_masked = botToken ? maskBotToken(botToken) : "";
  // msOauth2api. Off at the deployment, nothing about it is served at all -- not the section,
  // not the stored values, not even a mask -- so a panel that has no install to point at never
  // mentions it. On, the masked key and whether both halves are set: an address pool with a
  // URL but no key reaches nothing, so that source is offered only once it is configured.
  result.msapi_available = isMsApiEnabled() ? "true" : "false";
  if (isMsApiEnabled()) {
    result.msapi_configured = msApiConfigured() ? "true" : "false";
    result.msapi_api_key_masked = maskApiKey(msApiConfig().apiKey);
    result.msapi_pool_type_default = DEFAULT_MSAPI_POOL_TYPE;
  } else {
    for (const key of [MSAPI_BASE_URL_KEY, MSAPI_POOL_TYPE_KEY]) delete result[key];
  }
  return result;
}

router.get("/", (_req, res) => {
  res.json(getClientSettings());
});

router.put("/", (req, res) => {
  const updates = req.body as Record<string, string>;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );

  db.transaction(() => {
    for (const key of ALLOWED_KEYS) {
      if (!(key in updates)) continue;
      // The data store's toggle is not there to be flipped on a panel whose deployment does
      // not offer the feature: the toggle is hidden, so this is for a stale page or a script
      if (key === "data_store_enabled" && !isDataManagementEnabled()) continue;
      // Same for the msOauth2api keys: the section is hidden, so this is a stale page or a
      // script writing settings the deployment does not offer
      if (
        (key === MSAPI_BASE_URL_KEY ||
          key === MSAPI_API_KEY_SETTING ||
          key === MSAPI_POOL_TYPE_KEY) &&
        !isMsApiEnabled()
      )
        continue;
      // Skip if the client sent back a masked credential unchanged
      if (
        (key === "default_tg_api_hash" ||
          key === NOTIFY_BOT_TOKEN_KEY ||
          key === MSAPI_API_KEY_SETTING) &&
        String(updates[key]).includes("****")
      )
        continue;
      // Put back any proxy password the client echoed as the mask rather than retyping
      if (key === "proxies") {
        const current = (
          db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as
            | { value: string }
            | undefined
        )?.value;
        stmt.run(key, unmaskProxies(String(updates[key]), current));
        continue;
      }
      // Browser timings are stored resolved: out-of-range or unparsable values become the
      // shipped default there and then, so what is saved is what a job will use
      if (key === CF_TUNING_KEY) {
        let incoming: unknown = updates[key];
        if (typeof incoming === "string") {
          try {
            incoming = JSON.parse(incoming);
          } catch {
            incoming = undefined;
          }
        }
        stmt.run(key, JSON.stringify(resolveCfTuning(incoming)));
        continue;
      }
      stmt.run(key, String(updates[key]));
    }
  })();

  // Reschedule if daily-run check toggled or the default timezone changed
  // (jobs with no timezone of their own follow the default)
  if ("check_daily_run" in updates || "default_timezone" in updates)
    refreshScheduler();

  // Apply a tightened retention window straight away
  if ("log_retention_days" in updates) purgeOldLogs();

  // Drop the cached timings so the next job picks the new ones up without a restart
  if (CF_TUNING_KEY in updates) invalidateCfTuning();

  res.json(getClientSettings());
});

// POST /cf-solver/install -- download the CloakBrowser stealth Chromium (~200MB) and the
// CJK/emoji faces (~30MB) on demand into the data dir so the Cloudflare "I am not a bot"
// solver can run. Neither is in the image, and the data dir is a volume, so both survive an
// upgrade. `force` downloads again over an existing install, which is how they get updated.
//
// The fonts are reported but do not decide `ok`: with the image's Latin fallback the
// browser still works, so a blocked font download is a warning, not a failed install.
// POST /vnc/install -- fetch x11vnc into the data dir. The app runs as `node`, so apt is
// pointed at directories it owns and asked only what it would download; the .deb files are
// then unpacked into the volume, which is what carries the install across an upgrade.
router.post("/vnc/install", async (_req, res) => {
  try {
    const status = await installVnc();
    res.json({ ok: true, status, log: vncInstallLog().log.slice(-40) });
  } catch (e: any) {
    res.status(400).json({
      ok: false,
      error: e?.message ?? String(e),
      log: vncInstallLog().log.slice(-40),
    });
  }
});

/** Progress for a install still running, so the button can show what it is doing. */
router.get("/vnc/install", (_req, res) => {
  res.json({ ...vncInstallLog(), status: vncStatus() });
});

router.post("/vnc/remove", (_req, res) => {
  removeVnc();
  res.json({ ok: true, status: vncStatus() });
});

let cfInstalling = false;
router.post("/cf-solver/install", async (req, res) => {
  const force = req.body?.force === true || req.query.force === "1";
  // "free" asks for the unlicensed build specifically, which is what a launch falls back
  // to when no licence seat is free. It is a separate download, so an install that already
  // has the keyed build still has work to do.
  const tier = req.body?.tier === "free" ? ("free" as const) : undefined;
  if (tier === "free") {
    if (cfInstalling) {
      res.status(409).json({ ok: false, message: "Install already in progress" });
      return;
    }
    cfInstalling = true;
    try {
      const browser = await installCfChromium(force, "free");
      res.json({
        ok: browser.ok,
        installed: browser.ok,
        fontsInstalled: areCfFontsInstalled(),
        version: browser.ok ? chromiumVersion() : undefined,
        output: browser.output.slice(-1500),
      });
    } finally {
      cfInstalling = false;
    }
    return;
  }
  // A licence key with no build behind it counts as outstanding: the key is only worth
  // anything once the build it unlocks is on disk.
  if (isChromiumInstalled() && areCfFontsInstalled() && !keyedBuildPending() && !force) {
    res.json({
      ok: true,
      installed: true,
      fontsInstalled: true,
      version: chromiumVersion(),
      message: "Already installed",
    });
    return;
  }
  if (cfInstalling) {
    res.status(409).json({ ok: false, message: "Install already in progress" });
    return;
  }
  cfInstalling = true;
  try {
    // Only re-download a browser that is missing (or explicitly forced): an upgrade from an
    // image that carried the fonts needs the fonts alone, not another 200MB of browser.
    const browser = isChromiumInstalled() && !keyedBuildPending() && !force
      ? { ok: true, output: "Browser already installed" }
      : await installCfChromium(force);
    const fonts = await installCfFonts(force);
    if (browser.ok) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_solver_enabled', 'true')").run();
    }
    res.json({
      ok: browser.ok,
      installed: browser.ok,
      fontsInstalled: fonts.ok,
      version: browser.ok ? chromiumVersion() : undefined,
      output: `${browser.output}\n\n--- fonts ---\n${fonts.output}`.slice(-1500),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message ?? "Install failed" });
  } finally {
    cfInstalling = false;
  }
});

// ── CloakBrowser licence keys ─────────────────────────────────────────────────
// A free key (one per GitHub sign-in at cloakbrowser.dev/free) gets the current stealth
// build instead of the ageing one that needs no key, and allows one concurrent browser.
// Several can be stored so concurrent jobs each get a seat. Never sent back in full.

router.get("/cf-solver/keys", (_req, res) => {
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

router.put("/cf-solver/keys", (req, res) => {
  const { keys } = req.body as { keys?: Array<{ label?: string; key?: string }> };
  if (!Array.isArray(keys)) {
    res.status(400).json({ error: "keys array is required" });
    return;
  }
  saveCfLicenseKeys(keys);
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

// POST /cf-solver/keys/check -- ask CloakBrowser's server what each stored key is worth,
// so a key that was mistyped or has lapsed shows up here rather than as a job that quietly
// runs the old build.
router.post("/cf-solver/keys/check", async (_req, res) => {
  const results = [];
  for (const entry of cfLicenseKeys()) {
    results.push({ label: entry.label, masked: maskKey(entry.key), ...(await checkCfLicenseKey(entry.key)) });
  }
  res.json({ results });
});

// POST /cf-solver/test -- launch the installed browser and check that it renders, so a
// Mini App step that comes up blank on a server can be told apart from a site problem.
// `?screenshot=1` includes what the browser drew.
// POST /cf-solver/stop -- close every solver browser that is open. The jobs holding them
// fail as their pages go; that is the point, since this is the way out when a run has
// wedged and is sitting on a licence seat, a profile or a proxy nothing else can have.
router.post("/cf-solver/stop", async (_req, res) => {
  const result = await stopAllCfBrowsers();
  res.json({ ok: true, stopped: result.stopped });
});

// POST /system/restart -- close every browser, kill any left behind by an earlier backend,
// and exit so the supervisor starts a fresh process. The heavier version of the button
// above: it also clears what only a new process can (leased licence seats, the scheduler,
// anything a wedged run is sitting on). Runs in flight are interrupted and reconciled on
// the next boot.
// `{ force: true }` skips asking the browsers to close and kills them outright, for when
// that request is itself what hangs.
router.post("/system/restart", async (req, res) => {
  const force = (req.body as { force?: boolean } | undefined)?.force === true;
  const result = await restartBemby({ force });
  res.json({ ok: true, ...result });
});

// POST /cf-solver/clear-profiles -- delete the per-exit browser profiles (cookies, cache,
// site data). Nothing identifying goes with them: the fingerprint is derived from the exit,
// not stored here. Refused while a browser still has one open.
router.post("/cf-solver/clear-profiles", (_req, res) => {
  const result = clearCfProfiles();
  if (result.error) {
    res.status(409).json({ ok: false, removed: result.removed, message: result.error });
    return;
  }
  res.json({ ok: true, removed: result.removed });
});

// POST /cf-solver/clear-exit-geo -- forget where every exit comes out, so the next launch of
// each looks it up again. What this is for: the host has moved country (a new box, or a VPN
// brought up on it) and the browser is meanwhile still presenting the old country's clock and
// language, since a remembered location otherwise stands for a fortnight.
router.post("/cf-solver/clear-exit-geo", (_req, res) => {
  res.json({ ok: true, cleared: clearCfExitGeo() });
});

// ── Browser profiles, one at a time ──────────────────────────────────────────
// The counterpart of clear-profiles above: a profile that was signed in by hand, or brought
// over from another instance, is worth keeping and moving rather than clearing wholesale.

// GET /cf-solver/profiles -- every profile on disk with its size, last use and whether a
// browser has it open.
router.get("/cf-solver/profiles", (_req, res) => {
  res.json({ profiles: listCfProfiles() });
});

// POST /cf-solver/profiles -- reserve a name a job's profile field can target. The browser
// fills the directory in on first launch.
router.post("/cf-solver/profiles", (req, res) => {
  const { name } = req.body as { name?: string };
  const result = createCfProfile(String(name ?? ""));
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.status(201).json({ ok: true, profiles: listCfProfiles() });
});

// POST /cf-solver/profiles/rename -- move a profile to another name, session and device
// intact. How a jar built up under a pooled name is put somewhere a job can target by name.
router.post("/cf-solver/profiles/rename", (req, res) => {
  const { from, to } = req.body as { from?: string; to?: string };
  const result = renameCfProfile(String(from ?? ""), String(to ?? ""));
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, profiles: listCfProfiles() });
});

// POST /cf-solver/profiles/delete -- remove the named profiles. A body rather than DELETE
// /:name so the settings page can clear a selection in one call.
router.post("/cf-solver/profiles/delete", (req, res) => {
  const { names } = req.body as { names?: unknown };
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  if (!list.length) {
    res.status(400).json({ ok: false, error: "names is required" });
    return;
  }
  const result = deleteCfProfiles(list);
  res.json({ ok: !result.refused.length, ...result, profiles: listCfProfiles() });
});

// POST /cf-solver/profiles/export -- stream the selected profiles as one .tar.gz. Caches are
// left out; see cfProfileArchive. POST rather than GET because the selection is a list.
router.post("/cf-solver/profiles/export", async (req, res) => {
  const { names } = req.body as { names?: unknown };
  const list = Array.isArray(names)
    ? names.filter((n): n is string => typeof n === "string" && CF_PROFILE_NAME_RE.test(n))
    : [];
  if (!list.length) {
    res.status(400).json({ error: "names is required" });
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const file =
    list.length === 1 ? `bemby-profile-${list[0]}-${stamp}.tar.gz` : `bemby-profiles-${stamp}.tar.gz`;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);

  const result = await exportCfProfiles(list, res);
  if (!result.ok && !res.headersSent) {
    res.status(500).json({ error: result.error });
    return;
  }
  // Headers (and probably bytes) are already out by the time tar fails, so the truncated
  // archive is all the caller gets -- ending the response is the only signal left.
  res.end();
});

// POST /cf-solver/profiles/import -- read a .tar.gz off the request body and put its profiles
// back on disk. The body is streamed straight into tar rather than buffered: a profile archive
// is measured in megabytes and there is no reason to hold one in memory.
router.post("/cf-solver/profiles/import", async (req, res) => {
  const replace = req.query.replace === "1" || req.query.replace === "true";
  // A cache-free profile archive is measured in megabytes, so anything of this order is a
  // mistake rather than a profile, and extracting it would fill the data volume. Browsers send
  // Content-Length for a file body; a chunked upload without one is let through and bounded by
  // the disk instead.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > 200 * 1024 * 1024) {
    res.status(413).json({ ok: false, error: "Archive is too large (limit 200MB)" });
    return;
  }
  try {
    const result = await importCfProfiles(req, { replace });
    if (result.error) {
      res.status(400).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result, profiles: listCfProfiles() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "Import failed" });
  }
});

// POST /cf-solver/uninstall -- delete every downloaded browser build, reclaiming the
// ~200MB each takes in the data dir. Refused while a job still has one open, since the
// binary would be pulled out from under it.
router.post("/cf-solver/uninstall", (_req, res) => {
  if (cfInstalling) {
    res.status(409).json({ ok: false, message: "Install already in progress" });
    return;
  }
  const result = removeAllCfBuilds();
  if (result.error) {
    res.status(409).json({ ok: false, removed: result.removed, message: result.error });
    return;
  }
  // The solver has nothing to launch now, so it stops claiming to be on
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_solver_enabled', 'false')").run();
  res.json({ ok: true, removed: result.removed });
});

// Launching a browser, loading a real page over the network and probing it takes tens of
// seconds, and doing that for every installed build takes a multiple of it -- long enough
// that a reverse proxy in front of the panel gives up on the request and answers 504. So
// the run happens in the background and the caller polls for it, the way the bulk account
// operations already work.
type CfTestState = {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  error?: string;
  /** Filled in as each build finishes, so progress is visible rather than all-or-nothing. */
  builds: Array<Awaited<ReturnType<typeof testBrowser>>>;
};
let cfTestState: CfTestState | undefined;

router.post("/cf-solver/test", (req, res) => {
  if (cfTestState?.running) {
    res.status(409).json({ ...cfTestState, message: "A browser test is already running" });
    return;
  }

  // Every build that is installed, in turn. With both on disk a job may run on either --
  // the keyed one normally, the free one when no licence seat is going -- so testing only
  // the preferred build leaves the fallback unproven, which is exactly the one that gets
  // used on a bad day.
  const tiers = (["keyed", "free"] as const).filter((t) => !!chromiumExecutable(t));
  const wantShot = !!req.query.screenshot;

  if (!tiers.length) {
    cfTestState = {
      running: false,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      ok: false,
      error: "Chromium is not installed",
      builds: [],
    };
    res.json(cfTestState);
    return;
  }

  const state: CfTestState = { running: true, startedAt: Date.now(), builds: [] };
  cfTestState = state;

  void (async () => {
    try {
      for (const tier of tiers) {
        const result = await testBrowser(undefined, tier).catch((err: any) => ({
          ok: false,
          tier,
          error: err?.message ?? String(err),
        }));
        state.builds.push(wantShot ? result : { ...result, screenshot: undefined });
      }
      state.ok = state.builds.every((b) => b.ok);
    } catch (err: any) {
      state.ok = false;
      state.error = err?.message ?? String(err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  res.status(202).json(state);
});

// GET /cf-solver/test -- how the run started above is going, and its results once it is
// done. Returns a finished-with-nothing state when no test has been run since boot.
router.get("/cf-solver/test", (_req, res) => {
  res.json(cfTestState ?? { running: false, startedAt: 0, builds: [] });
});

// ── Notification bot ──────────────────────────────────────────────────────────
// Job notifications are sent by a Telegram bot, so they no longer depend on a job having
// an authenticated account. A bot cannot start a conversation, and cannot resolve a user
// by @username, so the target has to be a numeric chat id the operator obtains by messaging
// the bot first -- which is what the two endpoints below are for.

/** The token to work with: the one supplied in the request, else the one stored. */
function resolveBotToken(body: unknown): string | null {
  const supplied = (body as { token?: string } | undefined)?.token?.trim();
  if (supplied && !supplied.includes("****")) return supplied;
  return getNotifyConfig().botToken;
}

// GET /notify/bot -- who the stored token belongs to, so a mistyped or revoked token shows
// up here rather than as notifications that quietly never arrive.
router.get("/notify/bot", async (_req, res) => {
  const token = getNotifyConfig().botToken;
  if (!token) {
    res.json({ configured: false });
    return;
  }
  const info = await getBotInfo(token);
  if (!info.ok) {
    res.json({ configured: true, ok: false, error: info.error });
    return;
  }
  res.json({
    configured: true,
    ok: true,
    id: info.result.id,
    username: info.result.username ?? "",
    name: info.result.first_name ?? "",
  });
});

// GET /notify/bot/chats -- chat ids the bot has heard from lately, for filling in the
// default target. Telegram only keeps recent updates, so an empty list usually means
// "message the bot and try again".
router.get("/notify/bot/chats", async (req, res) => {
  const token = resolveBotToken(req.query);
  if (!token) {
    res.status(400).json({ ok: false, error: "No bot token configured" });
    return;
  }
  const chats = await recentBotChats(token);
  if (!chats.ok) {
    res.status(502).json({ ok: false, error: chats.error });
    return;
  }
  res.json({ ok: true, chats: chats.result });
});

// POST /notify/bot/test -- send a real message now. The only check that proves the whole
// path: token valid, host can reach the Bot API, and the target has started the bot.
router.post("/notify/bot/test", async (req, res) => {
  const token = resolveBotToken(req.body);
  const cfg = getNotifyConfig();
  const target = (req.body?.target as string | undefined)?.trim() || cfg.botTarget;
  if (!token) {
    res.status(400).json({ ok: false, error: "No bot token configured" });
    return;
  }
  if (!target) {
    res.status(400).json({ ok: false, error: "No notification target configured" });
    return;
  }
  try {
    await sendBotNotify(token, target, "🔔 Bemby test notification");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Send failed" });
  }
});

// POST /msapi/test -- ask the address pool for its counts. Proves the URL is reachable, the
// key is accepted and the type exists, which is everything a login-email run needs.
router.post("/msapi/test", async (req, res) => {
  if (!isMsApiEnabled()) {
    res.status(403).json({ ok: false, error: msApiOffReason() });
    return;
  }
  if (!msApiConfigured()) {
    res.status(400).json({ ok: false, error: "Set the base URL and API key first" });
    return;
  }
  try {
    const stats = await poolStatus((req.body?.type as string | undefined) ?? "");
    res.json({ ok: true, ...stats });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Request failed" });
  }
});

// ── Proxy providers ───────────────────────────────────────────────────────────
// Configured proxy sellers whose current list can be pulled into the proxies setting.
// API keys are never sent back to the client; a `hasKey` flag stands in for them.

router.get("/proxy-providers", (_req, res) => {
  res.json({ providers: providersForClient() });
});

router.put("/proxy-providers", (req, res) => {
  const { providers } = req.body as { providers?: ProxyProvider[] };
  if (!Array.isArray(providers)) {
    res.status(400).json({ error: "providers array is required" });
    return;
  }

  const seen = new Set<string>();
  for (const p of providers) {
    if (!p?.id?.trim() || !p?.name?.trim()) {
      res.status(400).json({ error: "Each provider needs an id and a name" });
      return;
    }
    if (p.type !== "webshare" && p.type !== "list") {
      res.status(400).json({ error: `Unsupported provider type "${p.type}"` });
      return;
    }
    if (p.type === "list" && !p.url?.trim()) {
      res.status(400).json({ error: `"${p.name}" needs a list URL` });
      return;
    }
    if (seen.has(p.id)) {
      res.status(400).json({ error: "Provider ids must be unique" });
      return;
    }
    seen.add(p.id);
  }

  saveProviders(providers);
  res.json({ providers: providersForClient() });
});

// Pull the current lists in. `providerId` syncs a single provider; otherwise every
// enabled one is synced. Manual proxies, and imports from providers that were not
// synced, are preserved.
router.post("/proxy-providers/sync", async (req, res) => {
  const { providerId } = req.body as { providerId?: string };
  try {
    const result = await syncProviders(providerId?.trim() || undefined);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Sync failed" });
  }
});

// Test TCP reachability through a SOCKS proxy (target: 1.1.1.1:80)
router.post("/test-proxy", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const proxy = parseTgProxy(url);
  if (!proxy) {
    res
      .status(400)
      .json({ error: "Invalid proxy URL — use socks5:// or socks4://" });
    return;
  }

  try {
    const result = await SocksClient.createConnection({
      proxy: {
        host: proxy.ip,
        port: proxy.port,
        type: proxy.socksType,
        ...(proxy.username
          ? { userId: proxy.username, password: proxy.password }
          : {}),
      },
      command: "connect",
      destination: { host: "1.1.1.1", port: 80 },
      timeout: 6000,
    });
    result.socket.destroy();
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err.message ?? "Connection failed" });
  }
});

export default router;
