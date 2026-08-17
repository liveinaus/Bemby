import { Api, TelegramClient } from "telegram";

// Writing an account's privacy settings, one key at a time. The caller picks a level per key --
// nobody, my contacts or everyone -- the same three Telegram itself offers, so a run that hid the
// avatar can be undone by the same screen later. Every setting is one `account.SetPrivacy` call, so
// the work is a list rather than any logic -- the interesting part is that Telegram refuses
// "nobody" on a few of the keys, and that the list grows with the API, so an unknown key must not
// fail the account.

/** The three levels Telegram offers per key. */
export type PrivacyLevel = "nobody" | "contacts" | "everybody";

/** How a key ended up, once Telegram had its say. */
export type PrivacyOutcome = PrivacyLevel | "unsupported" | "failed";

export type PrivacyResult = {
  /** Key name (as the API spells it, minus the prefix) to what it ended up as. */
  settings: Record<string, PrivacyOutcome>;
  /** How many keys ended up hidden from everyone. */
  nobody: number;
  /** Keys that ended up at contacts, whether asked for or because Telegram allows no narrower. */
  contacts: string[];
  /** Keys opened to everyone. */
  everybody: string[];
  /** Keys this account or this library could not set, with why. */
  skipped: { key: string; reason: string }[];
};

/**
 * A key that can be written, and whether Telegram will take "nobody" for it.
 *
 * `addedByPhone` ("who can find me by my number") has no "nobody" on Telegram's side -- the
 * narrowest it goes is contacts -- and `chatInvite` behaves the same way on current layers, so
 * both start at contacts rather than spending a rejected call to find out.
 */
type PrivacyTarget = { key: string; ctor: string; narrowest: "nobody" | "contacts" };

const TARGETS: PrivacyTarget[] = [
  { key: "phoneNumber", ctor: "InputPrivacyKeyPhoneNumber", narrowest: "nobody" },
  { key: "addedByPhone", ctor: "InputPrivacyKeyAddedByPhone", narrowest: "contacts" },
  { key: "lastSeen", ctor: "InputPrivacyKeyStatusTimestamp", narrowest: "nobody" },
  { key: "profilePhoto", ctor: "InputPrivacyKeyProfilePhoto", narrowest: "nobody" },
  { key: "about", ctor: "InputPrivacyKeyAbout", narrowest: "nobody" },
  { key: "birthday", ctor: "InputPrivacyKeyBirthday", narrowest: "nobody" },
  { key: "forwards", ctor: "InputPrivacyKeyForwards", narrowest: "nobody" },
  { key: "calls", ctor: "InputPrivacyKeyPhoneCall", narrowest: "nobody" },
  { key: "callsP2P", ctor: "InputPrivacyKeyPhoneP2P", narrowest: "nobody" },
  // Who can send me voice messages is Premium-only, so it is left out rather than attempted
  // and reported as unavailable on every ordinary account
  { key: "giftsAutoSave", ctor: "InputPrivacyKeyStarGiftsAutoSave", narrowest: "nobody" },
  { key: "chatInvite", ctor: "InputPrivacyKeyChatInvite", narrowest: "contacts" },
];

/** Every key this build can write, in the order it writes them. */
export const PRIVACY_KEYS: readonly string[] = TARGETS.map((t) => t.key);

/** Keys Telegram will not take "nobody" for, so contacts is the narrowest they offer. */
export const PRIVACY_CONTACTS_ONLY: readonly string[] = TARGETS.filter(
  (t) => t.narrowest === "contacts",
).map((t) => t.key);

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return value === "nobody" || value === "contacts" || value === "everybody";
}

/**
 * The level wanted for each key. A key left out of the map is not touched at all, so a caller can
 * write one setting without having an opinion on the rest.
 */
export type PrivacySelection = Record<string, PrivacyLevel>;

/** Every key as narrow as it goes -- the old "lock it all down" default. */
export function allNarrowest(): PrivacySelection {
  return Object.fromEntries(PRIVACY_KEYS.map((key) => [key, "nobody"]));
}

