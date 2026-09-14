import { db } from "./database";

// Loose per-account metadata bag stored as JSON in tg_accounts.additional_attributes.
// Holds UI-safe flags such as email or restriction status. The passkey secret lives in
// its own tg_accounts.passkey column (see tg/passkeyStore.ts), never in this bag.
export type AccountAttributes = Record<string, unknown>;

// Legacy settings key where passkeys lived before they moved onto the account row.
// Retained so old backups can still be recognised (and skipped) on import.
export const LEGACY_PASSKEY_STORE_KEY = "tg_passkey_secrets";

export function parseAttributes(
  raw: string | null | undefined,
): AccountAttributes {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as AccountAttributes) : {};
  } catch {
    return {};
  }
}

export function getAttributes(accountId: number): AccountAttributes {
  const row = db
    .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { additional_attributes: string | null } | undefined;
  return parseAttributes(row?.additional_attributes);
}

export function writeAttributes(
  accountId: number,
  attrs: AccountAttributes,
): void {
  const empty = !attrs || Object.keys(attrs).length === 0;
  db.prepare(
    "UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?",
  ).run(empty ? null : JSON.stringify(attrs), accountId);
}

// Merge a partial patch into the bag; a key set to undefined is removed.
export function patchAttributes(
  accountId: number,
  patch: AccountAttributes,
): void {
  const next = { ...getAttributes(accountId) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  writeAttributes(accountId, next);
}

// The bag as safe to expose to the UI. Defence in depth: strips a `passkey` key in case
// a legacy row still has the secret embedded (it belongs in the dedicated passkey column).
export function publicAttributes(attrs: AccountAttributes): AccountAttributes {
  // importedTwoFa holds the (encrypted) 2FA of a card-imported account -- kept for the
  // take-ownership step, never sent to the client.
  const { passkey: _passkey, importedTwoFa: _twoFa, ...rest } = attrs;
  return rest;
}

// The attributes bag to store for an imported account (null when absent/empty).
export function foldImportedAttributes(item: any): AccountAttributes | null {
  const bag = item?.additionalAttributes;
  if (bag && typeof bag === "object" && Object.keys(bag).length) {
    return bag as AccountAttributes;
  }
  return null;
}
