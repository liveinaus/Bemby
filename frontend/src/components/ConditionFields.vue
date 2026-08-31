<template>
  <div class="form-group" style="margin-bottom:0">
    <label class="form-label">{{ label }}</label>
    <select v-model="cond.check" class="form-select">
      <option value="reply_text">{{ t('jobs.custom.checkReplyText') }}</option>
      <option value="last_action">{{ t('jobs.custom.checkLastAction') }}</option>
    </select>
    <label class="form-check" style="margin-top:8px">
      <input type="checkbox" v-model="cond.negate" />
      {{ t('jobs.custom.labelNegate') }}
    </label>
    <div v-if="hint" style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ hint }}</div>
  </div>

  <!-- reply_text -->
  <template v-if="cond.check === 'reply_text'">
    <div class="form-group" style="margin-bottom:0;margin-top:8px">
      <label class="form-label">{{ t('jobs.custom.labelCheckText') }}</label>
      <input v-model.trim="cond.text" class="form-input" :placeholder="t('jobs.custom.checkTextPlaceholder')" />
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.checkTextHint') }}</div>
    </div>
    <div class="form-row" style="margin-bottom:0;margin-top:8px">
      <div class="form-group">
        <label class="form-label">{{ durationLabel(t('jobs.custom.labelCheckWait')) }}</label>
        <NumberInput v-model="cond.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.checkWaitHint') }}</div>
      </div>
      <div class="form-group">
        <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
        <input v-model.number="cond.scope" class="form-input" type="number" max="0" step="1" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0;margin-top:8px">
      <label class="form-label">{{ t('jobs.custom.labelContactOptional') }}</label>
      <input v-model.trim="cond.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contactOptionalHint') }}</div>
    </div>
  </template>

  <!-- last_action -->
  <div v-else class="form-group" style="margin-bottom:0;margin-top:8px">
    <label class="form-label">{{ t('jobs.custom.labelCheckOutcome') }}</label>
    <select v-model="cond.outcome" class="form-select">
      <option value="failed">{{ t('jobs.custom.outcomeFailed') }}</option>
      <option value="succeeded">{{ t('jobs.custom.outcomeSucceeded') }}</option>
    </select>
    <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.checkOutcomeHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n';
import NumberInput from './NumberInput.vue';
import { msScale, durationLabel } from '../composables/preferSeconds';
import type { ConditionForm } from '../composables/customActions';

// The fields of one `if_check` arm. Edited in place: the form object belongs to the action
// the editor above holds, and there is nothing to convert on the way in or out.
defineProps<{ cond: ConditionForm; label: string; hint?: string }>();
</script>
