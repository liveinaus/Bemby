import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether the deployment offers msOauth2api at all (MSOAUTH2API on
// the server), and whether it has a base URL and a key stored, so the step editor and the
// bulk forms agree the moment Settings saves one. The credentials themselves never reach the
// client -- only whether they are there, and which pool type is the default.
//
// Not offered, nothing anywhere should mention msOauth2api: no Settings section, no address
// source on a login-email run, no pool steps in the editor.

const available = ref(false);
const configured = ref(false);
const poolTypeDefault = ref("Telegram");
let loaded = false;

/** Lazy-loads the flags once. Safe to call from any view's onMounted. */
export async function loadMsApiSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    applyMsApiSetting(await settingsApi.get());
  } catch {
    loaded = false; // allow a later retry
  }
}

/**
 * Takes both flags off a Settings payload. The deployment's flag governs: with the feature not
 * offered, a stored URL and key count for nothing (and are not served in the first place).
 */
export function applyMsApiSetting(payload: {
  msapi_available?: string;
  msapi_configured?: string;
  msapi_pool_type?: string;
  msapi_pool_type_default?: string;
}): void {
  available.value = payload.msapi_available === "true";
  configured.value = available.value && payload.msapi_configured === "true";
  poolTypeDefault.value =
    payload.msapi_pool_type || payload.msapi_pool_type_default || "Telegram";
  loaded = true;
}

export {
  available as msApiAvailable,
  configured as msApiConfigured,
  poolTypeDefault as msApiPoolTypeDefault,
};
