<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("settings.title") }}</h2>
    </div>

    <div class="settings-grid">
      <!-- System defaults -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.sysDefaults") }}</div>

          <div v-if="saveMsg" class="success-msg">{{ saveMsg }}</div>
          <div v-if="saveError" class="error-msg">{{ saveError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelTimezone")
              }}</label>
              <select v-model="form.default_timezone" class="form-select">
                <option v-for="tz in timezones" :key="tz" :value="tz">
                  {{ tz }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelMaxRetries")
              }}</label>
              <input
                v-model.number="form.default_max_retry"
                class="form-input"
                type="number"
                min="1"
                max="10"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input v-model="form.check_daily_run" type="checkbox" />
              <span>{{ t("settings.labelDailyRun") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.dailyRunHint") }}
            </p>
          </div>

          <button
            class="btn btn-primary"
            :disabled="saving"
            @click="saveSettings"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ saving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- TG Notifications -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.notifySection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.notifyHint") }}
          </p>

          <!-- With no token the deprecated account sender is what still runs, so say so
               here rather than only inside the collapsed section below -->
          <p
            v-if="!notifyBot.configured"
            style="font-size: 12px; margin: -6px 0 12px; color: #c47f17"
          >
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.notifyNoBotWarning") }}
          </p>

          <div v-if="notifyMsg" class="success-msg">{{ notifyMsg }}</div>
          <div v-if="notifyError" class="error-msg">{{ notifyError }}</div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyBotToken")
            }}</label>
            <input
              v-model.trim="notifyForm.botToken"
              class="form-input"
              autocomplete="off"
              :placeholder="
                notifyBotTokenMasked || t('settings.notifyBotTokenPlaceholder')
              "
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.notifyBotTokenHint") }}
            </p>
            <p
              v-if="notifyBot.configured"
              style="font-size: 12px; margin: 4px 0 0"
              :style="{ color: notifyBot.ok ? '#2e9e5b' : '#c0392b' }"
            >
              <i
                :class="
                  notifyBot.ok
                    ? 'fa-solid fa-circle-check'
                    : 'fa-solid fa-circle-exclamation'
                "
              ></i>
              {{
                notifyBot.ok
                  ? `${t("settings.notifyBotOk")}: @${notifyBot.username}`
                  : notifyBot.error || t("settings.notifyBotBad")
              }}
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyBotTarget")
            }}</label>
            <input
              v-model.trim="notifyForm.botTarget"
              class="form-input"
              :placeholder="t('settings.notifyBotTargetPlaceholder')"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.notifyBotTargetHint") }}
            </p>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.notifyBotTopicHint") }}
            </p>
            <button
              class="btn btn-ghost btn-sm"
              style="margin-top: 6px"
              :disabled="notifyChatsLoading"
              @click="loadNotifyChats"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
              {{
                notifyChatsLoading
                  ? t("settings.notifyChatsLoading")
                  : t("settings.notifyFindChatsBtn")
              }}
            </button>
            <p
              v-if="notifyChatsHint"
              style="font-size: 12px; color: #888; margin: 6px 0 0"
            >
              {{ notifyChatsHint }}
            </p>
            <div v-if="notifyChats.length" style="margin-top: 6px">
              <button
                v-for="c in notifyChats"
                :key="c.target"
                class="btn btn-ghost btn-sm"
                style="display: block; width: 100%; text-align: left"
                @click="notifyForm.botTarget = c.target"
              >
                {{ c.title }}
                <span style="color: #888">— {{ c.target }} ({{ c.type }})</span>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyEvents")
            }}</label>
            <div class="event-pills">
              <label
                v-for="ev in notifyEventOptions"
                :key="ev.value"
                class="event-pill"
                :class="{ active: notifyForm.events.includes(ev.value) }"
              >
                <input
                  type="checkbox"
                  :checked="notifyForm.events.includes(ev.value)"
                  @change="toggleNotifyEvent(ev.value)"
                />
                {{ ev.label }}
              </label>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="notifySaving"
              @click="saveNotify"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ notifySaving ? t("common.saving") : t("settings.saveBtn") }}
            </button>
            <button
              class="btn btn-ghost"
              :disabled="notifyTesting || notifySaving"
              @click="testNotifyBot"
            >
              <i class="fa-solid fa-paper-plane"></i>
              {{
                notifyTesting
                  ? t("settings.notifyTesting")
                  : t("settings.notifyTestBtn")
              }}
            </button>
          </div>

          <!-- Pre-bot sender: deprecated and slated for removal. Only used while no token
               is set, and only for jobs whose account is authenticated. -->
          <div
            style="
              border-top: 1px solid var(--border, #333);
              margin-top: 16px;
              padding-top: 12px;
            "
          >
            <button
              class="btn btn-ghost btn-sm"
              @click="notifyLegacyOpen = !notifyLegacyOpen"
            >
              <i
                :class="
                  notifyLegacyOpen
                    ? 'fa-solid fa-chevron-down'
                    : 'fa-solid fa-chevron-right'
                "
              ></i>
              {{ t("settings.notifyLegacyTitle") }}
              <span style="color: #c47f17; font-weight: 400">
                ({{ t("settings.notifyDeprecatedTag") }})
              </span>
            </button>
            <div v-if="notifyLegacyOpen" style="margin-top: 10px">
              <p style="font-size: 12px; margin: 0 0 8px; color: #c47f17">
                <i class="fa-solid fa-triangle-exclamation"></i>
                {{ t("settings.notifyLegacyDeprecated") }}
              </p>
              <p style="font-size: 12px; color: #888; margin: 0 0 8px">
                {{ t("settings.notifyLegacyHint") }}
              </p>
              <label class="form-label">{{
                t("settings.labelNotifyUsername")
              }}</label>
              <input
                v-model.trim="notifyForm.username"
                class="form-input"
                :placeholder="t('settings.notifyUsernamePlaceholder')"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Cloudflare solver -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.cfSolver.title") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.cfSolver.hint") }}
          </p>
          <div v-if="cfInstallMsg" class="success-msg">{{ cfInstallMsg }}</div>
          <div v-if="cfInstallError" class="error-msg">{{ cfInstallError }}</div>
          <p style="font-size: 12px; margin: 0 0 8px">
            {{ t("settings.cfSolver.status") }}:
            <strong :style="{ color: cfChromiumInstalled ? '#2e9e5b' : '#c47f17' }">
              {{ cfChromiumInstalled ? t("settings.cfSolver.stateInstalled") : t("settings.cfSolver.stateNotInstalled") }}
            </strong>
            <!-- Only when the build list is unavailable (an older backend): otherwise every
                 build is listed below, and repeating the preferred one here reads as a
                 contradiction of the second entry -->
            <template v-if="!cfBuilds.length">
              <span v-if="cfChromiumVersion" style="color: #888"> — {{ cfChromiumVersion }}</span>
              <span v-if="cfChromiumTier" style="color: #888">
                ({{ cfChromiumTier === "keyed" ? t("settings.cfSolver.tierKeyed") : t("settings.cfSolver.tierFree") }})
              </span>
            </template>
          </p>
          <p
            v-if="!cfBuilds.length && cfChromiumPath"
            style="font-size: 11px; color: #888; margin: -6px 0 12px; word-break: break-all"
          >
            {{ cfChromiumPath }}
          </p>
          <!-- Both tiers can be installed at once and a job may run on either, so each is
               listed with which one it is and when it gets used -->
          <div v-if="cfBuilds.length" style="margin: 0 0 12px">
            <div v-for="b in cfBuilds" :key="b.path" style="margin-bottom: 6px">
              <span style="font-size: 12px">
                <strong>{{
                  b.tier === "keyed"
                    ? t("settings.cfSolver.tierKeyed")
                    : t("settings.cfSolver.tierFree")
                }}</strong>
                <span style="color: #888"> — CloakBrowser {{ b.version }}</span>
                <span
                  :style="`margin-left:6px;font-size:11px;color:${b.preferred ? '#2e9e5b' : '#888'}`"
                >
                  {{
                    b.preferred
                      ? t("settings.cfSolver.buildDefault")
                      : t("settings.cfSolver.buildFallback")
                  }}
                </span>
              </span>
              <div style="font-size: 11px; color: #aaa; word-break: break-all">{{ b.path }}</div>
            </div>
          </div>
          <p
            v-if="cfChromiumTier === 'keyed' && !cfFreeInstalled"
            style="font-size: 12px; margin: -6px 0 12px; color: #c47f17"
          >
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.noFreeFallback") }}
          </p>
          <p v-if="cfKeyedPending" style="font-size: 12px; margin: -6px 0 12px; color: #c47f17">
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.keyedPending") }}
          </p>
          <p v-if="cfChromiumInstalled && !cfFontsInstalled" style="font-size: 12px; margin: -6px 0 12px; color: #c47f17">
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.fontsMissing") }}<span v-if="cfFontsMissing"> ({{ cfFontsMissing }})</span>
          </p>
          <div class="form-group" style="margin: 0 0 12px; max-width: 320px">
            <label class="form-label">{{ t("settings.cfSolver.langLabel") }}</label>
            <select v-model="cfBrowserLang" class="form-select" @change="saveCfBrowserLang">
              <option value="">{{ t("settings.cfSolver.langFollowExit") }}</option>
              <option v-for="l in CF_LOCALES" :key="l.id" :value="l.id">
                {{ l.name }} ({{ l.id }})
              </option>
            </select>
            <div style="font-size: 11px; color: #888; margin-top: 3px">
              {{ t("settings.cfSolver.langHint") }}
            </div>
          </div>
          <!-- x11vnc: only needed to watch a browser being driven by hand, so it is
               fetched on demand rather than shipped in every image -->
          <div class="form-group" style="margin: 0 0 12px; max-width: 560px">
            <label class="form-label">{{ t("settings.cfSolver.vncLabel") }}</label>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
              <span v-if="vncInstalled" style="font-size: 12px; color: #2e9e5b">
                <i class="fa-solid fa-check"></i>
                {{ vncVersion || t("settings.cfSolver.vncPresent") }}
                <span style="color: #888">({{ vncSourceText }})</span>
              </span>
              <span v-else style="font-size: 12px; color: #c47f17">
                <i class="fa-solid fa-triangle-exclamation"></i>
                {{ t("settings.cfSolver.vncMissing") }}
              </span>
              <button class="btn btn-sm btn-primary" :disabled="vncInstalling" @click="installVnc">
                <i class="fa-solid fa-download"></i>
                {{ vncInstalling ? t("settings.cfSolver.vncInstalling") : t(vncInstalled ? "settings.cfSolver.vncReinstall" : "settings.cfSolver.vncInstall") }}
              </button>
              <button
                v-if="vncFromDataDir"
                class="btn btn-sm btn-ghost"
                :disabled="vncInstalling"
                @click="removeVnc"
              >
                {{ t("common.delete") }}
              </button>
            </div>
            <div style="font-size: 11px; color: #888; margin-top: 3px">
              {{ t("settings.cfSolver.vncHint") }}
            </div>
            <pre v-if="vncLog" class="vnc-log">{{ vncLog }}</pre>
          </div>
          <div class="form-group" style="margin: 0 0 12px; max-width: 420px">
            <label class="form-label">{{ t("settings.cfSolver.profileIdLabel") }}</label>
            <input
              v-model.trim="cfProfileId"
              class="form-input"
              placeholder="{ip}"
              @change="saveCfProfileId"
            />
            <div style="font-size: 11px; color: #888; margin-top: 3px">
              {{ t("settings.cfSolver.profileIdHint") }}
            </div>
          </div>

          <!-- Managing the profiles themselves: the sessions a run carries over. Kept beside
               the name template above, which decides which profile a run lands on. -->
          <div class="profiles-panel">
            <!-- Folded away by default: a dozen profiles fill the page, and this is a place
                 you visit to tidy up rather than one you read on the way past -->
            <div class="profiles-head">
              <button class="btn btn-sm btn-ghost" @click="cfProfilesOpen = !cfProfilesOpen">
                <i
                  :class="cfProfilesOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"
                ></i>
                <strong>{{ t("settings.profiles.title") }}</strong>
              </button>
              <span style="font-size: 11px; color: #888">
                {{
                  t("settings.profiles.summary")
                    .replace("{n}", String(cfProfiles.length))
                    .replace("{size}", formatBytes(cfProfilesTotalBytes))
                }}
              </span>
              <button
                v-if="cfProfilesOpen"
                class="btn btn-sm btn-ghost"
                :disabled="cfProfilesLoading"
                @click="loadCfProfiles"
              >
                <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
              </button>
            </div>

            <div v-if="cfProfilesOpen" class="profiles-actions">
              <input
                v-model.trim="newProfileName"
                class="form-input"
                style="flex: 0 0 200px"
                :placeholder="t('settings.profiles.namePlaceholder')"
                @keyup.enter="addProfile"
              />
              <button
                class="btn btn-sm btn-ghost"
                :disabled="!newProfileName || profilesBusy"
                @click="addProfile"
              >
                <i class="fa-solid fa-plus"></i> {{ t("settings.profiles.addBtn") }}
              </button>
              <span class="profiles-sep"></span>
              <button
                class="btn btn-sm btn-ghost"
                :disabled="!selectedProfiles.length || profilesBusy"
                @click="exportProfiles"
              >
                <i class="fa-solid fa-file-export"></i>
                {{ t("settings.profiles.exportBtn") }}
                <template v-if="selectedProfiles.length"> ({{ selectedProfiles.length }})</template>
              </button>
              <button
                class="btn btn-sm btn-ghost"
                :disabled="!selectedProfiles.length || profilesBusy"
                @click="confirmDeleteProfiles = true"
              >
                <i class="fa-solid fa-trash"></i>
                {{ t("settings.profiles.deleteBtn") }}
                <template v-if="selectedProfiles.length"> ({{ selectedProfiles.length }})</template>
              </button>
              <span class="profiles-sep"></span>
              <input
                ref="profileImportInput"
                type="file"
                accept=".gz,.tgz,.tar.gz,application/gzip"
                style="display: none"
                @change="onProfileFilePicked"
              />
              <button
                class="btn btn-sm btn-ghost"
                :disabled="profilesBusy"
                @click="profileImportInput?.click()"
              >
                <i class="fa-solid fa-file-import"></i> {{ t("settings.profiles.importBtn") }}
              </button>
              <label class="profiles-replace">
                <input type="checkbox" v-model="importReplaceProfiles" />
                {{ t("settings.profiles.replaceLabel") }}
              </label>
            </div>

            <div v-if="cfProfilesOpen && profilesMsg" class="success-msg" style="margin: 6px 0">{{ profilesMsg }}</div>
            <div v-if="cfProfilesOpen && profilesError" class="error-msg" style="margin: 6px 0">{{ profilesError }}</div>

            <div v-if="cfProfilesOpen && !cfProfiles.length" style="font-size: 12px; color: #888">
              {{ t("settings.profiles.empty") }}
            </div>
            <table v-else-if="cfProfilesOpen" class="profiles-table">
              <thead>
                <tr>
                  <th style="width: 28px">
                    <input
                      type="checkbox"
                      :checked="allProfilesSelected"
                      @change="toggleAllProfiles"
                    />
                  </th>
                  <th>{{ t("settings.profiles.colName") }}</th>
                  <th style="width: 90px">{{ t("settings.profiles.colSize") }}</th>
                  <th style="width: 140px">{{ t("settings.profiles.colLastUsed") }}</th>
                  <th style="width: 150px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in cfProfiles" :key="p.name">
                  <td>
                    <input type="checkbox" :value="p.name" v-model="selectedProfiles" />
                  </td>
                  <!-- Renaming in place: the name is what a job's profile field targets, so
                       this is how one job's session is handed to another -->
                  <td style="font-family: monospace; font-size: 12px">
                    <input
                      v-if="renamingProfile === p.name"
                      v-model.trim="renameValue"
                      autofocus
                      class="form-input"
                      style="height: 26px; font-family: monospace; font-size: 12px"
                      :placeholder="t('settings.profiles.namePlaceholder')"
                      @keyup.enter="saveRename"
                      @keyup.esc="renamingProfile = ''"
                    />
                    <template v-else>{{ p.name }}</template>
                  </td>
                  <td>{{ formatBytes(p.sizeBytes) }}</td>
                  <td style="font-size: 12px; color: #666">
                    {{ p.lastUsedAt ? formatWhen(p.lastUsedAt) : t("settings.profiles.neverUsed") }}
                  </td>
                  <td style="white-space: nowrap">
                    <template v-if="renamingProfile === p.name">
                      <button
                        class="btn btn-sm btn-ghost"
                        :disabled="!renameValue || renameValue === p.name || profilesBusy"
                        @click="saveRename"
                      >
                        <i class="fa-solid fa-check"></i>
                      </button>
                      <button class="btn btn-sm btn-ghost" @click="renamingProfile = ''">
                        <i class="fa-solid fa-xmark"></i>
                      </button>
                    </template>
                    <template v-else>
                      <button
                        class="btn btn-sm btn-ghost"
                        :disabled="p.inUse || profilesBusy"
                        :title="
                          p.inUse
                            ? t('settings.profiles.inUseTip')
                            : t('settings.profiles.renameTip')
                        "
                        @click="startRename(p.name)"
                      >
                        <i class="fa-solid fa-pen"></i>
                      </button>
                      <span
                        v-if="p.inUse"
                        class="badge badge-red"
                        style="font-size: 10px"
                        :title="t('settings.profiles.inUseTip')"
                        >{{ t("settings.profiles.inUse") }}</span
                      >
                      <span
                        v-else-if="p.managed"
                        class="badge badge-purple"
                        style="font-size: 10px"
                        :title="t('settings.profiles.managedTip')"
                        >{{ t("settings.profiles.managed") }}</span
                      >
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="cfProfilesOpen" style="font-size: 11px; color: #888; margin-top: 6px">
              {{ t("settings.profiles.hint") }}
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="cfInstalling || cfTesting || cfSolverComplete"
              @click="installCfSolver(false)"
            >
              <i class="fa-solid fa-download"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t(cfInstallLabelKey) }}
            </button>
            <button
              v-if="cfChromiumInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="installCfSolver(true)"
            >
              <i class="fa-solid fa-rotate"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t("settings.cfSolver.reinstallBtn") }}
            </button>
            <button
              v-if="!cfFreeInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="installCfSolver(false, 'free')"
            >
              <i class="fa-solid fa-download"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t("settings.cfSolver.installFreeBtn") }}
            </button>
            <button
              v-if="cfChromiumInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="testCfSolver"
            >
              <i class="fa-solid fa-flask"></i>
              {{ cfTesting ? t("settings.cfSolver.testing") : t("settings.cfSolver.testBtn") }}
            </button>
          </div>
          <div v-if="cfChromiumInstalled" style="font-size: 11px; color: #888; margin-top: 6px">
            {{ t("settings.cfSolver.reinstallHint") }}
          </div>
          <div v-if="!cfFreeInstalled" style="font-size: 11px; color: #888; margin-top: 6px">
            {{ t("settings.cfSolver.installFreeHint") }}
          </div>
          <!-- Kept off the row above and styled quietly: it throws away a 200MB download
               that everything else here depends on, so it should not read as a next step -->
          <div
            v-if="cfChromiumInstalled"
            style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #eee"
          >
            <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping || cfClearingProfiles"
                @click="stopCfBrowsers"
              >
                <i class="fa-solid fa-hand"></i>
                {{ cfStopping ? t("settings.cfSolver.stopping") : t("settings.cfSolver.stopBtn") }}
                <template v-if="cfBrowsersRunning > 0"> ({{ cfBrowsersRunning }})</template>
              </button>
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping || cfClearingProfiles"
                @click="clearCfProfiles"
              >
                <i class="fa-solid fa-eraser"></i>
                {{ cfClearingProfiles ? t("settings.cfSolver.clearingProfiles") : t("settings.cfSolver.clearProfilesBtn") }}
                <template v-if="cfProfileCount > 0"> ({{ cfProfileCount }})</template>
              </button>
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping || cfClearingGeo"
                @click="clearCfExitGeo"
              >
                <i class="fa-solid fa-location-crosshairs"></i>
                {{ cfClearingGeo ? t("settings.cfSolver.clearingGeo") : t("settings.cfSolver.clearGeoBtn") }}
              </button>
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping"
                @click="confirmUninstallCf = true"
              >
                <i class="fa-solid fa-trash"></i>
                {{ cfUninstalling ? t("settings.cfSolver.uninstalling") : t("settings.cfSolver.uninstallBtn") }}
              </button>
            </div>
            <div style="font-size: 11px; color: #888; margin-top: 6px">
              {{ t("settings.cfSolver.stopHint") }}
              {{ t("settings.cfSolver.clearProfilesHint") }}
              {{ t("settings.cfSolver.uninstallHint") }}
            </div>
          </div>
          <div v-if="cfTestWarnings.length" class="error-msg" style="margin-top: 8px">
            <div v-for="w in cfTestWarnings" :key="w">• {{ w }}</div>
          </div>
          <div
            v-if="cfTestNotes.length"
            style="font-size: 11px; color: #888; margin-top: 8px"
          >
            <div v-for="n in cfTestNotes" :key="n">• {{ n }}</div>
          </div>
          <pre
            v-if="cfTestReport"
            style="font-size: 11px; margin-top: 8px; max-height: 220px; overflow: auto; white-space: pre-wrap"
            >{{ cfTestReport }}</pre
          >

          <!-- CloakBrowser licence keys: one free key per GitHub account, one browser each -->
          <div style="border-top: 1px solid var(--border, #333); margin-top: 16px; padding-top: 12px">
            <button class="btn btn-ghost btn-sm" @click="cfKeysOpen = !cfKeysOpen">
              <i :class="cfKeysOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              {{ t("settings.cfKeys.title") }}
              <span style="color: #888; font-weight: 400">({{ cfKeys.length }})</span>
            </button>
            <div v-if="cfKeysOpen" style="margin-top: 10px">
              <p style="font-size: 12px; color: #888; margin: 0 0 12px">
                {{ t("settings.cfKeys.hint") }}
              </p>
              <div v-if="cfKeysMsg" class="success-msg">{{ cfKeysMsg }}</div>
              <div v-if="cfKeysError" class="error-msg">{{ cfKeysError }}</div>
              <p v-if="cfKeys.length" style="font-size: 11px; color: #888; margin: 0 0 8px">
                {{ t("settings.cfKeys.inUse") }}: {{ cfKeysInUse }} / {{ cfKeys.length }}
              </p>
              <div
                v-for="(k, i) in cfKeys"
                :key="i"
                style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px"
              >
                <input
                  v-model="k.label"
                  class="form-input"
                  style="flex: 0 0 32%"
                  :placeholder="t('settings.cfKeys.labelPlaceholder')"
                />
                <div style="flex: 1">
                  <input
                    v-model="k.key"
                    class="form-input"
                    :placeholder="t('settings.cfKeys.keyPlaceholder')"
                  />
                  <div v-if="cfKeyChecks[k.label]" style="font-size: 11px; margin-top: 3px"
                    :style="{ color: cfKeyChecks[k.label].valid ? '#2e9e5b' : '#c0392b' }">
                    {{ cfKeyChecks[k.label].valid
                      ? `${t("settings.cfKeys.checkValid")} — ${cfKeyChecks[k.label].plan || "free"}`
                      : cfKeyChecks[k.label].error || t("settings.cfKeys.checkInvalid") }}
                  </div>
                </div>
                <button class="btn btn-ghost btn-sm" @click="cfKeys.splice(i, 1)">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap">
                <button class="btn btn-ghost" @click="cfKeys.push({ label: '', key: '' })">
                  <i class="fa-solid fa-plus"></i>
                  {{ t("settings.cfKeys.addBtn") }}
                </button>
                <button class="btn btn-primary" :disabled="cfKeysSaving" @click="saveCfKeys">
                  <i class="fa-solid fa-floppy-disk"></i>
                  {{ cfKeysSaving ? t("common.saving") : t("common.save") }}
                </button>
                <button
                  v-if="cfKeys.length"
                  class="btn btn-ghost"
                  :disabled="cfKeysSaving || cfKeysChecking"
                  @click="checkCfKeys"
                >
                  <i class="fa-solid fa-circle-check"></i>
                  {{ cfKeysChecking ? t("settings.cfKeys.checking") : t("settings.cfKeys.checkBtn") }}
                </button>
              </div>
            </div>
          </div>

          <!-- Browser timings and limits: defaults are what the solver ships with -->
          <div style="border-top: 1px solid var(--border, #333); margin-top: 16px; padding-top: 12px">
            <button class="btn btn-ghost btn-sm" @click="cfTuningOpen = !cfTuningOpen">
              <i :class="cfTuningOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              {{ t("settings.cfTuning.title") }}
            </button>
            <div v-if="cfTuningOpen" style="margin-top: 10px">
              <p style="font-size: 12px; color: #888; margin: 0 0 12px">
                {{ t("settings.cfTuning.hint") }}
              </p>
              <div v-if="cfTuningMsg" class="success-msg">{{ cfTuningMsg }}</div>
              <div v-if="cfTuningError" class="error-msg">{{ cfTuningError }}</div>
              <div v-for="f in cfTuningFields" :key="f" class="form-group">
                <label class="form-label">
                  {{ t(`settings.cfTuning.fields.${f}.label`) }}
                  <span style="font-weight: 400; color: #888">
                    ({{ t("settings.cfTuning.default") }}: {{ cfTuningDefaults[f] }})
                  </span>
                </label>
                <input
                  v-model.number="cfTuningForm[f]"
                  class="form-input"
                  type="number"
                  :min="cfTuningLimits[f]?.min"
                  :max="cfTuningLimits[f]?.max"
                  :placeholder="String(cfTuningDefaults[f])"
                />
                <div style="font-size: 11px; color: #aaa; margin-top: 3px">
                  {{ t(`settings.cfTuning.fields.${f}.hint`) }}
                  <span v-if="cfTuningLimits[f]">
                    {{ t("settings.cfTuning.range") }}: {{ cfTuningLimits[f].min }}–{{ cfTuningLimits[f].max }}
                  </span>
                </div>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 12px">
                <button class="btn btn-primary" :disabled="cfTuningSaving" @click="saveCfTuning">
                  <i class="fa-solid fa-floppy-disk"></i>
                  {{ cfTuningSaving ? t("common.saving") : t("common.save") }}
                </button>
                <button class="btn btn-ghost" :disabled="cfTuningSaving" @click="resetCfTuning">
                  <i class="fa-solid fa-rotate-left"></i>
                  {{ t("settings.cfTuning.resetBtn") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Admin credentials -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.adminCreds") }}</div>

          <div v-if="credMsg" class="success-msg">{{ credMsg }}</div>
          <div v-if="credError" class="error-msg">{{ credError }}</div>

          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewUsername") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model.trim="cred.username"
              class="form-input"
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewPassword") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model="cred.newPassword"
              class="form-input"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="form-group">
            <label class="form-label"
              >{{ t("settings.labelCurrentPass") }}
              <span style="color: #e63946">*</span></label
            >
            <input
              v-model="cred.currentPassword"
              class="form-input"
              type="password"
              autocomplete="current-password"
            />
          </div>

          <button
            class="btn btn-primary"
            :disabled="credSaving"
            @click="saveCredentials"
          >
            <i class="fa-solid fa-shield-halved"></i>
            {{ credSaving ? t("common.saving") : t("settings.updateBtn") }}
          </button>

          <div class="settings-subsection" style="margin-top: 22px">
            {{ t("settings.sessionsSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.sessionsHint") }}
          </p>
          <button
            class="btn btn-secondary"
            :disabled="revoking"
            @click="signOutEverywhere"
          >
            <i class="fa-solid fa-right-from-bracket"></i>
            {{ revoking ? t("common.saving") : t("settings.revokeSessionsBtn") }}
          </button>
        </div>
      </div>

      <!-- General settings -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.generalSection") }}
          </div>

          <!-- Telegram API credentials -->
          <div class="settings-subsection">
            {{ t("settings.defaultTgApiSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 14px">
            {{ t("settings.defaultTgApiHint") }}
          </p>

          <div v-if="defaultTgApiMsg" class="success-msg">
            {{ defaultTgApiMsg }}
          </div>
          <div v-if="defaultTgApiError" class="error-msg">
            {{ defaultTgApiError }}
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDefaultTgApiId")
              }}</label>
              <input
                v-model.number="defaultTgApiId"
                class="form-input"
                type="number"
                min="1"
                placeholder="e.g. 1234567"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDefaultTgApiHash")
              }}</label>
              <input
                v-model.trim="defaultTgApiHashInput"
                class="form-input"
                :placeholder="
                  defaultTgApiHashMasked
                    ? t('settings.defaultTgApiHashPlaceholder')
                    : t('settings.defaultTgApiHashNew')
                "
                style="font-family: monospace"
              />
              <p
                v-if="defaultTgApiHashMasked"
                style="font-size: 11px; color: #888; margin: 4px 0 0"
              >
                {{ t("settings.defaultTgApiHashSet") }}
                <code style="font-size: 11px">{{
                  defaultTgApiHashMasked
                }}</code>
              </p>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="defaultTgApiSaving"
              @click="saveDefaultTgApi"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{
                defaultTgApiSaving ? t("common.saving") : t("settings.saveBtn")
              }}
            </button>
            <button
              v-if="defaultTgApiId || defaultTgApiHashMasked"
              class="btn btn-ghost"
              :disabled="defaultTgApiClearing"
              @click="clearDefaultTgApi"
            >
              {{
                defaultTgApiClearing
                  ? t("settings.defaultTgApiClearing")
                  : t("settings.defaultTgApiClear")
              }}
            </button>
          </div>

          <!-- Schedule list placement -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.schedulePageSection") }}
          </div>
          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                v-model="scheduleSeparatePageSetting"
                @change="saveSchedulePage"
              />
              <span>{{ t("settings.schedulePageToggle") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.schedulePageHint") }}
            </p>
          </div>

          <!-- Template edit button on the jobs page -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.jobsTemplateEditSection") }}
          </div>
          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                v-model="jobsTemplateEditButtonSetting"
                @change="saveJobsTemplateEditButton"
              />
              <span>{{ t("settings.jobsTemplateEditToggle") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.jobsTemplateEditHint") }}
            </p>
          </div>

          <!-- The data store: its menu entry and its job steps. The whole section is absent
               unless the server offers the feature (DATA_MANAGEMENT), so a panel that has no
               use for it never asks the question -->
          <template v-if="dataStoreAvailable">
            <div class="settings-subsection" style="margin-top: 28px">
              {{ t("settings.dataStoreSection") }}
            </div>
            <div class="form-group">
              <label class="form-check">
                <input type="checkbox" v-model="dataStoreSetting" @change="saveDataStore" />
                <span>{{ t("settings.dataStoreToggle") }}</span>
              </label>
              <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
                {{ t("settings.dataStoreHint") }}
              </p>
            </div>
          </template>

          <!-- TG account display -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.accountDisplaySection") }}
          </div>
          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                v-model="accountDisplayWithTgName"
                @change="saveAccountDisplay"
              />
              <span>{{ t("settings.accountDisplayToggle") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.accountDisplayHint") }}
            </p>
          </div>

          <!-- Log retention -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.logRetentionSection") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelLogRetention")
            }}</label>
            <input
              v-model.number="logRetentionDays"
              class="form-input"
              type="number"
              min="0"
              style="max-width: 160px"
              @change="saveLogRetention"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.logRetentionHint") }}
            </p>
          </div>

          <!-- Schedule staggering -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.scheduleGapSection") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelScheduleGap")
            }}</label>
            <input
              v-model.number="scheduleGapMinutes"
              class="form-input"
              type="number"
              min="0"
              max="30"
              style="max-width: 160px"
              @change="saveScheduleGap"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.scheduleGapHint") }}
            </p>
          </div>
        </div>
      </div>

      <!-- Secrets: named values a job config refers to as {name} -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.secretsSection") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.secretsHint") }}
          </p>

          <div v-if="secretsMsg" class="success-msg">{{ secretsMsg }}</div>
          <div v-if="secretsError" class="error-msg">{{ secretsError }}</div>

          <div v-for="sec in secrets" :key="sec.key" class="ua-preset-row">
            <span class="ua-preset-name">{{ sec.key }}</span>
            <span class="ua-preset-value">{{ "{" + sec.key + "}" }}</span>
            <span style="font-size: 11px; color: #aaa">
              {{ sec.updatedAt ? fmtSecretDate(sec.updatedAt) : "" }}
            </span>
            <button
              class="btn btn-sm btn-danger btn-icon"
              :title="t('common.delete')"
              @click="removeSecret(sec.key)"
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <p v-if="!secrets.length" style="font-size: 12px; color: #aaa; margin: 0 0 12px">
            {{ t("settings.secretsEmpty") }}
          </p>

          <!-- Same form adds and replaces: an existing name is simply written over -->
          <div class="proxy-row" style="margin-top: 10px">
            <input
              v-model.trim="secretForm.key"
              class="form-input"
              style="flex: 0 0 180px"
              :placeholder="t('settings.secretNamePlaceholder')"
            />
            <input
              v-model="secretForm.value"
              class="form-input"
              style="flex: 1"
              type="password"
              autocomplete="new-password"
              :placeholder="t('settings.secretValuePlaceholder')"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="secretSaving || !secretForm.key || !secretForm.value"
              @click="saveSecret"
            >
              {{ secretSaving ? t("common.saving") : t("common.save") }}
            </button>
          </div>
          <p style="font-size: 12px; color: #888; margin: 6px 0 0">
            {{ t("settings.secretsWriteOnlyHint") }}
          </p>

          <!-- The Microsoft app a refresh-token step signs in against. The id is no secret,
               but it is half a pair with one, so it is asked for beside it -->
          <div style="margin-top: 16px">
            <label class="form-label">{{ t("settings.msOauthClientIdLabel") }}</label>
            <div class="proxy-row">
              <input
                v-model.trim="msOauthClientId"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.msOauthClientIdPlaceholder')"
              />
              <button
                class="btn btn-sm btn-primary"
                :disabled="msOauthSaving"
                @click="saveMsOauthClientId"
              >
                {{ msOauthSaving ? t("common.saving") : t("common.save") }}
              </button>
            </div>
            <p style="font-size: 12px; color: #888; margin: 6px 0 0">
              {{ t("settings.msOauthClientIdHint") }}
            </p>
          </div>
        </div>
      </div>

      <!-- msOauth2api: the mailbox pool a login email or a signup step can draw an address
           from. The key is write-only, the same round trip the bot token makes. The whole
           card is absent unless the server offers the feature (MSOAUTH2API), so a panel with
           no install to point at never mentions it -->
      <div v-if="msApiAvailable" class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.msapi.title") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.msapi.hint") }}
          </p>

          <div v-if="msApiMsg" class="success-msg">{{ msApiMsg }}</div>
          <div v-if="msApiError" class="error-msg">{{ msApiError }}</div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.msapi.baseUrlLabel") }}</label>
            <input
              v-model.trim="msApiForm.baseUrl"
              class="form-input"
              autocomplete="off"
              placeholder="http://host:3000"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.msapi.baseUrlHint") }}
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.msapi.apiKeyLabel") }}</label>
            <input
              v-model.trim="msApiForm.apiKey"
              class="form-input"
              autocomplete="off"
              :placeholder="msApiKeyMasked || 'msk_...'"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.msapi.apiKeyHint") }}
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.msapi.poolTypeLabel") }}</label>
            <input
              v-model.trim="msApiForm.poolType"
              class="form-input"
              style="max-width: 220px"
              :placeholder="msApiPoolTypeDefault"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.msapi.poolTypeHint") }}
            </p>
          </div>

          <div style="display: flex; gap: 8px; align-items: center">
            <button
              class="btn btn-primary btn-sm"
              :disabled="msApiSaving"
              @click="saveMsApi"
            >
              {{ msApiSaving ? t("common.saving") : t("common.save") }}
            </button>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="msApiTesting || !msApiConfigured"
              @click="testMsApi"
            >
              <i class="fa-solid fa-plug-circle-check"></i>
              {{ msApiTesting ? t("settings.msapi.testing") : t("settings.msapi.testBtn") }}
            </button>
          </div>
          <p v-if="msApiPool" style="font-size: 12px; margin: 8px 0 0; color: #2e9e5b">
            <i class="fa-solid fa-circle-check"></i> {{ msApiPool }}
          </p>
        </div>
      </div>

      <!-- Proxies -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.proxiesSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.proxiesHint") }}
          </p>

          <div v-if="proxiesMsg" class="success-msg">{{ proxiesMsg }}</div>
          <div v-if="proxiesError" class="error-msg">{{ proxiesError }}</div>

          <!-- The list is what makes this card tall: a synced provider leaves dozens of
               entries, so it folds away behind a count of what state they are in -->
          <div class="proxy-fold">
            <button class="btn btn-ghost btn-sm" @click="proxyListOpen = !proxyListOpen">
              <i
                :class="proxyListOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"
              ></i>
              {{ t("settings.proxyListTitle") }}
              <span style="color: #888; font-weight: 400">({{ proxies.length }})</span>
            </button>
            <span class="proxy-fold-note">{{ proxyStateSummary }}</span>
          </div>

          <div v-if="proxyListOpen" class="proxy-list-box">
            <div v-for="(p, i) in proxies" :key="p.id">
              <div v-if="editingProxyId === p.id" class="proxy-edit-panel">
                <div class="proxy-row">
                  <select
                    v-model="editProxyForm.protocol"
                    class="form-select"
                    style="flex: 0 0 110px"
                  >
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                  <input
                    v-model.trim="editProxyForm.host"
                    class="form-input"
                    style="flex: 1"
                    :placeholder="t('settings.proxyHost')"
                    @input="onProxyHostInput(editProxyForm)"
                  />
                  <input
                    v-model.trim="editProxyForm.port"
                    class="form-input"
                    style="flex: 0 0 80px"
                    type="number"
                    min="1"
                    max="65535"
                    :placeholder="t('settings.proxyPort')"
                  />
                </div>
                <div class="proxy-row">
                  <input
                    v-model.trim="editProxyForm.username"
                    class="form-input"
                    style="flex: 1"
                    :placeholder="t('settings.proxyUsername')"
                    autocomplete="off"
                  />
                  <input
                    v-model.trim="editProxyForm.password"
                    class="form-input"
                    style="flex: 1"
                    :placeholder="t('settings.proxyPassword')"
                    autocomplete="off"
                  />
                </div>
                <div class="proxy-row">
                  <input
                    v-model.trim="editProxyForm.name"
                    class="form-input"
                    style="flex: 0 0 160px"
                    :placeholder="t('settings.proxyName')"
                  />
                  <label
                    class="form-checkbox-label"
                    style="flex: 0 0 auto"
                    :title="t('settings.proxyPickedOnlyTip')"
                  >
                    <input type="checkbox" v-model="editProxyForm.autoPool" />
                    {{ t("settings.proxyAutoPool") }}
                  </label>
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="
                      proxyEditTesting ||
                      !editProxyForm.name ||
                      !editProxyForm.host
                    "
                    @click="saveProxyEdit(i)"
                  >
                    {{
                      proxyEditTesting
                        ? t("settings.proxyTesting")
                        : t("common.save")
                    }}
                  </button>
                  <button
                    class="btn btn-sm btn-ghost"
                    @click="editingProxyId = null"
                  >
                    {{ t("common.cancel") }}
                  </button>
                </div>
              </div>
              <div v-else class="ua-preset-row">
                <span class="ua-preset-name">{{ p.name }}</span>
                <span class="ua-preset-value">{{ p.url }}</span>
                <span
                  v-if="!proxySupportsTelegram(p.url)"
                  class="badge badge-red"
                  style="font-size: 10px"
                  :title="t('settings.proxyBrowserOnlyTip')"
                  >{{ t("settings.proxyBrowserOnly") }}</span
                >
                <span
                  v-if="p.autoPool === false"
                  class="badge"
                  style="font-size: 10px"
                  :title="t('settings.proxyPickedOnlyTip')"
                  >{{ t("settings.proxyPickedOnly") }}</span
                >
                <!-- Off by hand outranks the tests' own verdict: they never set it, never
                     clear it, and skip the exit while it stands -->
                <span
                  v-if="p.disabled"
                  class="badge badge-red"
                  style="font-size: 10px"
                  :title="t('settings.proxyOffTip')"
                  >{{ t("settings.proxyOff") }}</span
                >
                <!-- The verdict the last test left on the entry: a failed one is disabled
                     until a later test, or the button beside it, puts it back -->
                <span
                  v-else-if="p.status === 'failed'"
                  class="badge badge-red"
                  style="font-size: 10px"
                  :title="proxyStatusTip(p)"
                  >{{ t("settings.proxyDisabled") }}</span
                >
                <span
                  v-else-if="p.status === 'ok'"
                  class="badge badge-green"
                  style="font-size: 10px"
                  :title="proxyStatusTip(p)"
                  >{{ p.testMs ? `${p.testMs} ms` : t("settings.proxyStatusOk") }}</span
                >
                <span
                  v-if="proxyTestResults[p.id]?.exitIp"
                  class="badge"
                  style="font-size: 10px"
                  :title="t('settings.proxyExitIpTip')"
                  >{{ proxyTestResults[p.id].exitIp }}</span
                >
                <button
                  v-if="p.disabled || p.status === 'failed'"
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('settings.proxyEnableTip')"
                  @click="enableProxy(p.id)"
                >
                  <i class="fa-solid fa-play"></i>
                </button>
                <button
                  v-else
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('settings.proxyDisableTip')"
                  @click="disableProxy(p.id)"
                >
                  <i class="fa-solid fa-ban"></i>
                </button>
                <button
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('common.edit')"
                  @click="startEditProxy(p)"
                >
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button
                  class="btn btn-sm btn-ghost ua-preset-del"
                  :title="t('settings.proxyDeleteTip')"
                  @click="removeProxy(i)"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>
          </div>

          <div class="proxy-fold">
            <button class="btn btn-ghost btn-sm" @click="proxyAddOpen = !proxyAddShown">
              <i
                :class="proxyAddShown ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"
              ></i>
              {{ t("settings.addProxyTitle") }}
            </button>
          </div>

          <div v-if="proxyAddShown" class="proxy-edit-panel" style="margin-top: 4px">
            <div class="proxy-row">
              <select
                v-model="newProxy.protocol"
                class="form-select"
                style="flex: 0 0 110px"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
              </select>
              <input
                v-model.trim="newProxy.host"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyHost')"
                @input="onProxyHostInput(newProxy)"
              />
              <input
                v-model.trim="newProxy.port"
                class="form-input"
                style="flex: 0 0 80px"
                type="number"
                min="1"
                max="65535"
                :placeholder="t('settings.proxyPort')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.username"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyUsername')"
                autocomplete="off"
              />
              <input
                v-model.trim="newProxy.password"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyPassword')"
                autocomplete="off"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.name"
                class="form-input"
                style="flex: 0 0 160px"
                :placeholder="t('settings.proxyName')"
                @keyup.enter="addProxy"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newProxy.name || !newProxy.host || proxyTesting"
                @click="addProxy"
              >
                <i class="fa-solid fa-plus"></i>
                {{
                  proxyTesting
                    ? t("settings.proxyTesting")
                    : t("settings.addProxy")
                }}
              </button>
            </div>
          </div>
          <p v-if="proxyAddShown" style="font-size: 11px; color: #888; margin: 4px 0 0">
            {{ t("settings.proxyUrlHint") }}
          </p>

          <!-- Import from a proxy provider -->
          <div class="proxy-fold">
            <button class="btn btn-ghost btn-sm" @click="proxyProvidersOpen = !proxyProvidersOpen">
              <i
                :class="
                  proxyProvidersOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'
                "
              ></i>
              {{ t("settings.providersSection") }}
              <span v-if="providers.length" style="color: #888; font-weight: 400"
                >({{ providers.length }})</span
              >
            </button>
          </div>
          <div v-if="proxyProvidersOpen" class="proxy-edit-panel" style="margin-top: 4px">
            <p style="font-size: 11px; color: #888; margin: 0 0 8px">
              {{ t("settings.providersHint") }}
            </p>

            <div
              v-for="(prov, i) in providers"
              :key="prov.id"
              style="border-top: 1px solid #eee; padding-top: 8px; margin-top: 8px"
            >
              <div class="proxy-row">
                <input
                  v-model.trim="prov.name"
                  class="form-input"
                  style="flex: 0 0 140px"
                  :placeholder="t('settings.providerName')"
                />
                <select v-model="prov.type" class="form-input" style="flex: 0 0 130px">
                  <option value="webshare">Webshare</option>
                  <option value="list">{{ t("settings.providerTypeList") }}</option>
                  <option value="subscription">{{ t("settings.providerTypeSubscription") }}</option>
                </select>
                <label class="form-checkbox-label" style="flex: 0 0 auto">
                  <input type="checkbox" v-model="prov.enabled" />
                  {{ t("settings.providerEnabled") }}
                </label>
                <button
                  class="btn btn-ghost btn-sm btn-icon"
                  :disabled="providersSyncing"
                  :title="t('settings.providerSyncOne')"
                  @click="syncProviders(prov.id)"
                >
                  <i class="fa-solid fa-rotate"></i>
                </button>
                <button
                  class="btn btn-danger btn-sm btn-icon"
                  :title="t('settings.providerDelete')"
                  @click="providers.splice(i, 1)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
              <div class="proxy-row" style="margin-top: 6px">
                <input
                  v-if="prov.type === 'list' || prov.type === 'subscription'"
                  v-model.trim="prov.url"
                  class="form-input"
                  :placeholder="
                    prov.type === 'subscription'
                      ? t('settings.providerSubUrlPlaceholder')
                      : t('settings.providerUrlPlaceholder')
                  "
                />
                <select
                  v-if="prov.type === 'list'"
                  v-model="prov.scheme"
                  class="form-input"
                  style="flex: 0 0 110px"
                >
                  <option value="http">http</option>
                  <option value="socks5">socks5</option>
                </select>
                <input
                  v-model.trim="prov.apiKey"
                  class="form-input"
                  type="password"
                  autocomplete="off"
                  :placeholder="
                    prov.hasKey
                      ? t('settings.providerKeyStored')
                      : prov.type === 'webshare'
                        ? t('settings.providerKeyPlaceholder')
                        : t('settings.providerKeyOptional')
                  "
                />
              </div>
            </div>

            <div class="proxy-row" style="margin-top: 10px">
              <button class="btn btn-ghost btn-sm" @click="addProvider">
                <i class="fa-solid fa-plus"></i> {{ t("settings.providerAdd") }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="providersSaving || !providers.length"
                @click="saveProviders"
              >
                <i class="fa-solid fa-floppy-disk"></i>
                {{ providersSaving ? t("common.saving") : t("settings.providerSave") }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="providersSyncing || !providers.length"
                @click="syncProviders()"
              >
                <i class="fa-solid fa-rotate"></i>
                {{ providersSyncing ? t("settings.providerSyncing") : t("settings.providerSyncAll") }}
              </button>
            </div>

            <!-- What a refresh does with an entry the provider re-issues under a new
                 identity: keep the id a job is pinned to, or treat it as a new proxy -->
            <div class="form-group" style="margin-top: 10px">
              <label class="form-check">
                <input
                  type="checkbox"
                  v-model="proxySyncMatchByName"
                  @change="saveProxySyncMatchByName"
                />
                <span>{{ t("settings.proxySyncMatchByName") }}</span>
              </label>
              <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
                {{ t("settings.proxySyncMatchByNameHint") }}
              </p>
            </div>

            <div v-if="providersMsg" class="success-msg" style="margin-top: 8px">{{ providersMsg }}</div>
            <div v-if="providersErrorMsg" class="error-msg" style="margin-top: 8px">{{ providersErrorMsg }}</div>
          </div>

          <!-- What a test asks of an exit, and how often it is asked on its own -->
          <div class="proxy-fold">
            <button class="btn btn-ghost btn-sm" @click="proxyHealthOpen = !proxyHealthOpen">
              <i
                :class="proxyHealthOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"
              ></i>
              {{ t("settings.proxyHealthSection") }}
            </button>
          </div>
          <div v-if="proxyHealthOpen" class="proxy-edit-panel" style="margin-top: 4px">
            <p style="font-size: 12px; color: #888; margin: 0 0 6px">
              {{ t("settings.proxyHealthHint") }}
            </p>
            <label class="form-checkbox-label" style="margin-bottom: 4px">
              <input type="checkbox" v-model="proxyTestCf" />
              <span>{{ t("settings.proxyTestCf") }}</span>
            </label>
            <p style="font-size: 11px; color: #888; margin: 0 0 8px 24px">
              {{ t("settings.proxyTestCfHint") }}
            </p>
            <div class="proxy-row">
              <input
                v-model.trim="proxyTestExtraUrl"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyTestExtraPlaceholder')"
              />
            </div>
            <p style="font-size: 11px; color: #888; margin: 4px 0 8px">
              {{ t("settings.proxyTestExtraHint") }}
            </p>
            <div class="proxy-row">
              <span style="font-size: 12px; color: #555">{{ t("settings.proxyTestInterval") }}</span>
              <input
                v-model.number="proxyTestIntervalHours"
                class="form-input"
                style="flex: 0 0 90px"
                type="number"
                min="0"
                max="168"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="proxyHealthSaving"
                @click="saveProxyHealth"
              >
                {{ proxyHealthSaving ? t("common.saving") : t("common.save") }}
              </button>
            </div>
            <p style="font-size: 11px; color: #888; margin: 4px 0 8px">
              {{ t("settings.proxyTestIntervalHint") }}
            </p>
            <label class="form-checkbox-label" style="margin-bottom: 4px">
              <input type="checkbox" v-model="proxyCheckBeforeUse" />
              <span>{{ t("settings.proxyCheckBeforeUse") }}</span>
            </label>
            <p style="font-size: 11px; color: #888; margin: 0 0 0 24px">
              {{ t("settings.proxyCheckBeforeUseHint") }}
            </p>
          </div>

          <div class="proxy-row" style="margin-top: 14px">
            <button
              class="btn btn-primary"
              :disabled="proxiesSaving"
              @click="saveProxies"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ proxiesSaving ? t("common.saving") : t("settings.saveBtn") }}
            </button>
            <button
              class="btn btn-secondary"
              :disabled="proxiesTestingAll || !proxies.length"
              @click="testAllProxies"
            >
              <i class="fa-solid fa-plug-circle-check"></i>
              {{
                proxiesTestingAll
                  ? t("settings.proxyTestingAll")
                  : t("settings.proxyTestAll")
              }}
            </button>
          </div>
        </div>
      </div>

      <!-- TG App Clients -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.appClientsSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 6px">
            {{ t("settings.appClientsHint") }}
          </p>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.appClientDeviceVars") }}
          </p>

          <div v-if="appClientsMsg" class="success-msg">
            {{ appClientsMsg }}
          </div>
          <div v-if="appClientsError" class="error-msg">
            {{ appClientsError }}
          </div>

          <div class="tg-client-mode-row">
            <span class="form-label" style="margin: 0">{{
              t("settings.tgClientModeLabel")
            }}</span>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="default" />
              {{ t("settings.tgClientModeDefault") }}
            </label>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="random" />
              {{ t("settings.tgClientModeRandom") }}
            </label>
          </div>

          <div v-for="(c, i) in appClients" :key="c.id">
            <div v-if="editingClientId === c.id" class="proxy-edit-panel">
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.name"
                  class="form-input"
                  style="flex: 0 0 110px"
                  :placeholder="t('settings.appClientName')"
                />
                <input
                  v-model.trim="editClientForm.deviceModel"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientDevice')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.systemVersion"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientSystem')"
                />
                <input
                  v-model.trim="editClientForm.appVersion"
                  class="form-input"
                  style="flex: 0 0 120px"
                  :placeholder="t('settings.appClientApp')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.langCode"
                  class="form-input"
                  style="flex: 0 0 80px"
                  :placeholder="t('settings.appClientLangCode')"
                />
                <input
                  v-model.trim="editClientForm.langPack"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientLangPack')"
                />
                <input
                  v-model.trim="editClientForm.systemLangCode"
                  class="form-input"
                  style="flex: 0 0 100px"
                  :placeholder="t('settings.appClientSysLang')"
                />
              </div>
              <div class="proxy-row">
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="
                    !editClientForm.name || !editClientForm.deviceModel
                  "
                  @click="saveClientEdit(i)"
                >
                  {{ t("common.save") }}
                </button>
                <button
                  class="btn btn-sm btn-ghost"
                  @click="editingClientId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <div v-else class="ua-preset-row">
              <span class="ua-preset-name">{{ c.name }}</span>
              <span class="ua-preset-value"
                >{{ c.deviceModel }} / {{ c.systemVersion }}</span
              >
              <template v-if="tgClientMode !== 'random'">
                <span
                  v-if="c.isDefault"
                  class="badge badge-green"
                  style="font-size: 11px; padding: 1px 6px"
                  >{{ t("settings.appClientIsDefault") }}</span
                >
                <button
                  v-else
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('settings.appClientSetDefault')"
                  @click="setDefaultClient(i)"
                >
                  <i class="fa-regular fa-star"></i>
                </button>
              </template>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="startEditClient(c)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.appClientDeleteTip')"
                :disabled="tgClientMode !== 'random' && c.isDefault"
                @click="removeClient(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          <!-- Add new client form -->
          <div class="proxy-edit-panel" style="margin-top: 8px">
            <div class="proxy-row">
              <input
                v-model.trim="newClient.name"
                class="form-input"
                style="flex: 0 0 110px"
                :placeholder="t('settings.appClientName')"
              />
              <input
                v-model.trim="newClient.deviceModel"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientDevice')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.systemVersion"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientSystem')"
              />
              <input
                v-model.trim="newClient.appVersion"
                class="form-input"
                style="flex: 0 0 120px"
                :placeholder="t('settings.appClientApp')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.langCode"
                class="form-input"
                style="flex: 0 0 80px"
                :placeholder="t('settings.appClientLangCode')"
              />
              <input
                v-model.trim="newClient.langPack"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientLangPack')"
              />
              <input
                v-model.trim="newClient.systemLangCode"
                class="form-input"
                style="flex: 0 0 100px"
                :placeholder="t('settings.appClientSysLang')"
              />
            </div>
            <div class="proxy-row">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newClient.name || !newClient.deviceModel"
                @click="addClient"
              >
                <i class="fa-solid fa-plus"></i>
                {{ t("settings.addAppClient") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            style="margin-top: 14px"
            :disabled="appClientsSaving"
            @click="saveAppClients"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ appClientsSaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Emby defaults -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.embyDefaults") }}</div>

          <div v-if="embyMsg" class="success-msg">{{ embyMsg }}</div>
          <div v-if="embyError" class="error-msg">{{ embyError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelPlayDuration")
              }}</label>
              <input
                v-model.number="form.default_play_duration"
                class="form-input"
                type="number"
                min="30"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDeviceName")
              }}</label>
              <input
                v-model.trim="form.default_device_name"
                class="form-input"
                placeholder="Mac"
              />
              <p style="font-size: 12px; color: #888; margin: 4px 0 0">
                {{ t("settings.deviceNameVars") }}
              </p>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.labelUserAgent") }}</label>
            <select v-model="form.default_ua" class="form-select">
              <option value="">— {{ t("jobs.uaDefault") }} —</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.value">
                {{ p.name }}
              </option>
            </select>
          </div>

          <div style="margin-bottom: 16px">
            <div class="card-section-title" style="margin-bottom: 10px">
              {{ t("settings.uaPresetsSection") }}
            </div>
            <div v-for="(p, i) in uaPresets" :key="i" class="ua-preset-row">
              <span class="ua-preset-name">{{ p.name }}</span>
              <span class="ua-preset-value">{{ p.value }}</span>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.uaPresetDeleteTip')"
                @click="removeUaPreset(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div class="ua-preset-add">
              <input
                v-model.trim="newPresetName"
                class="form-input"
                style="flex: 0 0 140px"
                :placeholder="t('settings.uaPresetName')"
                @keyup.enter="addUaPreset"
              />
              <input
                v-model.trim="newPresetValue"
                class="form-input"
                style="flex: 1; min-width: 0"
                :placeholder="t('settings.uaPresetValue')"
                @keyup.enter="addUaPreset"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newPresetName || !newPresetValue"
                @click="addUaPreset"
              >
                <i class="fa-solid fa-plus"></i> {{ t("settings.addPreset") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="embySaving"
            @click="saveEmby"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ embySaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Import / Export -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.importExport.title") }}
          </div>

          <div v-if="importMsg" class="success-msg">{{ importMsg }}</div>
          <div v-if="importError" class="error-msg">{{ importError }}</div>

          <div class="form-group">
            <p style="font-size: 12px; color: #888; margin: 0 0 8px">
              {{ t("settings.importExport.exportHint") }}
            </p>
            <label class="form-label">{{
              t("settings.importExport.exportSecretLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                v-model="exportSecret"
                :type="showExportSecret ? 'text' : 'password'"
                class="form-input"
                :placeholder="
                  t('settings.importExport.exportSecretPlaceholder')
                "
                autocomplete="new-password"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showExportSecret = !showExportSecret"
              >
                <i
                  :class="
                    showExportSecret
                      ? 'fa-solid fa-eye-slash'
                      : 'fa-solid fa-eye'
                  "
                ></i>
              </button>
            </div>
            <p style="font-size: 11px; color: #888; margin: 4px 0 8px">
              {{ t("settings.importExport.exportSecretHint") }}
            </p>
            <button class="btn btn-secondary" @click="doExport">
              <i class="fa-solid fa-file-export"></i>
              {{ t("settings.importExport.exportBtn") }}
            </button>
          </div>

          <hr class="ie-divider" />

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importLabel")
            }}</label>
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              class="form-input"
              @change="onFileChange"
            />
          </div>

          <div v-if="importFileEncrypted" class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importSecretLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                v-model="importSecret"
                :type="showImportSecret ? 'text' : 'password'"
                class="form-input"
                :placeholder="
                  t('settings.importExport.importSecretPlaceholder')
                "
                autocomplete="current-password"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showImportSecret = !showImportSecret"
              >
                <i
                  :class="
                    showImportSecret
                      ? 'fa-solid fa-eye-slash'
                      : 'fa-solid fa-eye'
                  "
                ></i>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input type="checkbox" v-model="importForceReauth" />
              <span>{{ t("settings.importExport.forceReauthLabel") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.importExport.forceReauthHint") }}
            </p>
            <div
              v-if="!importForceReauth"
              class="supplier-no-key-warning"
              style="margin-top: 8px"
            >
              {{ t("settings.importExport.forceReauthRisk") }}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importMode")
            }}</label>
            <div class="import-mode-row">
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="merge" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeMerge") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeMergeHint") }}
                  </div>
                </div>
              </label>
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="replace" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeReplace") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeReplaceHint") }}
                  </div>
                </div>
              </label>
            </div>
          </div>

          <div v-if="importMode === 'replace'" class="form-group">
            <label class="form-label">{{
              t("settings.importExport.confirmPasswordLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                :type="showImportConfirmPassword ? 'text' : 'password'"
                class="form-control"
                v-model="importConfirmPassword"
                :placeholder="t('settings.importExport.confirmPasswordPlaceholder')"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showImportConfirmPassword = !showImportConfirmPassword"
              >
                <i :class="showImportConfirmPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'"></i>
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="importing"
            @click="doImport"
          >
            <i class="fa-solid fa-file-import"></i>
            {{
              importing
                ? t("settings.importExport.importing")
                : t("settings.importExport.importBtn")
            }}
          </button>
        </div>
      </div>

      <!-- AI settings -->
      <div class="card s-col-12">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.aiSection") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 16px">
            {{ t("settings.aiHint") }}
          </p>

          <!-- Fallback toggle -->
          <div class="form-group">
            <label class="form-check">
              <input v-model="form.ai_fallback_enabled" type="checkbox" @change="saveFallbackEnabled" />
              <span>{{ t("settings.aiFallbackLabel") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.aiFallbackHint") }}
            </p>
          </div>

          <!-- Providers list -->
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-bottom: 10px;
            "
          >
            <div class="card-section-title" style="margin: 0">
              {{ t("settings.aiProvidersSection") }}
            </div>
            <button
              class="btn btn-ghost btn-sm"
              @click="showAddSupplier = true"
            >
              <i class="fa-solid fa-plus"></i> {{ t("settings.addProvider") }}
            </button>
          </div>

          <div v-if="aiSuppliersLoading" style="color: #888; font-size: 13px">
            {{ t("common.loading") }}
          </div>
          <div
            v-else-if="!suppliers.length"
            style="color: #aaa; font-size: 13px; margin-bottom: 12px"
          >
            {{ t("settings.noSuppliers") }}
          </div>

          <div v-for="s in suppliers" :key="s.id" class="supplier-card">
            <!-- Supplier header -->
            <div v-if="editingSupplierId !== s.id" class="supplier-header">
              <div class="supplier-info">
                <span class="supplier-name">{{ s.name }}</span>
                <span class="supplier-url">{{ s.base_url }}</span>
                <span class="supplier-timeout">{{ s.timeout_ms }}ms</span>
              </div>
              <div class="supplier-actions">
                <button
                  class="btn btn-ghost btn-sm"
                  @click="startEditSupplier(s)"
                >
                  {{ t("settings.editSupplier") }}
                </button>
                <button
                  class="btn btn-ghost btn-sm btn-danger"
                  @click="removeSupplier(s.id)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
            <div
              v-if="editingSupplierId !== s.id && !s.api_key"
              class="supplier-no-key-warning"
            >
              <i class="fa-solid fa-triangle-exclamation"></i>
              {{ t("settings.supplierNoApiKey") }}
            </div>

            <!-- Supplier edit form -->
            <div v-if="editingSupplierId === s.id" class="supplier-edit-form">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierName")
                  }}</label>
                  <input v-model.trim="editForm.name" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierTimeout")
                  }}</label>
                  <input
                    v-model.number="editForm.timeout_ms"
                    class="form-input"
                    type="number"
                    min="1000"
                    step="1000"
                  />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierBaseUrl")
                }}</label>
                <input
                  v-model.trim="editForm.base_url"
                  class="form-input"
                  placeholder="https://openrouter.ai/api/v1"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierApiKey")
                }}</label>
                <input
                  v-model.trim="editForm.api_key"
                  class="form-input"
                  type="text"
                  autocomplete="off"
                  placeholder="sk-..."
                />
              </div>
              <div style="display: flex; gap: 8px">
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="supplierSaving"
                  @click="saveEditSupplier(s.id)"
                >
                  {{
                    supplierSaving
                      ? t("common.saving")
                      : t("settings.saveSupplier")
                  }}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  @click="editingSupplierId = null"
                >
                  {{ t("settings.cancelEdit") }}
                </button>
              </div>
            </div>

            <!-- Models -->
            <div class="supplier-models">
              <div class="supplier-models-label">
                {{ t("settings.supplierModels") }}
              </div>
              <div class="supplier-model-chips">
                <span v-for="m in s.models" :key="m.id" class="model-chip">
                  {{ m.model_id }}
                  <button
                    class="model-chip-del"
                    @click="removeModel(s.id, m.id)"
                  >
                    <i class="fa-solid fa-xmark"></i>
                  </button>
                </span>
                <span
                  v-if="!s.models.length"
                  style="color: #aaa; font-size: 12px"
                  >—</span
                >
              </div>
              <div class="model-add-row">
                <input
                  v-model.trim="newModelInputs[s.id]"
                  class="form-input form-input-sm"
                  :placeholder="t('settings.modelId')"
                  @keyup.enter="addModel(s.id)"
                />
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!newModelInputs[s.id]"
                  @click="addModel(s.id)"
                >
                  <i class="fa-solid fa-plus"></i> {{ t("settings.addModel") }}
                </button>
              </div>
            </div>
          </div>

          <!-- Add supplier form -->
          <div v-if="showAddSupplier" class="supplier-card supplier-edit-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierName")
                }}</label>
                <input
                  v-model.trim="newSupplierForm.name"
                  class="form-input"
                  placeholder="OpenRouter"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierTimeout")
                }}</label>
                <input
                  v-model.number="newSupplierForm.timeout_ms"
                  class="form-input"
                  type="number"
                  min="1000"
                  step="1000"
                />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierBaseUrl")
              }}</label>
              <input
                v-model.trim="newSupplierForm.base_url"
                class="form-input"
                placeholder="https://openrouter.ai/api/v1"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierApiKey")
              }}</label>
              <input
                v-model.trim="newSupplierForm.api_key"
                class="form-input"
                type="text"
                autocomplete="off"
                placeholder="sk-..."
              />
            </div>
            <div style="display: flex; gap: 8px">
              <button
                class="btn btn-primary btn-sm"
                :disabled="
                  supplierSaving ||
                  !newSupplierForm.name ||
                  !newSupplierForm.base_url
                "
                @click="createSupplier"
              >
                {{
                  supplierSaving
                    ? t("common.saving")
                    : t("settings.saveSupplier")
                }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                @click="showAddSupplier = false"
              >
                {{ t("settings.cancelEdit") }}
              </button>
            </div>
          </div>

          <div v-if="supplierError" class="error-msg" style="margin-top: 8px">
            {{ supplierError }}
          </div>

          <!-- Default model -->
          <div
            style="
              margin-top: 20px;
              padding-top: 16px;
              border-top: 1px solid #e5e7eb;
            "
          >
            <div class="form-group">
              <label class="form-label">{{ t("settings.defaultModel") }}</label>
              <select v-model="form.ai_default_model_id" class="form-select">
                <option value="">{{ t("settings.defaultModelNone") }}</option>
                <optgroup v-for="s in suppliers" :key="s.id" :label="s.name">
                  <option v-for="m in s.models" :key="m.id" :value="String(m.id)">
                    {{ m.model_id }}
                  </option>
                </optgroup>
              </select>
            </div>
            <div v-if="aiMsg" class="success-msg">{{ aiMsg }}</div>
            <div v-if="aiError" class="error-msg">{{ aiError }}</div>
            <button
              class="btn btn-primary"
              :disabled="aiSaving"
              @click="saveAi"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{
                aiSaving ? t("common.saving") : t("settings.saveDefaultModel")
              }}
            </button>
          </div>
        </div>
      </div>

      <!-- Memory -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.memorySection") }}</div>

          <div v-if="memoryLoading" style="color: #888; font-size: 13px">
            {{ t("common.loading") }}
          </div>
          <template v-else-if="memory">
            <!-- A previous kill is the thing worth surfacing: the process could not log it -->
            <div v-if="memory.lastBeforeCrash" class="error-msg">
              {{ crashText }}
              <div
                v-if="memory.lastBeforeCrash.runs.length"
                style="margin-top: 4px"
              >
                {{ t("settings.memoryCrashJobs") }}
                {{
                  memory.lastBeforeCrash.runs
                    .map((r) => `${r.jobName} (#${r.logId})`)
                    .join(", ")
                }}
              </div>
            </div>

            <div class="mem-rows">
              <div class="mem-row">
                <span>{{ t("settings.memoryCurrent") }}</span>
                <strong>{{ memory.current.rssMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryPeak") }}</span>
                <strong>{{ memory.peak?.rssMb ?? memory.current.rssMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryExternal") }}</span>
                <strong>{{ memory.current.externalMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryHeap") }}</span>
                <strong>{{ memory.current.heapUsedMb }} MB</strong>
              </div>
              <div v-if="memory.limitMb" class="mem-row">
                <span>{{ t("settings.memoryLimit") }}</span>
                <strong>{{ memory.limitMb }} MB ({{ memoryPercent }}%)</strong>
              </div>
            </div>
            <p style="font-size: 12px; color: #888; margin: 8px 0 0">
              {{ t("settings.memoryHint") }}
            </p>
          </template>
          <div v-else class="error-msg">{{ t("settings.memoryUnavailable") }}</div>

          <button
            class="btn btn-ghost btn-sm"
            style="margin-top: 10px"
            :disabled="memoryLoading"
            @click="loadMemory"
          >
            <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
          </button>
        </div>
      </div>

      <!-- Restarting the backend: the way out when the process itself is what is stuck -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.system.title") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 10px">
            {{ t("settings.system.hint") }}
          </p>
          <div v-if="!restartSupervised" class="error-msg" style="margin-bottom: 10px">
            {{ t("settings.system.unsupervised") }}
          </div>
          <div v-if="restartMsg" class="success-msg" style="margin-bottom: 10px">
            {{ restartMsg }}
          </div>
          <div v-if="restartError" class="error-msg" style="margin-bottom: 10px">
            {{ restartError }}
          </div>
          <button
            class="btn btn-danger btn-sm"
            :disabled="restarting"
            @click="askRestart(false)"
          >
            <i class="fa-solid fa-power-off"></i>
            {{ restarting ? t("settings.system.restarting") : t("settings.system.restartBtn") }}
            <template v-if="cfBrowsersRunning > 0"> ({{ cfBrowsersRunning }})</template>
          </button>
          <button
            class="btn btn-danger btn-sm"
            style="margin-left: 8px"
            :disabled="restarting"
            @click="askRestart(true)"
          >
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.system.forceRestartBtn") }}
          </button>
          <p style="font-size: 12px; color: #888; margin: 10px 0 0">
            {{ t("settings.system.forceRestartHint") }}
          </p>
        </div>
      </div>
    </div>

    <!-- It takes every run in flight down with it, so it is asked for rather than assumed -->
    <div v-if="confirmRestart" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">
          {{
            restartForce
              ? t("settings.system.forceRestartBtn")
              : t("settings.system.restartBtn")
          }}
        </h3>
        <div class="modal-body">
          <p>
            {{
              restartForce
                ? t("settings.system.forceRestartConfirm")
                : t("settings.system.restartConfirm")
            }}
          </p>
          <p v-if="!restartSupervised" class="error-msg">
            {{ t("settings.system.unsupervised") }}
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmRestart = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" @click="restartSystem">
            <i
              class="fa-solid"
              :class="restartForce ? 'fa-triangle-exclamation' : 'fa-power-off'"
            ></i>
            {{
              restartForce
                ? t("settings.system.forceRestartBtn")
                : t("settings.system.restartBtn")
            }}
          </button>
        </div>
      </div>
    </div>

    <!-- Removing every downloaded build: ~200MB each comes back only by downloading again -->
    <div v-if="confirmUninstallCf" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("settings.cfSolver.uninstallBtn") }}</h3>
        <div class="modal-body">
          <p>{{ t("settings.cfSolver.uninstallConfirm") }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmUninstallCf = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" @click="uninstallCfSolver">
            <i class="fa-solid fa-trash"></i> {{ t("settings.cfSolver.uninstallBtn") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Deleting profiles takes the sessions in them with it, so it is asked for by name -->
    <div v-if="confirmDeleteProfiles" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("settings.profiles.deleteBtn") }}</h3>
        <div class="modal-body">
          <p>
            {{ t("settings.profiles.deleteConfirm").replace("{n}", String(selectedProfiles.length)) }}
          </p>
          <p style="font-family: monospace; font-size: 12px; color: #666">
            {{ selectedProfiles.join(", ") }}
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDeleteProfiles = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" :disabled="profilesBusy" @click="deleteProfiles">
            <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import {
  settingsApi,
  authApi,
  dataApi,
  aiSuppliersApi,
  secretsApi,
  statusApi,
  type CfBrowserTest,
  type CfBrowserTestRun,
  type CfProfile,
} from "../api/client";
import type {
  MemoryReport,
  ExportPayload,
  EncryptedEnvelope,
  Settings,
  UAPreset,
  AiSupplier,
  Proxy,
  ProxyProvider,
  ProxyTestResult,
  TgAppClient,
  CfKeyView,
  CfKeyCheck,
  NotifyBotInfo,
  NotifyBotChat,
  SecretSummary,
} from "../api/client";
import { t } from "../i18n";
import { proxySupportsTelegram } from "../utils/proxy";
import { usePersistedRef } from "../composables/usePersistedRef";
import { setAccountDisplayWithTgName } from "../composables/accountDisplay";
import { setSchedulePageSeparate } from "../composables/schedulePage";
import {
  applyDataStoreSetting,
  dataStoreAvailable,
  dataStoreEnabled,
  setDataStoreEnabled,
} from "../composables/dataStore";
import { applyMsApiSetting, msApiAvailable } from "../composables/msApi";
import { setTemplateEditButton } from "../composables/templateEditButton";

const timezones = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Darwin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "UTC",
];

const form = reactive({
  default_timezone: "Australia/Sydney",
  default_max_retry: 5,
  check_daily_run: true,
  default_ua: "",
  default_play_duration: 300,
  default_device_name: "Mac",
  ai_model: "",
  ai_default_model_id: "",
  ai_fallback_enabled: true,
});
const saving = ref(false);
const saveMsg = ref("");
const saveError = ref("");

const embySaving = ref(false);
const embyMsg = ref("");
const embyError = ref("");

const aiSaving = ref(false);
const aiMsg = ref("");
const aiError = ref("");

const suppliers = ref<AiSupplier[]>([]);
const aiSuppliersLoading = ref(false);
const editingSupplierId = ref<number | null>(null);
const editForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const newSupplierForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const showAddSupplier = ref(false);
const supplierSaving = ref(false);
const supplierError = ref("");
const newModelInputs = ref<Record<number, string>>({});

const notifyForm = reactive({
  botToken: "",
  botTarget: "",
  username: "",
  events: ["failed"] as string[],
});
const notifySaving = ref(false);
const notifyMsg = ref("");
const notifyError = ref("");
const notifyTesting = ref(false);
// The stored token is never sent back in full; the mask stands in as the placeholder, and
// leaving the field blank keeps whatever is stored.
const notifyBotTokenMasked = ref("");
const notifyBot = ref<NotifyBotInfo>({ configured: false });
const notifyChats = ref<NotifyBotChat[]>([]);
const notifyChatsLoading = ref(false);
const notifyChatsHint = ref("");
const notifyLegacyOpen = ref(false);

// msOauth2api: the address pool a login-email run or a signup step draws from. The key is
// write-only here too, so the mask stands in as the placeholder and a blank field keeps it.
const msApiForm = reactive({ baseUrl: "", apiKey: "", poolType: "" });
const msApiKeyMasked = ref("");
const msApiConfigured = ref(false);
const msApiPoolTypeDefault = ref("Telegram");
const msApiSaving = ref(false);
const msApiTesting = ref(false);
const msApiMsg = ref("");
const msApiError = ref("");
const msApiPool = ref("");

// Cloudflare "I am not a bot" solver: an optional headless browser installed on
// demand into the data dir (keeps the image small).
const cfChromiumInstalled = ref(false);
const cfChromiumVersion = ref("");
// Which build is on disk ("keyed" or "free"), and whether a stored licence key unlocks one
// that has not been downloaded yet -- downloads are deliberate, never automatic.
const cfChromiumTier = ref("");
const cfChromiumPath = ref("");
const cfKeyedPending = ref(false);
// Whether the unlicensed build is on disk as well: it is what a launch with no licence
// seat falls back to, and the keyed build cannot start without one.
const cfFreeInstalled = ref(false);
const cfFontsInstalled = ref(false);
const cfFontsMissing = ref("");
// The fonts live in the data dir, not the image, so a browser installed by an older
// version can be complete while they are still missing. Both have to be there before
// the solver is fully set up.
const cfSolverComplete = computed(
  () => cfChromiumInstalled.value && cfFontsInstalled.value && !cfKeyedPending.value,
);
// The one install button fetches whatever is missing, and the server skips a browser that
// is already there. Saying "install browser" when only the fonts are outstanding leaves no
// button that looks like it installs fonts, so the label follows what will actually download.
const cfInstallLabelKey = computed(() => {
  if (cfKeyedPending.value) return "settings.cfSolver.installKeyedBtn";
  if (cfChromiumInstalled.value && !cfFontsInstalled.value)
    return "settings.cfSolver.installFontsBtn";
  return "settings.cfSolver.installBtn";
});
const cfInstalling = ref(false);
const cfInstallMsg = ref("");
const cfInstallError = ref("");
const cfTesting = ref(false);
const cfTestReport = ref("");
const cfTestWarnings = ref<string[]>([]);
const cfTestNotes = ref<string[]>([]);

// CloakBrowser licence keys. The server only ever sends them masked; a masked value sent
// back unchanged means "keep the stored key", so a label can be edited without pasting the
// key again.
const cfKeysOpen = ref(false);
const cfKeys = ref<Array<{ label: string; key: string }>>([]);
const cfKeysInUse = ref(0);
const cfKeysSaving = ref(false);
const cfKeysChecking = ref(false);
const cfKeysMsg = ref("");
const cfKeysError = ref("");
const cfKeyChecks = ref<Record<string, CfKeyCheck>>({});

function loadCfKeys(s: Settings) {
  try {
    const parsed = JSON.parse(s.cf_cloak_keys_masked ?? "[]") as CfKeyView[];
    cfKeys.value = parsed.map((k) => ({ label: k.label, key: k.masked }));
  } catch {
    cfKeys.value = [];
  }
  cfKeysInUse.value = Number(s.cf_cloak_keys_in_use ?? 0) || 0;
}

async function saveCfKeys() {
  cfKeysSaving.value = true;
  cfKeysMsg.value = "";
  cfKeysError.value = "";
  try {
    const res = await settingsApi.saveCfKeys(cfKeys.value.filter((k) => k.key.trim()));
    cfKeys.value = res.keys.map((k) => ({ label: k.label, key: k.masked }));
    cfKeysInUse.value = res.inUse;
    cfKeyChecks.value = {};
    // Adding the first key means the build it unlocks is now outstanding, so the install
    // panel above has to start offering it
    await refreshCfBuildState();
    cfKeysMsg.value = t("settings.saved");
  } catch (e: any) {
    cfKeysError.value = e?.response?.data?.error ?? e?.message ?? t("settings.cfKeys.saveFailed");
  } finally {
    cfKeysSaving.value = false;
  }
}

/** Re-reads which build is installed and whether a key has one outstanding. */
async function refreshCfBuildState() {
  try {
    const fresh = await settingsApi.get();
    cfChromiumTier.value = fresh.cf_chromium_tier ?? "";
    cfChromiumPath.value = fresh.cf_chromium_path ?? "";
    cfKeyedPending.value = fresh.cf_chromium_keyed_pending === "true";
    cfFreeInstalled.value = fresh.cf_chromium_free_installed === "true";
    cfBrowsersRunning.value = Number(fresh.cf_browsers_running ?? 0);
    cfBuilds.value = parseCfBuilds(fresh.cf_chromium_builds);
    cfProfileCount.value = Number(fresh.cf_profile_count ?? 0);
    cfChromiumVersion.value = fresh.cf_chromium_version ?? "";
  } catch {
    /* the panel keeps what it has */
  }
}

async function checkCfKeys() {
  cfKeysChecking.value = true;
  cfKeysMsg.value = "";
  cfKeysError.value = "";
  try {
    const results = await settingsApi.checkCfKeys();
    cfKeyChecks.value = Object.fromEntries(results.map((r) => [r.label, r]));
  } catch (e: any) {
    cfKeysError.value = e?.response?.data?.error ?? e?.message ?? t("settings.cfKeys.checkFailed");
  } finally {
    cfKeysChecking.value = false;
  }
}

// Browser timings. The server sends the values in force, the shipped defaults and the
// range each is held to, so this form needs no copy of any of them.
type CfLimit = { min: number; max: number };
const cfTuningOpen = ref(false);
const cfTuningSaving = ref(false);
const cfTuningMsg = ref("");
const cfTuningError = ref("");
const cfTuningForm = ref<Record<string, number>>({});
const cfTuningDefaults = ref<Record<string, number>>({});
const cfTuningLimits = ref<Record<string, CfLimit>>({});
const cfTuningFields = computed(() => Object.keys(cfTuningDefaults.value));

function loadCfTuning(s: Settings) {
  const parse = <T,>(raw: string | undefined, fallback: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  cfTuningDefaults.value = parse(s.cf_tuning_defaults, {} as Record<string, number>);
  cfTuningLimits.value = parse(s.cf_tuning_limits, {} as Record<string, CfLimit>);
  cfTuningForm.value = { ...cfTuningDefaults.value, ...parse(s.cf_tuning, {} as Record<string, number>) };
}

async function saveCfTuning() {
  cfTuningMsg.value = "";
  cfTuningError.value = "";
  cfTuningSaving.value = true;
  try {
    // The server clamps and stores what it will actually use, then hands it back
    const saved = await settingsApi.update({ cf_tuning: JSON.stringify(cfTuningForm.value) });
    loadCfTuning(saved);
    cfTuningMsg.value = t("settings.cfTuning.saved");
  } catch (e: any) {
    cfTuningError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    cfTuningSaving.value = false;
  }
}

function resetCfTuning() {
  cfTuningForm.value = { ...cfTuningDefaults.value };
  cfTuningMsg.value = t("settings.cfTuning.resetHint");
}

/**
 * Locales offered for the browser. Not a full list: these are the languages Mini Apps in
 * this space actually render in, and a name a step can be written against.
 */
const CF_LOCALES = [
  { id: "zh-CN", name: "简体中文" },
  { id: "zh-TW", name: "繁體中文" },
  { id: "en-US", name: "English (US)" },
  { id: "en-GB", name: "English (UK)" },
  { id: "en-AU", name: "English (AU)" },
  { id: "ru-RU", name: "Русский" },
  { id: "ja-JP", name: "日本語" },
  { id: "ko-KR", name: "한국어" },
  { id: "vi-VN", name: "Tiếng Việt" },
  { id: "th-TH", name: "ไทย" },
  { id: "id-ID", name: "Bahasa Indonesia" },
  { id: "pt-BR", name: "Português (BR)" },
  { id: "es-ES", name: "Español" },
  { id: "de-DE", name: "Deutsch" },
  { id: "fr-FR", name: "Français" },
  { id: "tr-TR", name: "Türkçe" },
];

const cfBrowserLang = ref("");
const cfProfileId = ref("");

// x11vnc, for the browser someone drives by hand
const vncInstalled = ref(false);
const vncSource = ref("");
const vncVersion = ref("");
const vncInstalling = ref(false);
const vncLog = ref("");
const vncFromDataDir = computed(() => vncSource.value === "data-dir");
const vncSourceText = computed(() =>
  t(vncSource.value === "data-dir" ? "settings.cfSolver.vncFromData" : "settings.cfSolver.vncFromImage"),
);

async function installVnc() {
  vncInstalling.value = true;
  vncLog.value = "";
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  try {
    const r = await settingsApi.installVnc();
    vncLog.value = (r.log ?? []).join("\n");
    if (r.ok) cfInstallMsg.value = t("settings.saved");
    else cfInstallError.value = r.error ?? t("settings.saveFailed");
  } catch (e: any) {
    const data = e?.response?.data;
    vncLog.value = (data?.log ?? []).join("\n");
    cfInstallError.value = data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    vncInstalling.value = false;
    await refreshVnc();
  }
}

async function removeVnc() {
  vncInstalling.value = true;
  try {
    await settingsApi.removeVnc();
  } finally {
    vncInstalling.value = false;
    await refreshVnc();
  }
}

async function refreshVnc() {
  try {
    const s = await settingsApi.get();
    vncInstalled.value = s.vnc_installed === "true";
    vncSource.value = s.vnc_source ?? "";
    vncVersion.value = s.vnc_version ?? "";
  } catch {
    /* the panel shows the last known state */
  }
}

/** Saved as it is chosen: one select is not worth its own save button. */
async function saveCfBrowserLang() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  try {
    await settingsApi.update({ cf_browser_lang: cfBrowserLang.value });
    cfInstallMsg.value = t("settings.saved");
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  }
}

/** Saved as it is typed out of, the same way the locale above is. */
async function saveCfProfileId() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  try {
    await settingsApi.update({ cf_profile_id: cfProfileId.value });
    cfInstallMsg.value = t("settings.saved");
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  }
}

const cfUninstalling = ref(false);
const cfStopping = ref(false);
const cfClearingProfiles = ref(false);
let cfTestPollTimer: ReturnType<typeof setTimeout> | null = null;
const cfProfileCount = ref(0);
const cfBrowsersRunning = ref(0);
type CfBuild = { tier: "keyed" | "free"; version: string; path: string; preferred: boolean };
const cfBuilds = ref<CfBuild[]>([]);

/** The installed-build list arrives as JSON; a malformed or absent one just means none. */
function parseCfBuilds(raw?: string): CfBuild[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? (parsed as CfBuild[]) : [];
  } catch {
    return [];
  }
}
const confirmUninstallCf = ref(false);

/** Closes every open browser. Whatever job was using one fails, which is the point. */
async function stopCfBrowsers() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfStopping.value = true;
  try {
    const res = await settingsApi.stopCfBrowsers();
    cfInstallMsg.value = t("settings.cfSolver.stopped").replace("{n}", String(res.stopped));
    await refreshCfBuildState();
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.stopFailed");
  } finally {
    cfStopping.value = false;
  }
}

/**
 * Deletes the per-exit profiles. Cookies and cache go; the browser identity does not, since
 * the fingerprint comes from the exit rather than the profile.
 */
/**
 * Forgets where every exit comes out, so the next launch of each looks it up again. For the
 * case a remembered location has gone stale: the host has moved country and the browser is
 * still presenting the old one's clock and language.
 */
const cfClearingGeo = ref(false);
async function clearCfExitGeo() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfClearingGeo.value = true;
  try {
    const res = await settingsApi.clearCfExitGeo();
    cfInstallMsg.value = t("settings.cfSolver.geoCleared").replace(
      "{n}",
      String(res.cleared ?? 0),
    );
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.error ?? e?.message ?? t("common.saveFailed");
  } finally {
    cfClearingGeo.value = false;
  }
}

