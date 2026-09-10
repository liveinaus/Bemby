// General functionality tests: account CRUD, job CRUD, settings enforcement,
// and foreign-key cascade behaviour.
// All tests use an in-memory SQLite database with the live schema.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = InstanceType<typeof Database>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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
    tg_username     TEXT
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
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    retired               TEXT
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL DEFAULT 'success',
    message TEXT,
    detail  TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler',
    retired INTEGER NOT NULL DEFAULT 0,
    detail_bytes INTEGER
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
`;

const ALLOWED_SETTINGS = [
  'default_timezone', 'default_max_retry', 'check_daily_run', 'default_ua',
  'default_play_duration', 'default_device_name', 'ai_model', 'notify_tg_username',
  'notify_tg_events', 'ua_presets', 'proxies', 'tg_app_clients', 'tg_client_mode',
];

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function insertAccount(db: DB, overrides: Partial<{ name: string; phone: string; apiId: number; apiHash: string; session: string | null; authStatus: string; disabled: number }> = {}) {
  const { name = 'Test', phone = '+61400000001', apiId = 1, apiHash = 'hash', session = null, authStatus = 'unauthenticated', disabled = 0 } = overrides;
  return db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, disabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, phone, apiId, apiHash, session, authStatus, disabled).lastInsertRowid as number;
}

function insertJob(db: DB, accountId: number | null, name = 'Job', botUsername = '@bot') {
  return db.prepare('INSERT INTO jobs (name, account_id, bot_username) VALUES (?, ?, ?)').run(name, accountId, botUsername).lastInsertRowid as number;
}

// ── Account CRUD ──────────────────────────────────────────────────────────────

describe('account CRUD', () => {
  let db: DB;
  beforeEach(() => { db = createDb(); });

  it('creates an account with the correct fields', () => {
    insertAccount(db, { name: 'Alice', phone: '+61400000001', apiId: 12345, apiHash: 'myhash' });
    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.name).toBe('Alice');
    expect(row.api_id).toBe(12345);
    expect(row.api_hash).toBe('myhash');
    expect(row.auth_status).toBe('unauthenticated');
    expect(row.disabled).toBe(0);
  });

  it('reads back all accounts ordered by sort_order then id', () => {
    insertAccount(db, { name: 'Alice', phone: '+61400000001' });
    insertAccount(db, { name: 'Bob',   phone: '+61400000002' });
    db.prepare('UPDATE tg_accounts SET sort_order = ? WHERE phone_number = ?').run(1, '+61400000002');
    db.prepare('UPDATE tg_accounts SET sort_order = ? WHERE phone_number = ?').run(2, '+61400000001');
    const rows = db.prepare('SELECT * FROM tg_accounts ORDER BY sort_order, id').all() as any[];
    expect(rows[0].name).toBe('Bob');
    expect(rows[1].name).toBe('Alice');
  });

  it('updates account fields', () => {
    const id = insertAccount(db, { name: 'Alice', phone: '+61400000001' });
    db.prepare('UPDATE tg_accounts SET name = ?, proxy_id = ? WHERE id = ?').run('Alice Updated', 'proxy-1', id);
    const row = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(id) as any;
    expect(row.name).toBe('Alice Updated');
    expect(row.proxy_id).toBe('proxy-1');
  });

  it('deletes an account', () => {
    const id = insertAccount(db);
    db.prepare('DELETE FROM tg_accounts WHERE id = ?').run(id);
    expect(db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(id)).toBeUndefined();
  });

  it('sets account_id to NULL on linked jobs when account is deleted', () => {
    const accId = insertAccount(db);
    const jobId = insertJob(db, accId, 'Linked Job');
    db.prepare('DELETE FROM tg_accounts WHERE id = ?').run(accId);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.account_id).toBeNull();
  });

  it('disabled flag defaults to 0 (active)', () => {
    const id = insertAccount(db);
    const row = db.prepare('SELECT disabled FROM tg_accounts WHERE id = ?').get(id) as any;
    expect(row.disabled).toBe(0);
  });

  it('disabled flag can be toggled to 1', () => {
    const id = insertAccount(db);
    db.prepare('UPDATE tg_accounts SET disabled = 1 WHERE id = ?').run(id);
    expect((db.prepare('SELECT disabled FROM tg_accounts WHERE id = ?').get(id) as any).disabled).toBe(1);
  });

  it('sort_order can be bulk-updated', () => {
    const id1 = insertAccount(db, { name: 'Alice', phone: '+61400000001' });
    const id2 = insertAccount(db, { name: 'Bob',   phone: '+61400000002' });
    const update = db.prepare('UPDATE tg_accounts SET sort_order = ? WHERE id = ?');
    db.transaction(() => { update.run(10, id1); update.run(5, id2); })();
    const rows = db.prepare('SELECT id, sort_order FROM tg_accounts ORDER BY sort_order').all() as any[];
    expect(rows[0].id).toBe(id2);
    expect(rows[1].id).toBe(id1);
  });

  it('stores and retrieves tg_display_name and tg_username', () => {
    const id = insertAccount(db);
    db.prepare('UPDATE tg_accounts SET tg_display_name = ?, tg_username = ? WHERE id = ?').run('Alice Smith', 'alicesmith', id);
    const row = db.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(id) as any;
    expect(row.tg_display_name).toBe('Alice Smith');
    expect(row.tg_username).toBe('alicesmith');
  });
});

// ── Job CRUD ──────────────────────────────────────────────────────────────────

describe('job CRUD', () => {
  let db: DB;
  let accId: number;

  beforeEach(() => {
    db = createDb();
    accId = insertAccount(db, { name: 'Alice', phone: '+61400000001' });
  });

  it('creates a job linked to an account', () => {
    const jobId = insertJob(db, accId, 'Morning Checkin', '@farmbot');
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.name).toBe('Morning Checkin');
    expect(job.account_id).toBe(accId);
    expect(job.bot_username).toBe('@farmbot');
    expect(job.enabled).toBe(1);
  });

  it('creates a standalone job with null account_id', () => {
    const jobId = insertJob(db, null, 'Emby Watch');
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.account_id).toBeNull();
  });

  it('updates job fields', () => {
    const jobId = insertJob(db, accId);
    db.prepare('UPDATE jobs SET name = ?, enabled = ?, retry_max = ? WHERE id = ?').run('Renamed Job', 0, 10, jobId);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.name).toBe('Renamed Job');
    expect(job.enabled).toBe(0);
    expect(job.retry_max).toBe(10);
  });

  it('deletes a job and cascades to its logs', () => {
    const jobId = insertJob(db, accId);
    db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, '2024-01-01T10:00:00Z', 'success');
    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    expect(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_logs WHERE job_id = ?').get(jobId) as any).n).toBe(0);
  });

  it('stores and retrieves JSON config', () => {
    const config = JSON.stringify({ embyUrl: 'http://emby:8096', username: 'user1', password: 'pass1' });
    const jobId = db.prepare('INSERT INTO jobs (name, account_id, bot_username, config) VALUES (?, ?, ?, ?)').run('Emby', null, '', config).lastInsertRowid;
    const job = db.prepare('SELECT config FROM jobs WHERE id = ?').get(jobId) as any;
    expect(JSON.parse(job.config)).toMatchObject({ embyUrl: 'http://emby:8096', username: 'user1' });
  });

  it('run_every_days defaults to 1 and can be updated', () => {
    const jobId = insertJob(db, accId);
    expect((db.prepare('SELECT run_every_days FROM jobs WHERE id = ?').get(jobId) as any).run_every_days).toBe(1);
    db.prepare('UPDATE jobs SET run_every_days = 7 WHERE id = ?').run(jobId);
    expect((db.prepare('SELECT run_every_days FROM jobs WHERE id = ?').get(jobId) as any).run_every_days).toBe(7);
  });

  it('template_id is set to NULL when the template is deleted', () => {
    const tmplId = db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Tmpl', '@bot').lastInsertRowid;
    const jobId  = db.prepare('INSERT INTO jobs (name, account_id, bot_username, template_id) VALUES (?, ?, ?, ?)').run('Linked', accId, '@bot', tmplId).lastInsertRowid;
    db.prepare('DELETE FROM job_templates WHERE id = ?').run(tmplId);
    expect((db.prepare('SELECT template_id FROM jobs WHERE id = ?').get(jobId) as any).template_id).toBeNull();
  });
});

// ── Job logs ──────────────────────────────────────────────────────────────────

describe('job logs', () => {
  let db: DB;
  let jobId: number;

  beforeEach(() => {
    db = createDb();
    const accId = insertAccount(db);
    jobId = insertJob(db, accId);
  });

  it('creates a log entry with required fields', () => {
    db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, '2024-06-15T10:00:00Z', 'success');
    const log = db.prepare('SELECT * FROM job_logs').get() as any;
    expect(log.job_id).toBe(jobId);
    expect(log.status).toBe('success');
    expect(log.retired).toBe(0);
  });

  it('retired flag can be toggled', () => {
    const logId = db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, '2024-06-15T10:00:00Z', 'success').lastInsertRowid;
    db.prepare('UPDATE job_logs SET retired = 1 WHERE id = ?').run(logId);
    expect((db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(logId) as any).retired).toBe(1);
    db.prepare('UPDATE job_logs SET retired = 0 WHERE id = ?').run(logId);
    expect((db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(logId) as any).retired).toBe(0);
  });

  it('detail column stores JSON detail payload', () => {
    const detail = JSON.stringify({ attempt: 1, commandSent: '/start' });
    const logId  = db.prepare('INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (?, ?, ?, ?)').run(jobId, '2024-06-15T10:00:00Z', 'error', detail).lastInsertRowid;
    const log    = db.prepare('SELECT * FROM job_logs WHERE id = ?').get(logId) as any;
    expect(JSON.parse(log.detail)).toMatchObject({ attempt: 1, commandSent: '/start' });
  });

  it('source field defaults to "scheduler"', () => {
    db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, '2024-06-15T10:00:00Z', 'success');
    const log = db.prepare('SELECT source FROM job_logs').get() as any;
    expect(log.source).toBe('scheduler');
  });
});

// ── Settings enforcement ──────────────────────────────────────────────────────

describe('settings -- ALLOWED_KEYS whitelist enforcement', () => {
  let db: DB;

  beforeEach(() => {
    db = createDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('admin_password_hash', 'existing-hash');
  });

  // Mirrors the PUT /settings route logic: only updates keys in ALLOWED_KEYS
  function applySettingsUpdate(db: DB, updates: Record<string, string>) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const key of ALLOWED_SETTINGS) {
        if (key in updates) stmt.run(key, String(updates[key]));
      }
    })();
  }

  it('updates an allowed key', () => {
    applySettingsUpdate(db, { default_timezone: 'America/Chicago' });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any;
    expect(row.value).toBe('America/Chicago');
  });

  it('silently ignores a non-allowed key in the update payload', () => {
    applySettingsUpdate(db, { secret_key: 'steal-me', default_timezone: 'America/Chicago' });
    expect(db.prepare("SELECT * FROM settings WHERE key = 'secret_key'").get()).toBeUndefined();
    const tz = db.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any;
    expect(tz.value).toBe('America/Chicago');
  });

  it('cannot overwrite admin_password_hash via the settings route', () => {
    applySettingsUpdate(db, { admin_password_hash: 'hacked-hash' });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get() as any;
    expect(row.value).toBe('existing-hash');
  });

  it('cannot overwrite admin_username via the settings route', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('admin_username', 'admin');
    applySettingsUpdate(db, { admin_username: 'hacker' });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_username'").get() as any;
    expect(row.value).toBe('admin');
  });

  it('updates multiple allowed keys in one call', () => {
    applySettingsUpdate(db, { default_timezone: 'UTC', default_max_retry: '3', check_daily_run: 'false' });
    expect((db.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any).value).toBe('UTC');
    expect((db.prepare("SELECT value FROM settings WHERE key = 'default_max_retry'").get() as any).value).toBe('3');
    expect((db.prepare("SELECT value FROM settings WHERE key = 'check_daily_run'").get() as any).value).toBe('false');
  });

  it('can update proxies JSON', () => {
    const proxies = JSON.stringify([{ id: 'p1', url: 'socks5://user:pass@host:1080' }]);
    applySettingsUpdate(db, { proxies });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as any;
    expect(JSON.parse(row.value)).toHaveLength(1);
  });
});

// ── AI suppliers and models ───────────────────────────────────────────────────

describe('AI suppliers and models CRUD', () => {
  let db: DB;
  beforeEach(() => { db = createDb(); });

  it('creates a supplier', () => {
    db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-test', 25000);
    const s = db.prepare('SELECT * FROM ai_suppliers').get() as any;
    expect(s.name).toBe('OpenRouter');
    expect(s.api_key).toBe('sk-test');
  });

  it('creates a model linked to a supplier', () => {
    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OR', 'https://or.ai/v1', '', 25000).lastInsertRowid;
    db.prepare('INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)').run(suppId, 'gpt-4', 'GPT-4');
    const m = db.prepare('SELECT * FROM ai_models').get() as any;
    expect(m.model_id).toBe('gpt-4');
    expect(m.supplier_id).toBe(Number(suppId));
  });

  it('cascades model deletion when supplier is deleted', () => {
    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OR', 'https://or.ai/v1', '', 25000).lastInsertRowid;
    db.prepare('INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)').run(suppId, 'gpt-4');
    db.prepare('DELETE FROM ai_suppliers WHERE id = ?').run(suppId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_models').get() as any).n).toBe(0);
  });

  it('updates supplier API key', () => {
    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OR', 'https://or.ai/v1', 'old-key', 25000).lastInsertRowid;
    db.prepare('UPDATE ai_suppliers SET api_key = ? WHERE id = ?').run('new-key', suppId);
    expect((db.prepare('SELECT api_key FROM ai_suppliers WHERE id = ?').get(suppId) as any).api_key).toBe('new-key');
  });

  it('deletes a model without affecting the supplier', () => {
    const suppId = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('OR', 'https://or.ai/v1', '', 25000).lastInsertRowid;
    const modelId = db.prepare('INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)').run(suppId, 'gpt-4').lastInsertRowid;
    db.prepare('DELETE FROM ai_models WHERE id = ?').run(modelId);
    expect(db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(suppId)).toBeDefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_models').get() as any).n).toBe(0);
  });
});

// ── Job template CRUD ─────────────────────────────────────────────────────────

describe('job templates CRUD', () => {
  let db: DB;
  beforeEach(() => { db = createDb(); });

  it('creates a template with default values', () => {
    db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Daily Bot', '@dailybot');
    const tmpl = db.prepare('SELECT * FROM job_templates WHERE name = ?').get('Daily Bot') as any;
    expect(tmpl.job_type).toBe('checkin');
    expect(tmpl.timezone).toBe('Australia/Sydney');
    expect(tmpl.retry_max).toBe(5);
    expect(tmpl.run_every_days).toBe(1);
  });

  it('updates a template', () => {
    const id = db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Tmpl', '@old').lastInsertRowid;
    db.prepare('UPDATE job_templates SET bot_username = ?, retry_max = ? WHERE id = ?').run('@new', 10, id);
    const tmpl = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(id) as any;
    expect(tmpl.bot_username).toBe('@new');
    expect(tmpl.retry_max).toBe(10);
  });

  it('sets template_id to NULL on linked jobs when template is deleted', () => {
    const accId  = insertAccount(db);
    const tmplId = db.prepare('INSERT INTO job_templates (name, bot_username) VALUES (?, ?)').run('Tmpl', '@bot').lastInsertRowid;
    const jobId  = db.prepare('INSERT INTO jobs (name, account_id, bot_username, template_id) VALUES (?, ?, ?, ?)').run('Job', accId, '@bot', tmplId).lastInsertRowid;
    db.prepare('DELETE FROM job_templates WHERE id = ?').run(tmplId);
    expect((db.prepare('SELECT template_id FROM jobs WHERE id = ?').get(jobId) as any).template_id).toBeNull();
  });
});

// ── Proxy resolution ──────────────────────────────────────────────────────────

describe('proxy resolution from settings', () => {
  let db: DB;

  beforeEach(() => {
    db = createDb();
    const proxies = JSON.stringify([
      { id: 'proxy-1', url: 'socks5://user:pass@proxy1.example.com:1080' },
      { id: 'proxy-2', url: 'socks5://proxy2.example.com:1080' },
    ]);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('proxies', proxies);
  });

  // Mirrors resolveProxyUrl() in routes/accounts.ts
  function resolveProxy(db: DB, proxyId: string | null): string | undefined {
    if (!proxyId) return undefined;
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxies') as { value: string } | undefined;
      if (!row?.value) return undefined;
      const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
      return list.find(p => p.id === proxyId)?.url;
    } catch { return undefined; }
  }

  it('resolves a known proxy id to its URL', () => {
    expect(resolveProxy(db, 'proxy-1')).toBe('socks5://user:pass@proxy1.example.com:1080');
  });

  it('resolves the second proxy correctly', () => {
    expect(resolveProxy(db, 'proxy-2')).toBe('socks5://proxy2.example.com:1080');
  });

  it('returns undefined for an unknown proxy id', () => {
    expect(resolveProxy(db, 'proxy-unknown')).toBeUndefined();
  });

  it('returns undefined when proxyId is null', () => {
    expect(resolveProxy(db, null)).toBeUndefined();
  });
});

// ── TG app client resolution ──────────────────────────────────────────────────

describe('TG app client resolution from settings', () => {
  let db: DB;

  const CLIENTS = JSON.stringify([
    { id: 'preset-ios',   name: 'iOS',   deviceModel: 'iPhone 13 Pro Max', systemVersion: 'iOS 15.4.1',       appVersion: '8.4.2',  langCode: 'en', langPack: 'ios',      systemLangCode: 'en-US', isDefault: false },
    { id: 'preset-linux', name: 'Linux', deviceModel: 'PC 64bit',          systemVersion: 'Ubuntu 22.04 LTS', appVersion: '4.16.5', langCode: 'en', langPack: 'tdesktop', systemLangCode: 'en-US', isDefault: true  },
  ]);

  beforeEach(() => {
    db = createDb();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tg_app_clients', CLIENTS);
  });

  // Mirrors resolveAppClientParams() in routes/accounts.ts (default/random branch excluded)
  function resolveClient(db: DB, appClientId: string | null | undefined) {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('tg_app_clients') as { value: string } | undefined;
      if (!row?.value) return undefined;
      const list = JSON.parse(row.value) as any[];
      const client = appClientId ? list.find(c => c.id === appClientId) : list.find(c => c.isDefault);
      if (!client) return undefined;
      return { deviceModel: client.deviceModel, systemVersion: client.systemVersion, appVersion: client.appVersion, langCode: client.langCode, langPack: client.langPack, systemLangCode: client.systemLangCode };
    } catch { return undefined; }
  }

  it('resolves a specific client by id', () => {
    const params = resolveClient(db, 'preset-ios');
    expect(params?.deviceModel).toBe('iPhone 13 Pro Max');
    expect(params?.langPack).toBe('ios');
  });

  it('falls back to the default client when no id is specified', () => {
    const params = resolveClient(db, null);
    expect(params?.deviceModel).toBe('PC 64bit');
    expect(params?.langPack).toBe('tdesktop');
  });

  it('returns undefined for an unknown client id', () => {
    expect(resolveClient(db, 'preset-unknown')).toBeUndefined();
  });

  it('returns undefined when tg_app_clients setting is absent', () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run('tg_app_clients');
    expect(resolveClient(db, 'preset-ios')).toBeUndefined();
  });
});
