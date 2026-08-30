import { getDefaultTgApiCredentials } from "../db/database";
import { iconFromConfig } from "./configIcon";
import type { Job, TgAccount } from "../types";

// Row shapes and row-to-domain mappers for jobs, shared by the job routes and
// the manual-run helper.

export type JobRow = {
  id: number;
  name: string;
  account_id: number | null;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  created_at: string;
  config: string | null;
  start_command: string;
  checkin_button: string;
  template_id: number | null;
  run_every_days: number;
  run_every_days_max: number | null;
  retired: string | null;
  last_success_at: string | null;
  one_time: number;
  account_name?: string;
  /** Joined in by the list query, for working out the job's effective exit. */
  account_proxy_id?: string | null;
};

export type JobAccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
};

/** Credentials are resolved as a pair: the account's own if complete, else the global defaults. */
export function rowToAccount(row: JobAccountRow): TgAccount {
  const ownCredentials =
    row.api_id && row.api_hash
      ? { apiId: row.api_id, apiHash: row.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: credentials?.apiId ?? null,
    apiHash: credentials?.apiHash ?? null,
    sessionString: row.session_string,
    authStatus: row.auth_status as TgAccount["authStatus"],
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
  };
}

export function rowToJob(row: JobRow): Job & { accountName?: string } {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id ?? null,
    accountName: row.account_name,
    jobType: row.job_type as Job["jobType"],
    botUsername: row.bot_username,
    scheduleWindowStart: row.schedule_window_start,
    scheduleWindowEnd: row.schedule_window_end,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    config: row.config ?? null,
    startCommand: row.start_command || "/start",
    checkinButton: row.checkin_button || "签到",
    templateId: row.template_id ?? null,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    retired: row.retired ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    oneTime: Boolean(row.one_time),
    // Stored inside config; surfaced as its own field so callers never touch the JSON
    icon: iconFromConfig(row.config),
  };
}
