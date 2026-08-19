import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether the jobs table carries a column for the exit each job
// leaves by. Shared so the column appears the moment the Settings toggle flips.
const enabled = ref(false);
let loaded = false;

/** Lazy-loads the setting once. Safe to call from any view's onMounted. */
export async function loadJobProxyColumnSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    enabled.value = s.jobs_show_effective_proxy === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies the change straight away (called by Settings when the toggle flips). */
export function setJobProxyColumn(value: boolean): void {
  enabled.value = value;
  loaded = true;
}

export { enabled as jobProxyColumn };
