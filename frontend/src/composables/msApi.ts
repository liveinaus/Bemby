import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether msOauth2api has a base URL and a key stored, so the step
// editor and the bulk forms agree the moment Settings saves one. The credentials themselves
// never reach the client -- only whether they are there, and which pool type is the default.

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

export function applyMsApiSetting(payload: {
  msapi_configured?: string;
  msapi_pool_type?: string;
  msapi_pool_type_default?: string;
}): void {
  configured.value = payload.msapi_configured === "true";
  poolTypeDefault.value =
    payload.msapi_pool_type || payload.msapi_pool_type_default || "Telegram";
  loaded = true;
}

export { configured as msApiConfigured, poolTypeDefault as msApiPoolTypeDefault };
