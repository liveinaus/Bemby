// Tests for the full-database export/import (routes/data.ts) and
// account-only export/import (routes/accounts.ts).
// Uses in-memory SQLite to replay the exact SQL the route handlers execute.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import type { ExportPayload } from '../routes/data';
import { exportRequiresEncryption, EXPORT_EXCLUDED_SETTINGS } from '../routes/data';

type DB = InstanceType<typeof Database>;

// ── Schema matching the current state of database.ts ─────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    phone_number    TEXT    NOT NULL,
    api_id          INTEGER NOT NULL,
    api_hash        TEXT    NOT NULL,
    session_string  TEXT,
    auth_status     TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    proxy_id        TEXT,
    disabled        INTEGER NOT NULL DEFAULT 0,
    app_client_id   TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username     TEXT,
    passkey               TEXT,
    additional_attributes TEXT
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    job_type         TEXT    NOT NULL DEFAULT 'checkin',
    bot_username     TEXT    NOT NULL DEFAULT '',
    timezone         TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 5,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT    NOT NULL DEFAULT '/start',
    checkin_button   TEXT    NOT NULL DEFAULT '签到',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    run_every_days   INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT    NOT NULL DEFAULT '/start',
    checkin_button        TEXT    NOT NULL DEFAULT '签到',
    template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    run_every_days        INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// ── Helpers that mirror the exact SQL in routes/data.ts ──────────────────────

function buildExportPayload(db: DB): ExportPayload {
  const accounts   = db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as any[];
  const templates  = db.prepare('SELECT * FROM job_templates ORDER BY id').all() as any[];
  const jobs       = db.prepare('SELECT * FROM jobs ORDER BY id').all() as any[];
  const aiSuppliers = db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all() as any[];
  const aiModels   = db.prepare('SELECT * FROM ai_models ORDER BY id').all() as any[];
  const settings   = db.prepare('SELECT key, value FROM settings').all() as any[];

  const accountIdToIndex  = new Map(accounts.map((a: any, i: number) => [a.id, i]));
  const templateIdToIndex = new Map(templates.map((t: any, i: number) => [t.id, i]));
  const supplierIdToIndex = new Map(aiSuppliers.map((s: any, i: number) => [s.id, i]));

  return {
    version: '1',
    exportedAt: new Date().toISOString(),
    accounts: accounts.map((a: any) => ({
      name: a.name, phoneNumber: a.phone_number, apiId: a.api_id, apiHash: a.api_hash,
      sessionString: a.session_string, authStatus: a.auth_status, proxyId: a.proxy_id ?? null,
      passkey: a.passkey ? JSON.parse(a.passkey) : null,
      additionalAttributes: a.additional_attributes ? JSON.parse(a.additional_attributes) : {},
    })),
    templates: templates.map((t: any) => ({
      name: t.name, jobType: t.job_type, botUsername: t.bot_username, timezone: t.timezone,
      replyTimeoutMs: t.reply_timeout_ms, retryMax: t.retry_max, config: t.config,
      startCommand: t.start_command, checkinButton: t.checkin_button,
    })),
    jobs: jobs.map((j: any) => ({
      accountIndex:  j.account_id  != null ? (accountIdToIndex.get(j.account_id)   ?? null) : null,
      templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
      name: j.name, jobType: j.job_type, botUsername: j.bot_username,
      scheduleWindowStart: j.schedule_window_start, scheduleWindowEnd: j.schedule_window_end,
      timezone: j.timezone, replyTimeoutMs: j.reply_timeout_ms, retryMax: j.retry_max,
      enabled: j.enabled === 1, config: j.config, startCommand: j.start_command, checkinButton: j.checkin_button,
    })),
    aiSuppliers: aiSuppliers.map((s: any) => ({
      name: s.name, baseUrl: s.base_url, apiKey: s.api_key, timeoutMs: s.timeout_ms,
    })),
    aiModels: aiModels
      .filter((m: any) => supplierIdToIndex.has(m.supplier_id))
      .map((m: any) => ({
        supplierIndex: supplierIdToIndex.get(m.supplier_id)!,
        modelId: m.model_id, label: m.label,
      })),
    settings: Object.fromEntries(
      settings.filter((s: any) => s.key !== LEGACY_PASSKEY_STORE_KEY).map((s: any) => [s.key, s.value]),
    ),
  };
}

type ImportResults = {
  accountsImported: number; accountsSkipped: number; templatesImported: number;
  jobsImported: number; aiSuppliersImported: number; aiModelsImported: number; settingsUpdated: number;
};

