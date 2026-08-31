<template>
  <div>
    <div class="web-steps-heading">
      <label class="form-label" style="margin: 0">{{ heading.label }}</label>
      <!-- Folding the lot is what makes a long chain readable: the branches and their arms
           come down to one line each, so the shape of the run can be seen without scrolling -->
      <button
        v-if="steps.length > 1"
        type="button"
        class="btn btn-ghost btn-sm web-fold-all"
        @click="foldAll(anyOpen)"
      >
        <i :class="anyOpen ? 'fa-solid fa-angles-up' : 'fa-solid fa-angles-down'"></i>
        {{ anyOpen ? t("jobs.web.collapseAll") : t("jobs.web.expandAll") }}
      </button>
    </div>
    <div style="font-size: 11px; color: var(--text-faint); margin: -2px 0 6px">
      {{ heading.hint }}
    </div>

    <div v-for="(s, i) in steps" :key="i" class="web-step-card">
      <div class="web-step-header">
        <button
          type="button"
          class="web-fold"
          :title="s.collapsed ? t('jobs.web.expandStep') : t('jobs.web.collapseStep')"
          @click="s.collapsed = !s.collapsed"
        >
          <i :class="s.collapsed ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down'"></i>
        </button>
        <span class="web-step-num">{{ i + 1 }}</span>
        <select v-model="s.type" class="form-select web-step-type">
          <option
            v-for="ty in typesFor(s.type)"
            :key="ty"
            :value="ty"
            :disabled="aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)"
          >
            {{ typeLabel(ty)
            }}{{
              aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)
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

      <!-- What the step does, for a card that is folded shut: without it a collapsed list is a
           column of type names, which is not enough to find the step being looked for -->
      <div v-if="s.collapsed" class="web-step-summary" @click="s.collapsed = false">
        {{ stepSummary(s) }}
      </div>

      <div v-show="!s.collapsed">
      <!-- A step this build has no fields for. Left as it is unless the type is changed -->
      <div v-if="s.unknown && s.unknown.type === s.type" class="web-step-unknown">
        {{ t("jobs.web.unknownStep").replace("{type}", s.type) }}
      </div>

      <!-- CSS selector: every type but the screenshot-driven AI ones and the plain delay -->
      <div
        v-if="
          s.type === 'web_input' ||
          s.type === 'web_button' ||
          s.type === 'web_wait_element' ||
          s.type === 'web_scroll_to' ||
          s.type === 'web_pick' ||
          s.type === 'web_collect' ||
          s.type === 'web_read' ||
          s.type === 'web_select' ||
          s.type === 'web_press' ||
          s.type === 'web_hold' ||
          s.type === 'web_hold_offset' ||
          s.type === 'web_drag' ||
          s.type === 'web_ai_input'
        "
      >
        <label class="form-label">{{
          s.type === "web_drag"
            ? t("jobs.web.labelDragFrom")
            : s.type === "web_hold_offset"
              ? t("jobs.web.labelAnchor")
              : t("jobs.web.labelSelector")
        }}</label>
        <input
          v-model.trim="s.selector"
          class="form-input"
          :placeholder="t('jobs.web.selectorPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{
            s.type === "web_press"
              ? t("jobs.web.pressSelectorHint")
              : s.type === "web_hold_offset"
                ? t("jobs.web.anchorHint")
                : t("jobs.web.selectorHint")
          }}
        </div>
      </div>

      <!-- Values of your own, for the steps after them to use. Several in one step, since a
           later one is often built out of the ones above it -->
      <div v-if="s.type === 'web_set'">
        <div class="web-var-row web-var-head">
          <label class="form-label" style="margin: 0">{{ t("jobs.web.labelVarName") }}</label>
          <label class="form-label" style="margin: 0">{{ t("jobs.web.labelSetValue") }}</label>
          <span></span>
        </div>
        <div v-for="(v, vi) in s.vars" :key="vi" class="web-var-row">
          <input
            v-model.trim="v.name"
            class="form-input"
            :placeholder="t('jobs.web.setNamePlaceholder')"
          />
          <input
            v-model="v.value"
            class="form-input"
            :placeholder="t('jobs.web.setValuePlaceholder')"
          />
          <div class="web-var-controls">
            <RowControls
              :index="vi"
              :count="s.vars.length"
              @move="moveVar(s, vi, $event)"
              @insert="s.vars.splice(vi + 1, 0, { name: '', value: '' })"
              @remove="s.vars.splice(vi, 1)"
            />
          </div>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          @click="s.vars.push({ name: '', value: '' })"
        >
          <i class="fa-solid fa-plus"></i> {{ t("jobs.web.addVar") }}
        </button>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 6px">
          {{ t("jobs.web.setHint") }}
        </div>
      </div>

      <!-- The data store: which folder, which record, and which field of its value -->
      <div v-if="DATA_WEB_STEP_TYPES.includes(s.type)">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataFolder") }}</label>
            <input
              v-model.trim="s.folder"
              class="form-input"
              :list="folderListId"
              :placeholder="t('jobs.web.dataFolderPlaceholder')"
            />
          </div>
          <!-- The pick step takes a place in the folder; the key is what it hands back -->
          <div v-if="s.type === 'web_data_pick'" class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataIndex") }}</label>
            <input
              v-model.trim="s.index"
              class="form-input"
              :placeholder="t('jobs.web.dataIndexPlaceholder')"
            />
          </div>
          <div v-else class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataKey") }}</label>
            <input
              v-model.trim="s.recordKey"
              class="form-input"
              :placeholder="t('jobs.web.dataKeyPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataPath") }}</label>
            <input
              v-model.trim="s.path"
              class="form-input"
              :placeholder="t('jobs.web.dataPathPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{
            s.type === "web_data_pick"
              ? t("jobs.web.dataPickTargetHint")
              : t("jobs.web.dataTargetHint")
          }}
        </div>

        <div v-if="s.type === 'web_data_read'" class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelVarName") }}</label>
          <input
            v-model.trim="s.varName"
            class="form-input"
            :placeholder="t('jobs.web.readNamePlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.dataReadHint") }}
          </div>
        </div>

        <!-- What the pick hands back: the record's key, and its value if a name is given -->
        <div v-if="s.type === 'web_data_pick'" style="margin-top: 8px">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t("jobs.web.labelPickKeyVar") }}</label>
              <input
                v-model.trim="s.varName"
                class="form-input"
                :placeholder="t('jobs.web.pickKeyVarPlaceholder')"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("jobs.web.labelPickValueVar") }}</label>
              <input
                v-model.trim="s.valueVar"
                class="form-input"
                :placeholder="t('jobs.web.pickValueVarPlaceholder')"
              />
            </div>
          </div>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.dataPickHint") }}
          </div>
        </div>

        <div v-if="s.type === 'web_data_save'" class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelDataValue") }}</label>
          <textarea
            v-model="s.value"
            class="form-input"
            rows="2"
            style="resize: vertical"
            :placeholder="t('jobs.web.dataValuePlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.dataSaveHint") }}
          </div>
        </div>

        <template v-if="s.type !== 'web_data_save'">
          <label class="form-checkbox-label" style="margin-top: 8px">
            <input v-model="s.optional" type="checkbox" />
            {{ t("jobs.web.labelDataOptional") }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.dataOptionalHint") }}
          </div>
        </template>
      </div>

      <!-- Read a code out of a mailbox: the password is a secret's name, never the value -->
      <div v-if="s.type === 'web_email_code'">
        <!-- Only where the deployment offers the pool, or on a step already saved as one:
             with it off the step is the Gmail one it has always been -->
        <div
          v-if="msApiAvailable || s.emailSource === 'msapi'"
          class="form-group"
        >
          <label class="form-label">{{ t("jobs.web.labelEmailSource") }}</label>
          <select v-model="s.emailSource" class="form-select">
            <option value="gmail">{{ t("jobs.web.emailSourceGmail") }}</option>
            <option value="msapi" :disabled="!msApiEnabled">
              {{ t("jobs.web.emailSourceMsApi") }}
            </option>
          </select>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{
              msApiEnabled
                ? t("jobs.web.emailSourceHint")
                : t("jobs.web.msApiNotConfigured")
            }}
          </div>
        </div>

        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelEmail") }}</label>
            <input
              v-model.trim="s.email"
              class="form-input"
              :placeholder="t('jobs.web.emailPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelCodeVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.codeVarNamePlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.emailCodeHint") }}
        </div>

        <div v-if="s.emailSource !== 'msapi'" class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelAppPassword") }}</label>
          <input
            v-model.trim="s.appPassword"
            class="form-input"
            :placeholder="t('jobs.web.appPasswordPlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.appPasswordHint") }}
          </div>
        </div>

        <div v-else class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelPoolType") }}</label>
          <input
            v-model.trim="s.poolType"
            class="form-input"
            :placeholder="t('jobs.web.poolTypePlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.poolTypeHint") }}
          </div>
        </div>

        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelFromContains") }}</label>
            <input
              v-model.trim="s.fromContains"
              class="form-input"
              :placeholder="t('jobs.web.fromContainsPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelSubjectContains") }}</label>
            <input
              v-model.trim="s.subjectContains"
              class="form-input"
              :placeholder="t('jobs.web.subjectContainsPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.mailFilterHint") }}
        </div>

        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelCodePattern") }}</label>
            <input
              v-model.trim="s.pattern"
              class="form-input"
              :placeholder="t('jobs.web.codePatternPlaceholder')"
            />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.codePatternHint") }}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelMailWait")) }}</label>
            <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.mailWaitHint") }}
            </div>
          </div>
        </div>
      </div>

      <!-- Take an address from the msOauth2api pool for a signup form to use -->
      <div v-if="s.type === 'web_email_lease'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelEmailVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.emailVarNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelPoolType") }}</label>
            <input
              v-model.trim="s.poolType"
              class="form-input"
              :placeholder="t('jobs.web.poolTypePlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.emailLeaseHint") }}
        </div>
      </div>

      <!-- Pointing the job at another template once its first purpose is served -->
      <div v-if="s.type === 'web_job_handover'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelHandoverTemplate") }}</label>
            <input
              v-model.trim="s.jobTemplate"
              class="form-input"
              :placeholder="t('jobs.web.handoverTemplatePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelHandoverName") }}</label>
            <input
              v-model.trim="s.jobName"
              class="form-input"
              :placeholder="t('jobs.web.handoverNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelHandoverEnabled") }}</label>
            <select v-model="s.jobEnabled" class="form-select">
              <option value="">{{ t("jobs.web.handoverEnabledLeave") }}</option>
              <option value="on">{{ t("jobs.web.handoverEnabledOn") }}</option>
              <option value="off">{{ t("jobs.web.handoverEnabledOff") }}</option>
            </select>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.handoverHint") }}
        </div>
      </div>

      <!-- The enrolment secret off a 2FA setup page: no selector needed, so it gets a block
           of its own rather than the shared selector field -->
      <div v-if="s.type === 'web_otp_secret'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTotpVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.otpSecretVarNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelOtpSecretScope") }}</label>
            <input
              v-model.trim="s.selector"
              class="form-input"
              :placeholder="t('jobs.web.selectorPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelWaitMs")) }}</label>
            <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.otpSecretHint") }}
        </div>
      </div>

      <!-- The code an authenticator app would be showing, for a login guarded by 2FA -->
      <div v-if="s.type === 'web_totp'">
        <label class="form-label">{{ t("jobs.web.labelTotpSecret") }}</label>
        <input
          v-model.trim="s.secretRef"
          class="form-input"
          :placeholder="t('jobs.web.totpSecretPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.totpSecretHint") }}
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTotpVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.totpVarNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelTotpMinValid")) }}</label>
            <NumberInput
              v-model="s.minValidMs"
              class="form-input"
              :min="0"
              :step="1000"
              :scale="msScale"
            />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.totpMinValidHint") }}
            </div>
          </div>
        </div>
      </div>

      <!-- A script run the way the browser console runs one, for what no selector reaches -->
      <div v-if="s.type === 'web_eval'">
        <label class="form-label">{{ t("jobs.web.labelScript") }}</label>
        <textarea
          v-model="s.script"
          class="form-input"
          rows="4"
          style="resize: vertical; font-family: var(--font-mono, monospace)"
          :placeholder="t('jobs.web.scriptPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.scriptHint") }}
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelEvalVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.evalNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxChars") }}</label>
            <input v-model.number="s.maxChars" class="form-input" type="number" min="0" step="100" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelEvalWait")) }}</label>
            <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.evalNameHint") }}
        </div>
        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.secret" type="checkbox" />
          {{ t("jobs.web.labelReadSecret") }}
        </label>
      </div>

      <div v-if="s.type === 'web_notify'">
        <label class="form-label">{{ t("jobs.web.labelNotifyText") }}</label>
        <textarea
          v-model="s.text"
          class="form-input"
          rows="2"
          style="resize: vertical"
          :placeholder="t('jobs.web.notifyTextPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.notifyTextHint") }}
        </div>
        <div class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelNotifyTarget") }}</label>
          <input
            v-model.trim="s.target"
            class="form-input"
            :placeholder="t('jobs.web.notifyTargetPlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.notifyTargetHint") }}
          </div>
        </div>
      </div>

      <div v-if="s.type === 'web_hold'" style="margin-top: 8px">
        <label class="form-label">{{ durationLabel(t("jobs.web.labelHoldMs")) }}</label>
        <NumberInput v-model="s.holdMs" class="form-input" :min="0" :step="500" :scale="msScale" />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.holdHint") }}
        </div>
      </div>

      <!-- Press at an offset from an anchor: the anchor itself is only measured -->
      <div v-if="s.type === 'web_hold_offset'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelHoldFrom") }}</label>
        <select v-model="s.holdFrom" class="form-select">
          <option value="centre">{{ t("jobs.web.holdFromCentre") }}</option>
          <option value="topLeft">{{ t("jobs.web.holdFromTopLeft") }}</option>
        </select>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelOffsetX") }}</label>
            <input v-model.number="s.offsetX" class="form-input" type="number" step="5" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelOffsetY") }}</label>
            <input v-model.number="s.offsetY" class="form-input" type="number" step="5" />
          </div>
        </div>
        <div class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ durationLabel(t("jobs.web.labelHoldMs")) }}</label>
          <NumberInput v-model="s.holdMs" class="form-input" :min="0" :step="500" :scale="msScale" />
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.holdOffsetHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_drag'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelDragTo") }}</label>
        <input
          v-model.trim="s.toSelector"
          class="form-input"
          :placeholder="t('jobs.web.dragToPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.dragToHint") }}
        </div>
        <div v-if="!s.toSelector" class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDragX") }}</label>
            <input v-model.number="s.dragX" class="form-input" type="number" step="10" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDragY") }}</label>
            <input v-model.number="s.dragY" class="form-input" type="number" step="10" />
          </div>
        </div>
        <div class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ durationLabel(t("jobs.web.labelDragDuration")) }}</label>
          <NumberInput v-model="s.durationMs" class="form-input" :min="0" :step="100" :scale="msScale" />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.dragDurationHint") }}
          </div>
        </div>
      </div>

      <div v-if="s.type === 'web_press'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelKey") }}</label>
        <!-- A list of the usual ones, while staying a plain field: the keys worth pressing
             are far too many to enumerate, and any letter is one of them -->
        <input
          v-model.trim="s.key"
          class="form-input"
          :list="keyListId"
          :placeholder="t('jobs.web.keyPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.keyHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_select'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelOption") }}</label>
        <input
          v-model.trim="s.option"
          class="form-input"
          :placeholder="t('jobs.web.optionPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.optionHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.textPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.textHint") }}
        </div>
      </div>

      <!-- The address a goto opens, and the list a collect or a loop works with -->
      <div v-if="s.type === 'web_goto'">
        <label class="form-label">{{ t("jobs.web.labelUrl") }}</label>
        <input v-model.trim="s.url" class="form-input" :placeholder="t('jobs.web.gotoPlaceholder')" />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.gotoHint") }}
        </div>
      </div>

      <div
        v-if="s.type === 'web_pick' || s.type === 'web_collect' || s.type === 'web_read'"
        style="margin-top: 8px"
      >
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{
              s.type === "web_collect" ? t("jobs.web.labelListName") : t("jobs.web.labelVarName")
            }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="
                s.type === 'web_read'
                  ? t('jobs.web.readNamePlaceholder')
                  : t('jobs.web.varNamePlaceholder')
              "
            />
          </div>
          <div v-if="s.type !== 'web_read'" class="form-group">
            <label class="form-label">{{ t("jobs.web.labelAttribute") }}</label>
            <input
              v-model.trim="s.attribute"
              class="form-input"
              :placeholder="t('jobs.web.attributePlaceholder')"
            />
          </div>
          <div v-else class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxChars") }}</label>
            <input v-model.number="s.maxChars" class="form-input" type="number" min="0" step="100" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{
            s.type === "web_read"
              ? t("jobs.web.readHint")
              : s.type === "web_collect"
                ? t("jobs.web.collectHint")
                : t("jobs.web.pickHint")
          }}
        </div>
        <!-- A value that is a login of its own belongs nowhere near the run log -->
        <label v-if="s.type === 'web_read'" class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.secret" type="checkbox" />
          {{ t("jobs.web.labelReadSecret") }}
        </label>
        <div
          v-if="s.type === 'web_read'"
          style="font-size: 11px; color: var(--text-faint); margin-top: 3px"
        >
          {{ t("jobs.web.readSecretHint") }}
        </div>
      </div>

      <!-- Telegram's own login code, read off the account the job runs as -->
      <div v-if="s.type === 'web_tg_code'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelCodeVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.tgCodeVarNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelTgCodeWait")) }}</label>
            <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.tgCodeHint") }}
        </div>
        <div class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelCodePattern") }}</label>
          <input
            v-model.trim="s.pattern"
            class="form-input"
            :placeholder="t('jobs.web.tgCodePatternPlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.tgCodePatternHint") }}
          </div>
        </div>
      </div>

      <!-- A message sent as the account the job runs as, e.g. a site's linking command -->
      <div v-if="s.type === 'web_tg_send'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTgSendContact") }}</label>
            <input
              v-model.trim="s.contact"
              class="form-input"
              :placeholder="t('jobs.web.tgSendContactPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTgSendText") }}</label>
            <input
              v-model="s.text"
              class="form-input"
              :placeholder="t('jobs.web.tgSendTextPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.tgSendHint") }}
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTgSendReply") }}</label>
            <input
              v-model.trim="s.replyContains"
              class="form-input"
              :placeholder="t('jobs.web.tgSendReplyPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelTgSendVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.tgSendVarNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelTgSendWait")) }}</label>
            <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.tgSendReplyHint") }}
        </div>
      </div>

      <!-- The pair my.telegram.org hands back, written onto the account it belongs to -->
      <div v-if="s.type === 'web_tg_api_save'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelApiId") }}</label>
            <input
              v-model.trim="s.apiId"
              class="form-input"
              :placeholder="t('jobs.web.apiIdPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelApiHash") }}</label>
            <input
              v-model.trim="s.apiHash"
              class="form-input"
              :placeholder="t('jobs.web.apiHashPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.tgApiSaveHint") }}
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelApiCopyFolder") }}</label>
            <input
              v-model.trim="s.folder"
              class="form-input"
              :list="folderListId"
              :placeholder="t('jobs.web.apiCopyFolderPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataKey") }}</label>
            <input
              v-model.trim="s.recordKey"
              class="form-input"
              :placeholder="t('jobs.web.apiCopyKeyPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.apiCopyHint") }}
        </div>
      </div>

      <!-- First half: take the mailbox to the sign-in address msOauth2api hands out -->
      <div v-if="s.type === 'web_ms_oauth2_start'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMsEmail") }}</label>
            <input
              v-model.trim="s.msEmail"
              class="form-input"
              :placeholder="t('jobs.web.msEmailPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMsAuthType") }}</label>
            <select v-model="s.msAuthType" class="form-input">
              <option value="auto">{{ t("jobs.web.msAuthTypeAuto") }}</option>
              <option value="imap">{{ t("jobs.web.msAuthTypeImap") }}</option>
            </select>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.msStartHint") }}
        </div>
      </div>

      <!-- Second half: confirm with the service that the mailbox landed -->
      <div v-if="s.type === 'web_ms_oauth2'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMsEmail") }}</label>
            <input
              v-model.trim="s.msEmail"
              class="form-input"
              :placeholder="t('jobs.web.msEmailPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.msOauthVarPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.msOauthHint") }}
        </div>

        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataFolder") }}</label>
            <input
              v-model.trim="s.folder"
              class="form-input"
              :list="folderListId"
              :placeholder="t('jobs.web.msFolderPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataKey") }}</label>
            <input
              v-model.trim="s.recordKey"
              class="form-input"
              :placeholder="t('jobs.web.msKeyPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelDataPath") }}</label>
            <input
              v-model.trim="s.path"
              class="form-input"
              :placeholder="t('jobs.web.msPathPlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.msSaveHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_pick' || s.type === 'web_collect'" style="margin-top: 8px">
        <div class="form-group">
          <label class="form-label">{{ t("jobs.web.labelContainsText") }}</label>
          <input
            v-model.trim="s.containsText"
            class="form-input"
            :placeholder="t('jobs.web.containsTextPlaceholder')"
          />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.containsTextHint") }}
          </div>
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelPattern") }}</label>
            <input
              v-model.trim="s.pattern"
              class="form-input"
              :placeholder="t('jobs.web.patternPlaceholder')"
            />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.patternHint") }}
            </div>
          </div>
          <div v-if="s.type === 'web_pick'" class="form-group">
            <label class="form-label">{{ t("jobs.web.labelChoose") }}</label>
            <select v-model="s.choose" class="form-select">
              <option value="first">{{ t("jobs.web.chooseFirst") }}</option>
              <option value="random">{{ t("jobs.web.chooseRandom") }}</option>
            </select>
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.chooseHint") }}
            </div>
          </div>
          <div v-else class="form-group">
            <label class="form-label">{{ t("jobs.web.labelLimit") }}</label>
            <input v-model.number="s.limit" class="form-input" type="number" min="0" step="1" />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("jobs.web.limitHint") }}
            </div>
          </div>
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.skipUsed" type="checkbox" />
          {{ t("jobs.web.labelSkipUsed") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.skipUsedHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_if'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelCheck") }}</label>
            <select v-model="s.check" class="form-select">
              <option value="element">{{ t("jobs.web.checkElement") }}</option>
              <option value="text">{{ t("jobs.web.checkText") }}</option>
              <option value="url">{{ t("jobs.web.checkUrl") }}</option>
              <option value="value">{{ t("jobs.web.checkValue") }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{
              s.check === "element"
                ? t("jobs.web.labelSelector")
                : s.check === "value"
                  ? t("jobs.web.labelIfValue")
                  : t("jobs.web.labelWords")
            }}</label>
            <input
              v-if="s.check === 'element'"
              v-model.trim="s.selector"
              class="form-input"
              :placeholder="t('jobs.web.ifSelectorPlaceholder')"
            />
            <input
              v-else-if="s.check === 'value'"
              v-model.trim="s.value"
              class="form-input"
              :placeholder="t('jobs.web.ifValuePlaceholder')"
            />
            <input
              v-else
              v-model.trim="s.text"
              class="form-input"
              :placeholder="t('jobs.web.wordsPlaceholder')"
            />
          </div>
        </div>
        <!-- The words are what a value check narrows on; with none, holding anything counts -->
        <div v-if="s.check === 'value'" class="form-group" style="margin-top: 8px">
          <label class="form-label">{{ t("jobs.web.labelIfValueWords") }}</label>
          <input
            v-model.trim="s.text"
            class="form-input"
            :placeholder="t('jobs.web.wordsPlaceholder')"
          />
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ s.check === "value" ? t("jobs.web.ifValueHint") : t("jobs.web.ifHint") }}
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.negate" type="checkbox" />
          {{ t("jobs.web.labelNegate") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.negateHint") }}
        </div>

        <!-- Nothing is going to draw a value, so a value check has nothing to wait for -->
        <div v-if="s.check !== 'value'" style="margin-top: 8px">
          <label class="form-label">{{ durationLabel(t("jobs.web.labelIfWait")) }}</label>
          <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.ifWaitHint") }}
          </div>
        </div>

        <div class="web-branch-body web-branch-then">
          <WebStepsEditor
            :steps="s.steps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            :in-loop="inLoop"
            role="then"
          />
        </div>
        <div class="web-branch-body web-branch-else">
          <WebStepsEditor
            :steps="s.elseSteps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            :in-loop="inLoop"
            role="else"
          />
        </div>
      </div>

      <div v-if="s.type === 'web_repeat'">
        <div>
          <label class="form-label">{{ t("jobs.web.labelTimes") }}</label>
          <input v-model.number="s.times" class="form-input" type="number" min="1" step="1" />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.timesHint") }}
          </div>
        </div>

        <div style="margin-top: 8px">
          <label class="form-label">{{ durationLabel(t("jobs.web.labelBetween")) }}</label>
          <NumberInput v-model="s.betweenMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.betweenHint") }}
          </div>
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.continueOnError" type="checkbox" />
          {{ t("jobs.web.labelContinueOnError") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.continueOnErrorHint") }}
        </div>

        <!-- A loop's rounds: no loop inside a loop, which the nested list enforces -->
        <div class="web-loop-body">
          <WebStepsEditor
            :steps="s.steps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            in-loop
            role="loop"
          />
        </div>
      </div>

      <div v-if="s.type === 'web_for_each'">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelForEachName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.varNamePlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxRounds") }}</label>
            <input v-model.number="s.max" class="form-input" type="number" min="0" step="1" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.forEachHint") }}
        </div>

        <div style="margin-top: 8px">
          <label class="form-label">{{ durationLabel(t("jobs.web.labelBetween")) }}</label>
          <NumberInput v-model="s.betweenMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
            {{ t("jobs.web.betweenHint") }}
          </div>
        </div>

        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.continueOnError" type="checkbox" />
          {{ t("jobs.web.labelContinueOnError") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.continueOnErrorHint") }}
        </div>

        <div class="web-loop-body">
          <WebStepsEditor
            :steps="s.steps"
            :ai-key-missing="aiKeyMissing"
            :depth="(depth ?? 0) + 1"
            in-loop
            role="loop"
          />
        </div>
      </div>

      <div
        v-if="
          s.type === 'web_delay' ||
          s.type === 'web_wait_element' ||
          s.type === 'web_scroll_to' ||
          s.type === 'web_goto' ||
          s.type === 'web_back'
        "
        style="margin-top: 8px"
      >
        <label class="form-label">{{
          s.type === "web_delay" ? durationLabel(t("jobs.web.labelDelay")) : durationLabel(t("jobs.web.labelTimeout"))
        }}</label>
        <NumberInput v-model="s.waitMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{
            s.type === "web_delay" ? t("jobs.web.delayHint") : t("jobs.web.timeoutHint")
          }}
        </div>
      </div>

      <div v-if="s.type === 'web_scroll'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollX") }}</label>
            <input v-model.number="s.scrollX" class="form-input" type="number" step="100" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollY") }}</label>
            <input v-model.number="s.scrollY" class="form-input" type="number" step="100" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.scrollHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_turnstile'" style="font-size: 11px; color: var(--text-faint)">
        {{ t("jobs.web.turnstileHint") }}
      </div>

      <div v-if="s.type === 'web_back'" style="font-size: 11px; color: var(--text-faint)">
        {{ t("jobs.web.backHint") }}
      </div>

      <div
        v-if="
          s.type === 'ai_web_button' ||
          s.type === 'ai_web_input' ||
          s.type === 'ai_web_click_xy' ||
          s.type === 'ai_web_click_xy_multi'
        "
      >
        <label class="form-label">{{ t("jobs.web.labelHint") }}</label>
        <!-- A textarea, not a one-line input: a hint that says where the targets are and
             what is not one runs to several lines, and is worth reading back -->
        <textarea
          v-model.trim="s.hint"
          class="form-input"
          rows="3"
          style="resize: vertical"
          :placeholder="hintPlaceholder(s.type)"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ hintHint(s.type) }}
        </div>
      </div>

      <!-- Several positions from one screenshot: how far apart to click them, and how many -->
      <div v-if="s.type === 'ai_web_click_xy_multi'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ durationLabel(t("jobs.web.labelClickGap")) }}</label>
            <NumberInput v-model="s.gapMs" class="form-input" :min="0" :step="100" :scale="msScale" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxPoints") }}</label>
            <input v-model.number="s.max" class="form-input" type="number" min="0" max="20" step="1" />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.clickGapHint") }}
        </div>
        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.refine" type="checkbox" />
          {{ t("jobs.web.labelRefinePoints") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.refinePointsHint") }}
        </div>
        <label class="form-checkbox-label" style="margin-top: 8px">
          <input v-model="s.zoom" type="checkbox" />
          {{ t("jobs.web.labelZoomPanel") }}
        </label>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.zoomPanelHint") }}
        </div>
      </div>

      <div v-if="s.type === 'ai_web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelAiText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.aiTextPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.aiTextHint") }}
        </div>
      </div>

      <!-- AI writes into a field the config names: what to write, and how much of it -->
      <div v-if="s.type === 'web_ai_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelWriteHint") }}</label>
        <textarea
          v-model="s.hint"
          class="form-input"
          rows="2"
          style="resize: vertical"
          :placeholder="t('jobs.web.writeHintPlaceholder')"
        />
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.writeHintHint") }}
        </div>
        <div class="form-row" style="margin-top: 8px">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelMaxChars") }}</label>
            <input v-model.number="s.maxChars" class="form-input" type="number" min="0" step="100" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelWriteVarName") }}</label>
            <input
              v-model.trim="s.varName"
              class="form-input"
              :placeholder="t('jobs.web.writeVarNamePlaceholder')"
            />
          </div>
        </div>
        <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
          {{ t("jobs.web.writeVarNameHint") }}
        </div>
      </div>
      </div>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.web.addStep") }}
    </button>

    <!-- Shared by every key field in this editor; the id is per instance, since the editor
         recurses for a loop's rounds and a branch's arms -->
    <datalist :id="keyListId">
      <option v-for="k in COMMON_KEYS" :key="k" :value="k" />
    </datalist>

    <!-- The folders the data store already holds, so a data step is not pointed at a typo -->
    <datalist :id="folderListId">
      <option v-for="f in dataFolderNames" :key="f" :value="f" />
    </datalist>
  </div>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, onMounted } from "vue";