async function clearCfProfiles() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfClearingProfiles.value = true;
  try {
    const res = await settingsApi.clearCfProfiles();
    if (res.ok) {
      cfInstallMsg.value = t("settings.cfSolver.profilesCleared").replace(
        "{n}",
        String(res.removed ?? 0),
      );
      await refreshCfBuildState();
      await loadCfProfiles();
    } else {
      cfInstallError.value = res.message ?? t("settings.cfSolver.clearProfilesFailed");
    }
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.clearProfilesFailed");
  } finally {
    cfClearingProfiles.value = false;
  }
}

// ── Browser profiles ─────────────────────────────────────────────────────────
// One profile is one browser identity's worth of state: cookies, cf_clearance, whatever it
// is signed in to. Clearing them all is above; this is for keeping, moving and dropping them
// one at a time.

const cfProfiles = ref<CfProfile[]>([]);
// Folded by default: the list runs to a screenful, and the header's count and total size
// are all there is to see on the way past
const cfProfilesOpen = ref(false);
const cfProfilesLoading = ref(false);
/** The profile whose name is being edited in place, and what it is being changed to. */
const renamingProfile = ref("");
const renameValue = ref("");
const selectedProfiles = ref<string[]>([]);
const newProfileName = ref("");
const importReplaceProfiles = ref(false);
const profileImportInput = ref<HTMLInputElement | null>(null);
const profilesBusy = ref(false);
const profilesMsg = ref("");
const profilesError = ref("");
const confirmDeleteProfiles = ref(false);

