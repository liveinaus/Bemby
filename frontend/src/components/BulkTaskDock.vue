<template>
  <div v-if="visible" class="task-dock">
    <button class="task-dock-pill" @click="expanded = !expanded">
      <i
        :class="
          running.length
            ? 'fa-solid fa-spinner fa-spin'
            : 'fa-solid fa-circle-check'
        "
      ></i>
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
          <span class="task-card-name">{{ bulkTaskTitle(task.kind) }}</span>
          <span class="task-card-state" :class="`state-${task.state}`">
            {{ t(`bulkTasks.state.${task.state}`) }}
          </span>
        </div>
        <div class="task-bar">
          <div
            class="task-bar-fill"
            :class="`state-${task.state}`"
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
  runningTasks,
  startBulkTaskPolling,
  taskDoneCount,
  taskFailedCount,
  taskProgress,
} from "../composables/bulkTasks";
import { bulkTaskItemText, bulkTaskTitle } from "../composables/bulkTaskText";

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

/** The item a running task is on, for the one-line summary. */
function currentItem(task: BulkTask) {
  return (
    task.items.find((i) => i.status === "working") ??
    task.items.find((i) => i.status === "waiting") ??
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
  border: 1px solid #d9d9d9;
  border-radius: 999px;
  background: #fff;
  color: #333;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
}

.task-dock-pill:hover {
  border-color: #1296db;
  color: #1296db;
}

.task-dock-panel {
  width: min(420px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
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
  color: #8c8c8c;
}

.task-card {
  padding: 10px;
  border: 1px solid #eee;
  border-radius: 8px;
  background: #fafafa;
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

.task-card-state {
  font-size: 11px;
  color: #8c8c8c;
}

.task-card-state.state-running {
  color: #1296db;
}

.task-card-state.state-cancelled {
  color: #faad14;
}

.task-bar {
  height: 6px;
  margin: 8px 0 6px;
  border-radius: 999px;
  background: #eee;
  overflow: hidden;
}

.task-bar-fill {
  height: 100%;
  background: #1296db;
  transition: width 0.3s ease;
}

.task-bar-fill.state-completed {
  background: #52c41a;
}

.task-bar-fill.state-cancelled {
  background: #faad14;
}

.task-card-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #666;
}

.task-failed {
  color: #ff4d4f;
}

.task-current {
  color: #1296db;
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
  color: #1296db;
  font-size: 11px;
  cursor: pointer;
}

.task-items {
  max-height: 220px;
  overflow-y: auto;
  margin-top: 8px;
  border-top: 1px solid #eee;
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
  background: #d0d0d0;
}

.task-dot.status-done {
  background: #52c41a;
}

.task-dot.status-failed {
  background: #ff4d4f;
}

.task-dot.status-cancelled {
  background: #bfbfbf;
}

.task-dot.status-working,
.task-dot.status-waiting {
  background: #1296db;
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
  color: #8c8c8c;
  font-size: 11px;
}

.task-item-msg {
  font-size: 11px;
  color: #666;
  word-break: break-word;
}

.task-item-error {
  color: #ff4d4f;
}

.task-card-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
