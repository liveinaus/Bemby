// Usernames are the one profile field that is globally unique, so a batch cannot simply be
// applied the way names and bios are: two accounts asking for the same handle means the
// second is refused by Telegram, not silently overwritten. Handles themselves are built in
// the browser, where the preview has to show the very strings that will be sent; this side
// only judges what arrives.

export const USERNAME_LIMITS = { min: 5, max: 32 } as const;

// Telegram's own rule: starts with a letter, then letters, digits and underscores.
// It is the authority on the rest (reserved words, purchasable handles), so this only
// catches what is wrong before a round trip is spent on it.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

/** Strips a leading @ and surrounding space; does not judge what is left. */
export function normaliseUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

/**
 * The reason a username is unacceptable, or null when it looks fine. Worded for an operator
 * looking at one bad row among many, so each case says which rule it broke.
 */
export function usernameError(raw: string): string | null {
  const name = normaliseUsername(raw);
  if (!name) return "Username is empty";
  if (name.length < USERNAME_LIMITS.min) {
    return `Username must be at least ${USERNAME_LIMITS.min} characters`;
  }
  if (name.length > USERNAME_LIMITS.max) {
    return `Username must be at most ${USERNAME_LIMITS.max} characters`;
  }
  if (!/^[a-zA-Z]/.test(name)) return "Username must start with a letter";
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return "Username may only contain letters, digits and underscores";
  }
  return USERNAME_RE.test(name) ? null : "Username is not in a form Telegram accepts";
}

export function isValidUsername(raw: string): boolean {
  return usernameError(raw) === null;
}
