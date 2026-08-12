import type {
  Job,
  TgAccount,
  EmbywatchConfig,
  EmbywatchLog,
  TgProxy,
  CheckinConfig,
  AutoregConfig,
} from "../types";
import { runCheckin, CheckinError, type CheckinAttemptLog } from "./checkin";
import { runEmbywatch } from "./embywatch";
import { newCfRunState } from "./cloudflare";
import { nameRun, releaseRunDisplay } from "./runDisplays";
import { stopCfBrowsersForRun } from "./cfBrowser";
import { runCustom, CustomJobError, type CustomJobLog } from "./custom";
import { runAutoreg, AutoregJobError, type AutoregJobLog } from "./autoreg";
import { db } from "../db/database";
import { resolveAppClientParams } from "../tg/appClient";
import { proxyUrlFor, type ProxyChoice } from "../tg/proxyProviders";

/**
 * The proxy a job or its template picked, if any. The job's own config wins, so a
 * template-linked job can pick its own exit; with none set it follows the template. A
 * `random` pick carries the pool it draws from, so the draw happens against the same list
 * wherever it is made.
 */
export function configProxyChoice(
  jobConfig: string | null,
  templateId: number | null | undefined,
): ProxyChoice {
  const readChoice = (raw: string | null | undefined): ProxyChoice => {
    if (!raw) return {};
    try {
      let c = JSON.parse(raw);
      if (typeof c === "string") c = JSON.parse(c);
      if (!c?.proxyId) return {};
      return {
        proxyId: c.proxyId as string,
        pool: Array.isArray(c.proxyPool) ? (c.proxyPool as string[]) : undefined,
      };
    } catch {
      return {};
    }
  };

  const fromJob = readChoice(jobConfig);
  if (fromJob.proxyId || !templateId) return fromJob;
  const row = db
    .prepare("SELECT config FROM job_templates WHERE id = ?")
    .get(templateId) as { config: string | null } | undefined;
  return readChoice(row?.config);
}

/**
 * Exit for this account's Telegram connection: the account's own proxy, and nothing
 * else. Every other place a session is used (login, status checks, the messenger) goes
 * through the account proxy too, so anything else here would put one auth key behind two
 * IPs -- which Telegram answers with AUTH_KEY_DUPLICATED and an invalidated session. A
 * job/template proxy is for the browser side instead (see resolveWebProxyUrl).
 */
function resolveTgProxyUrl(
  accountProxyId: string | null | undefined,
  job: Job,
): string | undefined {
  const configured = configProxyChoice(job.config, job.templateId).proxyId;
  if (configured && configured !== accountProxyId) {
    console.warn(
      `[runner] Job "${job.name}": proxy "${configured}" is set on the job/template but the ` +
        `Telegram connection follows the account's proxy (${accountProxyId ?? "none"}); the job ` +
        `proxy is used for the browser only. Set it on the account (and re-authenticate) to ` +
        `route Telegram through it.`,
    );
  }
  return proxyUrlFor(accountProxyId);
}

/**
 * Exit for the browser side (Cloudflare challenges, Mini Apps): the job's or template's
 * proxy when one is set, otherwise the account's. Cloudflare judges the exit IP, so this
 * one is meant to be chosen per job, and the browser holds no Telegram session.
 *
 * A `random` pick is drawn here, so each run goes out through a different exit of the pool.
 */
export function resolveWebProxyUrl(
  accountProxyId: string | null | undefined,
  job: Job,
): string | undefined {
  const choice = configProxyChoice(job.config, job.templateId);
  return choice.proxyId
    ? proxyUrlFor(choice.proxyId, choice.pool)
    : proxyUrlFor(accountProxyId);
}

export function parseTgProxy(
  proxyUrl: string | undefined,
): TgProxy | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const proto = u.protocol.replace(":", "");
    if (proto !== "socks5" && proto !== "socks4" && proto !== "socks")
      return undefined;
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      socksType: proto === "socks4" ? 4 : 5,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return undefined;
  }
}

export type JobDetailLog =
  | CheckinAttemptLog
  | EmbywatchLog
  | CustomJobLog
  | AutoregJobLog;

const RETRY_DELAY_MS = 5_000;

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Job cancelled"));
      },
      { once: true },
    );
  });
}