function runImport(db: DB, payload: ExportPayload, mode: 'merge' | 'replace', forceReauth = true): ImportResults {
  const results: ImportResults = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, aiSuppliersImported: 0, aiModelsImported: 0, settingsUpdated: 0 };

  db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM ai_models').run();
      db.prepare('DELETE FROM ai_suppliers').run();
      db.prepare('DELETE FROM jobs').run();
      db.prepare('DELETE FROM job_templates').run();
      db.prepare('DELETE FROM tg_accounts').run();
    }

    const accountIndexToId = new Map<number, number>();
    for (let i = 0; i < payload.accounts.length; i++) {
      const a = payload.accounts[i];
      if (mode === 'merge') {
        const existing = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber) as { id: number } | undefined;
        if (existing) { accountIndexToId.set(i, existing.id); results.accountsSkipped++; continue; }
      }
      const r = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(a.name, a.phoneNumber, a.apiId, a.apiHash,
          forceReauth ? null : (a.sessionString ?? null),
          forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'),
          a.proxyId ?? null);
      const newAccountId = r.lastInsertRowid as number;
      accountIndexToId.set(i, newAccountId);
      const pk = importedPasskey(a);
      if (pk) savePasskey(db, newAccountId, pk);
      restoreAttrs(db, newAccountId, a);
      results.accountsImported++;
    }

    const templateIndexToId = new Map<number, number>();
    if (Array.isArray(payload.templates)) {
      for (let i = 0; i < payload.templates.length; i++) {
        const t = payload.templates[i];
        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM job_templates WHERE name = ?').get(t.name) as { id: number } | undefined;
          if (existing) { templateIndexToId.set(i, existing.id); continue; }
        }
        const r = db.prepare('INSERT INTO job_templates (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(t.name, t.jobType ?? 'checkin', t.botUsername ?? '', t.timezone ?? 'Australia/Sydney', t.replyTimeoutMs ?? 40000, t.retryMax ?? 5, t.config ?? null, t.startCommand ?? '/start', t.checkinButton ?? '签到');
        templateIndexToId.set(i, r.lastInsertRowid as number);
        results.templatesImported++;
      }
    }

    for (const j of payload.jobs) {
      const resolvedAccountId  = j.accountIndex  != null ? (accountIndexToId.get(j.accountIndex)   ?? null) : null;
      const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;
      db.prepare('INSERT INTO jobs (account_id, template_id, name, job_type, bot_username, schedule_window_start, schedule_window_end, timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(resolvedAccountId, resolvedTemplateId, j.name, j.jobType ?? 'checkin', j.botUsername, j.scheduleWindowStart ?? 1400, j.scheduleWindowEnd ?? 1600, j.timezone ?? 'Australia/Sydney', j.replyTimeoutMs ?? 40000, j.retryMax ?? 5, j.enabled ? 1 : 0, j.config ?? null, j.startCommand ?? '/start', j.checkinButton ?? '签到');
      results.jobsImported++;
    }

    const supplierIndexToId = new Map<number, number>();
    if (Array.isArray(payload.aiSuppliers)) {
      for (let i = 0; i < payload.aiSuppliers.length; i++) {
        const s = payload.aiSuppliers[i];
        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM ai_suppliers WHERE name = ?').get(s.name) as { id: number } | undefined;
          if (existing) { supplierIndexToId.set(i, existing.id); continue; }
        }
        const r = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run(s.name, s.baseUrl, s.apiKey, s.timeoutMs ?? 25000);
        supplierIndexToId.set(i, r.lastInsertRowid as number);
        results.aiSuppliersImported++;
      }
    }

    if (Array.isArray(payload.aiModels)) {
      for (const m of payload.aiModels) {
        const resolvedSupplierId = supplierIndexToId.get(m.supplierIndex);
        if (resolvedSupplierId == null) continue;
        db.prepare('INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)').run(resolvedSupplierId, m.modelId, m.label ?? null);
        results.aiModelsImported++;
      }
    }

    if (payload.settings && typeof payload.settings === 'object') {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(payload.settings)) {
        if (key === LEGACY_PASSKEY_STORE_KEY) continue;
        if (typeof value === 'string') { stmt.run(key, value); results.settingsUpdated++; }
      }
    }
  })();

  return results;
}

// ── Encryption helpers (mirrors routes/data.ts) ───────────────────────────────

function encryptPayload(plaintext: string, secret: string) {
  const salt = crypto.randomBytes(16);
  const key  = crypto.scryptSync(secret, salt, 32);
  const iv   = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { encrypted: true as const, version: '1' as const, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('base64') };
}

function decryptPayload(envelope: ReturnType<typeof encryptPayload>, secret: string): string {
  const salt    = Buffer.from(envelope.salt, 'hex');
  const key     = crypto.scryptSync(secret, salt, 32);
  const iv      = Buffer.from(envelope.iv,   'hex');
  const tag     = Buffer.from(envelope.tag,  'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(Buffer.from(envelope.data, 'base64')) + decipher.final('utf8');
}

// ── AES-256-GCM encryption ────────────────────────────────────────────────────

describe('AES-256-GCM encryption', () => {
  it('round-trips plaintext correctly', () => {
    const text = JSON.stringify({ version: '1', accounts: [], jobs: [] });
    expect(decryptPayload(encryptPayload(text, 's3cr3t'), 's3cr3t')).toBe(text);
  });

  it('throws when decrypting with the wrong secret', () => {
    const envelope = encryptPayload('hello world', 'correct');
    expect(() => decryptPayload(envelope, 'wrong')).toThrow();
  });

  it('produces unique ciphertext on every call (random IV + salt)', () => {
    const e1 = encryptPayload('same', 'key');
    const e2 = encryptPayload('same', 'key');
    expect(e1.data).not.toBe(e2.data);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.salt).not.toBe(e2.salt);
  });
});

