<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('jobs.title') }}</h2>
      <button class="btn btn-primary" @click="openAdd"><i class="fa-solid fa-plus"></i> {{ t('jobs.addBtn') }}</button>
    </div>

    <!-- Scheduler status; hidden when the operator moved it to its own menu entry -->
    <ScheduleList v-if="!scheduleSeparatePage" ref="scheduleListRef" collapsible />

    <div class="card">
      <!-- Filters -->
      <div style="padding:12px 16px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button
          v-for="opt in filterOptions" :key="opt.value"
          class="btn btn-sm"
          :class="filterType === opt.value ? 'btn-primary' : 'btn-ghost'"
          @click="filterType = opt.value"
        >{{ opt.label }}</button>
        <select v-if="accountFilterOptions.length" v-model="filterAccountId" class="form-select" style="width:160px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allAccounts') }}</option>
          <option v-for="a in accountFilterOptions" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
        </select>
        <select v-if="botUrlTplFilterOptions.length" v-model="filterBotUrlTpl" class="form-select" style="width:180px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allBotUrlTpl') }}</option>
          <option v-for="opt in botUrlTplFilterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <input v-model="filterName" class="form-input" style="width:160px;height:30px;font-size:13px;padding:0 8px" :placeholder="t('jobs.filterPlaceholder')" />
        <button
          class="btn btn-sm"
          :class="showLastSuccess ? 'btn-primary' : 'btn-ghost'"
          :title="t('jobs.toggleLastSuccessHint')"
          @click="showLastSuccess = !showLastSuccess"
        >
          <i class="fa-solid fa-clock-rotate-left"></i> {{ t('jobs.colLastSuccess') }}
        </button>
        <button v-if="jobs.length" class="btn btn-sm btn-secondary" style="margin-left:auto" @click="toggleAllJobs">
          {{ allJobsSelected ? t('common.deselectAll') : t('common.selectAll') }}
        </button>
      </div>
      <!-- Bulk action bar -->
      <div v-if="selectedJobIds.length" class="bulk-bar">
        <span class="bulk-count">{{ t('jobs.selectedCount').replace('{n}', String(selectedJobIds.length)) }}</span>
        <button class="btn btn-sm btn-success" @click="openBulkRun"><i class="fa-solid fa-play"></i> {{ t('jobs.bulkRun').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="bulkEnableJobs"><i class="fa-solid fa-circle-check"></i> {{ t('jobs.bulkEnable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="confirmBulkDisableJobs = true"><i class="fa-solid fa-ban"></i> {{ t('jobs.bulkDisable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-danger" @click="confirmBulkRetireJobs = true"><i class="fa-solid fa-box-archive"></i> {{ t('jobs.bulkRetire').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="showBulkWindowModal = true"><i class="fa-solid fa-clock"></i> {{ t('jobs.bulkWindow').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-ghost" style="margin-left:auto" @click="selectedJobIds = []"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <PaginationBar
        :page="page" :page-size="pageSize" :total="total"
        @update:page="onPageChange" @update:page-size="onPageSizeChange"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="th-sort" :class="sortKey === 'name' ? 'sort-active' : ''" @click="setSort('name')">{{ t('common.name') }} <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th class="th-sort" :class="sortKey === 'account' ? 'sort-active' : ''" @click="setSort('account')">{{ t('jobs.colAccount') }} <span class="sort-icon">{{ sortIcon('account') }}</span></th>
              <th class="th-sort" :class="sortKey === 'type' ? 'sort-active' : ''" @click="setSort('type')">{{ t('jobs.colType') }} <span class="sort-icon">{{ sortIcon('type') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'botUrl' ? 'sort-active' : ''" @click="setSort('botUrl')">{{ t('jobs.colBotUrlTpl') }} <span class="sort-icon">{{ sortIcon('botUrl') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'window' ? 'sort-active' : ''" @click="setSort('window')">{{ t('jobs.colWindow') }} <span class="sort-icon">{{ sortIcon('window') }}</span></th>
              <th v-if="showLastSuccess" class="th-sort" :class="sortKey === 'lastSuccess' ? 'sort-active' : ''" @click="setSort('lastSuccess')">{{ t('jobs.colLastSuccess') }} <span class="sort-icon">{{ sortIcon('lastSuccess') }}</span></th>
              <th v-if="jobProxyColumn" class="col-hide-mobile">{{ t('jobs.colProxy') }}</th>
              <th class="th-sort" :class="sortKey === 'enabled' ? 'sort-active' : ''" @click="setSort('enabled')">{{ t('jobs.colEnabled') }} <span class="sort-icon">{{ sortIcon('enabled') }}</span></th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!jobs.length">
              <td :colspan="7 + (showLastSuccess ? 1 : 0) + (jobProxyColumn ? 1 : 0)" class="empty">{{ t('jobs.noJobs') }}</td>
            </tr>
            <tr
              v-for="(j, idx) in jobs" :key="j.id"
              style="cursor:pointer"
              :class="selectedJobIds.includes(j.id) ? 'row-selected' : ''"
              @click="toggleJobSelect(j.id, idx, $event)"
            >
              <td>
                <span class="job-name-cell">
                  <JobIcon :icon="j.icon" :size="15" />
                  {{ j.name }}
                </span>
              </td>
              <td>{{ jobAccountLabel(j) }}</td>
              <td><span :class="jobTypeBadge(j.jobType)">{{ t(`logs.jobType.${j.jobType}`) }}</span></td>
              <td class="col-hide-mobile">
                <template v-if="j.templateId">
                  <span class="badge badge-tpl" style="margin-left:0;margin-right:4px">T</span>{{ templates.find(t => t.id === j.templateId)?.name ?? '' }}
                </template>
                <template v-else>{{ j.jobType === 'embywatch' ? j.botUsername : '@' + j.botUsername }}</template>
              </td>
              <td class="col-hide-mobile">{{ fmtWindow(j.scheduleWindowStart, j.scheduleWindowEnd) }}</td>
              <td v-if="showLastSuccess">
                <span v-if="j.lastSuccessAt" class="last-success" :title="fmtDateTimeFull(j.lastSuccessAt)">{{ fmtSince(j.lastSuccessAt) }}</span>
                <span v-else class="last-success-never">{{ t('jobs.neverSucceeded') }}</span>
              </td>
              <td v-if="jobProxyColumn" class="col-hide-mobile">
                <span
                  class="job-proxy"
                  :class="[
                    `job-proxy-${j.effectiveProxy?.kind ?? 'direct'}`,
                    { 'job-proxy-missing': j.effectiveProxy?.missing || j.effectiveProxy?.tgMissing },
                  ]"
                  :title="proxyTitle(j.effectiveProxy)"
                >
                  <i class="fa-solid" :class="proxyIcon(j.effectiveProxy)"></i>
                  <span class="job-proxy-name">{{ proxyText(j.effectiveProxy) }}</span>
                </span>
              </td>
              <td>
                <span
                  :class="j.enabled ? 'badge badge-green' : 'badge badge-grey'"
                  style="cursor:pointer;user-select:none"
                  @click.stop="toggleEnabled(j)"
                >
                  {{ j.enabled ? t('common.yes') : t('common.no') }}
                </span>
                <span v-if="j.oneTime" class="badge badge-grey" :title="t('jobs.oneTimeHint')">{{ t('jobs.badgeOneTime') }}</span>
              </td>
              <td @click.stop>
                <!-- desktop: icon buttons -->
                <div class="actions hide-mobile">
                  <button class="btn btn-sm btn-success btn-icon" :disabled="running.has(j.id)" :title="t('common.run')" @click="runNow(j.id)">
                    <i class="fa-solid fa-play"></i>
                  </button>
                  <button
                    v-if="watchableRun(j.id)"
                    class="btn btn-sm btn-ghost btn-icon"
                    style="color: var(--success)"
                    :title="t('manualBrowser.watch')"
                    @click="watchRun(watchableRun(j.id) as string)"
                  >
                    <i class="fa-solid fa-eye"></i>
                  </button>
                  <button v-else-if="j.jobType === 'custom'" class="btn btn-sm btn-ghost btn-icon" :title="t('manualBrowser.open')" @click="openManualBrowser(j.id)">
                    <i class="fa-solid fa-desktop"></i>
                  </button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.edit')" @click="openEdit(j)"><i class="fa-solid fa-pen"></i></button>
                  <button
                    v-if="templateEditButton && j.templateId"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('jobs.editTemplateBtn')"
                    @click="openTemplateEdit(j)"
                  >
                    <i class="fa-solid fa-file-pen"></i>
                  </button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.duplicate')" @click="openDuplicate(j)"><i class="fa-solid fa-copy"></i></button>
                  <button class="btn btn-sm btn-danger btn-icon" :title="t('common.retire')" @click="retire(j.id)"><i class="fa-solid fa-box-archive"></i></button>
                </div>
                <!-- mobile: single button opens action sheet -->
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuJob = j">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal modal-form" :class="{ 'modal-wide': form.jobType === 'custom' && !form.templateId }">
        <h3 class="modal-title">
          {{ t(editTarget ? 'jobs.editTitle' : 'jobs.addTitle') }}
          <span v-if="profileVarIds" class="modal-title-ids" :title="t('common.dbIdsHint')">{{ profileVarIds }}</span>
        </h3>
        <div class="modal-body">
        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <!-- Template selector + Enabled inline -->
        <div v-if="templates.length" style="display:flex;gap:12px;align-items:flex-end;margin-bottom:14px">
          <div style="flex:1">
            <label class="form-label">{{ t('templates.labelTemplate') }}</label>
            <select v-model="form.templateId" class="form-select" @change="onTemplateChange">
              <option :value="null">{{ t('templates.noTemplate') }}</option>
              <option v-for="tpl in templates.filter(t => t.enabled || t.id === form.templateId)" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
            </select>
          </div>
          <div style="padding-bottom:9px;white-space:nowrap">
            <label class="form-check">
              <input v-model="form.enabled" type="checkbox" />
              <span>{{ t('jobs.labelEnabled') }}</span>
            </label>
          </div>
        </div>

        <!-- Enabled standalone (no templates configured) -->
        <div v-else style="margin-bottom:14px">
          <label class="form-check">
            <input v-model="form.enabled" type="checkbox" />
            <span>{{ t('jobs.labelEnabled') }}</span>
          </label>
        </div>

        <!-- Template summary -->
        <div v-if="form.templateId && linkedTemplate" class="template-summary-card">
          <div class="template-summary-row">
            <span :class="jobTypeBadge(linkedTemplate.jobType)">{{ t(`logs.jobType.${linkedTemplate.jobType}`) }}</span>
            <span class="template-summary-detail">{{ linkedTemplate.jobType === 'embywatch' ? linkedTemplate.botUsername : '@' + linkedTemplate.botUsername }}</span>
          </div>
        </div>

        <!-- Proxy override: this job's own exit, or the template's when left blank -->
        <ProxyPicker
          v-if="form.templateId && proxiesList.length"
          v-model="jobProxyId"
          :pool="jobProxyPool"
          :proxies="proxiesList"
          :label="t('jobs.labelProxy')"
          :blank-label="t('jobs.proxyFollowTemplate') + (templateProxyName ? ` (${templateProxyName})` : '')"
          :hint="proxyHint"
        />

        <!-- Name + Type (no template) | Name + Account (template, checkin/custom) -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelName') }} <span style="color:var(--danger)">*</span></label>
            <div class="name-with-icon">
              <JobIconPicker v-model="form.icon" />
              <input v-model.trim="form.name" class="form-input" placeholder="Xxemby" />
            </div>
          </div>
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.labelType') }}</label>
            <select v-model="form.jobType" class="form-select" @change="onJobTypeChange">
              <option value="checkin">Check-in (签到)</option>
              <option value="embywatch">Emby Watch (观看)</option>
              <option value="custom">Custom (自定义)</option>
              <option value="autoreg">Auto Registration (抢注)</option>
            </select>
          </div>
          <div v-if="form.templateId && (form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg')" class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:var(--danger)">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
            </select>
          </div>
        </div>

        <!-- Check-in: Account + Bot (no template only — when template, account is in the row above) -->
        <div v-if="form.jobType === 'checkin' && !form.templateId" class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:var(--danger)">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:var(--danger)">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>
        </div>

        <!-- Emby Watch: Server URL (hidden when template controls it) -->
        <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-group">
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

        <!-- Emby credentials (always job-specific, shown even for template-linked jobs) -->
        <template v-if="form.jobType === 'embywatch'">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyUser') }} <span style="color:var(--danger)">*</span></label>
              <input v-model.trim="embyCfg.username" class="form-input" placeholder="Username" autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyPass') }} <span style="color:var(--danger)">*</span></label>
              <input v-model="embyCfg.password" class="form-input" type="password" placeholder="Password" autocomplete="new-password" />
            </div>
          </div>
        </template>

        <!-- embywatch-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'embywatch' && !form.templateId">
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
          <!-- No account carries an Emby job, so its exit is set here rather than inherited -->
          <div v-if="proxiesList.length" style="margin-bottom:14px">
            <ProxyPicker
              v-model="jobProxyId"
              :pool="jobProxyPool"
              :proxies="proxiesList"
              :label="t('jobs.labelProxy')"
              :blank-label="t('jobs.proxyNone')"
              :hint="proxyHint"
            />
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
        </template>
        <!-- embywatch optional account (always shown, job-specific) -->
        <div v-if="form.jobType === 'embywatch' && accounts.length > 0" class="form-group" style="margin-top:8px">
          <label class="form-label">
            {{ t('jobs.labelAccount') }}
            <span style="color:var(--text-faint);font-weight:400"> — {{ t('jobs.accountOptionalHint') }}</span>
          </label>
          <select v-model="form.accountId" class="form-select">
            <option :value="null">{{ t('jobs.noAccount') }}</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
          </select>
        </div>

        <!-- Custom: Account + Bot (no template — when template, account is in the Name row above) -->
        <template v-if="form.jobType === 'custom'">
          <div v-if="!form.templateId" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:var(--danger)">*</span></label>
              <select v-model="form.accountId" class="form-select">
                <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.labelTarget') }}</label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="BotUsername" />
            </div>
          </div>

          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelJobMaxRetries') }}</label>
            <input v-model.number="customJobMaxRetries" class="form-input" type="number" min="1" max="20" style="max-width:120px" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
          </div>

          <!-- Action chain builder (hidden when template controls it) -->
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.actions') }}</label>

            <ActionChainEditor
              :actions="customActions"
              :ai-key-missing="aiKeyMissing"
              :cf-browser-missing="cfBrowserMissing"
              :proxies="proxiesList"
              :profile-id-placeholder="profileIdPlaceholder"
            />
          </div>
        </template>

        <!-- Auto registration (hidden when template controls it) -->
        <template v-if="form.jobType === 'autoreg' && !form.templateId">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:var(--danger)">*</span></label>
              <select v-model="form.accountId" class="form-select">
                <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ formatAccountLabel(a) }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.autoreg.labelBot') }} <span style="color:var(--danger)">*</span></label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
            </div>
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
              <label class="form-label">{{ durationLabel(t('jobs.labelReplyTimeout')) }}</label>
              <NumberInput v-model="form.replyTimeoutMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
            </div>
          </div>
        </template>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowStart') }}</label>
            <input v-model.number="form.scheduleWindowStart" class="form-input" type="number" placeholder="1400" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowEnd') }}</label>
            <input v-model.number="form.scheduleWindowEnd" class="form-input" type="number" placeholder="1600" />
          </div>
        </div>

        <!-- Cadence is job-wide, whatever the job does; a linked job follows its template's -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
            <input
              v-model.trim="runEveryDaysText"
              class="form-input"
              type="text"
              :placeholder="t('jobs.runEveryDaysPlaceholder')"
              style="max-width:120px"
              :disabled="!!form.templateId"
            />
            <div style="font-size:11px;margin-top:4px" :style="runEveryDaysValid ? 'color:var(--text-faint)' : 'color:var(--danger-soft-text)'">{{ t('jobs.runEveryDaysHint') }}</div>
          </div>
          <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
            <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
          </div>
        </div>

        <!-- checkin-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'checkin' && !form.templateId">
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
              <label class="form-label">{{ durationLabel(t('jobs.labelReplyTimeout')) }}</label>
              <NumberInput v-model="form.replyTimeoutMs" class="form-input" :min="0" :step="1000" :scale="msScale" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" :disabled="!!form.templateId" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="checkinSuccessContains" class="form-input" :placeholder="t('jobs.successContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="checkinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
          </div>
        </template>

        <!-- Last in the body, on the right: it applies to every job type, and a linked
             job follows its template -->
        <div class="one-time-row">
          <label class="form-check">
            <input v-model="form.oneTime" type="checkbox" :disabled="!!form.templateId" />
            <span>{{ t('jobs.labelOneTime') }}</span>
          </label>
          <div class="one-time-hint">{{ form.templateId ? t('jobs.oneTimeTemplateHint') : t('jobs.oneTimeHint') }}</div>
        </div>

        </div><!-- end modal-body -->
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button v-if="editTarget && !editTarget.templateId" class="btn btn-ghost" @click="openExtract(editTarget)">
            <i class="fa-solid fa-file-export"></i> {{ t('jobs.extractToTemplate') }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveJob">
            <i class="fa-solid fa-floppy-disk"></i> {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Extract to Template modal -->
    <div v-if="extractSource" class="modal-backdrop">
      <div class="modal" style="width:400px">
        <h3 class="modal-title">{{ t('jobs.extractModalTitle') }}</h3>
        <div class="modal-body">
          <div v-if="extractError" class="error-msg">{{ extractError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.extractTemplateName') }} <span style="color:var(--danger)">*</span></label>
            <input v-model.trim="extractName" class="form-input" :placeholder="extractSource.name" @keyup.enter="confirmExtract" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="extractSource = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="extractSaving" @click="confirmExtract">
            <i class="fa-solid fa-file-export"></i> {{ extractSaving ? t('common.saving') : t('jobs.extractConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Disable confirmation modal -->
    <div v-if="confirmDisableJob" class="modal-backdrop">
      <div class="modal" style="width:360px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmDisable') }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDisableJob = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeDisable"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk run modal -->
    <div v-if="showBulkRunModal" class="modal-backdrop">
      <div class="modal" :style="bulkRunTask ? 'width:520px' : 'width:380px'">
        <h3 class="modal-title">
          {{ t('jobs.bulkRunTitle') }}
          <span v-if="bulkRunTask?.label" class="modal-title-scope">{{ bulkRunTask.label }}</span>
        </h3>
        <p v-if="bulkRunConflict" class="bulk-run-conflict">
          <i class="fa-solid fa-triangle-exclamation"></i> {{ t('jobs.bulkRunConflict') }}
        </p>
        <!-- A conflict waits for the queue it named to arrive with the next poll, rather
             than offering the form again for a start that would be refused -->
        <template v-if="!bulkRunTask && !bulkRunConflict">
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.bulkRunDelayLabel') }}</label>
              <input v-model.number="bulkRunDelay" type="number" min="0" class="form-input" style="width:120px" @keyup.enter="startBulkRun" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.bulkRunMaxLabel') }}</label>
              <input v-model.number="bulkRunMaxSeconds" type="number" min="0" class="form-input" style="width:120px" @keyup.enter="startBulkRun" />
              <p class="form-hint">{{ t('jobs.bulkRunMaxHint') }}</p>
            </div>
            <p class="form-hint">{{ t('bulkTasks.serverNote') }}</p>
            <p class="form-hint">{{ t('jobs.bulkRunHint') }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkRun"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
            <button class="btn btn-success" @click="startBulkRun"><i class="fa-solid fa-play"></i> {{ t('jobs.bulkRunStart') }}</button>
          </div>
        </template>
        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress v-else-if="bulkRunTask" :task="bulkRunTask" @close="closeBulkRun" />
        <div v-else class="modal-footer">
          <button class="btn btn-primary" @click="closeBulkRun"><i class="fa-solid fa-check"></i> {{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk change window modal -->
    <div v-if="showBulkWindowModal" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('jobs.bulkWindowTitle') }}</h3>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelWindowStart') }}</label>
              <input v-model.number="bulkWindowStart" type="number" class="form-input" placeholder="1400" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelWindowEnd') }}</label>
              <input v-model.number="bulkWindowEnd" type="number" class="form-input" placeholder="1600" />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showBulkWindowModal = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="executeBulkChangeWindow"><i class="fa-solid fa-clock"></i> {{ t('jobs.bulkWindowApply') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk disable confirmation -->
    <div v-if="confirmBulkDisableJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkDisable').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDisableJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDisableJobs"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk retire confirmation -->
    <div v-if="confirmBulkRetireJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.retire') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkRetire').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkRetireJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkRetireJobs"><i class="fa-solid fa-box-archive"></i> {{ t('common.retire') }}</button>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuJob" class="action-sheet-backdrop" @click="actionMenuJob = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuJob.name }}</div>
        <button v-if="actionMenuJob.jobType === 'custom'" class="action-sheet-btn" @click="openManualBrowser(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-desktop"></i> {{ t('manualBrowser.open') }}
        </button>
        <button class="action-sheet-btn" :disabled="running.has(actionMenuJob.id)" @click="runNow(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-play"></i> {{ t('common.run') }}
        </button>
        <button class="action-sheet-btn" @click="openEdit(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-pen"></i> {{ t('common.edit') }}
        </button>
        <button
          v-if="templateEditButton && actionMenuJob.templateId"
          class="action-sheet-btn"
          @click="openTemplateEdit(actionMenuJob); actionMenuJob = null"
        >
          <i class="fa-solid fa-file-pen"></i> {{ t('jobs.editTemplateBtn') }}
        </button>
        <button class="action-sheet-btn" @click="openDuplicate(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-copy"></i> {{ t('common.duplicate') }}
        </button>
        <button class="action-sheet-btn" @click="toggleEnabled(actionMenuJob); actionMenuJob = null">
          <i :class="actionMenuJob.enabled ? 'fa-solid fa-ban' : 'fa-solid fa-circle-check'"></i>
          {{ actionMenuJob.enabled ? t('common.disable') : t('common.enable') }}
        </button>
        <button class="action-sheet-btn danger" @click="retire(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-box-archive"></i> {{ t('common.retire') }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuJob = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
    <!-- Bulk run error toast -->
    <div v-if="bulkRunToast" class="job-toast">{{ bulkRunToast }}</div>
  </div>
  <TemplateFormModal
    v-if="templateEditTarget"
    :template="templateEditTarget"
    @close="templateEditTarget = null"
    @saved="onTemplateSaved"
  />
  <ManualBrowser
    v-if="manualBrowserJobId || manualBrowserRunId"
    :job-id="manualBrowserJobId ?? undefined"
    :run-id="manualBrowserRunId ?? undefined"
    @closed="manualBrowserJobId = null; manualBrowserRunId = null"
  />
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { jobsApi, accountsApi, bulkTasksApi, manualBrowserApi, settingsApi, logsApi, templatesApi, type Job, type JobFacets, type JobTemplate, type Account, type Settings, type UAPreset, type EmbywatchConfig, type CustomConfig, type AutoregConfig, type CheckinConfig, type Proxy, type JobProxy } from '../api/client';
import { t, locale } from '../i18n';
import { regexValid } from '../utils/regexCheck';
import { usePersistedRef } from '../composables/usePersistedRef';
import { useAvailableFilter } from '../composables/useAvailableFilter';
import { formatAccountLabel, loadAccountDisplaySetting } from '../composables/accountDisplay';
import { loadSchedulePageSetting, scheduleSeparatePage } from '../composables/schedulePage';
import { loadTemplateEditButtonSetting, templateEditButton } from '../composables/templateEditButton';
import { takeJobEditId } from '../composables/viewNav';
import { jobProxyColumn, loadJobProxyColumnSetting } from '../composables/jobProxyColumn';
import { msScale, durationLabel, loadPreferSecondsSetting } from '../composables/preferSeconds';
import NumberInput from '../components/NumberInput.vue';
import TemplateFormModal from '../components/TemplateFormModal.vue';
import ScheduleList from '../components/ScheduleList.vue';
import { debounce } from '../composables/useDebounce';
import PaginationBar from '../components/PaginationBar.vue';
import ActionChainEditor from '../components/ActionChainEditor.vue';
import {
  actionsFromConfig,
  actionsToConfig,
  type CustomActionForm,
} from '../composables/customActions';
import { proxyFields } from '../composables/proxyPick';
import ProxyPicker from '../components/ProxyPicker.vue';
import JobIconPicker from '../components/JobIconPicker.vue';
import JobIcon from '../components/JobIcon.vue';
import { loadJobIcons } from '../composables/jobIcons';
import ManualBrowser from '../components/ManualBrowser.vue';
import {
  onBulkTaskFinished,
  pokeBulkTasks,
  runningTaskWithRef,
  startBulkTaskPolling,
  taskById,
  trackStartedTask,
} from '../composables/bulkTasks';
import BulkTaskProgress from '../components/BulkTaskProgress.vue';

const jobs = ref<Job[]>([]);
const accounts = ref<Account[]>([]);
const templates = ref<JobTemplate[]>([]);
/** Template opened from a job row; null keeps the template editor closed. */
const templateEditTarget = ref<JobTemplate | null>(null);
const settings = ref<Settings | null>(null);
const uaPresets = computed<UAPreset[]>(() => {
  try { return JSON.parse(settings.value?.ua_presets ?? '[]'); } catch { return []; }
});
const proxiesList = computed<Proxy[]>(() => {
  try { return JSON.parse(settings.value?.proxies ?? '[]'); } catch { return []; }
});
const running = ref(new Set<number>());

const page = ref(1);
const total = ref(0);
const pageSize = usePersistedRef<number>('bemby:jobs:pageSize', 25);
const facets = ref<JobFacets>({ botUsernames: [], templates: [] });

const filterType = usePersistedRef<string>('bemby:jobs:filterType', '');
const filterAccountId = usePersistedRef<number | ''>('bemby:jobs:filterAccountId', '');
const filterBotUrlTpl = usePersistedRef<string>('bemby:jobs:filterBotUrlTpl', '');
const filterName = usePersistedRef<string>('bemby:jobs:filterName', '');
const filterOptions = computed(() => [
  { value: '', label: t('common.all') },
  { value: 'checkin', label: t('logs.jobType.checkin') },
  { value: 'embywatch', label: t('logs.jobType.embywatch') },
  { value: 'custom', label: t('logs.jobType.custom') },
  { value: 'autoreg', label: t('logs.jobType.autoreg') },
]);
// Options come from server facets so the dropdown covers the whole dataset, not just the loaded page
const botUrlTplOptions = computed(() => {
  const botVals = facets.value.botUsernames.map(v => ({ value: `bot:${v}`, label: v }));
  const tplVals = facets.value.templates.map(t => ({ value: `tpl:${t.id}`, label: `[T] ${t.name}` }));
  return [...botVals, ...tplVals];
});
// What each dropdown actually offers: nothing to choose between means no dropdown, and the
// guards below drop a filter the moment it leaves this list -- deleting the last job of a
// template would otherwise leave the filter set to it and every other job hidden.
const accountFilterOptions = computed(() => (accounts.value.length > 1 ? accounts.value : []));
const botUrlTplFilterOptions = computed(() =>
  botUrlTplOptions.value.length > 1 ? botUrlTplOptions.value : [],
);
useAvailableFilter(filterAccountId, () => accountFilterOptions.value.map(a => a.id), '');
useAvailableFilter(filterBotUrlTpl, () => botUrlTplFilterOptions.value.map(o => o.value), '');

const showLastSuccess = usePersistedRef<boolean>('bemby:jobs:showLastSuccess', false);
const sortKey = usePersistedRef<string>('bemby:jobs:sortKey', '');
const sortDir = usePersistedRef<'asc' | 'desc'>('bemby:jobs:sortDir', 'asc');
const actionMenuJob = ref<Job | null>(null);
const confirmDisableJob = ref<Job | null>(null);
const selectedJobIds = ref<number[]>([]);
const allJobsSelected = computed(() => jobs.value.length > 0 && jobs.value.every(j => selectedJobIds.value.includes(j.id)));
const confirmBulkDisableJobs = ref(false);
const confirmBulkRetireJobs = ref(false);
const showBulkRunModal = ref(false);
const bulkRunDelay = ref(70);
// Ceiling on one run, so a job stuck on a dead proxy or an unreachable site does not hold
// the queue; 0 waits indefinitely
const bulkRunMaxSeconds = ref(1800);
const bulkRunTaskId = ref<string | null>(null);
const bulkRunTask = computed(() => taskById(bulkRunTaskId.value));
/** Set when the server refused the selection because its templates are already queued. */
const bulkRunConflict = ref('');
const showBulkWindowModal = ref(false);
const bulkWindowStart = ref(1400);
const bulkWindowEnd = ref(1600);

function setSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
  page.value = 1;
  loadJobs();
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

// Filtering and sorting happen server-side; filter changes restart from page 1
watch([filterType, filterAccountId, filterBotUrlTpl], () => {
  page.value = 1;
  loadJobs();
});
const debouncedNameFilter = debounce(() => {
  page.value = 1;
  loadJobs();
}, 300);
watch(filterName, () => debouncedNameFilter());

function onPageChange(p: number) {
  if (p === page.value) return;
  page.value = p;
  loadJobs();
}

function onPageSizeChange(size: number) {
  pageSize.value = size;
  page.value = 1;
  loadJobs();
}

function jobTypeBadge(type: string) {
  const map: Record<string, string> = {
    checkin: 'badge badge-blue',
    embywatch: 'badge badge-purple',
    custom: 'badge badge-amber',
    autoreg: 'badge badge-red',
  };
  return map[type] ?? 'badge badge-grey';
}
const pollTimers = new Map<number, ReturnType<typeof setTimeout>>();

const showForm = ref(false);
const editTarget = ref<Job | null>(null);
const customActions = ref<CustomActionForm[]>([]);
const customJobMaxRetries = ref(1);

const form = reactive({
  name: '',
  accountId: null as number | null,
  jobType: 'checkin' as 'checkin' | 'embywatch' | 'custom' | 'autoreg',
  botUsername: '',
  scheduleWindowStart: 1000,
  scheduleWindowEnd: 2200,
  // Empty means follow the default_timezone setting
  timezone: '',
  replyTimeoutMs: 40000,
  retryMax: 5,
  enabled: true,
  templateId: null as number | null,
  runEveryDays: 1,
  runEveryDaysMax: null as number | null,
  oneTime: false,
  icon: null as string | null,
});

const linkedTemplate = computed(() => templates.value.find(t => t.id === form.templateId) ?? null);

// Proxy override for a template-linked job: blank follows the template's own choice
const jobProxyId = ref('');
// Ids a 'random' override draws from; empty draws from the whole list
const jobProxyPool = ref<string[]>([]);

/** The proxy a job or template config picked: '' and an empty pool when it picked none. */
function readConfigProxy(raw: string | null | undefined): { proxyId: string; pool: string[] } {
  const none = { proxyId: '', pool: [] };
  if (!raw) return none;
  try {
    let c = JSON.parse(raw) as { proxyId?: string; proxyPool?: string[] } | string;
    if (typeof c === 'string') c = JSON.parse(c) as { proxyId?: string; proxyPool?: string[] };
    return {
      proxyId: typeof c?.proxyId === 'string' ? c.proxyId : '',
      pool: Array.isArray(c?.proxyPool) ? [...c.proxyPool] : [],
    };
  } catch { return none; }
}

// Named in the "follow template" option so the inherited exit is visible without
// opening the template
const templateProxyName = computed(() => {
  const id = readConfigProxy(linkedTemplate.value?.config).proxyId;
  if (!id) return '';
  if (id === 'random') return t('jobs.proxyRandom');
  return proxiesList.value.find(p => p.id === id)?.name ?? id;
});

// Which exit a job leaves by is either its own or inherited, and only these two forms offer
// the pick: a template-linked job overriding its template, and an Emby job, which has no
// account to inherit one from.
const proxyPickable = computed(() => !!form.templateId || form.jobType === 'embywatch');

// Emby traffic goes out through the pick itself; for everything else it is the browser that
// does, with Telegram staying on the account's exit.
const proxyHint = computed(() =>
  form.jobType === 'embywatch' ? t('jobs.proxyEmbyHint') : t('jobs.proxyBrowserOnlyHint'),
);

/** Config fragment carrying this job's proxy pick, empty when it has none to make. */
function proxyOverride(): { proxyId?: string; proxyPool?: string[] } {
  return proxyPickable.value ? proxyFields(jobProxyId.value, jobProxyPool.value) : {};
}

// "Run every days" accepts a single number (7) or a range (7-15). The range is
// stored as runEveryDays (min) + runEveryDaysMax; the scheduler picks a random
// value in the range each cycle.
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

const extractSource = ref<Job | null>(null);
const extractName = ref('');
const extractError = ref('');
const extractSaving = ref(false);
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
const embyUaDropdown = ref('');
const embyServer = reactive<{ protocol: 'https' | 'http'; host: string; port: number | '' }>({
  protocol: 'https',
  host: '',
  port: 443,
});
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
/**
 * The database ids a browser profile name is built from, shown beside the panel title: with
 * `{ip}-{jobId}` in the profile field, this is what the run's profile will be called. The
 * template and account are read off the form rather than off the saved job, so changing
 * either here says at once which profile the job moves to.
 */
const profileVarIds = computed(() => {
  const parts: string[] = [];
  if (editTarget.value) parts.push(`{jobId} ${editTarget.value.id}`);
  if (form.templateId) parts.push(`{templateId} ${form.templateId}`);
  if (form.accountId) parts.push(`{tgId} ${form.accountId}`);
  return parts.join(' · ');
});

const formError = ref('');
const saving = ref(false);
const aiKeyMissing = computed(() => settings.value?.ai_key_configured !== 'true');
// A blank profile name falls back to the one configured in Settings, so show which
const profileIdPlaceholder = computed(() => settings.value?.cf_profile_id?.trim() || '{ip}');
// Anything that opens a page needs the solver's browser and its fonts in the data dir;
// neither ships in the image, so those options stay off until both are downloaded.
// Only ever true once the settings have actually arrived. Null means they have not (the
// load is fire-and-forget and swallows its errors), and reading that as "no browser" greys
// the actions out with a label saying something untrue about the machine.
const cfBrowserMissing = computed(
  () =>
    !!settings.value &&
    (settings.value.cf_chromium_installed !== 'true' ||
      settings.value.cf_fonts_installed !== 'true'),
);

const CMD_PRESETS = new Set(['', '/start', '/checkin'])
const BTN_PRESETS = new Set(['', '签到', '{aiBtn}', '{anyBtn}'])
const cmdDropdown = ref('')
const cmdCustom = ref('')
const btnDropdown = ref('')
const btnCustom = ref('')
const btnAiHint = ref('')
const checkinSuccessContains = ref('')
const checkinFailContains = ref('')

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
  if (embyUaDropdown.value === '' ) { embyCfg.userAgent = ''; return; }
  if (embyUaDropdown.value === '__custom__') return;
  const preset = uaPresets.value.find(p => p.name === embyUaDropdown.value);
  if (preset) embyCfg.userAgent = preset.value;
}

function onJobTypeChange() {
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  form.accountId = (form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg')
    ? (accounts.value[0]?.id ?? null)
    : null;
  form.runEveryDays = 1;
  form.runEveryDaysMax = null;
  runEveryDaysText.value = '1';
  customActions.value = [];
  Object.assign(autoregCfg, defaultAutoregCfg());
  customJobMaxRetries.value = 1;
  btnAiHint.value = '';
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  jobProxyId.value = '';
  jobProxyPool.value = [];
  setCmdState(''); setBtnState('');
}


onMounted(async () => {
  loadAccountDisplaySetting();
  loadSchedulePageSetting();
  loadTemplateEditButtonSetting();
  loadJobProxyColumnSetting();
  loadPreferSecondsSetting();
  // Custom icons are shared across every list that draws a job, and fetched once
  void loadJobIcons();
  await Promise.all([loadJobs(), loadAccounts(), loadStatus(), loadSettings(), loadTemplates()]);
  pollLiveRuns();
  await openRequestedJobEdit();
});

// The logs page can send us here to edit one job. That job need not be on the page the list
// happens to be showing, so it is looked up in the full list when the page misses it.
async function openRequestedJobEdit() {
  const asked = takeJobEditId();
  if (asked == null) return;
  const job = jobs.value.find(j => j.id === asked) ?? (await jobsApi.list().catch(() => [])).find(j => j.id === asked);
  if (job) openEdit(job);
}

// ── Effective proxy column ────────────────────────────────────────────────────
// The server works the exit out from the job, its template and its account, and names it in
// whichever way identifies it: a pinned exit by name, a whole-supplier pool by the supplier.
// A draw over anything else is counted rather than listed, since the exit is only settled
// when the run starts.

function proxyText(p?: JobProxy): string {
  if (!p) return t('jobs.proxy.direct');
  if (p.kind === 'direct') return t('jobs.proxy.direct');
  // Nothing was picked here; the global exit is what stands in for a direct connection
  if (p.kind === 'global') return p.label;
  if (p.kind === 'proxy') return p.label;
  const size = p.poolSize ? ` (${p.poolSize})` : '';
  return (p.kind === 'provider' ? p.label : t('jobs.proxy.random')) + size;
}

function proxyIcon(p?: JobProxy): string {
  // A pick whose exit has been deleted is not a working pick, whatever its kind
  if (p?.missing || p?.tgMissing) return 'fa-triangle-exclamation';
  switch (p?.kind) {
    case 'proxy':
      return 'fa-plug';
    case 'global':
      return 'fa-globe';
    case 'provider':
    case 'random':
      return 'fa-shuffle';
    default:
      return 'fa-arrow-right';
  }
}

/** Why this is the effective exit, and the Telegram side when the job overrides the account. */
function proxyTitle(p?: JobProxy): string {
  if (!p) return '';
  const lines = [t(`jobs.proxy.source.${p.source}`)];
  if (p.kind === 'global') lines.push(t('jobs.proxy.globalNote'));
  if (p.kind === 'provider' || p.kind === 'random') lines.push(t('jobs.proxy.drawnPerRun'));
  if (p.tgLabel !== undefined) {
    lines.push(
      t('jobs.proxy.tgNote').replace('{exit}', p.tgLabel || t('jobs.proxy.direct')),
    );
  }
  if (p.missing || p.tgMissing) lines.push(t('jobs.proxy.missing'));
  return lines.join('\n');
}

// Label for a job's account, honouring the "{Bemby name} - {TG name}" display setting.
function jobAccountLabel(j: Job): string {
  const acc = accounts.value.find((a) => a.id === j.accountId);
  const fallback = j.accountName ?? (j.accountId != null ? String(j.accountId) : "");
  return formatAccountLabel(acc, fallback);
}

async function loadSettings() {
  try { settings.value = await settingsApi.get(); } catch { /* ignore */ }
}

async function loadTemplates() {
  try { templates.value = await templatesApi.list(); } catch { /* ignore */ }
}

function openTemplateEdit(j: Job) {
  const tpl = templates.value.find(t => t.id === j.templateId);
  if (tpl) templateEditTarget.value = tpl;
}

/** A template edit changes what every linked job runs, so refresh both lists. */
async function onTemplateSaved() {
  await Promise.all([loadTemplates(), loadJobs()]);
}

function applyTemplate(tpl: JobTemplate) {
  form.jobType = tpl.jobType;
  form.botUsername = tpl.botUsername;
  form.timezone = tpl.timezone;
  form.replyTimeoutMs = tpl.replyTimeoutMs;
  form.retryMax = tpl.retryMax;
  form.runEveryDays = tpl.runEveryDays ?? 1;
  form.runEveryDaysMax = tpl.runEveryDaysMax ?? null;
  form.oneTime = tpl.oneTime ?? false;
  runEveryDaysText.value = formatRunEvery(tpl.runEveryDays ?? 1, tpl.runEveryDaysMax);
  setCmdState(tpl.startCommand === '/start' ? '' : (tpl.startCommand ?? ''));
  setBtnState(tpl.checkinButton === '签到' ? '' : (tpl.checkinButton ?? ''));
  if (tpl.jobType === 'embywatch') {
    const m = tpl.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, { protocol: (m?.[1] ?? 'https') as 'https' | 'http', host: m?.[2] ?? '', port: m?.[3] ? Number(m[3]) : 443 });
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as EmbywatchConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        // username/password are job-specific; only apply playback settings from template
        Object.assign(embyCfg, { playDuration: c.playDuration ?? '', userAgent: c.userAgent ?? '', markWatched: c.markWatched !== false, verifyPlayable: c.verifyPlayable !== false, realWatch: c.realWatch === true, sequencePlay: c.sequencePlay === true, library: c.library ?? '', ignoreSslErrors: c.ignoreSslErrors === true });
        setUaState(c.userAgent ?? '');
      } catch { /* ignore */ }
    }
  } else if (tpl.jobType === 'custom') {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as CustomConfig;
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = actionsFromConfig(cfg.actions);
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    }
  } else if (tpl.jobType === 'autoreg') {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as AutoregConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig;
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
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    customActions.value = [];
  }
}

function onTemplateChange() {
  const tpl = linkedTemplate.value;
  jobProxyId.value = '';
  jobProxyPool.value = [];
  if (!tpl) return;
  applyTemplate(tpl);
  // accountId is job-specific — never reset it when a template is assigned
}

async function loadJobs() {
  const params: Parameters<typeof jobsApi.listPaged>[0] = {
    page: page.value,
    pageSize: pageSize.value,
    search: filterName.value.trim() || undefined,
    sortKey: sortKey.value || undefined,
    sortDir: sortKey.value ? sortDir.value : undefined,
    jobType: filterType.value || undefined,
    accountId: filterAccountId.value,
  };
  if (filterBotUrlTpl.value.startsWith('bot:')) params.botUsername = filterBotUrlTpl.value.slice(4);
  else if (filterBotUrlTpl.value.startsWith('tpl:')) params.templateId = Number(filterBotUrlTpl.value.slice(4));
  const res = await jobsApi.listPaged(params);
  // Step back when deletions leave the current page empty
  if (!res.items.length && page.value > 1) {
    page.value -= 1;
    return loadJobs();
  }
  jobs.value = res.items;
  total.value = res.total;
  facets.value = res.facets;
  selectedJobIds.value = selectedJobIds.value.filter(id => res.items.some(j => j.id === id));
}

async function loadAccounts() {
  accounts.value = await accountsApi.list();
}

const scheduleListRef = ref<{ reload: () => Promise<void> } | null>(null);

// The panel owns its own data; job changes here just ask it to look again
async function loadStatus() {
  await scheduleListRef.value?.reload();
  // Which runs have a screen up, so the list can offer to watch one
  await refreshLiveRuns();
}

function fmtWindow(start: number, end: number) {
  const fmt = (n: number) => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

// Absolute timestamp including the year, for the last-success tooltip where the
// relative label alone can be years old.
function fmtDateTimeFull(iso: string) {
  const localeMap: Record<string, string> = { en: 'en-AU', zh: 'zh-CN' };
  return new Date(iso).toLocaleString(localeMap[locale.value] ?? 'en-AU', {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Elapsed time as at most two units: "3 days ago", "2 weeks 3 days ago",
// "1 month 5 days ago". Months and years are calendar-aware, not 30/365-day
// approximations, so "1 month ago" lands on the same day of the month.
function fmtSince(iso: string) {
  const then = new Date(iso);
  const now = new Date();
  const secs = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 60) return t('jobs.since.justNow');

  const unit = (n: number, key: string) =>
    t(`jobs.since.${key}${n === 1 ? '' : 's'}`).replace('{n}', String(n));
  const ago = (...parts: string[]) => t('jobs.since.ago').replace('{v}', parts.join(' '));

  const mins = Math.floor(secs / 60);
  if (mins < 60) return ago(unit(mins, 'minute'));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return ago(unit(hours, 'hour'));
  const days = Math.floor(hours / 24);
  if (days < 7) return ago(unit(days, 'day'));

  // Calendar months elapsed, clamped so the anchor never overshoots now
  let months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();
  const anchor = new Date(then);
  anchor.setMonth(anchor.getMonth() + months);
  if (anchor.getTime() > now.getTime()) {
    months -= 1;
    anchor.setMonth(anchor.getMonth() - 1);
  }

  if (months < 1) {
    const weeks = Math.floor(days / 7);
    const remDays = days % 7;
    return remDays ? ago(unit(weeks, 'week'), unit(remDays, 'day')) : ago(unit(weeks, 'week'));
  }

  const remDays = Math.floor((now.getTime() - anchor.getTime()) / 86_400_000);
  if (months < 12) {
    return remDays ? ago(unit(months, 'month'), unit(remDays, 'day')) : ago(unit(months, 'month'));
  }
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths ? ago(unit(years, 'year'), unit(remMonths, 'month')) : ago(unit(years, 'year'));
}

function openAdd() {
  // Re-read on the way in: the browser and its fonts are installed from the settings page,
  // and the copy taken when this view mounted would still say they are not there
  void loadSettings();
  editTarget.value = null;
  Object.assign(form, {
    name: '', accountId: accounts.value[0]?.id ?? null,
    jobType: 'checkin', botUsername: '',
    scheduleWindowStart: 1000, scheduleWindowEnd: 2200,
    timezone: '',
    replyTimeoutMs: 40000,
    retryMax: Number(settings.value?.default_max_retry ?? 5),
    enabled: true,
    templateId: null,
    runEveryDays: 1,
    runEveryDaysMax: null,
    oneTime: false,
    icon: null,
  });
  runEveryDaysText.value = '1';
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  customActions.value = [];
  Object.assign(autoregCfg, defaultAutoregCfg());
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  jobProxyId.value = '';
  jobProxyPool.value = [];
  setCmdState(''); setBtnState('');
  formError.value = '';
  showForm.value = true;
}

function openEdit(j: Job) {
  void loadSettings();
  editTarget.value = j;
  const jobProxy = j.templateId || j.jobType === 'embywatch'
    ? readConfigProxy(j.config)
    : { proxyId: '', pool: [] };
  jobProxyId.value = jobProxy.proxyId;
  jobProxyPool.value = jobProxy.pool;
  Object.assign(form, {
    name: j.name, accountId: j.accountId, jobType: j.jobType,
    botUsername: j.botUsername, scheduleWindowStart: j.scheduleWindowStart,
    scheduleWindowEnd: j.scheduleWindowEnd, timezone: j.timezone,
    replyTimeoutMs: j.replyTimeoutMs, retryMax: j.retryMax, enabled: j.enabled,
    templateId: j.templateId ?? null,
    runEveryDays: j.runEveryDays ?? 1,
    runEveryDaysMax: j.runEveryDaysMax ?? null,
    oneTime: j.oneTime ?? false,
    icon: j.icon ?? null,
  });
  runEveryDaysText.value = formatRunEvery(j.runEveryDays ?? 1, j.runEveryDaysMax);
  setCmdState(j.startCommand === '/start' ? '' : (j.startCommand ?? ''));
  setBtnState(j.checkinButton === '签到' ? '' : (j.checkinButton ?? ''));
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  if (j.jobType === 'checkin' && j.config) {
    try {
      let cfg = JSON.parse(j.config);
      if (typeof cfg === 'string') cfg = JSON.parse(cfg);
      checkinSuccessContains.value = cfg.successContains ?? '';
      checkinFailContains.value = cfg.failContains ?? '';
    } catch { /* ignore */ }
  }
  if (j.jobType === 'embywatch') {
    // Parse stored URL back into protocol / host / port fields
    const m = j.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, {
      protocol: (m?.[1] ?? 'https') as 'https' | 'http',
      host: m?.[2] ?? j.botUsername,
      port: m?.[3] ? Number(m[3]) : 443,
    });
    if (j.config) {
      try {
        let c = JSON.parse(j.config) as EmbywatchConfig | string;
        // Migrate legacy double-encoded records
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        Object.assign(embyCfg, {
          username: c.username ?? '',
          password: c.password ?? '',
          playDuration: c.playDuration ?? '',
          userAgent: c.userAgent ?? '',
          markWatched: c.markWatched !== false,
          verifyPlayable: c.verifyPlayable !== false,
          realWatch: c.realWatch === true,
          sequencePlay: c.sequencePlay === true,
          ignoreSslErrors: c.ignoreSslErrors === true,
          library: c.library ?? '',
        });
        setUaState(c.userAgent ?? '');
      } catch {
        Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
        embyUaDropdown.value = '';
      }
    } else {
      Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
      embyUaDropdown.value = '';
    }
  } else if (j.jobType === 'custom') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (j.config) {
      try {
        const cfg = JSON.parse(j.config) as CustomConfig;
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = actionsFromConfig(cfg.actions);
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    } else {
      customActions.value = [];
      customJobMaxRetries.value = 1;
    }
  } else if (j.jobType === 'autoreg') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
    Object.assign(autoregCfg, defaultAutoregCfg());
    if (j.config) {
      try {
        let c = JSON.parse(j.config) as AutoregConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as AutoregConfig;
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
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true, verifyPlayable: true, realWatch: false, sequencePlay: false, library: '', ignoreSslErrors: false });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
  }
  formError.value = '';
  showForm.value = true;
}

function openDuplicate(j: Job) {
  openEdit(j);
  editTarget.value = null;
  form.name = `${j.name} (copy)`;
}

function handleEmbyHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim();
  if (!text) return;
  // Match optional protocol, host, optional port, optional path
  const match = text.match(/^(?:(https?):\/\/)?([^:/\s]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return;
  const [, proto, host, portStr] = match;
  // Plain hostname with no protocol or port — nothing to split, paste normally
  if (!proto && !portStr) return;
  event.preventDefault();
  if (proto === 'https' || proto === 'http') embyServer.protocol = proto as 'https' | 'http';
  embyServer.host = host;
  if (portStr) embyServer.port = Number(portStr);
}

function buildConfig(): EmbywatchConfig | CustomConfig | AutoregConfig | CheckinConfig | { proxyId?: string; proxyPool?: string[] } | null {
  if (form.jobType === 'autoreg') {
    // Template-linked jobs take their whole config from the template, bar a proxy override
    if (form.templateId) {
      const override = proxyOverride();
      return override.proxyId ? override : null;
    }
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
    return cfg;
  }
  if (form.jobType === 'embywatch') {
    if (form.templateId) {
      // Template provides all settings; job only stores credentials and any proxy override
      return { username: embyCfg.username, password: embyCfg.password, ...proxyOverride() } as EmbywatchConfig;
    }
    const cfg: EmbywatchConfig = { username: embyCfg.username, password: embyCfg.password, ...proxyOverride() };
    if (embyCfg.playDuration !== '') cfg.playDuration = Number(embyCfg.playDuration as string | number);
    if (embyCfg.userAgent) cfg.userAgent = embyCfg.userAgent;
    cfg.markWatched = embyCfg.markWatched;
    cfg.verifyPlayable = embyCfg.verifyPlayable;
    cfg.realWatch = embyCfg.realWatch;
    cfg.sequencePlay = embyCfg.sequencePlay;
    cfg.ignoreSslErrors = embyCfg.ignoreSslErrors;
    if (embyCfg.library) cfg.library = embyCfg.library;
    return cfg;
  }
  if (form.jobType === 'custom') {
    const cfg: CustomConfig = {
      actions: actionsToConfig(customActions.value),
    };
    if (customJobMaxRetries.value > 1) cfg.maxRetries = customJobMaxRetries.value;
    Object.assign(cfg, proxyOverride());
    return cfg;
  }
  if (form.jobType === 'checkin') {
    const s = checkinSuccessContains.value.trim();
    const f = checkinFailContains.value.trim();
    const cfg: CheckinConfig = {
      ...(s ? { successContains: s } : {}),
      ...(f ? { failContains: f } : {}),
      ...proxyOverride(),
    };
    if (Object.keys(cfg).length) return cfg;
  }
  return null;
}

async function saveJob() {
  formError.value = '';
  if (!form.name) { formError.value = t('jobs.errors.nameRequired'); return; }
  if ((form.jobType === 'checkin' || form.jobType === 'custom' || form.jobType === 'autoreg') && !form.accountId) { formError.value = t('jobs.errors.accountRequired'); return; }
  if (form.jobType === 'custom') {
    // No target bot needed: an action can name its own contact, or drive a page that
    // never touches Telegram. The ones that do need it say so when they run.
    if (customActions.value.length === 0) { formError.value = t('jobs.errors.customActionsRequired'); return; }
  }
  if (form.jobType === 'autoreg' && !form.templateId) {
    if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
    if (!autoregCfg.groupId) { formError.value = t('jobs.errors.autoregGroupRequired'); return; }
    if (!autoregCfg.codePrefix && !autoregCfg.codeRegex) { formError.value = t('jobs.errors.autoregPrefixRequired'); return; }
    if (autoregCfg.codeRegex && !regexValid(autoregCfg.codeRegex)) { formError.value = t('jobs.errors.autoregRegexInvalid'); return; }
    if (!autoregCfg.signupUsername) { formError.value = t('jobs.errors.autoregUsernameRequired'); return; }
  }
  if (form.jobType === 'embywatch') {
    if (!embyServer.host) { formError.value = t('jobs.errors.hostRequired'); return; }
    const portPart = (embyServer.port as number | string) !== '' ? `:${embyServer.port}` : '';
    // Strip any accidental protocol prefix the user may have typed into the host field
    form.botUsername = `${embyServer.protocol}://${embyServer.host.replace(/^https?:\/\//, '')}${portPart}`;
  }
  if (form.jobType !== 'custom' && !form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
  if (form.jobType === 'checkin' || form.jobType === 'autoreg') form.botUsername = form.botUsername.replace(/^@+/, '');
  if (form.jobType === 'embywatch' && (!embyCfg.username || !embyCfg.password)) {
    formError.value = t('jobs.errors.embyCredRequired');
    return;
  }
  saving.value = true;
  try {
    // Verify server reachability and credentials before saving the job
    if (form.jobType === 'embywatch') {
      let proxyId: string | undefined;
      let proxyPool: string[] | undefined;
      let userAgent: string | undefined = embyCfg.userAgent || undefined;
      let ignoreSslErrors = embyCfg.ignoreSslErrors;
      if (form.templateId && linkedTemplate.value?.config) {
        try {
          const c = JSON.parse(linkedTemplate.value.config) as { proxyId?: string; proxyPool?: string[]; userAgent?: string; ignoreSslErrors?: boolean };
          proxyId = c.proxyId;
          proxyPool = c.proxyPool;
          userAgent = c.userAgent || undefined;
          ignoreSslErrors = c.ignoreSslErrors === true;
        } catch { /* ignore bad template config */ }
      }
      // The job's own exit, when it overrides the template's. A random pick is drawn by the
      // test itself, so the test only proves the pool is reachable, not which exit a run takes
      const override = proxyOverride();
      if (override.proxyId) {
        proxyId = override.proxyId;
        proxyPool = override.proxyPool;
      }
      const test = await jobsApi.testEmby({
        serverUrl: form.botUsername,
        username: embyCfg.username,
        password: embyCfg.password,
        ...(userAgent ? { userAgent } : {}),
        ...(proxyId ? { proxyId } : {}),
        ...(proxyPool?.length ? { proxyPool } : {}),
        ...(ignoreSslErrors ? { ignoreSslErrors: true } : {}),
      });
      if (!test.ok) {
        formError.value = `${t('jobs.errors.embyVerifyFailed')}${test.error ? `: ${test.error}` : ''}`;
        return;
      }
    }
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
      templateId: form.templateId ?? null,
    };
    if (editTarget.value) {
      await jobsApi.update(editTarget.value.id, payload);
    } else {
      await jobsApi.create(payload);
    }
    showForm.value = false;
    await Promise.all([loadJobs(), loadStatus()]);
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    saving.value = false;
  }
}

function openExtract(j: Job) {
  extractSource.value = j;
  extractName.value = j.name;
  extractError.value = '';
}

async function confirmExtract() {
  const job = extractSource.value;
  if (!job) return;
  if (!extractName.value) { extractError.value = t('jobs.errors.nameRequired'); return; }
  extractSaving.value = true;
  extractError.value = '';
  try {
    const tpl = await templatesApi.create({
      name: extractName.value,
      jobType: job.jobType,
      botUsername: job.botUsername,
      timezone: job.timezone,
      replyTimeoutMs: job.replyTimeoutMs,
      retryMax: job.retryMax,
      config: job.config ? JSON.parse(job.config) as unknown as string | null : null,
      startCommand: job.startCommand,
      checkinButton: job.checkinButton,
    });
    await jobsApi.update(job.id, { templateId: tpl.id });
    extractSource.value = null;
    showForm.value = false;
    await Promise.all([loadJobs(), loadTemplates()]);
  } catch (err: any) {
    extractError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    extractSaving.value = false;
  }
}

async function toggleEnabled(j: Job) {
  if (j.enabled) {
    confirmDisableJob.value = j;
    return;
  }
  await jobsApi.update(j.id, { enabled: true });
  await Promise.all([loadJobs(), loadStatus()]);
}

async function executeDisable() {
  if (!confirmDisableJob.value) return;
  await jobsApi.update(confirmDisableJob.value.id, { enabled: false });
  await Promise.all([loadJobs(), loadStatus()]);
  confirmDisableJob.value = null;
}

async function retire(id: number) {
  if (!confirm(t('jobs.confirmRetire'))) return;
  await jobsApi.delete(id);
  selectedJobIds.value = selectedJobIds.value.filter(i => i !== id);
  await loadJobs();
}

function toggleAllJobs() {
  selectedJobIds.value = allJobsSelected.value ? [] : jobs.value.map(j => j.id);
}

// Index of the last row toggled without Shift; anchors Shift-click ranges.
let lastJobSelectedIdx: number | null = null;

function toggleJobSelect(id: number, idx: number, event?: MouseEvent) {
  // Shift-click selects the contiguous range between the anchor row and this
  // one; other clicks toggle a single row and reset the anchor.
  if (event?.shiftKey && lastJobSelectedIdx !== null) {
    // Shift-click would otherwise highlight the intervening table text.
    window.getSelection?.()?.removeAllRanges();
    const next = new Set(selectedJobIds.value);
    const [lo, hi] = [lastJobSelectedIdx, idx].sort((a, b) => a - b);
    for (let i = lo; i <= hi; i++) {
      const row = jobs.value[i];
      if (row) next.add(row.id);
    }
    selectedJobIds.value = [...next];
    return;
  }
  const arrIdx = selectedJobIds.value.indexOf(id);
  if (arrIdx === -1) selectedJobIds.value.push(id);
  else selectedJobIds.value.splice(arrIdx, 1);
  lastJobSelectedIdx = idx;
}

// The anchor indexes the current list, so clear it whenever the list is
// replaced (search, filter, reload) to avoid spanning stale rows.
watch(jobs, () => {
  lastJobSelectedIdx = null;
});

// One request each, whatever the selection: a request per job meant the scheduler was
// rebuilt once per job as well, which is what made a couple of hundred of them so slow.
async function bulkEnableJobs() {
  await jobsApi.bulkUpdate(selectedJobIds.value, { enabled: true });
  await Promise.all([loadJobs(), loadStatus()]);
  selectedJobIds.value = [];
}

async function executeBulkDisableJobs() {
  await jobsApi.bulkUpdate(selectedJobIds.value, { enabled: false });
  await Promise.all([loadJobs(), loadStatus()]);
  confirmBulkDisableJobs.value = false;
  selectedJobIds.value = [];
}

async function executeBulkRetireJobs() {
  await jobsApi.bulkRetire(selectedJobIds.value);
  await loadJobs();
  confirmBulkRetireJobs.value = false;
  selectedJobIds.value = [];
}

async function executeBulkChangeWindow() {
  await jobsApi.bulkUpdate(selectedJobIds.value, {
    scheduleWindowStart: bulkWindowStart.value,
    scheduleWindowEnd: bulkWindowEnd.value,
  });
  await Promise.all([loadJobs(), loadStatus()]);
  showBulkWindowModal.value = false;
  selectedJobIds.value = [];
}

function stopRunning(jobId: number) {
  running.value.delete(jobId);
  running.value = new Set(running.value);
  const timer = pollTimers.get(jobId);
  if (timer) { clearTimeout(timer); pollTimers.delete(jobId); }
}

function schedulePoll(jobId: number, logId: number) {
  const timer = setTimeout(async () => {
    try {
      const log = await logsApi.getOne(logId);
      if (log.status === 'running') {
        schedulePoll(jobId, logId);
      } else {
        stopRunning(jobId);
      }
    } catch {
      stopRunning(jobId);
    }
  }, 3000);
  pollTimers.set(jobId, timer);
}

const bulkRunToast = ref('');
let bulkRunToastTimer: ReturnType<typeof setTimeout> | null = null;

function showBulkRunToast(msg: string) {
  if (bulkRunToastTimer) clearTimeout(bulkRunToastTimer);
  bulkRunToast.value = msg;
  bulkRunToastTimer = setTimeout(() => { bulkRunToast.value = ''; }, 3000);
}

// Runs on the server, one job at a time with the chosen delay between them, so
// the queue survives the page being closed.
async function startBulkRun() {
  const ids = [...selectedJobIds.value];
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.runJobs(ids, bulkRunDelay.value, bulkRunMaxSeconds.value);
    trackStartedTask(task);
    bulkRunTaskId.value = task.id;
    bulkRunConflict.value = '';
    selectedJobIds.value = [];
  } catch (err: any) {
    const data = err.response?.data;
    // 409 names the queue holding these templates: show that one rather than a bare error
    if (data?.taskId) {
      bulkRunConflict.value = data.error ?? '';
      bulkRunTaskId.value = data.taskId;
      pokeBulkTasks();
      return;
    }
    showBulkRunToast(data?.error ?? t('bulkTasks.startFailed'));
  }
}

function openBulkRun() {
  // Queues are per template now, so attach to the one already holding these jobs --
  // any other queue is somebody else's batch and must not be mistaken for this one.
  bulkRunConflict.value = '';
  bulkRunTaskId.value =
    runningTaskWithRef('run-jobs', selectedJobIds.value)?.id ?? null;
  showBulkRunModal.value = true;
}

function closeBulkRun() {
  showBulkRunModal.value = false;
  bulkRunTaskId.value = null;
  bulkRunConflict.value = '';
}

const manualBrowserJobId = ref<number | null>(null);
const manualBrowserRunId = ref<string | null>(null);
// Runs with a screen up, refreshed alongside the running-job poll
const liveRuns = ref<Record<number, string>>({});

/** The run to watch for a job, when it has one going. */
function watchableRun(jobId: number): string | undefined {
  return liveRuns.value[jobId];
}

function watchRun(runId: string) {
  manualBrowserRunId.value = runId;
}

async function refreshLiveRuns() {
  try {
    // Only after the list: a poll from here is nobody watching, so it must not keep a
    // hand-driven session from idling out
    const { runs } = await manualBrowserApi.status({ watching: false });
    const map: Record<number, string> = {};
    for (const r of runs ?? []) if (r.jobId) map[r.jobId] = r.runId;
    liveRuns.value = map;
  } catch {
    liveRuns.value = {};
  }
}

// A run puts its screen up part way through -- when it reaches the page it has to open --
// rather than the moment it starts, so the watch button cannot be settled once at load time.
// The list keeps looking: quickly while a run is about, slowly otherwise, so the button
// arrives and goes on its own instead of waiting for the page to be reloaded.
const LIVE_RUN_POLL_BUSY_MS = 3000;
const LIVE_RUN_POLL_IDLE_MS = 15000;
let liveRunTimer: ReturnType<typeof setTimeout> | null = null;

function pollLiveRuns() {
  if (liveRunTimer) clearTimeout(liveRunTimer);
  const busy = running.value.size > 0 || Object.keys(liveRuns.value).length > 0;
  liveRunTimer = setTimeout(
    async () => {
      await refreshLiveRuns();
      pollLiveRuns();
    },
    busy ? LIVE_RUN_POLL_BUSY_MS : LIVE_RUN_POLL_IDLE_MS,
  );
}

/** Opens the job's own browser to drive by hand, so a login lands on its profile. */
function openManualBrowser(id: number) {
  manualBrowserJobId.value = id;
}

async function runNow(id: number) {
  running.value.add(id);
  running.value = new Set(running.value);
  try {
    const { logId } = await jobsApi.run(id);
    schedulePoll(id, logId);
    // Something of ours is going now: look for its screen on the quick cadence, so the watch
    // button turns up as soon as the run opens one
    pollLiveRuns();
  } catch (err: any) {
    alert(err.response?.data?.error ?? 'Trigger failed');
    stopRunning(id);
  }
}

// A background job queue finishing changes last-run info, so reload the list then
startBulkTaskPolling();
const stopTaskFinishWatch = onBulkTaskFinished((task) => {
  if (task.kind === 'run-jobs') void loadJobs();
});

onUnmounted(() => {
  for (const timer of pollTimers.values()) clearTimeout(timer);
  if (liveRunTimer) clearTimeout(liveRunTimer);
  stopTaskFinishWatch();
});
</script>

<style scoped>
.modal-title-scope {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
}

.bulk-run-conflict {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--warning-soft);
  color: var(--warning-soft-text);
  font-size: 12px;
}

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

.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sort:hover {
  background: var(--primary-soft);
}

.th-sort.sort-active {
  color: var(--primary-soft-text);
}

.sort-icon {
  font-size: 10px;
  color: var(--text-disabled);
  margin-left: 2px;
}

.th-sort.sort-active .sort-icon {
  color: var(--primary);
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: var(--bg-muted);
}

.row-selected td {
  background: var(--primary-soft-strong);
}

.badge-tpl {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  margin-left: 5px;
  vertical-align: middle;
  letter-spacing: 0.03em;
}

/* Sits alone at the foot of the form, right-aligned, away from the fields it does not belong to */
.one-time-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.one-time-hint {
  font-size: 11px;
  color: var(--text-faint);
  text-align: right;
}

.template-summary-card {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--primary-soft);
  border: 1px solid var(--primary-border);
}

.template-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.template-summary-detail {
  font-size: 13px;
  color: var(--text-secondary);
}

/* ── Mobile action sheet ──────────────────────────────────────────────────────── */

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: var(--bg-card);
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
}

.action-sheet-header {
  padding: 14px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-faint);
}

.action-sheet-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 15px 20px;
  background: none;
  border: none;
  font-size: 15px;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: var(--bg-inset);
}

.action-sheet-btn.danger {
  color: var(--danger);
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: var(--bg-active);
  margin: 4px 0;
}

.action-sheet-cancel {
  color: var(--text-muted);
  font-weight: 500;
}

.last-success {
  font-size: 13px;
  color: var(--text-body);
  white-space: nowrap;
}
.last-success-never {
  font-size: 13px;
  color: var(--text-faint);
}

.job-proxy {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 13px;
  color: var(--text-body);
  max-width: 200px;
}

.job-proxy > i {
  font-size: 11px;
  color: var(--text-faint);
}

/* The name is what identifies the exit, so it is the part that keeps its room */
.job-proxy-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-proxy-direct {
  color: var(--text-faint);
}

/* A deleted exit shows its id, which reads like a name; the colour is what says otherwise */
.job-proxy-missing,
.job-proxy-missing > i {
  color: var(--danger);
}

.bulk-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  border-top: 1px solid var(--border-faint);
  background: var(--bg-subtle);
}

.bulk-count {
  font-size: 13px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.job-toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.88);
  color: var(--text-on-accent);
  font-size: 13px;
  padding: 8px 20px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
  animation: job-fade-in 0.15s ease;
}

@keyframes job-fade-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