/** Errors that say "this account cannot have that", not "the call was wrong". */
const UNSUPPORTED = [
  "PREMIUM_ACCOUNT_REQUIRED",
  "PRIVACY_KEY_INVALID",
  "PRIVACY_VALUE_INVALID",
  "PRIVACY_TOO_LONG",
];

function ruleFor(level: PrivacyLevel): Api.TypeInputPrivacyRule[] {
  if (level === "everybody") return [new Api.InputPrivacyValueAllowAll()];
  return level === "nobody"
    ? [new Api.InputPrivacyValueDisallowAll()]
    : [
        new Api.InputPrivacyValueAllowContacts(),
        new Api.InputPrivacyValueDisallowAll(),
      ];
}

/**
 * The levels to try for a requested one, narrowest first. "Nobody" on a key Telegram has no
 * "nobody" for goes straight to contacts, and falls back to contacts if the server refuses it
 * anyway, rather than leaving the setting as it was. The other two levels have no fallback: asking
 * for contacts and getting everyone would be the opposite of what was asked.
 */
function levelsFor(wanted: PrivacyLevel, target: PrivacyTarget): PrivacyLevel[] {
  if (wanted !== "nobody") return [wanted];
  return target.narrowest === "nobody" ? ["nobody", "contacts"] : ["contacts"];
}

/**
 * Writes each selected key at the level asked for. A key the API refuses outright is recorded and
 * passed over -- one setting this account cannot have is not a reason to leave the rest unwritten.
 *
 * Rejections are read from the error rather than guessed at in advance, since which keys take
 * "nobody" is a server-side matter that moves between layers.
 */
export async function applyPrivacy(
  client: TelegramClient,
  selection: PrivacySelection,
): Promise<PrivacyResult> {
  const result: PrivacyResult = {
    settings: {},
    nobody: 0,
    contacts: [],
    everybody: [],
    skipped: [],
  };

  for (const target of TARGETS) {
    const wanted = selection[target.key];
    // Not mentioned: leave whatever the account already has
    if (!isPrivacyLevel(wanted)) continue;

    const Ctor = (Api as unknown as Record<string, unknown>)[target.ctor];
    if (typeof Ctor !== "function") {
      // A key this library does not carry: nothing to send, and not this account's fault
      result.settings[target.key] = "unsupported";
      result.skipped.push({ key: target.key, reason: "not in this API layer" });
      continue;
    }
    const key = new (Ctor as new () => Api.TypeInputPrivacyKey)();

    let lastError = "";
    let done = false;

    for (const level of levelsFor(wanted, target)) {
      try {
        await client.invoke(new Api.account.SetPrivacy({ key, rules: ruleFor(level) }));
        result.settings[target.key] = level;
        if (level === "nobody") result.nobody++;
        else if (level === "contacts") result.contacts.push(target.key);
        else result.everybody.push(target.key);
        done = true;
        break;
      } catch (err: any) {
        lastError = err?.errorMessage ?? err?.message ?? String(err);
        if (!UNSUPPORTED.some((code) => lastError.includes(code))) throw err;
      }
    }

    if (!done) {
      result.settings[target.key] = "unsupported";
      result.skipped.push({ key: target.key, reason: lastError });
    }
  }

  return result;
}

/** Shuts every key this build knows about as far as Telegram allows. */
export function hardenPrivacy(client: TelegramClient): Promise<PrivacyResult> {
  return applyPrivacy(client, allNarrowest());
}

/** One line for the task list: what went where, and what would not budge. */
export function describePrivacyResult(result: PrivacyResult): string {
  const parts: string[] = [];
  if (result.nobody) parts.push(`${result.nobody} hidden from everyone`);
  if (result.contacts.length) parts.push(`${result.contacts.join(", ")} set to contacts`);
  if (result.everybody.length) {
    parts.push(`${result.everybody.join(", ")} open to everyone`);
  }
  if (result.skipped.length) {
    parts.push(`${result.skipped.map((s) => s.key).join(", ")} not available`);
  }
  return parts.length ? parts.join("; ") : "nothing to change";
}
