import type { Page } from "playwright-core";

// Registering a Microsoft passkey without hardware, for the `web_ms_passkey` step. Chromium's
// CDP WebAuthn domain can stand a virtual authenticator in for a security key: the account's
// "add a passkey" flow then completes with no device and no native dialog, and the credential
// it mints -- id, RP id, user handle and private key -- is read straight back out. That is the
// whole point: a passkey Bemby holds the private key for can sign a later sign-in itself.

export type VirtualAuthenticator = {
  authenticatorId: string;
  // A CDPSession; typed loosely because the WebAuthn domain is not in playwright-core's
  // narrowed Protocol surface, and every call here is to that domain.
  cdp: { send: (method: string, params?: unknown) => Promise<any> };
};

/** A credential as the virtual authenticator holds it, with the private key worth keeping. */
export type PasskeyCredential = {
  credentialId: string;
  rpId: string;
  userHandle: string | null;
  /** PKCS#8, base64. What makes the passkey reusable rather than just proof one was made. */
  privateKey: string;
  signCount: number;
  isResidentCredential: boolean;
};

/**
 * Arms a virtual authenticator on the page and leaves it there for the rest of the session.
 * `isUserVerified` and `automaticPresenceSimulation` make it answer create/get on its own, so
 * nothing waits on a touch that will never come.
 */
export async function armVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = (await page.context().newCDPSession(page)) as unknown as VirtualAuthenticator["cdp"];
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { authenticatorId: String(authenticatorId), cdp };
}

/** Everything the authenticator currently holds. */
export async function listCredentials(auth: VirtualAuthenticator): Promise<PasskeyCredential[]> {
  const res = await auth.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: auth.authenticatorId,
  });
  const credentials: any[] = res?.credentials ?? [];
  return credentials.map((c) => ({
    credentialId: String(c.credentialId ?? ""),
    rpId: String(c.rpId ?? ""),
    userHandle: c.userHandle ?? null,
    privateKey: String(c.privateKey ?? ""),
    signCount: Number(c.signCount ?? 0),
    isResidentCredential: Boolean(c.isResidentCredential),
  }));
}

/** The ids held right now, for a before/after diff around an enrolment. */
export async function credentialIds(auth: VirtualAuthenticator): Promise<Set<string>> {
  return new Set((await listCredentials(auth)).map((c) => c.credentialId));
}
