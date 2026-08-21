import { reactive, ref, watch } from 'vue';
import type { Ref } from 'vue';

// Returns a ref whose value is synced to localStorage under the given key.
export function usePersistedRef<T>(key: string, defaultValue: T): Ref<T> {
  let initial = defaultValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) initial = JSON.parse(raw) as T;
  } catch {
    // ignore malformed stored value
  }
  const state = ref(initial) as Ref<T>;
  watch(state, (val) => {
    localStorage.setItem(key, JSON.stringify(val));
  });
  return state;
}

// Same idea for a form-shaped object: stored fields are merged over the defaults so
// fields added later still start with a sensible value.
export function usePersistedReactive<T extends object>(key: string, defaults: T): T {
  let stored: Partial<T> = {};
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) stored = JSON.parse(raw) as Partial<T>;
  } catch {
    // ignore malformed stored value
  }
  const state = reactive({ ...defaults, ...stored }) as T;
  watch(
    state,
    (val) => {
      localStorage.setItem(key, JSON.stringify(val));
    },
    { deep: true },
  );
  return state;
}