import { t } from "../i18n";
import {
  AI_WEB_STEP_TYPES,
  DATA_WEB_STEP_TYPES,
  defaultWebStep,
  offeredWebStepTypes,
  type WebStepForm,
  type WebStepType,
} from "../composables/webSteps";
import {
  dataFolderNames,
  dataStoreEnabled,
  loadDataFolderNames,
} from "../composables/dataStore";
import {
  loadMsApiSetting,
  msApiAvailable,
  msApiConfigured,
} from "../composables/msApi";
import RowControls from "./RowControls.vue";
import NumberInput from "./NumberInput.vue";
import { msScale, durationLabel } from "../composables/preferSeconds";

// The list is mutated in place: the parent holds it inside its own action form object, so
// emitting a replacement would mean threading an update back through the action index.
//
// The component recurses for a loop's rounds and a branch's two arms. `depth` and `inLoop`
// are what keep that in step with the backend's own limits: a loop cannot be offered inside
// another loop, and nothing may nest past the depth cap.
const props = defineProps<{
  steps: WebStepForm[];
  aiKeyMissing: boolean;
  depth?: number;
  inLoop?: boolean;
  /** Which heading to show: the action's own steps, a loop's, or one arm of a branch. */
  role?: "steps" | "loop" | "then" | "else";
}>();