const cfProfilesTotalBytes = computed(() =>
  cfProfiles.value.reduce((sum, p) => sum + p.sizeBytes, 0),
);
const allProfilesSelected = computed(
  () => cfProfiles.value.length > 0 && selectedProfiles.value.length === cfProfiles.value.length,
);

function toggleAllProfiles() {
  selectedProfiles.value = allProfilesSelected.value ? [] : cfProfiles.value.map((p) => p.name);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatWhen(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return t("settings.profiles.justNow");
  if (mins < 60) return t("settings.profiles.minsAgo").replace("{n}", String(mins));
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("settings.profiles.hoursAgo").replace("{n}", String(hours));
  return t("settings.profiles.daysAgo").replace("{n}", String(Math.round(hours / 24)));
}

/** Keeps the selection to profiles that still exist, so a stale name is never acted on. */
function setProfiles(list: CfProfile[]) {
  cfProfiles.value = list;
  const names = new Set(list.map((p) => p.name));
  selectedProfiles.value = selectedProfiles.value.filter((n) => names.has(n));
  cfProfileCount.value = list.length;
}

async function loadCfProfiles() {
  cfProfilesLoading.value = true;
  try {
    setProfiles(await settingsApi.cfProfiles());
  } catch (e: any) {
    profilesError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    cfProfilesLoading.value = false;
  }
}

async function addProfile() {
  profilesMsg.value = "";
  profilesError.value = "";
  profilesBusy.value = true;
  try {
    const res = await settingsApi.createCfProfile(newProfileName.value);
    if (res.profiles) setProfiles(res.profiles);
    profilesMsg.value = t("settings.profiles.added").replace("{name}", newProfileName.value);
    newProfileName.value = "";
  } catch (e: any) {
    profilesError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    profilesBusy.value = false;
  }
}

/**
 * Renaming in place. The name is what a job's profile field resolves to, so moving a profile
 * from `direct-104` to `direct-105` is how the session one job built up is handed to another.
 * The browser keeps its cookies and its device across the move; only the name changes.
 */
function startRename(name: string) {
  profilesMsg.value = "";
  profilesError.value = "";
  renamingProfile.value = name;
  renameValue.value = name;
}

async function saveRename() {
  const from = renamingProfile.value;
  const to = renameValue.value;
  if (!from || !to || to === from) {
    renamingProfile.value = "";
    return;
  }
  profilesMsg.value = "";
  profilesError.value = "";
  profilesBusy.value = true;
  try {
    const res = await settingsApi.renameCfProfile(from, to);
    if (res.profiles) setProfiles(res.profiles);
    profilesMsg.value = t("settings.profiles.renamed")
      .replace("{from}", from)
      .replace("{to}", to);
    renamingProfile.value = "";
  } catch (e: any) {
    profilesError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    profilesBusy.value = false;
  }
}

async function deleteProfiles() {
  confirmDeleteProfiles.value = false;
  profilesMsg.value = "";
  profilesError.value = "";
  profilesBusy.value = true;
  try {
    const res = await settingsApi.deleteCfProfiles(selectedProfiles.value);
    if (res.profiles) setProfiles(res.profiles);
    if (res.removed.length)
      profilesMsg.value = t("settings.profiles.deleted").replace("{n}", String(res.removed.length));
    if (res.refused.length)
      profilesError.value = res.refused.map((r) => `${r.name}: ${r.reason}`).join("; ");
  } catch (e: any) {
    profilesError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    profilesBusy.value = false;
  }
}

async function exportProfiles() {
  profilesMsg.value = "";
  profilesError.value = "";
  profilesBusy.value = true;
  try {
    const blob = await settingsApi.exportCfProfiles(selectedProfiles.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    a.download =
      selectedProfiles.value.length === 1
        ? `bemby-profile-${selectedProfiles.value[0]}-${date}.tar.gz`
        : `bemby-profiles-${date}.tar.gz`;
    a.click();
    URL.revokeObjectURL(url);
    profilesMsg.value = t("settings.profiles.exported").replace(
      "{n}",
      String(selectedProfiles.value.length),
    );
  } catch (e: any) {
    profilesError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    profilesBusy.value = false;
  }
}

async function onProfileFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Cleared straight away so picking the same file again still fires a change event
  input.value = "";
  if (!file) return;
  profilesMsg.value = "";
  profilesError.value = "";
  profilesBusy.value = true;
  try {
    const res = await settingsApi.importCfProfiles(file, importReplaceProfiles.value);
    if (res.profiles) setProfiles(res.profiles);
    if (res.imported.length)
      profilesMsg.value = t("settings.profiles.imported")
        .replace("{n}", String(res.imported.length))
        .replace("{names}", res.imported.join(", "));
    if (res.skipped?.length)
      profilesError.value = res.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ");
  } catch (e: any) {
    const data = e?.response?.data;
    profilesError.value =
      data?.error ??
      data?.skipped?.map((s: { name: string; reason: string }) => `${s.name}: ${s.reason}`).join("; ") ??
      e?.message ??
      t("settings.profiles.importFailed");
  } finally {
    profilesBusy.value = false;
  }
}

/** Deletes every downloaded build. The solver has nothing to launch until one is back. */
async function uninstallCfSolver() {
  confirmUninstallCf.value = false;
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfUninstalling.value = true;
  try {
    const res = await settingsApi.uninstallCfSolver();
    if (res.ok) {
      cfChromiumInstalled.value = false;
      cfChromiumVersion.value = "";
      cfChromiumTier.value = "";
      cfChromiumPath.value = "";
      cfFreeInstalled.value = false;
      cfBuilds.value = [];
      cfTestReport.value = "";
      cfTestWarnings.value = [];
      cfTestNotes.value = [];
      await refreshCfBuildState();
      cfInstallMsg.value = res.removed?.length
        ? `${t("settings.cfSolver.uninstalled")} — ${res.removed.join(", ")}`
        : t("settings.cfSolver.uninstalled");
    } else {
      cfInstallError.value = res.message ?? t("settings.cfSolver.uninstallFailed");
    }
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.uninstallFailed");
  } finally {
    cfUninstalling.value = false;
  }
}

/**
 * `force` downloads the browser again over an existing one, updating it. `tier: "free"`
 * fetches the unlicensed build specifically -- a separate download that sits beside the
 * keyed one, so a launch that cannot take a licence seat still has something to run.
 */
async function installCfSolver(force = false, tier?: "free") {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfInstalling.value = true;
  try {
    const res = await settingsApi.installCfSolver(force, tier);
    if (res.ok) {
      cfChromiumInstalled.value = true;
      cfChromiumVersion.value = res.version ?? "";
      cfFontsInstalled.value = res.fontsInstalled === true;
      if (res.fontsInstalled) cfFontsMissing.value = "";
      await refreshCfBuildState();
      cfInstallMsg.value = res.version
        ? `${t("settings.cfSolver.installed")} — ${res.version}`
        : t("settings.cfSolver.installed");
      // The browser is usable without them, so a font failure is a warning beside the
      // success rather than an error in place of it.
      if (!res.fontsInstalled) cfInstallError.value = t("settings.cfSolver.fontsFailed");
    } else {
      cfInstallError.value = res.message || res.output || t("settings.cfSolver.failed");
    }
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.failed");
  } finally {
    cfInstalling.value = false;
  }
}

// Launches the browser and reports what the page sees of itself, so one install can be
// compared against another when a challenge passes in one place and not the other.
/** Renders whatever the run has produced so far, so results appear build by build. */
function showCfTestRun(run: CfBrowserTestRun) {
  const builds = run.builds ?? [];
  const name = (b: CfBrowserTest) =>
    b.tier === "free"
      ? t("settings.cfSolver.tierFree")
      : b.tier === "keyed"
        ? t("settings.cfSolver.tierKeyed")
        : t("settings.cfSolver.testBtn");
  const label = (b: CfBrowserTest, text: string) =>
    builds.length > 1 ? `[${name(b)}] ${text}` : text;

  cfTestWarnings.value = builds.flatMap((b) => (b.warnings ?? []).map((w) => label(b, w)));
  cfTestNotes.value = builds.flatMap((b) => (b.notes ?? []).map((n) => label(b, n)));
  cfTestReport.value = builds
    .map((b) =>
      JSON.stringify(
        {
          build: name(b),
          ok: b.ok,
          version: b.version,
          executable: b.executable,
          exitCountry: b.exitCountry,
          ...(b.error ? { error: b.error } : {}),
          ...b.env,
        },
        null,
        2,
      ),
    )
    .join("\n\n");

  // Nothing conclusive to say until the last build is in
  if (run.running) return;

  if (run.error && !builds.length) {
    cfInstallError.value = run.error;
    return;
  }
  const failed = builds.filter((b) => !b.ok);
  const passed = builds.filter((b) => b.ok);
  if (failed.length) {
    cfInstallError.value = failed
      .map((b) =>
        builds.length > 1
          ? `${name(b)}: ${b.error || t("settings.cfSolver.testFailed")}`
          : b.error || t("settings.cfSolver.testFailed"),
      )
      .join(" | ");
    // A build that passed is still worth saying so, when another did not
    if (passed.length) {
      cfInstallMsg.value = `${t("settings.cfSolver.testPassed")} — ${passed.map(name).join(", ")}`;
    }
  } else if (builds.length) {
    cfInstallMsg.value =
      builds.length > 1
        ? `${t("settings.cfSolver.testPassed")} — ${builds.map(name).join(", ")}`
        : t("settings.cfSolver.testPassed");
  }
}

// Leaving the page should not leave a timer behind polling for a test nobody is watching
onUnmounted(() => stopCfTestPoll());

function stopCfTestPoll() {
  if (cfTestPollTimer) {
    clearTimeout(cfTestPollTimer);
    cfTestPollTimer = null;
  }
}

async function pollCfTest() {
  stopCfTestPoll();
  try {
    const run = await settingsApi.cfSolverTestStatus();
    showCfTestRun(run);
    if (run.running) {
      cfTestPollTimer = setTimeout(pollCfTest, 2000);
    } else {
      cfTesting.value = false;
    }
  } catch {
    // A blip on the way to the panel is not the test failing; keep watching, slower
    cfTestPollTimer = setTimeout(pollCfTest, 4000);
  }
}

/**
 * Starts the test and follows it. Each build means launching a browser and loading a real
 * page, which together outlast what a proxy will hold a request open for, so the run
 * happens server-side and this polls for it.
 */
async function testCfSolver() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfTestReport.value = "";
  cfTestWarnings.value = [];
  cfTestNotes.value = [];
  cfTesting.value = true;
  try {
    const run = await settingsApi.testCfSolver();
    showCfTestRun(run);
    if (run.running) {
      cfTestPollTimer = setTimeout(pollCfTest, 2000);
    } else {
      cfTesting.value = false;
    }
  } catch (e: any) {
    // A test already running is not an error: follow that one instead
    if (e?.response?.status === 409) {
      cfTestPollTimer = setTimeout(pollCfTest, 500);
      return;
    }
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.testFailed");
    cfTesting.value = false;
  }
}

