// Writing an account's privacy settings at the level asked for. Driven against a stand-in
// client, since what matters is not the transport but which rule each key is sent and what
// happens when the server refuses one: `addedByPhone` has no "nobody" at all, and a key this
// account cannot have must not take the rest down with it.

import { describe, expect, it } from "vitest";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { applyPrivacy, describePrivacyResult, hardenPrivacy } from "../tg/privacy";

type Sent = { key: string; rules: string[] };

/**
 * A client that records the privacy calls. `refuse` names the errors to answer a key with, at
 * the level asked for -- "any" for a key the account cannot set at all, which is how Telegram
 * answers a setting this account has no access to, whatever rule it is sent.
 */
function fakeClient(
  refuse: Record<
    string,
    { level: "nobody" | "contacts" | "everybody" | "any"; error: string }
  > = {},
) {
  const sent: Sent[] = [];
  const client = {
    invoke: async (req: any) => {
      const key = String(req.key?.className ?? "");
      const rules = (req.rules ?? []).map((r: any) => String(r.className));
      const level = rules.includes("InputPrivacyValueAllowAll")
        ? "everybody"
        : rules.includes("InputPrivacyValueAllowContacts")
          ? "contacts"
          : "nobody";
      const refusal = refuse[key];
      if (refusal && (refusal.level === "any" || refusal.level === level)) {
        const err: any = new Error(refusal.error);
        err.errorMessage = refusal.error;
        throw err;
      }
      sent.push({ key, rules });
      return new Api.account.PrivacyRules({
        rules: [],
        chats: [],
        users: [],
      });
    },
  };
  return { client: client as unknown as TelegramClient, sent };
}

const forKey = (sent: Sent[], key: string) => sent.find((s) => s.key === key);

describe("hardenPrivacy", () => {
  it("hides the phone number from everyone, contacts included", async () => {
    const { client, sent } = fakeClient();
    const result = await hardenPrivacy(client);

    expect(forKey(sent, "InputPrivacyKeyPhoneNumber")?.rules).toEqual([
      "InputPrivacyValueDisallowAll",
    ]);
    expect(result.settings.phoneNumber).toBe("nobody");
  });

  it("sets every key it knows about", async () => {
    const { client, sent } = fakeClient();
    const result = await hardenPrivacy(client);

    // One call per key, none left out
    expect(sent).toHaveLength(Object.keys(result.settings).length);
    expect(Object.values(result.settings).every((v) => v !== "failed")).toBe(true);
    for (const key of [
      "InputPrivacyKeyStatusTimestamp",
      "InputPrivacyKeyProfilePhoto",
      "InputPrivacyKeyAbout",
      "InputPrivacyKeyForwards",
      "InputPrivacyKeyPhoneCall",
      "InputPrivacyKeyBirthday",
      "InputPrivacyKeyChatInvite",
    ]) {
      expect(forKey(sent, key), key).toBeTruthy();
    }
  });

  it("asks contacts-only for the keys Telegram has no nobody for", async () => {
    const { client, sent } = fakeClient();
    const result = await hardenPrivacy(client);

    // Being found by number cannot be switched off, so contacts is the narrowest there is
    expect(forKey(sent, "InputPrivacyKeyAddedByPhone")?.rules).toEqual([
      "InputPrivacyValueAllowContacts",
      "InputPrivacyValueDisallowAll",
    ]);
    expect(result.settings.addedByPhone).toBe("contacts");
    expect(result.contacts).toContain("addedByPhone");
    // And it is not counted among what is hidden outright
    expect(result.nobody).toBe(
      Object.values(result.settings).filter((v) => v === "nobody").length,
    );
  });

  it("falls back to contacts when the server refuses nobody", async () => {
    const { client, sent } = fakeClient({
      InputPrivacyKeyStatusTimestamp: {
        level: "nobody",
        error: "PRIVACY_VALUE_INVALID",
      },
    });
    const result = await hardenPrivacy(client);

    expect(result.settings.lastSeen).toBe("contacts");
    expect(forKey(sent, "InputPrivacyKeyStatusTimestamp")?.rules).toEqual([
      "InputPrivacyValueAllowContacts",
      "InputPrivacyValueDisallowAll",
    ]);
  });

  it("skips a setting the account cannot have and still sets the rest", async () => {
    const { client, sent } = fakeClient({
      InputPrivacyKeyStarGiftsAutoSave: {
        level: "any",
        error: "PREMIUM_ACCOUNT_REQUIRED",
      },
    });
    const result = await hardenPrivacy(client);

    // Refused at both levels, so nothing was sent for it
    expect(forKey(sent, "InputPrivacyKeyStarGiftsAutoSave")).toBeUndefined();
    expect(result.settings.giftsAutoSave).toBe("unsupported");
    expect(result.skipped.map((s) => s.key)).toEqual(["giftsAutoSave"]);
    // The phone number, the point of the exercise, is still hidden
    expect(result.settings.phoneNumber).toBe("nobody");
  });

  it("lets an error that is not about the setting through", async () => {
    const { client } = fakeClient({
      InputPrivacyKeyPhoneNumber: {
        level: "nobody",
        error: "AUTH_KEY_UNREGISTERED",
      },
    });

    // A dead session must fail the account, not be recorded as an unsupported setting
    await expect(hardenPrivacy(client)).rejects.toThrow("AUTH_KEY_UNREGISTERED");
  });
});

