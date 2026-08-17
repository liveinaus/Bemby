import { watch } from 'vue';
import type { Ref } from 'vue';

/**
 * Clears a filter once its value is no longer on offer. Deleting the last job of a template takes
 * that template out of the dropdown, and a filter left pointing at it hides every remaining row
 * with nothing on screen to explain why -- persisted filters make that survive a reload. A control
 * that hides itself when there is nothing left to choose between counts as "not on offer" too, so
 * pass the values it actually shows.
 *
 * Only changes are watched, so a persisted filter survives the first paint with the options still
 * empty. `onCleared` is for views whose reload hangs off the select's own change event.
 */
export function useAvailableFilter<T>(
  filter: Ref<T>,
  available: () => readonly T[],
  cleared: T,
  onCleared?: () => void,
): void {
  watch(available, (values) => {
    if (filter.value === cleared || values.includes(filter.value)) return;
    filter.value = cleared;
    onCleared?.();
  });
}