// Per step rather than once for the list: a step already saved as a data step keeps its own
// type on offer even with the store switched off, so opening the form cannot rewrite it.
function typesFor(current: WebStepType): WebStepType[] {
  return offeredWebStepTypes(props.depth ?? 0, props.inLoop ?? false, {
    dataEnabled: dataStoreEnabled.value,
    msApiEnabled: msApiConfigured.value,
    keep: current,
  });
}

// A type with no translation is one this build does not know: shown by its raw name, since the
// key itself is what `t` hands back and that reads as nothing at all
function typeLabel(ty: WebStepType): string {
  const key = "jobs.web.type." + ty;
  const label = t(key);
  return label === key ? ty : label;
}

/** Whether the pool source is on offer; the editor says so rather than failing at run time. */
const msApiEnabled = msApiConfigured;

onMounted(() => {
  loadDataFolderNames();
  void loadMsApiSetting();
});

// Suggestions for the key field. Not the whole set -- any letter or digit is a key too, and
// the field stays free text for those; these are the ones a page usually goes by. The backend
// settles the spelling, so `ctrl + enter` typed by hand works as well as the entry here does.
const COMMON_KEYS = [
  "Enter",
  "Control+Enter",
  "Shift+Enter",
  "Alt+Enter",
  "Meta+Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "Control+a",
  "Control+c",
  "Control+v",
];

