// ADMIN_PASSWORD_RESET: the boot-time flag that puts login back on ADMIN_USERNAME /
// ADMIN_PASSWORD when the panel password has been forgotten. Covers what it removes, what it
// leaves alone, that it applies once per setting of the flag, and that it signs everyone out.

import Database from 'better-sqlite3';

let testDb!: InstanceType<typeof Database>;

vi.mock('../db/database', () => ({ get db() { return testDb; } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAdminPasswordResetFlag, ADMIN_PASSWORD_RESET_APPLIED_KEY } from '../auth/adminReset';
import { getTokenEpoch } from '../middleware/auth';
import { getStoredCredentials } from '../auth/credentials';

function setting(key: string): string | undefined {
  return (testDb.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function put(key: string, value: string) {
  testDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  put('admin_username', 'ops');
  put('admin_password_hash', '$argon2id$v=19$m=65536,t=3,p=4$fake');
  put('default_timezone', 'Australia/Sydney');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('applyAdminPasswordResetFlag', () => {
  it('does nothing when the flag is absent or off', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', ' 0 ']) {
      expect(applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: v, ADMIN_PASSWORD: 'x' })).toBe('off');
    }
    expect(setting('admin_password_hash')).toBeDefined();
    expect(setting('admin_username')).toBe('ops');
  });

  it('drops the stored credentials so login falls back to the env pair, and nothing else', () => {
    const out = applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw' });
    expect(out).toBe('applied');
    expect(setting('admin_password_hash')).toBeUndefined();
    expect(setting('admin_username')).toBeUndefined();
    expect(setting('default_timezone')).toBe('Australia/Sydney');
    // With the row gone, credentials come from the environment
    process.env.ADMIN_USERNAME = 'admin';
    expect(getStoredCredentials()).toEqual({ username: 'admin', passwordHash: null });
    delete process.env.ADMIN_USERNAME;
  });

  it('signs every existing session out', () => {
    expect(getTokenEpoch()).toBe(0);
    applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1', ADMIN_PASSWORD: 'pw' });
    expect(getTokenEpoch()).toBeGreaterThan(0);
  });

  it('applies once: a restart with the flag still set leaves the new password alone', () => {
    const env = { ADMIN_PASSWORD_RESET: '1', ADMIN_PASSWORD: 'pw' };
    expect(applyAdminPasswordResetFlag(env)).toBe('applied');
    expect(setting(ADMIN_PASSWORD_RESET_APPLIED_KEY)).toBe('1');

    // The operator logs in and sets a new password in the panel
    put('admin_password_hash', '$argon2id$new');
    const epoch = getTokenEpoch();

    expect(applyAdminPasswordResetFlag(env)).toBe('already-applied');
    expect(setting('admin_password_hash')).toBe('$argon2id$new');
    expect(getTokenEpoch()).toBe(epoch);
  });

  it('is armed again once the flag has been removed', () => {
    applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1', ADMIN_PASSWORD: 'pw' });
    put('admin_password_hash', '$argon2id$new');

    expect(applyAdminPasswordResetFlag({ ADMIN_PASSWORD: 'pw' })).toBe('off');
    expect(setting(ADMIN_PASSWORD_RESET_APPLIED_KEY)).toBeUndefined();
    expect(setting('admin_password_hash')).toBe('$argon2id$new');

    expect(applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1', ADMIN_PASSWORD: 'pw' })).toBe('applied');
    expect(setting('admin_password_hash')).toBeUndefined();
  });

  it('a different value applies even while the previous one is still recorded', () => {
    applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1', ADMIN_PASSWORD: 'pw' });
    put('admin_password_hash', '$argon2id$new');
    expect(applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '2', ADMIN_PASSWORD: 'pw' })).toBe('applied');
    expect(setting('admin_password_hash')).toBeUndefined();
  });

  it('warns when ADMIN_PASSWORD is not set, since login then has nothing to check against', () => {
    applyAdminPasswordResetFlag({ ADMIN_PASSWORD_RESET: '1' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ADMIN_PASSWORD is not set'));
  });
});