// ── Export encryption trigger (plaintext-leak guard) ─────────────────────────

describe('exportRequiresEncryption -- forces encryption for any credential', () => {
  const base = { accounts: [], aiSuppliers: [], settings: {} } as Pick<ExportPayload, 'accounts' | 'aiSuppliers' | 'settings'>;

  it('is false for a payload with no credentials', () => {
    expect(exportRequiresEncryption(base)).toBe(false);
  });

  it('is true when an account has a session string', () => {
    expect(exportRequiresEncryption({ ...base, accounts: [{ name: 'A', phoneNumber: '+1', apiId: 1, apiHash: '', sessionString: 'sess', authStatus: 'authenticated' }] })).toBe(true);
  });

  it('is true when an account has an API hash but no session (regression: was plaintext)', () => {
    expect(exportRequiresEncryption({ ...base, accounts: [{ name: 'A', phoneNumber: '+1', apiId: 1, apiHash: 'h', sessionString: null, authStatus: 'unauthenticated' }] })).toBe(true);
  });

  it('is true when an AI supplier has an API key', () => {
    expect(exportRequiresEncryption({ ...base, aiSuppliers: [{ name: 'x', baseUrl: 'u', apiKey: 'sk', timeoutMs: 1 }] })).toBe(true);
  });

  it('is true when settings contain default_tg_api_hash', () => {
    expect(exportRequiresEncryption({ ...base, settings: { default_tg_api_hash: 'abc' } })).toBe(true);
  });

  it('is true when settings contain proxies', () => {
    expect(exportRequiresEncryption({ ...base, settings: { proxies: 'socks5://u:p@host:1080' } })).toBe(true);
  });

  it('is true when settings contain a proxy provider token (regression: was plaintext)', () => {
    expect(
      exportRequiresEncryption({
        ...base,
        settings: { proxy_providers: '[{"id":"webshare","type":"webshare","apiKey":"tok"}]' },
      }),
    ).toBe(true);
    expect(exportRequiresEncryption({ ...base, settings: { webshare_api_key: 'tok' } })).toBe(true);
  });

  it('is true when settings carry tunnel nodes, whose uuid is the credential', () => {
    expect(
      exportRequiresEncryption({
        ...base,
        settings: {
          vless_nodes:
            '[{"proxyId":"pp:a:b","providerId":"a","port":24080,"node":{"uuid":"d342d11e-d424-4583-b36e-524ab1f0afa4"}}]',
        },
      }),
    ).toBe(true);
  });

  it('is true when a job config embeds an Emby password (regression: was plaintext)', () => {
    const jobs = [{ config: JSON.stringify({ username: 'u', password: 'p' }) }] as ExportPayload['jobs'];
    expect(exportRequiresEncryption({ ...base, jobs })).toBe(true);
  });

  it('is true when a template config embeds credentials', () => {
    const templates = [{ config: JSON.stringify({ username: 'u', password: 'p' }) }] as ExportPayload['templates'];
    expect(exportRequiresEncryption({ ...base, templates })).toBe(true);
  });

  it('is false for a job config with no credential fields', () => {
    const jobs = [{ config: JSON.stringify({ markWatched: true }) }] as ExportPayload['jobs'];
    expect(exportRequiresEncryption({ ...base, jobs })).toBe(false);
  });

  it('is false for a null or malformed job config', () => {
    const jobs = [{ config: null }, { config: 'not json' }] as ExportPayload['jobs'];
    expect(exportRequiresEncryption({ ...base, jobs })).toBe(false);
  });

  it('is true when an account carries a passkey private key (no session)', () => {
    const accounts = [{
      name: 'A', phoneNumber: '+1', apiId: 1, apiHash: '', sessionString: null, authStatus: 'unauthenticated',
      passkey: { telegramPasskeyId: 'p', credentialId: 'c', privateKeyPem: 'KEY', rpId: 'r', userHandle: 'u', createdDate: 1 },
    }] as ExportPayload['accounts'];
    expect(exportRequiresEncryption({ ...base, accounts })).toBe(true);
  });
});

describe('export excludes instance-local secrets', () => {
  it('never carries admin/JWT secrets in a backup', () => {
    expect(EXPORT_EXCLUDED_SETTINGS.has('admin_password_hash')).toBe(true);
    expect(EXPORT_EXCLUDED_SETTINGS.has('admin_username')).toBe(true);
    expect(EXPORT_EXCLUDED_SETTINGS.has('jwt_secret')).toBe(true);
  });
});

