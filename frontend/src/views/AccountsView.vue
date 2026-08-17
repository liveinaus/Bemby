<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("accounts.title") }}</h2>
      <div class="page-header-actions">
        <!-- A textarea rather than an input: a pasted list of names is the point, and an input
             would flatten its newlines into one long term that matches nothing -->
        <div class="account-search">
          <textarea
            v-model="searchText"
            class="form-input account-search-box"
            :rows="searchRows"
            :placeholder="t('accounts.searchPlaceholder')"
          ></textarea>
          <div v-if="searchTermCount > 1" class="account-search-count">
            {{ t("accounts.searchTerms").replace("{n}", String(searchTermCount)) }}
            <template v-if="searchTermCount > MAX_SEARCH_TERMS">
              {{ t("accounts.searchTermsCapped").replace("{n}", String(MAX_SEARCH_TERMS)) }}
            </template>
          </div>
        </div>
        <button
          v-if="accounts.length"
          class="btn btn-secondary"
          @click="toggleSelectAll"
        >
          {{ allSelected ? t("common.deselectAll") : t("common.selectAll") }}
        </button>
        <!-- Bulk actions on the current selection, consolidated into one menu -->
        <div v-if="selectedIds.size > 0" class="bulk-menu">
          <button class="btn btn-secondary" @click="bulkMenuOpen = !bulkMenuOpen">
            <i class="fa-solid fa-list-check"></i>
            {{ t("accounts.bulkActions.btn") }} ({{ selectedIds.size }})
            <i class="fa-solid fa-caret-down" style="margin-left: 4px"></i>
          </button>
          <div
            v-if="bulkMenuOpen"
            class="bulk-menu-backdrop"
            @click="bulkMenuOpen = false"
          ></div>
          <div v-if="bulkMenuOpen" class="bulk-menu-list">
            <button
              class="bulk-menu-item"
              :disabled="spamBulkRunning"
              @click="runBulk(openBulkSpam)"
            >
              <i class="fa-solid fa-user-shield"></i>
              {{ t("accounts.checkSpamSelected") }}
            </button>
            <button
              class="bulk-menu-item"
              :disabled="bulkFetchRunning"
              @click="runBulk(openBulkFetch)"
            >
              <i class="fa-solid fa-arrows-rotate"></i>
              {{ t("accounts.bulkFetch.btn") }}
            </button>
            <button class="bulk-menu-item" @click="runBulk(openBulkRename)">
              <i class="fa-solid fa-i-cursor"></i>
              {{ t("accounts.bulkRename.btn") }}
            </button>
            <button class="bulk-menu-item" @click="runBulk(openBulkNotes)">
              <i class="fa-solid fa-note-sticky"></i>
              {{ t("accounts.setNotesSelected") }}
            </button>
            <button class="bulk-menu-item" @click="runBulk(openExportWarn)">
              <i class="fa-solid fa-file-export"></i>
              {{ t("accounts.exportSelectedBtn") }}
            </button>
            <template v-if="bulkMgmtEnabled">
              <div class="bulk-menu-divider"></div>
              <button class="bulk-menu-item" @click="runBulk(openBulkTgRename)">
                <i class="fa-solid fa-address-card"></i>
                {{ t("accounts.bulkTgRename.btn") }}
              </button>
              <button class="bulk-menu-item" @click="runBulk(openBulkCred)">
                <i class="fa-solid fa-user-lock"></i>
                {{ t("accounts.bulkCred.btn") }}
              </button>
              <button class="bulk-menu-item" @click="runBulk(openBulkEmail)">
                <i class="fa-solid fa-envelope"></i>
                {{ t("accounts.bulkEmail.btn") }}
              </button>
              <button class="bulk-menu-item" @click="runBulk(openBulkPasskey)">
                <i class="fa-solid fa-key"></i>
                {{ t("accounts.bulkPasskey.btn") }}
              </button>
              <button class="bulk-menu-item" @click="runBulk(openBulkPrivacy)">
                <i class="fa-solid fa-eye-slash"></i>
                {{ t("accounts.bulkPrivacy.btn") }}
              </button>
              <button
                class="bulk-menu-item danger"
                @click="runBulk(openBulkClean)"
              >
                <i class="fa-solid fa-broom"></i>
                {{ t("accounts.bulkClean.btn") }}
              </button>
            </template>
          </div>
        </div>
        <button v-else class="btn btn-secondary" @click="openExportWarn">
          <i class="fa-solid fa-file-export"></i> {{ t("accounts.exportBtn") }}
        </button>
        <button class="btn btn-secondary" @click="showExtra = !showExtra">
          <i
            class="fa-solid"
            :class="showExtra ? 'fa-eye-slash' : 'fa-eye'"
          ></i>
          {{
            showExtra
              ? t("accounts.hideExtraInfoToggle")
              : t("accounts.showExtraInfoToggle")
          }}
        </button>
        <button class="btn btn-secondary" @click="openImport">
          <i class="fa-solid fa-file-import"></i> {{ t("accounts.importBtn") }}
        </button>
        <button
          v-if="bulkMgmtEnabled"
          class="btn btn-secondary"
          @click="openBulkAdd"
        >
          <i class="fa-solid fa-layer-group"></i>
          {{ t("accounts.bulkAdd.btn") }}
        </button>
        <button class="btn btn-primary" @click="openAdd">
          <i class="fa-solid fa-plus"></i> {{ t("accounts.addBtn") }}
        </button>
      </div>
    </div>

    <div class="card">
      <PaginationBar
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 20px"></th>
              <th class="sortable" @click="sortBy('name')">
                {{ t("common.name") }}<i :class="sortIcon('name')"></i>
              </th>
              <th class="sortable" @click="sortBy('phone')">
                {{ t("accounts.colPhone") }}<i :class="sortIcon('phone')"></i>
              </th>
              <th class="col-hide-mobile">{{ t("accounts.colTgName") }}</th>
              <th class="sortable" @click="sortBy('status')">
                {{ t("accounts.colStatus") }}<i :class="sortIcon('status')"></i>
              </th>
              <th :class="extraColClass">{{ t("accounts.colExtraInfo") }}</th>
              <th class="col-hide-mobile sortable" @click="sortBy('created')">
                {{ t("accounts.colAdded") }}<i :class="sortIcon('created')"></i>
              </th>
              <th>{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!accounts.length">
              <td :colspan="showExtra ? 8 : 7" class="empty">{{ t("accounts.noAccounts") }}</td>
            </tr>
            <tr
              v-for="(a, idx) in accounts"
              :key="a.id"
              :class="[
                a.disabled ? 'row-disabled' : '',
                dragOverIdx === idx ? 'drag-over' : '',
                selectedIds.has(a.id) ? 'row-selected' : '',
              ]"
              style="cursor: pointer"
              :draggable="!searchText.trim() && !sortKey"
              @click="toggleSelect(a.id, idx, $event)"
              @dragstart="onDragStart(idx, $event)"
              @dragover.prevent="dragOverIdx = idx"
              @dragleave="dragOverIdx = null"
              @drop.prevent="onDrop(idx)"
              @dragend="dragOverIdx = null"
            >
              <td class="drag-handle" title="Drag to reorder">
                <i class="fa-solid fa-grip-vertical"></i>
              </td>
              <td>
                {{ a.name }}
                <span
                  v-if="a.disabled"
                  class="badge badge-grey"
                  style="margin-left: 6px; font-size: 10px"
                  >{{ t("accounts.disabled") }}</span
                >
                <span
                  v-if="a.appClientId"
                  class="badge badge-blue"
                  style="margin-left: 4px; font-size: 10px"
                  >{{
                    appClientsList.find((c) => c.id === a.appClientId)?.name ??
                    a.appClientId
                  }}</span
                >
                <span
                  v-if="a.proxyId"
                  class="badge"
                  :class="accountProxyUsable(a.proxyId) ? 'badge-purple' : 'badge-red'"
                  :title="accountProxyUsable(a.proxyId) ? undefined : t('accounts.proxyNoTelegramHint')"
                  style="margin-left: 4px; font-size: 10px"
                  ><i
                    class="fa-solid fa-shield-halved"
                    style="margin-right: 3px"
                  ></i
                  >{{
                    proxiesList.find((p) => p.id === a.proxyId)?.name ?? "Proxy"
                  }}</span
                >
                <div
                  v-if="a.resolvedDeviceModel"
                  class="device-model-preview"
                  :title="t('accounts.deviceModelPreview')"
                >
                  <i class="fa-solid fa-mobile-screen"></i>
                  {{ a.resolvedDeviceModel }}
                </div>
              </td>
              <td>
                {{ a.phoneNumber }}
                <div
                  v-if="phoneCountry(a.phoneNumber)"
                  class="phone-country"
                  :title="phoneCountry(a.phoneNumber)!.name"
                >
                  <span class="phone-country-flag">{{
                    phoneCountry(a.phoneNumber)!.flag
                  }}</span>
                  {{ phoneCountry(a.phoneNumber)!.name }}
                </div>
              </td>
              <td class="col-hide-mobile">
                <div class="tg-name-cell">
                  <span v-if="metaLoading.has(a.id)" class="tg-name-loading">
                    <span class="spinner-xs"></span>
                  </span>
                  <template v-else-if="a.tgDisplayName">
                    <span class="tg-name-text">{{ a.tgDisplayName }}</span>
                    <span v-if="a.tgUsername" class="tg-name-username"
                      >@{{ a.tgUsername }}</span
                    >
                  </template>
                  <button
                    v-if="a.authStatus === 'authenticated'"
                    class="btn btn-xs btn-ghost btn-icon tg-name-refresh"
                    :disabled="metaLoading.has(a.id)"
                    title="Refresh TG name"
                    @click.stop="fetchMeta(a.id)"
                  >
                    <i class="fa-solid fa-arrows-rotate"></i>
                  </button>
                </div>
              </td>
              <td>
                <span :class="statusBadge(a.authStatus)">{{
                  t(`accounts.status.${a.authStatus}`)
                }}</span>
                <span
                  v-if="spamCheckLoading.has(a.id)"
                  class="badge badge-grey"
                  style="margin-left: 6px"
                >
                  <i
                    class="fa-solid fa-spinner fa-spin"
                    style="margin-right: 3px"
                  ></i
                  >{{ t("accounts.spamChecking") }}
                </span>
                <span
                  v-else-if="spamStatuses.get(a.id)"
                  :class="spamBadgeClass(spamStatuses.get(a.id)!.spamStatus)"
                  :title="spamStatuses.get(a.id)!.rawMessage"
                  style="margin-left: 6px; cursor: help"
                >
                  <i
                    class="fa-solid fa-shield-halved"
                    style="margin-right: 3px"
                  ></i
                  >{{
                    t(`accounts.spam.${spamStatuses.get(a.id)!.spamStatus}`)
                  }}
                </span>
              </td>
              <td :class="extraColClass" style="max-width: 220px; white-space: pre-wrap; word-break: break-word">
                <div
                  v-if="accountExtraInfo(a).length"
                  style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px"
                >
                  <span
                    v-for="b in accountExtraInfo(a)"
                    :key="b.label"
                    class="badge"
                    :class="b.cls"
                    :title="b.title"
                    :style="{ fontSize: '10px', cursor: b.reveal ? 'pointer' : '' }"
                    @click.stop="b.reveal ? toggleEmailReveal(a) : undefined"
                    >{{ b.label }}</span
                  >
                </div>
                <div
                  v-if="revealedEmails.has(a.id) && accountLoginEmail(a)"
                  class="revealed-email"
                  @click.stop
                >
                  {{ accountLoginEmail(a) }}
                </div>
                <span v-if="a.notes">{{ a.notes }}</span>
              </td>
              <td class="col-hide-mobile">{{ fmtDate(a.createdAt) }}</td>
              <td @click.stop>
                <!-- desktop: icon buttons -->
                <div class="actions hide-mobile">
                  <button
                    v-if="a.authStatus !== 'authenticated'"
                    class="btn btn-sm btn-primary btn-icon"
                    :title="t('accounts.authenticate')"
                    @click="openAuth(a)"
                  >
                    <i class="fa-solid fa-key"></i>
                  </button>
                  <button
                    v-if="a.authStatus === 'authenticated' && !a.disabled"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('accounts.openInMessenger')"
                    @click="openMessengerFor(a.id)"
                  >
                    <i class="fa-brands fa-telegram"></i>
                  </button>
                  <button
                    v-if="a.authStatus === 'authenticated'"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('accounts.checkStatus')"
                    @click="openCheckStatus(a)"
                  >
                    <i class="fa-solid fa-circle-info"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="
                      a.disabled
                        ? t('accounts.enableAccount')
                        : t('accounts.disableAccount')
                    "
                    @click="toggleDisabled(a)"
                  >
                    <i
                      :class="
                        a.disabled
                          ? 'fa-solid fa-circle-play'
                          : 'fa-solid fa-ban'
                      "
                    ></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('common.edit')"
                    @click="openEdit(a)"
                  >
                    <i class="fa-solid fa-pen"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-danger btn-icon"
                    :title="t('common.delete')"
                    @click="remove(a.id)"
                  >
                    <i class="fa-solid fa-trash"></i>
                  </button>
                </div>
                <!-- mobile: ... opens action sheet -->
                <button
                  class="btn btn-sm btn-ghost btn-icon show-mobile"
                  @click="actionMenuAccount = a"
                >
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Bulk notes modal -->
    <div v-if="showBulkNotes" class="modal-backdrop">
      <div class="modal" style="max-width: 420px">
        <h3 class="modal-title">
          {{ t("accounts.bulkNotesTitle") }} ({{ selectedIds.size }})
        </h3>
        <div class="form-group">
          <label class="form-label">{{ t("accounts.labelNotes") }}</label>
          <textarea
            v-model="bulkNotesText"
            class="form-input"
            rows="4"
            :placeholder="t('accounts.notesPlaceholder')"
            style="resize: vertical"
          ></textarea>
        </div>
        <div class="modal-actions">
          <button
            class="btn btn-ghost"
            :disabled="bulkNotesSaving"
            @click="showBulkNotes = false"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="bulkNotesSaving"
            @click="saveBulkNotes"
          >
            {{ bulkNotesSaving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Bulk rename modal -->
    <div v-if="showBulkRename" class="modal-backdrop">
      <div class="modal" style="max-width: 460px">
        <h3 class="modal-title">
          {{ t("accounts.bulkRename.title") }} ({{ bulkRenameTargets.length }})
        </h3>
        <div class="bulk-add-options-row">
          <div class="form-group" style="flex: 2">
            <label class="form-label">{{
              t("accounts.bulkRename.formatLabel")
            }}</label>
            <input v-model="bulkRenameForm.format" class="form-input" />
            <div class="form-hint">{{ t("accounts.bulkRename.formatHint") }}</div>
          </div>
        </div>
        <div class="bulk-add-options-row">
          <div class="form-group">
            <label class="form-label">{{
              t("accounts.bulkRename.startLabel")
            }}</label>
            <input
              v-model.number="bulkRenameForm.startIndex"
              type="number"
              class="form-input"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("accounts.bulkRename.digitsLabel")
            }}</label>
            <input
              v-model.number="bulkRenameForm.indexDigits"
              type="number"
              min="0"
              max="9"
              class="form-input"
            />
            <div class="form-hint">{{ t("accounts.bulkRename.digitsHint") }}</div>
          </div>
        </div>
        <div v-if="bulkRenamePreview.length" class="form-group">
          <label class="form-label">{{
            t("accounts.bulkRename.previewLabel")
          }}</label>
          <div class="bulk-rename-preview">
            <div
              v-for="(p, i) in bulkRenamePreview"
              :key="i"
              class="bulk-rename-preview-row"
            >
              <span class="bulk-rename-old">{{ p.old }}</span>
              <i class="fa-solid fa-arrow-right"></i>
              <span class="bulk-rename-new">{{ p.next }}</span>
            </div>
            <div v-if="bulkRenameTargets.length > bulkRenamePreview.length" class="form-hint">
              …{{ bulkRenameTargets.length - bulkRenamePreview.length }}
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button
            class="btn btn-ghost"
            :disabled="bulkRenameSaving"
            @click="showBulkRename = false"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="bulkRenameSaving || !bulkRenameTargets.length"
            @click="saveBulkRename"
          >
            {{ bulkRenameSaving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Export warning modal -->
    <div v-if="showExportWarn" class="modal-backdrop">
      <div class="modal" style="max-width: 460px">
        <h3 class="modal-title">
          <i
            class="fa-solid fa-triangle-exclamation"
            style="color: #f59e0b; margin-right: 8px"
          ></i
          >{{ t("accounts.exportWarnTitle") }}
        </h3>
        <div class="warn-box">{{ t("accounts.exportWarnBody") }}</div>
        <p style="font-size: 13px; color: #555; margin-top: 12px">
          {{
            selectedIds.size > 0
              ? locale === "zh"
                ? `将导出 ${selectedIds.size} 个账户`
                : `Exporting ${selectedIds.size} account(s)`
              : locale === "zh"
                ? `将导出全部 ${total} 个账户`
                : `Exporting all ${total} account(s)`
          }}
        </p>
        <div class="form-group" style="margin-top: 12px">
          <label class="form-label">{{
            t("accounts.exportSecretLabel")
          }}</label>
          <div class="input-with-toggle">
            <input
              v-model="exportSecret"
              :type="showExportSecret ? 'text' : 'password'"
              class="form-input"
              :placeholder="t('accounts.exportSecretPlaceholder')"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="toggle-secret-btn"
              @click="showExportSecret = !showExportSecret"
            >
              <i
                :class="
                  showExportSecret ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'
                "
              ></i>
            </button>
          </div>
          <p style="font-size: 11px; color: #888; margin: 4px 0 0">
            {{ t("accounts.exportSecretHint") }}
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showExportWarn = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" @click="confirmExport">
            <i class="fa-solid fa-download"></i> {{ t("common.download") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Import modal -->
    <div v-if="showImport" class="modal-backdrop">
      <div class="modal" style="max-width: 480px">
        <h3 class="modal-title">{{ t("accounts.importTitle") }}</h3>
        <div class="warn-box">{{ t("accounts.importWarnBody") }}</div>
        <div class="form-group" style="margin-top: 16px">
          <label class="form-label">{{ t("accounts.importFileLabel") }}</label>
          <input
            ref="importFileEl"
            type="file"
            accept=".json,application/json"
            class="form-input"
            @change="onImportFile"
          />
        </div>
        <div v-if="importFileEncrypted" class="form-group">
          <label class="form-label">{{
            t("accounts.importSecretLabel")
          }}</label>
          <div class="input-with-toggle">
            <input
              v-model="importSecret"
              :type="showImportSecret ? 'text' : 'password'"
              class="form-input"
              :placeholder="t('accounts.importSecretPlaceholder')"
              autocomplete="current-password"
            />
            <button
              type="button"
              class="toggle-secret-btn"
              @click="showImportSecret = !showImportSecret"
            >
              <i
                :class="
                  showImportSecret ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'
                "
              ></i>
            </button>
          </div>
        </div>
        <div class="form-group" style="margin-top: 12px">
          <label class="form-check">
            <input type="checkbox" v-model="importForceReauth" />
            <span>{{ t("accounts.forceReauthLabel") }}</span>
          </label>
          <div class="form-hint">{{ t("accounts.forceReauthHint") }}</div>
          <div
            v-if="!importForceReauth"
            class="warn-box"
            style="margin-top: 8px"
          >
            {{ t("accounts.forceReauthRisk") }}
          </div>
        </div>
        <div v-if="importError" class="error-msg">{{ importError }}</div>
        <div v-if="importResult" class="success-msg">{{ importResult }}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showImport = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="!importReady || importBusy"
            @click="doImport"
          >
            <i class="fa-solid fa-file-import"></i>
            {{
              importBusy ? t("accounts.importDoing") : t("accounts.importBtn")
            }}
          </button>
        </div>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal">
        <h3 class="modal-title">
          {{ t(editTarget ? "accounts.editTitle" : "accounts.addTitle") }}
          <span v-if="editTarget" class="modal-title-ids" :title="t('common.dbIdsHint')">{{
            `{tgId} ${editTarget.id}`
          }}</span>
        </h3>

        <!-- Tabs: only shown when editing an authenticated account -->
        <div
          v-if="editTarget?.authStatus === 'authenticated'"
          class="edit-tabs"
        >
          <button
            :class="['edit-tab', editTab === 'basic' ? 'active' : '']"
            @click="editTab = 'basic'"
          >
            {{ t("accounts.tabBasic") }}
          </button>
          <button
            :class="['edit-tab', editTab === 'profile' ? 'active' : '']"
            @click="editTab = 'profile'"
          >
            {{ t("accounts.tabProfile") }}
          </button>
          <button
            :class="['edit-tab', editTab === 'twofa' ? 'active' : '']"
            @click="editTab = 'twofa'"
          >
            {{ t("accounts.tab2fa") }}
          </button>
          <button
            :class="['edit-tab', editTab === 'devices' ? 'active' : '']"
            @click="editTab = 'devices'"
          >
            {{ t("accounts.tabDevices") }}
          </button>
          <button
            :class="['edit-tab', editTab === 'others' ? 'active' : '']"
            @click="editTab = 'others'"
          >
            {{ t("accounts.tabOthers") }}
          </button>
        </div>

        <div class="modal-body">
        <!-- Basic tab -->
        <div v-show="editTab === 'basic'">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelName") }}</label>
            <input
              v-model.trim="form.name"
              class="form-input"
              placeholder="e.g. My Account"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelPhone") }}</label>
            <input
              v-model.trim="form.phoneNumber"
              class="form-input"
              placeholder="+61412345678"
            />
          </div>
          <div class="form-group" style="max-width: 140px">
            <label class="form-label">
              {{
                hasGlobalTgCreds
                  ? t("accounts.apiIdOptional")
                  : t("accounts.labelApiId")
              }}
            </label>
            <input v-model.trim="form.apiId" class="form-input" type="number" />
          </div>
          <div class="form-group">
            <label class="form-label">
              {{
                hasGlobalTgCreds
                  ? t("accounts.apiHashOptional")
                  : t("accounts.labelApiHash")
              }}
            </label>
            <input
              v-model.trim="form.apiHash"
              class="form-input"
              :placeholder="
                hasGlobalTgCreds ? t('accounts.apiHashOptional') : '32-char hex'
              "
              style="font-family: monospace"
            />
          </div>
          <p
            v-if="hasGlobalTgCreds"
            style="
              font-size: 12px;
              color: #2ec4b6;
              margin-top: -8px;
              margin-bottom: 14px;
            "
          >
            <i class="fa-solid fa-circle-info" style="margin-right: 4px"></i
            >{{ t("accounts.apiOptionalHint") }}
          </p>
          <p
            v-else
            style="
              font-size: 12px;
              color: #888;
              margin-top: -8px;
              margin-bottom: 14px;
            "
          >
            {{ t("accounts.apiHint") }}
            <a href="https://my.telegram.org/apps" target="_blank"
              >my.telegram.org/apps</a
            >
          </p>
          <div v-if="proxiesList.length" class="form-group">
            <label class="form-label">{{ t("accounts.labelProxy") }}</label>
            <select v-model="form.proxyId" class="form-select">
              <option value="">{{ t("accounts.proxyNone") }}</option>
              <option
                v-for="p in proxiesList"
                :key="p.id"
                :value="p.id"
                :disabled="!proxySupportsTelegram(p.url)"
              >
                {{ p.name
                }}{{
                  proxySupportsTelegram(p.url)
                    ? ""
                    : ` (${proxyScheme(p.url) ?? "?"} — ${t("accounts.proxyNoTelegram")})`
                }}
              </option>
            </select>
            <div v-if="hasNonTgProxies" class="form-hint">
              {{ t("accounts.proxyNoTelegramHint") }}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelAppClient") }}</label>
            <select v-model="form.appClientId" class="form-select">
              <option value="">
                {{
                  tgClientMode === "random"
                    ? t("accounts.appClientRandom")
                    : `${t("accounts.appClientDefault")}${defaultClientName ? ` (${defaultClientName})` : ""}`
                }}
              </option>
              <option v-for="c in appClientsList" :key="c.id" :value="c.id">
                {{ c.name }}
              </option>
            </select>
            <div v-if="deviceModelPreview" class="device-model-preview-form">
              <i class="fa-solid fa-mobile-screen"></i>
              <span class="dmp-label"
                >{{ t("accounts.deviceModelPreview") }}:</span
              >
              <span class="dmp-value">{{ deviceModelPreview }}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelNotes") }}</label>
            <textarea
              v-model="form.notes"
              class="form-input"
              rows="3"
              :placeholder="t('accounts.notesPlaceholder')"
              style="resize: vertical"
            ></textarea>
          </div>
        </div>

        <!-- Profile tab (authenticated accounts only) -->
        <div
          v-if="editTarget?.authStatus === 'authenticated'"
          v-show="editTab === 'profile'"
        >
          <div class="form-section-label" style="margin-bottom: 12px">
            {{ t("accounts.profileSection") }}
          </div>

          <div class="avatar-row">
            <div class="avatar-frame">
              <i v-if="avatarLoading" class="fa-solid fa-spinner fa-spin"></i>
              <img v-else-if="avatarUrl" :src="avatarUrl" alt="" />
              <i v-else class="fa-solid fa-user avatar-placeholder"></i>
            </div>
            <div class="avatar-actions">
              <button
                class="btn btn-secondary btn-sm"
                :disabled="avatarBusy || avatarLoading"
                @click="avatarInput?.click()"
              >
                <i
                  :class="
                    avatarBusy
                      ? 'fa-solid fa-spinner fa-spin'
                      : 'fa-solid fa-image'
                  "
                ></i>
                {{ t("accounts.avatarUpload") }}
              </button>
              <div class="form-hint">{{ t("accounts.avatarHint") }}</div>
            </div>
            <input
              ref="avatarInput"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style="display: none"
              @change="onAvatarPicked"
            />
          </div>
          <div v-if="avatarError" class="error-msg">{{ avatarError }}</div>

          <div
            v-if="profileLoading"
            style="color: #888; font-size: 13px; margin-bottom: 12px"
          >
            <i class="fa-solid fa-spinner fa-spin"></i> {{ t("common.loading") }}
          </div>

          <template v-else>
            <div class="form-group">
              <label class="form-label">
                {{ t("accounts.profileFirstName") }}
              </label>
              <input
                v-model.trim="profileForm.firstName"
                class="form-input"
                maxlength="64"
              />
            </div>
            <div class="form-group">
              <label class="form-label">
                {{ t("accounts.profileLastName") }}
              </label>
              <input
                v-model.trim="profileForm.lastName"
                class="form-input"
                maxlength="64"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.profileBio") }}</label>
              <textarea
                v-model="profileForm.about"
                class="form-input"
                rows="3"
                maxlength="70"
                :placeholder="t('accounts.profileBioPlaceholder')"
                style="resize: vertical"
              ></textarea>
            </div>

            <div v-if="profileError" class="error-msg">{{ profileError }}</div>
            <div v-if="profileMsg" class="success-msg">{{ profileMsg }}</div>

            <button
              class="btn btn-primary btn-inline"
              :disabled="profileBusy || !profileForm.firstName"
              @click="doUpdateProfile"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ profileBusy ? t("common.saving") : t("common.save") }}
            </button>

            <!-- Username: its own Telegram call, so its own save and errors -->
            <div class="form-section-label" style="margin: 22px 0 12px">
              {{ t("accounts.usernameSection") }}
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.usernameLabel") }}</label>
              <div class="username-row">
                <span class="username-at">@</span>
                <input
                  v-model.trim="usernameValue"
                  class="form-input"
                  maxlength="32"
                  :placeholder="t('accounts.usernamePlaceholder')"
                  @input="usernameAvailable = null; usernameError = ''"
                />
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="
                    usernameChecking || !usernameLooksValid || !usernameChanged
                  "
                  @click="checkUsernameAvailable"
                >
                  <i
                    :class="
                      usernameChecking
                        ? 'fa-solid fa-spinner fa-spin'
                        : 'fa-solid fa-magnifying-glass'
                    "
                  ></i>
                  {{ t("accounts.usernameCheck") }}
                </button>
              </div>
              <div class="form-hint">{{ t("accounts.usernameHint") }}</div>
            </div>

            <div v-if="usernameAvailable === true" class="success-msg">
              <i class="fa-solid fa-check"></i> {{ t("accounts.usernameFree") }}
            </div>
            <!-- Telegram answers a taken handle with a plain false and no reason, so
                 this case needs a message of its own or the check looks like it did nothing -->
            <div v-else-if="usernameAvailable === false" class="error-msg">
              {{ usernameError || t("accounts.usernameTaken") }}
            </div>
            <div v-else-if="usernameError" class="error-msg">{{ usernameError }}</div>
            <div v-if="usernameMsg" class="success-msg">{{ usernameMsg }}</div>

            <button
              class="btn btn-primary btn-inline"
              :disabled="
                usernameBusy ||
                !usernameChanged ||
                (usernameNormalised !== '' && !usernameLooksValid)
              "
              @click="doUpdateUsername"
            >
              <i class="fa-solid fa-at"></i>
              {{
                usernameBusy
                  ? t("common.saving")
                  : usernameNormalised
                    ? t("accounts.usernameSave")
                    : t("accounts.usernameClear")
              }}
            </button>
          </template>
        </div>

        <!-- 2FA tab (authenticated accounts only) -->
        <div
          v-if="editTarget?.authStatus === 'authenticated'"
          v-show="editTab === 'twofa'"
        >
          <div class="form-section-label" style="margin-bottom: 12px">
            {{ t("accounts.twoFaSection") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("accounts.twoFaCurrentPassword")
            }}</label>
            <p class="form-hint">
              {{ t("accounts.twoFaCurrentPasswordHint") }}
            </p>
            <input
              v-model="twoFaCurrentPwd"
              type="password"
              class="form-input"
              autocomplete="current-password"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("accounts.twoFaNewPassword")
            }}</label>
            <p class="form-hint">{{ t("accounts.twoFaNewPasswordHint") }}</p>
            <input
              v-model="twoFaNewPwd"
              type="password"
              class="form-input"
              autocomplete="new-password"
            />
          </div>
          <div v-if="twoFaNewPwd" class="form-group">
            <label class="form-label">{{
              t("accounts.twoFaNewPasswordConfirm")
            }}</label>
            <input
              v-model="twoFaNewPwdConfirm"
              type="password"
              class="form-input"
              autocomplete="new-password"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.twoFaHint") }}</label>
            <input v-model="twoFaHint" class="form-input" />
          </div>
          <div v-if="twoFaError" class="error-msg">{{ twoFaError }}</div>
          <div v-if="twoFaMsg" class="success-msg">{{ twoFaMsg }}</div>
          <button
            class="btn btn-secondary btn-inline"
            :disabled="twoFaBusy"
            @click="doUpdateTwoFa"
          >
            <i class="fa-solid fa-lock"></i>
            {{ twoFaBusy ? t("common.saving") : t("accounts.twoFaUpdate") }}
          </button>
        </div>

        <!-- Devices tab (authenticated accounts only) -->
        <div
          v-if="editTarget?.authStatus === 'authenticated'"
          v-show="editTab === 'devices'"
        >
          <div class="sessions-header">
            <div class="form-section-label">
              {{ t("accounts.sessionsSection") }}
            </div>
            <button
              class="btn btn-xs btn-ghost"
              :disabled="sessionsLoading"
              @click="loadSessions"
            >
              <i
                class="fa-solid fa-arrows-rotate"
                :class="sessionsLoading ? 'fa-spin' : ''"
              ></i>
              {{ t("accounts.sessionsRefresh") }}
            </button>
          </div>

          <div
            v-if="sessionsLoading && !sessions.length"
            class="sessions-empty"
          >
            <i class="fa-solid fa-spinner fa-spin"></i>
            {{ t("accounts.sessionsLoading") }}
          </div>
          <div v-if="sessionsError" class="error-msg">{{ sessionsError }}</div>
          <div v-if="terminateError" class="error-msg">
            {{ terminateError }}
          </div>
          <div v-if="terminateMsg" class="success-msg">{{ terminateMsg }}</div>

          <div class="sessions-list">
            <div
              v-for="s in sessions"
              :key="s.hash"
              :class="['session-item', s.current ? 'session-current' : '']"
            >
              <div class="session-info">
                <div class="session-device">
                  {{ s.deviceModel }}
                  <span
                    v-if="s.current"
                    class="badge badge-green"
                    style="font-size: 10px; margin-left: 6px"
                    >{{ t("accounts.sessionsCurrent") }}</span
                  >
                </div>
                <div class="session-meta">
                  {{ s.appName }} · {{ s.ip }} · {{ s.country }}
                </div>
                <div class="session-meta">
                  {{ t("accounts.sessionsLastActive") }}:
                  {{ fmtSessionDate(s.dateActive) }}
                </div>
              </div>
              <button
                v-if="!s.current"
                class="btn btn-xs btn-danger"
                :disabled="terminatingHash === s.hash"
                @click="doTerminateSession(s.hash)"
              >
                {{
                  terminatingHash === s.hash
                    ? t("accounts.sessionTerminating")
                    : t("accounts.sessionTerminate")
                }}
              </button>
            </div>
          </div>

          <div v-if="sessions.length > 1" style="margin-top: 10px">
            <button
              class="btn btn-ghost btn-inline"
              :disabled="terminateBusy"
              @click="doTerminateAllSessions"
            >
              <i class="fa-solid fa-right-from-bracket"></i>
              {{
                terminateBusy
                  ? t("common.saving")
                  : t("accounts.terminateSessions")
              }}
            </button>
          </div>

        </div>

        <!-- Login email tab (authenticated accounts only) -->
        <div
          v-if="editTarget?.authStatus === 'authenticated'"
          v-show="editTab === 'others'"
        >
          <!-- Login email section -->
          <div class="form-section-label" style="margin-bottom: 12px">
            {{ t("accounts.loginEmailSection") }}
          </div>

          <div v-if="pwdInfoLoading" style="color: #888; font-size: 13px; margin-bottom: 12px">
            <i class="fa-solid fa-spinner fa-spin"></i> {{ t("common.loading") }}
          </div>

          <template v-else-if="pwdInfo">
            <!-- Status row: masked pattern comes straight from getPassword -->
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap">
              <span class="badge" :class="pwdInfo.loginEmailPattern ? 'badge-green' : 'badge-grey'">
                {{ pwdInfo.loginEmailPattern ? t("accounts.loginEmailSet") : t("accounts.loginEmailNone") }}
              </span>
              <span v-if="pwdInfo.loginEmailPattern" style="font-size: 13px; font-family: monospace">
                {{ pwdInfo.loginEmailPattern }}
              </span>
              <span v-if="loginEmailPendingConfirm" class="badge badge-orange">
                {{ t("accounts.loginEmailPending") }}
              </span>
            </div>

            <!-- Pending confirmation flow -->
            <template v-if="loginEmailPendingConfirm">
              <p class="form-hint" style="margin-bottom: 8px">
                {{
                  t("accounts.loginEmailPendingHint").replace(
                    "{pattern}",
                    loginEmailNewPattern || "?"
                  )
                }}
              </p>
              <div class="form-group">
                <label class="form-label">{{ t("accounts.loginEmailConfirmCode") }}</label>
                <input v-model="loginEmailCode" class="form-input" maxlength="12" />
              </div>
              <div v-if="loginEmailError" class="error-msg">{{ loginEmailError }}</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button
                  class="btn btn-primary btn-inline"
                  :disabled="loginEmailBusy || !loginEmailCode"
                  @click="doVerifyLoginEmail"
                >
                  {{ loginEmailBusy ? t("common.saving") : t("accounts.loginEmailConfirm") }}
                </button>
                <button
                  class="btn btn-ghost btn-inline"
                  :disabled="loginEmailBusy"
                  @click="doResendLoginEmailCode"
                >
                  {{ t("accounts.loginEmailResend") }}
                </button>
                <button
                  class="btn btn-ghost btn-inline"
                  :disabled="loginEmailBusy"
                  @click="cancelLoginEmailChange"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </template>

            <!-- Change / set form -->
            <template v-else-if="loginEmailChangeMode">
              <div class="form-group">
                <label class="form-label">{{ t("accounts.loginEmailNewEmail") }}</label>
                <input v-model="loginEmailNew" type="email" class="form-input" />
              </div>
              <div v-if="loginEmailError" class="error-msg">{{ loginEmailError }}</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button
                  class="btn btn-primary btn-inline"
                  :disabled="loginEmailBusy || !loginEmailNew"
                  @click="doSendLoginEmailCode"
                >
                  {{ loginEmailBusy ? t("common.saving") : t("accounts.loginEmailSendCode") }}
                </button>
                <button class="btn btn-ghost btn-inline" @click="loginEmailChangeMode = false">
                  {{ t("common.cancel") }}
                </button>
              </div>
            </template>

            <!-- Idle: action buttons -->
            <template v-else>
              <div v-if="loginEmailMsg" class="success-msg" style="margin-bottom: 8px">{{ loginEmailMsg }}</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button class="btn btn-secondary btn-inline" @click="openChangeLoginEmail">
                  <i class="fa-solid fa-envelope"></i>
                  {{ pwdInfo.loginEmailPattern ? t("accounts.loginEmailChange") : t("accounts.loginEmailSet2") }}
                </button>
              </div>
              <p class="form-hint" style="margin-top: 10px">
                {{ pwdInfo.loginEmailPattern ? t("accounts.loginEmailNoRemoveHint") : t("accounts.loginEmailSetupHint") }}
              </p>
            </template>
          </template>

          <hr class="section-divider" />

          <!-- Passkeys section -->
          <div class="form-section-label" style="margin-bottom: 8px">
            {{ t("accounts.passkeySection") }}
          </div>

          <div v-if="passkeysLoading" style="color: #888; font-size: 13px">
            <i class="fa-solid fa-spinner fa-spin"></i> {{ t("common.loading") }}
          </div>
          <div v-else-if="passkeysError" class="error-msg">
            {{ passkeysError }}
          </div>
          <template v-else>
            <p v-if="!passkeys.length" class="form-hint">
              {{ t("accounts.passkeyNone") }}
            </p>
            <div v-else class="sessions-list">
              <div
                v-for="pk in passkeys"
                :key="pk.id"
                class="session-item"
              >
                <div class="session-info">
                  <div class="session-device">
                    <i class="fa-solid fa-key" style="margin-right: 6px"></i>
                    {{ pk.name || t("accounts.passkeyUnnamed") }}
                  </div>
                  <div class="session-meta">
                    {{ t("accounts.passkeyAdded") }}:
                    {{ fmtSessionDate(pk.date) }}
                  </div>
                  <div v-if="pk.lastUsageDate" class="session-meta">
                    {{ t("accounts.passkeyLastUsed") }}:
                    {{ fmtSessionDate(pk.lastUsageDate) }}
                  </div>
                </div>
                <div style="display: flex; gap: 6px">
                  <button
                    v-if="passkeyStoredIds.includes(pk.id)"
                    class="btn btn-xs btn-secondary"
                    :disabled="verifyingPasskeyId === pk.id"
                    @click="doVerifyPasskey(pk)"
                  >
                    {{
                      verifyingPasskeyId === pk.id
                        ? t("accounts.passkeyVerifying")
                        : t("accounts.passkeyVerify")
                    }}
                  </button>
                  <button
                    class="btn btn-xs btn-danger"
                    :disabled="deletingPasskeyId === pk.id"
                    @click="doDeletePasskey(pk)"
                  >
                    {{
                      deletingPasskeyId === pk.id
                        ? t("accounts.passkeyDeleting")
                        : t("accounts.passkeyRemove")
                    }}
                  </button>
                </div>
              </div>
            </div>
            <button
              class="btn btn-sm btn-secondary"
              style="margin-top: 8px"
              :disabled="addingPasskey"
              @click="doAddPasskey"
            >
              <i class="fa-solid fa-plus" style="margin-right: 6px"></i>
              {{ addingPasskey ? t("accounts.passkeyAdding") : t("accounts.passkeyAdd") }}
            </button>
            <p class="form-hint" style="margin-top: 6px">
              {{ t("accounts.passkeyAddHint") }}
            </p>
          </template>
        </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <template v-if="editTab === 'basic'">
            <button
              v-if="editTarget && editTarget.authStatus !== 'unauthenticated'"
              class="btn btn-danger"
              :disabled="forceReauthBusy"
              @click="doForceReauth"
              style="margin-right: auto"
            >
              <i class="fa-solid fa-rotate-right"></i>
              {{
                forceReauthBusy ? t("common.saving") : t("accounts.forceReauth")
              }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="saving"
              @click="saveAccount"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ saving ? t("common.saving") : t("common.save") }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Account status modal -->
    <div v-if="showStatus" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">
          {{ t("accounts.checkStatusTitle") }} — {{ statusTarget?.name }}
        </h3>
        <div class="modal-body">
          <div
            v-if="statusChecking"
            style="text-align: center; padding: 24px 0; color: #888"
          >
            <i class="fa-solid fa-spinner fa-spin"></i>
            {{ t("accounts.checking") }}
          </div>
          <div v-else-if="statusError" class="error-msg">{{ statusError }}</div>
          <template v-else-if="statusResult">
            <div class="status-row">
              <span class="status-label">{{ t("accounts.colStatus") }}</span>
              <span v-if="statusResult.isDeleted" class="badge badge-red">{{
                t("accounts.statusDeleted")
              }}</span>
              <span
                v-else-if="statusResult.isRestricted"
                class="badge badge-orange"
                >{{ t("accounts.statusRestricted") }}</span
              >
              <span v-else class="badge badge-green">{{
                t("accounts.statusActive")
              }}</span>
            </div>
            <div
              v-if="statusResult.firstName || statusResult.lastName"
              class="status-row"
            >
              <span class="status-label">{{
                t("accounts.statusDisplayName")
              }}</span>
              <span>{{
                [statusResult.firstName, statusResult.lastName]
                  .filter(Boolean)
                  .join(" ")
              }}</span>
            </div>
            <div v-if="statusResult.username" class="status-row">
              <span class="status-label">{{
                t("accounts.statusUsername")
              }}</span>
              <span>@{{ statusResult.username }}</span>
            </div>
            <div v-if="statusResult.phone" class="status-row">
              <span class="status-label">{{ t("accounts.statusPhone") }}</span>
              <span>+{{ statusResult.phone }}</span>
            </div>
            <div
              v-if="statusResult.restrictions.length"
              style="margin-top: 12px"
            >
              <div class="status-label" style="margin-bottom: 6px">
                {{ t("accounts.statusRestrictions") }}
              </div>
              <div
                v-for="r in statusResult.restrictions"
                :key="r.platform + r.reason"
                class="restriction-item"
              >
                <span class="badge badge-orange" style="margin-right: 6px">{{
                  r.platform
                }}</span>
                <span style="font-size: 12px; color: #555">{{
                  r.text || r.reason
                }}</span>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showStatus = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Bulk add modal -->
    <div v-if="showBulkAdd" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">{{ t("accounts.bulkAdd.title") }}</h3>

        <!-- Input step -->
        <template v-if="!bulkBatch">
          <p class="bulk-add-hint">{{ t("accounts.bulkAdd.hint") }}</p>
          <div v-if="bulkAddError" class="error-msg">{{ bulkAddError }}</div>
          <div class="form-group">
            <textarea
              v-model="bulkAddText"
              class="form-input bulk-add-textarea"
              :placeholder="bulkAddPlaceholder"
              rows="12"
              spellcheck="false"
            ></textarea>
          </div>

          <div class="bulk-add-options">
            <div class="form-section-label">
              {{ t("accounts.bulkAdd.optionsTitle") }}
            </div>
            <div class="bulk-add-options-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.gapLabel")
                }}</label>
                <input
                  v-model.number="bulkOptions.gapSeconds"
                  type="number"
                  min="0"
                  class="form-input"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.namePrefixLabel")
                }}</label>
                <input v-model="bulkOptions.namePrefix" class="form-input" />
              </div>
            </div>
            <div class="bulk-add-options-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.maxRetriesLabel")
                }}</label>
                <input
                  v-model.number="bulkOptions.maxRetries"
                  type="number"
                  min="0"
                  class="form-input"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.retryDelayLabel")
                }}</label>
                <input
                  v-model.number="bulkOptions.retryDelaySeconds"
                  type="number"
                  min="0"
                  class="form-input"
                />
              </div>
            </div>
            <div class="bulk-add-options-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.nameIndexLabel")
                }}</label>
                <select v-model="bulkOptions.nameIndexMode" class="form-select">
                  <option value="total">
                    {{ t("accounts.bulkAdd.nameIndexTotal") }}
                  </option>
                  <option value="batch">
                    {{ t("accounts.bulkAdd.nameIndexBatch") }}
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.namePadLabel")
                }}</label>
                <input
                  v-model.number="bulkOptions.namePadDigits"
                  type="number"
                  min="0"
                  max="9"
                  class="form-input"
                  :placeholder="t('accounts.bulkAdd.namePadAuto')"
                />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("accounts.bulkAdd.notesLabel")
              }}</label>
              <input v-model="bulkOptions.notesTemplate" class="form-input" />
              <div class="form-hint">{{ t("accounts.bulkAdd.notesHint") }}</div>
            </div>
            <div class="bulk-add-options-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.devicesLabel")
                }}</label>
                <select
                  v-model="bulkOptions.deviceIds"
                  multiple
                  class="form-select bulk-add-multiselect"
                >
                  <option
                    v-for="c in appClientsList"
                    :key="c.id"
                    :value="c.id"
                  >
                    {{ c.name }}
                  </option>
                </select>
                <div class="form-hint">
                  {{ t("accounts.bulkAdd.candidateHint") }}
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.proxiesLabel")
                }}</label>
                <select
                  v-model="bulkOptions.proxyIds"
                  multiple
                  class="form-select bulk-add-multiselect"
                >
                  <option
                    v-for="p in tgProxiesList"
                    :key="p.id"
                    :value="p.id"
                  >
                    {{ p.name }}
                  </option>
                </select>
                <div class="form-hint">
                  {{ t("accounts.bulkAdd.candidateHint") }}
                  <template v-if="hasNonTgProxies">
                    {{ t("accounts.proxyNoTelegramHint") }}
                  </template>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("accounts.bulkAdd.apiCredsLabel")
              }}</label>
              <div
                v-for="(cred, i) in bulkApiCreds"
                :key="i"
                class="bulk-add-cred-row"
              >
                <input
                  v-model="cred.apiId"
                  type="number"
                  min="1"
                  class="form-input"
                  :placeholder="t('accounts.bulkAdd.apiIdPlaceholder')"
                />
                <input
                  v-model="cred.apiHash"
                  class="form-input bulk-add-mono"
                  :placeholder="t('accounts.bulkAdd.apiHashPlaceholder')"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="btn btn-ghost btn-icon"
                  :title="t('common.delete')"
                  @click="removeBulkApiCred(i)"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div class="bulk-add-cred-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="addBulkApiCred"
                >
                  <i class="fa-solid fa-plus"></i>
                  {{ t("accounts.bulkAdd.apiCredAdd") }}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="bulkApiCredsPasteOpen = !bulkApiCredsPasteOpen"
                >
                  <i class="fa-solid fa-paste"></i>
                  {{ t("accounts.bulkAdd.apiCredPaste") }}
                </button>
              </div>
              <template v-if="bulkApiCredsPasteOpen">
                <textarea
                  v-model="bulkApiCredsPasteText"
                  class="form-input bulk-add-mono"
                  rows="5"
                  spellcheck="false"
                  :placeholder="t('accounts.bulkAdd.apiCredPastePlaceholder')"
                ></textarea>
                <div class="bulk-add-cred-actions">
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="!bulkApiCredsPasteText.trim()"
                    @click="applyBulkApiCredsPaste"
                  >
                    {{ t("accounts.bulkAdd.apiCredPasteApply") }}
                  </button>
                </div>
                <div class="form-hint">
                  {{ t("accounts.bulkAdd.apiCredPasteHint") }}
                </div>
              </template>
              <div class="form-hint">{{ t("accounts.bulkAdd.apiCredsHint") }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("accounts.bulkAdd.twoFaModeLabel")
              }}</label>
              <select v-model="bulkOptions.twoFaMode" class="form-select">
                <option value="api">
                  {{ t("accounts.bulkAdd.twoFaFromApi") }}
                </option>
                <option value="fixed">
                  {{ t("accounts.bulkAdd.twoFaFixedMode") }}
                </option>
              </select>
            </div>
            <div v-if="bulkOptions.twoFaMode === 'fixed'" class="form-group">
              <label class="form-label">{{
                t("accounts.bulkAdd.twoFaFixedLabel")
              }}</label>
              <input
                v-model="bulkOptions.twoFaFixed"
                type="password"
                class="form-input"
                autocomplete="new-password"
              />
            </div>
            <label class="form-check">
              <input type="checkbox" v-model="bulkAdvancedRegex" />
              <span>{{ t("accounts.bulkAdd.advancedToggle") }}</span>
            </label>
            <template v-if="!bulkAdvancedRegex">
              <div class="bulk-add-options-row">
                <div class="form-group">
                  <label class="form-label">{{
                    t("accounts.bulkAdd.codeFieldLabel")
                  }}</label>
                  <input v-model="bulkOptions.codeFieldId" class="form-input" />
                </div>
                <div v-if="bulkOptions.twoFaMode === 'api'" class="form-group">
                  <label class="form-label">{{
                    t("accounts.bulkAdd.twoFaFieldLabel")
                  }}</label>
                  <input v-model="bulkOptions.twoFaFieldId" class="form-input" />
                </div>
              </div>
            </template>
            <template v-else>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.codeRegexLabel")
                }}</label>
                <input
                  v-model="bulkOptions.codeRegex"
                  class="form-input bulk-add-mono"
                />
              </div>
              <div v-if="bulkOptions.twoFaMode === 'api'" class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkAdd.twoFaRegexLabel")
                }}</label>
                <input
                  v-model="bulkOptions.twoFaRegex"
                  class="form-input bulk-add-mono"
                />
              </div>
              <div class="form-hint">{{ t("accounts.bulkAdd.regexHint") }}</div>
            </template>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkAdd">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="bulkAddBusy || !bulkAddText.trim()"
              @click="startBulk"
            >
              <i class="fa-solid fa-play"></i>
              {{ t("accounts.bulkAdd.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -->
        <template v-else>
          <div class="bulk-add-progress-head">
            <span>
              {{ t("accounts.bulkAdd.progressLabel") }}:
              {{ bulkDoneCount }} / {{ bulkBatch.total }}
            </span>
            <span
              v-if="bulkBatch.running"
              class="bulk-add-running"
            >
              <i class="fa-solid fa-spinner fa-spin"></i>
              {{ t("accounts.bulkAdd.running") }}
            </span>
            <span v-else class="bulk-add-finished">
              <i class="fa-solid fa-circle-check"></i>
              {{ t("accounts.bulkAdd.finished") }}
            </span>
          </div>
          <div v-if="bulkBatch.running" class="form-hint">
            {{ t("accounts.bulkAdd.minimiseHint") }}
          </div>
          <div class="bulk-add-list">
            <div
              v-for="item in bulkBatch.items"
              :key="item.index"
              class="bulk-add-item"
            >
              <span
                class="bulk-add-status-dot"
                :class="`status-${item.status}`"
              ></span>
              <div class="bulk-add-item-body">
                <div class="bulk-add-item-top">
                  <strong>{{ item.accountName }}</strong>
                  <span class="bulk-add-phone">{{ item.phoneNumber }}</span>
                  <span class="bulk-add-item-status">
                    {{ t(`accounts.bulkAdd.status.${item.status}`) }}
                  </span>
                </div>
                <div
                  v-if="item.error"
                  class="bulk-add-item-msg bulk-add-item-error"
                >
                  {{ item.error }}
                </div>
                <div v-else-if="item.message" class="bulk-add-item-msg">
                  {{ item.message }}
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button
              v-if="bulkBatch.running"
              class="btn btn-ghost"
              @click="closeBulkAdd"
            >
              <i class="fa-solid fa-window-minimize"></i>
              {{ t("accounts.bulkAdd.minimise") }}
            </button>
            <button
              v-if="bulkBatch.running"
              class="btn btn-danger"
              :disabled="bulkAddBusy"
              @click="cancelBulk"
            >
              <i class="fa-solid fa-stop"></i> {{ t("accounts.bulkAdd.cancel") }}
            </button>
            <button v-else class="btn btn-primary" @click="closeBulkAdd">
              <i class="fa-solid fa-check"></i> {{ t("common.close") }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Bulk rename Telegram profile modal -->
    <div v-if="showBulkTgRename" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-address-card" style="margin-right: 8px"></i>
          {{ t("accounts.bulkTgRename.title") }}
        </h3>

        <!-- Config step -->
        <template v-if="!bulkTgRenameBatch">
          <div v-if="!bulkTgRenameTargets.length" class="warn-box">
            {{ t("accounts.bulkTgRename.noTargets") }}
          </div>
          <template v-else>
            <p class="bulk-add-hint">
              {{
                t("accounts.bulkTgRename.intro").replace(
                  "{n}",
                  String(bulkTgRenameTargets.length),
                )
              }}
            </p>
            <div v-if="bulkTgRenameError" class="error-msg">
              {{ bulkTgRenameError }}
            </div>
            <!-- Avatar assignment -->
            <div class="form-group">
              <label class="form-check">
                <input v-model="bulkTgRenameAvatar" type="checkbox" />
                <span>{{ t("accounts.bulkTgRename.avatarLabel") }}</span>
              </label>
              <template v-if="bulkTgRenameAvatar">
                <select
                  v-model="bulkTgRenameAvatarSource"
                  class="form-input"
                  style="margin-top: 6px"
                >
                  <option value="any">
                    {{ t("accounts.bulkTgRename.avatarAny") }}
                  </option>
                  <option value="pool">
                    {{ t("accounts.bulkTgRename.avatarPool") }}
                  </option>
                  <option value="online">
                    {{ t("accounts.bulkTgRename.avatarOnline") }}
                  </option>
                </select>
                <div v-if="avatarPool" class="form-hint">
                  {{ t("accounts.bulkTgRename.avatarPoolCount") }}:
                  <strong>{{ avatarPool.count }}</strong> ({{ avatarPool.dir }})
                  &middot;
                  {{ t("accounts.bulkTgRename.avatarStyles") }}:
                  <strong>{{ avatarPool.styles }}</strong>
                </div>
                <div
                  v-if="
                    bulkTgRenameAvatarSource === 'pool' && avatarPool?.count === 0
                  "
                  class="warn-box"
                  style="margin-top: 6px"
                >
                  {{ t("accounts.bulkTgRename.avatarPoolEmpty") }}
                </div>
              </template>
              <label class="form-check" style="margin-top: 6px">
                <input
                  v-model="bulkTgRenameNamesToo"
                  type="checkbox"
                  :disabled="!bulkTgRenameAvatar && !bulkTgUsername"
                />
                <span>{{ t("accounts.bulkTgRename.namesToo") }}</span>
              </label>
            </div>

            <!-- Username assignment -->
            <div class="form-group">
              <label class="form-check">
                <input v-model="bulkTgUsername" type="checkbox" />
                <span>{{ t("accounts.bulkTgRename.usernameLabel") }}</span>
              </label>
              <template v-if="bulkTgUsername">
                <div class="bulk-add-options-row" style="margin-top: 6px">
                  <div class="form-group">
                    <label class="form-label">{{
                      t("accounts.bulkTgRename.usernameFormat")
                    }}</label>
                    <input
                      v-model.trim="bulkTgUsernameForm.format"
                      class="form-input"
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{
                      t("accounts.bulkRename.startLabel")
                    }}</label>
                    <input
                      v-model.number="bulkTgUsernameForm.startIndex"
                      type="number"
                      class="form-input"
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{
                      t("accounts.bulkRename.digitsLabel")
                    }}</label>
                    <input
                      v-model.number="bulkTgUsernameForm.indexDigits"
                      type="number"
                      min="0"
                      max="9"
                      class="form-input"
                    />
                  </div>
                </div>
                <div class="form-hint">
                  {{ t("accounts.bulkTgRename.usernameHint") }}
                </div>
                <div class="bulk-tgrename-toolbar" style="margin-top: 6px">
                  <button
                    class="btn btn-secondary btn-sm"
                    @click="regenerateBulkUsernames"
                  >
                    <i class="fa-solid fa-rotate"></i>
                    {{ t("accounts.bulkTgRename.usernameReroll") }}
                  </button>
                </div>
                <div v-if="bulkTgUsernameList.length" class="bulk-rename-preview">
                  <div
                    v-for="(u, i) in bulkTgUsernameList.slice(0, 5)"
                    :key="i"
                    class="bulk-rename-preview-row"
                  >
                    <span class="bulk-rename-old">{{
                      bulkTgRenameTargets[i]?.name
                    }}</span>
                    <i class="fa-solid fa-arrow-right"></i>
                    <span class="bulk-rename-new">@{{ u }}</span>
                  </div>
                  <div
                    v-if="bulkTgUsernameList.length > 5"
                    class="form-hint"
                  >
                    …{{ bulkTgUsernameList.length - 5 }}
                  </div>
                </div>
                <div v-if="!bulkTgUsernameValid" class="warn-box" style="margin-top: 6px">
                  {{ t("accounts.bulkTgRename.usernameInvalid") }}
                </div>
              </template>
            </div>

            <div v-show="bulkTgRenameNamesToo" class="form-group">
              <div class="bulk-tgrename-toolbar">
                <label class="form-label" style="margin: 0">{{
                  t("accounts.bulkTgRename.valuesLabel")
                }}</label>
                <button
                  class="btn btn-secondary btn-sm"
                  @click="generateBulkTgRename"
                >
                  <i class="fa-solid fa-wand-magic-sparkles"></i>
                  {{ t("accounts.bulkTgRename.generateBtn") }}
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="bulkTgRenameAiBusy"
                  @click="generateBulkTgRenameWithAi"
                >
                  <i
                    :class="
                      bulkTgRenameAiBusy
                        ? 'fa-solid fa-spinner fa-spin'
                        : 'fa-solid fa-robot'
                    "
                  ></i>
                  {{
                    bulkTgRenameAiBusy
                      ? t("accounts.bulkTgRename.aiGenerating")
                      : t("accounts.bulkTgRename.aiGenerateBtn")
                  }}
                </button>
              </div>
              <label class="form-label" style="margin-top: 6px">{{
                t("accounts.bulkTgRename.aiHintLabel")
              }}</label>
              <input
                v-model.trim="bulkTgRenameAiHint"
                class="form-input"
                :placeholder="t('accounts.bulkTgRename.aiHintPlaceholder')"
                @keyup.enter="generateBulkTgRenameWithAi"
              />
              <label class="form-check" style="margin-top: 6px">
                <input v-model="bulkTgRenameAiSkipAbout" type="checkbox" />
                <span>{{ t("accounts.bulkTgRename.aiSkipAbout") }}</span>
              </label>
              <div class="form-hint">
                {{ t("accounts.bulkTgRename.aiHintHint") }}
              </div>
              <textarea
                v-model="bulkTgRenameText"
                class="form-input bulk-add-mono"
                rows="8"
                :placeholder="bulkTgRenamePlaceholder"
              ></textarea>
              <div class="form-hint">{{ t("accounts.bulkTgRename.hint") }}</div>
              <div class="bulk-email-preview">
                {{ t("accounts.bulkTgRename.parsedLabel") }}:
                <span
                  :class="
                    bulkTgRenameParsed.length === bulkTgRenameTargets.length
                      ? 'bulk-email-test-ok'
                      : 'bulk-email-test-fail'
                  "
                  >{{ bulkTgRenameParsed.length }} /
                  {{ bulkTgRenameTargets.length }}</span
                >
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkTgRenameGap"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="(a, i) in bulkTgRenameTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
                <span v-if="bulkTgRenameParsed[i]" class="bulk-tgrename-arrow">
                  <i class="fa-solid fa-arrow-right"></i>
                  {{ bulkTgRenameParsed[i].firstName }}
                  {{ bulkTgRenameParsed[i].lastName }}
                </span>
              </div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkTgRename">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkTgRenameTargets.length"
              class="btn btn-primary"
              :disabled="bulkTgRenameBusy || !bulkTgRenameValid"
              @click="startBulkTgRename"
            >
              <i class="fa-solid fa-address-card"></i>
              {{ t("accounts.bulkTgRename.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -->
        <template v-else>
          <div class="bulk-add-progress-head">
            <span>
              {{ t("accounts.bulkTgRename.progressLabel") }}:
              {{ bulkTgRenameDoneCount }} / {{ bulkTgRenameBatch.total }}
            </span>
            <span v-if="bulkTgRenameBatch.running" class="bulk-add-running">
              <i class="fa-solid fa-spinner fa-spin"></i>
              {{ t("accounts.bulkTgRename.running") }}
            </span>
            <span v-else class="bulk-add-finished">
              <i class="fa-solid fa-circle-check"></i>
              {{ t("accounts.bulkAdd.finished") }}
            </span>
          </div>
          <div class="bulk-add-list">
            <div
              v-for="item in bulkTgRenameBatch.items"
              :key="item.accountId"
              class="bulk-add-item"
            >
              <span
                class="bulk-add-status-dot"
                :class="`status-${item.status}`"
              ></span>
              <div class="bulk-add-item-body">
                <div class="bulk-add-item-top">
                  <strong>{{ item.accountName }}</strong>
                  <span class="bulk-add-item-status">
                    {{ t(`accounts.bulkTgRename.status.${item.status}`) }}
                  </span>
                </div>
                <div
                  v-if="item.message"
                  class="bulk-add-item-msg"
                  :class="item.status === 'failed' ? 'bulk-add-item-error' : ''"
                >
                  {{ item.message }}
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button
              v-if="bulkTgRenameBatch.running"
              class="btn btn-danger"
              :disabled="bulkTgRenameBusy"
              @click="cancelBulkTgRename"
            >
              <i class="fa-solid fa-ban"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="bulkTgRenameBatch.running"
              @click="closeBulkTgRename"
            >
              <i class="fa-solid fa-check"></i> {{ t("common.close") }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Bulk change login email modal -->
    <div v-if="showBulkEmail" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-envelope" style="margin-right: 8px"></i>
          {{ t("accounts.bulkEmail.title") }}
        </h3>

        <!-- Config step -->
        <template v-if="!bulkEmailTask">
          <div v-if="!bulkEmailTargets.length" class="warn-box">
            {{ t("accounts.bulkEmail.noTargets") }}
          </div>
          <template v-else>
            <p class="bulk-add-hint">
              {{
                t(
                  bulkEmailForm.source === "msapi"
                    ? "accounts.bulkEmail.introMsApi"
                    : "accounts.bulkEmail.intro",
                ).replace("{n}", String(bulkEmailTargets.length))
              }}
            </p>
            <div v-if="bulkEmailError" class="error-msg">
              {{ bulkEmailError }}
            </div>

            <!-- Telegram will only replace a login email, never add one, so an account with
                 none linked fails the run -->
            <div v-if="bulkEmailNoEmailCount" class="warn-box">
              {{
                t("accounts.bulkEmail.replaceOnly").replace(
                  "{n}",
                  String(bulkEmailNoEmailCount),
                )
              }}
            </div>

            <!-- Only where the deployment offers the pool: with it off the form is the Gmail
                 one it has always been, with nothing to choose between -->
            <div v-if="msApiAvailable" class="form-group">
              <label class="form-label">{{
                t("accounts.bulkEmail.sourceLabel")
              }}</label>
              <select v-model="bulkEmailForm.source" class="form-select">
                <option value="gmail">
                  {{ t("accounts.bulkEmail.sourceGmail") }}
                </option>
                <option value="msapi" :disabled="!msApiConfigured">
                  {{ t("accounts.bulkEmail.sourceMsApi") }}
                </option>
              </select>
              <div class="form-hint">
                {{
                  msApiConfigured
                    ? t("accounts.bulkEmail.sourceHint")
                    : t("accounts.bulkEmail.msApiNotConfigured")
                }}
              </div>
            </div>

            <div
              v-if="bulkEmailForm.source === 'msapi'"
              class="form-group"
            >
              <label class="form-label">{{
                t("accounts.bulkEmail.poolTypeLabel")
              }}</label>
              <input
                v-model.trim="bulkEmailForm.poolType"
                class="form-input"
                :placeholder="msApiPoolTypeDefault"
                autocomplete="off"
              />
              <div class="form-hint">
                {{ t("accounts.bulkEmail.poolTypeHint") }}
              </div>
            </div>

            <div v-if="bulkEmailForm.source === 'gmail'" class="form-group">
              <label class="form-label">{{
                t("accounts.bulkEmail.gmailLabel")
              }}</label>
              <input
                v-model.trim="bulkEmailForm.gmail"
                class="form-input"
                placeholder="myemail@gmail.com"
                autocomplete="off"
              />
              <div class="form-hint">
                {{ t("accounts.bulkEmail.gmailHint") }}
              </div>
            </div>
            <div v-if="bulkEmailForm.source === 'gmail'" class="form-group">
              <label class="form-label">{{
                t("accounts.bulkEmail.appPasswordLabel")
              }}</label>
              <input
                v-model="bulkEmailForm.appPassword"
                type="password"
                class="form-input"
                autocomplete="off"
              />
              <div class="form-hint">
                {{ t("accounts.bulkEmail.appPasswordHint") }}
              </div>
            </div>
            <div v-if="bulkEmailForm.source === 'gmail'" class="bulk-email-test">
              <span v-if="bulkEmailTestOk === true" class="bulk-email-test-ok">
                <i class="fa-solid fa-circle-check"></i> {{ bulkEmailTestMsg }}
              </span>
              <span
                v-else-if="bulkEmailTestOk === false"
                class="bulk-email-test-fail"
              >
                <i class="fa-solid fa-circle-xmark"></i> {{ bulkEmailTestMsg }}
              </span>
              <button
                class="btn btn-secondary btn-sm"
                :disabled="bulkEmailTesting"
                @click="testBulkEmailGmail"
              >
                <i class="fa-solid fa-plug-circle-check"></i>
                {{
                  bulkEmailTesting
                    ? t("accounts.bulkEmail.testing")
                    : t("accounts.bulkEmail.testBtn")
                }}
              </button>
            </div>
            <div v-if="bulkEmailForm.source === 'gmail'" class="form-group">
              <label class="form-label">{{
                t("accounts.bulkEmail.tagLabel")
              }}</label>
              <input
                v-model.trim="bulkEmailForm.tag"
                class="form-input bulk-add-mono"
                placeholder="{phoneNum}"
              />
              <div class="form-hint">{{ t("accounts.bulkEmail.tagHint") }}</div>
              <div class="bulk-email-preview">
                {{ t("accounts.bulkEmail.previewLabel") }}:
                <span>{{ bulkEmailExample }}</span>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkEmailForm.gapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkEmailTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkEmail">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkEmailTargets.length"
              class="btn btn-primary"
              :disabled="bulkEmailForm.source === 'gmail' && bulkEmailTestOk !== true"
              :title="
                bulkEmailForm.source === 'gmail' && bulkEmailTestOk !== true
                  ? t('accounts.bulkEmail.testRequired')
                  : ''
              "
              @click="startBulkEmail"
            >
              <i class="fa-solid fa-envelope"></i>
              {{ t("accounts.bulkEmail.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress v-else :task="bulkEmailTask" @close="closeBulkEmail" />
      </div>
    </div>

    <!-- Bulk change credential modal -->
    <div v-if="showBulkCred" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-user-lock" style="margin-right: 8px"></i>
          {{ t("accounts.bulkCred.title") }}
        </h3>

        <!-- Config step -->
        <template v-if="!bulkCredTask">
          <div v-if="!bulkCredTargets.length" class="warn-box">
            {{ t("accounts.bulkCred.noTargets") }}
          </div>
          <template v-else>
            <p class="bulk-add-hint">
              {{
                t("accounts.bulkCred.intro").replace(
                  "{n}",
                  String(bulkCredTargets.length),
                )
              }}
            </p>
            <div v-if="bulkCredError" class="error-msg">{{ bulkCredError }}</div>
            <div class="form-section-label" style="margin-bottom: 12px">
              {{ t("accounts.bulkCred.twoFaSection") }}
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("accounts.bulkCred.currentPassword")
              }}</label>
              <p class="form-hint">
                {{ t("accounts.bulkCred.currentPasswordHint") }}
              </p>
              <input
                v-model="bulkCredForm.currentPassword"
                type="password"
                class="form-input"
                autocomplete="current-password"
              />
            </div>
            <div class="bulk-add-options-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkCred.newPassword")
                }}</label>
                <input
                  v-model="bulkCredForm.newPassword"
                  type="password"
                  class="form-input"
                  autocomplete="new-password"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("accounts.bulkCred.repeatPassword")
                }}</label>
                <input
                  v-model="bulkCredForm.repeatPassword"
                  type="password"
                  class="form-input"
                  autocomplete="new-password"
                />
              </div>
            </div>
            <label class="form-check" style="margin-top: 4px">
              <input type="checkbox" v-model="bulkCredForm.removeDevices" />
              <span>{{ t("accounts.bulkCred.removeDevices") }}</span>
            </label>
            <label class="form-check" style="margin-top: 10px">
              <input type="checkbox" v-model="bulkCredForm.removePasskeys" />
              <span>{{ t("accounts.bulkCred.removePasskeys") }}</span>
            </label>
            <div class="form-group" style="margin-top: 14px">
              <label class="form-label">{{
                t("accounts.bulkCred.notesAppend")
              }}</label>
              <input
                v-model="bulkCredForm.notesAppend"
                class="form-input"
                :placeholder="t('accounts.bulkCred.notesAppendPlaceholder')"
              />
              <div class="form-hint">
                {{ t("accounts.bulkCred.notesAppendHint") }}
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkCredForm.gapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkCredTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkCred">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkCredTargets.length"
              class="btn btn-primary"
              @click="startBulkCred"
            >
              <i class="fa-solid fa-user-lock"></i>
              {{ t("accounts.bulkCred.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress v-else :task="bulkCredTask" @close="closeBulkCred" />
      </div>
    </div>

    <!-- Bulk add passkey modal -->
    <div v-if="showBulkPasskey" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-key" style="margin-right: 8px"></i>
          {{ t("accounts.bulkPasskey.title") }}
        </h3>

        <!-- Config step -->
        <template v-if="!bulkPasskeyTask">
          <div v-if="!bulkPasskeyTargets.length" class="warn-box">
            {{ t("accounts.bulkPasskey.noTargets") }}
          </div>
          <template v-else>
            <p class="bulk-add-hint">
              {{
                t("accounts.bulkPasskey.intro").replace(
                  "{n}",
                  String(bulkPasskeyTargets.length),
                )
              }}
            </p>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkPasskeyGapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkPasskeyTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkPasskey">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkPasskeyTargets.length"
              class="btn btn-primary"
              @click="startBulkPasskey"
            >
              <i class="fa-solid fa-key"></i>
              {{ t("accounts.bulkPasskey.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress
          v-else
          :task="bulkPasskeyTask"
          @close="closeBulkPasskey"
        />
      </div>
    </div>

    <!-- Bulk privacy modal: a level per key, so a run can also undo an earlier one -->
    <div v-if="showBulkPrivacy" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-eye-slash" style="margin-right: 8px"></i>
          {{ t("accounts.bulkPrivacy.title") }}
        </h3>

        <template v-if="!bulkPrivacyTask">
          <div v-if="!bulkPrivacyTargets.length" class="warn-box">
            {{ t("accounts.bulkPrivacy.noTargets") }}
          </div>
          <template v-else>
            <p class="bulk-add-hint">
              {{
                t("accounts.bulkPrivacy.intro").replace(
                  "{n}",
                  String(bulkPrivacyTargets.length),
                )
              }}
            </p>
            <!-- One level per key, since it is the account's own settings being rewritten -->
            <div class="bulk-privacy-bulkset">
              <span class="form-hint">{{ t("accounts.bulkPrivacy.setAll") }}</span>
              <button
                v-for="level in PRIVACY_LEVELS"
                :key="level"
                class="btn btn-ghost btn-sm"
                @click="setAllPrivacyLevels(level)"
              >
                {{ t(`accounts.bulkPrivacy.level.${level}`) }}
              </button>
            </div>
            <ul class="bulk-privacy-list">
              <li v-for="key in PRIVACY_KEYS" :key="key">
                <span class="bulk-privacy-key">
                  {{ t(`accounts.bulkPrivacy.key.${key}`) }}
                </span>
                <span class="bulk-privacy-levels">
                  <label
                    v-for="level in PRIVACY_LEVELS"
                    :key="level"
                    class="bulk-privacy-level"
                    :class="{
                      disabled: level === 'nobody' && PRIVACY_CONTACTS_ONLY.includes(key),
                    }"
                  >
                    <input
                      type="radio"
                      :name="`privacy-${key}`"
                      :value="level"
                      :checked="bulkPrivacySettings[key] === level"
                      :disabled="level === 'nobody' && PRIVACY_CONTACTS_ONLY.includes(key)"
                      @change="bulkPrivacySettings[key] = level"
                    />
                    {{ t(`accounts.bulkPrivacy.level.${level}`) }}
                  </label>
                </span>
              </li>
            </ul>
            <div class="form-hint" style="margin-bottom: 10px">
              {{ t("accounts.bulkPrivacy.contactsOnlyNote") }}
            </div>
            <div class="form-hint" style="margin-bottom: 10px">
              {{ t("accounts.bulkPrivacy.note") }}
            </div>
            <div class="form-group">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkPrivacyGapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkPrivacyTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkPrivacy">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkPrivacyTargets.length"
              class="btn btn-primary"
              @click="startBulkPrivacy"
            >
              <i class="fa-solid fa-eye-slash"></i>
              {{ t("accounts.bulkPrivacy.start") }}
            </button>
          </div>
        </template>

        <BulkTaskProgress
          v-else
          :task="bulkPrivacyTask"
          @close="closeBulkPrivacy"
        />
      </div>
    </div>

    <!-- Bulk spam-check modal -->
    <div v-if="showBulkSpam" class="modal-backdrop">
      <div class="modal">
        <h3 class="modal-title">
          <i class="fa-solid fa-user-shield" style="margin-right: 8px"></i>
          {{ t("accounts.checkSpamSelected") }}
        </h3>
        <div v-if="!bulkSpamTargetCount" class="warn-box">
          {{ t("accounts.bulkClean.noTargets") }}
        </div>
        <template v-else>
          <p class="bulk-add-hint">
            {{
              t("accounts.bulkSpam.intro").replace(
                "{n}",
                String(bulkSpamTargetCount),
              )
            }}
          </p>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
            <input
              v-model.number="spamBulkGapSeconds"
              type="number"
              min="0"
              class="form-input"
            />
            <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
          </div>
        </template>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showBulkSpam = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button
            v-if="bulkSpamTargetCount"
            class="btn btn-primary"
            :disabled="spamBulkRunning"
            @click="startBulkSpamCheck"
          >
            <i class="fa-solid fa-user-shield"></i>
            {{ t("accounts.bulkSpam.start") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Bulk clean modal -->
    <div v-if="showBulkClean" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i
            class="fa-solid fa-broom"
            style="margin-right: 8px; color: #ff4d4f"
          ></i>
          {{ t("accounts.bulkClean.title") }}
        </h3>

        <!-- Confirm step -->
        <template v-if="!bulkCleanTask">
          <div v-if="!bulkCleanTargets.length" class="warn-box">
            {{ t("accounts.bulkClean.noTargets") }}
          </div>
          <template v-else>
            <div class="warn-box">
              {{
                t("accounts.bulkClean.intro").replace(
                  "{n}",
                  String(bulkCleanTargets.length),
                )
              }}
              <ul class="tgc-clean-list">
                <li>{{ t("tgc.clean.actionLeaveGroups") }}</li>
                <li>{{ t("tgc.clean.actionLeaveChannels") }}</li>
                <li>{{ t("tgc.clean.actionDeleteChats") }}</li>
                <li>{{ t("tgc.clean.actionRemoveContacts") }}</li>
                <li>{{ t("tgc.clean.actionRemoveFolders") }}</li>
              </ul>
              {{ t("tgc.clean.keptNote") }}
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkCleanTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
            <div class="form-group" style="margin-top: 12px">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkCleanGapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
            <label class="form-check" style="margin-top: 12px">
              <input type="checkbox" v-model="bulkCleanConfirmChecked" />
              <span>{{ t("accounts.bulkClean.confirmCheck") }}</span>
            </label>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkClean">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkCleanTargets.length"
              class="btn btn-danger"
              :disabled="!bulkCleanConfirmChecked"
              @click="startBulkClean"
            >
              <i class="fa-solid fa-broom"></i>
              {{ t("accounts.bulkClean.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress v-else :task="bulkCleanTask" @close="closeBulkClean" />
      </div>
    </div>

    <!-- Bulk fetch attributes modal -->
    <div v-if="showBulkFetch" class="modal-backdrop">
      <div class="modal modal-lg">
        <h3 class="modal-title">
          <i class="fa-solid fa-arrows-rotate" style="margin-right: 8px"></i>
          {{ t("accounts.bulkFetch.title") }}
        </h3>

        <!-- Confirm step -->
        <template v-if="!bulkFetchTask">
          <div v-if="!bulkFetchTargets.length" class="warn-box">
            {{ t("accounts.bulkFetch.noTargets") }}
          </div>
          <template v-else>
            <div class="warn-box">
              {{
                t("accounts.bulkFetch.intro").replace(
                  "{n}",
                  String(bulkFetchTargets.length),
                )
              }}
            </div>
            <div class="bulk-clean-accounts">
              <div
                v-for="a in bulkFetchTargets"
                :key="a.id"
                class="bulk-clean-account"
              >
                <strong>{{ a.name }}</strong>
                <span class="bulk-add-phone">{{ a.phoneNumber }}</span>
              </div>
            </div>
            <div class="form-group" style="margin-top: 12px">
              <label class="form-label">{{ t("accounts.bulkGap.label") }}</label>
              <input
                v-model.number="bulkFetchGapSeconds"
                type="number"
                min="0"
                class="form-input"
              />
              <div class="form-hint">{{ t("accounts.bulkGap.hint") }}</div>
            </div>
          </template>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeBulkFetch">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              v-if="bulkFetchTargets.length"
              class="btn btn-primary"
              @click="startBulkFetch"
            >
              <i class="fa-solid fa-arrows-rotate"></i>
              {{ t("accounts.bulkFetch.start") }}
            </button>
          </div>
        </template>

        <!-- Progress step -- rendered from the server-side task -->
        <BulkTaskProgress v-else :task="bulkFetchTask" @close="closeBulkFetch" />
      </div>
    </div>

    <!-- Auth modal -->
    <div v-if="showAuth" class="modal-backdrop">
      <div class="modal">
        <h3 class="modal-title">
          {{ t("accounts.authTitle") }} — {{ authTarget?.name }}
        </h3>
        <div v-if="authError" class="error-msg">{{ authError }}</div>

        <!-- Step: request code / start login -->
        <div v-if="authStep === 'idle'">
          <!-- Usable passkey: log in with it automatically, then ask for 2FA. -->
          <template v-if="authTarget?.hasBembyPasskey">
            <p
              v-if="authBusy"
              style="color: #666; margin-bottom: 16px; font-size: 13px"
            >
              <i class="fa-solid fa-spinner fa-spin" style="margin-right: 6px"></i>
              {{ t("accounts.authPasskeyProgress") }}
            </p>
            <button
              v-else
              class="btn btn-primary"
              @click="sendCode"
            >
              <i class="fa-solid fa-key"></i>
              {{ t("accounts.loginPasskey") }}
            </button>
          </template>
          <template v-else>
            <p style="color: #666; margin-bottom: 16px; font-size: 13px">
              {{ t("accounts.authHint") }}
              <strong>{{ authTarget?.phoneNumber }}</strong
              >.
            </p>
            <button
              class="btn btn-primary"
              :disabled="authBusy"
              @click="sendCode"
            >
              <i class="fa-solid fa-paper-plane"></i>
              {{ authBusy ? t("accounts.sending") : t("accounts.sendCode") }}
            </button>
          </template>
        </div>

        <!-- Step: enter OTP -->
        <div v-else-if="authStep === 'code'">
          <div v-if="isCodeViaApp" class="info-box" style="margin-bottom: 14px">
            <i class="fa-brands fa-telegram" style="margin-right: 6px"></i>
            {{ t("accounts.codeViaApp") }}
            <button
              class="btn btn-sm btn-ghost"
              style="margin-left: 8px"
              :disabled="resendBusy"
              @click="resendAsSms"
            >
              {{ resendBusy ? "..." : t("accounts.resendSms") }}
            </button>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelCode") }}</label>
            <input
              v-model.trim="authCode"
              class="form-input"
              placeholder="12345"
              autofocus
            />
          </div>
          <p class="code-hint-note">{{ t("accounts.codeNoReceiveHint") }}</p>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeAuth">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="authBusy"
              @click="verifyCode"
            >
              <i class="fa-solid fa-check"></i>
              {{ authBusy ? t("accounts.verifying") : t("accounts.verify") }}
            </button>
          </div>
        </div>

        <!-- Step: 2FA password -->
        <div v-else-if="authStep === '2fa'">
          <div v-if="authViaPasskey" class="info-box" style="margin-bottom: 14px">
            <i class="fa-solid fa-key" style="margin-right: 6px"></i>
            {{ t("accounts.authPasskeyOk") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.labelTwoFa") }}</label>
            <input
              v-model="authPassword"
              class="form-input"
              type="password"
              autofocus
            />
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeAuth">
              <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="authBusy"
              @click="verify2fa"
            >
              <i class="fa-solid fa-check"></i>
              {{ authBusy ? t("accounts.verifying") : t("accounts.submit") }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div
      v-if="actionMenuAccount"
      class="action-sheet-backdrop"
      @click="actionMenuAccount = null"
    >
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuAccount.name }}</div>
        <button
          v-if="actionMenuAccount.authStatus !== 'authenticated'"
          class="action-sheet-btn"
          @click="
            openAuth(actionMenuAccount);
            actionMenuAccount = null;
          "
        >
          <i class="fa-solid fa-key"></i> {{ t("accounts.authenticate") }}
        </button>
        <button
          v-if="actionMenuAccount.authStatus === 'authenticated' && !actionMenuAccount.disabled"
          class="action-sheet-btn"
          @click="
            openMessengerFor(actionMenuAccount.id);
            actionMenuAccount = null;
          "
        >
          <i class="fa-brands fa-telegram"></i>
          {{ t("accounts.openInMessenger") }}
        </button>
        <button
          v-if="actionMenuAccount.authStatus === 'authenticated'"
          class="action-sheet-btn"
          @click="
            openCheckStatus(actionMenuAccount);
            actionMenuAccount = null;
          "
        >
          <i class="fa-solid fa-circle-info"></i>
          {{ t("accounts.checkStatus") }}
        </button>
        <button
          v-if="actionMenuAccount.authStatus === 'authenticated'"
          class="action-sheet-btn"
          :disabled="metaLoading.has(actionMenuAccount.id)"
          @click="
            fetchMeta(actionMenuAccount.id);
            actionMenuAccount = null;
          "
        >
          <i class="fa-solid fa-arrows-rotate"></i>
          {{ t("accounts.colTgName") }}
        </button>
        <button
          class="action-sheet-btn"
          @click="
            toggleDisabled(actionMenuAccount);
            actionMenuAccount = null;
          "
        >
          <i
            :class="
              actionMenuAccount.disabled
                ? 'fa-solid fa-circle-play'
                : 'fa-solid fa-ban'
            "
          ></i>
          {{
            actionMenuAccount.disabled
              ? t("accounts.enableAccount")
              : t("accounts.disableAccount")
          }}
        </button>
        <button
          class="action-sheet-btn"
          @click="
            openEdit(actionMenuAccount);
            actionMenuAccount = null;
          "
        >
          <i class="fa-solid fa-pen"></i> {{ t("common.edit") }}
        </button>
        <button
          class="action-sheet-btn danger"
          @click="
            remove(actionMenuAccount.id);
            actionMenuAccount = null;
          "
        >
          <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
        </button>
        <div class="action-sheet-divider"></div>
        <button
          class="action-sheet-btn action-sheet-cancel"
          @click="actionMenuAccount = null"
        >
          {{ t("common.cancel") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from "vue";
import {
  accountsApi,
  bulkTasksApi,
  settingsApi,
  type Account,
  type Proxy,
  type TgAppClient,
  type TgAccountStatus,
  type TgSpamStatus,
  type SessionInfo,
  type PasswordInfo,
  type Passkey,
  type BulkAddBatch,
  type BulkAddOptions,
  type BulkProfileBatch,
  type BulkProfileEntry,
  type AvatarSourceMode,
  type AvatarPoolStatus,
  type PrivacyLevel,
} from "../api/client";
import { t, locale } from "../i18n";
import { usePersistedRef } from "../composables/usePersistedRef";
import { phoneCountry } from "../utils/phoneCountry";
import { proxyScheme, proxySupportsTelegram } from "../utils/proxy";
import { debounce } from "../composables/useDebounce";
import { openMessengerFor } from "../composables/viewNav";
import {
  onBulkTaskFinished,
  runningTaskOfKind,
  startBulkTaskPolling,
  taskById,
  trackStartedTask,
} from "../composables/bulkTasks";
import PaginationBar from "../components/PaginationBar.vue";
import BulkTaskProgress from "../components/BulkTaskProgress.vue";

const accounts = ref<Account[]>([]);

// ── Search and pagination state ───────────────────────────────────────────────
const page = ref(1);
const total = ref(0);
const pageSize = usePersistedRef<number>("bemby:accounts:pageSize", 25);
const searchText = usePersistedRef<string>("bemby:accounts:search", "");

// Column sort; empty key = manual drag order (backend default)
const sortKey = usePersistedRef<string>("bemby:accounts:sortKey", "");
const sortDir = usePersistedRef<"asc" | "desc">("bemby:accounts:sortDir", "asc");

// Cycle a column through asc -> desc -> manual order
function sortBy(key: string) {
  if (sortKey.value !== key) {
    sortKey.value = key;
    sortDir.value = "asc";
  } else if (sortDir.value === "asc") {
    sortDir.value = "desc";
  } else {
    sortKey.value = "";
  }
}

function sortIcon(key: string) {
  if (sortKey.value !== key) return "fa-solid fa-sort sort-ind sort-ind-dim";
  return sortDir.value === "asc"
    ? "fa-solid fa-sort-up sort-ind"
    : "fa-solid fa-sort-down sort-ind";
}

// Set while load() itself steps the page back, to avoid a duplicate fetch
let skipPageWatch = false;
watch([page, pageSize], () => {
  if (skipPageWatch) {
    skipPageWatch = false;
    return;
  }
  load();
});

const debouncedSearch = debounce(() => {
  if (page.value !== 1) page.value = 1;
  else load();
}, 300);
watch(searchText, () => debouncedSearch());

// One term per line, read the same way the backend reads it: the count is shown so a paste
// that arrived as one long line rather than many is obvious, rather than being blamed on the
// accounts. The cap matches MAX_SEARCH_TERMS there, and holds the query string down as well.
const MAX_SEARCH_TERMS = 200;

const searchTermList = computed(() => [
  ...new Set(
    searchText.value
      .split(/[\r\n]+/)
      .map((line) => line.trim().replace(/^@+/, "").trim())
      .filter(Boolean),
  ),
]);

const searchTermCount = computed(() => searchTermList.value.length);

/** What goes to the server: the terms as it reads them, capped. Empty when nothing was typed. */
const searchParam = computed(() =>
  searchTermList.value.slice(0, MAX_SEARCH_TERMS).join("\n") || undefined,
);

// Grows with the list up to a few lines, so a long paste does not take over the header
const searchRows = computed(() => Math.min(6, Math.max(1, searchTermCount.value)));

watch([sortKey, sortDir], () => {
  if (page.value !== 1) page.value = 1;
  else load();
});

// ── Drag-and-drop reorder state ───────────────────────────────────────────────
const dragSrcIdx = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

function onDragStart(idx: number, e: DragEvent) {
  // Reordering a filtered/sorted subset is misleading; disabled in those modes
  if (searchText.value.trim() || sortKey.value) {
    e.preventDefault();
    return;
  }
  dragSrcIdx.value = idx;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

async function onDrop(targetIdx: number) {
  const src = dragSrcIdx.value;
  dragSrcIdx.value = null;
  dragOverIdx.value = null;
  if (src === null || src === targetIdx) return;
  const arr = [...accounts.value];
  const [moved] = arr.splice(src, 1);
  arr.splice(targetIdx, 0, moved);
  accounts.value = arr;
  // Offset by the page start so within-page reorder keeps the global order
  const base = (page.value - 1) * pageSize.value;
  await accountsApi.reorder(
    arr.map((a, i) => ({ id: a.id, sortOrder: base + i })),
  );
}
const settings = ref<{
  proxies?: string;
  tg_app_clients?: string;
  tg_client_mode?: string;
  default_tg_api_id?: string;
  default_tg_api_hash?: string;
  bulk_account_management?: string;
  msapi_available?: string;
  msapi_configured?: string;
  msapi_pool_type?: string;
  msapi_pool_type_default?: string;
} | null>(null);

const bulkMgmtEnabled = computed(
  () => settings.value?.bulk_account_management === "true",
);

/** Whether the deployment offers the pool at all; off, nothing here mentions msOauth2api. */
const msApiAvailable = computed(() => settings.value?.msapi_available === "true");

/** Whether a login email can actually be drawn from it: offered, with a URL and key stored. */
const msApiConfigured = computed(
  () => msApiAvailable.value && settings.value?.msapi_configured === "true",
);

const msApiPoolTypeDefault = computed(
  () =>
    settings.value?.msapi_pool_type ||
    settings.value?.msapi_pool_type_default ||
    "Telegram",
);

const hasGlobalTgCreds = computed(
  () =>
    !!Number(settings.value?.default_tg_api_id) &&
    !!settings.value?.default_tg_api_hash,
);

const proxiesList = computed<Proxy[]>(() => {
  try {
    return JSON.parse(settings.value?.proxies ?? "[]");
  } catch {
    return [];
  }
});

// An account proxy is the Telegram exit, so only SOCKS entries can serve as one
const tgProxiesList = computed(() =>
  proxiesList.value.filter((p) => proxySupportsTelegram(p.url)),
);
const hasNonTgProxies = computed(
  () => tgProxiesList.value.length < proxiesList.value.length,
);
const accountProxyUsable = (proxyId: string): boolean => {
  const p = proxiesList.value.find((x) => x.id === proxyId);
  // An id with no matching entry says nothing about the scheme; don't cry wolf
  return !p || proxySupportsTelegram(p.url);
};

const appClientsList = computed<TgAppClient[]>(() => {
  try {
    return JSON.parse(settings.value?.tg_app_clients ?? "[]");
  } catch {
    return [];
  }
});

const tgClientMode = computed(
  () => settings.value?.tg_client_mode ?? "default",
);

const defaultClientName = computed(() => {
  if (tgClientMode.value === "random") return t("accounts.appClientRandom");
  return appClientsList.value.find((c) => c.isDefault)?.name ?? "";
});

// Default lengths mirror the backend expandCommand() so masked random tokens
// preview at the right width.
const RANDOM_TOKEN_LENS: Record<string, number> = {
  word: 6,
  WORD: 6,
  num: 6,
  alpha: 8,
};

// Client-side preview of a deviceModel template: named tokens are filled from
// the account being edited; random tokens are masked (their real value is
// generated and fixed per account on the server).
function previewDeviceName(template: string): string {
  const acct = editTarget.value;
  const ctx: Record<string, string> = {
    name: form.name || "",
    tgName: acct?.tgDisplayName || "",
    tgUsername: acct?.tgUsername || "",
    id: acct ? String(acct.id) : "",
  };
  return template.replace(
    /\{(\w+)(?::(\d+))?\}/g,
    (match, type: string, lenStr?: string) => {
      if (type in ctx) return ctx[type];
      if (type in RANDOM_TOKEN_LENS)
        return "•".repeat(lenStr ? parseInt(lenStr, 10) : RANDOM_TOKEN_LENS[type]);
      if (type === "uuid") return "••••••••-••••-4•••-••••-••••••••••••";
      return match;
    },
  );
}

const deviceModelPreview = computed(() => {
  // Dropdown unchanged: show the real server-resolved value for this account.
  if (!form.appClientId && editTarget.value?.resolvedDeviceModel) {
    return editTarget.value.resolvedDeviceModel;
  }
  const client = form.appClientId
    ? appClientsList.value.find((c) => c.id === form.appClientId)
    : appClientsList.value.find((c) => c.isDefault);
  return client ? previewDeviceName(client.deviceModel) : "";
});

// ── Form state ────────────────────────────────────────────────────────────────
const showForm = ref(false);
const editTab = ref<"basic" | "profile" | "twofa" | "devices" | "others">(
  "basic",
);
const editTarget = ref<Account | null>(null);
const form = reactive({
  name: "",
  phoneNumber: "",
  apiId: "",
  apiHash: "",
  proxyId: "",
  appClientId: "",
  notes: "",
});
const formError = ref("");
const saving = ref(false);

// ── 2FA state ─────────────────────────────────────────────────────────────────
const twoFaCurrentPwd = ref("");
const twoFaNewPwd = ref("");
const twoFaNewPwdConfirm = ref("");
const twoFaHint = ref("");
const twoFaBusy = ref(false);
const twoFaError = ref("");
const twoFaMsg = ref("");

// ── Profile state ─────────────────────────────────────────────────────────────
const profileForm = reactive({ firstName: "", lastName: "", about: "" });

// ── Username state ────────────────────────────────────────────────────────────
// Kept apart from profileForm: account.updateUsername is a separate Telegram call
// with its own failure modes (taken, reserved, purchasable), so it saves on its own.
const usernameValue = ref("");
const usernameOriginal = ref("");
const usernameBusy = ref(false);
const usernameChecking = ref(false);
const usernameError = ref("");
const usernameMsg = ref("");
const usernameAvailable = ref<boolean | null>(null);
const profileLoaded = ref(false);
const profileLoading = ref(false);
const profileBusy = ref(false);
const profileError = ref("");
const profileMsg = ref("");

// ── Avatar state ──────────────────────────────────────────────────────────────
const avatarUrl = ref<string | null>(null);
const avatarLoading = ref(false);
const avatarBusy = ref(false);
const avatarError = ref("");
const avatarInput = ref<HTMLInputElement | null>(null);

// ── Sessions state ────────────────────────────────────────────────────────────
const sessions = ref<SessionInfo[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref("");
const terminatingHash = ref<string | null>(null);
const terminateBusy = ref(false);
const terminateError = ref("");
const terminateMsg = ref("");

// ── Recovery email state ──────────────────────────────────────────────────────
const pwdInfo = ref<PasswordInfo | null>(null);
const pwdInfoLoading = ref(false);
const passkeys = ref<Passkey[]>([]);
const passkeysLoading = ref(false);
const passkeysError = ref("");
const passkeysLoaded = ref(false);
const deletingPasskeyId = ref<string | null>(null);
const addingPasskey = ref(false);
const passkeyStoredIds = ref<string[]>([]);
const verifyingPasskeyId = ref<string | null>(null);
const loginEmailBusy = ref(false);
const loginEmailError = ref("");
const loginEmailMsg = ref("");
const loginEmailChangeMode = ref(false);
const loginEmailPendingConfirm = ref(false);
const loginEmailNewPattern = ref("");
const loginEmailNew = ref("");
const loginEmailCode = ref("");

// ── TG meta refresh (display name + username stored in DB, loaded with accounts list) ──
const metaLoading = reactive(new Set<number>());

async function fetchMeta(accountId: number) {
  if (metaLoading.has(accountId)) return;
  metaLoading.add(accountId);
  try {
    const meta = await accountsApi.refreshTgMeta(accountId);
    const idx = accounts.value.findIndex((a) => a.id === accountId);
    if (idx !== -1) {
      accounts.value[idx] = { ...accounts.value[idx], ...meta };
    }
  } catch {
  } finally {
    metaLoading.delete(accountId);
  }
}

// ── Mobile action sheet ───────────────────────────────────────────────────────
const actionMenuAccount = ref<Account | null>(null);

// ── Spam check state ──────────────────────────────────────────────────────────
const spamCheckLoading = reactive(new Set<number>());
const spamStatuses = reactive(new Map<number, TgSpamStatus>());

function spamBadgeClass(status: TgSpamStatus["spamStatus"]) {
  const map: Record<string, string> = {
    free: "badge-green",
    limited: "badge-orange",
    blocked: "badge-red",
    frozen: "badge-blue",
    unknown: "badge-grey",
  };
  return `badge ${map[status] ?? "badge-grey"}`;
}

// Same bookkeeping the backend does on the account record: the restriction flag, and the
// raw reply kept only while the status is unknown.
function mirrorSpamAttrs(
  current: Record<string, unknown> | undefined,
  status: TgSpamStatus["spamStatus"],
  rawMessage?: string,
  buttons?: string[],
): Record<string, unknown> {
  const attrs = { ...(current ?? {}) };
  delete attrs.spamUnknownReply;
  if (status === "free") delete attrs.restriction;
  else if (status !== "unknown") attrs.restriction = status;
  else attrs.spamUnknownReply = { text: rawMessage ?? "", buttons: buttons ?? [] };
  return attrs;
}

async function checkSpam(a: Account) {
  if (spamCheckLoading.has(a.id)) return;
  spamCheckLoading.add(a.id);
  try {
    const result = await accountsApi.checkSpam(a.id);
    spamStatuses.set(a.id, result);
    // Mirror the persisted restriction flag onto the row so the Extra Info badge updates.
    a.attributes = mirrorSpamAttrs(a.attributes, result.spamStatus, result.rawMessage, result.buttons);
  } catch (err: any) {
    spamStatuses.set(a.id, {
      spamStatus: "unknown",
      rawMessage: err.response?.data?.error ?? "Check failed",
    });
  } finally {
    spamCheckLoading.delete(a.id);
  }
}

// Bulk spam check runs as a background task; per-row badges are filled in from
// its items as they land, so the list updates while the operator watches.
const spamBulkGapSeconds = ref(30);
const showBulkSpam = ref(false);
const spamTaskId = ref<string | null>(null);
const spamTask = computed(() => taskById(spamTaskId.value));
const spamBulkRunning = computed(() => !!runningTaskOfKind("spam-check"));

const bulkSpamTargetCount = computed(
  () =>
    accounts.value.filter(
      (a) =>
        selectedIds.value.has(a.id) &&
        a.authStatus === "authenticated" &&
        !a.disabled,
    ).length,
);

function openBulkSpam() {
  showBulkSpam.value = true;
}

async function startBulkSpamCheck() {
  const ids = accounts.value
    .filter(
      (a) =>
        selectedIds.value.has(a.id) &&
        a.authStatus === "authenticated" &&
        !a.disabled,
    )
    .map((a) => a.id);
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.spamCheck(ids, spamBulkGapSeconds.value);
    trackStartedTask(task);
    spamTaskId.value = task.id;
    showBulkSpam.value = false;
  } catch (err: any) {
    alert(err.response?.data?.error ?? t("bulkTasks.startFailed"));
  }
}

// Mirror finished spam results onto the rows: the badge and the persisted
// restriction flag, exactly as a single check does.
watch(
  () => spamTask.value?.items.map((i) => `${i.refId}:${i.status}`).join(","),
  () => {
    for (const item of spamTask.value?.items ?? []) {
      if (item.status === "failed") {
        spamStatuses.set(item.refId, {
          spamStatus: "unknown",
          rawMessage: item.error ?? t("bulkTasks.itemStatus.failed"),
        });
        continue;
      }
      if (item.status !== "done") continue;
      const status = (item.data?.spamStatus ??
        "unknown") as TgSpamStatus["spamStatus"];
      spamStatuses.set(item.refId, { spamStatus: status, rawMessage: item.message });
      const account = accounts.value.find((a) => a.id === item.refId);
      if (!account) continue;
      account.attributes = mirrorSpamAttrs(
        account.attributes,
        status,
        item.message,
        item.data?.buttons as string[] | undefined,
      );
    }
  },
);

// ── Bulk fetch attributes state ───────────────────────────────────────────────
// Refreshes TG meta + extra attributes (name, username, hasEmail, hasPasskey) for
// each selected authenticated account. Read-only; excludes the spam check.
const showBulkFetch = ref(false);
const bulkFetchTargets = ref<Account[]>([]);
const bulkFetchGapSeconds = ref(5);
const bulkFetchTaskId = ref<string | null>(null);
const bulkFetchTask = computed(() => taskById(bulkFetchTaskId.value));
const bulkFetchRunning = computed(() => !!runningTaskOfKind("fetch-attributes"));

function openBulkFetch() {
  bulkFetchTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  // A batch still running from an earlier visit keeps showing its progress
  bulkFetchTaskId.value = runningTaskOfKind("fetch-attributes")?.id ?? null;
  showBulkFetch.value = true;
}

function closeBulkFetch() {
  showBulkFetch.value = false;
  bulkFetchTaskId.value = null;
}

async function startBulkFetch() {
  const ids = bulkFetchTargets.value.map((a) => a.id);
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.fetchAttributes(
      ids,
      bulkFetchGapSeconds.value,
    );
    trackStartedTask(task);
    bulkFetchTaskId.value = task.id;
  } catch (e: any) {
    alert(e.response?.data?.error ?? t("bulkTasks.startFailed"));
  }
}

// ── Status check state ────────────────────────────────────────────────────────
const showStatus = ref(false);
const statusTarget = ref<Account | null>(null);
const statusResult = ref<TgAccountStatus | null>(null);
const statusError = ref("");
const statusChecking = ref(false);

// ── Extra info column toggle (notes + additional attributes) ──────────────────
// Storage key kept as "showNotes" to preserve the user's existing preference.
const showExtra = usePersistedRef<boolean>("bemby:accounts:showNotes", true);
const extraColClass = computed(() =>
  showExtra.value ? "col-hide-mobile" : "col-hidden",
);

// Badges shown in the Extra Info column: the passkey state plus any flags Bemby has
// recorded in the account's additional_attributes bag (e.g. hasEmail).
const EXTRA_ATTR_LABELS: Record<string, string> = { hasEmail: "attrEmail" };
type ExtraBadge = {
  label: string;
  cls: string;
  title?: string;
  /** Pressing it shows the stored login email, which the badge itself never spells out. */
  reveal?: boolean;
};

function accountExtraInfo(a: Account): ExtraBadge[] {
  const badges: ExtraBadge[] = [];
  if (a.hasBembyPasskey)
    badges.push({ label: t("accounts.attrBembyPasskey"), cls: "badge-green" });
  else if (a.hasPasskey)
    badges.push({ label: t("accounts.attrPasskey"), cls: "badge-grey" });
  const attrs = a.attributes ?? {};
  // The login email, the same pair the passkey makes: green when Bemby set it, plain when
  // Telegram just reports that one exists. The address goes in the tooltip rather than the
  // badge, which is uppercased and would shout it.
  if (typeof attrs.loginEmail === "string" && attrs.loginEmail)
    badges.push({
      label: t("accounts.attrBembyEmail"),
      cls: "badge-green",
      title: t("accounts.attrBembyEmailReveal"),
      reveal: true,
    });
  else if (attrs.hasEmail === true)
    badges.push({ label: t("accounts.attrEmail"), cls: "badge-blue" });
  // Restriction: coloured status badge reusing the spam status labels/colours.
  if (typeof attrs.restriction === "string") {
    const colour: Record<string, string> = {
      limited: "badge-orange",
      blocked: "badge-red",
      frozen: "badge-blue",
    };
    badges.push({
      label: `${t("accounts.attrRestriction")}: ${t(`accounts.spam.${attrs.restriction}`)}`,
      cls: colour[attrs.restriction] ?? "badge-grey",
    });
  }
  // A SpamBot reply no rule could classify: the wording and keyboard go in the tooltip,
  // which is what a new language needs to be added to the classifier.
  const unknownReply = attrs.spamUnknownReply as
    | { text?: string; buttons?: string[]; checkedAt?: string }
    | undefined;
  if (unknownReply && typeof unknownReply === "object") {
    const buttons = unknownReply.buttons?.length
      ? `\n\n[${unknownReply.buttons.join("] [")}]`
      : "";
    badges.push({
      label: t("accounts.attrSpamUnknown"),
      cls: "badge-grey",
      title: `${unknownReply.text ?? ""}${buttons}`,
    });
  }
  for (const [key, value] of Object.entries(attrs)) {
    // Skip keys shown above and any non-primitive values (no "[object Object]").
    if (
      key === "hasPasskey" ||
      key === "passkey" ||
      key === "restriction" ||
      key === "hasEmail" ||
      key === "loginEmail"
    )
      continue;
    if (value === false || value == null || typeof value === "object") continue;
    const base = EXTRA_ATTR_LABELS[key] ? t(`accounts.${EXTRA_ATTR_LABELS[key]}`) : key;
    badges.push({
      label: value === true ? base : `${base}: ${String(value)}`,
      cls: "badge-blue",
    });
  }
  return badges;
}

// The address Bemby gave the account, kept out of sight until asked for: the column is dense,
// and a mailbox is worth no more than a glance in passing.
const revealedEmails = ref<Set<number>>(new Set());

function accountLoginEmail(a: Account): string {
  const value = a.attributes?.loginEmail;
  return typeof value === "string" ? value : "";
}

function toggleEmailReveal(a: Account): void {
  const next = new Set(revealedEmails.value);
  if (next.has(a.id)) next.delete(a.id);
  else next.add(a.id);
  revealedEmails.value = next;
}

// ── Bulk notes state ──────────────────────────────────────────────────────────
const showBulkNotes = ref(false);
const bulkNotesText = ref("");
const bulkNotesSaving = ref(false);

async function openBulkNotes() {
  bulkNotesText.value = "";
  showBulkNotes.value = true;
}

async function saveBulkNotes() {
  if (!selectedIds.value.size) return;
  bulkNotesSaving.value = true;
  try {
    await accountsApi.bulkUpdateNotes(
      [...selectedIds.value],
      bulkNotesText.value || null,
    );
    await load();
    showBulkNotes.value = false;
  } finally {
    bulkNotesSaving.value = false;
  }
}

// ── Bulk rename ───────────────────────────────────────────────────────────────
const showBulkRename = ref(false);
const bulkRenameSaving = ref(false);
const bulkRenameForm = reactive({
  format: "A_{index}",
  startIndex: 1,
  indexDigits: 3,
});

// Selected accounts in their displayed order, so the running index matches
// what the user sees.
const bulkRenameTargets = computed(() =>
  accounts.value.filter((a) => selectedIds.value.has(a.id)),
);

// {index} is replaced with the (optionally zero-padded) running number.
function buildRenameName(index: number): string {
  const digits =
    Number(bulkRenameForm.indexDigits) > 0
      ? Math.floor(Number(bulkRenameForm.indexDigits))
      : 0;
  const idxStr = digits > 0 ? String(index).padStart(digits, "0") : String(index);
  return (bulkRenameForm.format || "{index}").replace(/\{index\}/g, idxStr);
}

const bulkRenamePreview = computed(() => {
  const start = Number(bulkRenameForm.startIndex) || 0;
  return bulkRenameTargets.value.slice(0, 5).map((a, i) => ({
    old: a.name,
    next: buildRenameName(start + i),
  }));
});

function openBulkRename() {
  showBulkRename.value = true;
}

async function saveBulkRename() {
  const targets = bulkRenameTargets.value;
  if (!targets.length) return;
  bulkRenameSaving.value = true;
  try {
    const start = Number(bulkRenameForm.startIndex) || 0;
    const items = targets.map((a, i) => ({
      id: a.id,
      name: buildRenameName(start + i),
    }));
    await accountsApi.bulkRename(items);
    await load();
    showBulkRename.value = false;
  } finally {
    bulkRenameSaving.value = false;
  }
}

// ── Selection state ───────────────────────────────────────────────────────────
const selectedIds = ref(new Set<number>());
const bulkMenuOpen = ref(false);
// Close the bulk-actions menu, then run the chosen action.
function runBulk(fn: () => unknown) {
  bulkMenuOpen.value = false;
  fn();
}
const allSelected = computed(
  () =>
    accounts.value.length > 0 &&
    accounts.value.every((a) => selectedIds.value.has(a.id)),
);

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(accounts.value.map((a) => a.id));
  }
}

// Index of the last row toggled without Shift; anchors Shift-click ranges.
let lastSelectedIdx: number | null = null;

function toggleSelect(id: number, idx: number, event?: MouseEvent) {
  // Shift-click selects the contiguous range between the anchor row and this
  // one; other modifiers/clicks toggle a single row and reset the anchor.
  if (event?.shiftKey && lastSelectedIdx !== null) {
    // Shift-click would otherwise highlight the intervening table text.
    window.getSelection?.()?.removeAllRanges();
    const next = new Set(selectedIds.value);
    const [lo, hi] = [lastSelectedIdx, idx].sort((a, b) => a - b);
    for (let i = lo; i <= hi; i++) {
      const row = accounts.value[i];
      if (row) next.add(row.id);
    }
    selectedIds.value = next;
    return;
  }
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
  lastSelectedIdx = idx;
}

// The anchor is an index into the current list, so it becomes meaningless when
// the list is replaced (search, pagination, reload, reorder) -- clear it so the
// next shift-click starts a fresh range instead of spanning stale rows.
watch(accounts, () => {
  lastSelectedIdx = null;
});

// ── Export state ──────────────────────────────────────────────────────────────
const showExportWarn = ref(false);
const exportSecret = ref("");
const showExportSecret = ref(false);

function openExportWarn() {
  exportSecret.value = "";
  showExportSecret.value = false;
  showExportWarn.value = true;
}

async function confirmExport() {
  const secret = exportSecret.value.trim() || undefined;
  if (!secret) {
    const msg =
      locale.value === "zh"
        ? "未设置加密密钥，任何持有此文件的人均可读取凭据。确定不加密导出吗？"
        : "No encryption secret set — anyone with this file can read your credentials. Export without encryption?";
    if (!confirm(msg)) return;
  }
  showExportWarn.value = false;
  const ids = selectedIds.value.size > 0 ? [...selectedIds.value] : undefined;
  const payload = await accountsApi.export(ids, secret);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bemby-accounts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Import state ──────────────────────────────────────────────────────────────
const showImport = ref(false);
const importFileEl = ref<HTMLInputElement | null>(null);
const importRawData = ref<unknown>(null);
const importFileEncrypted = ref(false);
const importSecret = ref("");
const showImportSecret = ref(false);
const importForceReauth = ref(true);
const importReady = computed(() => importRawData.value !== null);
const importBusy = ref(false);
const importError = ref("");
const importResult = ref("");

function openImport() {
  importRawData.value = null;
  importFileEncrypted.value = false;
  importSecret.value = "";
  showImportSecret.value = false;
  importForceReauth.value = true;
  importError.value = "";
  importResult.value = "";
  importBusy.value = false;
  showImport.value = true;
}

function onImportFile(e: Event) {
  importError.value = "";
  importResult.value = "";
  importRawData.value = null;
  importFileEncrypted.value = false;
  importSecret.value = "";
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result as string);
      importFileEncrypted.value = raw?.encrypted === true;
      // Also accept bare arrays for backwards compat
      importRawData.value = Array.isArray(raw) ? { accounts: raw } : raw;
    } catch {
      importError.value = t("accounts.importFailed") + ": invalid JSON format";
    }
  };
  reader.readAsText(file);
}

async function doImport() {
  if (!importRawData.value) return;
  importBusy.value = true;
  importError.value = "";
  importResult.value = "";
  try {
    const secret = importSecret.value.trim() || undefined;
    const { imported, skipped } = await accountsApi.import(
      importRawData.value,
      secret,
      importForceReauth.value,
    );
    importResult.value =
      locale.value === "zh"
        ? `导入完成：${imported} 个成功，${skipped} 个跳过（手机号已存在）`
        : `Done: ${imported} imported, ${skipped} skipped (phone already exists)`;
    importRawData.value = null;
    if (importFileEl.value) importFileEl.value.value = "";
    await load();
  } catch (err: any) {
    const code = err.response?.data?.code;
    if (code === "WRONG_SECRET") {
      importError.value = t("accounts.wrongSecret");
    } else {
      importError.value =
        t("accounts.importFailed") +
        ": " +
        (err.response?.data?.error ?? err.message);
    }
  } finally {
    importBusy.value = false;
  }
}

// ── Auth state ────────────────────────────────────────────────────────────────
const showAuth = ref(false);
const authTarget = ref<Account | null>(null);
const authStep = ref<"idle" | "code" | "2fa">("idle");
const authCode = ref("");
const authPassword = ref("");
const authError = ref("");
const authBusy = ref(false);
const isCodeViaApp = ref(false);
const authViaPasskey = ref(false);
const resendBusy = ref(false);

// ── Bulk add state ────────────────────────────────────────────────────────────
const showBulkAdd = ref(false);
const bulkAddText = ref("");
const bulkAddError = ref("");
const bulkAddBusy = ref(false);
const bulkBatch = ref<BulkAddBatch | null>(null);
let bulkPollTimer: ReturnType<typeof setTimeout> | null = null;

// Per-batch options; defaults mirror the backend resolveConfig().
const bulkAdvancedRegex = ref(false);
const bulkOptions = reactive({
  gapSeconds: 70,
  maxRetries: 2,
  retryDelaySeconds: 300,
  namePrefix: "A_",
  nameIndexMode: "total" as "total" | "batch",
  namePadDigits: 0,
  notesTemplate: "Automatically added via {apiUrl}",
  codeFieldId: "code",
  // Defaults reproduce the field-id parsing; capture group 1 is the value.
  codeRegex: 'id="code"[^>]*value="([^"]*)"',
  twoFaMode: "api" as "api" | "fixed",
  twoFaFieldId: "pass2fa",
  twoFaRegex: 'id="pass2fa"[^>]*value="([^"]*)"',
  twoFaFixed: "",
  // Candidate device / proxy ids; empty = any configured entry.
  deviceIds: [] as string[],
  proxyIds: [] as string[],
});

// Candidate API ID/hash pairs; one is picked at random per account. Empty rows
// are dropped on submit; when none are provided the global default is used.
const bulkApiCreds = ref<{ apiId: string; apiHash: string }[]>([
  { apiId: "", apiHash: "" },
]);

function addBulkApiCred() {
  bulkApiCreds.value.push({ apiId: "", apiHash: "" });
}

function removeBulkApiCred(index: number) {
  bulkApiCreds.value.splice(index, 1);
  if (!bulkApiCreds.value.length) bulkApiCreds.value.push({ apiId: "", apiHash: "" });
}

// Paste-many box: one pair per line as "<id> <hash>" (any whitespace, comma or
// tab separates the two). Parsed rows replace the current list.
const bulkApiCredsPasteOpen = ref(false);
const bulkApiCredsPasteText = ref("");

function applyBulkApiCredsPaste() {
  const parsed = bulkApiCredsPasteText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [apiId, apiHash] = line.split(/[\s,\t]+/);
      return { apiId: (apiId ?? "").trim(), apiHash: (apiHash ?? "").trim() };
    })
    .filter((c) => c.apiId && c.apiHash);
  if (!parsed.length) return;
  bulkApiCreds.value = parsed;
  bulkApiCredsPasteText.value = "";
  bulkApiCredsPasteOpen.value = false;
}

const bulkAddPlaceholder =
  "+12025550143----https://example.com/getcode?id=80323dfc-9002-4083-a997-7ea29346d620\n+12025550178----https://example.com/getcode?id=0eaa294a-8d56-4aa4-bec9-6192356fadfc\n+12025550199";

const bulkDoneCount = computed(
  () =>
    bulkBatch.value?.items.filter((i) =>
      ["done", "failed", "created", "skipped"].includes(i.status),
    ).length ?? 0,
);

function openBulkAdd() {
  bulkAddText.value = "";
  bulkAddError.value = "";
  // Keep showing a batch that is still running from a previous open
  if (!bulkBatch.value?.running) bulkBatch.value = null;
  showBulkAdd.value = true;
  if (bulkBatch.value?.running) pollBulk();
}

function closeBulkAdd() {
  showBulkAdd.value = false;
  stopBulkPoll();
  if (!bulkBatch.value?.running) {
    bulkBatch.value = null;
    load();
  }
}

function stopBulkPoll() {
  if (bulkPollTimer) {
    clearTimeout(bulkPollTimer);
    bulkPollTimer = null;
  }
}

async function pollBulk() {
  stopBulkPoll();
  try {
    const batch = await accountsApi.bulkAddStatus();
    bulkBatch.value = batch;
    if (batch?.running) {
      bulkPollTimer = setTimeout(pollBulk, 2000);
    } else {
      await load();
    }
  } catch {
    bulkPollTimer = setTimeout(pollBulk, 4000);
  }
}

// Only send fields relevant to the chosen 2FA mode / advanced toggle so hidden
// values don't silently take effect.
function buildBulkOptions(): BulkAddOptions {
  const o: BulkAddOptions = {
    gapSeconds: bulkOptions.gapSeconds,
    maxRetries: bulkOptions.maxRetries,
    retryDelaySeconds: bulkOptions.retryDelaySeconds,
    namePrefix: bulkOptions.namePrefix,
    nameIndexMode: bulkOptions.nameIndexMode,
    namePadDigits: bulkOptions.namePadDigits,
    notesTemplate: bulkOptions.notesTemplate,
    codeFieldId: bulkOptions.codeFieldId,
    twoFaMode: bulkOptions.twoFaMode,
  };
  if (bulkAdvancedRegex.value) o.codeRegex = bulkOptions.codeRegex;
  if (bulkOptions.twoFaMode === "fixed") {
    o.twoFaFixed = bulkOptions.twoFaFixed;
  } else {
    o.twoFaFieldId = bulkOptions.twoFaFieldId;
    if (bulkAdvancedRegex.value) o.twoFaRegex = bulkOptions.twoFaRegex;
  }
  if (bulkOptions.deviceIds.length) o.deviceIds = [...bulkOptions.deviceIds];
  if (bulkOptions.proxyIds.length) o.proxyIds = [...bulkOptions.proxyIds];
  const creds = bulkApiCreds.value
    .map((c) => ({ apiId: Number(c.apiId), apiHash: c.apiHash.trim() }))
    .filter((c) => Number.isInteger(c.apiId) && c.apiId > 0 && !!c.apiHash);
  if (creds.length) o.apiCredentials = creds;
  return o;
}

async function startBulk() {
  bulkAddError.value = "";
  bulkAddBusy.value = true;
  try {
    bulkBatch.value = await accountsApi.bulkAdd(
      bulkAddText.value,
      buildBulkOptions(),
    );
    pollBulk();
  } catch (err: any) {
    bulkAddError.value =
      err.response?.data?.error ?? t("accounts.bulkAdd.startFailed");
  } finally {
    bulkAddBusy.value = false;
  }
}

async function cancelBulk() {
  bulkAddBusy.value = true;
  try {
    await accountsApi.bulkAddCancel();
    await pollBulk();
  } finally {
    bulkAddBusy.value = false;
  }
}

// ── Bulk rename Telegram profile state ────────────────────────────────────────
// Common names used to pre-fill sensible defaults; the user can edit or paste
// over them before running.
const TG_FIRST_NAMES = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard",
  "Joseph", "Thomas", "Charles", "Daniel", "Matthew", "Anthony", "Mark",
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan",
  "Jessica", "Sarah", "Karen", "Emily", "Emma", "Olivia", "Sophia", "Grace",
  "Lucas", "Ethan", "Noah", "Liam", "Ava", "Mia", "Isla", "Leo", "Ryan",
  "Chloe", "Hannah",
];
const TG_LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin",
  "Lee", "Walker", "Hall", "Allen", "Young", "King", "Wright", "Scott",
  "Green", "Baker", "Adams", "Nelson", "Carter", "Mitchell", "Turner",
  "Parker",
];

function randomOf<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const showBulkTgRename = ref(false);
const bulkTgRenameText = ref("");
const bulkTgRenameError = ref("");
const bulkTgRenameBusy = ref(false);
const bulkTgRenameAiBusy = ref(false);
const bulkTgRenameAiHint = ref("");
const bulkTgRenameAiSkipAbout = ref(false);
const bulkTgRenameGap = ref(3);
const bulkTgRenameBatch = ref<BulkProfileBatch | null>(null);
const bulkTgRenameAvatar = ref(false);
const bulkTgRenameAvatarSource = ref<AvatarSourceMode>("any");
const bulkTgRenameNamesToo = ref(true);
const avatarPool = ref<AvatarPoolStatus | null>(null);

// Bulk usernames. Unlike names, a handle is globally unique, so the pattern carries a
// {rand} suffix by default -- a plain counter collides with handles already taken.
const bulkTgUsername = ref(false);
const bulkTgUsernameForm = reactive({
  format: "user_{index}{rand}",
  startIndex: 1,
  indexDigits: 0,
});
let bulkTgRenamePollTimer: ReturnType<typeof setTimeout> | null = null;

const bulkTgRenamePlaceholder =
  "John\tSmith\tHey there\nMary\tJones\t\nDavid\tBrown";

// Selected, authenticated accounts on the current page, in display order.
const bulkTgRenameTargets = computed(() =>
  accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  ),
);

// One line per account; fields split on tab (falling back to comma when a line
// has no tab): firstName, lastName, intro. Blank lines are ignored.
const bulkTgRenameParsed = computed(() =>
  bulkTgRenameText.value
    .split(/\r?\n/)
    .filter((l) => l.trim().length)
    .map((line) => {
      const delim = line.includes("\t") ? "\t" : ",";
      const parts = line.split(delim);
      return {
        firstName: (parts[0] ?? "").trim(),
        lastName: (parts[1] ?? "").trim(),
        about: parts.slice(2).join(delim).trim(),
      };
    }),
);

function randomHandleSuffix(length = 4): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// Held rather than computed: a computed would re-roll {rand} on every render, so the
// preview would show handles other than the ones actually sent.
const bulkTgUsernameList = ref<string[]>([]);

function regenerateBulkUsernames() {
  const count = bulkTgRenameTargets.value.length;
  const start = Number(bulkTgUsernameForm.startIndex) || 0;
  const digits = Math.max(0, Math.min(9, Number(bulkTgUsernameForm.indexDigits) || 0));
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = start + i;
    const indexStr = digits > 0 ? String(index).padStart(digits, "0") : String(index);
    const build = () =>
      (bulkTgUsernameForm.format || "user_{index}{rand}")
        .replace(/\{index\}/g, indexStr)
        .replace(/\{rand\}/g, () => randomHandleSuffix());
    let candidate = build();
    // A pattern with neither placeholder is the same handle every time, and every
    // account after the first would come back occupied
    for (let attempt = 0; seen.has(candidate.toLowerCase()) && attempt < 20; attempt++) {
      candidate = `${build()}${randomHandleSuffix(2)}`;
    }
    seen.add(candidate.toLowerCase());
    out.push(candidate);
  }
  bulkTgUsernameList.value = out;
}

watch(
  [
    () => bulkTgUsernameForm.format,
    () => bulkTgUsernameForm.startIndex,
    () => bulkTgUsernameForm.indexDigits,
    () => bulkTgRenameTargets.value.length,
    bulkTgUsername,
  ],
  () => {
    if (bulkTgUsername.value) regenerateBulkUsernames();
  },
  { immediate: true },
);

const HANDLE_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const bulkTgUsernameValid = computed(
  () =>
    bulkTgUsernameList.value.length === bulkTgRenameTargets.value.length &&
    bulkTgUsernameList.value.every((u) => HANDLE_RE.test(u)),
);

// Names are only required when the batch is actually writing them. An avatar-only
// run leaves the text box out of it entirely.
const bulkTgRenameValid = computed(() => {
  if (!bulkTgRenameTargets.value.length) return false;
  if (bulkTgUsername.value && !bulkTgUsernameValid.value) return false;
  if (!bulkTgRenameNamesToo.value) {
    return bulkTgRenameAvatar.value || bulkTgUsername.value;
  }
  return (
    bulkTgRenameParsed.value.length === bulkTgRenameTargets.value.length &&
    bulkTgRenameParsed.value.every((p) => p.firstName.length > 0)
  );
});

const bulkTgRenameDoneCount = computed(
  () =>
    bulkTgRenameBatch.value?.items.filter((i) =>
      ["done", "failed"].includes(i.status),
    ).length ?? 0,
);

function generateBulkTgRename() {
  bulkTgRenameText.value = bulkTgRenameTargets.value
    .map(() => `${randomOf(TG_FIRST_NAMES)}\t${randomOf(TG_LAST_NAMES)}`)
    .join("\n");
}

// The backend does the cleaning, so whatever lands in the box already parses back into the
// same rows and sits inside Telegram's limits
async function generateBulkTgRenameWithAi() {
  const count = bulkTgRenameTargets.value.length;
  if (!count || bulkTgRenameAiBusy.value) return;
  bulkTgRenameAiBusy.value = true;
  bulkTgRenameError.value = "";
  try {
    const { profiles } = await accountsApi.bulkProfileGenerate(
      count,
      bulkTgRenameAiHint.value || undefined,
      !bulkTgRenameAiSkipAbout.value,
    );
    bulkTgRenameText.value = profiles
      .map((p) => `${p.firstName}\t${p.lastName}\t${p.about}`.replace(/\t+$/, ""))
      .join("\n");
    // Short of a row per account the operator would have to spot the mismatch themselves
    if (profiles.length < count) {
      bulkTgRenameError.value = t("accounts.bulkTgRename.aiShort")
        .replace("{n}", String(profiles.length))
        .replace("{total}", String(count));
    }
  } catch (err: any) {
    bulkTgRenameError.value =
      err.response?.data?.error ?? t("accounts.bulkTgRename.aiFailed");
  } finally {
    bulkTgRenameAiBusy.value = false;
  }
}

// Names can only be skipped when avatars are being set, or the batch would do nothing.
watch([bulkTgRenameAvatar, bulkTgUsername], ([avatar, username]) => {
  if (!avatar && !username) bulkTgRenameNamesToo.value = true;
});

function openBulkTgRename() {
  bulkTgRenameError.value = "";
  // Keep showing a batch still running from a previous open
  if (!bulkTgRenameBatch.value?.running) {
    bulkTgRenameBatch.value = null;
    bulkTgRenameText.value = "";
  }
  showBulkTgRename.value = true;
  // Tells the operator how many pool images there are before they pick a source
  accountsApi
    .avatarPool()
    .then((s) => (avatarPool.value = s))
    .catch(() => (avatarPool.value = null));
  if (bulkTgRenameBatch.value?.running) pollBulkTgRename();
}

function closeBulkTgRename() {
  showBulkTgRename.value = false;
  stopBulkTgRenamePoll();
  if (!bulkTgRenameBatch.value?.running) {
    bulkTgRenameBatch.value = null;
    load();
  }
}

function stopBulkTgRenamePoll() {
  if (bulkTgRenamePollTimer) {
    clearTimeout(bulkTgRenamePollTimer);
    bulkTgRenamePollTimer = null;
  }
}

async function pollBulkTgRename() {
  stopBulkTgRenamePoll();
  try {
    const batch = await accountsApi.bulkProfileStatus();
    bulkTgRenameBatch.value = batch;
    if (batch?.running) {
      bulkTgRenamePollTimer = setTimeout(pollBulkTgRename, 1500);
    } else {
      await load();
    }
  } catch {
    bulkTgRenamePollTimer = setTimeout(pollBulkTgRename, 3000);
  }
}

async function startBulkTgRename() {
  if (!bulkTgRenameValid.value) return;
  bulkTgRenameError.value = "";
  const parsed = bulkTgRenameParsed.value;
  const withNames = bulkTgRenameNamesToo.value;
  const handles = bulkTgUsername.value ? bulkTgUsernameList.value : [];
  const entries: BulkProfileEntry[] = bulkTgRenameTargets.value.map((a, i) => ({
    accountId: a.id,
    firstName: withNames ? (parsed[i]?.firstName ?? "") : "",
    lastName: withNames ? (parsed[i]?.lastName ?? "") : "",
    about: withNames ? (parsed[i]?.about ?? "") : "",
    username: handles[i] ?? "",
  }));
  bulkTgRenameBusy.value = true;
  try {
    bulkTgRenameBatch.value = await accountsApi.bulkProfile(entries, {
      gapSeconds: bulkTgRenameGap.value,
      avatarSource: bulkTgRenameAvatar.value
        ? bulkTgRenameAvatarSource.value
        : undefined,
    });
    pollBulkTgRename();
  } catch (err: any) {
    bulkTgRenameError.value =
      err.response?.data?.error ?? t("accounts.bulkTgRename.startFailed");
  } finally {
    bulkTgRenameBusy.value = false;
  }
}

async function cancelBulkTgRename() {
  bulkTgRenameBusy.value = true;
  try {
    await accountsApi.bulkProfileCancel();
    await pollBulkTgRename();
  } finally {
    bulkTgRenameBusy.value = false;
  }
}

// ── Bulk change login email state ─────────────────────────────────────────────
const showBulkEmail = ref(false);
const bulkEmailError = ref("");
const bulkEmailTargets = ref<Account[]>([]);
const bulkEmailTaskId = ref<string | null>(null);
const bulkEmailTask = computed(() => taskById(bulkEmailTaskId.value));
const bulkEmailForm = reactive({
  source: "gmail" as "gmail" | "msapi",
  gmail: "",
  appPassword: "",
  tag: "{phoneNum}",
  /** msOauth2api pool type; blank uses the configured default. */
  poolType: "",
  gapSeconds: 30,
});

// Telegram replaces a login email but never adds one, so an account with none linked cannot
// be given one here. Counted off the attribute a fetch records, so it is a warning rather
// than a filter: an account whose attributes were never fetched is simply unknown.
const bulkEmailNoEmailCount = computed(
  () => bulkEmailTargets.value.filter((a) => a.attributes?.hasEmail !== true).length,
);

const bulkEmailTesting = ref(false);
const bulkEmailTestOk = ref<boolean | null>(null);
const bulkEmailTestMsg = ref("");

// Deterministic sample alphabets so the preview reads as a concrete example
// without flickering on every render.
const SAMPLE_ALPHABETS: Record<string, string> = {
  word: "abcdefghijklmnopqrstuvwxyz",
  WORD: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  num: "1234567890",
  alpha: "a1b2c3d4e5f6g7h8i9j0",
};

function sampleToken(alphabet: string, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[i % alphabet.length];
  return s;
}

// Client-side preview of the expanded tag as an example: named tokens use the
// first target's data (a sample Telegram id for {tgId}); random tokens show a
// representative sample value.
function previewEmailTag(template: string): string {
  const acct = bulkEmailTargets.value[0];
  const ctx: Record<string, string> = {
    phoneNum: acct?.phoneNumber?.replace(/\D/g, "") || "{phoneNum}",
    phone: acct?.phoneNumber?.replace(/\D/g, "") || "{phone}",
    id: acct ? String(acct.id) : "{id}",
    tgId: "1234567890",
  };
  const expanded = template.replace(
    /\{(\w+)(?::(\d+))?\}/g,
    (match, type: string, lenStr?: string) => {
      if (type in ctx) return ctx[type];
      if (type in SAMPLE_ALPHABETS)
        return sampleToken(
          SAMPLE_ALPHABETS[type],
          lenStr ? parseInt(lenStr, 10) : RANDOM_TOKEN_LENS[type],
        );
      if (type === "uuid") return "3f9a2c7e-1b4d-4e8a-9c2f-6d5b8a1e0f37";
      return match;
    },
  );
  // Telegram rejects numeric tags, so digits are mapped to letters (0=a..9=j).
  return expanded.replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));
}

// Preview of the full plus-address the accounts will receive.
const bulkEmailExample = computed(() => {
  const g = bulkEmailForm.gmail || "myemail@gmail.com";
  const at = g.lastIndexOf("@");
  const local = at === -1 ? g : g.slice(0, at);
  const domain = at === -1 ? "gmail.com" : g.slice(at + 1);
  const tag = previewEmailTag(bulkEmailForm.tag || "{phoneNum}");
  return `${local}+${tag}@${domain}`;
});

function openBulkEmail() {
  bulkEmailTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  bulkEmailError.value = "";
  bulkEmailForm.source = msApiConfigured.value ? "msapi" : "gmail";
  bulkEmailForm.gmail = "";
  bulkEmailForm.appPassword = "";
  bulkEmailForm.tag = "{phoneNum}";
  bulkEmailForm.poolType = "";
  bulkEmailTesting.value = false;
  bulkEmailTestOk.value = null;
  bulkEmailTestMsg.value = "";
  // A batch still running from an earlier visit keeps showing its progress
  bulkEmailTaskId.value = runningTaskOfKind("login-email")?.id ?? null;
  showBulkEmail.value = true;
}

function closeBulkEmail() {
  showBulkEmail.value = false;
  bulkEmailTaskId.value = null;
}

async function testBulkEmailGmail() {
  bulkEmailError.value = "";
  bulkEmailTestOk.value = null;
  bulkEmailTestMsg.value = "";
  if (!bulkEmailForm.gmail.includes("@")) {
    bulkEmailError.value = t("accounts.bulkEmail.errors.gmailRequired");
    return;
  }
  if (!bulkEmailForm.appPassword) {
    bulkEmailError.value = t("accounts.bulkEmail.errors.appPasswordRequired");
    return;
  }
  bulkEmailTesting.value = true;
  try {
    const r = await accountsApi.testGmail(
      bulkEmailForm.gmail,
      bulkEmailForm.appPassword,
    );
    bulkEmailTestOk.value = r.ok;
    bulkEmailTestMsg.value = r.ok
      ? t("accounts.bulkEmail.testOk")
      : r.error || t("accounts.bulkEmail.testFailed");
  } catch (e: any) {
    bulkEmailTestOk.value = false;
    bulkEmailTestMsg.value =
      e?.response?.data?.error ??
      e?.message ??
      t("accounts.bulkEmail.testFailed");
  } finally {
    bulkEmailTesting.value = false;
  }
}

async function startBulkEmail() {
  bulkEmailError.value = "";
  const viaPool = bulkEmailForm.source === "msapi";
  if (viaPool && !msApiConfigured.value) {
    bulkEmailError.value = t("accounts.bulkEmail.msApiNotConfigured");
    return;
  }
  if (!viaPool) {
    if (!bulkEmailForm.gmail.includes("@")) {
      bulkEmailError.value = t("accounts.bulkEmail.errors.gmailRequired");
      return;
    }
    if (!bulkEmailForm.appPassword) {
      bulkEmailError.value = t("accounts.bulkEmail.errors.appPasswordRequired");
      return;
    }
    if (bulkEmailTestOk.value !== true) {
      bulkEmailError.value = t("accounts.bulkEmail.testRequired");
      return;
    }
    if (!bulkEmailForm.tag.trim()) {
      bulkEmailError.value = t("accounts.bulkEmail.errors.tagRequired");
      return;
    }
  }
  if (!bulkEmailTargets.value.length) return;

  try {
    const task = await bulkTasksApi.loginEmail(
      bulkEmailTargets.value.map((a) => a.id),
      viaPool
        ? { source: "msapi", poolType: bulkEmailForm.poolType }
        : {
            source: "gmail",
            gmail: bulkEmailForm.gmail,
            appPassword: bulkEmailForm.appPassword,
            tag: bulkEmailForm.tag,
          },
      bulkEmailForm.gapSeconds,
    );
    trackStartedTask(task);
    bulkEmailTaskId.value = task.id;
  } catch (e: any) {
    bulkEmailError.value =
      e.response?.data?.error ?? t("bulkTasks.startFailed");
  }
}

// Editing the credentials invalidates a prior successful test, forcing a re-test
// before Start becomes available again.
watch(
  () => [bulkEmailForm.gmail, bulkEmailForm.appPassword],
  () => {
    bulkEmailTestOk.value = null;
    bulkEmailTestMsg.value = "";
  },
);

// ── Bulk change credential state ──────────────────────────────────────────────
const showBulkCred = ref(false);
const bulkCredError = ref("");
const bulkCredTargets = ref<Account[]>([]);
const bulkCredTaskId = ref<string | null>(null);
const bulkCredTask = computed(() => taskById(bulkCredTaskId.value));
const bulkCredForm = reactive({
  currentPassword: "",
  newPassword: "",
  repeatPassword: "",
  removeDevices: false,
  removePasskeys: false,
  notesAppend: "",
  gapSeconds: 30,
});

// 2FA / device / passkey changes need a live (authenticated) session.
function openBulkCred() {
  bulkCredTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  bulkCredError.value = "";
  bulkCredForm.currentPassword = "";
  bulkCredForm.newPassword = "";
  bulkCredForm.repeatPassword = "";
  bulkCredForm.removeDevices = false;
  bulkCredForm.removePasskeys = false;
  bulkCredForm.notesAppend = "";
  // A batch still running from an earlier visit keeps showing its progress
  bulkCredTaskId.value = runningTaskOfKind("credentials")?.id ?? null;
  showBulkCred.value = true;
}

function closeBulkCred() {
  showBulkCred.value = false;
  bulkCredTaskId.value = null;
}

async function startBulkCred() {
  bulkCredError.value = "";
  if (!bulkCredForm.newPassword) {
    bulkCredError.value = t("accounts.bulkCred.errors.newPasswordRequired");
    return;
  }
  if (bulkCredForm.newPassword !== bulkCredForm.repeatPassword) {
    bulkCredError.value = t("accounts.bulkCred.errors.passwordMismatch");
    return;
  }
  if (!bulkCredTargets.value.length) return;

  try {
    const task = await bulkTasksApi.credentials(
      bulkCredTargets.value.map((a) => a.id),
      {
        currentPassword: bulkCredForm.currentPassword || undefined,
        newPassword: bulkCredForm.newPassword,
        removeDevices: bulkCredForm.removeDevices,
        removePasskeys: bulkCredForm.removePasskeys,
        notesAppend: bulkCredForm.notesAppend,
      },
      bulkCredForm.gapSeconds,
    );
    trackStartedTask(task);
    bulkCredTaskId.value = task.id;
  } catch (e: any) {
    bulkCredError.value = e.response?.data?.error ?? t("bulkTasks.startFailed");
  }
}

// ── Bulk add passkey state ────────────────────────────────────────────────────
const showBulkPasskey = ref(false);
const bulkPasskeyTargets = ref<Account[]>([]);
const bulkPasskeyGapSeconds = ref(30);
const bulkPasskeyTaskId = ref<string | null>(null);
const bulkPasskeyTask = computed(() => taskById(bulkPasskeyTaskId.value));

function openBulkPasskey() {
  bulkPasskeyTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  // A batch still running from an earlier visit keeps showing its progress
  bulkPasskeyTaskId.value = runningTaskOfKind("passkey")?.id ?? null;
  showBulkPasskey.value = true;
}

function closeBulkPasskey() {
  showBulkPasskey.value = false;
  bulkPasskeyTaskId.value = null;
}

async function startBulkPasskey() {
  const ids = bulkPasskeyTargets.value.map((a) => a.id);
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.passkey(ids, bulkPasskeyGapSeconds.value);
    trackStartedTask(task);
    bulkPasskeyTaskId.value = task.id;
  } catch (e: any) {
    alert(e.response?.data?.error ?? t("bulkTasks.startFailed"));
  }
}

// ── Bulk privacy state ────────────────────────────────────────────────────────
// The settings, in the order the server writes them, each with its own level so a run can hide
// the avatar and a later one hand it back. The two in PRIVACY_CONTACTS_ONLY are the ones Telegram
// will not take "nobody" for -- being found by number cannot be switched off at all.
const PRIVACY_KEYS = [
  "phoneNumber",
  "addedByPhone",
  "lastSeen",
  "profilePhoto",
  "about",
  "birthday",
  "forwards",
  "calls",
  "callsP2P",
  "giftsAutoSave",
  "chatInvite",
] as const;
const PRIVACY_CONTACTS_ONLY: readonly string[] = ["addedByPhone", "chatInvite"];
const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["nobody", "contacts", "everybody"];

/** Narrowest each key goes, which is what the modal opens on. */
function defaultPrivacySettings(): Record<string, PrivacyLevel> {
  return Object.fromEntries(
    PRIVACY_KEYS.map((key) => [
      key,
      PRIVACY_CONTACTS_ONLY.includes(key) ? "contacts" : "nobody",
    ]),
  );
}

const showBulkPrivacy = ref(false);
const bulkPrivacyTargets = ref<Account[]>([]);
const bulkPrivacyGapSeconds = ref(5);
const bulkPrivacySettings = ref<Record<string, PrivacyLevel>>(
  defaultPrivacySettings(),
);
const bulkPrivacyTaskId = ref<string | null>(null);
const bulkPrivacyTask = computed(() => taskById(bulkPrivacyTaskId.value));

function setAllPrivacyLevels(level: PrivacyLevel) {
  for (const key of PRIVACY_KEYS) {
    // Telegram has no "nobody" for these two, so contacts is as far as they go
    bulkPrivacySettings.value[key] =
      level === "nobody" && PRIVACY_CONTACTS_ONLY.includes(key) ? "contacts" : level;
  }
}

function openBulkPrivacy() {
  bulkPrivacyTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  bulkPrivacySettings.value = defaultPrivacySettings();
  bulkPrivacyTaskId.value = runningTaskOfKind("privacy")?.id ?? null;
  showBulkPrivacy.value = true;
}

function closeBulkPrivacy() {
  showBulkPrivacy.value = false;
  bulkPrivacyTaskId.value = null;
}

async function startBulkPrivacy() {
  const ids = bulkPrivacyTargets.value.map((a) => a.id);
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.privacy(
      ids,
      { ...bulkPrivacySettings.value },
      bulkPrivacyGapSeconds.value,
    );
    trackStartedTask(task);
    bulkPrivacyTaskId.value = task.id;
  } catch (e: any) {
    alert(e.response?.data?.error ?? t("bulkTasks.startFailed"));
  }
}

// ── Bulk clean state ──────────────────────────────────────────────────────────
const showBulkClean = ref(false);
const bulkCleanConfirmChecked = ref(false);
const bulkCleanTargets = ref<Account[]>([]);
const bulkCleanGapSeconds = ref(30);
const bulkCleanTaskId = ref<string | null>(null);
const bulkCleanTask = computed(() => taskById(bulkCleanTaskId.value));

// Clean only applies to accounts with a live (authenticated) session.
function openBulkClean() {
  bulkCleanTargets.value = accounts.value.filter(
    (a) => selectedIds.value.has(a.id) && a.authStatus === "authenticated",
  );
  bulkCleanConfirmChecked.value = false;
  // A batch still running from an earlier visit keeps showing its progress
  bulkCleanTaskId.value = runningTaskOfKind("clean")?.id ?? null;
  showBulkClean.value = true;
}

function closeBulkClean() {
  showBulkClean.value = false;
  bulkCleanTaskId.value = null;
}

async function startBulkClean() {
  const ids = bulkCleanTargets.value.map((a) => a.id);
  if (!ids.length) return;
  try {
    const task = await bulkTasksApi.clean(ids, bulkCleanGapSeconds.value);
    trackStartedTask(task);
    bulkCleanTaskId.value = task.id;
  } catch (e: any) {
    alert(e.response?.data?.error ?? t("bulkTasks.startFailed"));
  }
}


// Lazy-load each tab's data the first time it is opened
watch(editTab, (tab) => {
  if (editTarget.value?.authStatus !== "authenticated") return;
  if (tab === "profile" && !profileLoaded.value) {
    loadProfile();
    loadAvatar();
  }
  if (tab === "devices" && sessions.value.length === 0) loadSessions();
  if (tab === "others") {
    if (!pwdInfo.value) loadPasswordInfo();
    if (!passkeysLoaded.value) loadPasskeys();
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────────
onMounted(async () => {
  await load();
  // Check enabled+authenticated accounts in the background; reload if any are now expired.
  try {
    const { expired } = await accountsApi.checkEnabledSessions();
    if (expired.length > 0) await load();
  } catch {
    // Background check failure is non-critical
  }
  // Auto-fetch TG name for authenticated accounts that have none stored yet.
  for (const a of accounts.value) {
    if (a.authStatus === "authenticated" && !a.tgDisplayName) {
      fetchMeta(a.id); // fire-and-forget, shows spinner in cell
    }
  }
  // Resume tracking a bulk-add batch still running from a previous page load.
  if (bulkMgmtEnabled.value) {
    try {
      const batch = await accountsApi.bulkAddStatus();
      if (batch?.running) {
        bulkBatch.value = batch;
        pollBulk();
      }
    } catch {
      // Non-critical
    }
    // Resume a bulk-rename batch still running from a previous page load.
    try {
      const batch = await accountsApi.bulkProfileStatus();
      if (batch?.running) {
        bulkTgRenameBatch.value = batch;
        pollBulkTgRename();
      }
    } catch {
      // Non-critical
    }
  }
});

// Background bulk tasks keep running server-side, so the list is reloaded when one
// ends rather than being patched row by row while it works.
startBulkTaskPolling();
const stopTaskFinishWatch = onBulkTaskFinished((task) => {
  if (task.kind !== "run-jobs") void load();
});
onUnmounted(() => stopTaskFinishWatch());

async function load() {
  const params = () => ({
    page: page.value,
    pageSize: pageSize.value,
    search: searchParam.value,
    sortKey: sortKey.value || undefined,
    sortDir: sortKey.value ? sortDir.value : undefined,
  });
  let [res, s] = await Promise.all([
    accountsApi.listPaged(params()),
    settingsApi.get(),
  ]);
  settings.value = s;
  if (!res.items.length && page.value > 1) {
    // Page emptied out (e.g. after deletes); step back once
    skipPageWatch = true;
    page.value -= 1;
    res = await accountsApi.listPaged(params());
  }
  accounts.value = res.items;
  total.value = res.total;
  // Drop selections no longer on the loaded page
  const visible = new Set(res.items.map((a) => a.id));
  selectedIds.value = new Set(
    [...selectedIds.value].filter((id) => visible.has(id)),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusBadge(s: Account["authStatus"]) {
  const map: Record<string, string> = {
    authenticated: "badge badge-green",
    pending_code: "badge badge-orange",
    pending_2fa: "badge badge-orange",
    unauthenticated: "badge badge-grey",
    session_expired: "badge badge-red",
  };
  return map[s] ?? "badge badge-grey";
}

function fmtDate(iso: string) {
  const localeMap: Record<string, string> = { en: "en-AU", zh: "zh-CN" };
  return new Date(iso).toLocaleDateString(localeMap[locale.value] ?? "en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ── Add / Edit ─────────────────────────────────────────────────────────────────
function openAdd() {
  editTarget.value = null;
  editTab.value = "basic";
  Object.assign(form, {
    name: "",
    phoneNumber: "",
    apiId: "",
    apiHash: "",
    proxyId: "",
    appClientId: "",
    notes: "",
  });
  formError.value = "";
  showForm.value = true;
}

function openEdit(a: Account) {
  editTarget.value = a;
  Object.assign(form, {
    name: a.name,
    phoneNumber: a.phoneNumber,
    apiId: String(a.apiId),
    apiHash: "",
    proxyId: a.proxyId ?? "",
    appClientId: a.appClientId ?? "",
    notes: a.notes ?? "",
  });
  formError.value = "";
  editTab.value = "basic";
  twoFaCurrentPwd.value = "";
  twoFaNewPwd.value = "";
  twoFaNewPwdConfirm.value = "";
  twoFaHint.value = "";
  twoFaBusy.value = false;
  twoFaError.value = "";
  twoFaMsg.value = "";
  Object.assign(profileForm, { firstName: "", lastName: "", about: "" });
  profileLoaded.value = false;
  profileLoading.value = false;
  profileBusy.value = false;
  profileError.value = "";
  profileMsg.value = "";
  usernameValue.value = "";
  usernameOriginal.value = "";
  usernameBusy.value = false;
  usernameChecking.value = false;
  usernameError.value = "";
  usernameMsg.value = "";
  usernameAvailable.value = null;
  avatarUrl.value = null;
  avatarLoading.value = false;
  avatarBusy.value = false;
  avatarError.value = "";
  sessions.value = [];
  sessionsLoading.value = false;
  sessionsError.value = "";
  terminatingHash.value = null;
  terminateBusy.value = false;
  terminateError.value = "";
  terminateMsg.value = "";
  pwdInfo.value = null;
  pwdInfoLoading.value = false;
  passkeys.value = [];
  passkeysLoaded.value = false;
  passkeysError.value = "";
  deletingPasskeyId.value = null;
  addingPasskey.value = false;
  passkeyStoredIds.value = [];
  verifyingPasskeyId.value = null;
  loginEmailBusy.value = false;
  loginEmailError.value = "";
  loginEmailMsg.value = "";
  loginEmailChangeMode.value = false;
  loginEmailPendingConfirm.value = false;
  loginEmailNewPattern.value = "";
  loginEmailNew.value = "";
  loginEmailCode.value = "";
  showForm.value = true;
}

async function saveAccount() {
  formError.value = "";
  if (!form.name || !form.phoneNumber) {
    formError.value = t("accounts.errors.namePhoneRequired");
    return;
  }
  // On create, credentials are only optional when global defaults exist
  // (on edit, blank fields keep the account's stored credentials)
  if (
    !editTarget.value &&
    !hasGlobalTgCreds.value &&
    (!form.apiId || !form.apiHash)
  ) {
    formError.value = t("accounts.errors.apiCredsRequired");
    return;
  }
  saving.value = true;
  try {
    if (editTarget.value) {
      await accountsApi.update(editTarget.value.id, {
        name: form.name,
        phoneNumber: form.phoneNumber,
        apiId: Number(form.apiId),
        ...(form.apiHash ? { apiHash: form.apiHash } : {}),
        proxyId: form.proxyId || null,
        appClientId: form.appClientId || null,
        notes: form.notes || null,
      });
    } else {
      await accountsApi.create({
        name: form.name,
        phoneNumber: form.phoneNumber,
        apiId: Number(form.apiId),
        apiHash: form.apiHash,
        proxyId: form.proxyId || null,
        appClientId: form.appClientId || null,
        notes: form.notes || null,
      });
    }
    showForm.value = false;
    await load();
  } catch (err: any) {
    const raw = err.response?.data?.error as string | undefined;
    // Translate known backend messages; show others as-is
    formError.value = raw?.includes("apiId and apiHash are required")
      ? t("accounts.errors.apiCredsRequired")
      : raw?.includes("name and phoneNumber are required")
        ? t("accounts.errors.namePhoneRequired")
        : (raw ?? t("common.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── 2FA update ────────────────────────────────────────────────────────────────
async function doUpdateTwoFa() {
  if (!editTarget.value) return;
  if (twoFaNewPwd.value && twoFaNewPwd.value !== twoFaNewPwdConfirm.value) {
    twoFaError.value = t("accounts.twoFaPasswordMismatch");
    return;
  }
  twoFaBusy.value = true;
  twoFaError.value = "";
  twoFaMsg.value = "";
  try {
    await accountsApi.updateTwoFa(editTarget.value.id, {
      currentPassword: twoFaCurrentPwd.value || undefined,
      newPassword: twoFaNewPwd.value || undefined,
      hint: twoFaHint.value || undefined,
    });
    const removed = !twoFaNewPwd.value;
    twoFaMsg.value = removed
      ? t("accounts.twoFaRemoved")
      : t("accounts.twoFaUpdated");
    twoFaCurrentPwd.value = "";
    twoFaNewPwd.value = "";
    twoFaNewPwdConfirm.value = "";
    twoFaHint.value = "";
  } catch (err: any) {
    const msg: string = err.response?.data?.error ?? err.message ?? "";
    twoFaError.value = msg.includes("PASSWORD_HASH_INVALID")
      ? t("accounts.twoFaWrongPassword")
      : msg;
  } finally {
    twoFaBusy.value = false;
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  if (!editTarget.value) return;
  profileLoading.value = true;
  profileError.value = "";
  try {
    const p = await accountsApi.getProfile(editTarget.value.id);
    Object.assign(profileForm, {
      firstName: p.firstName,
      lastName: p.lastName,
      about: p.about,
    });
    usernameValue.value = p.username;
    usernameOriginal.value = p.username;
    profileLoaded.value = true;
  } catch (err: any) {
    profileError.value = err.response?.data?.error ?? err.message;
  } finally {
    profileLoading.value = false;
  }
}

async function doUpdateProfile() {
  if (!editTarget.value || !profileForm.firstName) return;
  profileBusy.value = true;
  profileError.value = "";
  profileMsg.value = "";
  try {
    const res = await accountsApi.updateProfile(editTarget.value.id, {
      firstName: profileForm.firstName,
      lastName: profileForm.lastName || undefined,
      about: profileForm.about || undefined,
    });
    profileMsg.value = t("accounts.profileUpdated");
    // Reflect the refreshed display name in the accounts table
    const target = accounts.value.find((a) => a.id === editTarget.value!.id);
    if (target) target.tgDisplayName = res.tgDisplayName;
  } catch (err: any) {
    profileError.value = err.response?.data?.error ?? err.message;
  } finally {
    profileBusy.value = false;
  }
}

// ── Username ──────────────────────────────────────────────────────────────────
const usernameNormalised = computed(() =>
  usernameValue.value.trim().replace(/^@+/, ""),
);
const usernameChanged = computed(
  () => usernameNormalised.value !== usernameOriginal.value,
);
// Mirrors the backend rule so an obviously bad handle never costs a round trip
const usernameLooksValid = computed(() =>
  /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(usernameNormalised.value),
);

// Telegram answers with raw codes; each means something different to whoever is looking
// at the box, so they are worth spelling out rather than showing verbatim.
function friendlyUsernameError(raw: string): string {
  if (raw.includes("USERNAME_OCCUPIED")) return t("accounts.usernameTaken");
  if (raw.includes("USERNAME_PURCHASE_AVAILABLE")) {
    return t("accounts.usernameForSale");
  }
  if (raw.includes("USERNAME_INVALID")) return t("accounts.usernameRejected");
  if (raw.includes("USERNAME_NOT_MODIFIED")) return t("accounts.usernameSame");
  if (raw.includes("FLOOD_WAIT")) return t("accounts.usernameFlood");
  return raw;
}

async function checkUsernameAvailable() {
  if (!editTarget.value || !usernameLooksValid.value) return;
  usernameChecking.value = true;
  usernameError.value = "";
  usernameMsg.value = "";
  usernameAvailable.value = null;
  try {
    const res = await accountsApi.checkUsername(
      editTarget.value.id,
      usernameNormalised.value,
    );
    usernameAvailable.value = res.available;
    if (!res.available && res.reason) {
      usernameError.value = friendlyUsernameError(res.reason);
    }
  } catch (err: any) {
    usernameError.value = friendlyUsernameError(
      err.response?.data?.error ?? err.message,
    );
  } finally {
    usernameChecking.value = false;
  }
}

async function doUpdateUsername() {
  if (!editTarget.value || !usernameChanged.value) return;
  // An empty box clears the handle, which Telegram accepts and the length rule does not
  if (usernameNormalised.value && !usernameLooksValid.value) return;
  usernameBusy.value = true;
  usernameError.value = "";
  usernameMsg.value = "";
  try {
    const res = await accountsApi.updateUsername(
      editTarget.value.id,
      usernameNormalised.value,
    );
    usernameOriginal.value = res.username;
    usernameValue.value = res.username;
    usernameAvailable.value = null;
    usernameMsg.value = res.username
      ? t("accounts.usernameUpdated")
      : t("accounts.usernameCleared");
    const target = accounts.value.find((a) => a.id === editTarget.value!.id);
    if (target) target.tgUsername = res.username || null;
  } catch (err: any) {
    usernameError.value = friendlyUsernameError(
      err.response?.data?.error ?? err.message,
    );
  } finally {
    usernameBusy.value = false;
  }
}

// ── Avatar ────────────────────────────────────────────────────────────────────
// Fetched separately from the rest of the profile: it is a media download rather
// than a field read, so a slow one should not hold up the name and bio.
async function loadAvatar() {
  if (!editTarget.value) return;
  avatarLoading.value = true;
  avatarError.value = "";
  avatarUrl.value = null;
  try {
    const { dataUrl } = await accountsApi.getAvatar(editTarget.value.id);
    avatarUrl.value = dataUrl;
  } catch (err: any) {
    avatarError.value = err.response?.data?.error ?? err.message;
  } finally {
    avatarLoading.value = false;
  }
}

async function onAvatarPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // so re-picking the same file fires change again
  if (!file || !editTarget.value) return;
  avatarBusy.value = true;
  avatarError.value = "";
  profileMsg.value = "";
  try {
    await accountsApi.setAvatar(editTarget.value.id, file);
    profileMsg.value = t("accounts.avatarUpdated");
    await loadAvatar();
  } catch (err: any) {
    avatarError.value = err.response?.data?.error ?? err.message;
  } finally {
    avatarBusy.value = false;
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function loadSessions() {
  if (!editTarget.value) return;
  sessionsLoading.value = true;
  sessionsError.value = "";
  terminateMsg.value = "";
  try {
    sessions.value = await accountsApi.getSessions(editTarget.value.id);
  } catch (err: any) {
    sessionsError.value = err.response?.data?.error ?? err.message;
  } finally {
    sessionsLoading.value = false;
  }
}

async function doTerminateSession(hash: string) {
  if (!editTarget.value) return;
  terminatingHash.value = hash;
  terminateError.value = "";
  try {
    await accountsApi.terminateSession(editTarget.value.id, hash);
    sessions.value = sessions.value.filter((s) => s.hash !== hash);
  } catch (err: any) {
    terminateError.value = err.response?.data?.error ?? err.message;
  } finally {
    terminatingHash.value = null;
  }
}

async function doTerminateAllSessions() {
  if (!editTarget.value) return;
  if (!confirm(t("accounts.terminateSessionsConfirm"))) return;
  terminateBusy.value = true;
  terminateError.value = "";
  terminateMsg.value = "";
  try {
    await accountsApi.terminateOtherSessions(editTarget.value.id);
    terminateMsg.value = t("accounts.terminateSessionsDone");
    // Reload so the list shows only the current session
    await loadSessions();
  } catch (err: any) {
    terminateError.value = err.response?.data?.error ?? err.message;
  } finally {
    terminateBusy.value = false;
  }
}

function fmtSessionDate(unix: number) {
  return new Date(unix * 1000).toLocaleString(
    locale.value === "zh" ? "zh-CN" : "en-AU",
    { dateStyle: "medium", timeStyle: "short" },
  );
}

// ── Login email functions ─────────────────────────────────────────────────────

async function loadPasswordInfo() {
  if (!editTarget.value) return;
  pwdInfoLoading.value = true;
  try {
    pwdInfo.value = await accountsApi.getPasswordInfo(editTarget.value.id);
    // Reflect the freshly-fetched login-email state on the list row immediately.
    const attrs = { ...(editTarget.value.attributes ?? {}) };
    if (pwdInfo.value.loginEmailPattern) attrs.hasEmail = true;
    else delete attrs.hasEmail;
    editTarget.value.attributes = attrs;
  } catch {
    // non-fatal: section just won't show
  } finally {
    pwdInfoLoading.value = false;
  }
}

async function loadPasskeys() {
  if (!editTarget.value) return;
  passkeysLoading.value = true;
  passkeysError.value = "";
  try {
    const data = await accountsApi.getPasskeys(editTarget.value.id);
    passkeys.value = data.passkeys;
    passkeyStoredIds.value = data.storedIds;
    passkeysLoaded.value = true;
    // Reflect the "any passkey" state on the list row immediately.
    const attrs = { ...(editTarget.value.attributes ?? {}) };
    editTarget.value.hasPasskey = data.passkeys.length > 0;
    if (data.passkeys.length) attrs.hasPasskey = true;
    else delete attrs.hasPasskey;
    editTarget.value.attributes = attrs;
  } catch (err: any) {
    passkeysError.value = err.response?.data?.error ?? err.message;
  } finally {
    passkeysLoading.value = false;
  }
}

async function doDeletePasskey(pk: Passkey) {
  if (!editTarget.value) return;
  if (!confirm(t("accounts.passkeyRemoveConfirm").replace("{name}", pk.name || "?")))
    return;
  deletingPasskeyId.value = pk.id;
  passkeysError.value = "";
  try {
    await accountsApi.deletePasskey(editTarget.value.id, pk.id);
    passkeys.value = passkeys.value.filter((p) => p.id !== pk.id);
  } catch (err: any) {
    passkeysError.value = err.response?.data?.error ?? err.message;
  } finally {
    deletingPasskeyId.value = null;
  }
}

async function doAddPasskey() {
  if (!editTarget.value) return;
  addingPasskey.value = true;
  passkeysError.value = "";
  try {
    await accountsApi.registerPasskey(editTarget.value.id);
    await loadPasskeys();
    alert(t("accounts.passkeyAdded2"));
  } catch (err: any) {
    passkeysError.value = err.response?.data?.error ?? err.message;
  } finally {
    addingPasskey.value = false;
  }
}

async function doVerifyPasskey(pk: Passkey) {
  if (!editTarget.value) return;
  verifyingPasskeyId.value = pk.id;
  passkeysError.value = "";
  try {
    const r = await accountsApi.verifyPasskey(editTarget.value.id, pk.id);
    if (r.ok && r.passwordRequired) {
      alert(t("accounts.passkeyVerifyOkPwd"));
    } else if (r.ok) {
      alert(
        t("accounts.passkeyVerifyOk").replace(
          "{who}",
          r.username ? `@${r.username}` : (r.firstName ?? r.userId),
        ),
      );
    } else {
      passkeysError.value = t("accounts.passkeyVerifyFailed");
    }
  } catch (err: any) {
    passkeysError.value = err.response?.data?.error ?? err.message;
  } finally {
    verifyingPasskeyId.value = null;
  }
}

function openChangeLoginEmail() {
  loginEmailChangeMode.value = true;
  loginEmailNew.value = "";
  loginEmailError.value = "";
  loginEmailMsg.value = "";
}

// Translate known Telegram refusal codes into readable messages
function loginEmailErrorText(raw: string): string {
  if (raw === "EMAIL_NOT_SETUP") return t("accounts.loginEmailNotSetup");
  if (raw === "EMAIL_INVALID") return t("accounts.loginEmailInvalid");
  if (raw === "EMAIL_NOT_ALLOWED") return t("accounts.loginEmailNotAllowed");
  if (raw === "CODE_INVALID" || raw === "EMAIL_TOKEN_INVALID") return t("accounts.loginEmailBadCode");
  if (raw === "EMAIL_VERIFY_EXPIRED") return t("accounts.loginEmailCodeExpired");
  if (raw.startsWith("FLOOD")) return t("accounts.loginEmailFlood");
  return raw;
}

async function doSendLoginEmailCode() {
  if (!editTarget.value || !loginEmailNew.value) return;
  loginEmailBusy.value = true;
  loginEmailError.value = "";
  try {
    const r = await accountsApi.sendLoginEmailCode(editTarget.value.id, loginEmailNew.value);
    loginEmailChangeMode.value = false;
    loginEmailPendingConfirm.value = true;
    loginEmailNewPattern.value = r.emailPattern;
    loginEmailCode.value = "";
  } catch (err: any) {
    loginEmailError.value = loginEmailErrorText(err.response?.data?.error ?? err.message);
  } finally {
    loginEmailBusy.value = false;
  }
}

async function doVerifyLoginEmail() {
  if (!editTarget.value || !loginEmailCode.value) return;
  loginEmailBusy.value = true;
  loginEmailError.value = "";
  try {
    await accountsApi.verifyLoginEmail(
      editTarget.value.id,
      loginEmailCode.value,
      loginEmailNew.value,
    );
    loginEmailPendingConfirm.value = false;
    loginEmailNewPattern.value = "";
    loginEmailNew.value = "";
    loginEmailCode.value = "";
    loginEmailMsg.value = t("accounts.loginEmailDone");
    await loadPasswordInfo();
  } catch (err: any) {
    loginEmailError.value = loginEmailErrorText(err.response?.data?.error ?? err.message);
  } finally {
    loginEmailBusy.value = false;
  }
}

async function doResendLoginEmailCode() {
  if (!editTarget.value || !loginEmailNew.value) return;
  loginEmailBusy.value = true;
  loginEmailError.value = "";
  try {
    const r = await accountsApi.sendLoginEmailCode(editTarget.value.id, loginEmailNew.value);
    loginEmailNewPattern.value = r.emailPattern;
  } catch (err: any) {
    loginEmailError.value = loginEmailErrorText(err.response?.data?.error ?? err.message);
  } finally {
    loginEmailBusy.value = false;
  }
}

// Abandon the pending change locally; the emailed code simply expires
function cancelLoginEmailChange() {
  loginEmailPendingConfirm.value = false;
  loginEmailNewPattern.value = "";
  loginEmailNew.value = "";
  loginEmailCode.value = "";
  loginEmailError.value = "";
}

// ── Force Re-auth ─────────────────────────────────────────────────────────────
const forceReauthBusy = ref(false);

async function doForceReauth() {
  if (!editTarget.value) return;
  const msg =
    locale.value === "zh"
      ? "这将清除该账户的会话，您需要重新进行身份验证。确定吗？"
      : "This will clear the session for this account and require re-authentication. Continue?";
  if (!confirm(msg)) return;
  forceReauthBusy.value = true;
  try {
    await accountsApi.forceReauth(editTarget.value.id);
    showForm.value = false;
    await load();
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t("common.saveFailed");
  } finally {
    forceReauthBusy.value = false;
  }
}

async function remove(id: number) {
  if (!confirm(t("accounts.confirmDelete"))) return;
  await accountsApi.delete(id);
  await load();
}

async function toggleDisabled(a: Account) {
  await accountsApi.update(a.id, { disabled: !a.disabled });
  await load();
}

async function openCheckStatus(a: Account) {
  statusTarget.value = a;
  statusResult.value = null;
  statusError.value = "";
  statusChecking.value = true;
  showStatus.value = true;
  try {
    statusResult.value = await accountsApi.checkStatus(a.id);
  } catch (err: any) {
    statusError.value = err.response?.data?.error ?? "Failed to check status";
  } finally {
    statusChecking.value = false;
  }
  // Run spam check after checkStatus disconnects to avoid AUTH_KEY_DUPLICATED
  // (both calls create separate TelegramClient instances from the same session)
  if (!a.disabled) checkSpam(a);
}

// ── Auth flow ─────────────────────────────────────────────────────────────────
function openAuth(a: Account) {
  authTarget.value = a;
  authStep.value = "idle";
  authCode.value = "";
  authPassword.value = "";
  authError.value = "";
  authViaPasskey.value = false;
  showAuth.value = true;
  // With a usable stored passkey, skip the idle step: log in and go straight to 2FA.
  if (a.hasBembyPasskey) sendCode();
}

function closeAuth() {
  showAuth.value = false;
}

// Translate known Telegram auth refusal codes into readable, localised messages.
function authErrorText(raw: string): string {
  if (!raw) return t("accounts.errors.verifyFailed");
  if (raw.includes("PASSWORD_HASH_INVALID"))
    return t("accounts.twoFaWrongPassword");
  if (raw.includes("PHONE_CODE_INVALID") || raw.includes("PHONE_CODE_EMPTY"))
    return t("accounts.errors.codeInvalid");
  if (raw.includes("PHONE_CODE_EXPIRED"))
    return t("accounts.errors.codeExpired");
  if (raw.startsWith("FLOOD")) return t("accounts.errors.flood");
  return raw;
}

async function sendCode() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    const res = await accountsApi.requestCode(authTarget.value.id);
    if (res.method === "passkey") {
      authViaPasskey.value = true;
      if (res.step === "done") {
        showAuth.value = false;
        await load();
      } else {
        authStep.value = "2fa";
      }
    } else {
      authViaPasskey.value = false;
      isCodeViaApp.value = res.isCodeViaApp ?? false;
      authStep.value = "code";
    }
  } catch (err: any) {
    authError.value = authErrorText(
      err.response?.data?.error ?? err.message ?? "",
    );
  } finally {
    authBusy.value = false;
  }
}

async function resendAsSms() {
  if (!authTarget.value) return;
  resendBusy.value = true;
  try {
    await accountsApi.resendCode(authTarget.value.id);
    isCodeViaApp.value = false;
  } catch (err: any) {
    authError.value =
      err.response?.data?.error ?? t("accounts.errors.sendFailed");
  } finally {
    resendBusy.value = false;
  }
}

async function verifyCode() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    const res = await accountsApi.verify(authTarget.value.id, {
      code: authCode.value,
    });
    if (res.step === "2fa") {
      authStep.value = "2fa";
    } else {
      showAuth.value = false;
      await load();
    }
  } catch (err: any) {
    authError.value = authErrorText(
      err.response?.data?.error ?? err.message ?? "",
    );
  } finally {
    authBusy.value = false;
  }
}

async function verify2fa() {
  if (!authTarget.value) return;
  authError.value = "";
  authBusy.value = true;
  try {
    await accountsApi.verify(authTarget.value.id, {
      password: authPassword.value,
    });
    showAuth.value = false;
    await load();
  } catch (err: any) {
    authError.value = authErrorText(
      err.response?.data?.error ?? err.message ?? "",
    );
  } finally {
    authBusy.value = false;
  }
}
</script>

<style scoped>
/* The search box holds a list, so it is a textarea; it stays input-sized on one line */
.account-search {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.account-search-box {
  width: 200px;
  resize: vertical;
  line-height: 1.4;
  font-family: inherit;
}

.account-search-count {
  font-size: 11px;
  color: #888;
}

/* What the lockdown is about to set, listed rather than summarised */
.bulk-privacy-bulkset {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.bulk-privacy-list {
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: #555;
}

.bulk-privacy-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 5px 0;
  border-bottom: 1px solid #f0f0f0;
}

.bulk-privacy-key {
  flex: 1 1 220px;
}

.bulk-privacy-levels {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.bulk-privacy-level {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.bulk-privacy-level.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.device-model-preview {
  margin-top: 3px;
  font-size: 11px;
  color: #888;
  font-family: var(--font-mono, monospace);
}

.phone-country {
  margin-top: 3px;
  font-size: 11px;
  color: #888;
  white-space: nowrap;
}

.phone-country-flag {
  margin-right: 3px;
  font-size: 13px;
}

.device-model-preview i {
  margin-right: 4px;
  opacity: 0.7;
}

.device-model-preview-form {
  margin-top: 6px;
  font-size: 12px;
  color: #888;
  display: flex;
  align-items: center;
  gap: 5px;
}

.device-model-preview-form .dmp-value {
  font-family: var(--font-mono, monospace);
  color: #555;
}

.tg-name-cell {
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tg-name-text {
  font-size: 13px;
}

.tg-name-username {
  font-size: 11px;
  color: #888;
}

.tg-name-loading {
  display: flex;
  align-items: center;
}

.tg-name-refresh {
  opacity: 0;
  transition: opacity 0.15s;
  padding: 2px 4px;
  font-size: 11px;
}

tr:hover .tg-name-refresh {
  opacity: 1;
}

@media (max-width: 767px) {
  .tg-name-cell {
    display: none;
  }
}

.btn-xs {
  padding: 2px 6px;
  font-size: 11px;
  height: 22px;
}

/* Minimal inline spinner */
.spinner-xs {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid #e5e7eb;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.page-header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.code-hint-note {
  font-size: 12px;
  color: #9ca3af;
  margin: 6px 0 12px;
  line-height: 1.5;
}

.warn-box {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
  color: #92400e;
  line-height: 1.5;
}

.edit-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 2px solid #e5e7eb;
  margin-bottom: 16px;
}

.edit-tab {
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  color: #6b7280;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.edit-tab:hover {
  color: #374151;
}

.edit-tab.active {
  color: #4f46e5;
  border-bottom-color: #4f46e5;
}

.btn-inline {
  width: auto;
  display: inline-flex;
}

.sessions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.sessions-header .form-section-label {
  margin-bottom: 0;
}

.sessions-empty {
  font-size: 13px;
  color: #9ca3af;
  padding: 12px 0;
}

.sessions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fafafa;
}

.session-current {
  background: #f0fdf4;
  border-color: #bbf7d0;
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-device {
  font-size: 13px;
  font-weight: 500;
  color: #111827;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.session-meta {
  font-size: 11px;
  color: #6b7280;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.section-divider {
  border: none;
  border-top: 1px solid #e5e7eb;
  margin: 16px 0 12px;
}

.form-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  margin-bottom: 12px;
}

.form-hint {
  font-size: 11px;
  color: #9ca3af;
  margin: 0 0 4px;
}

.username-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.username-row .form-input {
  flex: 1;
  min-width: 0;
}

.username-at {
  color: #9ca3af;
  font-size: 15px;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.avatar-frame {
  width: 72px;
  height: 72px;
  flex: none;
  border-radius: 50%;
  overflow: hidden;
  background: #f1f3f5;
  border: 1px solid #e3e7eb;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #adb5bd;
}

.avatar-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-placeholder {
  font-size: 28px;
}

.avatar-actions {
  min-width: 0;
}

.avatar-actions .form-hint {
  margin-top: 6px;
}

.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle .form-input {
  padding-right: 38px;
  flex: 1;
}

.toggle-secret-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: #888;
  padding: 4px;
  line-height: 1;
}

.toggle-secret-btn:hover {
  color: #444;
}

.row-disabled td {
  opacity: 0.5;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}

.status-label {
  min-width: 110px;
  font-weight: 500;
  color: #666;
  flex-shrink: 0;
}

.restriction-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px solid #f5f5f5;
}

th.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.sort-ind {
  margin-left: 5px;
  font-size: 11px;
}

.sort-ind-dim {
  opacity: 0.3;
}

th.sortable:hover .sort-ind-dim {
  opacity: 0.6;
}

.drag-handle {
  cursor: grab;
  color: #ccc;
  padding: 0 4px;
  user-select: none;
  width: 20px;
}

.drag-handle:hover {
  color: #888;
}

tr[draggable] {
  cursor: default;
}

tr.drag-over td {
  background: #eef2ff;
}

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: #fff;
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
  color: #888;
  border-bottom: 1px solid #f0f0f0;
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
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: #f5f5f5;
}

.action-sheet-btn.danger {
  color: #e63946;
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}

/* ── Bulk add ── */
.modal-lg {
  width: 640px;
}

.bulk-add-hint {
  color: #666;
  font-size: 13px;
  margin-bottom: 12px;
}

.bulk-add-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

.bulk-add-progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
}

.bulk-add-running {
  color: #1296db;
  font-weight: 500;
}

.bulk-add-finished {
  color: #52c41a;
  font-weight: 500;
}

.bulk-add-list {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bulk-add-item {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #eee;
  border-radius: 8px;
}

.bulk-email-test {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -4px 0 14px;
  flex-wrap: wrap;
}

.bulk-email-test .btn {
  margin-left: auto;
}

.bulk-email-test-ok {
  color: #52c41a;
  font-size: 13px;
}

.bulk-email-test-fail {
  color: #ff4d4f;
  font-size: 13px;
  word-break: break-word;
}

.bulk-email-preview {
  margin-top: 6px;
  font-size: 12px;
  color: #666;
}

.bulk-email-preview span {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #1296db;
  word-break: break-all;
}

.bulk-clean-accounts {
  margin-top: 12px;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 8px;
}

.bulk-clean-account {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
  border-bottom: 1px solid #f2f2f2;
}

.bulk-clean-account:last-child {
  border-bottom: none;
}

.bulk-tgrename-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.bulk-tgrename-arrow {
  color: #1296db;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bulk-tgrename-arrow i {
  margin-right: 4px;
  opacity: 0.6;
}

.bulk-add-options {
  margin-top: 16px;
  padding: 16px 18px;
  background: #f7f8fa;
  border: 1px solid #ececf0;
  border-radius: 10px;
}

.bulk-add-options .form-section-label {
  margin: 0 0 14px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8a8a94;
}

.bulk-add-options .form-group {
  margin-bottom: 12px;
}

.bulk-add-options .form-hint {
  margin-top: 5px;
}

.bulk-add-options-row {
  display: flex;
  gap: 12px;
}

.bulk-add-options-row .form-group {
  flex: 1;
  min-width: 0;
}

/* Divider before the "how to parse" controls */
.bulk-add-options .form-check {
  margin: 16px 0 12px;
  padding-top: 14px;
  border-top: 1px dashed #e0e0e6;
  font-size: 13px;
  font-weight: 500;
  color: #444;
  cursor: pointer;
}

.bulk-add-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  background: #fbfbfd;
}

/* The revealed login email: selectable, and spelled as stored rather than uppercased the
   way the badge beside it is */
.revealed-email {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #475569;
  word-break: break-all;
  margin-bottom: 4px;
  user-select: text;
}

.bulk-add-multiselect {
  min-height: 92px;
  padding: 4px;
}

.bulk-add-cred-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.bulk-add-cred-row .form-input:first-child {
  flex: 0 0 130px;
}

.bulk-add-cred-row .form-input:nth-child(2) {
  flex: 1;
  min-width: 0;
}

.bulk-add-cred-actions {
  display: flex;
  gap: 8px;
  margin: 4px 0 8px;
}

.bulk-rename-preview {
  border: 1px solid #e0e0e6;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fbfbfd;
  font-size: 13px;
}

.bulk-rename-preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.bulk-rename-old {
  color: #888;
}

.bulk-rename-new {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.bulk-add-status-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 5px;
  background: #d0d0d0;
}
.bulk-add-status-dot.status-done {
  background: #52c41a;
}
.bulk-add-status-dot.status-created {
  background: #1296db;
}
.bulk-add-status-dot.status-skipped {
  background: #95de64;
}
.bulk-add-status-dot.status-failed {
  background: #ff4d4f;
}
.bulk-add-status-dot.status-pending,
.bulk-add-status-dot.status-waiting {
  background: #d0d0d0;
}
.bulk-add-status-dot.status-requesting_code,
.bulk-add-status-dot.status-fetching_code,
.bulk-add-status-dot.status-submitting_code,
.bulk-add-status-dot.status-submitting_2fa,
.bulk-add-status-dot.status-cleaning,
.bulk-add-status-dot.status-fetching,
.bulk-add-status-dot.status-updating,
.bulk-add-status-dot.status-working {
  background: #1296db;
  animation: bulk-pulse 1s ease-in-out infinite;
}
.bulk-add-status-dot.status-retrying {
  background: #faad14;
  animation: bulk-pulse 1s ease-in-out infinite;
}

@keyframes bulk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.bulk-add-item-body {
  flex: 1;
  min-width: 0;
}

.bulk-add-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.bulk-add-phone {
  color: #666;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.bulk-menu {
  position: relative;
  display: inline-block;
}
.bulk-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.bulk-menu-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 100;
  min-width: 220px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 6px;
}
.bulk-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  background: none;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
}
.bulk-menu-item:not(:disabled):hover {
  background: #f5f5f7;
}
.bulk-menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.bulk-menu-item.danger {
  color: #e63946;
}
.bulk-menu-item i {
  width: 16px;
  text-align: center;
}
.bulk-menu-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}

.bulk-add-item-status {
  margin-left: auto;
  font-size: 12px;
  color: #888;
}

.bulk-add-item-msg {
  font-size: 12px;
  color: #999;
  margin-top: 3px;
  word-break: break-word;
}

.bulk-add-item-error {
  color: #ff4d4f;
}
</style>
