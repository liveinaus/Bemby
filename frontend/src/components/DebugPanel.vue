<template>
  <div class="debug-panel">
    <div class="debug-panel-title">{{ t("logs.debug.title") }}</div>
    <img
      v-for="(src, i) in images"
      :key="i"
      :src="src"
      class="debug-panel-img"
      alt=""
    />
    <textarea
      v-model="prompt"
      class="debug-panel-textarea"
      rows="14"
      :placeholder="t('logs.debug.promptPlaceholder')"
    />
    <div class="debug-panel-controls">
      <span class="debug-tokens-label">{{ t("logs.debug.model") }}</span>
      <select v-model="model" class="form-select debug-model-input">
        <option value="">{{ t("logs.debug.modelDefault") }}</option>
        <optgroup v-for="sup in suppliers" :key="sup.id" :label="sup.name">
          <option v-for="m in sup.models" :key="m.id" :value="m.model_id">
            {{ m.model_id }}
          </option>
        </optgroup>
      </select>
      <span class="debug-tokens-label">{{ t("logs.debug.maxTokens") }}</span>
      <input
        v-model.number="maxTokens"
        class="form-input debug-tokens-input"
        type="number"
        min="10"
        max="100000"
        step="100"
      />
    </div>
    <div class="debug-panel-actions">
      <button
        class="btn btn-primary btn-sm"
        :disabled="running"
        @click="$emit('run')"
      >
        {{ running ? t("logs.debug.running") : t("logs.debug.run") }}
      </button>
      <button class="btn btn-ghost btn-sm" @click="$emit('close')">
        {{ t("logs.debug.close") }}
      </button>
    </div>
    <div v-if="response != null" class="debug-panel-response">
      <div class="dev-block-label">
        {{ t("logs.debug.response")
        }}{{
          durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : ""
        }}
      </div>
      <pre class="dev-block-pre">{{ response }}</pre>
    </div>
    <!-- Its own error style: the log view's is scoped to that component, so borrowing it
         here left the text in the inherited colour, unreadable on this panel -->
    <div v-if="error" class="debug-panel-error">
      {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AiSupplier } from "../api/client";
import { t } from "../i18n";

defineProps<{
  images: string[];
  suppliers: AiSupplier[];
  running: boolean;
  response: string | null;
  error: string | null;
  durationMs: number | null;
}>();

defineEmits<{ run: []; close: [] }>();

const prompt = defineModel<string>("prompt", { required: true });
const model = defineModel<string>("model", { required: true });
const maxTokens = defineModel<number>("maxTokens", { required: true });
</script>

<style>
.debug-panel {
  display: flex;
  flex-direction: column;
  margin-top: 10px;
  padding: 12px;
  background: #12122a;
  border: 1px solid #2d2d5c;
  border-radius: 6px;
}

.debug-panel-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #89b4fa;
  margin-bottom: 8px;
}

.debug-panel-img {
  display: block;
  width: 100%;
  max-height: 420px;
  object-fit: contain;
  object-position: left;
  border-radius: 4px;
  margin-bottom: 8px;
  opacity: 0.9;
}

.debug-panel-textarea {
  width: 100%;
  box-sizing: border-box;
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 4px;
  color: #cdd6f4;
  font-size: 12px;
  font-family: monospace;
  padding: 8px;
  line-height: 1.5;
  resize: vertical;
  /* A prompt runs to dozens of lines and is meant to be edited, so it gets the room */
  min-height: 160px;
  max-height: 60vh;
}

.debug-panel-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: nowrap;
}

.debug-panel-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.debug-tokens-label {
  font-size: 11px;
  color: #9399b2;
  white-space: nowrap;
}

.debug-tokens-input {
  width: 80px !important;
  padding: 4px 8px !important;
  font-size: 12px !important;
}

.debug-model-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px !important;
  font-size: 12px !important;
}

.debug-panel-response {
  margin-top: 10px;
}

.debug-panel-response .dev-block-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6366f1;
  margin-bottom: 4px;
}

.debug-panel-response .dev-block-pre {
  margin: 0;
  font-size: 12px;
  color: #cdd6f4;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: monospace;
  line-height: 1.6;
  /* Long replies scroll here rather than pushing the run button off the screen */
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 4px;
}

.debug-panel-error {
  margin-top: 10px;
  padding: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: #f38ba8;
  background: rgba(243, 139, 168, 0.1);
  border: 1px solid rgba(243, 139, 168, 0.35);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
</style>