describe('full-database export/import -- passkeys & attributes', () => {
  const seed = () => { const db = new Database(':memory:'); db.exec(SCHEMA); return db; };

  it('carries the passkey per-account, never as a settings blob', () => {
    const db = seed();
    const { lastInsertRowid: id } = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    savePasskey(db, Number(id), makePasskey('pk1'));
    const payload = buildExportPayload(db);
    expect(payload.accounts[0].passkey?.telegramPasskeyId).toBe('pk1');
    expect(payload.settings[LEGACY_PASSKEY_STORE_KEY]).toBeUndefined();
  });

  it('restores the passkey onto the new account row on merge import', () => {
    const src = seed();
    const { lastInsertRowid: srcId } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    savePasskey(src, Number(srcId), makePasskey('pk1'));
    const payload = buildExportPayload(src);

    const dest = seed();
    dest.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Filler', '+61999999999', 9, 'x');
    runImport(dest, payload, 'merge');

    const acct = dest.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(acct.id).not.toBe(Number(srcId));
    expect(getPasskey(dest, acct.id)?.telegramPasskeyId).toBe('pk1');
  });

  it('round-trips the additional_attributes bag', () => {
    const src = seed();
    const { lastInsertRowid: id } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    src.prepare('UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?').run(JSON.stringify({ hasEmail: true, restriction: null }), id);
    const payload = buildExportPayload(src);

    const dest = seed();
    runImport(dest, payload, 'merge');
    const acct = dest.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(getAttrs(dest, acct.id)).toEqual({ hasEmail: true, restriction: null });
  });

  it('replace mode wipes the old passkey with its account and restores the imported one', () => {
    const src = seed();
    const { lastInsertRowid: srcId } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    savePasskey(src, Number(srcId), makePasskey('pk1'));
    const payload = buildExportPayload(src);

    const dest = seed();
    const { lastInsertRowid: oldId } = dest.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Old', '+61411111111', 5, 'y');
    savePasskey(dest, Number(oldId), makePasskey('stale'));
    runImport(dest, payload, 'replace');

    const rows = dest.prepare('SELECT id, phone_number FROM tg_accounts').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].phone_number).toBe('+61400000001');
    expect(getPasskey(dest, rows[0].id)?.telegramPasskeyId).toBe('pk1'); // stale row (and its passkey) gone
  });

  // Backward compatibility: an older backup keeps passkeys in the raw settings blob
  // (with account ids that no longer exist). Import must succeed and must NOT write
  // that stale blob back, so passkeys never mis-attach to the wrong account.
  it('imports an older backup without mis-attaching its stale passkey blob', () => {
    const legacyStore = JSON.stringify({ old: { accountId: 999, ...makePasskey('old') } });
    const payload = {
      version: '1' as const, exportedAt: 'x',
      accounts: [{ name: 'Alice', phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', sessionString: null, authStatus: 'unauthenticated' }],
      jobs: [], settings: { [LEGACY_PASSKEY_STORE_KEY]: legacyStore, some_other: 'kept' },
    } as unknown as ExportPayload;

    const dest = seed();
    const r = runImport(dest, payload, 'merge');
    expect(r.accountsImported).toBe(1);
    const acct = dest.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(getPasskey(dest, acct.id)).toBeNull();                       // no stale attach
    expect(dest.prepare('SELECT value FROM settings WHERE key = ?').get(LEGACY_PASSKEY_STORE_KEY)).toBeUndefined();
    expect((dest.prepare('SELECT value FROM settings WHERE key = ?').get('some_other') as any).value).toBe('kept');
  });
});

// ── Full-database export shape ────────────────────────────────────────────────

describe('full data export -- payload shape and content', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Alice', '+61400000001', 12345, 'hash-alice', 'sess-alice', 'authenticated', 'proxy-1');
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)')
      .run('Bob', '+61400000002', 67890, 'hash-bob');

    const tmplId = db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Daily Bot', '@dailybot').lastInsertRowid;
    db.prepare('INSERT INTO jobs (name, account_id, template_id, bot_username, job_type) VALUES (?, ?, ?, ?, ?)').run('Alice daily', 1, tmplId, '@dailybot', 'checkin');
    db.prepare('INSERT INTO jobs (name, account_id, bot_username) VALUES (?, ?, ?)').run('Standalone', null, '@other');

    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-secret', 25000).lastInsertRowid;
    db.prepare('INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)').run(suppId, 'gpt-4', 'GPT-4');

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('default_timezone', 'America/New_York');
  });

  it('version field is "1"', () => {
    expect(buildExportPayload(db).version).toBe('1');
  });

  it('exports all accounts', () => {
    const { accounts } = buildExportPayload(db);
    expect(accounts).toHaveLength(2);
    expect(accounts.map(a => a.phoneNumber)).toEqual(['+61400000001', '+61400000002']);
  });

  it('includes sensitive fields: apiHash and sessionString', () => {
    const { accounts } = buildExportPayload(db);
    expect(accounts[0].apiHash).toBe('hash-alice');
    expect(accounts[0].sessionString).toBe('sess-alice');
    expect(accounts[1].sessionString).toBeNull();
  });

  it('includes proxyId', () => {
    expect(buildExportPayload(db).accounts[0].proxyId).toBe('proxy-1');
  });

  it('exports all templates', () => {
    expect(buildExportPayload(db).templates).toHaveLength(1);
    expect(buildExportPayload(db).templates![0].name).toBe('Daily Bot');
  });

  it('maps job accountIndex to the correct account position', () => {
    const { jobs } = buildExportPayload(db);
    // Alice is index 0 in the accounts array
    expect(jobs.find(j => j.name === 'Alice daily')?.accountIndex).toBe(0);
  });

  it('maps job templateIndex to the correct template position', () => {
    const { jobs } = buildExportPayload(db);
    expect(jobs.find(j => j.name === 'Alice daily')?.templateIndex).toBe(0);
  });

  it('job with null account_id exports with accountIndex null', () => {
    expect(buildExportPayload(db).jobs.find(j => j.name === 'Standalone')?.accountIndex).toBeNull();
  });

  it('exports AI suppliers with full API key', () => {
    const { aiSuppliers } = buildExportPayload(db);
    expect(aiSuppliers).toHaveLength(1);
    expect(aiSuppliers![0].apiKey).toBe('sk-secret');
  });

  it('maps AI model supplierIndex to the correct supplier position', () => {
    const { aiModels } = buildExportPayload(db);
    expect(aiModels![0].supplierIndex).toBe(0);
    expect(aiModels![0].modelId).toBe('gpt-4');
  });

  it('exports all settings', () => {
    expect(buildExportPayload(db).settings['default_timezone']).toBe('America/New_York');
  });

  it('export can be encrypted and round-tripped', () => {
    const payload = buildExportPayload(db);
    const json    = JSON.stringify(payload);
    const envelope = encryptPayload(json, 'my-backup-secret');
    const restored = JSON.parse(decryptPayload(envelope, 'my-backup-secret')) as ExportPayload;
    expect(restored.version).toBe('1');
    expect(restored.accounts).toHaveLength(2);
    expect(restored.accounts[0].apiHash).toBe('hash-alice');
  });
});

