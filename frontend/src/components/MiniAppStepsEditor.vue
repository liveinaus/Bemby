<template>
  <div>
    <div class="app-steps-heading">
      <label class="form-label" style="margin: 0">{{ heading.label }}</label>
      <button
        v-if="steps.length > 1"
        type="button"
        class="btn btn-ghost btn-sm app-fold-all"
        @click="foldAll(anyOpen)"
      >
        <i :class="anyOpen ? 'fa-solid fa-angles-up' : 'fa-solid fa-angles-down'"></i>
        {{ anyOpen ? t("jobs.web.collapseAll") : t("jobs.web.expandAll") }}
      </button>
    </div>
    <div style="font-size: 11px; color: var(--text-faint); margin: -2px 0 6px">
      {{ heading.hint }}
    </div>

    <div v-for="(s, i) in steps" :key="i" class="app-step-card">
      <div class="app-step-header">
        <button
          type="button"
          class="app-fold"
          :title="s.collapsed ? t('jobs.web.expandStep') : t('jobs.web.collapseStep')"
          @click="s.collapsed = !s.collapsed"
        >
          <i :class="s.collapsed ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down'"></i>
        </button>
        <span class="app-step-num">{{ i + 1 }}</span>
        <select v-model="s.type" class="form-select app-step-type" @change="onTypeChange(s)">
          <option
            v-for="ty in typesFor(s.type)"
            :key="ty"
            :value="ty"
            :disabled="aiKeyMissing && AI_MINI_APP_STEP_TYPES.includes(ty)"
          >
            {{ typeLabel(ty)
            }}{{
              aiKeyMissing && AI_MINI_APP_STEP_TYPES.includes(ty)
                ? " (" + t("jobs.noApiKey") + ")"
                : ""
            }}
          </option>
        </select>
        <RowControls
          :index="i"
          :count="steps.length"
          @move="move(i, $event)"
          @insert="insertAfter(i)"
          @remove="remove(i)"
        />
      </div>

      <!-- What a folded step does, so a shut list is still readable -->
      <div v-if="s.collapsed" class="app-step-summary" @click="s.collapsed = false">
        {{ stepSummary(s) }}
      </div>

      <div v-show="!s.collapsed" class="app-step-body">
        <!-- A row this build cannot read. Left exactly as it came unless the type is changed -->
        <div v-if="s.raw" class="app-step-unknown app-step-wide">
          {{ t("jobs.custom.appStepUnknown").replace("{row}", s.raw) }}
        </div>

        <template v-else>
          <div v-if="s.type === 'label'">
            <label class="form-label">{{ t("jobs.custom.appStepLabelText") }}</label>
            <input
              v-model.trim="s.text"
              class="form-input"
              :placeholder="t('jobs.custom.appStepLabelPlaceholder')"
            />
            <div class="app-field-hint">{{ t("jobs.custom.appStepLabelHint") }}</div>
          </div>

          <div v-if="s.type === 'css'">
            <label class="form-label">{{ t("jobs.custom.appStepSelector") }}</label>
            <input
              v-model.trim="s.selector"
              class="form-input"
              :placeholder="t('jobs.custom.appStepSelectorPlaceholder')"
            />
            <div class="app-field-hint">{{ t("jobs.custom.appStepSelectorHint") }}</div>
          </div>

          <div v-if="s.type === 'delay'">
            <label class="form-label">{{ durationLabel(t("jobs.custom.appStepDelay")) }}</label>
            <NumberInput
              v-model="s.waitMs"
              class="form-input"
              :min="0"
              :step="1000"
              :scale="msScale"
            />
            <div class="app-field-hint">{{ t("jobs.custom.appStepDelayHint") }}</div>
          </div>

          <template v-if="s.type === 'scroll'">
            <div>
              <label class="form-label">{{ t("jobs.custom.appStepScrollMode") }}</label>
              <select v-model="s.scrollMode" class="form-select">
                <option value="pixels">{{ t("jobs.custom.appStepScrollPixels") }}</option>
                <option value="selector">{{ t("jobs.custom.appStepScrollSelector") }}</option>
              </select>
              <div class="app-field-hint">{{ t("jobs.custom.appStepScrollHint") }}</div>
            </div>
            <div v-if="s.scrollMode === 'selector'">
              <label class="form-label">{{ t("jobs.custom.appStepSelector") }}</label>
              <input
                v-model.trim="s.scrollSelector"
                class="form-input"
                :placeholder="t('jobs.custom.appStepScrollSelectorPlaceholder')"
              />
            </div>
            <div v-else class="form-row app-step-wide">
              <div class="form-group">
                <label class="form-label">{{ t("jobs.custom.appStepScrollX") }}</label>
                <NumberInput v-model="s.scrollX" class="form-input" :step="100" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t("jobs.custom.appStepScrollY") }}</label>
                <NumberInput v-model="s.scrollY" class="form-input" :step="100" />
              </div>
            </div>
          </template>

          <div v-if="s.type === 'aiBtn'">
            <label class="form-label">{{ t("jobs.custom.appStepAiHint") }}</label>
            <input
              v-model.trim="s.hint"
              class="form-input"
              :placeholder="t('jobs.custom.appStepAiHintPlaceholder')"
            />
            <div class="app-field-hint">{{ t("jobs.custom.appStepAiHintHint") }}</div>
          </div>

          <div
            v-if="s.type === 'turnstile' || s.type === 'input' || s.type === 'aiInput'"
            class="app-step-wide app-field-hint"
            style="margin: 0"
          >
            {{ typeHint(s.type) }}
          </div>

          <!-- A branch: what it asks about, and a list of steps for each answer -->
          <div v-if="s.type === 'if'" class="app-step-wide">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t("jobs.web.labelCheck") }}</label>
                <select v-model="s.check" class="form-select">
                  <option value="element">{{ t("jobs.custom.appCheckElement") }}</option>
                  <option value="text">{{ t("jobs.custom.appCheckText") }}</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  s.check === "element"
                    ? t("jobs.custom.appStepSelector")
                    : t("jobs.web.labelWords")
                }}</label>
                <input
                  v-if="s.check === 'element'"
                  v-model.trim="s.selector"
                  class="form-input"
                  :placeholder="t('jobs.custom.appStepSelectorPlaceholder')"
                />
                <input
                  v-else
                  v-model.trim="s.text"
                  class="form-input"
                  :placeholder="t('jobs.custom.appIfWordsPlaceholder')"
                />
              </div>
            </div>
            <div class="app-field-hint">{{ t("jobs.custom.appIfHint") }}</div>

            <label class="form-checkbox-label" style="margin-top: 8px">
              <input v-model="s.negate" type="checkbox" />
              {{ t("jobs.web.labelNegate") }}
            </label>
            <div class="app-field-hint">{{ t("jobs.custom.appNegateHint") }}</div>

            <div class="app-branch-body app-branch-then">
              <MiniAppStepsEditor
                :steps="s.steps"
                :ai-key-missing="aiKeyMissing"
                :depth="(depth ?? 0) + 1"
                role="then"
              />
            </div>
            <div class="app-branch-body app-branch-else">
              <MiniAppStepsEditor
                :steps="s.elseSteps"
                :ai-key-missing="aiKeyMissing"
                :depth="(depth ?? 0) + 1"
                role="else"
              />
            </div>
          </div>

          <!-- Every type but a branch, which is only as good as the steps inside its arms -->
          <div v-if="s.type !== 'if'" class="app-step-wide">
            <label class="form-checkbox-label" style="margin-top: 8px">
              <input v-model="s.continueAfterFail" type="checkbox" />
              {{ t("jobs.web.labelContinueAfterFail") }}
            </label>
            <div class="app-field-hint">{{ t("jobs.custom.appContinueAfterFailHint") }}</div>
          </div>
        </template>
      </div>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.custom.addInAppStep") }}
    </button>

    <div v-if="!depth" style="font-size: 11px; color: var(--text-faint); margin-top: 6px">
      {{ t("jobs.custom.inAppButtonHint") }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import NumberInput from "./NumberInput.vue";
import RowControls from "./RowControls.vue";
import { durationLabel, msScale } from "../composables/preferSeconds";
import {
  AI_MINI_APP_STEP_TYPES,
  blankMiniAppStep,
  offeredMiniAppStepTypes,
  type MiniAppStepForm,
  type MiniAppStepType,
} from "../composables/miniAppSteps";

// Mutated in place: the parent holds the list inside its own action form object, the same way
// the web steps editor is given its list.
const props = defineProps<{
  steps: MiniAppStepForm[];
  aiKeyMissing: boolean;
  depth?: number;
  /** Which heading to show: the action's own steps, or one arm of a branch. */
  role?: "steps" | "then" | "else";
}>();

const heading = computed(() => {
  switch (props.role) {
    case "then":
      return { label: t("jobs.web.thenStepsLabel"), hint: t("jobs.custom.appThenStepsHint") };
    case "else":
      return { label: t("jobs.web.elseStepsLabel"), hint: t("jobs.custom.appElseStepsHint") };
    default:
      return { label: t("jobs.custom.labelInAppButton"), hint: t("jobs.custom.appStepsHint") };
  }
});

/** Per step, so one already saved as a branch keeps that type on offer at any depth. */
function typesFor(current: MiniAppStepType): MiniAppStepType[] {
  return offeredMiniAppStepTypes(props.depth ?? 0, current);
}

function typeLabel(ty: MiniAppStepType): string {
  return t(`jobs.custom.appStepType.${ty}`);
}

function typeHint(ty: MiniAppStepType): string {
  return t(`jobs.custom.appStepHint.${ty}`);
}

/** A step's one line when it is folded shut. */
function stepSummary(s: MiniAppStepForm): string {
  if (s.raw) return s.raw;
  const carry = s.continueAfterFail ? ` · ${t("jobs.custom.appSummaryOptional")}` : "";
  switch (s.type) {
    case "label":
      return `${typeLabel(s.type)}: ${s.text || "—"}${carry}`;
    case "css":
      return `${typeLabel(s.type)}: ${s.selector || "—"}${carry}`;
    case "delay":
      return `${typeLabel(s.type)}: ${s.waitMs}ms${carry}`;
    case "scroll":
      return (
        `${typeLabel(s.type)}: ` +
        (s.scrollMode === "selector"
          ? s.scrollSelector || "—"
          : `${s.scrollX}, ${s.scrollY}`) +
        carry
      );
    case "aiBtn":
      return `${typeLabel(s.type)}${s.hint ? `: ${s.hint}` : ""}${carry}`;
    case "if": {
      const asked = s.check === "element" ? s.selector : s.text;
      const arms = t("jobs.custom.appSummaryArms")
        .replace("{then}", String(s.steps.length))
        .replace("{else}", String(s.elseSteps.length));
      return `${typeLabel(s.type)}: ${s.negate ? "!" : ""}${asked || "—"} · ${arms}`;
    }
    default:
      return `${typeLabel(s.type)}${carry}`;
  }
}

// A step switched to a type with no fields in common keeps the rest of its form, the way the
// web editor does, so switching back and forth loses nothing typed into the other type
function onTypeChange(s: MiniAppStepForm) {
  if (s.raw) delete s.raw;
  if (s.type === "delay" && !s.waitMs) s.waitMs = 5000;
}

const anyOpen = computed(() => props.steps.some((s) => !s.collapsed));

function foldAll(shut: boolean) {
  const walk = (list: MiniAppStepForm[]) => {
    for (const s of list) {
      s.collapsed = shut;
      if (s.steps.length) walk(s.steps);
      if (s.elseSteps.length) walk(s.elseSteps);
    }
  };
  walk(props.steps);
}

function add() {
  props.steps.push(blankMiniAppStep());
}

function insertAfter(i: number) {
  props.steps.splice(i + 1, 0, blankMiniAppStep());
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
.app-step-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--bg-card);
}

