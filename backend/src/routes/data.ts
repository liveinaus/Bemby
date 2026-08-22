import { Router } from 'express';
import { db } from '../db/database';
import { decryptPayload, encryptPayload, type EncryptedEnvelope } from '../db/exportCrypto';
import { decryptAccountRow, encryptSecret } from '../db/secretColumns';
import { exportData, isValidDataName } from '../db/dataStore';
import { refreshScheduler } from '../scheduler';
import { applyGlobalProxy } from '../tg/globalProxy';
import { reconcileListeners } from '../tg/vlessTunnel';
import {
  verifyPassword,
  legacyHashPassword,
  timingSafeCompare,
  getStoredCredentials,
} from '../auth/credentials';
import {
  savePasskeySecret,
  parseStoredPasskey,
  importedPasskeyFor,
  type StoredPasskey,
} from '../tg/passkeyStore';
import {
  parseAttributes,
  writeAttributes,
  foldImportedAttributes,
  LEGACY_PASSKEY_STORE_KEY,
} from '../db/accountAttributes';

// Admin/JWT secrets are instance-local and must never travel in a backup.
export const EXPORT_EXCLUDED_SETTINGS = new Set([
  'admin_password_hash',
  'admin_username',
  'jwt_secret',
  // References an instance-local ai_models row id; meaningless after import
  'ai_default_model_id',
]);

// Settings whose presence forces the export to be encrypted. Proxy entries carry their
// credentials in the URL, and a provider entry carries the seller's API token.
export const SENSITIVE_SETTING_KEYS = [
  'default_tg_api_hash',
  'proxies',
  'proxy_providers',
  'webshare_api_key',
  // A tunnel node's uuid is what its Worker admits the connection on
  'vless_nodes',
  // Whoever holds the notification bot's token can act as that bot
  'notify_bot_token',
  // Whoever holds the msOauth2api key can read every mailbox that install holds
  'msapi_api_key',
];

// Config keys that carry a credential (e.g. Emby login) inside a job/template config blob.
const SENSITIVE_CONFIG_KEYS = ['password', 'username'];

/** True if a job/template config JSON string carries a credential field. */
function configHasSecret(config: string | null | undefined): boolean {
  if (!config) return false;
  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    return SENSITIVE_CONFIG_KEYS.some((k) => Boolean(parsed?.[k]));
  } catch {
    return false;
  }
}

// Encryption is mandatory when the payload carries any credential-bearing field:
// session strings, API keys, per-account API hashes, sensitive settings, or an
// Emby username/password embedded in a job/template config.
export function exportRequiresEncryption(
  payload: Pick<ExportPayload, 'accounts' | 'aiSuppliers' | 'settings'> &
    Partial<Pick<ExportPayload, 'jobs' | 'templates'>>,
): boolean {
  return (
    payload.accounts.some(
      (a) => a.sessionString || a.apiHash || a.passkey?.privateKeyPem,
    ) ||
    (payload.aiSuppliers ?? []).some((s) => s.apiKey) ||
    SENSITIVE_SETTING_KEYS.some((k) => Boolean(payload.settings?.[k])) ||
    (payload.jobs ?? []).some((j) => configHasSecret(j.config)) ||
    (payload.templates ?? []).some((t) => configHasSecret(t.config))
  );
}

const router = Router();

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  app_client_id: string | null;
  disabled: number;
  sort_order: number;
  tg_display_name: string | null;
  tg_username: string | null;
  notes: string | null;
  passkey: string | null;
  additional_attributes: string | null;
};

type JobRow = {
  id: number;
  account_id: number | null;
  template_id: number | null;
  name: string;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  run_every_days: number;
  run_every_days_max: number | null;
  retired: string | null;
  last_success_at: string | null;
};

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  run_every_days: number;
  run_every_days_max: number | null;
};

type SettingRow = { key: string; value: string };

type AiSupplierRow = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
};

type AiModelRow = {
  id: number;
  supplier_id: number;
  model_id: string;
  label: string | null;
};

