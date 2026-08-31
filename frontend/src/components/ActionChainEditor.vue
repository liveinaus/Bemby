<template>
  <div v-if="actions.length === 0" class="chain-empty">
    {{ depth > 0 ? t('jobs.custom.noBranchActions') : t('jobs.custom.noActions') }}
  </div>

  <div v-for="(action, i) in actions" :key="i" class="custom-action-card">
    <!-- Row: step number + type selector + move/delete buttons -->
    <div class="custom-action-header">
      <span class="custom-action-num">{{ i + 1 }}</span>
      <select v-model="action.type" class="form-select custom-action-type-select">
        <option v-for="ty in typesFor(action.type)" :key="ty" :value="ty" :disabled="typeBlocked(ty)">
          {{ typeLabel(ty) }}{{ typeNote(ty) }}
        </option>
      </select>
      <RowControls :index="i" :count="actions.length" @move="move(i, $event)" @insert="insert(i)" @remove="remove(i)" />
    </div>

    <!-- send_command -->
    <div v-if="action.type === 'send_command'" class="custom-action-params">
      <div class="form-row" style="margin-bottom:0">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
          <select v-model="action.contentDropdown" class="form-select">
            <option value="/start">/start</option>
            <option value="/checkin">/checkin</option>
            <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="{aiInputWithCustomHint}" :disabled="aiKeyMissing">{{ t('jobs.aiInputHintOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="custom">{{ t('common.custom') }}...</option>
          </select>
          <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
          <template v-if="action.contentDropdown === '{aiInput}'">
            <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
            <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
          </template>
          <div v-else-if="action.contentDropdown !== '{aiInputWithCustomHint}'" style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <!-- The hint is prose and its own explanation is long, so both take the card's full
           width rather than the half the content column leaves them -->
      <div v-if="action.contentDropdown === '{aiInputWithCustomHint}'" style="margin-top:8px">
        <textarea v-model="action.contentAiInputHint" class="form-input" style="min-height:64px;resize:vertical" rows="3" :placeholder="t('jobs.aiInputHintPlaceholder')"></textarea>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputHintHint') }}</div>
        <div class="form-row" style="margin-bottom:0;margin-top:6px">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">{{ t('jobs.aiInputMinLenLabel') }}</label>
            <input v-model.trim="action.contentAiInputMinLen" class="form-input" type="number" min="1" max="4096" :placeholder="t('jobs.aiInputLenPlaceholder')" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">{{ t('jobs.aiInputMaxLenLabel') }}</label>
            <input v-model.trim="action.contentAiInputMaxLen" class="form-input" type="number" min="1" max="4096" :placeholder="t('jobs.aiInputLenPlaceholder')" />
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputLenRangeHint') }}</div>
        <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
      </div>
    </div>

    <!-- send_contact_message -->
    <div v-if="action.type === 'send_contact_message'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
        <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
      </div>
      <div class="form-row" style="margin-bottom:0;margin-top:8px">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
          <select v-model="action.contentDropdown" class="form-select">
            <option value="/start">/start</option>
            <option value="/checkin">/checkin</option>
            <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="{aiInputWithCustomHint}" :disabled="aiKeyMissing">{{ t('jobs.aiInputHintOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="custom">{{ t('common.custom') }}...</option>
          </select>
          <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
          <template v-if="action.contentDropdown === '{aiInput}'">
            <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
            <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
          </template>
          <div v-else-if="action.contentDropdown !== '{aiInputWithCustomHint}'" style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <!-- The hint is prose and its own explanation is long, so both take the card's full
           width rather than the half the content column leaves them -->
      <div v-if="action.contentDropdown === '{aiInputWithCustomHint}'" style="margin-top:8px">
        <textarea v-model="action.contentAiInputHint" class="form-input" style="min-height:64px;resize:vertical" rows="3" :placeholder="t('jobs.aiInputHintPlaceholder')"></textarea>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputHintHint') }}</div>
        <div class="form-row" style="margin-bottom:0;margin-top:6px">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">{{ t('jobs.aiInputMinLenLabel') }}</label>
            <input v-model.trim="action.contentAiInputMinLen" class="form-input" type="number" min="1" max="4096" :placeholder="t('jobs.aiInputLenPlaceholder')" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">{{ t('jobs.aiInputMaxLenLabel') }}</label>
            <input v-model.trim="action.contentAiInputMaxLen" class="form-input" type="number" min="1" max="4096" :placeholder="t('jobs.aiInputLenPlaceholder')" />
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputLenRangeHint') }}</div>
        <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
      </div>
    </div>

    <!-- wait_reply -->
    <div v-if="action.type === 'wait_reply'" class="custom-action-params">
      <div class="form-row" style="margin-bottom:0">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
          <NumberInput v-model="action.maxWaitMs" class="form-input" :min="1000" :step="1000" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
        <NumberInput v-model="action.scope" class="form-input" :max="0" :step="1" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
    </div>

    <!-- delay -->
    <div v-if="action.type === 'delay'" class="custom-action-params">
      <label class="form-label">{{ t('jobs.custom.labelWaitMs') }}</label>
      <NumberInput v-model="action.waitMs" class="form-input" :min="100" :step="500" />
    </div>

    <!-- click_button -->
    <div v-if="action.type === 'click_button'" class="custom-action-params">
      <div class="form-row" style="margin-bottom:0">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
          <select v-model="action.buttonDropdown" class="form-select">
            <option value="签到">签到</option>
            <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
            <option value="custom">{{ t('common.custom') }}...</option>
          </select>
          <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
          <template v-if="action.buttonDropdown === '{aiBtn}'">
            <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
            <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
          </template>
          <div v-else style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
        <NumberInput v-model="action.maxWaitMs" class="form-input" :min="1000" :step="1000" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.maxWaitTotalHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
        <NumberInput v-model="action.scope" class="form-input" :max="0" :step="1" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
    </div>

    <!-- click_message_button -->
    <div v-if="action.type === 'click_message_button'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
        <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
      </div>
      <div class="form-row" style="margin-bottom:0;margin-top:8px">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
          <select v-model="action.buttonDropdown" class="form-select">
            <option value="签到">签到</option>
            <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
            <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
            <option value="custom">{{ t('common.custom') }}...</option>
          </select>
          <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
          <template v-if="action.buttonDropdown === '{aiBtn}'">
            <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
            <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
          </template>
          <div v-else style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
        <NumberInput v-model="action.maxWaitMs" class="form-input" :min="1000" :step="1000" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.maxWaitTotalHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
        <NumberInput v-model="action.scope" class="form-input" :max="0" :step="1" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
    </div>

    <!-- enter_captcha -->
    <div v-if="action.type === 'enter_captcha'" class="custom-action-params">
      <div class="form-row" style="margin-bottom:0">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
          <NumberInput v-model="action.maxWaitMs" class="form-input" :min="1000" :step="1000" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelCaptchaLength') }}</label>
          <input v-model.trim="action.captchaLength" class="form-input" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
      <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
    </div>

    <!-- join_group -->
    <div v-if="action.type === 'join_group'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelGroupId') }}</label>
        <input v-model.trim="action.groupId" class="form-input" :placeholder="t('jobs.custom.groupIdPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.groupIdHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.checkMembership" />
          {{ t('jobs.custom.labelCheckMembership') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.checkMembershipHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelVerifyButton') }}</label>
        <input v-if="!verifyUsesAi(action.verifyButton)" v-model.trim="action.verifyButton" class="form-input" :placeholder="t('jobs.custom.verifyButtonPlaceholder')" />
        <input v-else class="form-input" :value="verifyAiHint(action.verifyButton)" :placeholder="t('jobs.aiHintPlaceholder')" @input="setVerifyAiHint(action, ($event.target as HTMLInputElement).value)" />
        <label class="form-checkbox-label" style="margin-top:6px">
          <input type="checkbox" :disabled="aiKeyMissing" :checked="verifyUsesAi(action.verifyButton)" @change="setVerifyAi(action, ($event.target as HTMLInputElement).checked)" />
          {{ t('jobs.custom.labelVerifyAiBtn') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ verifyUsesAi(action.verifyButton) ? t('jobs.custom.verifyAiBtnHint') : t('jobs.custom.verifyButtonHint') }}</div>
        <div v-if="aiKeyMissing && verifyUsesAi(action.verifyButton)" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.verifyMentionsMe" />
          {{ t('jobs.custom.labelVerifyMentionsMe') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.verifyMentionsMeHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.verifyMaskedName" />
          {{ t('jobs.custom.labelVerifyMaskedName') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.verifyMaskedNameHint') }}</div>
      </div>
      <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelVerifyWaitMs') }}</label>
        <NumberInput v-model="action.verifyWaitMs" :min="1000" :step="1000" class="form-input" />
      </div>
      <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelVerifyMaxWaitMs') }}</label>
        <NumberInput v-model="action.verifyMaxWaitMs" :min="1000" :step="1000" class="form-input" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.verifyMaxWaitMsHint') }}</div>
      </div>
    </div>

    <!-- subscribe_channel -->
    <div v-if="action.type === 'subscribe_channel'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelChannelId') }}</label>
        <input v-model.trim="action.channelId" class="form-input" :placeholder="t('jobs.custom.channelIdPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.channelIdHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.checkMembership" />
          {{ t('jobs.custom.labelCheckSubscription') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.checkSubscriptionHint') }}</div>
      </div>
    </div>

    <!-- open_mini_app / open_mini_app_url / open_bot_menu_app -->
    <div v-if="action.type === 'open_mini_app' || action.type === 'open_mini_app_url' || action.type === 'open_bot_menu_app'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ action.type === 'open_mini_app' ? t('jobs.custom.labelContactOptional') : action.type === 'open_mini_app_url' ? t('jobs.custom.labelMiniAppOwner') : t('jobs.custom.labelMenuAppOwner') }}</label>
        <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ action.type === 'open_mini_app' ? t('jobs.custom.contactOptionalHint') : action.type === 'open_mini_app_url' ? t('jobs.custom.miniAppOwnerHint') : t('jobs.custom.menuAppOwnerHint') }}</div>
      </div>
      <div v-if="action.type === 'open_mini_app_url'" class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelMiniAppUrl') }}</label>
        <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.custom.miniAppUrlPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppUrlHint') }}</div>
      </div>
      <div v-if="action.type === 'open_mini_app'" class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelMiniAppButton') }}</label>
        <input v-model.trim="action.button" class="form-input" :placeholder="t('jobs.custom.miniAppButtonPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppButtonHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <MiniAppStepsEditor :steps="action.appSteps" />
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.exactAppLabels" />
          {{ t('jobs.custom.labelExactAppLabels') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.exactAppLabelsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
      <div class="form-row" style="margin-bottom:0;margin-top:8px">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
          <NumberInput v-model="action.miniAppMaxWaitMs" class="form-input" :min="0" :step="10000" placeholder="300000" />
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <ProxyPicker
          v-model="action.miniAppProxyId"
          :pool="action.miniAppProxyPool"
          :proxies="proxies"
          :label="t('jobs.custom.labelMiniAppProxy')"
          :blank-label="t('jobs.custom.miniAppProxyJob')"
          :hint="t('jobs.custom.miniAppProxyHint')"
          allow-direct
        />
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.miniAppTryAllProxies" />
          {{ t('jobs.custom.labelMiniAppTryAll') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.web.labelProfileId') }}</label>
        <input v-model.trim="action.profileId" class="form-input" :placeholder="profileIdPlaceholder" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.web.profileIdHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.keepAppSession" />
          {{ t('jobs.custom.labelKeepAppSession') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.keepAppSessionHint') }}</div>
      </div>
    </div>

    <!-- open_url / open_message_url -->
    <div v-if="action.type === 'open_url' || action.type === 'open_message_url'" class="custom-action-params">
      <div v-if="action.type === 'open_url'" class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.web.labelUrl') }}</label>
        <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.web.urlPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.web.urlHint') }}</div>
      </div>
      <template v-else>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">{{ t('jobs.custom.labelContactOptional') }}</label>
          <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
          <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contactOptionalHint') }}</div>
        </div>
        <div class="form-group" style="margin-bottom:0;margin-top:8px">
          <label class="form-label">{{ t('jobs.custom.labelLinkText') }}</label>
          <input v-model.trim="action.linkText" class="form-input" :placeholder="t('jobs.custom.linkTextPlaceholder')" />
          <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.linkTextHint') }}</div>
        </div>
        <div class="form-group" style="margin-bottom:0;margin-top:8px">
          <label class="form-label">{{ t('jobs.custom.labelLinkMessageContains') }}</label>
          <input v-model.trim="action.messageContains" class="form-input" :placeholder="t('jobs.custom.messageContainsPlaceholder')" />
          <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.linkMessageContainsHint') }}</div>
        </div>
        <div class="form-row" style="margin-bottom:0;margin-top:8px">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelLinkWait') }}</label>
            <NumberInput v-model="action.linkWaitMs" class="form-input" :min="0" :step="1000" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.linkWaitHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
            <NumberInput v-model="action.scope" class="form-input" :max="0" :step="1" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
          </div>
        </div>
      </template>
      <div class="form-group" style="margin-bottom:0;margin-top:10px">
        <WebStepsEditor :steps="action.webSteps" :ai-key-missing="aiKeyMissing" />
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
      <div class="form-row" style="margin-bottom:0;margin-top:8px">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
          <NumberInput v-model="action.miniAppMaxWaitMs" class="form-input" :min="0" :step="10000" placeholder="300000" />
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <ProxyPicker
          v-model="action.miniAppProxyId"
          :pool="action.miniAppProxyPool"
          :proxies="proxies"
          :label="t('jobs.custom.labelMiniAppProxy')"
          :blank-label="t('jobs.custom.miniAppProxyJob')"
          :hint="t('jobs.custom.miniAppProxyHint')"
          allow-direct
        />
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-checkbox-label">
          <input type="checkbox" v-model="action.miniAppTryAllProxies" />
          {{ t('jobs.custom.labelMiniAppTryAll') }}
        </label>
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.web.labelProfileId') }}</label>
        <input v-model.trim="action.profileId" class="form-input" :placeholder="profileIdPlaceholder" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.web.profileIdHint') }}</div>
      </div>
    </div>

    <!-- ai_multiple_btn -->
    <div v-if="action.type === 'ai_multiple_btn'" class="custom-action-params">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelContactOptional') }}</label>
        <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.contactOptionalHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.custom.labelMessageContains') }}</label>
        <input v-model.trim="action.messageContains" class="form-input" :placeholder="t('jobs.custom.messageContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.messageContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0;margin-top:8px">
        <label class="form-label">{{ t('jobs.aiHintLabel') }}</label>
        <input v-model.trim="action.buttonAiHint" class="form-input" :placeholder="t('jobs.aiHintPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.aiMultipleBtnHint') }}</div>
        <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
      </div>
      <div class="form-row" style="margin-bottom:0;margin-top:8px">
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelGapMs') }}</label>
          <NumberInput v-model="action.gapMs" class="form-input" :min="0" :step="500" />
          <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.gapMsHint') }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
          <NumberInput v-model="action.maxRetries" class="form-input" :min="0" :max="10" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
        <NumberInput v-model="action.maxWaitMs" class="form-input" :min="1000" :step="1000" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.maxWaitTotalHintEach') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
        <NumberInput v-model="action.scope" class="form-input" :max="0" :step="1" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
        <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
        <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
        <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
      </div>
    </div>


  <!-- if_check -->
  <div v-if="action.type === 'if_check'" class="custom-action-params">
    <ConditionFields
      :cond="action.cond"
      :label="t('jobs.custom.ifWhen')"
      :hint="t('jobs.custom.ifCheckHint')"
    />

    <div class="branch">
      <div class="branch-title">{{ t('jobs.custom.ifThen') }}</div>
      <ActionChainEditor
        :actions="action.then"
        :depth="depth + 1"
        :ai-key-missing="aiKeyMissing"
        :cf-browser-missing="cfBrowserMissing"
        :proxies="proxies"
        :profile-id-placeholder="profileIdPlaceholder"
        :allow-ai-multiple-btn="allowAiMultipleBtn"
      />
    </div>

    <div v-for="(arm, ai) in action.elseIfs" :key="'arm' + ai" class="branch">
      <div class="branch-title">
        <span>{{ t('jobs.custom.ifElseIf') }} {{ ai + 1 }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm branch-drop"
          :title="t('common.delete')"
          @click="action.elseIfs.splice(ai, 1)"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <ConditionFields :cond="arm.cond" :label="t('jobs.custom.ifWhen')" />
      <div class="branch-nested">
        <ActionChainEditor
          :actions="arm.then"
          :depth="depth + 1"
          :ai-key-missing="aiKeyMissing"
          :cf-browser-missing="cfBrowserMissing"
          :proxies="proxies"
          :profile-id-placeholder="profileIdPlaceholder"
          :allow-ai-multiple-btn="allowAiMultipleBtn"
        />
      </div>
    </div>

    <div class="branch">
      <div class="branch-title">{{ t('jobs.custom.ifElse') }}</div>
      <ActionChainEditor
        :actions="action.otherwise"
        :depth="depth + 1"
        :ai-key-missing="aiKeyMissing"
        :cf-browser-missing="cfBrowserMissing"
        :proxies="proxies"
        :profile-id-placeholder="profileIdPlaceholder"
        :allow-ai-multiple-btn="allowAiMultipleBtn"
      />
    </div>

    <button type="button" class="btn btn-ghost btn-sm branch-add" @click="addArm(action)">
      <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addElseIf') }}
    </button>
  </div>

  <!-- end_job / fail_job -->
  <div v-if="action.type === 'end_job' || action.type === 'fail_job'" class="custom-action-params">
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label">{{ t('jobs.custom.labelReason') }}</label>
      <input v-model.trim="action.reason" class="form-input" :placeholder="t('jobs.custom.reasonPlaceholder')" />
      <div style="font-size:11px;color:var(--text-faint);margin-top:3px">
        {{ action.type === 'end_job' ? t('jobs.custom.endJobHint') : t('jobs.custom.failJobHint') }}
      </div>
    </div>
  </div>

  <!-- Carrying on past a failure is what lets a check afterwards judge it -->
  <div v-if="canContinue(action.type)" class="form-group" style="margin:8px 0 0">
    <label class="form-check">
      <input type="checkbox" v-model="action.continueOnError" />
      {{ t('jobs.custom.labelContinueOnError') }}
    </label>
    <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.continueOnErrorHint') }}</div>
  </div>

  </div>

  <button type="button" class="btn btn-ghost btn-sm chain-add" @click="add">
    <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addAction') }}
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import type { Proxy } from '../api/client';
import NumberInput from './NumberInput.vue';
import RowControls from './RowControls.vue';
import ProxyPicker from './ProxyPicker.vue';
import MiniAppStepsEditor from './MiniAppStepsEditor.vue';
import WebStepsEditor from './WebStepsEditor.vue';
import ConditionFields from './ConditionFields.vue';
import {
  defaultAction,
  defaultCondition,
  offeredActionTypes,
  type CustomActionForm,
  type CustomActionType,
} from '../composables/customActions';

// The custom job's action chain. The list is mutated in place, the way `WebStepsEditor`
// handles its own: the parent holds it, and an arm of a check holds one a level down.
//
// The component recurses for those arms, and `depth` keeps that in step with the backend's
// own cap -- a check is not offered once the nesting is as deep as a run will accept.
const props = withDefaults(
  defineProps<{
    actions: CustomActionForm[];
    /** How many checks this list sits inside; 0 at the top level. */
    depth?: number;
    aiKeyMissing?: boolean;
    cfBrowserMissing?: boolean;
    proxies?: Proxy[];
    profileIdPlaceholder?: string;
    /** Offer the AI multi-button action, which only the template form has ever carried. */
    allowAiMultipleBtn?: boolean;
  }>(),
  {
    depth: 0,
    aiKeyMissing: false,
    cfBrowserMissing: false,
    proxies: () => [],
    profileIdPlaceholder: '',
    allowAiMultipleBtn: false,
  },
);

const actions = computed(() => props.actions);

// Per action rather than once for the list: one already saved as a type this form would not
// have offered keeps it on the menu, so opening the form cannot rewrite it.
const typesFor = (current: CustomActionType) =>
  offeredActionTypes(props.depth, {
    aiMultipleBtn: props.allowAiMultipleBtn,
    keep: current,
  });

const TYPE_LABELS: Record<CustomActionType, string> = {
  send_command: 'actionSendCommand',
  send_contact_message: 'actionSendContactMessage',
  wait_reply: 'actionWaitReply',
  delay: 'actionDelay',
  click_button: 'actionClickButton',
  click_message_button: 'actionClickMessageButton',
  ai_multiple_btn: 'actionAiMultipleBtn',
  enter_captcha: 'actionEnterCaptcha',
  join_group: 'actionJoinGroup',
  subscribe_channel: 'actionSubscribeChannel',
  open_mini_app: 'actionOpenMiniApp',
  open_mini_app_url: 'actionOpenMiniAppUrl',
  open_bot_menu_app: 'actionOpenBotMenuApp',
  open_url: 'actionOpenUrl',
  open_message_url: 'actionOpenMessageUrl',
  if_check: 'actionIfCheck',
  end_job: 'actionEndJob',
  fail_job: 'actionFailJob',
};

/** Types that cannot run without an AI key, and those that need the browser installed. */
const NEEDS_AI = new Set<CustomActionType>(['enter_captcha', 'ai_multiple_btn']);
const NEEDS_BROWSER = new Set<CustomActionType>([
  'open_mini_app',
  'open_mini_app_url',
  'open_bot_menu_app',
  'open_url',
  'open_message_url',
]);

const typeLabel = (ty: CustomActionType) => t(`jobs.custom.${TYPE_LABELS[ty]}`);

const typeBlocked = (ty: CustomActionType) =>
  (NEEDS_AI.has(ty) && props.aiKeyMissing) ||
  (NEEDS_BROWSER.has(ty) && props.cfBrowserMissing);

const typeNote = (ty: CustomActionType) => {
  if (NEEDS_AI.has(ty) && props.aiKeyMissing) return ` (${t('jobs.noApiKey')})`;
  if (NEEDS_BROWSER.has(ty) && props.cfBrowserMissing) return ` (${t('jobs.noCfBrowser')})`;
  return '';
};

// join_group's verify button doubles as an {aiBtn} placeholder: the checkbox swaps the
// literal button text for one, and the field beside it then edits the hint the AI is given.
// Matches the backend's reading exactly, so `{aiBtn:}` stays literal button text here too.
const AI_BTN_RE = /^\{aiBtn(?::(.+))?\}$/;
const verifyUsesAi = (value: string) => AI_BTN_RE.test((value ?? '').trim());
const verifyAiHint = (value: string) => (value ?? '').trim().match(AI_BTN_RE)?.[1] ?? '';
const setVerifyAi = (action: CustomActionForm, on: boolean) => {
  action.verifyButton = on ? '{aiBtn}' : '';
};
// Kept as typed rather than trimmed on every keystroke, which would eat the space between
// words. An empty hint goes back to a bare {aiBtn}: the backend reads `{aiBtn:}` as literal text.
const setVerifyAiHint = (action: CustomActionForm, hint: string) => {
  action.verifyButton = hint.trim() ? `{aiBtn:${hint}}` : '{aiBtn}';
};

/** A check settles its own outcome, and the two terminals have no failure to carry past. */
const canContinue = (ty: CustomActionType) =>
  ty !== 'if_check' && ty !== 'end_job' && ty !== 'fail_job';

function add() {
  props.actions.push(defaultAction());
}

/** Puts a new action straight after this one, rather than at the end to be walked up. */
function insert(i: number) {
  props.actions.splice(i + 1, 0, defaultAction());
}

function remove(i: number) {
  props.actions.splice(i, 1);
}

function move(i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= props.actions.length) return;
  const arr = props.actions;
  [arr[i], arr[to]] = [arr[to], arr[i]];
}

function addArm(action: CustomActionForm) {
  action.elseIfs.push({ cond: defaultCondition(), then: [] });
}
</script>

<style scoped>
/* Moved here from the two forms that used to hold a copy of this markup each: a scoped rule
   there no longer reaches these elements now the editor is a component of its own. */
.custom-action-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--bg-subtle);
}

.custom-action-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.custom-action-num {
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
}

.custom-action-type-select {
  flex: 1;
}

.custom-action-params {
  padding-left: 26px;
}

/* A nested chain sits a shade lighter than the card holding it, the way a web step's does,
   so how deep an action sits reads off the background rather than off the indent alone */
.custom-action-card .custom-action-card {
  background: var(--bg-card);
}

.chain-empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: 6px 0;
}

.chain-add {
  margin-top: 4px;
}

/* One arm of a check: its own box, so which actions belong to which answer is not left to
   be worked out from the order they appear in */
.branch {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary-soft);
  border-radius: 6px;
  background: var(--bg-card);
}

.branch-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.branch-drop {
  padding: 2px 6px;
  color: var(--text-faint);
}

.branch-drop:hover {
  color: var(--danger);
}

/* An else-if holds a condition and then its actions; the actions are set off from the
   condition above them so the two do not read as one list of fields */
.branch-nested {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.branch-add {
  margin-top: 10px;
}
</style>
