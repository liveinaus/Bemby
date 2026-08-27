<template>
  <div class="modal-backdrop">
    <div class="modal" style="width:560px">
      <h3 class="modal-title">
        {{ t(editTarget ? 'templates.editTitle' : 'templates.addTitle') }}
        <span v-if="editTarget" class="modal-title-ids" :title="t('common.dbIdsHint')">{{ `{templateId} ${editTarget.id}` }}</span>
      </h3>
      <div class="modal-body">
        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <!-- A working chain to start from, only offered for a new template: applying it fills
             the whole form in, which would throw away an existing one's settings -->
        <div v-if="!editTarget && availableTemplatePresets.length" class="form-group">
          <label class="form-label">{{ t('templates.presets.label') }}</label>
          <div style="display:flex;gap:6px">
            <select v-model="presetId" class="form-select" style="flex:1;min-width:0">
              <option value="">{{ t('templates.presets.none') }}</option>
              <option v-for="p in availableTemplatePresets" :key="p.id" :value="p.id">{{ t(p.labelKey) }}</option>
            </select>
            <button type="button" class="btn btn-secondary" :disabled="!presetId" @click="applyPreset">
              {{ t('templates.presets.apply') }}
            </button>
          </div>
          <div v-if="presetHint" style="font-size:11px;color:var(--text-faint);margin-top:4px">{{ presetHint }}</div>
        </div>

        <!-- The other way to fill the form in, for a template that already exists: paste one
             shared from another Bemby. Nothing is saved by applying it -- the form is filled and
             read over first -- and saving afterwards writes to this same template, so the id, and
             every job linked to it, stay as they are. -->
        <div v-if="editTarget" class="form-group">
          <div style="display:flex;gap:6px;align-items:center">
            <button type="button" class="btn btn-secondary btn-sm" style="white-space:nowrap" @click="toggleImport">
              <i class="fa-solid fa-file-import"></i> {{ t('templates.overwriteBtn') }}
            </button>
            <span style="font-size:11px;color:var(--text-faint)">{{ t('templates.overwriteHint') }}</span>
          </div>
          <div v-if="showImport" style="margin-top:8px">
            <label class="form-label">{{ t('templates.importLabel') }}</label>
            <textarea
              v-model="importJson"
              class="form-input"
              rows="6"
              style="resize:vertical;font-family:monospace;font-size:12px"
              :placeholder="t('templates.importPlaceholder')"
            />
            <div v-if="importError" class="error-msg" style="margin-top:6px">{{ importError }}</div>
            <div v-if="importNotice" style="font-size:11px;color:var(--warning-soft-text);margin-top:6px">
              {{ importNotice }}
            </div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button type="button" class="btn btn-primary" :disabled="!importJson.trim()" @click="applyImport">
                {{ t('templates.overwriteApply') }}
              </button>
              <button type="button" class="btn btn-ghost" @click="showImport = false">
                {{ t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Template Name + Job Type -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('templates.labelName') }} <span style="color:var(--danger)">*</span></label>
            <div class="name-with-icon">
              <JobIconPicker v-model="form.icon" />
              <input v-model.trim="form.name" class="form-input" placeholder="My Template" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelType') }}</label>
            <select v-model="form.jobType" class="form-select" @change="onJobTypeChange">
              <option value="checkin">Check-in (签到)</option>
              <option value="embywatch">Emby Watch (观看)</option>
              <option value="custom">Custom (自定义)</option>
              <option value="autoreg">Auto Registration (抢注)</option>
            </select>
          </div>
        </div>

        <!-- Check-in: Bot Username -->
        <div v-if="form.jobType === 'checkin'" class="form-group">
          <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:var(--danger)">*</span></label>
          <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
        </div>

        <!-- Emby Watch: Server URL -->
        <div v-if="form.jobType === 'embywatch'" class="form-group">
          <label class="form-label">{{ t('jobs.labelServerUrl') }} <span style="color:var(--danger)">*</span></label>
          <div style="display:flex;align-items:center;gap:6px">
            <select v-model="embyServer.protocol" class="form-select" style="width:88px;flex-shrink:0">
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <span style="color:var(--text-faint);font-size:13px;flex-shrink:0">://</span>
            <input v-model.trim="embyServer.host" class="form-input" placeholder="emby.xxxx.com" @paste="handleEmbyHostPaste" />
            <span style="color:var(--text-faint);font-size:13px;flex-shrink:0">:</span>
            <input v-model.number="embyServer.port" class="form-input" type="number" min="1" max="65535" style="width:72px;flex-shrink:0" placeholder="443" />
          </div>
        </div>

        <!-- embywatch-specific fields (credentials are set per-job, not in template) -->
        <template v-if="form.jobType === 'embywatch'">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">
                {{ t('jobs.labelPlayDuration') }}
                <span style="color:var(--text-faint);font-weight:400"> — {{ t('common.blankForDefault') }}</span>
              </label>
              <input v-model.number="embyCfg.playDuration" class="form-input" type="number" min="30" placeholder="300" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelUserAgent') }}</label>
            <select v-model="embyUaDropdown" class="form-select" @change="onUaDropdownChange">
              <option value="">{{ t('jobs.uaDefault') }}</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.name">{{ p.name }}</option>
              <option value="__custom__">{{ t('jobs.uaCustom') }}</option>
            </select>
            <textarea
              v-if="embyUaDropdown === '__custom__'"
              v-model.trim="embyCfg.userAgent"
              class="form-input"
              rows="2"
              style="margin-top:6px;resize:vertical"
              placeholder="Mozilla/5.0 ..."
            />
          </div>
          <div class="form-group">
            <label class="form-check">
              <input v-model="embyCfg.ignoreSslErrors" type="checkbox" />
              <span>{{ t('jobs.labelIgnoreSslErrors') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.ignoreSslErrorsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelLibrary') }}</label>
            <input v-model.trim="embyCfg.library" class="form-input" type="text" :placeholder="t('jobs.libraryPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px">{{ t('jobs.libraryHint') }}</div>
          </div>
          <div class="emby-rules-hint">{{ t('jobs.playbackRulesHint') }}</div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.markWatched" type="checkbox" />
              <span>{{ t('jobs.labelMarkWatched') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.markWatchedHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.verifyPlayable" type="checkbox" />
              <span>{{ t('jobs.labelVerifyPlayable') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.verifyPlayableHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.realWatch" type="checkbox" />
              <span>{{ t('jobs.labelRealWatch') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.realWatchHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.sequencePlay" type="checkbox" />
              <span>{{ t('jobs.labelSequencePlay') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.sequencePlayHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
              <input v-model.trim="runEveryDaysText" class="form-input" type="text" :placeholder="t('jobs.runEveryDaysPlaceholder')" style="max-width:120px" />
              <div style="font-size:11px;margin-top:4px" :style="runEveryDaysValid ? 'color:var(--text-faint)' : 'color:var(--danger-soft-text)'">{{ t('jobs.runEveryDaysHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
            </div>
          </div>
        </template>

        <!-- Custom: target bot + action chain -->
        <template v-if="form.jobType === 'custom'">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelTarget') }}</label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="BotUsername" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelJobMaxRetries') }}</label>
            <input v-model.number="customJobMaxRetries" class="form-input" type="number" min="1" max="20" style="max-width:120px" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.actions') }}</label>
            <ActionChainEditor
              :actions="customActions"
              :ai-key-missing="aiKeyMissing"
              :cf-browser-missing="cfBrowserMissing"
              :proxies="proxiesList"
              :profile-id-placeholder="profileIdPlaceholder"
              allow-ai-multiple-btn
            />
          </div>
        </template>

        <!-- Auto registration -->
        <template v-if="form.jobType === 'autoreg'">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelBot') }} <span style="color:var(--danger)">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelGroup') }} <span style="color:var(--danger)">*</span></label>
            <input v-model.trim="autoregCfg.groupId" class="form-input" placeholder="@groupname" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.groupHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodePrefix') }} <span v-if="!autoregCfg.codeRegex" style="color:var(--danger)">*</span></label>
            <input v-model.trim="autoregCfg.codePrefix" class="form-input" placeholder="ABC-*-XYZ_" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.codePrefixHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeRegex') }} <span v-if="!autoregCfg.codePrefix" style="color:var(--danger)">*</span></label>
            <input v-model.trim="autoregCfg.codeRegex" class="form-input" :placeholder="t('jobs.autoreg.codeRegexPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.codeRegexHint') }}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">{{ t('jobs.autoreg.eitherPrefixOrRegex') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.stripChinese" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelStripChinese') }}</span>
              </label>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.stripChineseHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelStripChars') }}</label>
              <input v-model.trim="autoregCfg.stripChars" class="form-input" :placeholder="t('jobs.autoreg.stripCharsPlaceholder')" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.stripCharsHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.aiModifyCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelAiModifyCode') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.aiModifyCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.aiModifyCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiModifyCodeHint') }}</label>
              <input v-model.trim="autoregCfg.aiModifyCodeHint" class="form-input" :placeholder="t('jobs.autoreg.aiModifyCodeHintPlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiContextCount') }}</label>
              <input v-model.number="autoregCfg.aiContextCount" class="form-input" type="number" min="0" max="50" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.aiContextCountHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelEntryMode') }}</label>
            <select v-model="autoregCfg.entryMode" class="form-select">
              <option value="button">{{ t('jobs.autoreg.entryModeButton') }}</option>
              <option value="command">{{ t('jobs.autoreg.entryModeCommand') }}</option>
            </select>
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.entryModeHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
              <select v-model="cmdDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: /start)</option>
                <option value="/start">/start</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
            </div>
            <div v-if="autoregCfg.entryMode === 'button'" class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelRegisterButton') }}</label>
              <input v-model.trim="autoregCfg.registerButton" class="form-input" :placeholder="t('jobs.autoreg.registerButtonPlaceholder')" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.registerButtonHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeReady') }}</label>
            <input v-model.trim="autoregCfg.codeReadyContains" class="form-input" :placeholder="t('jobs.autoreg.codeReadyPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.codeReadyHint') }}</div>
          </div>
          <!-- Some bots vet the code first, then offer a button/link that opens registration -->
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.clickAfterCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelClickAfterCode') }}</span>
            </label>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.clickAfterCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.clickAfterCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAfterCodeButton') }}</label>
              <input v-model.trim="autoregCfg.afterCodeButton" class="form-input" :placeholder="t('jobs.autoreg.afterCodeButtonPlaceholder')" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.afterCodeButtonHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.afterCodeRequired" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelAfterCodeRequired') }}</span>
              </label>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.afterCodeRequiredHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelSignupUsername') }} <span style="color:var(--danger)">*</span></label>
            <input v-model.trim="autoregCfg.signupUsername" class="form-input" placeholder="myname{num:3}" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.signupUsernameHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelUsernameReady') }}</label>
            <input v-model.trim="autoregCfg.usernameReadyContains" class="form-input" :placeholder="t('jobs.autoreg.usernameReadyPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.usernameReadyHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelListenMinutes') }}</label>
              <input v-model.number="autoregCfg.listenMinutes" class="form-input" type="number" min="1" max="1440" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.listenMinutesHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelScanHistory') }}</label>
              <input v-model.number="autoregCfg.scanHistoryCount" class="form-input" type="number" min="0" max="100" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.scanHistoryHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="autoregCfg.successContains" class="form-input" :placeholder="t('jobs.autoreg.successContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="autoregCfg.failContains" class="form-input" :placeholder="t('jobs.autoreg.failContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.autoreg.failContainsHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
              <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
            </div>
          </div>
        </template>

        <!-- checkin-specific fields -->
        <template v-if="form.jobType === 'checkin'">
          <div class="form-row" style="align-items:start">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
              <select v-model="cmdDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: /start)</option>
                <option value="/start">/start</option>
                <option value="/checkin">/checkin</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">{{ t('jobs.startCommandHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelCheckinButton') }}</label>
              <select v-model="btnDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: 签到)</option>
                <option value="签到">签到</option>
                <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="btnDropdown === 'custom'" v-model.trim="btnCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
              <template v-if="btnDropdown === '{aiBtn}'">
                <input v-model.trim="btnAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:var(--danger);margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </template>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
              <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="tplCheckinSuccessContains" class="form-input" :placeholder="t('jobs.successContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="tplCheckinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
          </div>
        </template>

        <ProxyPicker
          v-if="proxiesList.length"
          v-model="tplProxyId"
          :pool="tplProxyPool"
          :proxies="proxiesList"
          :label="t('jobs.labelProxy')"
          :blank-label="t('jobs.proxyNone')"
          :hint="proxyHint"
        />

      </div><!-- end modal-body -->
      <div class="modal-footer">
        <button class="btn btn-ghost" @click="emit('close')"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="saveTemplate">
          <i class="fa-solid fa-floppy-disk"></i> {{ saving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { templatesApi, settingsApi, type JobTemplate, type Settings, type UAPreset, type Proxy, type EmbywatchConfig, type CustomConfig, type AutoregConfig } from '../api/client';
import { t } from '../i18n';
import { regexValid } from '../utils/regexCheck';
import ActionChainEditor from './ActionChainEditor.vue';
import {
  actionsFromConfig,
  actionsToConfig,
  type CustomActionForm,
} from '../composables/customActions';
import { proxyFields } from '../composables/proxyPick';
import { availableTemplatePresets } from '../composables/templatePresets';
import { loadDataStoreSetting } from '../composables/dataStore';
import ProxyPicker from './ProxyPicker.vue';
import JobIconPicker from './JobIconPicker.vue';


/** The template being edited; null opens the form blank for a new one. */
const props = defineProps<{ template: JobTemplate | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const editTarget = ref<JobTemplate | null>(props.template);
const settings = ref<Settings | null>(null);
// Emby traffic goes out through the pick itself; for everything else it is the browser that
// does, with Telegram staying on the account's exit.
const proxyHint = computed(() =>
  form.jobType === 'embywatch' ? t('jobs.proxyEmbyHint') : t('jobs.proxyBrowserOnlyHint'),
);
const formError = ref('');
const saving = ref(false);

const uaPresets = computed<UAPreset[]>(() => {
  try { return JSON.parse(settings.value?.ua_presets ?? '[]'); } catch { return []; }
});
const proxiesList = computed<Proxy[]>(() => {
  try { return JSON.parse(settings.value?.proxies ?? '[]'); } catch { return []; }
});
const aiKeyMissing = computed(() => settings.value?.ai_key_configured !== 'true');
// A blank profile name falls back to the one configured in Settings, so show which
const profileIdPlaceholder = computed(() => settings.value?.cf_profile_id?.trim() || '{ip}');
// Anything that opens a page needs the solver's browser and its fonts in the data dir;
// neither ships in the image, so those options stay off until both are downloaded.
const cfBrowserMissing = computed(
  () =>
    !!settings.value &&
    (settings.value.cf_chromium_installed !== 'true' ||
      settings.value.cf_fonts_installed !== 'true'),
);

const customActions = ref<CustomActionForm[]>([]);
const customJobMaxRetries = ref(1);

const form = reactive({
  name: '',
  jobType: 'checkin' as 'checkin' | 'embywatch' | 'custom' | 'autoreg',
  botUsername: '',
  // Empty means follow the default_timezone setting
  timezone: '',
  replyTimeoutMs: 40000,
  retryMax: 5,
  runEveryDays: 1,
  runEveryDaysMax: null as number | null,
  icon: null as string | null,
});

// "Run every days" accepts a single number (7) or a range (7-15). Stored as
// runEveryDays (min) + runEveryDaysMax; the scheduler rolls a value in-range.
const runEveryDaysText = ref('1');
function parseRunEvery(text: string): { min: number; max: number | null } {
  const m = String(text).trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return { min: 1, max: null };
  const min = Math.max(1, parseInt(m[1], 10) || 1);
  const hi = m[2] != null ? parseInt(m[2], 10) : NaN;
  return { min, max: Number.isFinite(hi) && hi > min ? hi : null };
}
function formatRunEvery(min: number, max: number | null | undefined): string {
  return max != null && max > min ? `${min}-${max}` : String(min ?? 1);
}
const runEveryDaysValid = computed(() => /^\s*\d+\s*(-\s*\d+\s*)?$/.test(runEveryDaysText.value));

type AutoregCfgForm = {
  groupId: string;
  codePrefix: string;
  codeRegex: string;
  stripChinese: boolean;
  stripChars: string;
  aiModifyCode: boolean;
  aiModifyCodeHint: string;
  aiContextCount: number;
  codeReadyContains: string;
  usernameReadyContains: string;
  entryMode: 'button' | 'command';
  registerButton: string;
  clickAfterCode: boolean;
  afterCodeButton: string;
  afterCodeRequired: boolean;
  signupUsername: string;
  listenMinutes: number;
  scanHistoryCount: number;
  successContains: string;
  failContains: string;
};
function defaultAutoregCfg(): AutoregCfgForm {
  return {
    groupId: '',
    codePrefix: '',
    codeRegex: '',
    stripChinese: false,
    stripChars: '',
    aiModifyCode: false,
    aiModifyCodeHint: '',
    aiContextCount: 6,
    codeReadyContains: '',
    usernameReadyContains: '',
    entryMode: 'button',
    registerButton: '',
    clickAfterCode: false,
    afterCodeButton: '',
    afterCodeRequired: false,
    signupUsername: '',
    listenMinutes: 30,
    scanHistoryCount: 0,
    successContains: '',
    failContains: '',
  };
}
const autoregCfg = reactive<AutoregCfgForm>(defaultAutoregCfg());

const embyCfg = reactive<{ username: string; password: string; playDuration: number | string; userAgent: string; markWatched: boolean; verifyPlayable: boolean; realWatch: boolean; sequencePlay: boolean; library: string; ignoreSslErrors: boolean }>({
  username: '',
  password: '',
  playDuration: '',
  userAgent: '',
  markWatched: true,
  verifyPlayable: true,
  realWatch: false,
  sequencePlay: false,
  library: '',
  ignoreSslErrors: false,
});
const tplProxyId = ref('');
// Ids a 'random' template pick draws from; empty draws from the whole list
const tplProxyPool = ref<string[]>([]);
const embyUaDropdown = ref('');
const embyServer = reactive<{ protocol: 'https' | 'http'; host: string; port: number | '' }>({
  protocol: 'https',
  host: '',
  port: 443,
});

const CMD_PRESETS = new Set(['', '/start', '/checkin']);
const BTN_PRESETS = new Set(['', '签到', '{aiBtn}', '{anyBtn}']);
const cmdDropdown = ref('');
const cmdCustom = ref('');
const btnDropdown = ref('');
const btnCustom = ref('');
const btnAiHint = ref('');
const tplCheckinSuccessContains = ref('');
const tplCheckinFailContains = ref('');

function setCmdState(val: string) {
  if (CMD_PRESETS.has(val)) { cmdDropdown.value = val; cmdCustom.value = ''; }
  else { cmdDropdown.value = 'custom'; cmdCustom.value = val; }
}

function setBtnState(val: string) {
  const aiMatch = val.match(/^\{aiBtn:(.+)\}$/);
  if (aiMatch) {
    btnDropdown.value = '{aiBtn}'; btnAiHint.value = aiMatch[1].trim(); btnCustom.value = '';
  } else if (BTN_PRESETS.has(val)) {
    btnDropdown.value = val; btnCustom.value = ''; btnAiHint.value = '';
  } else {
    btnDropdown.value = 'custom'; btnCustom.value = val; btnAiHint.value = '';
  }
}

function setUaState(ua: string) {
  if (!ua) { embyUaDropdown.value = ''; return; }
  const match = uaPresets.value.find(p => p.value === ua);
  embyUaDropdown.value = match ? match.name : '__custom__';
}

function onUaDropdownChange() {
  if (embyUaDropdown.value === '') { embyCfg.userAgent = ''; return; }
  if (embyUaDropdown.value === '__custom__') return;
  const preset = uaPresets.value.find(p => p.name === embyUaDropdown.value);
  if (preset) embyCfg.userAgent = preset.value;
}

function onJobTypeChange() {
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  tplProxyId.value = '';
  tplProxyPool.value = [];
  customActions.value = [];
  customJobMaxRetries.value = 1;
  btnAiHint.value = '';
  tplCheckinSuccessContains.value = '';
  tplCheckinFailContains.value = '';
  Object.assign(autoregCfg, defaultAutoregCfg());
  setCmdState(''); setBtnState('');
}


function handleEmbyHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim();
  if (!text) return;
  const match = text.match(/^(?:(https?):\/\/)?([^:/\s]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return;
  const [, proto, host, portStr] = match;
  if (!proto && !portStr) return;
  event.preventDefault();
  if (proto === 'https' || proto === 'http') embyServer.protocol = proto as 'https' | 'http';
  embyServer.host = host;
  if (portStr) embyServer.port = Number(portStr);
}

function buildConfig(): EmbywatchConfig | CustomConfig | AutoregConfig | null {
  if (form.jobType === 'autoreg') {
    const cfg: AutoregConfig = {
      groupId: autoregCfg.groupId,
      codePrefix: autoregCfg.codePrefix,
      signupUsername: autoregCfg.signupUsername,
    };
    if (autoregCfg.entryMode === 'command') cfg.entryMode = 'command';
    else if (autoregCfg.registerButton.trim()) cfg.registerButton = autoregCfg.registerButton.trim();
    if (autoregCfg.listenMinutes > 0 && autoregCfg.listenMinutes !== 30) cfg.listenMinutes = autoregCfg.listenMinutes;
    if (autoregCfg.scanHistoryCount > 0) cfg.scanHistoryCount = autoregCfg.scanHistoryCount;
    if (autoregCfg.codeRegex.trim()) cfg.codeRegex = autoregCfg.codeRegex.trim();
    if (autoregCfg.stripChinese) cfg.stripChinese = true;
    if (autoregCfg.stripChars.trim()) cfg.stripChars = autoregCfg.stripChars.trim();
    if (autoregCfg.aiModifyCode) {
      cfg.aiModifyCode = true;
      if (autoregCfg.aiModifyCodeHint.trim()) cfg.aiModifyCodeHint = autoregCfg.aiModifyCodeHint.trim();
      if (autoregCfg.aiContextCount >= 0 && autoregCfg.aiContextCount !== 6) cfg.aiContextCount = autoregCfg.aiContextCount;
    }
    if (autoregCfg.codeReadyContains.trim()) cfg.codeReadyContains = autoregCfg.codeReadyContains.trim();
    if (autoregCfg.clickAfterCode) {
      cfg.clickAfterCode = true;
      if (autoregCfg.afterCodeButton.trim()) cfg.afterCodeButton = autoregCfg.afterCodeButton.trim();
      if (autoregCfg.afterCodeRequired) cfg.afterCodeRequired = true;
    }
    if (autoregCfg.usernameReadyContains.trim()) cfg.usernameReadyContains = autoregCfg.usernameReadyContains.trim();
    if (autoregCfg.successContains.trim()) cfg.successContains = autoregCfg.successContains.trim();
    if (autoregCfg.failContains.trim()) cfg.failContains = autoregCfg.failContains.trim();
    Object.assign(cfg, proxyFields(tplProxyId.value, tplProxyPool.value));
    return cfg;
  }
  if (form.jobType === 'embywatch') {
    // Credentials (username/password) are job-specific; template only stores playback settings
    const cfg: Partial<EmbywatchConfig> = {};
    if (embyCfg.playDuration !== '') cfg.playDuration = Number(embyCfg.playDuration as string | number);
    if (embyCfg.userAgent) cfg.userAgent = embyCfg.userAgent;
    cfg.markWatched = embyCfg.markWatched;
    cfg.verifyPlayable = embyCfg.verifyPlayable;
    cfg.realWatch = embyCfg.realWatch;
    cfg.sequencePlay = embyCfg.sequencePlay;
    cfg.ignoreSslErrors = embyCfg.ignoreSslErrors;
    if (embyCfg.library) cfg.library = embyCfg.library;
    Object.assign(cfg, proxyFields(tplProxyId.value, tplProxyPool.value));
    return cfg as EmbywatchConfig;
  }
  if (form.jobType === 'custom') {
    const cfg: CustomConfig = {
      actions: actionsToConfig(customActions.value),
    };
    if (customJobMaxRetries.value > 1) cfg.maxRetries = customJobMaxRetries.value;
    Object.assign(cfg, proxyFields(tplProxyId.value, tplProxyPool.value));
    return cfg;
  }
  if (form.jobType === 'checkin') {
    const s = tplCheckinSuccessContains.value.trim();
    const f = tplCheckinFailContains.value.trim();
    const proxy = proxyFields(tplProxyId.value, tplProxyPool.value);
    if (s || f || proxy.proxyId) return {
      ...(s ? { successContains: s } : {}),
      ...(f ? { failContains: f } : {}),
      ...proxy,
    } as unknown as CustomConfig;
    return null;
  }
  return null;
}

async function loadSettings() {
  try { settings.value = await settingsApi.get(); } catch { /* ignore */ }
}

function resetForm() {
  // See JobsView: the browser may have been installed since this view mounted
  Object.assign(form, {
    name: '',
    jobType: 'checkin',
    botUsername: '',
    timezone: '',
    replyTimeoutMs: 40000,
    retryMax: Number(settings.value?.default_max_retry ?? 5),
    runEveryDays: 1,
    runEveryDaysMax: null,
    icon: null,
  });
  runEveryDaysText.value = '1';
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  tplProxyId.value = '';
  tplProxyPool.value = [];
  customActions.value = [];
  customJobMaxRetries.value = 1;
  tplCheckinSuccessContains.value = '';
  tplCheckinFailContains.value = '';
  Object.assign(autoregCfg, defaultAutoregCfg());
  setCmdState(''); setBtnState('');
  formError.value = '';
}

function loadFromTemplate(tpl: JobTemplate) {
  Object.assign(form, {
    name: tpl.name,
    jobType: tpl.jobType,
    botUsername: tpl.botUsername,
    // A share only carries the timings its job type puts on this form, so the rest fall back
    timezone: tpl.timezone ?? '',
    replyTimeoutMs: tpl.replyTimeoutMs ?? 40000,
    retryMax: tpl.retryMax ?? Number(settings.value?.default_max_retry ?? 5),
    runEveryDays: tpl.runEveryDays ?? 1,
    runEveryDaysMax: tpl.runEveryDaysMax ?? null,
    icon: tpl.icon ?? null,
  });
  runEveryDaysText.value = formatRunEvery(tpl.runEveryDays ?? 1, tpl.runEveryDaysMax);
  setCmdState(tpl.startCommand === '/start' ? '' : (tpl.startCommand ?? ''));
  setBtnState(tpl.checkinButton === '签到' ? '' : (tpl.checkinButton ?? ''));

  tplProxyId.value = '';
  tplProxyPool.value = [];
  if (tpl.jobType === 'embywatch') {
    const m = tpl.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, {
      protocol: (m?.[1] ?? 'https') as 'https' | 'http',
      host: m?.[2] ?? tpl.botUsername,
      port: m?.[3] ? Number(m[3]) : 443,
    });
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as EmbywatchConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        Object.assign(embyCfg, {
          username: '',
          password: '',
          playDuration: c.playDuration ?? '',
          userAgent: c.userAgent ?? '',
          markWatched: c.markWatched !== false,
          verifyPlayable: c.verifyPlayable !== false,
          realWatch: c.realWatch === true,
          sequencePlay: c.sequencePlay === true,
          ignoreSslErrors: c.ignoreSslErrors === true,
          library: c.library ?? '',
        });
        tplProxyId.value = c.proxyId ?? '';
        tplProxyPool.value = [...(c.proxyPool ?? [])];
        setUaState(c.userAgent ?? '');
      } catch {
        Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
        embyUaDropdown.value = '';
      }
    } else {
      Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
      embyUaDropdown.value = '';
    }
  } else if (tpl.jobType === 'custom') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as CustomConfig & { proxyId?: string };
        tplProxyId.value = cfg.proxyId ?? '';
        tplProxyPool.value = [...(cfg.proxyPool ?? [])];
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = actionsFromConfig(cfg.actions);
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    } else {
      customActions.value = [];
      customJobMaxRetries.value = 1;
    }
  } else if (tpl.jobType === 'autoreg') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as (AutoregConfig & { proxyId?: string }) | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig & { proxyId?: string };
        tplProxyId.value = c.proxyId ?? '';
        tplProxyPool.value = [...(c.proxyPool ?? [])];
        Object.assign(autoregCfg, {
          groupId: c.groupId ?? '',
          codePrefix: c.codePrefix ?? '',
          codeRegex: c.codeRegex ?? '',
          stripChinese: c.stripChinese === true,
          stripChars: c.stripChars ?? '',
          aiModifyCode: c.aiModifyCode === true,
          aiModifyCodeHint: c.aiModifyCodeHint ?? '',
          aiContextCount: c.aiContextCount ?? 6,
          codeReadyContains: c.codeReadyContains ?? '',
          usernameReadyContains: c.usernameReadyContains ?? '',
          registerButton: c.registerButton ?? '',
          clickAfterCode: c.clickAfterCode === true,
          afterCodeButton: c.afterCodeButton ?? '',
          afterCodeRequired: c.afterCodeRequired === true,
          signupUsername: c.signupUsername ?? '',
          listenMinutes: c.listenMinutes ?? 30,
          scanHistoryCount: c.scanHistoryCount ?? 0,
          entryMode: c.entryMode === 'command' ? 'command' : 'button',
          successContains: c.successContains ?? '',
          failContains: c.failContains ?? '',
        });
      } catch { /* ignore */ }
    }
  } else {
    // checkin
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    tplCheckinSuccessContains.value = '';
    tplCheckinFailContains.value = '';
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as { proxyId?: string; proxyPool?: string[]; successContains?: string; failContains?: string };
        tplProxyId.value = cfg.proxyId ?? '';
        tplProxyPool.value = [...(cfg.proxyPool ?? [])];
        tplCheckinSuccessContains.value = cfg.successContains ?? '';
        tplCheckinFailContains.value = cfg.failContains ?? '';
      } catch { /* ignore */ }
    }
  }
  formError.value = '';
}

async function saveTemplate() {
  formError.value = '';
  if (!form.name) { formError.value = t('jobs.errors.nameRequired'); return; }
  if (form.jobType === 'custom') {
    // No target bot needed: an action can name its own contact, or drive a page that
    // never touches Telegram. The ones that do need it say so when they run.
    if (customActions.value.length === 0) { formError.value = t('jobs.errors.customActionsRequired'); return; }
  }
  if (form.jobType === 'embywatch') {
    if (!embyServer.host) { formError.value = t('jobs.errors.hostRequired'); return; }
    const portPart = (embyServer.port as number | string) !== '' ? `:${embyServer.port}` : '';
    form.botUsername = `${embyServer.protocol}://${embyServer.host.replace(/^https?:\/\//, '')}${portPart}`;
    // Credentials are set per-job, not in the template
  }
  if (form.jobType === 'autoreg') {
    if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
    if (!autoregCfg.groupId) { formError.value = t('jobs.errors.autoregGroupRequired'); return; }
    if (!autoregCfg.codePrefix && !autoregCfg.codeRegex) { formError.value = t('jobs.errors.autoregPrefixRequired'); return; }
    if (autoregCfg.codeRegex && !regexValid(autoregCfg.codeRegex)) { formError.value = t('jobs.errors.autoregRegexInvalid'); return; }
    if (!autoregCfg.signupUsername) { formError.value = t('jobs.errors.autoregUsernameRequired'); return; }
  }
  if (form.jobType === 'checkin' && !form.botUsername) {
    formError.value = t('jobs.errors.botRequired');
    return;
  }
  if (form.jobType === 'checkin' || form.jobType === 'autoreg') form.botUsername = form.botUsername.replace(/^@+/, '');

  saving.value = true;
  try {
    const rawCfg = buildConfig();
    const startCommand = (cmdDropdown.value === 'custom' ? cmdCustom.value : cmdDropdown.value) || undefined;
    const resolvedAiBtn = btnAiHint.value.trim() ? `{aiBtn:${btnAiHint.value.trim()}}` : '{aiBtn}';
    const checkinButton = btnDropdown.value === '{aiBtn}'
      ? resolvedAiBtn
      : (btnDropdown.value === 'custom' ? btnCustom.value : btnDropdown.value) || undefined;
    const re = parseRunEvery(runEveryDaysText.value);
    form.runEveryDays = re.min;
    form.runEveryDaysMax = re.max;
    const payload = {
      ...form,
      // config is serialised by the backend; pass as-is
      config: rawCfg as unknown as string | null,
      startCommand,
      checkinButton,
    };
    if (editTarget.value) {
      await templatesApi.update(editTarget.value.id, payload);
    } else {
      await templatesApi.create(payload);
    }
    emit('saved');
    emit('close');
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    saving.value = false;
  }
}

// A preset is loaded the same way a saved template is, so what lands in the form is exactly
// what the form would have shown had the template already existed -- and it is a copy from
// there on, free to be edited before it is saved.
const presetId = ref('');
const presetHint = computed(() => {
  const preset = availableTemplatePresets.value.find(p => p.id === presetId.value);
  return preset ? t(preset.hintKey) : '';
});

// Pasting a shared template over this one. The share carries what a template *is* -- its name,
// type, timings and config -- and not what this instance decided about it, so anything it leaves
// out keeps the value already in the form rather than reverting to a default. Applied to the form
// only: what saves it is the same Save button as any other edit, against the same id.
const showImport = ref(false);
const importJson = ref('');
const importError = ref('');
const importNotice = ref('');

function toggleImport() {
  showImport.value = !showImport.value;
  importError.value = '';
  importNotice.value = '';
}

function applyImport() {
  importError.value = '';
  importNotice.value = '';

  let raw: unknown;
  try {
    raw = JSON.parse(importJson.value);
  } catch {
    importError.value = t('templates.importError');
    return;
  }
  // Sharing several at once gives an array; only one can be pasted over one template
  const items = Array.isArray(raw) ? raw : [raw];
  const item = items[0] as Record<string, unknown> | undefined;
  if (!item || typeof item !== 'object' || !('name' in item) || !('jobType' in item)) {
    importError.value = t('templates.importError');
    return;
  }
  const notices: string[] = [];
  if (items.length > 1) notices.push(t('templates.overwriteFirstOnly').replace('{n}', String(items.length)));

  // The share stringifies the config; the form reads it back the same way a saved one is read
  const config =
    typeof item.config === 'string' || item.config == null
      ? (item.config as string | null)
      : JSON.stringify(item.config);

  // A proxy id only means something next to the list it came from: one this instance has not got
  // would otherwise read as configured while the job ran with no proxy at all
  let cleaned = config;
  if (config) {
    try {
      const parsed = JSON.parse(config) as Record<string, unknown>;
      const proxyId = parsed?.proxyId;
      if (typeof proxyId === 'string' && proxyId && !proxiesList.value.some((p) => p.id === proxyId)) {
        delete parsed.proxyId;
        cleaned = JSON.stringify(parsed);
        notices.push(t('templates.overwriteProxyDropped'));
      }
    } catch {
      /* not an object; left as it came */
    }
  }

  if (item.jobType && editTarget.value && item.jobType !== editTarget.value.jobType) {
    notices.push(
      t('templates.overwriteTypeChanged')
        .replace('{from}', String(editTarget.value.jobType))
        .replace('{to}', String(item.jobType)),
    );
  }

  // Merged over what is already here, so a share that says nothing about a field leaves it alone
  loadFromTemplate({ ...(editTarget.value as JobTemplate), ...item, config: cleaned } as JobTemplate);
  showImport.value = false;
  importJson.value = '';
  importNotice.value = notices.join(' ');
}

function applyPreset() {
  const preset = availableTemplatePresets.value.find(p => p.id === presetId.value);
  if (!preset) return;
  loadFromTemplate(preset.template());
}

// Seed straight away so the modal never renders a half-filled form
if (props.template) loadFromTemplate(props.template);
else resetForm();

onMounted(async () => {
  // Decides whether the preset picker is offered at all
  void loadDataStoreSetting();
  await loadSettings();
  // The retry default comes from settings, which land after the first paint
  if (!props.template) form.retryMax = Number(settings.value?.default_max_retry ?? 5);
  // A saved UA only matches a preset name once the presets are loaded
  if (props.template?.jobType === 'embywatch') setUaState(embyCfg.userAgent);
});
</script>

<style scoped>
.name-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name-with-icon .form-input {
  flex: 1;
  min-width: 0;
}

.job-name-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
}

</style>