export async function runJob(
  job: Job,
  account: TgAccount | null,
  detailLogs?: JobDetailLog[],
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  // Browser exits refused during this run, shared by every attempt below: retrying a
  // proxy Cloudflare has already turned down only replays the refusal
  // What the browser profile names like `{ip}-{jobId}` and `{tgId}` are filled in from
  const cfRun = newCfRunState({
    jobId: job.id,
    templateId: job.templateId ?? undefined,
    tgId: account?.id,
  });
  // So a viewer's list of what is running says which job each screen belongs to
  nameRun(cfRun.runId, job.id, job.name);

  // Cancelling sets the signal, but a browser step can be sitting in a driver call that
  // takes no notice of one. Closing this run's browsers makes those calls reject at once,
  // which is what turns "stopping" into stopped instead of a wait on the whole budget.
  const stopBrowsers = () => {
    void stopCfBrowsersForRun(cfRun.runId).catch(() => {});
  };
  signal?.addEventListener("abort", stopBrowsers, { once: true });

  try {

  for (let attempt = 1; attempt <= job.retryMax; attempt++) {
    if (signal?.aborted) throw new Error("Job cancelled");
    try {
      switch (job.jobType) {
        case "checkin": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          // Telegram follows the account's exit; the browser may use the job's
          const checkinProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const checkinProxyUrl = resolveWebProxyUrl(account.proxyId, job);
          const checkinDevice = resolveAppClientParams(account.id, account.appClientId);
          let checkinCfg: CheckinConfig = {};
          try {
            // For template-linked jobs, use template config as base then overlay job config
            if (job.templateId) {
              const tplRow = db
                .prepare("SELECT config FROM job_templates WHERE id = ?")
                .get(job.templateId) as { config: string | null } | undefined;
              if (tplRow?.config) {
                let t = JSON.parse(tplRow.config);
                if (typeof t === "string") t = JSON.parse(t);
                checkinCfg = { ...checkinCfg, ...t };
              }
            }
            if (job.config) {
              let c = JSON.parse(job.config);
              if (typeof c === "string") c = JSON.parse(c);
              checkinCfg = { ...checkinCfg, ...c };
            }
          } catch {
            /* ignore */
          }
          const log = await runCheckin(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            job.replyTimeoutMs,
            job.startCommand,
            job.checkinButton,
            attempt,
            job.retryMax,
            signal,
            checkinProxy,
            checkinDevice,
            checkinCfg.successContains,
            checkinCfg.failContains,
            checkinProxyUrl,
          );
          detailLogs?.push(log);
          break;
        }
        case "embywatch": {
          let jobCfg: Partial<EmbywatchConfig> = JSON.parse(job.config ?? "{}");
          if (typeof jobCfg === "string")
            jobCfg = JSON.parse(jobCfg as unknown as string);
          let config: EmbywatchConfig = jobCfg as EmbywatchConfig;
          // Template-linked jobs: merge template config (settings) with job config (credentials)
          if (job.templateId) {
            const tplRow = db
              .prepare("SELECT config FROM job_templates WHERE id = ?")
              .get(job.templateId) as { config: string | null } | undefined;
            if (tplRow?.config) {
              let tplCfg = JSON.parse(tplRow.config);
              if (typeof tplCfg === "string") tplCfg = JSON.parse(tplCfg);
              config = { ...tplCfg, ...jobCfg } as EmbywatchConfig;
            }
          }
          if (!config.username || !config.password)
            throw new Error("Emby username and password are required");
          const log = await runEmbywatch(job.botUsername, config, signal);
          detailLogs?.push(log);
          break;
        }
        case "custom": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          const rawCfg = JSON.parse(job.config ?? '{"actions":[]}');
          // Telegram follows the account's exit; the browser may use the job's
          const customProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const customProxyUrl = resolveWebProxyUrl(account.proxyId, job);
          const customDevice = resolveAppClientParams(account.id, account.appClientId);
          const customLog = await runCustom(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            rawCfg,
            signal,
            customProxy,
            customDevice,
            customProxyUrl,
            cfRun,
            configProxyChoice(job.config, job.templateId),
          );
          detailLogs?.push(customLog);
          break;
        }
        case "autoreg": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          let autoregCfg: Record<string, unknown> = {};
          try {
            // Template-linked jobs: template config as base, job config overlaid
            if (job.templateId) {
              const tplRow = db
                .prepare("SELECT config FROM job_templates WHERE id = ?")
                .get(job.templateId) as { config: string | null } | undefined;
              if (tplRow?.config) {
                let t = JSON.parse(tplRow.config);
                if (typeof t === "string") t = JSON.parse(t);
                autoregCfg = { ...autoregCfg, ...t };
              }
            }
            if (job.config) {
              let c = JSON.parse(job.config);
              if (typeof c === "string") c = JSON.parse(c);
              autoregCfg = { ...autoregCfg, ...c };
            }
          } catch {
            /* ignore */
          }
          const autoregProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const autoregDevice = resolveAppClientParams(
            account.id,
            account.appClientId,
          );
          const autoregLog = await runAutoreg(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            job.startCommand,
            autoregCfg as unknown as AutoregConfig,
            signal,
            autoregProxy,
            autoregDevice,
            job.replyTimeoutMs,
          );
          detailLogs?.push(autoregLog);
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.jobType}`);
      }
      return;
    } catch (err) {
      if (err instanceof CheckinError) detailLogs?.push(err.log);
      if (err instanceof CustomJobError) detailLogs?.push(err.log);
      if (err instanceof AutoregJobError) detailLogs?.push(err.log);
      lastError = err;
      // A cancelled job must not be retried, and must report as cancelled even
      // if the underlying failure surfaced as something else.
      if (signal?.aborted) throw new Error("Job cancelled");
      console.error(
        `[runner] Job "${job.name}" attempt ${attempt}/${job.retryMax} failed:`,
        err,
      );
      if (attempt < job.retryMax && signal) {
        await delayAbortable(RETRY_DELAY_MS, signal).catch(() => {
          throw lastError;
        });
      } else if (attempt < job.retryMax) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    }

    throw lastError;
  } finally {
    signal?.removeEventListener("abort", stopBrowsers);
    // However the run ended, its screen goes with it: an X server left behind holds a
    // display number, and there is nothing left to watch on it
    releaseRunDisplay(cfRun.runId);
  }
}
