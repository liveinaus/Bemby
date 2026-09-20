import { db } from '../db/database';
import { bumpTokenEpoch } from '../middleware/auth';

/**
 * ADMIN_PASSWORD_RESET: the way back in for an operator who has forgotten the panel password.
 *
 * Once a password has been set through the panel, the hash in `settings` is what login checks
 * and ADMIN_PASSWORD is ignored, so changing the env var alone does nothing. Setting
 * ADMIN_PASSWORD_RESET=1 and restarting drops the stored username and password hash, which
 * puts login back on ADMIN_USERNAME / ADMIN_PASSWORD, and retires every session token so
 * whoever held the old password is signed out too. Nothing else in the database is touched.
 *
 * It applies once. The flag will still be set on the next restart -- nobody remembers to
 * take it out straight away -- and if it applied every boot, the password the operator set
 * in the panel after getting back in would silently revert on each restart. So the value
 * that was applied is recorded, and the flag is skipped while it still reads the same. It
 * is forgotten again once the flag is removed, so setting it a second time, months later,
 * works the same as the first.
 */
export const ADMIN_PASSWORD_RESET_APPLIED_KEY = 'admin_password_reset_applied';

const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

export type AdminPasswordResetOutcome = 'applied' | 'already-applied' | 'off';

export function applyAdminPasswordResetFlag(
  env: NodeJS.ProcessEnv = process.env,
): AdminPasswordResetOutcome {
  const raw = (env.ADMIN_PASSWORD_RESET ?? '').trim();
  const flagOn = !OFF_VALUES.has(raw.toLowerCase());

  const applied = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(ADMIN_PASSWORD_RESET_APPLIED_KEY) as { value: string } | undefined;

  if (!flagOn) {
    if (applied) db.prepare('DELETE FROM settings WHERE key = ?').run(ADMIN_PASSWORD_RESET_APPLIED_KEY);
    return 'off';
  }

  if (applied?.value === raw) {
    console.warn(
      '[auth] ADMIN_PASSWORD_RESET is still set but was already applied on an earlier start; ' +
        'ignoring it. Remove it from the environment.',
    );
    return 'already-applied';
  }

  db.transaction(() => {
    db.prepare("DELETE FROM settings WHERE key IN ('admin_username', 'admin_password_hash')").run();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      ADMIN_PASSWORD_RESET_APPLIED_KEY,
      raw,
    );
    bumpTokenEpoch();
  })();

  const username = env.ADMIN_USERNAME ?? 'admin';
  if (!env.ADMIN_PASSWORD) {
    // Login has nothing to fall back to now; say so here rather than as a 500 on the form
    console.error('[auth] ADMIN_PASSWORD_RESET applied but ADMIN_PASSWORD is not set: set it, or nobody can log in.');
  }
  console.warn(
    `[auth] ADMIN_PASSWORD_RESET applied: admin credentials reset to ADMIN_USERNAME / ADMIN_PASSWORD ` +
      `(username "${username}"), all sessions signed out. Log in, set a new password in Settings, ` +
      `then remove ADMIN_PASSWORD_RESET from the environment.`,
  );
  return 'applied';
}