const uaPresets = ref<UAPreset[]>([]);
const newPresetName = ref("");
const newPresetValue = ref("");

const proxies = ref<Proxy[]>([]);
// Folded away by default: a synced list runs to dozens of rows and pushed the rest of the
// page off screen. Remembered, so working through the proxies does not mean re-opening it.
const proxyListOpen = usePersistedRef<boolean>("bemby:settings:proxyListOpen", false);
const proxyAddOpen = usePersistedRef<boolean>("bemby:settings:proxyAddOpen", false);
const proxyProvidersOpen = usePersistedRef<boolean>("bemby:settings:proxyProvidersOpen", false);
const proxyHealthOpen = usePersistedRef<boolean>("bemby:settings:proxyHealthOpen", false);

/**
 * The add-a-proxy form stands open while there is nothing configured at all, so a fresh
 * install does not open on four folded rows with no obvious place to start.
 */
const proxyAddShown = computed(
  () => proxyAddOpen.value || (!proxies.value.length && !providers.value.length),
);

/** What the folded list would show: how many exits can be drawn, and why the rest cannot. */
const proxyStateSummary = computed(() => {
  const list = proxies.value;
  if (!list.length) return "";
  const off = list.filter((p) => p.disabled).length;
  const failed = list.filter((p) => !p.disabled && p.status === "failed").length;
  const parts = [
    t("settings.proxyUsableCount")
      .replace("{n}", String(list.length - off - failed))
      .replace("{total}", String(list.length)),
  ];
  if (failed) parts.push(`${failed} ${t("settings.proxyDisabled")}`);
  if (off) parts.push(`${off} ${t("settings.proxyOff")}`);
  return parts.join(" · ");
});
const proxiesSaving = ref(false);
const proxyTesting = ref(false);
const editingProxyId = ref<string | null>(null);
const proxyEditTesting = ref(false);
const proxiesMsg = ref("");
const proxiesError = ref("");
const proxiesTestingAll = ref(false);
const proxyTestResults = ref<Record<string, ProxyTestResult>>({});
// The bulk test reads the stored list (the passwords on screen are masked), so it can
// only speak for what has been saved.
const savedProxiesJson = ref("[]");
const providers = ref<ProxyProvider[]>([]);
const providersSaving = ref(false);
const providersSyncing = ref(false);
const providersMsg = ref("");
const providersErrorMsg = ref("");
// On by default, so a refresh updates an entry in place rather than leaving a job with no proxy
const proxySyncMatchByName = ref(true);

