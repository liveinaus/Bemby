<template>
  <div class="form-group" style="margin-bottom: 0">
    <label class="form-label">{{ label }}</label>
    <select
      :value="modelValue"
      class="form-select"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">{{ blankLabel }}</option>
      <option v-if="allowDirect" value="direct">{{ t("jobs.custom.miniAppProxyDirect") }}</option>
      <option value="random">{{ t("jobs.proxyRandom") }}</option>
      <option v-for="p in proxies" :key="p.id" :value="p.id">
        {{ p.name }}{{ usable(p) ? "" : ` (${offLabel(p)})` }}
      </option>
    </select>
    <div v-if="hint" style="font-size: 11px; color: #aaa; margin-top: 3px">{{ hint }}</div>

    <!-- The pool the draw runs over. Nothing ticked means the whole list, so a pool never
         has to be maintained just to use a random exit -->
    <div v-if="modelValue === 'random'" class="proxy-pool">
      <div class="proxy-pool-head">
        <span class="form-label" style="margin: 0">{{ t("jobs.proxyRandomPoolLabel") }}</span>
        <span class="proxy-pool-count">{{
          pool.length ? `${coveredCount}/${usableCount}` : t("jobs.proxyRandomPoolAll")
        }}</span>
        <button
          v-if="pool.length"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="pool.splice(0, pool.length)"
        >
          {{ t("jobs.proxyRandomPoolClear") }}
        </button>
      </div>

      <!-- Grouped by supplier once there is one to group by: a tick on the supplier keeps
           standing for its current list, so a sync that adds or drops exits is followed -->
      <div v-if="grouped" class="proxy-pool-list">
        <div v-for="g in groups" :key="g.id" class="proxy-pool-group">
          <div class="proxy-pool-group-head">
            <label class="form-checkbox-label proxy-pool-item">
              <input
                type="checkbox"
                :checked="isSupplierPicked(g.id)"
                :indeterminate.prop="!isSupplierPicked(g.id) && pickedIn(g) > 0"
                @change="toggleSupplier(g.id)"
              />
              <strong>{{ g.name }}</strong>
            </label>
            <span class="proxy-pool-count"
              >{{ isSupplierPicked(g.id) ? usableIn(g) : pickedIn(g) }}/{{ usableIn(g) }}</span
            >
            <button type="button" class="proxy-pool-toggle" @click="toggleExpanded(g.id)">
              <i :class="expanded.has(g.id) ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'"></i>
            </button>
          </div>
          <div v-if="expanded.has(g.id)" class="proxy-pool-group-items">
            <label
              v-for="p in g.items"
              :key="p.id"
              class="form-checkbox-label proxy-pool-item"
              :title="isSupplierPicked(g.id) ? t('jobs.proxyRandomPoolBySupplier') : undefined"
            >
              <input
                type="checkbox"
                :checked="isSupplierPicked(g.id) || pool.includes(p.id)"
                :disabled="isSupplierPicked(g.id)"
                @change="toggle(p.id)"
              />
              <span :class="{ 'proxy-pool-off': !usable(p) }">{{ p.name }}</span>
              <span v-if="!usable(p)" class="badge badge-red" style="font-size: 9px">{{
                offLabel(p)
              }}</span>
            </label>
          </div>
        </div>
      </div>

      <div v-else class="proxy-pool-list">
        <label v-for="p in proxies" :key="p.id" class="form-checkbox-label proxy-pool-item">
          <input type="checkbox" :checked="pool.includes(p.id)" @change="toggle(p.id)" />
          <span :class="{ 'proxy-pool-off': !usable(p) }">{{ p.name }}</span>
          <span v-if="!usable(p)" class="badge badge-red" style="font-size: 9px">{{
            offLabel(p)
          }}</span>
        </label>
      </div>

      <div style="font-size: 11px; color: #aaa; margin-top: 3px">
        {{ t("jobs.proxyRandomPoolHint") }}
        <template v-if="grouped"> {{ t("jobs.proxyRandomPoolSupplierHint") }}</template>
        {{ t("jobs.proxyRandomPoolDisabledHint") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "../i18n";
import {
  poolCovers,
  proxyProvidersCached,
  supplierIdForProxy,
  supplierToken,
} from "../composables/proxyPick";
import type { ProxyProvider } from "../api/client";

// Every place an exit can be chosen shows this, so "random" and its pool read and behave the
// same throughout. The pool array is mutated in place: the parent holds it inside its own form
// object, the way the step editors are given their lists.
const props = defineProps<{
  /** Proxy list id, "direct", "random", or "" for the blank option. */
  modelValue: string;
  pool: string[];
  /**
   * The proxy list as stored. `disabled` is an exit turned off by hand and `status: "failed"`
   * one a test knocked out; neither is ever drawn.
   */
  proxies: Array<{ id: string; name: string; status?: string; disabled?: boolean }>;
  label: string;
  /** What a blank value means here: follow the template, follow the job, or no proxy at all. */
  blankLabel: string;
  hint?: string;
  /** Offer "direct" -- only the browser actions can go out without an exit. */
  allowDirect?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const providers = ref<ProxyProvider[]>([]);
const providersLoaded = ref(false);
const expanded = ref(new Set<string>());

// Suppliers are only needed once a draw is on screen, and the fetch behind this is shared
watch(
  () => props.modelValue,
  async (value) => {
    if (value !== "random" || providersLoaded.value) return;
    providers.value = await proxyProvidersCached();
    providersLoaded.value = true;
  },
  { immediate: true },
);

type Group = {
  id: string;
  name: string;
  items: Array<{ id: string; name: string; status?: string; disabled?: boolean }>;
};

/** A disabled exit is shown but never drawn, so it is left out of every count. */
const usable = (p: { status?: string; disabled?: boolean }) =>
  !p.disabled && p.status !== "failed";

/** What the badge beside an unusable exit says: turned off by hand, or failed its test. */
const offLabel = (p: { status?: string; disabled?: boolean }) =>
  p.disabled ? t("settings.proxyOff") : t("settings.proxyDisabled");

const groups = computed<Group[]>(() => {
  const ids = providers.value.map((p) => p.id);
  const items = new Map<string, Group["items"]>();
  for (const p of props.proxies) {
    const supplier = supplierIdForProxy(p.id, ids);
    (items.get(supplier) ?? items.set(supplier, []).get(supplier)!).push(p);
  }
  const out: Group[] = providers.value
    .filter((p) => items.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, items: items.get(p.id)! }));
  // Manually added proxies, and imports whose provider is gone, keep a group of their own
  if (items.has("")) {
    out.push({ id: "", name: t("jobs.proxyRandomPoolManual"), items: items.get("")! });
  }
  return out;
});

/** Only worth grouping once a supplier is in play; a list of manual proxies stays flat. */
const grouped = computed(() => groups.value.some((g) => g.id));

const usableCount = computed(() => props.proxies.filter(usable).length);

const coveredCount = computed(() => {
  const ids = providers.value.map((p) => p.id);
  return props.proxies.filter((p) => usable(p) && poolCovers(props.pool, p.id, ids)).length;
});

const isSupplierPicked = (id: string) => props.pool.includes(supplierToken(id));

const pickedIn = (g: Group) =>
  g.items.filter((p) => usable(p) && props.pool.includes(p.id)).length;

const usableIn = (g: Group) => g.items.filter(usable).length;

// Opened once the groups are settled: the ones with something ticked one by one, so a saved
// pool is visible without hunting for it. Proxies and suppliers both arrive asynchronously,
// hence the watch rather than a call at mount.
let seeded = false;
watch(
  [providersLoaded, groups] as const,
  ([loaded, list]) => {
    if (seeded || !loaded || !list.length) return;
    seeded = true;
    for (const g of list) {
      if (pickedIn(g) || list.length === 1) expanded.value.add(g.id);
    }
  },
  { immediate: true },
);

function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id);
  else expanded.value.add(id);
}

