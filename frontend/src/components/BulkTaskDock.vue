<template>
  <div v-if="visible" class="task-dock">
    <button class="task-dock-pill" @click="expanded = !expanded">
      <i :class="pillIcon"></i>
      <span>{{ pillLabel }}</span>
      <i
        :class="expanded ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up'"
      ></i>
    </button>

    <div v-if="expanded" class="task-dock-panel">
      <div class="task-dock-head">
        <strong>{{ t("bulkTasks.title") }}</strong>
        <span class="task-dock-hint">{{ t("bulkTasks.hint") }}</span>
      </div>

      <div v-for="task in tasks" :key="task.id" class="task-card">
        <div class="task-card-top">
          <span class="task-card-name">
            {{ bulkTaskTitle(task.kind) }}
            <span v-if="task.label" class="task-card-scope">{{ task.label }}</span>
          </span>
          <span class="task-card-state" :class="`state-${stateKey(task)}`">
            {{ t(`bulkTasks.state.${stateKey(task)}`) }}
          </span>
        </div>
        <div class="task-bar">
          <div
            class="task-bar-fill"
            :class="`state-${stateKey(task)}`"
            :style="{ width: `${taskProgress(task)}%` }"
          ></div>
        </div>
        <div class="task-card-meta">
          <span>{{ taskDoneCount(task) }} / {{ task.total }}</span>
          <span v-if="taskFailedCount(task)" class="task-failed">
            {{
              t("bulkTasks.failedCount").replace(
                "{n}",
                String(taskFailedCount(task)),
              )
            }}
          </span>
          <span v-if="currentItem(task)" class="task-current">
            {{ currentItem(task)!.refName }}
          </span>
          <button class="task-link" @click="toggleDetail(task.id)">
            {{
              openDetail === task.id
                ? t("bulkTasks.hideItems")
                : t("bulkTasks.showItems")
            }}
          </button>
        </div>

        <div v-if="openDetail === task.id" class="task-items">
          <div v-for="item in task.items" :key="item.refId" class="task-item">
            <span class="task-dot" :class="`status-${item.status}`"></span>
            <div class="task-item-body">
              <div class="task-item-top">
                <strong>{{ item.refName }}</strong>
                <span class="task-item-status">
                  {{ t(`bulkTasks.itemStatus.${item.status}`) }}
                </span>
              </div>
              <div
                v-if="bulkTaskItemText(task, item)"
                class="task-item-msg"
                :class="item.status === 'failed' ? 'task-item-error' : ''"
              >
                {{ bulkTaskItemText(task, item) }}
              </div>
            </div>
          </div>
        </div>

        <div class="task-card-actions">
          <BulkTaskGap v-if="task.state === 'running'" :task="task" />
          <button
            v-if="task.state === 'running'"
            class="btn btn-ghost btn-sm"
            :disabled="task.cancelRequested || busy === task.id"
            @click="togglePause(task)"
          >
            <i
              :class="task.paused ? 'fa-solid fa-play' : 'fa-solid fa-pause'"
            ></i>
            {{ task.paused ? t("bulkTasks.resume") : t("bulkTasks.pause") }}
          </button>
          <button
            v-if="task.state === 'running'"
            class="btn btn-danger btn-sm"
            :disabled="task.cancelRequested || busy === task.id"
            @click="terminate(task)"
          >
            <i class="fa-solid fa-ban"></i>
            {{
              task.cancelRequested
                ? t("bulkTasks.terminating")
                : t("bulkTasks.terminate")
            }}
          </button>
          <button
            v-else-if="dismissable(task)"
            class="btn btn-ghost btn-sm"
            :disabled="busy === task.id"
            @click="dismiss(task)"
          >
            <i class="fa-solid fa-xmark"></i> {{ t("bulkTasks.dismiss") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "../i18n";
import type { BulkTask } from "../api/client";
import {
  bulkTasks,
  cancelBulkTask,
  dismissBulkTask,
  pauseBulkTask,
  resumeBulkTask,
  runningTasks,
  startBulkTaskPolling,
  taskDoneCount,
  taskFailedCount,
  taskProgress,
} from "../composables/bulkTasks";
import { bulkTaskItemText, bulkTaskTitle } from "../composables/bulkTaskText";
import BulkTaskGap from "./BulkTaskGap.vue";

const expanded = ref(false);
const openDetail = ref<string | null>(null);
const busy = ref<string | null>(null);

const tasks = bulkTasks;
const running = runningTasks;
const visible = computed(() => tasks.value.length > 0);

const pillLabel = computed(() =>
  running.value.length
    ? t("bulkTasks.pillRunning").replace("{n}", String(running.value.length))
    : t("bulkTasks.pillIdle").replace("{n}", String(tasks.value.length)),
);

// Nothing is turning while every queue is held, so the pill says so rather than spinning
const pillIcon = computed(() => {
  if (!running.value.length) return "fa-solid fa-circle-check";
  return running.value.every((task) => task.paused)
    ? "fa-solid fa-circle-pause"
    : "fa-solid fa-spinner fa-spin";
});

/** A held queue is still running, but reads as paused in the card and the bar. */
function stateKey(task: BulkTask): string {
  return task.state === "running" && task.paused ? "paused" : task.state;
}

/** The item a running task is on, for the one-line summary. */
function currentItem(task: BulkTask) {
  return (
    task.items.find((i) => i.status === "working") ??
    task.items.find((i) => i.status === "waiting") ??
    task.items.find((i) => i.status === "paused") ??
    null
  );
}

/** Anything that has stopped can be cleared away; a running task is terminated first. */
function dismissable(task: BulkTask): boolean {
  return task.state !== "running";
}

function toggleDetail(id: string) {
  openDetail.value = openDetail.value === id ? null : id;
}

async function terminate(task: BulkTask) {
  busy.value = task.id;
  try {
    await cancelBulkTask(task.id);
  } finally {
    busy.value = null;
  }
}

async function togglePause(task: BulkTask) {
  busy.value = task.id;
  try {
    if (task.paused) await resumeBulkTask(task.id);
    else await pauseBulkTask(task.id);
  } finally {
    busy.value = null;
  }
}

async function dismiss(task: BulkTask) {
  busy.value = task.id;
  try {
    await dismissBulkTask(task.id);
  } finally {
    busy.value = null;
  }
}

// Running work is picked up on load, so a reloaded page still shows it
onMounted(() => startBulkTaskPolling());
</script>

<style scoped>
.task-dock {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
}

.task-dock-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
}

.task-dock-pill:hover {
  border-color: var(--info);
  color: var(--info);
}

.task-dock-panel {
  width: min(420px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}

.task-dock-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.task-dock-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.task-card {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
}

.task-card + .task-card {
  margin-top: 8px;
}

.task-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.task-card-name {
  font-weight: 600;
}

/* Several job queues can run at once, so each says which templates it covers */
.task-card-scope {
  margin-left: 6px;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-muted);
}

.task-card-state {
  font-size: 11px;
  color: var(--text-muted);
}

.task-card-state.state-running {
  color: var(--info);
}

.task-card-state.state-cancelled {
  color: var(--warning);
}

.task-card-state.state-paused {
  color: var(--warning);
}

.task-bar {
  height: 6px;
  margin: 8px 0 6px;
  border-radius: 999px;
  background: var(--bg-active);
  overflow: hidden;
}

.task-bar-fill {
  height: 100%;
  background: var(--info);
  transition: width 0.3s ease;
}

.task-bar-fill.state-completed {
  background: var(--success);
}

.task-bar-fill.state-cancelled,
.task-bar-fill.state-paused {
  background: var(--warning-solid);
}

.task-card-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-tertiary);
}

.task-failed {
  color: var(--danger);
}

.task-current {
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.task-link {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0;
  color: var(--info);
  font-size: 11px;
  cursor: pointer;
}

.task-items {
  max-height: 220px;
  overflow-y: auto;
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.task-item {
  display: flex;
  gap: 8px;
  padding: 4px 0;
}

.task-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--bg-track);
}

.task-dot.status-done {
  background: var(--success);
}

.task-dot.status-failed {
  background: var(--danger);
}

.task-dot.status-cancelled {
  background: var(--bg-track);
}

.task-dot.status-paused {
  background: var(--warning-solid);
}

.task-dot.status-working,
.task-dot.status-waiting {
  background: var(--info);
  animation: task-pulse 1s ease-in-out infinite;
}

@keyframes task-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.task-item-body {
  flex: 1;
  min-width: 0;
}

.task-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.task-item-status {
  color: var(--text-muted);
  font-size: 11px;
}

.task-item-msg {
  font-size: 11px;
  color: var(--text-tertiary);
  word-break: break-word;
}

.task-item-error {
  color: var(--danger);
}

.task-card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

/* The gap control sits on the left, away from the pause/terminate buttons */
.task-card-actions > .task-gap {
  margin-right: auto;
}
</style>
