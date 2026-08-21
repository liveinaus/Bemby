<template>
  <div>
    <div class="bulk-task-head">
      <span>
        {{ t("bulkTasks.progressLabel") }}: {{ taskDoneCount(task) }} /
        {{ task.total }}
      </span>
      <span
        v-if="task.state === 'running' && task.paused"
        class="bulk-task-paused"
      >
        <i class="fa-solid fa-circle-pause"></i>
        {{ t("bulkTasks.state.paused") }}
      </span>
      <span v-else-if="task.state === 'running'" class="bulk-task-running">
        <i class="fa-solid fa-spinner fa-spin"></i>
        {{ t("bulkTasks.state.running") }}
      </span>
      <span v-else class="bulk-task-finished">
        <i class="fa-solid fa-circle-check"></i>
        {{ t(`bulkTasks.state.${task.state}`) }}
      </span>
    </div>
    <p v-if="task.state === 'running'" class="bulk-task-note">
      <i class="fa-solid fa-circle-info"></i> {{ t("bulkTasks.serverNote") }}
    </p>

    <div class="bulk-task-list">
      <div v-for="item in task.items" :key="item.refId" class="bulk-task-item">
        <span class="bulk-task-dot" :class="`status-${item.status}`"></span>
        <div class="bulk-task-item-body">
          <div class="bulk-task-item-top">
            <strong>{{ item.refName }}</strong>
            <span class="bulk-task-item-status">
              {{ t(`bulkTasks.itemStatus.${item.status}`) }}
            </span>
          </div>
          <div
            v-if="bulkTaskItemText(task, item)"
            class="bulk-task-item-msg"
            :class="item.status === 'failed' ? 'bulk-task-item-error' : ''"
          >
            {{ bulkTaskItemText(task, item) }}
          </div>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <button
        v-if="task.state === 'running'"
        class="btn btn-ghost"
        :disabled="task.cancelRequested || pausing"
        @click="togglePause"
      >
        <i :class="task.paused ? 'fa-solid fa-play' : 'fa-solid fa-pause'"></i>
        {{ task.paused ? t("bulkTasks.resume") : t("bulkTasks.pause") }}
      </button>
      <button
        v-if="task.state === 'running'"
        class="btn btn-danger"
        :disabled="task.cancelRequested || terminating"
        @click="terminate"
      >
        <i class="fa-solid fa-ban"></i>
        {{
          task.cancelRequested
            ? t("bulkTasks.terminating")
            : t("bulkTasks.terminate")
        }}
      </button>
      <button class="btn btn-primary" @click="emit('close')">
        <i class="fa-solid fa-check"></i> {{ t("common.close") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n";
import type { BulkTask } from "../api/client";
import {
  cancelBulkTask,
  pauseBulkTask,
  resumeBulkTask,
  taskDoneCount,
} from "../composables/bulkTasks";
import { bulkTaskItemText } from "../composables/bulkTaskText";

// Progress view for one background bulk task, shared by every bulk modal. The
// task runs on the server, so closing this only hides the view.

const props = defineProps<{ task: BulkTask }>();
const emit = defineEmits<{ (e: "close"): void }>();

const terminating = ref(false);
const pausing = ref(false);

async function togglePause() {
  pausing.value = true;
  try {
    if (props.task.paused) await resumeBulkTask(props.task.id);
    else await pauseBulkTask(props.task.id);
  } finally {
    pausing.value = false;
  }
}

async function terminate() {
  terminating.value = true;
  try {
    await cancelBulkTask(props.task.id);
  } finally {
    terminating.value = false;
  }
}
</script>

<style scoped>
.bulk-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 6px;
}

.bulk-task-running {
  color: var(--info);
}

.bulk-task-finished {
  color: var(--success);
}

.bulk-task-paused {
  color: var(--warning);
}

.bulk-task-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.bulk-task-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
}

.bulk-task-item {
  display: flex;
  gap: 8px;
  padding: 5px 0;
}

.bulk-task-item + .bulk-task-item {
  border-top: 1px solid var(--border-faint);
}

.bulk-task-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--bg-track);
}

.bulk-task-dot.status-done {
  background: var(--success);
}

.bulk-task-dot.status-failed {
  background: var(--danger);
}

.bulk-task-dot.status-cancelled {
  background: var(--bg-track);
}

.bulk-task-dot.status-paused {
  background: var(--warning-solid);
}

.bulk-task-dot.status-working,
.bulk-task-dot.status-waiting {
  background: var(--info);
  animation: bulk-task-pulse 1s ease-in-out infinite;
}

@keyframes bulk-task-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.bulk-task-item-body {
  flex: 1;
  min-width: 0;
}

.bulk-task-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.bulk-task-item-status {
  color: var(--text-muted);
  font-size: 11px;
}

.bulk-task-item-msg {
  font-size: 12px;
  color: var(--text-tertiary);
  word-break: break-word;
}

.bulk-task-item-error {
  color: var(--danger);
}
</style>
