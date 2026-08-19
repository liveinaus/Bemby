<template>
  <div>
    <label class="form-label">{{ t("jobs.custom.labelInAppButton") }}</label>

    <div v-for="(_, i) in steps" :key="i" class="mini-step-row">
      <span class="mini-step-num">{{ i + 1 }}</span>
      <input
        v-model.trim="steps[i]"
        class="form-input mini-step-input"
        :list="tokenListId"
        :placeholder="t('jobs.custom.inAppStepPlaceholder')"
      />
      <RowControls
        :index="i"
        :count="steps.length"
        @move="move(i, $event)"
        @insert="insertAfter(i)"
        @remove="remove(i)"
      />
    </div>

    <button type="button" class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.custom.addInAppStep") }}
    </button>

    <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
      {{ t("jobs.custom.inAppButtonHint") }}
    </div>

    <!-- The tokens worth suggesting; the field stays free text, since a step is usually the
         button's own label -->
    <datalist :id="tokenListId">
      <option v-for="tok in COMMON_TOKENS" :key="tok" :value="tok" />
    </datalist>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance } from "vue";
import { t } from "../i18n";
import RowControls from "./RowControls.vue";

// Mutated in place: the parent holds the list inside its own action form object, the same way
// the web steps editor is given its list.
const props = defineProps<{ steps: string[] }>();

const COMMON_TOKENS = [
  "delay(10000)",
  "scroll(0, 99999)",
  "scroll(css:#footer)",
  "css:",
  "{turnstile}",
  "{aiBtn}",
  "{input}",
  "{aiInput}",
];

// One datalist per instance: an action list shows several of these editors at once
const tokenListId = `mini-app-tokens-${getCurrentInstance()?.uid ?? 0}`;

function add() {
  props.steps.push("");
}

function insertAfter(i: number) {
  props.steps.splice(i + 1, 0, "");
}

function remove(i: number) {
  props.steps.splice(i, 1);
}

function move(i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= props.steps.length) return;
  const [item] = props.steps.splice(i, 1);
  props.steps.splice(to, 0, item);
}
</script>

<style scoped>
.mini-step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.mini-step-input {
  flex: 1;
  min-width: 0;
}

.mini-step-num {
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--info);
  color: var(--text-on-accent);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
</style>
