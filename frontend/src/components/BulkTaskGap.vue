<template>
  <label class="task-gap" :title="t('bulkTasks.gapHint')">
    <span class="task-gap-label">{{ t("bulkTasks.gapLabel") }}</span>
    <input
      v-model="draft"
      class="task-gap-input"
      type="number"
      min="0"
      max="3600"
      step="1"
      :disabled="saving"
      @change="apply"
      @keydown.enter.prevent="apply"
      @blur="apply"
    />
    <span class="task-gap-unit">{{ t("bulkTasks.gapUnit") }}</span>
  </label>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "../i18n";
import type { BulkTask } from "../api/client";
import { setBulkTaskGap } from "../composables/bulkTasks";

// The wait between two items of a running bulk task. Editable mid-run -- typically
// while the queue is held -- and the server applies it to the wait already running.

const props = defineProps<{ task: BulkTask }>();

const draft = ref(String(props.task.gapSeconds));
const saving = ref(false);

// The poll keeps the task fresh; follow it unless the operator is mid-edit
watch(
  () => props.task.gapSeconds,
  (gap) => {
    if (!saving.value && document.activeElement?.tagName !== "INPUT") {
      draft.value = String(gap);
    }
  },
);

async function apply() {
  const wanted = Number(draft.value);
  if (!Number.isFinite(wanted) || wanted < 0) {
    draft.value = String(props.task.gapSeconds);
    return;
  }
  const rounded = Math.round(wanted);
  if (rounded === props.task.gapSeconds) {
    draft.value = String(rounded);
    return;
  }
  saving.value = true;
  try {
    draft.value = String(await setBulkTaskGap(props.task.id, rounded));
  } catch {
    draft.value = String(props.task.gapSeconds);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.task-gap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
  cursor: pointer;
}

.task-gap-input {
  width: 56px;
  padding: 2px 4px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 11px;
  text-align: right;
}

.task-gap-input:disabled {
  opacity: 0.6;
}
</style>
