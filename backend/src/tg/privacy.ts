import { Api, TelegramClient } from "telegram";

// Shutting an account's privacy settings down as far as Telegram allows. What a farmed account
// wants is to give nothing away: no number, no last seen, no photo, no bio, nobody able to add
// it to a group. Every setting is one `account.SetPrivacy` call, so the work is a list rather
// than any logic -- the interesting part is that Telegram refuses "nobody" on a few of the
// keys, and that the list grows with the API, so an unknown key must not fail the account.

/** How hidden a key ended up, once Telegram had its say. */
export type PrivacyOutcome = "nobody" | "contacts" | "unsupported" | "failed";

export type PrivacyResult = {
  /** Key name (as the API spells it, minus the prefix) to what it ended up as. */
  settings: Record<string, PrivacyOutcome>;
  /** How many keys ended up hidden from everyone. */
  nobody: number;
  /** Keys Telegram would only narrow to contacts, `addedByPhone` chief among them. */
  contacts: string[];
  /** Keys this account or this library could not set, with why. */
  skipped: { key: string; reason: string }[];
};

/**
 * A key to shut down, and whether Telegram will take "nobody" for it.
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

/** Errors that say "this account cannot have that", not "the call was wrong". */
const UNSUPPORTED = [
  "PREMIUM_ACCOUNT_REQUIRED",
  "PRIVACY_KEY_INVALID",
  "PRIVACY_VALUE_INVALID",
  "PRIVACY_TOO_LONG",
];

function ruleFor(level: "nobody" | "contacts"): Api.TypeInputPrivacyRule[] {
  return level === "nobody"
    ? [new Api.InputPrivacyValueDisallowAll()]
    : [
        new Api.InputPrivacyValueAllowContacts(),
        new Api.InputPrivacyValueDisallowAll(),
      ];
}

/**
 * Sets every privacy key as narrow as it will go: nobody where Telegram allows it, contacts
 * where it does not. A key the API refuses outright is recorded and passed over -- one setting
 * this account cannot have is not a reason to leave the rest of them open.
 *
 * Rejections are read from the error rather than guessed at in advance, since which keys take
 * "nobody" is a server-side matter that moves between layers.
 */
export async function hardenPrivacy(client: TelegramClient): Promise<PrivacyResult> {
  const result: PrivacyResult = { settings: {}, nobody: 0, contacts: [], skipped: [] };

  for (const target of TARGETS) {
    const Ctor = (Api as unknown as Record<string, unknown>)[target.ctor];
    if (typeof Ctor !== "function") {
      // A key this library does not carry: nothing to send, and not this account's fault
      result.settings[target.key] = "unsupported";
      result.skipped.push({ key: target.key, reason: "not in this API layer" });
      continue;
    }
    const key = new (Ctor as new () => Api.TypeInputPrivacyKey)();

    // "Nobody" first where it is allowed; a refusal drops to contacts rather than leaving the
    // setting as it was
    const levels: Array<"nobody" | "contacts"> =
      target.narrowest === "nobody" ? ["nobody", "contacts"] : ["contacts"];
    let lastError = "";
    let done = false;

    for (const level of levels) {
      try {
        await client.invoke(new Api.account.SetPrivacy({ key, rules: ruleFor(level) }));
        result.settings[target.key] = level;
        if (level === "nobody") result.nobody++;
        else result.contacts.push(target.key);
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

/** One line for the task list: what was hidden, and what would not go all the way. */
export function describePrivacyResult(result: PrivacyResult): string {
  const parts = [`${result.nobody} hidden from everyone`];
  if (result.contacts.length) parts.push(`${result.contacts.join(", ")} narrowed to contacts`);
  if (result.skipped.length) {
    parts.push(`${result.skipped.map((s) => s.key).join(", ")} not available`);
  }
  return parts.join("; ");
}
