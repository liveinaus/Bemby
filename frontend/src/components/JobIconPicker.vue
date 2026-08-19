<template>
  <div class="icon-picker">
    <button
      type="button"
      class="icon-trigger"
      :title="t('jobIcons.pick')"
      @click="open = !open"
    >
      <JobIcon :icon="modelValue" :size="20" />
      <i class="fa-solid fa-chevron-down icon-trigger-caret"></i>
    </button>

    <button
      v-if="modelValue"
      type="button"
      class="icon-clear"
      :title="t('jobIcons.clear')"
      @click="choose(null)"
    >
      <i class="fa-solid fa-xmark"></i>
    </button>

    <div v-if="open" class="icon-panel">
      <div class="icon-panel-head">
        <span>{{ t("jobIcons.title") }}</span>
        <button type="button" class="icon-panel-close" @click="open = false">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="icon-scroll">
        <template v-for="group in BUILT_IN_JOB_ICONS" :key="group.group">
          <div class="icon-group-label">
            {{ t(`jobIcons.groups.${group.group}`) }}
          </div>
          <div class="icon-grid">
            <button
              v-for="name in group.icons"
              :key="name"
              type="button"
              class="icon-cell"
              :class="{ 'icon-cell-active': modelValue === name }"
              @click="choose(name)"
            >
              <i :class="name"></i>
            </button>
          </div>
        </template>

        <div class="icon-group-label">
          {{ t("jobIcons.groups.custom") }}
          <span class="icon-group-count">{{ customIcons.length }}</span>
        </div>
        <div class="icon-grid">
          <button
            v-for="item in customIcons"
            :key="item.name"
            type="button"
            class="icon-cell"
            :class="{ 'icon-cell-active': modelValue === `custom:${item.name}` }"
            @click="choose(`custom:${item.name}`)"
          >
            <img :src="item.dataUrl" alt="" />
            <span
              class="icon-cell-remove"
              :title="t('jobIcons.remove')"
              @click.stop="removeIcon(item.name)"
            >
              <i class="fa-solid fa-xmark"></i>
            </span>
          </button>
          <button
            type="button"
            class="icon-cell icon-cell-upload"
            :title="t('jobIcons.upload')"
            :disabled="uploading"
            @click="fileInput?.click()"
          >
            <i
              :class="
                uploading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-plus'
              "
            ></i>
          </button>
        </div>

        <div v-if="error" class="icon-error">{{ error }}</div>
        <div class="icon-hint">{{ t("jobIcons.uploadHint") }}</div>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        style="display: none"
        @change="onFile"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { t } from "../i18n";
import JobIcon from "./JobIcon.vue";
import {
  BUILT_IN_JOB_ICONS,
  customIcons,
  loadJobIcons,
  removeJobIcon,
  uploadJobIcon,
} from "../composables/jobIcons";

defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ "update:modelValue": [string | null] }>();

const open = ref(false);
const uploading = ref(false);
const error = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(() => loadJobIcons());

function choose(icon: string | null) {
  emit("update:modelValue", icon);
  open.value = false;
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // so re-picking the same file fires change again
  if (!file) return;
  uploading.value = true;
  error.value = "";
  try {
    const icon = await uploadJobIcon(file);
    choose(`custom:${icon.name}`);
  } catch (err: any) {
    error.value = err.response?.data?.error ?? err.message;
  } finally {
    uploading.value = false;
  }
}

async function removeIcon(name: string) {
  error.value = "";
  try {
    await removeJobIcon(name);
  } catch (err: any) {
    error.value = err.response?.data?.error ?? err.message;
  }
}
</script>

<style scoped>
.icon-picker {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.icon-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
}

.icon-trigger:hover {
  border-color: var(--border-strong);
}

.icon-trigger-caret {
  font-size: 10px;
  color: var(--text-faint);
}

.icon-clear {
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 4px;
}

.icon-clear:hover {
  color: var(--danger);
}

.icon-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 60;
  width: 296px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
}

.icon-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-faint);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.icon-panel-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-faint);
}

.icon-scroll {
  max-height: 320px;
  overflow-y: auto;
  padding: 10px 12px 12px;
}

.icon-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin: 8px 0 6px;
}

.icon-group-count {
  color: var(--text-disabled);
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
}

.icon-cell {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-inset);
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 14px;
}

.icon-cell:hover {
  background: var(--bg-inset);
}

.icon-cell-active {
  border-color: var(--info);
  background: var(--primary-soft);
  color: var(--info);
}

.icon-cell img {
  width: 70%;
  height: 70%;
  object-fit: contain;
}

.icon-cell-remove {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 14px;
  height: 14px;
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--danger);
  color: var(--text-on-accent);
  border-radius: 50%;
  font-size: 8px;
}

.icon-cell:hover .icon-cell-remove {
  display: flex;
}

.icon-cell-upload {
  border: 1px dashed var(--border-strong);
  background: var(--bg-card);
  color: var(--text-faint);
}

.icon-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger-soft-text);
}

.icon-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
</style>