export type ExportPayload = {
  version: '1';
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
    proxyId?: string | null;
    appClientId?: string | null;
    disabled?: boolean;
    sortOrder?: number | null;
    tgDisplayName?: string | null;
    tgUsername?: string | null;
    notes?: string | null;
    // Passkey secret and generic flags travel inline with the account so nothing needs
    // remapping on import (a raw settings blob would keep stale, detached account ids).
    passkey?: StoredPasskey | null;
    additionalAttributes?: Record<string, unknown> | null;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled?: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
  }>;
  jobs: Array<{
    /** Index into the accounts array; null for jobs that don't require an account */
    accountIndex: number | null;
    /** Index into the templates array; null if not linked to a template */
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
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
    /** ISO timestamp when the job was retired (archived); null for live jobs. */
    retired?: string | null;
    /** Last successful run, which the run-every-days spacing is measured from. */
    lastSuccessAt?: string | null;
  }>;
  aiSuppliers?: Array<{
    name: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }>;
  aiModels?: Array<{
    /** Index into the aiSuppliers array */
    supplierIndex: number;
    modelId: string;
    label: string | null;
  }>;
  /**
   * The data store, folder by folder. A backup that left it out would silently lose whatever
   * the jobs have saved there, which is the one part of the store nothing else holds a copy of.
   */
  dataFolders?: Array<{ name: string; records: Array<{ key: string; value: unknown }> }>;
  settings: Record<string, string>;
};

/** Ids of the proxies currently configured, for validating references against. */
function configuredProxyIds(): Set<string> {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as
    | { value: string }
    | undefined;
  try {
    const list = JSON.parse(row?.value ?? '[]') as Array<{ id?: string }>;
    return new Set(list.map((p) => p.id).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/**
 * Drops proxy references that point at proxies this instance does not have: the account
 * column, and the `proxyId` inside job and template configs. Returns how many were
 * cleared. A dangling reference is worse than none, because it silently resolves to no
 * proxy at all instead of the one the job was set up with.
 */
export function clearDanglingProxyRefs(): number {
  const known = configuredProxyIds();
  let cleared = 0;

  const accounts = db
    .prepare("SELECT id, proxy_id FROM tg_accounts WHERE proxy_id IS NOT NULL AND proxy_id != ''")
    .all() as Array<{ id: number; proxy_id: string }>;
  for (const a of accounts) {
    if (known.has(a.proxy_id)) continue;
    db.prepare('UPDATE tg_accounts SET proxy_id = NULL WHERE id = ?').run(a.id);
    cleared++;
  }

  for (const table of ['jobs', 'job_templates'] as const) {
    const rows = db
      .prepare(`SELECT id, config FROM ${table} WHERE config IS NOT NULL AND config LIKE '%proxyId%'`)
      .all() as Array<{ id: number; config: string }>;
    for (const row of rows) {
      let cfg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.config);
        cfg = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch {
        continue;
      }
      const proxyId = cfg?.proxyId;
      if (typeof proxyId !== 'string' || !proxyId || known.has(proxyId)) continue;
      delete cfg.proxyId;
      db.prepare(`UPDATE ${table} SET config = ? WHERE id = ?`).run(JSON.stringify(cfg), row.id);
      cleared++;
    }
  }

  return cleared;
}

router.post('/export', (req, res) => {
  const { secret } = req.body as { secret?: string };

  const accounts = (db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as AccountRow[])
    // The backup has its own encryption; the at-rest key must not be needed to restore it
    .map(decryptAccountRow);
  const templates = db.prepare('SELECT * FROM job_templates ORDER BY id').all() as TemplateRow[];
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[];
  const aiSuppliers = db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all() as AiSupplierRow[];
  const aiModels = db.prepare('SELECT * FROM ai_models ORDER BY id').all() as AiModelRow[];
  const settings = db.prepare('SELECT key, value FROM settings').all() as SettingRow[];

  const accountIdToIndex = new Map(accounts.map((a, i) => [a.id, i]));
  const templateIdToIndex = new Map(templates.map((t, i) => [t.id, i]));
  const supplierIdToIndex = new Map(aiSuppliers.map((s, i) => [s.id, i]));

  const payload: ExportPayload = {
    version: '1',
    exportedAt: new Date().toISOString(),
    accounts: accounts.map(a => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
      appClientId: a.app_client_id ?? null,
      disabled: Boolean(a.disabled),
      sortOrder: a.sort_order ?? 0,
      tgDisplayName: a.tg_display_name ?? null,
      tgUsername: a.tg_username ?? null,
      notes: a.notes ?? null,
      passkey: parseStoredPasskey(a.passkey),
      additionalAttributes: parseAttributes(a.additional_attributes),
    })),
    templates: templates.map(t => ({
      name: t.name,
      jobType: t.job_type,
      botUsername: t.bot_username,
      timezone: t.timezone,
      replyTimeoutMs: t.reply_timeout_ms,
      retryMax: t.retry_max,
      enabled: t.enabled === 1,
      config: t.config,
      startCommand: t.start_command,
      checkinButton: t.checkin_button,
      runEveryDays: t.run_every_days ?? 1,
      runEveryDaysMax: t.run_every_days_max ?? null,
    })),
    jobs: jobs.map(j => ({
      accountIndex: j.account_id != null ? (accountIdToIndex.get(j.account_id) ?? null) : null,
      templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
      name: j.name,
      jobType: j.job_type,
      botUsername: j.bot_username,
      scheduleWindowStart: j.schedule_window_start,
      scheduleWindowEnd: j.schedule_window_end,
      timezone: j.timezone,
      replyTimeoutMs: j.reply_timeout_ms,
      retryMax: j.retry_max,
      enabled: j.enabled === 1,
      config: j.config,
      startCommand: j.start_command,
      checkinButton: j.checkin_button,
      runEveryDays: j.run_every_days ?? 1,
      runEveryDaysMax: j.run_every_days_max ?? null,
      retired: j.retired ?? null,
      lastSuccessAt: j.last_success_at ?? null,
    })),
    aiSuppliers: aiSuppliers.map(s => ({
      name: s.name,
      baseUrl: s.base_url,
      apiKey: s.api_key,
      timeoutMs: s.timeout_ms,
    })),
    aiModels: aiModels
      .filter(m => supplierIdToIndex.has(m.supplier_id))
      .map(m => ({
        supplierIndex: supplierIdToIndex.get(m.supplier_id)!,
        modelId: m.model_id,
        label: m.label,
      })),
    dataFolders: exportData().folders,
    settings: Object.fromEntries(
      settings
        // Passkeys now live on the account row (exported per-account above), never as a
        // setting. Exclude the legacy blob in case an un-migrated DB still holds it.
        .filter(s => !EXPORT_EXCLUDED_SETTINGS.has(s.key) && s.key !== LEGACY_PASSKEY_STORE_KEY)
        .map(s => [s.key, s.value]),
    ),
  };

  const hasSecrets = exportRequiresEncryption(payload);

  if (hasSecrets && !secret) {
    res.status(400).json({
      error: 'This export contains sensitive credentials (session strings or API keys). Provide an encryption secret.',
      code: 'SECRET_REQUIRED',
    });
    return;
  }

  if (secret) {
    res.json(encryptPayload(JSON.stringify(payload), secret));
  } else {
    res.json(payload);
  }
});

