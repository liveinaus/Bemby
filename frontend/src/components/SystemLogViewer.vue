<template>
  <div class="syslog">
    <div class="syslog-toolbar">
      <select v-model="level" class="form-select syslog-level">
        <option value="">{{ t("settings.systemLog.levelAll") }}</option>
        <option value="info">{{ t("settings.systemLog.levelInfo") }}</option>
        <option value="warn">{{ t("settings.systemLog.levelWarn") }}</option>
        <option value="error">{{ t("settings.systemLog.levelError") }}</option>
      </select>
      <input
        v-model="search"
        class="form-input syslog-search"
        type="search"
        :placeholder="t('common.search')"
      />
      <label class="form-check syslog-live">
        <input type="checkbox" v-model="live" />
        <span>{{ t("settings.systemLog.live") }}</span>
      </label>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="reload">
        <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
      </button>
      <button class="btn btn-ghost btn-sm" :disabled="!entries.length" @click="copyAll">
        <i class="fa-solid fa-copy"></i>
        {{ copied ? t("settings.update.copied") : t("settings.systemLog.copy") }}
      </button>
      <button class="btn btn-ghost btn-sm" :disabled="!entries.length" @click="download">
        <i class="fa-solid fa-download"></i> {{ t("common.download") }}
      </button>
      <button class="btn btn-ghost btn-sm" @click="clear">
        <i class="fa-solid fa-eraser"></i> {{ t("settings.systemLog.clear") }}
      </button>
    </div>

    <div v-if="error" class="error-msg" style="margin-bottom: 8px">{{ error }}</div>

    <div ref="paneEl" class="syslog-pane" @scroll="onScroll">
      <div v-if="loading && !entries.length" class="syslog-empty">
        {{ t("common.loading") }}
      </div>
      <div v-else-if="!entries.length" class="syslog-empty">
        {{ t("settings.systemLog.empty") }}
      </div>
      <div
        v-for="entry in entries"
        :key="entry.seq"
        class="syslog-line"
        :class="`syslog-${entry.level}`"
      >
        <span class="syslog-time">{{ shortTime(entry.at) }}</span>
        <span class="syslog-level-tag">{{ entry.level.toUpperCase() }}</span>
        <span class="syslog-text">{{ entry.text }}</span>
      </div>
    </div>

    <!-- Scrolled up mid-read, new lines must not yank the pane away; say they arrived instead -->
    <button v-if="live && !following" class="btn btn-sm btn-secondary syslog-tail" @click="scrollToEnd">
      <i class="fa-solid fa-arrow-down"></i> {{ t("settings.systemLog.jumpToEnd") }}
    </button>

    <p class="syslog-meta">
      {{
        t("settings.systemLog.buffered")
          .replace("{n}", String(page?.buffered ?? entries.length))
          .replace("{cap}", String(page?.capacity ?? 0))
      }}
      <template v-if="page?.dropped">
        · {{ t("settings.systemLog.dropped").replace("{n}", String(page.dropped)) }}
      </template>
      <template v-if="page?.startedAt">
        · {{ t("settings.systemLog.since").replace("{at}", localTime(page.startedAt)) }}
      </template>
    </p>
    <p class="syslog-hint">{{ t("settings.systemLog.hint") }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { statusApi } from "../api/client";
import type { SystemLogEntry, SystemLogLevel, SystemLogPage } from "../api/client";
import { t } from "../i18n";
import { copyText } from "../utils/clipboard";
import { debounce } from "../composables/useDebounce";
import { usePersistedRef } from "../composables/usePersistedRef";

const POLL_MS = 2000;
/** Held client-side so a long session cannot grow the page without bound. */
const MAX_RENDERED = 3000;
/** How close to the bottom still counts as watching the tail. */
const TAIL_SLACK_PX = 40;

const entries = ref<SystemLogEntry[]>([]);
const page = ref<SystemLogPage | null>(null);
const loading = ref(true);
const error = ref("");
const copied = ref(false);
const following = ref(true);
const paneEl = ref<HTMLElement | null>(null);

const level = usePersistedRef<"" | SystemLogLevel>("syslog.level", "");
const live = usePersistedRef("syslog.live", true);
const search = ref("");
const appliedSearch = ref("");

let cursor = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const query = computed(() => ({
  level: level.value || undefined,
  search: appliedSearch.value || undefined,
}));

function shortTime(at: string): string {
  return new Date(at).toLocaleTimeString();
}

function localTime(at: string): string {
  return new Date(at).toLocaleString();
}

async function fetchPage(reset: boolean) {
  if (reset) {
    cursor = 0;
    loading.value = true;
  }
  try {
    const result = await statusApi.systemLog({
      ...query.value,
      since: reset ? undefined : cursor,
      limit: MAX_RENDERED,
    });
    error.value = "";
    // A cursor ahead of the buffer means the backend restarted and its seqs began again,
    // so what we hold belongs to a process that is gone
    if (!reset && result.nextSeq < cursor) {
      entries.value = [];
      cursor = 0;
      page.value = result;
      await fetchPage(true);
      return;
    }
    page.value = result;
    cursor = result.nextSeq;
    // Guarded against a repeat: a poll that raced the first load can bring back lines
    // already held, and a duplicate seq is a duplicate v-for key
    const lastSeq = entries.value.length ? entries.value[entries.value.length - 1].seq : 0;
    entries.value = reset
      ? result.entries
      : entries.value.concat(result.entries.filter((e) => e.seq > lastSeq));
    if (entries.value.length > MAX_RENDERED) {
      entries.value = entries.value.slice(-MAX_RENDERED);
    }
    if (following.value && (reset || result.entries.length)) {
      await nextTick();
      scrollToEnd();
    }
  } catch (err: any) {
    error.value = err?.response?.data?.error ?? t("settings.systemLog.loadFailed");
  } finally {
    loading.value = false;
  }
}

const reload = () => fetchPage(true);

function onScroll() {
  const pane = paneEl.value;
  if (!pane) return;
  following.value =
    pane.scrollHeight - pane.scrollTop - pane.clientHeight <= TAIL_SLACK_PX;
}

function scrollToEnd() {
  const pane = paneEl.value;
  if (!pane) return;
  pane.scrollTop = pane.scrollHeight;
  following.value = true;
}

function asText(): string {
  return entries.value.map((e) => `${e.at} ${e.level.toUpperCase()} ${e.text}`).join("\n");
}

async function copyAll() {
  if (!(await copyText(asText()))) {
    error.value = t("common.copyFailed");
    return;
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

function download() {
  const blob = new Blob([asText()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bemby-system-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clear() {
  try {
    await statusApi.clearSystemLog();
  } catch {
    /* the reload below reports whatever state it finds */
  }
  entries.value = [];
  await fetchPage(true);
}

const applySearch = debounce(() => {
  appliedSearch.value = search.value.trim();
}, 300);
watch(search, applySearch);

// A filter is applied server-side, so the held lines no longer match what was asked for
watch([level, appliedSearch], () => void fetchPage(true));

watch(
  live,
  (on) => {
    clearInterval(timer);
    if (!on) return;
    timer = setInterval(() => void fetchPage(false), POLL_MS);
  },
  { immediate: true },
);

onMounted(() => void fetchPage(true));
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.syslog-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.syslog-level {
  width: auto;
  min-width: 140px;
}
.syslog-search {
  width: 220px;
}
.syslog-live {
  margin: 0;
  white-space: nowrap;
}
.syslog-pane {
  height: 380px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-inset);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}
.syslog-empty {
  color: var(--text-muted);
  font-family: inherit;
}
.syslog-line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  color: var(--text-body);
}
.syslog-time {
  flex: none;
  color: var(--text-faint);
}
.syslog-level-tag {
  flex: none;
  width: 42px;
  color: var(--text-muted);
}
.syslog-text {
  /* Stack traces and JSON dumps arrive with their own newlines */
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 0;
}
.syslog-warn {
  color: var(--warning);
}
.syslog-warn .syslog-level-tag {
  color: var(--warning);
}
.syslog-error {
  color: var(--danger);
}
.syslog-error .syslog-level-tag {
  color: var(--danger);
}
.syslog-tail {
  margin-top: 8px;
}
.syslog-meta {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.syslog-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
