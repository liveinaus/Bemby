<template>
  <div class="modal-backdrop">
    <div class="modal" style="width:560px">
      <h3 class="modal-title">
        {{ t(editTarget ? 'templates.editTitle' : 'templates.addTitle') }}
        <span v-if="editTarget" class="modal-title-ids" :title="t('common.dbIdsHint')">{{ `{templateId} ${editTarget.id}` }}</span>
      </h3>
      <div class="modal-body">
        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <!-- Template Name + Job Type -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('templates.labelName') }} <span style="color:#e63946">*</span></label>
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
          <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:#e63946">*</span></label>
          <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
        </div>

        <!-- Emby Watch: Server URL -->
        <div v-if="form.jobType === 'embywatch'" class="form-group">
          <label class="form-label">{{ t('jobs.labelServerUrl') }} <span style="color:#e63946">*</span></label>
          <div style="display:flex;align-items:center;gap:6px">
            <select v-model="embyServer.protocol" class="form-select" style="width:88px;flex-shrink:0">
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <span style="color:#aaa;font-size:13px;flex-shrink:0">://</span>
            <input v-model.trim="embyServer.host" class="form-input" placeholder="emby.xxxx.com" @paste="handleEmbyHostPaste" />
            <span style="color:#aaa;font-size:13px;flex-shrink:0">:</span>
            <input v-model.number="embyServer.port" class="form-input" type="number" min="1" max="65535" style="width:72px;flex-shrink:0" placeholder="443" />
          </div>
        </div>

        <!-- embywatch-specific fields (credentials are set per-job, not in template) -->
        <template v-if="form.jobType === 'embywatch'">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">
                {{ t('jobs.labelPlayDuration') }}
                <span style="color:#aaa;font-weight:400"> — {{ t('common.blankForDefault') }}</span>
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
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.ignoreSslErrorsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelLibrary') }}</label>
            <input v-model.trim="embyCfg.library" class="form-input" type="text" :placeholder="t('jobs.libraryPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.libraryHint') }}</div>
          </div>
          <div class="emby-rules-hint">{{ t('jobs.playbackRulesHint') }}</div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.markWatched" type="checkbox" />
              <span>{{ t('jobs.labelMarkWatched') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.markWatchedHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.verifyPlayable" type="checkbox" />
              <span>{{ t('jobs.labelVerifyPlayable') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.verifyPlayableHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.realWatch" type="checkbox" />
              <span>{{ t('jobs.labelRealWatch') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.realWatchHint') }}</div>
          </div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.sequencePlay" type="checkbox" />
              <span>{{ t('jobs.labelSequencePlay') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.sequencePlayHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
              <input v-model.trim="runEveryDaysText" class="form-input" type="text" :placeholder="t('jobs.runEveryDaysPlaceholder')" style="max-width:120px" />
              <div style="font-size:11px;margin-top:4px" :style="runEveryDaysValid ? 'color:#aaa' : 'color:#991b1b'">{{ t('jobs.runEveryDaysHint') }}</div>
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
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('jobs.custom.actions') }}</label>
            <div v-if="customActions.length === 0" style="font-size:13px;color:#aaa;padding:10px 0">{{ t('jobs.custom.noActions') }}</div>
            <div v-for="(action, i) in customActions" :key="i" class="custom-action-card">
              <div class="custom-action-header">
                <span class="custom-action-num">{{ i + 1 }}</span>
                <select v-model="action.type" class="form-select custom-action-type-select">
                  <option value="send_command">{{ t('jobs.custom.actionSendCommand') }}</option>
                  <option value="send_contact_message">{{ t('jobs.custom.actionSendContactMessage') }}</option>
                  <option value="wait_reply">{{ t('jobs.custom.actionWaitReply') }}</option>
                  <option value="delay">{{ t('jobs.custom.actionDelay') }}</option>
                  <option value="click_button">{{ t('jobs.custom.actionClickButton') }}</option>
                  <option value="click_message_button">{{ t('jobs.custom.actionClickMessageButton') }}</option>
                  <option value="ai_multiple_btn" :disabled="aiKeyMissing">{{ t('jobs.custom.actionAiMultipleBtn') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                  <option value="enter_captcha" :disabled="aiKeyMissing">{{ t('jobs.custom.actionEnterCaptcha') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                  <option value="join_group">{{ t('jobs.custom.actionJoinGroup') }}</option>
                  <option value="subscribe_channel">{{ t('jobs.custom.actionSubscribeChannel') }}</option>
                  <option value="open_mini_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="open_mini_app_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenMiniAppUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="open_bot_menu_app" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenBotMenuApp') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                  <option value="open_url" :disabled="cfBrowserMissing">{{ t('jobs.custom.actionOpenUrl') }}{{ cfBrowserMissing ? ' (' + t('jobs.noCfBrowser') + ')' : '' }}</option>
                </select>
                <RowControls :index="i" :count="customActions.length" @move="moveAction(i, $event)" @insert="insertAction(i)" @remove="removeAction(i)" />
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
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                    <template v-if="action.contentDropdown === '{aiInput}'">
                      <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
              </div>

              <!-- send_contact_message -->
              <div v-if="action.type === 'send_contact_message'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                    <select v-model="action.contentDropdown" class="form-select">
                      <option value="/start">/start</option>
                      <option value="/checkin">/checkin</option>
                      <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                    <template v-if="action.contentDropdown === '{aiInput}'">
                      <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
              </div>

              <!-- wait_reply -->
              <div v-if="action.type === 'wait_reply'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- delay -->
              <div v-if="action.type === 'delay'" class="custom-action-params">
                <label class="form-label">{{ t('jobs.custom.labelWaitMs') }}</label>
                <input v-model.number="action.waitMs" class="form-input" type="number" min="100" step="500" />
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
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- click_message_button -->
              <div v-if="action.type === 'click_message_button'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelContact') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactHint') }}</div>
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
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- ai_multiple_btn -->
              <div v-if="action.type === 'ai_multiple_btn'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelContactOptional') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contactOptionalHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMessageContains') }}</label>
                  <input v-model.trim="action.messageContains" class="form-input" :placeholder="t('jobs.custom.messageContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.messageContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.aiHintLabel') }}</label>
                  <input v-model.trim="action.buttonAiHint" class="form-input" :placeholder="t('jobs.aiHintPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.aiMultipleBtnHint') }}</div>
                  <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelGapMs') }}</label>
                    <input v-model.number="action.gapMs" class="form-input" type="number" min="0" step="500" />
                    <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.gapMsHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelScope') }}</label>
                  <input v-model.number="action.scope" class="form-input" type="number" max="0" step="1" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.scopeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- enter_captcha -->
              <div v-if="action.type === 'enter_captcha'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelCaptchaLength') }}</label>
                    <input v-model.trim="action.captchaLength" class="form-input" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </div>

              <!-- join_group -->
              <div v-if="action.type === 'join_group'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelGroupId') }}</label>
                  <input v-model.trim="action.groupId" class="form-input" :placeholder="t('jobs.custom.groupIdPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.groupIdHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.checkMembership" />
                    {{ t('jobs.custom.labelCheckMembership') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkMembershipHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelVerifyButton') }}</label>
                  <input v-model.trim="action.verifyButton" class="form-input" :placeholder="t('jobs.custom.verifyButtonPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyButtonHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.verifyMentionsMe" />
                    {{ t('jobs.custom.labelVerifyMentionsMe') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyMentionsMeHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.verifyMaskedName" />
                    {{ t('jobs.custom.labelVerifyMaskedName') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyMaskedNameHint') }}</div>
                </div>
                <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelVerifyWaitMs') }}</label>
                  <input v-model.number="action.verifyWaitMs" type="number" min="1000" step="1000" class="form-input" />
                </div>
                <div v-if="action.verifyButton" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelVerifyMaxWaitMs') }}</label>
                  <input v-model.number="action.verifyMaxWaitMs" type="number" min="1000" step="1000" class="form-input" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.verifyMaxWaitMsHint') }}</div>
                </div>
              </div>

              <!-- subscribe_channel -->
              <div v-if="action.type === 'subscribe_channel'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelChannelId') }}</label>
                  <input v-model.trim="action.channelId" class="form-input" :placeholder="t('jobs.custom.channelIdPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.channelIdHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.checkMembership" />
                    {{ t('jobs.custom.labelCheckSubscription') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.checkSubscriptionHint') }}</div>
                </div>
              </div>

              <!-- open_mini_app / open_mini_app_url / open_bot_menu_app -->
              <div v-if="action.type === 'open_mini_app' || action.type === 'open_mini_app_url' || action.type === 'open_bot_menu_app'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ action.type === 'open_mini_app' ? t('jobs.custom.labelContactOptional') : action.type === 'open_mini_app_url' ? t('jobs.custom.labelMiniAppOwner') : t('jobs.custom.labelMenuAppOwner') }}</label>
                  <input v-model.trim="action.contact" class="form-input" :placeholder="t('jobs.custom.contactOptionalPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ action.type === 'open_mini_app' ? t('jobs.custom.contactOptionalHint') : action.type === 'open_mini_app_url' ? t('jobs.custom.miniAppOwnerHint') : t('jobs.custom.menuAppOwnerHint') }}</div>
                </div>
                <div v-if="action.type === 'open_mini_app_url'" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppUrl') }}</label>
                  <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.custom.miniAppUrlPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppUrlHint') }}</div>
                </div>
                <div v-if="action.type === 'open_mini_app'" class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelMiniAppButton') }}</label>
                  <input v-model.trim="action.button" class="form-input" :placeholder="t('jobs.custom.miniAppButtonPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppButtonHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <MiniAppStepsEditor :steps="action.appSteps" />
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                    <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <ProxyPicker
                    v-model="action.miniAppProxyId"
                    :pool="action.miniAppProxyPool"
                    :proxies="proxiesList"
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
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.web.labelProfileId') }}</label>
                  <input v-model.trim="action.profileId" class="form-input" :placeholder="profileIdPlaceholder" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.web.profileIdHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-checkbox-label">
                    <input type="checkbox" v-model="action.keepAppSession" />
                    {{ t('jobs.custom.labelKeepAppSession') }}
                  </label>
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.keepAppSessionHint') }}</div>
                </div>
              </div>

              <!-- open_url -->
              <div v-if="action.type === 'open_url'" class="custom-action-params">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.web.labelUrl') }}</label>
                  <input v-model.trim="action.url" class="form-input" :placeholder="t('jobs.web.urlPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.web.urlHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:10px">
                  <WebStepsEditor :steps="action.webSteps" :ai-key-missing="aiKeyMissing" />
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
                <div class="form-row" style="margin-bottom:0;margin-top:8px">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMiniAppMaxWait') }}</label>
                    <input v-model.number="action.miniAppMaxWaitMs" class="form-input" type="number" min="0" step="10000" placeholder="300000" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppMaxWaitHint') }}</div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <ProxyPicker
                    v-model="action.miniAppProxyId"
                    :pool="action.miniAppProxyPool"
                    :proxies="proxiesList"
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
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.miniAppTryAllHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0;margin-top:8px">
                  <label class="form-label">{{ t('jobs.web.labelProfileId') }}</label>
                  <input v-model.trim="action.profileId" class="form-input" :placeholder="profileIdPlaceholder" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.web.profileIdHint') }}</div>
                </div>
              </div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" @click="addAction">
              <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addAction') }}
            </button>
          </div>
        </template>

        <!-- Auto registration -->
        <template v-if="form.jobType === 'autoreg'">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelBot') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelGroup') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.groupId" class="form-input" placeholder="@groupname" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.groupHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodePrefix') }} <span v-if="!autoregCfg.codeRegex" style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.codePrefix" class="form-input" placeholder="ABC-*-XYZ_" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codePrefixHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeRegex') }} <span v-if="!autoregCfg.codePrefix" style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.codeRegex" class="form-input" :placeholder="t('jobs.autoreg.codeRegexPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeRegexHint') }}</div>
            <div style="font-size:11px;color:#777;margin-top:3px">{{ t('jobs.autoreg.eitherPrefixOrRegex') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.stripChinese" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelStripChinese') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.stripChineseHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelStripChars') }}</label>
              <input v-model.trim="autoregCfg.stripChars" class="form-input" :placeholder="t('jobs.autoreg.stripCharsPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.stripCharsHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.aiModifyCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelAiModifyCode') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.aiModifyCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.aiModifyCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiModifyCodeHint') }}</label>
              <input v-model.trim="autoregCfg.aiModifyCodeHint" class="form-input" :placeholder="t('jobs.autoreg.aiModifyCodeHintPlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAiContextCount') }}</label>
              <input v-model.number="autoregCfg.aiContextCount" class="form-input" type="number" min="0" max="50" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.aiContextCountHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelEntryMode') }}</label>
            <select v-model="autoregCfg.entryMode" class="form-select">
              <option value="button">{{ t('jobs.autoreg.entryModeButton') }}</option>
              <option value="command">{{ t('jobs.autoreg.entryModeCommand') }}</option>
            </select>
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.entryModeHint') }}</div>
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
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.registerButtonHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelCodeReady') }}</label>
            <input v-model.trim="autoregCfg.codeReadyContains" class="form-input" :placeholder="t('jobs.autoreg.codeReadyPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.codeReadyHint') }}</div>
          </div>
          <!-- Some bots vet the code first, then offer a button/link that opens registration -->
          <div class="form-group">
            <label class="form-check">
              <input v-model="autoregCfg.clickAfterCode" type="checkbox" />
              <span>{{ t('jobs.autoreg.labelClickAfterCode') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.clickAfterCodeHint') }}</div>
          </div>
          <div v-if="autoregCfg.clickAfterCode" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelAfterCodeButton') }}</label>
              <input v-model.trim="autoregCfg.afterCodeButton" class="form-input" :placeholder="t('jobs.autoreg.afterCodeButtonPlaceholder')" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.afterCodeButtonHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-check">
                <input v-model="autoregCfg.afterCodeRequired" type="checkbox" />
                <span>{{ t('jobs.autoreg.labelAfterCodeRequired') }}</span>
              </label>
              <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.autoreg.afterCodeRequiredHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelSignupUsername') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="autoregCfg.signupUsername" class="form-input" placeholder="myname{num:3}" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.signupUsernameHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.autoreg.labelUsernameReady') }}</label>
            <input v-model.trim="autoregCfg.usernameReadyContains" class="form-input" :placeholder="t('jobs.autoreg.usernameReadyPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.usernameReadyHint') }}</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelListenMinutes') }}</label>
              <input v-model.number="autoregCfg.listenMinutes" class="form-input" type="number" min="1" max="1440" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.listenMinutesHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelScanHistory') }}</label>
              <input v-model.number="autoregCfg.scanHistoryCount" class="form-input" type="number" min="0" max="100" />
              <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.scanHistoryHint') }}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="autoregCfg.successContains" class="form-input" :placeholder="t('jobs.autoreg.successContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="autoregCfg.failContains" class="form-input" :placeholder="t('jobs.autoreg.failContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.autoreg.failContainsHint') }}</div>
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
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.startCommandHint') }}</div>
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
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
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
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="tplCheckinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
          </div>
        </template>

        <ProxyPicker
          v-if="proxiesList.length"
          v-model="tplProxyId"
          :pool="tplProxyPool"
          :proxies="proxiesList"
          :label="t('jobs.labelProxy')"
          :blank-label="t('jobs.proxyNone')"
          :hint="t('jobs.proxyBrowserOnlyHint')"
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
import { templatesApi, settingsApi, type JobTemplate, type Settings, type UAPreset, type Proxy, type EmbywatchConfig, type CustomConfig, type CustomAction, type AutoregConfig } from '../api/client';
import { t } from '../i18n';
import { regexValid } from '../utils/regexCheck';
import WebStepsEditor from './WebStepsEditor.vue';
import MiniAppStepsEditor from './MiniAppStepsEditor.vue';
import RowControls from './RowControls.vue';
import { webStepsFromConfig, webStepsToConfig, type WebStepForm } from '../composables/webSteps';
import { appButtonsOf } from '../composables/miniAppSteps';
import { proxyFields } from '../composables/proxyPick';
import ProxyPicker from './ProxyPicker.vue';
import JobIconPicker from './JobIconPicker.vue';

type CustomActionForm = {
  type: 'send_command' | 'send_contact_message' | 'wait_reply' | 'delay' | 'click_button' | 'click_message_button' | 'ai_multiple_btn' | 'enter_captcha' | 'join_group' | 'subscribe_channel' | 'open_mini_app' | 'open_mini_app_url' | 'open_bot_menu_app' | 'open_url';
  content: string;
  contentDropdown: string;
  contentCustom: string;
  contentAiInputLength: string;
  maxWaitMs: number;
  waitMs: number;
  gapMs: number;
  button: string;
  buttonDropdown: string;
  buttonCustom: string;
  buttonAiHint: string;
  maxRetries: number;
  scope: number;
  captchaLength: string;
  successContains: string;
  failContains: string;
  /** ai_multiple_btn: wording the buttons message must contain */
  messageContains: string;
  contact: string;
  groupId: string;
  checkMembership: boolean;
  verifyButton: string;
  verifyWaitMs: number;
  /** join_group: bounds the whole verification, private-chat hand-off included */
  verifyMaxWaitMs: number;
  /** join_group: only click a verification prompt naming this account */
  verifyMentionsMe: boolean;
  /** join_group: also accept a prompt naming this account with a masked name */
  verifyMaskedName: boolean;
  channelId: string;
  /** Mini App actions: the in-app steps, one per entry, run in order */
  appSteps: string[];
  /** open_mini_app: browser budget, 0 = default */
  miniAppMaxWaitMs: number;
  /** open_mini_app: pinned browser proxy id, 'direct', or '' for the job proxy */
  miniAppProxyId: string;
  miniAppTryAllProxies: boolean;
  /** Ids a 'random' pick draws from; empty draws from the whole list */
  miniAppProxyPool: string[];
  profileId: string;
  /** Mini App actions: keep what the app stored last run instead of signing in afresh */
  keepAppSession: boolean;
  /** open_url: the page to open */
  url: string;
  /** open_url: sub-steps run on the page once it is up */
  webSteps: WebStepForm[];
};

/** The template being edited; null opens the form blank for a new one. */
const props = defineProps<{ template: JobTemplate | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const editTarget = ref<JobTemplate | null>(props.template);
const settings = ref<Settings | null>(null);
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
const ACTION_CMD_PRESETS = new Set(['/start', '/checkin']);
const ACTION_BTN_PRESETS = new Set(['签到', '{anyBtn}']);
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

function defaultAction(): CustomActionForm {
  return {
    type: 'send_command', content: '/start', contentDropdown: '/start', contentCustom: '',
    contentAiInputLength: '', maxWaitMs: 30000, waitMs: 2000, gapMs: 1000, button: '签到',
    buttonDropdown: '签到', buttonCustom: '', buttonAiHint: '', maxRetries: 3, scope: 0,
    captchaLength: '', successContains: '', failContains: '', messageContains: '', contact: '', groupId: '', checkMembership: false,
    verifyButton: '', verifyWaitMs: 30000, verifyMaxWaitMs: 120000, verifyMentionsMe: false, verifyMaskedName: false, channelId: '', appSteps: [],
    miniAppMaxWaitMs: 300000, miniAppProxyId: '', miniAppProxyPool: [], miniAppTryAllProxies: true,
    url: '', webSteps: [], profileId: '', keepAppSession: false,
  };
}

function addAction() { customActions.value.push(defaultAction()); }
/** Puts a new action straight after this one, rather than at the end to be walked up. */
function insertAction(i: number) { customActions.value.splice(i + 1, 0, defaultAction()); }
function removeAction(i: number) { customActions.value.splice(i, 1); }
function moveAction(i: number, by: number) {
  const arr = customActions.value;
  const to = i + by;
  if (to < 0 || to >= arr.length) return;
  [arr[i], arr[to]] = [arr[to], arr[i]];
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
      actions: customActions.value.map(a => {
        if (a.type === 'send_command') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_command' as const, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'send_contact_message') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_contact_message' as const, contact: a.contact, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'wait_reply') {
          return {
            type: 'wait_reply' as const,
            maxWaitMs: a.maxWaitMs,
            ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
            ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
            ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
            ...(a.scope ? { scope: a.scope } : {}),
          };
        }
        if (a.type === 'delay') return { type: 'delay' as const, waitMs: a.waitMs };
        if (a.type === 'enter_captcha') {
          const captchaLength = a.captchaLength ? parseInt(a.captchaLength) || undefined : undefined;
          return { type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'join_group') return {
          type: 'join_group' as const,
          groupId: a.groupId,
          ...(a.checkMembership ? { checkMembership: true } : {}),
          ...(a.verifyButton.trim() ? { verifyButton: a.verifyButton.trim(), verifyWaitMs: a.verifyWaitMs, verifyMaxWaitMs: a.verifyMaxWaitMs } : {}),
          ...(a.verifyMentionsMe ? { verifyMentionsMe: true } : {}),
          ...(a.verifyMaskedName ? { verifyMaskedName: true } : {}),
        };
        if (a.type === 'subscribe_channel') return { type: 'subscribe_channel' as const, channelId: a.channelId, ...(a.checkMembership ? { checkMembership: true } : {}) };
        if (a.type === 'open_mini_app') return {
          type: 'open_mini_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.button.trim() ? { button: a.button.trim() } : {}),
          ...appButtonsOf(a.appSteps),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
          ...(a.profileId ? { profileId: a.profileId } : {}),
          ...(a.keepAppSession ? { keepAppSession: true } : {}),
        };
        if (a.type === 'open_mini_app_url') return {
          type: 'open_mini_app_url' as const,
          url: a.url.trim(),
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...appButtonsOf(a.appSteps),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
          ...(a.profileId ? { profileId: a.profileId } : {}),
          ...(a.keepAppSession ? { keepAppSession: true } : {}),
        };
        if (a.type === 'open_bot_menu_app') return {
          type: 'open_bot_menu_app' as const,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...appButtonsOf(a.appSteps),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
          ...(a.profileId ? { profileId: a.profileId } : {}),
          ...(a.keepAppSession ? { keepAppSession: true } : {}),
        };
        if (a.type === 'open_url') return {
          type: 'open_url' as const,
          url: a.url.trim(),
          ...(a.webSteps.length ? { steps: webStepsToConfig(a.webSteps) } : {}),
          ...(a.profileId ? { profileId: a.profileId } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          ...(a.miniAppMaxWaitMs > 0 ? { maxWaitMs: a.miniAppMaxWaitMs } : {}),
          ...proxyFields(a.miniAppProxyId, a.miniAppProxyPool),
          ...(a.miniAppTryAllProxies ? {} : { tryAllProxies: false }),
          ...(a.profileId ? { profileId: a.profileId } : {}),
        };
        if (a.type === 'ai_multiple_btn') return {
          type: 'ai_multiple_btn' as const,
          gapMs: a.gapMs,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.contact.trim() ? { contact: a.contact.trim() } : {}),
          ...(a.buttonAiHint.trim() ? { hint: a.buttonAiHint.trim() } : {}),
          ...(a.messageContains.trim() ? { messageContains: a.messageContains.trim() } : {}),
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
        };
        let button: string;
        if (a.buttonDropdown === 'custom') button = a.buttonCustom;
        else if (a.buttonDropdown === '{aiBtn}') button = a.buttonAiHint.trim() ? `{aiBtn:${a.buttonAiHint.trim()}}` : '{aiBtn}';
        else button = a.buttonDropdown || '签到';
        if (a.type === 'click_message_button') return {
          type: 'click_message_button' as const,
          contact: a.contact,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
        };
        return {
          type: 'click_button' as const,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
        };
      }),
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
    timezone: tpl.timezone,
    replyTimeoutMs: tpl.replyTimeoutMs,
    retryMax: tpl.retryMax,
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
        customActions.value = cfg.actions.map((a: CustomAction) => {
          const base = defaultAction();
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_command' as const, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command' as const, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'send_contact_message') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_contact_message' as const, contact: a.contact, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply' as const, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, scope: a.scope ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay' as const, waitMs: a.waitMs };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'join_group') return { ...base, type: 'join_group' as const, groupId: a.groupId, checkMembership: a.checkMembership ?? false, verifyButton: a.verifyButton ?? '', verifyWaitMs: a.verifyWaitMs ?? 30000, verifyMaxWaitMs: a.verifyMaxWaitMs ?? 120000, verifyMentionsMe: a.verifyMentionsMe ?? false, verifyMaskedName: a.verifyMaskedName ?? false };
          if (a.type === 'subscribe_channel') return { ...base, type: 'subscribe_channel' as const, channelId: a.channelId, checkMembership: a.checkMembership ?? false };
          if (a.type === 'open_mini_app') return { ...base, type: 'open_mini_app' as const, contact: a.contact ?? '', button: a.button ?? '', appSteps: [...(a.appButtons ?? [])], successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppProxyPool: [...(a.proxyPool ?? [])], miniAppTryAllProxies: a.tryAllProxies ?? true, profileId: a.profileId ?? '', keepAppSession: a.keepAppSession ?? false };
          if (a.type === 'open_mini_app_url') return { ...base, type: 'open_mini_app_url' as const, url: a.url ?? '', contact: a.contact ?? '', appSteps: [...(a.appButtons ?? [])], successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppProxyPool: [...(a.proxyPool ?? [])], miniAppTryAllProxies: a.tryAllProxies ?? true, profileId: a.profileId ?? '', keepAppSession: a.keepAppSession ?? false };
          if (a.type === 'open_bot_menu_app') return { ...base, type: 'open_bot_menu_app' as const, contact: a.contact ?? '', appSteps: [...(a.appButtons ?? [])], successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppProxyPool: [...(a.proxyPool ?? [])], miniAppTryAllProxies: a.tryAllProxies ?? true, profileId: a.profileId ?? '', keepAppSession: a.keepAppSession ?? false };
          if (a.type === 'open_url') return { ...base, type: 'open_url' as const, url: a.url ?? '', webSteps: webStepsFromConfig(a.steps), successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0, miniAppMaxWaitMs: a.maxWaitMs ?? 0, miniAppProxyId: a.proxyId ?? '', miniAppProxyPool: [...(a.proxyPool ?? [])], miniAppTryAllProxies: a.tryAllProxies ?? true, profileId: a.profileId ?? '' };
          if (a.type === 'ai_multiple_btn') return { ...base, type: 'ai_multiple_btn' as const, contact: a.contact ?? '', buttonAiHint: a.hint ?? '', messageContains: a.messageContains ?? '', gapMs: a.gapMs ?? 1000, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_button' as const, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          }
          if (a.type === 'click_message_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_message_button' as const, contact: a.contact, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', scope: a.scope ?? 0 };
          }
          return base;
        });
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

// Seed straight away so the modal never renders a half-filled form
if (props.template) loadFromTemplate(props.template);
else resetForm();

onMounted(async () => {
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
  color: #6b7280;
}

.custom-action-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafafa;
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
  color: #aaa;
}

.custom-action-type-select {
  flex: 1;
}

.custom-action-params {
  padding-left: 26px;
}

</style>