describe("applyPrivacy", () => {
  it("writes each key at the level asked for", async () => {
    const { client, sent } = fakeClient();
    const result = await applyPrivacy(client, {
      phoneNumber: "nobody",
      profilePhoto: "everybody",
      lastSeen: "contacts",
    });

    expect(forKey(sent, "InputPrivacyKeyPhoneNumber")?.rules).toEqual([
      "InputPrivacyValueDisallowAll",
    ]);
    expect(forKey(sent, "InputPrivacyKeyProfilePhoto")?.rules).toEqual([
      "InputPrivacyValueAllowAll",
    ]);
    expect(forKey(sent, "InputPrivacyKeyStatusTimestamp")?.rules).toEqual([
      "InputPrivacyValueAllowContacts",
      "InputPrivacyValueDisallowAll",
    ]);
    expect(result.settings).toEqual({
      phoneNumber: "nobody",
      profilePhoto: "everybody",
      lastSeen: "contacts",
    });
    expect(result.nobody).toBe(1);
    expect(result.contacts).toEqual(["lastSeen"]);
    expect(result.everybody).toEqual(["profilePhoto"]);
  });

  it("leaves a key out of the selection untouched", async () => {
    const { client, sent } = fakeClient();
    const result = await applyPrivacy(client, { about: "everybody" });

    expect(sent).toHaveLength(1);
    expect(forKey(sent, "InputPrivacyKeyAbout")).toBeTruthy();
    expect(Object.keys(result.settings)).toEqual(["about"]);
  });

  it("hands a previously hidden setting back to everyone", async () => {
    // The point of the levels: an earlier run hid the avatar, this one puts it back
    const { client } = fakeClient();
    const hidden = await applyPrivacy(client, { profilePhoto: "nobody" });
    expect(hidden.settings.profilePhoto).toBe("nobody");

    const restored = await applyPrivacy(client, { profilePhoto: "everybody" });
    expect(restored.settings.profilePhoto).toBe("everybody");
    expect(restored.nobody).toBe(0);
  });

  it("gives contacts for a nobody asked of a key Telegram has no nobody for", async () => {
    const { client, sent } = fakeClient();
    const result = await applyPrivacy(client, { addedByPhone: "nobody" });

    expect(forKey(sent, "InputPrivacyKeyAddedByPhone")?.rules).toEqual([
      "InputPrivacyValueAllowContacts",
      "InputPrivacyValueDisallowAll",
    ]);
    expect(result.settings.addedByPhone).toBe("contacts");
  });

  it("does not widen a refused setting past what was asked for", async () => {
    const { client } = fakeClient({
      InputPrivacyKeyAbout: { level: "contacts", error: "PRIVACY_VALUE_INVALID" },
    });
    const result = await applyPrivacy(client, { about: "contacts" });

    // Falling back to everybody would be the opposite of the request, so it is skipped instead
    expect(result.settings.about).toBe("unsupported");
    expect(result.everybody).toEqual([]);
  });

  it("ignores unknown keys and levels", async () => {
    const { client, sent } = fakeClient();
    const result = await applyPrivacy(client, {
      nonsense: "nobody",
      about: "sometimes" as any,
    });

    expect(sent).toHaveLength(0);
    expect(result.settings).toEqual({});
  });
});

describe("describePrivacyResult", () => {
  it("says what was hidden and what would not go all the way", async () => {
    const { client } = fakeClient({
      InputPrivacyKeyStarGiftsAutoSave: {
        level: "any",
        error: "PREMIUM_ACCOUNT_REQUIRED",
      },
    });
    const text = describePrivacyResult(await hardenPrivacy(client));

    expect(text).toContain("hidden from everyone");
    expect(text).toContain("addedByPhone");
    expect(text).toContain("giftsAutoSave not available");
  });
});