router.post('/import', async (req, res) => {
  let { data, mode, secret, forceReauth = true, confirmPassword } = req.body as { data: ExportPayload | EncryptedEnvelope; mode: 'merge' | 'replace'; secret?: string; forceReauth?: boolean; confirmPassword?: string };

  if (data && (data as EncryptedEnvelope).encrypted === true) {
    if (!secret) {
      res.status(400).json({ error: 'This backup is encrypted. Please provide the secret to decrypt it.' });
      return;
    }
    try {
      data = JSON.parse(decryptPayload(data as EncryptedEnvelope, secret)) as ExportPayload;
    } catch {
      res.status(400).json({ error: 'Incorrect secret or corrupted backup file', code: 'WRONG_SECRET' });
      return;
    }
  }

  const payload = data as ExportPayload;

  if (!payload || payload.version !== '1') {
    res.status(400).json({ error: 'Invalid or unsupported export file' });
    return;
  }

  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.jobs)) {
    res.status(400).json({ error: 'Malformed export file: missing accounts or jobs' });
    return;
  }

  if (mode === 'replace') {
    if (!confirmPassword) {
      res.status(400).json({ error: 'Current password confirmation is required for replace-mode import.', code: 'CONFIRM_REQUIRED' });
      return;
    }
    const stored = getStoredCredentials();
    // With no stored hash and no ADMIN_PASSWORD, the old fallback compared the input against
    // the hash of the empty string, so an empty confirmPassword passed. Refuse outright
    // instead: there is nothing to check against, and a wipe is not the place to fail open.
    const envPassword = process.env.ADMIN_PASSWORD;
    const valid = stored.passwordHash
      ? await verifyPassword(confirmPassword, stored.passwordHash)
      : envPassword
        ? timingSafeCompare(legacyHashPassword(confirmPassword), legacyHashPassword(envPassword))
        : false;
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password', code: 'WRONG_PASSWORD' });
      return;
    }
  }

  const results = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, aiSuppliersImported: 0, aiModelsImported: 0, dataFoldersImported: 0, dataRecordsImported: 0, settingsUpdated: 0, proxyRefsCleared: 0 };

  try {
    db.transaction(() => {
    if (mode === 'replace') {
      // FK order: models -> suppliers, jobs -> templates/accounts
      db.prepare('DELETE FROM ai_models').run();
      db.prepare('DELETE FROM ai_suppliers').run();
      db.prepare('DELETE FROM jobs').run();
      db.prepare('DELETE FROM job_templates').run();
      db.prepare('DELETE FROM tg_accounts').run();
      db.prepare('DELETE FROM data_records').run();
      db.prepare('DELETE FROM data_folders').run();
      // The pinned default references a wiped ai_models row id
      db.prepare("DELETE FROM settings WHERE key = 'ai_default_model_id'").run();
    }

    // Import accounts and build accountIndex -> new db id mapping
    const accountIndexToId = new Map<number, number>();

    for (let i = 0; i < payload.accounts.length; i++) {
      const a = payload.accounts[i];

      if (mode === 'merge') {
        const existing = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber) as { id: number } | undefined;
        if (existing) {
          accountIndexToId.set(i, existing.id);
          results.accountsSkipped++;
          continue;
        }
      }

      const result = db.prepare(
        `INSERT INTO tg_accounts
           (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id,
            app_client_id, disabled, sort_order, tg_display_name, tg_username, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.name, a.phoneNumber, a.apiId, encryptSecret(a.apiHash),
        encryptSecret(forceReauth ? null : (a.sessionString ?? null)),
        forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'),
        a.proxyId ?? null,
        a.appClientId ?? null,
        a.disabled ? 1 : 0,
        Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : 0,
        a.tgDisplayName ?? null,
        a.tgUsername ?? null,
        a.notes ?? null,
      );

      const newAccountId = result.lastInsertRowid as number;
      accountIndexToId.set(i, newAccountId);
      // Restore the passkey secret under the new account id so passkey login still works
      // after import (even when force-reauth clears the session string).
      const pk = importedPasskeyFor(a);
      if (pk) savePasskeySecret({ ...pk, accountId: newAccountId });
      // Restore the generic attributes bag.
      const attrs = foldImportedAttributes(a);
      if (attrs) writeAttributes(newAccountId, attrs);
      results.accountsImported++;
    }

    // Import templates and build templateIndex -> new db id mapping
    const templateIndexToId = new Map<number, number>();

    if (Array.isArray(payload.templates)) {
      for (let i = 0; i < payload.templates.length; i++) {
        const t = payload.templates[i];

        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM job_templates WHERE name = ?').get(t.name) as { id: number } | undefined;
          if (existing) {
            templateIndexToId.set(i, existing.id);
            continue;
          }
        }

        const result = db.prepare(
          `INSERT INTO job_templates
             (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled, config,
              start_command, checkin_button, run_every_days, run_every_days_max)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          t.name,
          t.jobType ?? 'checkin',
          t.botUsername ?? '',
          t.timezone ?? '',
          t.replyTimeoutMs ?? 40000,
          t.retryMax ?? 5,
          // Older backups carry no template enabled flag; those templates were usable
          t.enabled === false ? 0 : 1,
          t.config ?? null,
          t.startCommand ?? '/start',
          t.checkinButton ?? '签到',
          t.runEveryDays ?? 1,
          t.runEveryDaysMax ?? null,
        );

        templateIndexToId.set(i, result.lastInsertRowid as number);
        results.templatesImported++;
      }
    }

    // Import jobs
    for (const j of payload.jobs) {
      const resolvedAccountId = j.accountIndex != null ? (accountIndexToId.get(j.accountIndex) ?? null) : null;
      const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;

      db.prepare(
        `INSERT INTO jobs
           (account_id, template_id, name, job_type, bot_username, schedule_window_start, schedule_window_end,
            timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button,
            run_every_days, run_every_days_max, retired, last_success_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        resolvedAccountId,
        resolvedTemplateId,
        j.name,
        j.jobType ?? 'checkin',
        j.botUsername,
        j.scheduleWindowStart ?? 1400,
        j.scheduleWindowEnd ?? 1600,
        j.timezone ?? '',
        j.replyTimeoutMs ?? 40000,
        j.retryMax ?? 5,
        j.enabled ? 1 : 0,
        j.config ?? null,
        j.startCommand ?? '/start',
        j.checkinButton ?? '签到',
        j.runEveryDays ?? 1,
        j.runEveryDaysMax ?? null,
        // A retired job must not come back live; older backups have no such jobs
        j.retired ?? null,
        j.lastSuccessAt ?? null,
      );
      results.jobsImported++;
    }

    // Import AI suppliers and build supplierIndex -> new db id mapping
    const supplierIndexToId = new Map<number, number>();

    if (Array.isArray(payload.aiSuppliers)) {
      for (let i = 0; i < payload.aiSuppliers.length; i++) {
        const s = payload.aiSuppliers[i];

        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM ai_suppliers WHERE name = ?').get(s.name) as { id: number } | undefined;
          if (existing) {
            supplierIndexToId.set(i, existing.id);
            continue;
          }
        }

        const result = db.prepare(
          'INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)',
        ).run(s.name, s.baseUrl, s.apiKey, s.timeoutMs ?? 25000);

        supplierIndexToId.set(i, result.lastInsertRowid as number);
        results.aiSuppliersImported++;
      }
    }

    // Import AI models
    if (Array.isArray(payload.aiModels)) {
      for (const m of payload.aiModels) {
        const resolvedSupplierId = supplierIndexToId.get(m.supplierIndex);
        if (resolvedSupplierId == null) continue;

        db.prepare(
          'INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)',
        ).run(resolvedSupplierId, m.modelId, m.label ?? null);
        results.aiModelsImported++;
      }
    }

    // Import the data store. A record already in the folder is overwritten: the backup is the
    // newer copy of what a job saved, and keeping the older value would be the surprise.
    if (Array.isArray(payload.dataFolders)) {
      for (const folder of payload.dataFolders) {
        const name = String(folder?.name ?? '').trim();
        if (!isValidDataName(name)) continue;
        const existing = db.prepare('SELECT id FROM data_folders WHERE name = ?').get(name) as { id: number } | undefined;
        const folderId = existing
          ? existing.id
          : (db.prepare('INSERT INTO data_folders (name) VALUES (?)').run(name).lastInsertRowid as number);
        if (!existing) results.dataFoldersImported++;

        for (const record of folder?.records ?? []) {
          const key = String(record?.key ?? '').trim();
          if (!isValidDataName(key)) continue;
          db.prepare(
            `INSERT INTO data_records (folder_id, key, value) VALUES (?, ?, ?)
               ON CONFLICT(folder_id, key) DO UPDATE
                 SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          ).run(folderId, key, JSON.stringify(record.value ?? null));
          results.dataRecordsImported++;
        }
      }
    }

    // Merge settings -- never let a backup overwrite instance-local admin/JWT secrets
    if (payload.settings && typeof payload.settings === 'object') {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(payload.settings)) {
        if (EXPORT_EXCLUDED_SETTINGS.has(key)) continue;
        // Never merge a legacy raw passkey blob: passkeys live on the account row now,
        // and an older backup's blob carries stale account ids.
        if (key === LEGACY_PASSKEY_STORE_KEY) continue;
        if (typeof value === 'string') { stmt.run(key, value); results.settingsUpdated++; }
      }
    }

    // A proxy reference is an id that only means something next to the proxy list it came
    // from: a backup taken without proxies, or one imported into an instance with its own,
    // leaves accounts and jobs pointing at nothing. That reads as "no proxy" at run time
    // rather than as an error, so the dangling references are cleared here and counted.
    results.proxyRefsCleared = clearDanglingProxyRefs();
    })();
  } catch (err) {
    // A malformed backup can throw inside the transaction (bad bind value,
    // constraint violation). Roll back and respond, rather than letting the
    // rejection escape the async handler and hang the request.
    res.status(400).json({
      error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  refreshScheduler();
  // Tunnel exits restored from the backup have to start listening, or every proxy the
  // imported list points at loopback for answers on a port with nothing behind it
  reconcileListeners();
  // The backup carries the global exit and the list it names, so what everything unrouted
  // goes out by has just changed under the running process
  applyGlobalProxy();
  res.json({ message: 'Import complete', ...results });
});

export default router;