function toggle(id: string) {
  const at = props.pool.indexOf(id);
  if (at >= 0) props.pool.splice(at, 1);
  else props.pool.push(id);
}

/** A supplier replaces its members in the pool: the tick is the whole list, whatever it holds. */
function toggleSupplier(supplierId: string) {
  const token = supplierToken(supplierId);
  const at = props.pool.indexOf(token);
  if (at >= 0) {
    props.pool.splice(at, 1);
    return;
  }
  const members = new Set(groups.value.find((g) => g.id === supplierId)?.items.map((p) => p.id));
  for (let i = props.pool.length - 1; i >= 0; i--) {
    if (members.has(props.pool[i])) props.pool.splice(i, 1);
  }
  props.pool.push(token);
}
</script>

<style scoped>
.proxy-pool {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
}

.proxy-pool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.proxy-pool-count {
  font-size: 11px;
  color: #888;
  margin-right: auto;
}

/* A synced provider can leave a long list, so the pool scrolls rather than pushing the
   rest of the form off screen */
.proxy-pool-list {
  max-height: 220px;
  overflow-y: auto;
}

.proxy-pool-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

.proxy-pool-group + .proxy-pool-group {
  border-top: 1px solid #f0f0f0;
}

.proxy-pool-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.proxy-pool-toggle {
  border: 0;
  background: none;
  color: #888;
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
}

.proxy-pool-group-items {
  padding-left: 18px;
}

.proxy-pool-off {
  color: #aaa;
  text-decoration: line-through;
}
</style>