// One datalist per editor instance, so the recursion cannot mint the same id twice
const instanceId = getCurrentInstance()?.uid ?? 0;
const keyListId = `web-keys-${instanceId}`;
const folderListId = `data-folders-${instanceId}`;

const heading = computed(() => {
  switch (props.role) {
    case "loop":
      return { label: t("jobs.web.loopStepsLabel"), hint: t("jobs.web.loopStepsHint") };
    case "then":
      return { label: t("jobs.web.thenStepsLabel"), hint: t("jobs.web.thenStepsHint") };
    case "else":
      return { label: t("jobs.web.elseStepsLabel"), hint: t("jobs.web.elseStepsHint") };
    default:
      return { label: t("jobs.web.stepsLabel"), hint: t("jobs.web.stepsHint") };
  }
});

function hintPlaceholder(type: WebStepType): string {
  if (type === "ai_web_input") return t("jobs.web.hintInputPlaceholder");
  if (type === "ai_web_click_xy") return t("jobs.web.hintXyPlaceholder");
  if (type === "ai_web_click_xy_multi") return t("jobs.web.hintXyMultiPlaceholder");
  return t("jobs.web.hintButtonPlaceholder");
}

function hintHint(type: WebStepType): string {
  if (type === "ai_web_click_xy") return t("jobs.web.hintXyHint");
  if (type === "ai_web_click_xy_multi") return t("jobs.web.hintXyMultiHint");
  return t("jobs.web.hintHint");
}

