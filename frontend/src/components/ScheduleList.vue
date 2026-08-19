<template>
  <div v-if="collapsible" class="card sched-card">
    <button class="sched-head" @click="open = !open">
      <span class="sched-title">
        <i :class="open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
        {{ t('jobs.nextRuns') }}
        <span class="sched-count">{{ items.length }}</span>
      </span>
      <span v-if="sorted.length" class="sched-summary">
        {{ t('jobs.nextUp') }}:
        <strong>{{ sorted[0].jobName }}</strong>
        · {{ fmtDateTime(sorted[0].nextRun) }}
      </span>
    </button>
    <div v-if="open" class="sched-body">
      <ScheduleBody
        :by-day="byDay"
        :next-job-id="nextJobId"
        :skipping="skipping"
        :scroll="true"
        v-model:search="search"
        @skip="skip"
      />
    </div>
  </div>

  <div v-else class="sched-page">
    <div class="sched-page-head">
      <span class="sched-count">{{ items.length }}</span>
      <span v-if="sorted.length" class="sched-summary">
        {{ t('jobs.nextUp') }}:
        <strong>{{ sorted[0].jobName }}</strong>
        · {{ fmtDateTime(sorted[0].nextRun) }}
      </span>
      <button class="btn btn-sm btn-ghost" style="margin-left:auto" :disabled="loading" @click="load">
        <i :class="loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate'"></i>
        {{ t('common.refresh') }}
      </button>
    </div>
    <ScheduleBody
      :by-day="byDay"
      :next-job-id="nextJobId"
      :skipping="skipping"
      :scroll="false"
      v-model:search="search"
      @skip="skip"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { statusApi, type ScheduleStatus } from '../api/client';
import { t, locale } from '../i18n';
import { usePersistedRef } from '../composables/usePersistedRef';
import ScheduleBody from './ScheduleBody.vue';
import { loadJobIcons } from '../composables/jobIcons';

// Upcoming scheduled runs. Rendered either as the collapsible card on the jobs page or as a
// page of its own (see the schedulePage setting), so both stay in step from one place.
const props = defineProps<{ collapsible?: boolean }>();

const items = ref<ScheduleStatus[]>([]);
const loading = ref(false);
const search = ref('');
const skipping = ref<number | null>(null);
const open = usePersistedRef<boolean>('bemby:jobs:schedOpen', true);

const sorted = computed(() =>
  [...items.value].sort((a, b) => a.nextRun.localeCompare(b.nextRun)),
);
const nextJobId = computed(() => sorted.value[0]?.jobId ?? null);

/** Grouped by local calendar day, filtered by the search box. */
const byDay = computed(() => {
  const q = search.value.toLowerCase();
  const filtered = q
    ? sorted.value.filter((s) => s.jobName.toLowerCase().includes(q))
    : sorted.value;
  const groups = new Map<string, { key: string; label: string; items: ScheduleStatus[] }>();
  for (const s of filtered) {
    const d = new Date(s.nextRun);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: fmtDayLabel(d), items: [] };
      groups.set(key, g);
    }
    g.items.push(s);
  }
  return [...groups.values()];
});

function localeTag() {
  return ({ en: 'en-AU', zh: 'zh-CN' } as Record<string, string>)[locale.value] ?? 'en-AU';
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(localeTag(), {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDayLabel(d: Date) {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  const dateStr = d.toLocaleDateString(localeTag(), {
    weekday: 'short', month: 'short', day: '2-digit',
  });
  if (diff === 0) return `${t('jobs.today')} · ${dateStr}`;
  if (diff === 1) return `${t('jobs.tomorrow')} · ${dateStr}`;
  return dateStr;
}

async function load() {
  loading.value = true;
  try {
    items.value = await statusApi.get();
  } catch {
    /* the panel is informational; a failed poll leaves the last list in place */
  } finally {
    loading.value = false;
  }
}

// Calls off one occurrence: the job keeps its schedule and reappears on its next eligible day
async function skip(jobId: number) {
  if (skipping.value !== null) return;
  skipping.value = jobId;
  try {
    await statusApi.skipRun(jobId);
    await load();
  } catch {
    /* it may have just fired, in which case the reload below tells the truth */
    await load();
  } finally {
    skipping.value = null;
  }
}

onMounted(() => {
  // The chips draw uploaded icons, which are fetched once and shared
  void loadJobIcons();
  return load();
});
defineExpose({ reload: load });
</script>

<style scoped>
.sched-card {
  margin-bottom: 16px;
  padding: 0;
  overflow: hidden;
}
.sched-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.sched-head:hover {
  background: var(--bg-inset);
}
.sched-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  flex-shrink: 0;
}
.sched-title .fa-solid {
  font-size: 11px;
  color: var(--text-faint);
}
.sched-body {
  padding: 0 18px 14px;
}
.sched-page-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.sched-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-body);
  background: var(--bg-inset);
  border-radius: 10px;
  padding: 1px 8px;
  letter-spacing: 0;
}
.sched-summary {
  font-size: 13px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.sched-summary strong {
  color: var(--text-primary);
}
</style>