// ── Full-database import -- merge mode ────────────────────────────────────────

describe('full data import -- merge mode', () => {
  let db: DB;

  const PAYLOAD: ExportPayload = {
    version: '1',
    exportedAt: '2024-01-01T00:00:00.000Z',
    accounts: [
      { name: 'Alice', phoneNumber: '+61400000001', apiId: 1, apiHash: 'h1', sessionString: 'sess-a', authStatus: 'authenticated' },
      { name: 'Bob',   phoneNumber: '+61400000002', apiId: 2, apiHash: 'h2', sessionString: null,     authStatus: 'unauthenticated' },
    ],
    templates: [
      { name: 'Tmpl', jobType: 'checkin', botUsername: '@bot', timezone: 'Australia/Sydney', replyTimeoutMs: 40000, retryMax: 5, config: null, startCommand: '/start', checkinButton: '签到' },
    ],
    jobs: [
      { accountIndex: 0, templateIndex: 0, name: 'Job A', jobType: 'checkin', botUsername: '@bot', scheduleWindowStart: 1400, scheduleWindowEnd: 1600, timezone: 'Australia/Sydney', replyTimeoutMs: 40000, retryMax: 5, enabled: true, config: null, startCommand: '/start', checkinButton: '签到' },
      { accountIndex: null, templateIndex: null, name: 'Emby Job', jobType: 'embywatch', botUsername: '', scheduleWindowStart: 900, scheduleWindowEnd: 1100, timezone: 'Australia/Sydney', replyTimeoutMs: 60000, retryMax: 3, enabled: true, config: '{"embyUrl":"http://emby:8096"}', startCommand: '/start', checkinButton: '' },
    ],
    aiSuppliers: [{ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-1', timeoutMs: 25000 }],
    aiModels:    [{ supplierIndex: 0, modelId: 'gpt-4', label: 'GPT-4' }],
    settings:    { default_timezone: 'America/New_York', check_daily_run: 'true' },
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
  });

  it('imports all accounts and returns correct counts', () => {
    const r = runImport(db, PAYLOAD, 'merge');
    expect(r.accountsImported).toBe(2);
    expect(r.accountsSkipped).toBe(0);
  });

  it('skips existing accounts by phone number and preserves original data', () => {
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Old Alice', '+61400000001', 99, 'old-hash');
    const r = runImport(db, PAYLOAD, 'merge');
    expect(r.accountsSkipped).toBe(1);
    expect(r.accountsImported).toBe(1);
    const alice = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(alice.name).toBe('Old Alice');
    expect(alice.api_hash).toBe('old-hash');
  });

  it('skips existing templates by name and preserves original', () => {
    db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Tmpl', '@original');
    const r = runImport(db, PAYLOAD, 'merge');
    expect(r.templatesImported).toBe(0);
    const tmpl = db.prepare('SELECT * FROM job_templates WHERE name = ?').get('Tmpl') as any;
    expect(tmpl.bot_username).toBe('@original');
  });

  it('links job to the correct imported account via accountIndex', () => {
    runImport(db, PAYLOAD, 'merge');
    const alice = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    const job   = db.prepare('SELECT * FROM jobs WHERE name = ?').get('Job A') as any;
    expect(job.account_id).toBe(alice.id);
  });

  it('links job to the correct imported template via templateIndex', () => {
    runImport(db, PAYLOAD, 'merge');
    const tmpl = db.prepare('SELECT id FROM job_templates WHERE name = ?').get('Tmpl') as any;
    const job  = db.prepare('SELECT * FROM jobs WHERE name = ?').get('Job A') as any;
    expect(job.template_id).toBe(tmpl.id);
  });

  it('job with null accountIndex imports with null account_id', () => {
    runImport(db, PAYLOAD, 'merge');
    const job = db.prepare('SELECT * FROM jobs WHERE name = ?').get('Emby Job') as any;
    expect(job.account_id).toBeNull();
  });

  it('job config is preserved through import', () => {
    runImport(db, PAYLOAD, 'merge');
    const job = db.prepare('SELECT * FROM jobs WHERE name = ?').get('Emby Job') as any;
    expect(job.config).toBe('{"embyUrl":"http://emby:8096"}');
  });

  it('imports AI suppliers and models with correct relationship', () => {
    const r = runImport(db, PAYLOAD, 'merge');
    expect(r.aiSuppliersImported).toBe(1);
    expect(r.aiModelsImported).toBe(1);
    const model = db.prepare('SELECT m.*, s.name AS sname FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id').get() as any;
    expect(model.model_id).toBe('gpt-4');
    expect(model.sname).toBe('OpenRouter');
  });

  it('skips AI supplier that already exists by name', () => {
    db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OpenRouter', 'https://existing.api', 'sk-existing', 20000);
    const r = runImport(db, PAYLOAD, 'merge');
    expect(r.aiSuppliersImported).toBe(0);
    const s = db.prepare('SELECT * FROM ai_suppliers WHERE name = ?').get('OpenRouter') as any;
    expect(s.api_key).toBe('sk-existing');
  });

  it('imports settings from the payload', () => {
    runImport(db, PAYLOAD, 'merge');
    const tz = db.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any;
    expect(tz.value).toBe('America/New_York');
  });

  it('forceReauth=true clears session strings and resets auth_status', () => {
    runImport(db, PAYLOAD, 'merge', true);
    const alice = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(alice.session_string).toBeNull();
    expect(alice.auth_status).toBe('unauthenticated');
  });

  it('forceReauth=false preserves session strings and auth_status', () => {
    runImport(db, PAYLOAD, 'merge', false);
    const alice = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(alice.session_string).toBe('sess-a');
    expect(alice.auth_status).toBe('authenticated');
  });
});

// ── Full-database import -- replace mode ─────────────────────────────────────

describe('full data import -- replace mode', () => {
  let db: DB;

  const INCOMING: ExportPayload = {
    version: '1', exportedAt: '2024-01-01T00:00:00.000Z',
    accounts:    [{ name: 'New', phoneNumber: '+61411111111', apiId: 1, apiHash: 'h', sessionString: null, authStatus: 'unauthenticated' }],
    templates:   [{ name: 'New Tmpl', jobType: 'checkin', botUsername: '@new', timezone: 'Australia/Sydney', replyTimeoutMs: 40000, retryMax: 5, config: null, startCommand: '/start', checkinButton: '签到' }],
    jobs:        [{ accountIndex: 0, templateIndex: 0, name: 'New Job', jobType: 'checkin', botUsername: '@new', scheduleWindowStart: 1400, scheduleWindowEnd: 1600, timezone: 'Australia/Sydney', replyTimeoutMs: 40000, retryMax: 5, enabled: true, config: null, startCommand: '/start', checkinButton: '签到' }],
    aiSuppliers: [{ name: 'New Supplier', baseUrl: 'https://new.api/v1', apiKey: 'sk-new', timeoutMs: 25000 }],
    aiModels:    [{ supplierIndex: 0, modelId: 'new-model', label: null }],
    settings:    {},
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    // Seed data that replace mode must clear
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Old Account', '+61499999999', 1, 'old');
    db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Old Tmpl', '@old');
    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('Old Supplier', 'https://old.api', 'sk-old', 20000).lastInsertRowid;
    db.prepare('INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)').run(suppId, 'old-model');
  });

  it('removes all existing accounts before import', () => {
    runImport(db, INCOMING, 'replace');
    const rows = db.prepare('SELECT * FROM tg_accounts').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].phone_number).toBe('+61411111111');
  });

  it('removes all existing templates before import', () => {
    runImport(db, INCOMING, 'replace');
    const rows = db.prepare('SELECT * FROM job_templates').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('New Tmpl');
  });

  it('removes all existing AI suppliers and models before import', () => {
    runImport(db, INCOMING, 'replace');
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_suppliers').get() as any).n).toBe(1);
    const s = db.prepare('SELECT * FROM ai_suppliers').get() as any;
    expect(s.name).toBe('New Supplier');
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_models').get() as any).n).toBe(1);
  });

  it('incoming jobs link to correctly re-inserted accounts in replace mode', () => {
    runImport(db, INCOMING, 'replace');
    const account = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61411111111') as any;
    const job     = db.prepare('SELECT * FROM jobs WHERE name = ?').get('New Job') as any;
    expect(job.account_id).toBe(account.id);
  });
});