/** True while any step here is open, so the one button reads as fold or unfold. */
const anyOpen = computed(() => props.steps.some((s) => !s.collapsed));

/**
 * Folds this level and everything under it. Recursive on purpose: a branch left open inside a
 * folded one is invisible, so unfolding later would come back to a state nobody chose.
 */
function foldAll(shut: boolean) {
  const walk = (list: WebStepForm[]) => {
    for (const s of list) {
      s.collapsed = shut;
      if (s.steps?.length) walk(s.steps);
      if (s.elseSteps?.length) walk(s.elseSteps);
    }
  };
  walk(props.steps);
}

/**
 * One line saying what a folded step does. Not the backend's summary -- that one runs against a
 * saved config, and this reads the form as it is being typed -- but the same idea: the type,
 * then whatever identifies this step among others of its type.
 */
function stepSummary(s: WebStepForm): string {
  const label = typeLabel(s.type);
  const detail = summaryDetail(s);
  return detail ? `${label} — ${detail}` : label;
}

function summaryDetail(s: WebStepForm): string {
  const arms = (n: number, m: number) =>
    t("jobs.web.branchCounts").replace("{then}", String(n)).replace("{else}", String(m));
  switch (s.type) {
    case "web_if":
      return (
        (s.check === "element"
          ? s.selector
          : s.check === "value"
            ? [s.value, s.text].filter(Boolean).join(" ~ ")
            : s.text) +
        (s.negate ? ` (${t("jobs.web.summaryNegated")})` : "") +
        ` · ${arms(s.steps.length, s.elseSteps.length)}`
      );
    case "web_repeat":
      return `${s.times}× · ${t("jobs.web.stepCount").replace("{n}", String(s.steps.length))}`;
    case "web_for_each":
      return `{${s.varName}} · ${t("jobs.web.stepCount").replace("{n}", String(s.steps.length))}`;
    case "web_input":
    case "web_ai_input":
      return `${s.selector} ← ${s.text || s.hint}`;
    case "web_set":
      return s.vars
        .filter((v) => v.name)
        .map((v) => `{${v.name}}`)
        .join(", ");
    case "web_goto":
      return s.url;
    case "web_data_read":
    case "web_data_save":
    case "web_data_delete":
      return [s.folder, s.recordKey, s.path].filter(Boolean).join(".");
    case "web_data_pick":
      return `${s.folder}[${s.index}] → {${s.varName}}`;
    case "web_ms_oauth2":
      return `→ {${s.varName}}${s.folder ? ` · ${[s.folder, s.recordKey, s.path].filter(Boolean).join(".")}` : ""}`;
    case "web_totp":
    case "web_otp_secret":
    case "web_email_code":
    case "web_email_lease":
    case "web_tg_code":
    case "web_read":
    case "web_pick":
    case "web_collect":
      return `${s.selector || s.email || ""} → {${s.varName}}`.trim();
    case "ai_web_button":
    case "ai_web_click_xy":
    case "ai_web_click_xy_multi":
      return s.hint;
    case "web_delay":
      return `${s.waitMs}ms`;
    case "web_eval":
      return `${s.script.replace(/\s+/g, " ").trim().slice(0, 60)}${s.varName ? ` → {${s.varName}}` : ""}`;
    default:
      return s.selector || s.url || s.text || "";
  }
}

