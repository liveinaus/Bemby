import { computed, ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether millisecond fields are shown, and typed, in seconds.
// Display only -- every value still travels and is stored in milliseconds, so a panel that
// flips this setting does not touch a single saved job.

const enabled = ref(false);
let loaded = false;

/** How many model units one displayed unit is worth: 1000 while seconds are preferred. */
export const msScale = computed(() => (enabled.value ? 1000 : 1));

/** Lazy-loads the setting once. Safe to call from any view's onMounted. */
export async function loadPreferSecondsSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    enabled.value = s.prefer_seconds === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies the change straight away (called by Settings when the toggle flips). */
export function setPreferSeconds(value: boolean): void {
  enabled.value = value;
  loaded = true;
}

/**
 * A field label with its unit swapped to match what the box now takes. The labels carry
 * their unit in the wording -- "Reply Timeout (ms)" -- so the label has to move with it.
 */
export function durationLabel(label: string): string {
  if (!enabled.value) return label;
  return label.replace(/（毫秒）/g, "（秒）").replace(/\(ms\)/g, "(s)");
}

export { enabled as preferSeconds };