.app-step-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.app-steps-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.app-fold-all {
  font-size: 11px;
  padding: 2px 6px;
}

.app-fold {
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1;
  flex: none;
}

.app-fold:hover {
  color: var(--info);
}

.app-step-summary {
  font-size: 12px;
  color: var(--text-tertiary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: -4px 0 2px 26px;
}

.app-step-summary:hover {
  color: var(--text-secondary);
}

/* The two arms of a branch, told apart by colour: taken on yes, taken on no */
.app-branch-body {
  margin-top: 10px;
  padding-left: 10px;
}

.app-branch-then {
  border-left: 2px solid var(--success);
}

.app-branch-else {
  border-left: 2px solid var(--warning);
}

/* A row this build cannot edit: warned about rather than hidden, since it still runs */
.app-step-unknown {
  font-size: 11px;
  color: var(--warning-soft-text);
  background: var(--warning-soft);
  border: 1px solid var(--warning-border);
  border-radius: 4px;
  padding: 6px 8px;
}

.app-step-num {
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

.app-step-type {
  flex: 1;
  min-width: 0;
  max-width: 340px;
  margin-right: auto;
}

.app-field-hint {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 3px;
}

/* Same grid as the web editor: one field per row when narrow, two when there is room, and a
   block that lays out rows of its own keeps the full width */
.app-step-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, max(300px, (100% - 14px) / 2)), 1fr));
  gap: 8px 14px;
  align-items: start;
}

.app-step-wide {
  grid-column: 1 / -1;
}
</style>