async function saveProxySyncMatchByName() {
  try {
    await settingsApi.update({
      proxy_sync_match_by_name: String(proxySyncMatchByName.value),
    });
  } catch {
    proxySyncMatchByName.value = !proxySyncMatchByName.value;
  }
}

type ProxyForm = {
  protocol: "socks5" | "socks4";
  host: string;
  port: string;
  username: string;
  password: string;
  name: string;
  /** Edit panel only: whether unnamed draws and Cloudflare fall-through may use this exit. */
  autoPool?: boolean;
};
const newProxy = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});
const editProxyForm = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});

function buildProxyUrl(f: ProxyForm): string {
  const auth = f.username
    ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@`
    : "";
  return `${f.protocol}://${auth}${f.host}:${f.port || "1080"}`;
}

function parseProxyInput(raw: string): Omit<ProxyForm, "name"> | null {
  try {
    const normalized = /^socks[45]?:\/\//i.test(raw) ? raw : `socks5://${raw}`;
    const u = new URL(normalized);
    const proto = u.protocol.replace(":", "").toLowerCase();
    return {
      protocol: proto === "socks4" ? "socks4" : "socks5",
      host: u.hostname,
      port: u.port || "1080",
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

function onProxyHostInput(form: ProxyForm) {
  const val = form.host;
  if (val.includes("://") || val.includes("@")) {
    const parsed = parseProxyInput(val);
    if (parsed) Object.assign(form, parsed);
  }
}

// ── TG App Clients ─────────────────────────────────────────────────────────────

const appClients = ref<TgAppClient[]>([]);
const tgClientMode = ref<"default" | "random">("default");
const appClientsSaving = ref(false);
const editingClientId = ref<string | null>(null);
const appClientsMsg = ref("");
const appClientsError = ref("");

type AppClientForm = {
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
};
const newClient = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});
const editClientForm = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});