function add() {
  props.steps.push(defaultWebStep());
}

function insertAfter(i: number) {
  props.steps.splice(i + 1, 0, defaultWebStep());
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

// Order is not cosmetic here: a `web_set` row may be built out of the rows above it
function moveVar(step: WebStepForm, i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= step.vars.length) return;
  const [item] = step.vars.splice(i, 1);
  step.vars.splice(to, 0, item);
}
</script>

<style scoped>
.web-step-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  /* The parent action card is #fafafa, so these sit a shade lighter to read as nested */
  background: var(--bg-card);
}

.web-step-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.web-steps-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.web-fold-all {
  font-size: 11px;
  padding: 2px 6px;
}

/* The chevron: a plain glyph rather than a button face, so the header still reads as a row
   of controls with the type at its centre */
.web-fold {
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1;
  flex: none;
}

.web-fold:hover {
  color: var(--info);
}

/* A folded step's one line. Clickable, since a summary that says the wrong thing is exactly
   when the fields are wanted back */
.web-step-summary {
  font-size: 12px;
  color: var(--text-tertiary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: -4px 0 2px 26px;
}

.web-step-summary:hover {
  color: var(--text-secondary);
}

/* A loop's own steps, set in from the loop's fields so the nesting reads at a glance */
.web-loop-body {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--info);
}

/* The two arms of a condition, told apart by colour: taken on yes, taken on no */
.web-branch-body {
  margin-top: 10px;
  padding-left: 10px;
}

.web-branch-then {
  border-left: 2px solid var(--success);
}

.web-branch-else {
  border-left: 2px solid var(--warning);
}

/* A step this build cannot edit: warned about rather than hidden, since it still runs */
.web-step-unknown {
  font-size: 11px;
  color: var(--warning-soft-text);
  background: var(--warning-soft);
  border: 1px solid var(--warning-border);
  border-radius: 4px;
  padding: 6px 8px;
}

.web-step-num {
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

.web-step-type {
  flex: 1;
  min-width: 0;
}

/* A name and its value per row, with the four controls: the order they sit in is the order
   they are set in, so moving one up is a real edit rather than tidying */
.web-var-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto;
  gap: 6px;
  margin-bottom: 6px;
}

.web-var-head {
  margin-bottom: 2px;
}

.web-var-controls {
  display: flex;
  gap: 2px;
}
</style>
