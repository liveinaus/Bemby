import { computed, ref } from "vue";
import { settingsApi, type UpdateStatus } from "../api/client";

// Module-level singleton: whether a newer build has been published. The sidebar marks it and
// Settings shows the detail, so both read the same answer rather than each asking for one.
//
// Reporting only. Taking the update is a pull and a recreate on whatever runs the container:
// a process cannot replace the container it is running in.

const status = ref<UpdateStatus | null>(null);
let loaded = false;

export const updateAvailable = computed(() => status.value?.updateAvailable === true);

/** Lazy-loads once. The server caches its own answer, so this is cheap to call on mount. */
export async function loadUpdateStatus(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    status.value = await settingsApi.updateStatus();
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Goes past the server's cache, for the panel's own "check now". */
export async function refreshUpdateStatus(): Promise<UpdateStatus | null> {
  status.value = await settingsApi.updateStatus(true);
  loaded = true;
  return status.value;
}

/** Drops the answer so the next load asks again, e.g. after the check is switched back on. */
export function invalidateUpdateStatus(): void {
  loaded = false;
  status.value = null;
}

export { status as updateStatus };