// ── Account-only export ───────────────────────────────────────────────────────

// Passkeys now live in the dedicated tg_accounts.passkey column; the legacy settings
// key is only recognised (and skipped) for backward compat on import.
const LEGACY_PASSKEY_STORE_KEY = 'tg_passkey_secrets';

// The persisted passkey form -- no accountId (it is the row id).
const makePasskey = (id: string) => ({
  telegramPasskeyId: id, credentialId: `cred-${id}`,
  privateKeyPem: `-----BEGIN PRIVATE KEY-----${id}-----END PRIVATE KEY-----`,
  rpId: 'telegram.org', userHandle: `handle-${id}`, createdDate: 1_700_000_000,
  dcId: 2, serverAddress: '149.154.167.51', port: 443,
});

function savePasskey(db: DB, accountId: number, stored: any) {
  db.prepare('UPDATE tg_accounts SET passkey = ? WHERE id = ?').run(JSON.stringify(stored), accountId);
}
function getPasskey(db: DB, accountId: number): any | null {
  const r = db.prepare('SELECT passkey FROM tg_accounts WHERE id = ?').get(accountId) as { passkey: string | null } | undefined;
  return r?.passkey ? JSON.parse(r.passkey) : null;
}
function getAttrs(db: DB, accountId: number): Record<string, unknown> {
  const r = db.prepare('SELECT additional_attributes FROM tg_accounts WHERE id = ?').get(accountId) as { additional_attributes: string | null } | undefined;
  return r?.additional_attributes ? JSON.parse(r.additional_attributes) : {};
}
// Mirrors passkeyStore.importedPasskeyFor (tolerates the interim `passkeys` array shape).
function importedPasskey(a: any): any | null {
  const raw = a?.passkey && typeof a.passkey === 'object' ? a.passkey
    : Array.isArray(a?.passkeys) ? (a.passkeys.find((p: any) => p?.dcId != null) ?? a.passkeys[0]) : null;
  if (!raw || typeof raw !== 'object') return null;
  const { accountId: _omit, ...stored } = raw;
  return stored;
}
// Mirrors accountAttributes.foldImportedAttributes + writeAttributes.
function restoreAttrs(db: DB, accountId: number, a: any) {
  const bag = a?.additionalAttributes;
  if (bag && typeof bag === 'object' && Object.keys(bag).length) {
    db.prepare('UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?').run(JSON.stringify(bag), accountId);
  }
}