function addClient() {
  if (!newClient.name.trim() || !newClient.deviceModel.trim()) return;
  appClients.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newClient.name.trim(),
    deviceModel: newClient.deviceModel.trim(),
    systemVersion: newClient.systemVersion.trim(),
    appVersion: newClient.appVersion.trim(),
    langCode: newClient.langCode.trim() || "en",
    langPack: newClient.langPack.trim(),
    systemLangCode: newClient.systemLangCode.trim() || "en-US",
    isDefault: false,
  });
  Object.assign(newClient, {
    name: "",
    deviceModel: "",
    systemVersion: "",
    appVersion: "",
    langCode: "en",
    langPack: "",
    systemLangCode: "en-US",
  });
}

function removeClient(index: number) {
  appClients.value.splice(index, 1);
}

function startEditClient(c: TgAppClient) {
  editingClientId.value = c.id;
  Object.assign(editClientForm, {
    name: c.name,
    deviceModel: c.deviceModel,
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  });
}

function saveClientEdit(index: number) {
  if (!editClientForm.name.trim() || !editClientForm.deviceModel.trim()) return;
  const existing = appClients.value[index];
  appClients.value[index] = {
    ...existing,
    name: editClientForm.name.trim(),
    deviceModel: editClientForm.deviceModel.trim(),
    systemVersion: editClientForm.systemVersion.trim(),
    appVersion: editClientForm.appVersion.trim(),
    langCode: editClientForm.langCode.trim() || "en",
    langPack: editClientForm.langPack.trim(),
    systemLangCode: editClientForm.systemLangCode.trim() || "en-US",
  };
  editingClientId.value = null;
}

function setDefaultClient(index: number) {
  appClients.value = appClients.value.map((c, i) => ({
    ...c,
    isDefault: i === index,
  }));
}

async function saveAppClients() {
  appClientsMsg.value = "";
  appClientsError.value = "";
  appClientsSaving.value = true;
  try {
    await settingsApi.update({
      tg_app_clients: JSON.stringify(appClients.value),
      tg_client_mode: tgClientMode.value,
    });
    appClientsMsg.value = t("settings.saved");
  } catch (err: any) {
    appClientsError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    appClientsSaving.value = false;
  }
}

// ── Default TG API Credentials ─────────────────────────────────────────────────

const defaultTgApiId = ref<number | "">(0);
const defaultTgApiHashInput = ref("");
const defaultTgApiHashMasked = ref("");
const defaultTgApiSaving = ref(false);
const defaultTgApiClearing = ref(false);
const defaultTgApiMsg = ref("");
const defaultTgApiError = ref("");

// ── TG account display ─────────────────────────────────────────────────────────
const accountDisplayWithTgName = ref(false);
const scheduleSeparatePageSetting = ref(false);
const jobsTemplateEditButtonSetting = ref(false);
const dataStoreSetting = ref(false);

async function saveDefaultTgApi() {
  defaultTgApiMsg.value = "";
  defaultTgApiError.value = "";
  defaultTgApiSaving.value = true;
  try {
    const payload: Record<string, string> = {
      default_tg_api_id: String(defaultTgApiId.value || ""),
    };
    // Only include hash if user typed a new one
    if (defaultTgApiHashInput.value) {
      payload.default_tg_api_hash = defaultTgApiHashInput.value;
    }
    const updated = await settingsApi.update(payload);
    defaultTgApiHashMasked.value = updated.default_tg_api_hash ?? "";
    defaultTgApiHashInput.value = "";
    defaultTgApiMsg.value = t("settings.defaultTgApiSaved");
  } catch (err: any) {
    defaultTgApiError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    defaultTgApiSaving.value = false;
  }
}

async function clearDefaultTgApi() {
  defaultTgApiMsg.value = "";
  defaultTgApiError.value = "";
  defaultTgApiClearing.value = true;
  try {
    await settingsApi.update({
      default_tg_api_id: "",
      default_tg_api_hash: "",
    });
    defaultTgApiId.value = 0;
    defaultTgApiHashInput.value = "";
    defaultTgApiHashMasked.value = "";
    defaultTgApiMsg.value = t("settings.defaultTgApiCleared");
  } catch (err: any) {
    defaultTgApiError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    defaultTgApiClearing.value = false;
  }
}

const notifyEventOptions = computed(() => [
  { value: "failed", label: t("settings.notifyEventFailed") },
  { value: "success", label: t("settings.notifyEventSuccess") },
]);

function toggleNotifyEvent(value: string) {
  const idx = notifyForm.events.indexOf(value);
  if (idx === -1) notifyForm.events.push(value);
  else notifyForm.events.splice(idx, 1);
}

const cred = reactive({ username: "", newPassword: "", currentPassword: "" });
const credSaving = ref(false);
const revoking = ref(false);
const credMsg = ref("");
const credError = ref("");

// Memory: current/peak plus whatever the previous process was holding if it was killed
const memory = ref<MemoryReport | null>(null);
const memoryLoading = ref(true);
const memoryPercent = computed(() => {
  const m = memory.value;
  if (!m?.limitMb) return 0;
  return Math.round((m.current.rssMb / m.limitMb) * 100);
});