// Mirrors the POST /accounts/export route logic
function exportAccounts(db: DB, ids?: number[]) {
  let rows: any[];
  if (ids?.length) {
    rows = db.prepare(`SELECT * FROM tg_accounts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as any[];
  } else {
    rows = db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as any[];
  }
  return {
    version: '1' as const,
    exportedAt: new Date().toISOString(),
    accounts: rows.map(a => ({
      name: a.name, phoneNumber: a.phone_number, apiId: a.api_id, apiHash: a.api_hash,
      sessionString: a.session_string, authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null, appClientId: a.app_client_id ?? null, disabled: Boolean(a.disabled),
      passkey: getPasskey(db, a.id),
      additionalAttributes: getAttrs(db, a.id),
    })),
  };
}

// Mirrors the POST /accounts/import route logic
function importAccounts(db: DB, items: any[], forceReauth = true) {
  let imported = 0, skipped = 0;
  for (const a of items) {
    if (!a.phoneNumber || !a.apiId || !a.apiHash) { skipped++; continue; }
    const existing = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber) as { id: number } | undefined;
    if (existing) { skipped++; continue; }
    const info = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, app_client_id, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.name || a.phoneNumber, a.phoneNumber, Number(a.apiId), a.apiHash, forceReauth ? null : (a.sessionString ?? null), forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'), a.proxyId ?? null, a.appClientId ?? null, a.disabled ? 1 : 0);
    const newId = Number(info.lastInsertRowid);
    const pk = importedPasskey(a);
    if (pk) savePasskey(db, newId, pk);
    restoreAttrs(db, newId, a);
    imported++;
  }
  return { imported, skipped };
}

describe('account-only export', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, app_client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('Alice', '+61400000001', 1, 'secret-hash', 'my-session', 'authenticated', 'proxy-1', 'preset-ios');
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Bob', '+61400000002', 2, 'bob-hash');
  });

  it('includes apiHash and sessionString in export', () => {
    const result = exportAccounts(db);
    expect(result.accounts[0].apiHash).toBe('secret-hash');
    expect(result.accounts[0].sessionString).toBe('my-session');
  });

  it('includes proxyId and appClientId', () => {
    expect(exportAccounts(db).accounts[0].proxyId).toBe('proxy-1');
    expect(exportAccounts(db).accounts[0].appClientId).toBe('preset-ios');
  });

  it('exports all accounts when no ids filter is provided', () => {
    expect(exportAccounts(db).accounts).toHaveLength(2);
  });

  it('filters to specific ids when provided', () => {
    const result = exportAccounts(db, [1]);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].phoneNumber).toBe('+61400000001');
  });

  it('export can be encrypted and round-tripped', () => {
    const json     = JSON.stringify(exportAccounts(db));
    const envelope = encryptPayload(json, 'accounts-secret');
    const restored = JSON.parse(decryptPayload(envelope, 'accounts-secret'));
    expect(restored.accounts[0].apiHash).toBe('secret-hash');
  });
});

describe('account-only import', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('imports valid accounts', () => {
    const r = importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', sessionString: 'sess', authStatus: 'authenticated' }]);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('skips duplicates by phone number and does not modify the original', () => {
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Original', '+61400000001', 99, 'original-hash');
    const r = importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'new-hash' }]);
    expect(r.skipped).toBe(1);
    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.name).toBe('Original');
    expect(row.api_hash).toBe('original-hash');
  });

  it('skips entries missing required fields', () => {
    const r = importAccounts(db, [
      { phoneNumber: '+61400000001' },                  // missing apiId, apiHash
      { apiId: 1, apiHash: 'h' },                       // missing phoneNumber
    ]);
    expect(r.skipped).toBe(2);
    expect(r.imported).toBe(0);
  });

  it('uses phone number as name when name is absent', () => {
    importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'h' }]);
    const row = db.prepare('SELECT name FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.name).toBe('+61400000001');
  });

  it('forceReauth=false preserves session string and auth_status', () => {
    importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', sessionString: 'mysess', authStatus: 'authenticated' }], false);
    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.session_string).toBe('mysess');
    expect(row.auth_status).toBe('authenticated');
  });

  it('forceReauth=true (default) resets session and marks unauthenticated', () => {
    importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', sessionString: 'mysess', authStatus: 'authenticated' }], true);
    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.session_string).toBeNull();
    expect(row.auth_status).toBe('unauthenticated');
  });

  it('preserves disabled flag when forceReauth=false', () => {
    importAccounts(db, [{ phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', disabled: true }], false);
    const row = db.prepare('SELECT disabled FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.disabled).toBe(1);
  });
});

describe('account-only export/import -- passkey & attributes', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('includes the account passkey in the export', () => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    savePasskey(db, Number(id), makePasskey('pk1'));
    const exported = exportAccounts(db);
    expect(exported.accounts[0].passkey.privateKeyPem).toContain('pk1');
    expect(exported.accounts[0].passkey.dcId).toBe(2);
  });

  it('restores the passkey onto the new account row on import', () => {
    const src = new Database(':memory:');
    src.exec(SCHEMA);
    const { lastInsertRowid: srcId } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    savePasskey(src, Number(srcId), makePasskey('pk1'));
    const exported = exportAccounts(src);

    // Pre-seed the target DB so the imported account gets a different id
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Filler', '+61999999999', 9, 'x');
    importAccounts(db, exported.accounts);

    const newAcct = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(newAcct.id).not.toBe(Number(srcId));
    const restored = getPasskey(db, newAcct.id);
    expect(restored.telegramPasskeyId).toBe('pk1');
    expect(restored.privateKeyPem).toContain('pk1');
    expect(restored.accountId).toBeUndefined(); // stored form omits accountId
  });

  it('round-trips the additional_attributes bag', () => {
    const src = new Database(':memory:');
    src.exec(SCHEMA);
    const { lastInsertRowid: id } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h');
    src.prepare('UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?').run(JSON.stringify({ hasPasskey: true, restriction: 'none' }), id);

    importAccounts(db, exportAccounts(src).accounts);
    const row = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(getAttrs(db, row.id)).toEqual({ hasPasskey: true, restriction: 'none' });
  });

  it('keeps the passkey even when forceReauth clears the session', () => {
    const src = new Database(':memory:');
    src.exec(SCHEMA);
    const { lastInsertRowid: srcId } = src.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status) VALUES (?, ?, ?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h', 'sess', 'authenticated');
    savePasskey(src, Number(srcId), makePasskey('pk1'));

    importAccounts(db, exportAccounts(src).accounts, true); // forceReauth
    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.session_string).toBeNull();                  // session dropped
    expect(getPasskey(db, row.id)?.telegramPasskeyId).toBe('pk1'); // passkey survives
  });

  // Backward compatibility: an export produced by an older Bemby has no passkey field
  // on its accounts. Import must still succeed and simply store none.
  it('imports an older export that has no passkey field', () => {
    const legacyAccount = { phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', sessionString: 'sess', authStatus: 'authenticated' };
    expect('passkey' in legacyAccount).toBe(false);
    const r = importAccounts(db, [legacyAccount]);
    expect(r.imported).toBe(1);
    const row = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(getPasskey(db, row.id)).toBeNull();
  });

  // Interim builds (this session) briefly exported a `passkeys` array; still importable.
  it('imports the interim passkeys-array shape', () => {
    const item = { phoneNumber: '+61400000001', apiId: 1, apiHash: 'h', passkeys: [{ accountId: 7, ...makePasskey('arr') }] };
    importAccounts(db, [item]);
    const row = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(getPasskey(db, row.id)?.telegramPasskeyId).toBe('arr');
  });
});