const crashText = computed(() => {
  const c = memory.value?.lastBeforeCrash;
  if (!c) return "";
  return t("settings.memoryCrash")
    .replace("{rss}", String(c.rssMb))
    .replace("{external}", String(c.externalMb))
    .replace("{at}", new Date(c.at).toLocaleString());
});

async function loadMemory() {
  memoryLoading.value = true;
  try {
    memory.value = await statusApi.memory();
  } catch {
    memory.value = null;
  } finally {
    memoryLoading.value = false;
  }
}

// Restarting the backend. The request is answered just before the process goes, so the
// interesting part is afterwards: wait for the new one to answer, then reload onto it.
const confirmRestart = ref(false);
/** Which of the two the confirmation is standing in front of. */
const restartForce = ref(false);
const restarting = ref(false);
const restartSupervised = ref(true);
const restartMsg = ref("");
const restartError = ref("");

/** Polls the unauthenticated health route until the new process answers, or time is up. */
async function waitForBackend(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Let the old process finish going first, so its last answer is not read as the new one
  await new Promise((r) => setTimeout(r, 2_000));
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* still down */
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return false;
}

function askRestart(force: boolean) {
  restartForce.value = force;
  confirmRestart.value = true;
}

async function restartSystem() {
  const force = restartForce.value;
  confirmRestart.value = false;
  restarting.value = true;
  restartMsg.value = "";
  restartError.value = "";
  try {
    const res = await settingsApi.restartSystem(force);
    restartMsg.value = force
      ? t("settings.system.forceRestartStarted").replace("{killed}", String(res.killed))
      : t("settings.system.restartStarted")
          .replace("{stopped}", String(res.stopped))
          .replace("{killed}", String(res.killed));
    if (!res.supervised) {
      restarting.value = false;
      return;
    }
    if (await waitForBackend()) window.location.reload();
    else restartError.value = t("settings.system.restartTimeout");
  } catch (e: any) {
    restartError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.system.restartFailed");
  } finally {
    restarting.value = false;
  }
}

onMounted(async () => {
  loadMemory();
  void loadSecrets();
  await loadProviders();
  try {
    const s = await settingsApi.get();
    form.default_timezone = s.default_timezone;
    form.default_max_retry = Number(s.default_max_retry);
    form.check_daily_run = s.check_daily_run !== "false";
    logRetentionDays.value = Number(s.log_retention_days) || 0;
    logRetentionSaved = logRetentionDays.value;
    scheduleGapMinutes.value =
      s.schedule_min_gap_minutes != null && s.schedule_min_gap_minutes !== ""
        ? Math.max(0, Number(s.schedule_min_gap_minutes) || 0)
        : 2;
    scheduleGapSaved = scheduleGapMinutes.value;
    form.default_ua = s.default_ua ?? "";
    try {
      uaPresets.value = JSON.parse(s.ua_presets ?? "[]");
    } catch {
      uaPresets.value = [];
    }
    try {
      proxies.value = JSON.parse(s.proxies ?? "[]");
    } catch {
      proxies.value = [];
    }
    savedProxiesJson.value = JSON.stringify(proxies.value);
    proxyTestCf.value = s.proxy_test_cf === "true";
    proxyTestExtraUrl.value = s.proxy_test_extra_url ?? "";
    proxyTestIntervalHours.value = Number(s.proxy_test_interval_hours) || 0;
    proxyCheckBeforeUse.value = s.proxy_check_before_use === "true";
    try {
      appClients.value = JSON.parse(s.tg_app_clients ?? "[]");
    } catch {
      appClients.value = [];
    }
    tgClientMode.value = s.tg_client_mode === "random" ? "random" : "default";
    defaultTgApiId.value = Number(s.default_tg_api_id) || 0;
    defaultTgApiHashMasked.value = s.default_tg_api_hash ?? "";
    accountDisplayWithTgName.value = s.account_display_with_tg_name === "true";
    scheduleSeparatePageSetting.value = s.schedule_separate_page === "true";
    jobsTemplateEditButtonSetting.value = s.jobs_template_edit_button === "true";
    // Unset means on: only an explicit "false" turns it off
    proxySyncMatchByName.value = s.proxy_sync_match_by_name !== "false";
    applyDataStoreSetting(s);
    dataStoreSetting.value = dataStoreEnabled.value;
    form.default_play_duration = Number(s.default_play_duration ?? 300);
    form.default_device_name = s.default_device_name ?? "Mac";
    form.ai_model = s.ai_model ?? "";
    form.ai_default_model_id = s.ai_default_model_id ?? "";
    form.ai_fallback_enabled = s.ai_fallback_enabled !== "false";
    cfChromiumInstalled.value = s.cf_chromium_installed === "true";
    cfChromiumVersion.value = s.cf_chromium_version ?? "";
    cfChromiumTier.value = s.cf_chromium_tier ?? "";
    cfFreeInstalled.value = s.cf_chromium_free_installed === "true";
    cfBrowsersRunning.value = Number(s.cf_browsers_running ?? 0);
    restartSupervised.value = s.restart_supervised !== "false";
    cfBuilds.value = parseCfBuilds(s.cf_chromium_builds);
    cfProfileCount.value = Number(s.cf_profile_count ?? 0);
    cfBrowserLang.value = s.cf_browser_lang ?? "";
    cfProfileId.value = s.cf_profile_id ?? "";
    vncInstalled.value = s.vnc_installed === "true";
    vncSource.value = s.vnc_source ?? "";
    vncVersion.value = s.vnc_version ?? "";
    cfChromiumPath.value = s.cf_chromium_path ?? "";
    cfKeyedPending.value = s.cf_chromium_keyed_pending === "true";
    cfFontsInstalled.value = s.cf_fonts_installed === "true";
    cfFontsMissing.value = s.cf_fonts_missing ?? "";
    loadCfKeys(s);
    loadCfTuning(s);
    notifyForm.username = s.notify_tg_username ?? "";
    notifyForm.botTarget = s.notify_bot_target ?? "";
    notifyBotTokenMasked.value = s.notify_bot_token_masked ?? "";
    try {
      if (s.notify_tg_events)
        notifyForm.events = JSON.parse(s.notify_tg_events);
    } catch {
      /* ignore */
    }
    void loadNotifyBot(s.notify_bot_configured === "true");
    msOauthClientId.value = s.ms_oauth_client_id ?? "";
    msApiForm.baseUrl = s.msapi_base_url ?? "";
    msApiForm.poolType = s.msapi_pool_type ?? "";
    msApiKeyMasked.value = s.msapi_api_key_masked ?? "";
    msApiConfigured.value = s.msapi_configured === "true";
    msApiPoolTypeDefault.value = s.msapi_pool_type_default || "Telegram";
    // Decides whether the card above is rendered at all
    applyMsApiSetting(s);
  } catch {
    /* ignore */
  }
  try {
    aiSuppliersLoading.value = true;
    suppliers.value = await aiSuppliersApi.list();
  } catch {
    /* ignore */
  } finally {
    aiSuppliersLoading.value = false;
  }
  // Upgraded installs only have the legacy model string: pre-select the row
  // the backend resolves it to (first supplier with a key carrying that model)
  if (!form.ai_default_model_id && form.ai_model) {
    const rows = suppliers.value.flatMap((s) =>
      s.models.map((m) => ({ ...m, hasKey: Boolean(s.api_key) })),
    );
    const match =
      rows.find((m) => m.model_id === form.ai_model && m.hasKey) ??
      rows.find((m) => m.model_id === form.ai_model);
    if (match) form.ai_default_model_id = String(match.id);
  }
  // Sizes are walked from disk, so this is fetched on its own rather than with the settings
  await loadCfProfiles();
});

async function saveSettings() {
  saveMsg.value = "";
  saveError.value = "";
  saving.value = true;
  try {
    await settingsApi.update({
      default_timezone: form.default_timezone,
      default_max_retry: String(form.default_max_retry),
      check_daily_run: String(form.check_daily_run),
    });
    saveMsg.value = t("settings.saved");
  } catch (err: any) {
    saveError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    saving.value = false;
  }
}

function addUaPreset() {
  const name = newPresetName.value.trim();
  const value = newPresetValue.value.trim();
  if (!name || !value) return;
  uaPresets.value.push({ name, value });
  newPresetName.value = "";
  newPresetValue.value = "";
}

function removeUaPreset(index: number) {
  // If the default UA matches the removed preset, clear it
  if (form.default_ua === uaPresets.value[index]?.value) form.default_ua = "";
  uaPresets.value.splice(index, 1);
}

async function addProxy() {
  if (!newProxy.name.trim() || !newProxy.host.trim()) return;
  const url = buildProxyUrl(newProxy);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyTesting.value = false;
  }

  proxies.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newProxy.name.trim(),
    url,
  });
  Object.assign(newProxy, {
    protocol: "socks5",
    host: "",
    port: "1080",
    username: "",
    password: "",
    name: "",
  });
}

function removeProxy(index: number) {
  proxies.value.splice(index, 1);
}

function startEditProxy(p: Proxy) {
  editingProxyId.value = p.id;
  const parsed = parseProxyInput(p.url);
  Object.assign(editProxyForm, {
    protocol: parsed?.protocol ?? "socks5",
    host: parsed?.host ?? "",
    port: parsed?.port ?? "1080",
    username: parsed?.username ?? "",
    password: parsed?.password ?? "",
    name: p.name,
    autoPool: p.autoPool !== false,
  });
  proxiesMsg.value = "";
  proxiesError.value = "";
}

async function saveProxyEdit(index: number) {
  if (!editProxyForm.name.trim() || !editProxyForm.host.trim()) return;
  const url = buildProxyUrl(editProxyForm);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyEditTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyEditTesting.value = false;
  }

  proxies.value[index] = {
    ...proxies.value[index],
    name: editProxyForm.name.trim(),
    url,
    autoPool: editProxyForm.autoPool !== false,
  };
  editingProxyId.value = null;
}

async function saveProxies() {
  proxiesMsg.value = "";
  proxiesError.value = "";
  proxiesSaving.value = true;
  try {
    const payload = JSON.stringify(proxies.value);
    await settingsApi.update({ proxies: payload });
    savedProxiesJson.value = payload;
    proxiesMsg.value = t("settings.saved");
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    proxiesSaving.value = false;
  }
}

async function testAllProxies() {
  proxiesMsg.value = "";
  proxiesError.value = "";
  if (JSON.stringify(proxies.value) !== savedProxiesJson.value) {
    proxiesError.value = t("settings.proxyTestAllUnsaved");
    return;
  }
  proxiesTestingAll.value = true;
  proxyTestResults.value = {};
  try {
    const { results, ok, proxies: updated } = await settingsApi.testAllProxies();
    proxyTestResults.value = Object.fromEntries(results.map((r) => [r.id, r]));
    applyProxies(updated);
    proxiesMsg.value = t("settings.proxyTestAllDone")
      .replace("{ok}", String(ok))
      .replace("{total}", String(results.length));
  } catch (err: any) {
    proxiesError.value =
      err.response?.data?.error ?? t("settings.proxyTestAllFailed");
  } finally {
    proxiesTestingAll.value = false;
  }
}

/** Takes on a list the server rewrote, so the copy on screen is not saved back over it. */
function applyProxies(raw: string | undefined) {
  try {
    proxies.value = JSON.parse(raw ?? "[]");
    savedProxiesJson.value = JSON.stringify(proxies.value);
  } catch {
    /* keep what is on screen */
  }
}

/** What the last test found, for the badge's tooltip: when it ran, and why it failed. */
function proxyStatusTip(p: Proxy): string {
  const when = p.testedAt ? new Date(p.testedAt).toLocaleString() : "";
  const head = p.status === "failed" ? t("settings.proxyDisabledTip") : t("settings.proxyStatusOk");
  return [head, when, p.testError].filter(Boolean).join(" · ");
}

/** Puts an exit back in the draws, clearing a manual switch and a failed verdict alike. */
async function enableProxy(id: string) {
  proxiesError.value = "";
  try {
    applyProxies((await settingsApi.enableProxy(id)).proxies);
    delete proxyTestResults.value[id];
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

/** Takes an exit out by hand. No test puts it back; only the button beside it does. */
async function disableProxy(id: string) {
  proxiesError.value = "";
  try {
    applyProxies((await settingsApi.disableProxy(id)).proxies);
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

// How thoroughly and how often the exits are tested. The extra checks are opt-in: each one
// that is on can disable an exit, which is the point of turning it on.
const proxyTestCf = ref(false);
const proxyCheckBeforeUse = ref(false);
const proxyTestExtraUrl = ref("");
const proxyTestIntervalHours = ref(0);
const proxyHealthSaving = ref(false);

async function saveProxyHealth() {
  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyHealthSaving.value = true;
  try {
    await settingsApi.update({
      proxy_test_cf: String(proxyTestCf.value),
      proxy_test_extra_url: proxyTestExtraUrl.value.trim(),
      proxy_test_interval_hours: String(Math.max(0, Number(proxyTestIntervalHours.value) || 0)),
      proxy_check_before_use: String(proxyCheckBeforeUse.value),
    });
    proxiesMsg.value = t("settings.saved");
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    proxyHealthSaving.value = false;
  }
}

// Proxy providers: configured sellers whose current list can be pulled in. Keys are
// never sent back by the server, so a blank key field means "leave it as it is".
function addProvider() {
  providers.value.push({
    // Timestamp-based so a new row is stable before the first save
    id: `p${Date.now().toString(36)}`,
    name: "Webshare",
    type: "webshare",
    scheme: "http",
    enabled: true,
    apiKey: "",
  });
}

async function loadProviders() {
  try {
    providers.value = await settingsApi.getProxyProviders();
  } catch {
    providers.value = [];
  }
}

async function saveProviders() {
  providersMsg.value = "";
  providersErrorMsg.value = "";
  providersSaving.value = true;
  try {
    providers.value = await settingsApi.saveProxyProviders(providers.value);
    providersMsg.value = t("settings.saved");
  } catch (err: any) {
    providersErrorMsg.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    providersSaving.value = false;
  }
}

async function syncProviders(providerId?: string) {
  providersMsg.value = "";
  providersErrorMsg.value = "";
  providersSyncing.value = true;
  try {
    // Save first, so a key or URL just typed in is the one used
    providers.value = await settingsApi.saveProxyProviders(providers.value);
    const res = await settingsApi.syncProxyProviders(providerId);
    if (!res.ok) {
      providersErrorMsg.value = res.error ?? t("settings.providerSyncFailed");
      return;
    }
    providersMsg.value = t("settings.providerSynced")
      .replace("{added}", String(res.added ?? 0))
      .replace("{updated}", String(res.updated ?? 0))
      .replace("{removed}", String(res.removed ?? 0))
      .replace("{total}", String(res.total ?? 0));
    // Every import is tested on arrival, so say how it went rather than leaving the
    // freshly disabled entries to be discovered in the list
    if (res.tested) {
      providersMsg.value += ` ${t("settings.providerSyncTested")
        .replace("{ok}", String(res.reachable ?? 0))
        .replace("{total}", String(res.tested))}`;
    }
    const failed = (res.providers ?? []).filter((p) => !p.ok);
    if (failed.length) {
      providersErrorMsg.value = failed.map((p) => `${p.name}: ${p.error}`).join("; ");
    }
    // The server rewrote the proxy list, statuses and all, so take its copy
    applyProxies(res.proxies ?? (await settingsApi.get()).proxies);
    await loadProviders();
  } catch (err: any) {
    providersErrorMsg.value = err.response?.data?.error ?? t("settings.providerSyncFailed");
  } finally {
    providersSyncing.value = false;
  }
}

async function saveEmby() {
  embyMsg.value = "";
  embyError.value = "";
  embySaving.value = true;
  try {
    await settingsApi.update({
      default_ua: form.default_ua,
      default_play_duration: String(form.default_play_duration),
      default_device_name: form.default_device_name,
      ua_presets: JSON.stringify(uaPresets.value),
    });
    embyMsg.value = t("settings.saved");
  } catch (err: any) {
    embyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    embySaving.value = false;
  }
}

async function saveAi() {
  aiMsg.value = "";
  aiError.value = "";
  aiSaving.value = true;
  try {
    // Keep the legacy model string in sync: it is the fallback when the
    // pinned row id no longer exists (e.g. after a data import)
    const selected = suppliers.value
      .flatMap((s) => s.models)
      .find((m) => String(m.id) === form.ai_default_model_id);
    form.ai_model = selected?.model_id ?? "";
    await settingsApi.update({
      ai_default_model_id: form.ai_default_model_id,
      ai_model: form.ai_model,
      ai_fallback_enabled: String(form.ai_fallback_enabled),
    });
    aiMsg.value = t("settings.saved");
  } catch (err: any) {
    aiError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    aiSaving.value = false;
  }
}

async function saveFallbackEnabled() {
  try {
    await settingsApi.update({ ai_fallback_enabled: String(form.ai_fallback_enabled) });
  } catch {
    // revert on failure
    form.ai_fallback_enabled = !form.ai_fallback_enabled;
  }
}

const logRetentionDays = ref(0);
let logRetentionSaved = 0; // last persisted value, for revert on failure

async function saveLogRetention() {
  const value = Math.max(0, Math.floor(Number(logRetentionDays.value) || 0));
  logRetentionDays.value = value;
  if (value === logRetentionSaved) return;
  try {
    await settingsApi.update({ log_retention_days: String(value) });
    logRetentionSaved = value;
  } catch {
    logRetentionDays.value = logRetentionSaved;
  }
}

const scheduleGapMinutes = ref(2);
let scheduleGapSaved = 2; // last persisted value, for revert on failure

async function saveScheduleGap() {
  const value = Math.min(
    30,
    Math.max(0, Math.floor(Number(scheduleGapMinutes.value) || 0)),
  );
  scheduleGapMinutes.value = value;
  if (value === scheduleGapSaved) return;
  try {
    await settingsApi.update({ schedule_min_gap_minutes: String(value) });
    scheduleGapSaved = value;
  } catch {
    scheduleGapMinutes.value = scheduleGapSaved;
  }
}

async function saveAccountDisplay() {
  try {
    await settingsApi.update({
      account_display_with_tg_name: String(accountDisplayWithTgName.value),
    });
    // Reflect the change immediately across all views
    setAccountDisplayWithTgName(accountDisplayWithTgName.value);
  } catch {
    // revert on failure
    accountDisplayWithTgName.value = !accountDisplayWithTgName.value;
  }
}

async function saveSchedulePage() {
  try {
    await settingsApi.update({
      schedule_separate_page: String(scheduleSeparatePageSetting.value),
    });
    // Move the menu entry and the jobs-page panel at once
    setSchedulePageSeparate(scheduleSeparatePageSetting.value);
  } catch {
    scheduleSeparatePageSetting.value = !scheduleSeparatePageSetting.value;
  }
}

async function saveDataStore() {
  try {
    await settingsApi.update({ data_store_enabled: String(dataStoreSetting.value) });
    // Show or hide the menu entry and the data steps without a reload
    setDataStoreEnabled(dataStoreSetting.value);
  } catch {
    dataStoreSetting.value = !dataStoreSetting.value;
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────────
// Names only: the list endpoint never returns a value, and neither does anything else.
const secrets = ref<SecretSummary[]>([]);
const secretForm = reactive({ key: "", value: "" });
const secretSaving = ref(false);
const secretsMsg = ref("");
const secretsError = ref("");

function fmtSecretDate(iso: string): string {
  // SQLite writes UTC without a zone, which the browser would otherwise read as local
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

async function loadSecrets() {
  try {
    secrets.value = await secretsApi.list();
  } catch {
    secrets.value = [];
  }
}

async function saveSecret() {
  secretsMsg.value = "";
  secretsError.value = "";
  secretSaving.value = true;
  try {
    await secretsApi.save(secretForm.key, secretForm.value);
    secretsMsg.value = t("settings.secretSaved").replace("{name}", secretForm.key);
    secretForm.key = "";
    secretForm.value = "";
    await loadSecrets();
  } catch (err: any) {
    secretsError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    secretSaving.value = false;
  }
}

// The Microsoft application (client) id, saved beside the secrets because that is where its
// other half lives. An ordinary setting otherwise, hence its own small save.
const msOauthClientId = ref("");
const msOauthSaving = ref(false);

async function saveMsOauthClientId() {
  secretsMsg.value = "";
  secretsError.value = "";
  msOauthSaving.value = true;
  try {
    await settingsApi.update({ ms_oauth_client_id: msOauthClientId.value });
    secretsMsg.value = t("settings.saved");
  } catch (err: any) {
    secretsError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    msOauthSaving.value = false;
  }
}

async function removeSecret(key: string) {
  secretsMsg.value = "";
  secretsError.value = "";
  try {
    await secretsApi.remove(key);
    await loadSecrets();
  } catch (err: any) {
    secretsError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function saveJobsTemplateEditButton() {
  try {
    await settingsApi.update({
      jobs_template_edit_button: String(jobsTemplateEditButtonSetting.value),
    });
    // Show or hide the button on the jobs page at once
    setTemplateEditButton(jobsTemplateEditButtonSetting.value);
  } catch {
    jobsTemplateEditButtonSetting.value = !jobsTemplateEditButtonSetting.value;
  }
}

async function reloadSuppliers() {
  suppliers.value = await aiSuppliersApi.list();
}

function startEditSupplier(s: AiSupplier) {
  editingSupplierId.value = s.id;
  editForm.name = s.name;
  editForm.base_url = s.base_url;
  editForm.api_key = s.api_key;
  editForm.timeout_ms = s.timeout_ms;
}

async function saveEditSupplier(id: number) {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.update(id, { ...editForm });
    editingSupplierId.value = null;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function createSupplier() {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.create({ ...newSupplierForm });
    showAddSupplier.value = false;
    newSupplierForm.name = "";
    newSupplierForm.base_url = "";
    newSupplierForm.api_key = "";
    newSupplierForm.timeout_ms = 25000;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function removeSupplier(id: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.remove(id);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function addModel(supplierId: number) {
  const modelId = newModelInputs.value[supplierId]?.trim();
  if (!modelId) return;
  supplierError.value = "";
  try {
    await aiSuppliersApi.addModel(supplierId, modelId);
    newModelInputs.value[supplierId] = "";
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function removeModel(supplierId: number, modelId: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.removeModel(supplierId, modelId);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function saveNotify() {
  notifyMsg.value = "";
  notifyError.value = "";
  notifySaving.value = true;
  try {
    const s = await settingsApi.update({
      notify_tg_username: notifyForm.username,
      notify_tg_events: JSON.stringify(notifyForm.events),
      notify_bot_target: notifyForm.botTarget,
      // Blank leaves the stored token alone, so an operator can edit the target
      // without retyping the token
      ...(notifyForm.botToken ? { notify_bot_token: notifyForm.botToken } : {}),
    });
    notifyForm.botToken = "";
    notifyBotTokenMasked.value = s.notify_bot_token_masked ?? "";
    notifyMsg.value = t("settings.saved");
    await loadNotifyBot(s.notify_bot_configured === "true");
  } catch (err: any) {
    notifyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    notifySaving.value = false;
  }
}

// ── msOauth2api ────────────────────────────────────────────────────────────────

async function saveMsApi() {
  msApiMsg.value = "";
  msApiError.value = "";
  msApiPool.value = "";
  msApiSaving.value = true;
  try {
    const s = await settingsApi.update({
      msapi_base_url: msApiForm.baseUrl,
      msapi_pool_type: msApiForm.poolType,
      // Blank leaves the stored key alone, so the URL can be edited without retyping it
      ...(msApiForm.apiKey ? { msapi_api_key: msApiForm.apiKey } : {}),
    });
    msApiForm.apiKey = "";
    msApiKeyMasked.value = s.msapi_api_key_masked ?? "";
    msApiConfigured.value = s.msapi_configured === "true";
    // Offer or withdraw the pool source in the step editor without a reload
    applyMsApiSetting(s);
    msApiMsg.value = t("settings.saved");
  } catch (err: any) {
    msApiError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    msApiSaving.value = false;
  }
}

/** Asks the pool for its counts: the one check that proves URL, key and type together. */
async function testMsApi() {
  msApiMsg.value = "";
  msApiError.value = "";
  msApiPool.value = "";
  msApiTesting.value = true;
  try {
    const r = await settingsApi.testMsApi(msApiForm.poolType);
    if (r.ok) {
      msApiPool.value = t("settings.msapi.poolCounts")
        .replace("{available}", String(r.available ?? 0))
        .replace("{leased}", String(r.leased ?? 0))
        .replace("{confirmed}", String(r.confirmed ?? 0));
    } else {
      msApiError.value = r.error ?? t("settings.msapi.testFailed");
    }
  } catch (err: any) {
    msApiError.value =
      err.response?.data?.error ?? t("settings.msapi.testFailed");
  } finally {
    msApiTesting.value = false;
  }
}

/** Confirms the stored token with getMe, so a revoked or mistyped one is visible here. */
async function loadNotifyBot(configured: boolean) {
  if (!configured) {
    notifyBot.value = { configured: false };
    return;
  }
  try {
    notifyBot.value = await settingsApi.getNotifyBot();
  } catch {
    notifyBot.value = { configured: true, ok: false };
  }
}

// A bot cannot start a conversation, so the numeric chat id it should notify only exists
// once someone has messaged it. This reads those chats back off getUpdates.
async function loadNotifyChats() {
  notifyChatsHint.value = "";
  notifyChats.value = [];
  notifyChatsLoading.value = true;
  try {
    const res = await settingsApi.getNotifyBotChats();
    notifyChats.value = res.chats ?? [];
    if (!notifyChats.value.length) notifyChatsHint.value = t("settings.notifyNoChats");
  } catch (err: any) {
    notifyChatsHint.value =
      err.response?.data?.error ?? t("settings.notifyChatsFailed");
  } finally {
    notifyChatsLoading.value = false;
  }
}

/** Sends a real message now: the only check that covers token, network and target. */
async function testNotifyBot() {
  notifyMsg.value = "";
  notifyError.value = "";
  notifyTesting.value = true;
  try {
    // Whatever is in the fields right now, saved or not, so a token can be tried first
    await settingsApi.testNotifyBot(
      notifyForm.botTarget || undefined,
      notifyForm.botToken || undefined,
    );
    notifyMsg.value = t("settings.notifyTestSent");
  } catch (err: any) {
    notifyError.value =
      err.response?.data?.error ?? t("settings.notifyTestFailed");
  } finally {
    notifyTesting.value = false;
  }
}

// ── Import / Export ───────────────────────────────────────────────────────────

const fileInput = ref<HTMLInputElement | null>(null);
const importFile = ref<File | null>(null);
const importMode = ref<"merge" | "replace">("merge");
const importForceReauth = ref(true);
const importing = ref(false);
const importMsg = ref("");
const importError = ref("");
const exportSecret = ref("");
const showExportSecret = ref(false);
const importSecret = ref("");
const showImportSecret = ref(false);
const importConfirmPassword = ref("");
const showImportConfirmPassword = ref(false);
// Set when a loaded file is detected as encrypted
const importFileEncrypted = ref(false);

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null;
  importFile.value = file;
  importFileEncrypted.value = false;
  importSecret.value = "";
  if (!file) return;
  // Peek at the file to detect encryption without a server round-trip
  file.text().then((text) => {
    try {
      const parsed = JSON.parse(text);
      importFileEncrypted.value = parsed?.encrypted === true;
    } catch {
      // Invalid JSON -- will be caught on actual import
    }
  });
}

async function doExport() {
  const secret = exportSecret.value.trim() || undefined;
  try {
    const data = await dataApi.export(secret);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    a.download = `bemby-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    const code = err.response?.data?.code;
    importError.value = code === "SECRET_REQUIRED"
      ? t("settings.importExport.exportSecretRequired")
      : (err.response?.data?.error ?? t("settings.importExport.importFailed"));
  }
}

async function doImport() {
  importMsg.value = "";
  importError.value = "";
  if (!importFile.value) {
    importError.value = t("settings.importExport.noFileSelected");
    return;
  }
  importing.value = true;
  try {
    const text = await importFile.value.text();
    let parsed: ExportPayload | EncryptedEnvelope;
    try {
      parsed = JSON.parse(text);
    } catch {
      importError.value = t("settings.importExport.invalidFile");
      return;
    }
    const secret = importSecret.value.trim() || undefined;
    const confirmPassword = importMode.value === "replace"
      ? importConfirmPassword.value.trim() || undefined
      : undefined;
    const result = await dataApi.import(
      parsed,
      importMode.value,
      secret,
      importForceReauth.value,
      confirmPassword,
    );
    importMsg.value = t("settings.importExport.importSuccess")
      .replace("{a}", String(result.accountsImported))
      .replace("{t}", String(result.templatesImported))
      .replace("{j}", String(result.jobsImported))
      .replace("{sup}", String(result.aiSuppliersImported))
      .replace("{mod}", String(result.aiModelsImported))
      .replace("{s}", String(result.settingsUpdated));
    if (fileInput.value) fileInput.value.value = "";
    importFile.value = null;
    importFileEncrypted.value = false;
    importSecret.value = "";
    importConfirmPassword.value = "";
  } catch (err: any) {
    const code = err.response?.data?.code;
    importError.value =
      code === "WRONG_SECRET"
        ? t("settings.importExport.wrongSecret")
        : code === "CONFIRM_REQUIRED"
          ? t("settings.importExport.confirmPasswordRequired")
          : code === "WRONG_PASSWORD"
            ? t("settings.importExport.wrongConfirmPassword")
            : (err.response?.data?.error ??
              t("settings.importExport.importFailed"));
  } finally {
    importing.value = false;
  }
}

async function saveCredentials() {
  credMsg.value = "";
  credError.value = "";
  if (!cred.currentPassword) {
    credError.value = t("settings.currentPassRequired");
    return;
  }
  credSaving.value = true;
  try {
    const { token } = await authApi.changeCredentials(
      cred.currentPassword,
      cred.username || undefined,
      cred.newPassword || undefined,
    );
    // A credential change retires every token issued before it, this tab's included. The
    // reply carries its replacement, so it has to be stored or the next request is a 401.
    if (token) localStorage.setItem("token", token);
    credMsg.value = t("settings.credSaved");
    Object.assign(cred, { username: "", newPassword: "", currentPassword: "" });
  } catch (err: any) {
    credError.value = err.response?.data?.error ?? t("settings.credFailed");
  } finally {
    credSaving.value = false;
  }
}

async function signOutEverywhere() {
  credMsg.value = "";
  credError.value = "";
  revoking.value = true;
  try {
    const { token } = await authApi.revokeSessions();
    if (token) localStorage.setItem("token", token);
    credMsg.value = t("settings.sessionsRevoked");
  } catch (err: any) {
    credError.value = err.response?.data?.error ?? t("settings.credFailed");
  } finally {
    revoking.value = false;
  }
}
</script>

<style scoped>
.profiles-panel {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid #eee;
  border-radius: 6px;
}

.profiles-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.profiles-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.profiles-sep {
  width: 1px;
  align-self: stretch;
  background: #eee;
  margin: 0 2px;
}

.profiles-replace {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #666;
}

.profiles-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
}

.profiles-table th,
.profiles-table td {
  text-align: left;
  padding: 5px 6px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}

.profiles-table th {
  font-size: 11px;
  color: #888;
  font-weight: 600;
}

.vnc-log {
  margin-top: 6px;
  padding: 6px 8px;
  background: #f6f7f9;
  border-radius: 4px;
  font-size: 11px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
}

.tg-client-mode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.radio-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
}

.event-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.event-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 20px;
  border: 1.5px solid #ddd;
  cursor: pointer;
  font-size: 13px;
  color: #555;
  user-select: none;
  transition:
    border-color 0.15s,
    background 0.15s,
    color 0.15s;
}

.event-pill input[type="checkbox"] {
  display: none;
}

.event-pill.active {
  border-color: var(--color-primary, #2563eb);
  background: #eff6ff;
  color: var(--color-primary, #2563eb);
  font-weight: 500;
}

.event-pill:hover:not(.active) {
  border-color: #bbb;
  background: #fafafa;
}

.ie-divider {
  border: none;
  border-top: 1px solid #eee;
  margin: 16px 0;
}

.import-mode-row {
  display: flex;
  gap: 16px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.import-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.import-mode-option input[type="radio"] {
  margin-top: 3px;
  flex-shrink: 0;
}

.import-mode-label {
  font-size: 13px;
  font-weight: 500;
}

.settings-subsection {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  margin-bottom: 10px;
}

.mem-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mem-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
  gap: 12px;
}

.mem-row span {
  color: #888;
}

.mem-row strong {
  font-variant-numeric: tabular-nums;
}

.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle .form-input {
  padding-right: 36px;
  flex: 1;
}

.toggle-secret-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: #888;
  padding: 0;
  display: flex;
  align-items: center;
}

.toggle-secret-btn:hover {
  color: #444;
}

.import-mode-hint {
  font-size: 12px;
  color: #888;
}

.ua-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
}

.ua-preset-name {
  flex: 0 0 140px;
  font-size: 13px;
  font-weight: 500;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ua-preset-value {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.ua-preset-del {
  flex-shrink: 0;
  color: #e63946;
  padding: 3px 7px;
}

.ua-preset-add {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* AI supplier cards */
.supplier-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #fafafa;
}
.supplier-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.supplier-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.supplier-name {
  font-weight: 600;
  font-size: 13px;
}
.supplier-url {
  font-size: 12px;
  color: #6b7280;
  font-family: monospace;
  word-break: break-all;
}
.supplier-timeout {
  font-size: 11px;
  color: #9ca3af;
}
.supplier-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.supplier-edit-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.supplier-no-key-warning {
  margin-top: 8px;
  font-size: 12px;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 5px;
  padding: 5px 10px;
}
.supplier-models {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e5e7eb;
}
.supplier-models-label {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.supplier-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #e5e7eb;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: monospace;
}
.model-chip-del {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: #9ca3af;
  font-size: 11px;
  line-height: 1;
}
.model-chip-del:hover {
  color: #ef4444;
}
.model-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.form-input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: auto;
}
/*
 * Red lettering for a destructive action sitting on a light button. Kept to the ghost
 * pairing deliberately: as a bare `.btn-danger` this also hit the solid red variant, whose
 * own colour is white -- red text on a red fill, which is why the provider delete icon and
 * the uninstall button came out as blank red blocks.
 */
.btn-ghost.btn-danger {
  color: #ef4444;
}
.btn-ghost.btn-danger:hover {
  color: #dc2626;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 20px;
  align-items: start;
}
.s-col-4 {
  grid-column: span 4;
}
.s-col-6 {
  grid-column: span 6;
}
.s-col-12 {
  grid-column: span 12;
}
@media (max-width: 960px) {
  .s-col-4 {
    grid-column: span 6;
  }
}
@media (max-width: 640px) {
  .s-col-4,
  .s-col-6 {
    grid-column: span 12;
  }
}

/* One folded sub-section's header row: the toggle, and a note that stands in for what is
   hidden so the card still says something useful while closed */
.proxy-fold {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.proxy-fold-note {
  font-size: 11px;
  color: #888;
}

/* A provider can leave dozens of rows, so the open list scrolls in place rather than
   pushing everything below it off screen */
.proxy-list-box {
  max-height: 320px;
  overflow-y: auto;
  margin-top: 4px;
}

.proxy-edit-panel {
  padding: 10px;
  border: 1px solid #e8e8f0;
  border-radius: 6px;
  background: #fafafa;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proxy-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* Destructive, but not a call to action: red lettering rather than a red slab, so it
   reads as available without competing with the download and test buttons above it. */
.cf-uninstall-btn {
  color: #c0392b;
  background: transparent;
  border: 1px solid #f0d0cd;
}

.cf-uninstall-btn:not(:disabled):hover {
  background: #fdf1f0;
  border-color: #e0a9a4;
  opacity: 1;
}
</style>
