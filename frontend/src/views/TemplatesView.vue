<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('templates.title') }}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input
          v-model="searchText"
          class="form-input"
          style="width:200px"
          :placeholder="t('common.search')"
        />
        <template v-if="selectedIds.length">
          <button class="btn btn-secondary" @click="shareSelected">
            <i :class="sharedMulti ? 'fa-solid fa-check' : 'fa-solid fa-share-nodes'"></i>
            {{ t('templates.shareSelectedBtn').replace('{n}', String(selectedIds.length)) }}
          </button>
          <button class="btn btn-secondary" :disabled="isMutingBot" @click="bulkMuteBotForever"><i class="fa-solid fa-bell-slash"></i> {{ t('templates.bulkMuteBotForever') }}</button>
          <button class="btn btn-secondary" @click="bulkEnableTpls"><i class="fa-solid fa-circle-check"></i> {{ t('templates.bulkEnable').replace('{n}', String(selectedIds.length)) }}</button>
          <button class="btn btn-secondary" @click="confirmBulkDisableTpls = true"><i class="fa-solid fa-ban"></i> {{ t('templates.bulkDisable').replace('{n}', String(selectedIds.length)) }}</button>
          <button class="btn btn-danger" @click="confirmBulkDeleteTpls = true"><i class="fa-solid fa-trash"></i> {{ t('templates.bulkDelete').replace('{n}', String(selectedIds.length)) }}</button>
        </template>
        <button v-if="templates.length" class="btn btn-secondary" @click="toggleAll">
          {{ allSelected ? t('common.deselectAll') : t('common.selectAll') }}
        </button>
        <button class="btn btn-secondary" @click="openImport"><i class="fa-solid fa-file-import"></i> {{ t('templates.importBtn') }}</button>
        <button class="btn btn-primary" @click="openAdd"><i class="fa-solid fa-plus"></i> {{ t('templates.addBtn') }}</button>
      </div>
    </div>

    <div v-if="importNotice" class="success-msg" style="margin-bottom:12px">
      {{ importNotice }}
      <button class="btn btn-ghost btn-sm btn-icon" style="margin-left:8px" @click="importNotice = ''">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>

    <div class="card">
      <PaginationBar
        :page="page"
        :page-size="pageSize"
        :total="total"
        @update:page="onPageChange"
        @update:page-size="onPageSizeChange"
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="th-sort" :class="sortKey === 'name' ? 'sort-active' : ''" @click="setSort('name')">{{ t('common.name') }} <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th class="th-sort" :class="sortKey === 'type' ? 'sort-active' : ''" @click="setSort('type')">{{ t('templates.colType') }} <span class="sort-icon">{{ sortIcon('type') }}</span></th>
              <th class="th-sort" :class="sortKey === 'enabled' ? 'sort-active' : ''" @click="setSort('enabled')">{{ t('templates.colEnabled') }} <span class="sort-icon">{{ sortIcon('enabled') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'botUrl' ? 'sort-active' : ''" @click="setSort('botUrl')">{{ t('templates.colBotUrl') }} <span class="sort-icon">{{ sortIcon('botUrl') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'linkedJobs' ? 'sort-active' : ''" @click="setSort('linkedJobs')">{{ t('templates.colLinkedJobs') }} <span class="sort-icon">{{ sortIcon('linkedJobs') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'created' ? 'sort-active' : ''" @click="setSort('created')">{{ t('templates.colAdded') }} <span class="sort-icon">{{ sortIcon('created') }}</span></th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!templates.length">
              <td colspan="7" class="empty">{{ t('templates.noTemplates') }}</td>
            </tr>
            <tr
              v-for="(tpl, idx) in templates"
              :key="tpl.id"
              style="cursor:pointer"
              :class="selectedIds.includes(tpl.id) ? 'row-selected' : ''"
              @click="toggleSelect(tpl.id, idx, $event)"
            >
              <td>{{ tpl.name }}</td>
              <td><span :class="jobTypeBadge(tpl.jobType)">{{ t(`logs.jobType.${tpl.jobType}`) }}</span></td>
              <td>
                <span
                  :class="tpl.enabled ? 'badge badge-green' : 'badge badge-grey'"
                  style="cursor:pointer;user-select:none"
                  @click.stop="toggleTemplateEnabled(tpl)"
                >
                  {{ tpl.enabled ? t('common.yes') : t('common.no') }}
                </span>
              </td>
              <td class="col-hide-mobile">{{ tpl.jobType === 'embywatch' ? tpl.botUsername : '@' + tpl.botUsername }}</td>
              <td class="col-hide-mobile">{{ tpl.linkedJobCount ?? 0 }}</td>
              <td class="col-hide-mobile">{{ fmtDate(tpl.createdAt) }}</td>
              <td @click.stop>
                <div class="actions hide-mobile">
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.createJobsBtn')"
                    @click="openCreateJobs(tpl)"
                  ><i class="fa-solid fa-list-check"></i></button>
                  <button
                    v-if="(tpl.linkedJobCount ?? 0) > 0"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.enableLinkedJobs')"
                    @click="setLinkedJobsEnabled(tpl, true)"
                  ><i class="fa-solid fa-circle-check"></i></button>
                  <button
                    v-if="(tpl.linkedJobCount ?? 0) > 0"
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.disableLinkedJobs')"
                    @click="setLinkedJobsEnabled(tpl, false)"
                  ><i class="fa-solid fa-circle-xmark"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="copiedTplId === tpl.id ? t('templates.shareCopied') : t('templates.shareBtn')" @click="shareTemplate(tpl)">
                    <i :class="copiedTplId === tpl.id ? 'fa-solid fa-check' : 'fa-solid fa-share-nodes'"></i>
                  </button>
                  <button
                    class="btn btn-sm btn-ghost btn-icon"
                    :title="t('templates.duplicateBtn')"
                    :disabled="duplicatingId !== null"
                    @click="duplicateTemplate(tpl)"
                  ><i class="fa-solid fa-clone"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.edit')" @click="openEdit(tpl)"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn btn-sm btn-danger btn-icon" :title="t('common.delete')" @click="openDeleteTpl(tpl.id)"><i class="fa-solid fa-trash"></i></button>
                </div>
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuTpl = tpl">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <TemplateFormModal
      v-if="showForm"
      :template="editTarget"
      @close="showForm = false"
      @saved="loadTemplates"
    />

    <!-- Create jobs from template modal -->
    <div v-if="showCreateJobs" class="modal-backdrop">
      <div class="modal" style="width:600px;max-height:90vh;overflow-y:auto">
        <h3 class="modal-title">{{ t('templates.createJobsTitle') }} — {{ createJobsTpl?.name }}</h3>
        <div class="modal-body">
          <div v-if="createJobsError" class="error-msg">{{ createJobsError }}</div>

          <!-- Schedule window -->
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('templates.createJobsWindowStart') }}</label>
              <input v-model.number="createJobsWindowStart" class="form-input" type="number" min="0" max="2359" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('templates.createJobsWindowEnd') }}</label>
              <input v-model.number="createJobsWindowEnd" class="form-input" type="number" min="0" max="2359" />
            </div>
          </div>

          <!-- Account list -->
          <div class="form-group">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <label class="form-label" style="margin-bottom:0">{{ t('templates.createJobsAvailableAccounts') }}</label>
              <div style="display:flex;gap:6px">
                <button type="button" class="btn btn-ghost btn-sm" @click="createJobsSelectAll">{{ t('templates.createJobsSelectAll') }}</button>
                <button type="button" class="btn btn-ghost btn-sm" @click="createJobsDeselectAll">{{ t('templates.createJobsDeselectAll') }}</button>
              </div>
            </div>
            <div v-if="createJobsLoading" style="text-align:center;padding:16px;color:#888">
              <i class="fa-solid fa-spinner fa-spin"></i>
            </div>
            <div v-else-if="createJobsRows.length === 0" style="padding:12px;color:#888;font-size:13px">
              {{ t('templates.createJobsNoAccounts') }}
            </div>
            <div v-else class="create-jobs-list">
              <div v-for="row in createJobsRows" :key="row.account.id" class="create-job-row">
                <div class="create-job-header">
                  <input
                    type="checkbox"
                    :checked="row.selected"
                    :disabled="row.account.authStatus !== 'authenticated'"
                    @change="row.selected = ($event.target as HTMLInputElement).checked"
                  />
                  <span class="create-job-account-name">{{ formatAccountLabel(row.account) }}</span>
                  <span style="font-size:11px;color:#aaa">{{ row.account.phoneNumber }}</span>
                  <span v-if="row.account.authStatus !== 'authenticated'" class="badge badge-grey" style="font-size:10px">
                    {{ t('templates.createJobsNotAuth') }}
                  </span>
                </div>
                <template v-if="row.selected">
                  <div class="form-group" style="margin:6px 0 6px 26px">
                    <label class="form-label" style="font-size:11px">{{ t('templates.createJobsJobName') }}</label>
                    <input v-model.trim="row.name" class="form-input" style="font-size:12px" />
                  </div>
                  <template v-if="createJobsTpl?.jobType === 'embywatch'">
                    <div class="form-row" style="margin-left:26px;margin-bottom:0">
                      <div class="form-group" style="margin-bottom:0">
                        <label class="form-label" style="font-size:11px">{{ t('templates.createJobsEmbyUser') }} <span style="color:#e63946">*</span></label>
                        <input v-model.trim="row.embyUsername" class="form-input" style="font-size:12px" autocomplete="off" />
                      </div>
                      <div class="form-group" style="margin-bottom:0">
                        <label class="form-label" style="font-size:11px">{{ t('templates.createJobsEmbyPass') }} <span style="color:#e63946">*</span></label>
                        <input v-model="row.embyPassword" class="form-input" type="password" style="font-size:12px" autocomplete="new-password" />
                      </div>
                    </div>
                  </template>
                </template>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showCreateJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="createJobsCreating || createJobsSelectedCount === 0"
            @click="doCreateJobs"
          >
            <i class="fa-solid fa-plus"></i>
            {{ createJobsCreating ? t('templates.createJobsCreating') : t('templates.createJobsConfirm').replace('{n}', String(createJobsSelectedCount)) }}
          </button>
        </div>
      </div>
    </div>

    <!-- Import modal -->
    <div v-if="showImport" class="modal-backdrop">
      <div class="modal" style="width:480px">
        <h3 class="modal-title">{{ t('templates.importTitle') }}</h3>
        <div class="modal-body">
          <div v-if="importError" class="error-msg">{{ importError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t('templates.importLabel') }}</label>
            <textarea
              v-model="importJson"
              class="form-input"
              rows="10"
              style="font-family:monospace;font-size:12px;resize:vertical"
              :placeholder="t('templates.importPlaceholder')"
            />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showImport = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="importing" @click="doImport">
            <i class="fa-solid fa-file-import"></i> {{ importing ? t('common.saving') : t('templates.importConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Single delete confirmation -->
    <div v-if="confirmDeleteTplId !== null" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.delete') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmDelete') }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDeleteTplId = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeDeleteTpl"><i class="fa-solid fa-trash"></i> {{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk disable confirmation -->
    <div v-if="confirmBulkDisableTpls" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmBulkDisable').replace('{n}', String(selectedIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDisableTpls = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDisableTpls"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk delete confirmation -->
    <div v-if="confirmBulkDeleteTpls" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.delete') }}</h3>
        <div class="modal-body">
          <p>{{ t('templates.confirmBulkDelete').replace('{n}', String(selectedIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDeleteTpls = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDeleteTpls"><i class="fa-solid fa-trash"></i> {{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuTpl" class="action-sheet-backdrop" @click="actionMenuTpl = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuTpl.name }}</div>
        <button class="action-sheet-btn" @click="openCreateJobs(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-list-check"></i> {{ t('templates.createJobsBtn') }}
        </button>
        <button v-if="(actionMenuTpl.linkedJobCount ?? 0) > 0" class="action-sheet-btn" @click="setLinkedJobsEnabled(actionMenuTpl!, true); actionMenuTpl = null">
          <i class="fa-solid fa-circle-check"></i> {{ t('templates.enableLinkedJobs') }}
        </button>
        <button v-if="(actionMenuTpl.linkedJobCount ?? 0) > 0" class="action-sheet-btn" @click="setLinkedJobsEnabled(actionMenuTpl!, false); actionMenuTpl = null">
          <i class="fa-solid fa-circle-xmark"></i> {{ t('templates.disableLinkedJobs') }}
        </button>
        <button class="action-sheet-btn" @click="shareTemplate(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-share-nodes"></i> {{ t('templates.shareBtn') }}
        </button>
        <button class="action-sheet-btn" @click="duplicateTemplate(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-clone"></i> {{ t('templates.duplicateBtn') }}
        </button>
        <button class="action-sheet-btn" @click="openEdit(actionMenuTpl!); actionMenuTpl = null">
          <i class="fa-solid fa-pen"></i> {{ t('common.edit') }}
        </button>
        <button class="action-sheet-btn danger" @click="openDeleteTpl(actionMenuTpl!.id); actionMenuTpl = null">
          <i class="fa-solid fa-trash"></i> {{ t('common.delete') }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuTpl = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
    <!-- Mute toast -->
    <div v-if="muteToast" class="tpl-toast">{{ muteToast }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { templatesApi, settingsApi, accountsApi, tgClientApi, jobsApi, type JobTemplate, type Settings, type Proxy, type AvailableAccount } from '../api/client';
import { t, locale } from '../i18n';
import { copyText } from '../utils/clipboard';
import { usePersistedRef } from '../composables/usePersistedRef';
import { debounce } from '../composables/useDebounce';
import { formatAccountLabel, loadAccountDisplaySetting } from '../composables/accountDisplay';
import PaginationBar from '../components/PaginationBar.vue';
import TemplateFormModal from '../components/TemplateFormModal.vue';

const templates = ref<JobTemplate[]>([]);
const settings = ref<Settings | null>(null);
const proxiesList = computed<Proxy[]>(() => {
  try { return JSON.parse(settings.value?.proxies ?? '[]'); } catch { return []; }
});

const showForm = ref(false);
const editTarget = ref<JobTemplate | null>(null);
const actionMenuTpl = ref<JobTemplate | null>(null);

const showImport = ref(false);
const importJson = ref('');
const importError = ref('');
const importNotice = ref('');
const importing = ref(false);
const copiedTplId = ref<number | null>(null);

// ── Create jobs from template state ──────────────────────────────────────────
const showCreateJobs = ref(false);
const createJobsTpl = ref<JobTemplate | null>(null);
const createJobsAccounts = ref<AvailableAccount[]>([]);
const createJobsLoading = ref(false);
const createJobsError = ref('');
const createJobsCreating = ref(false);
const createJobsWindowStart = ref(1400);
const createJobsWindowEnd = ref(1600);

type CreateJobRow = {
  account: AvailableAccount;
  selected: boolean;
  name: string;
  embyUsername: string;
  embyPassword: string;
};
const createJobsRows = ref<CreateJobRow[]>([]);

const selectedIds = ref<number[]>([]);
const sharedMulti = ref(false);
const allSelected = computed(() => templates.value.length > 0 && templates.value.every(t => selectedIds.value.includes(t.id)));

const sortKey = usePersistedRef<string>('bemby:templates:sortKey', 'name');
const sortDir = usePersistedRef<'asc' | 'desc'>('bemby:templates:sortDir', 'asc');
const page = ref(1);
const total = ref(0);
const pageSize = usePersistedRef<number>('bemby:templates:pageSize', 25);
const searchText = usePersistedRef<string>('bemby:templates:search', '');

function setSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
  page.value = 1;
  void loadTemplates();
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

// SQLite stamps created_at in UTC with no zone marker, which a browser would otherwise read
// as local time and land a day out either side of midnight
function fmtDate(stamp: string | null | undefined): string {
  if (!stamp) return '—';
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  const localeMap: Record<string, string> = { en: 'en-AU', zh: 'zh-CN' };
  return parsed.toLocaleDateString(localeMap[locale.value] ?? 'en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const searchReload = debounce(() => {
  page.value = 1;
  void loadTemplates();
}, 300);
watch(searchText, () => searchReload());

function onPageChange(p: number) {
  page.value = p;
  void loadTemplates();
}
function onPageSizeChange(size: number) {
  // PaginationBar also emits update:page 1, which triggers the reload
  pageSize.value = size;
}
const confirmDeleteTplId = ref<number | null>(null);
const confirmBulkDisableTpls = ref(false);
const confirmBulkDeleteTpls = ref(false);

function toggleAll() {
  selectedIds.value = allSelected.value ? [] : templates.value.map(t => t.id);
}
// Index of the last row toggled without Shift; anchors Shift-click ranges.
let lastSelectedIdx: number | null = null;

function toggleSelect(id: number, idx: number, event?: MouseEvent) {
  // Shift-click selects the contiguous range between the anchor row and this
  // one; other clicks toggle a single row and reset the anchor.
  if (event?.shiftKey && lastSelectedIdx !== null) {
    // Shift-click would otherwise highlight the intervening table text.
    window.getSelection?.()?.removeAllRanges();
    const next = new Set(selectedIds.value);
    const [lo, hi] = [lastSelectedIdx, idx].sort((a, b) => a - b);
    for (let i = lo; i <= hi; i++) {
      const row = templates.value[i];
      if (row) next.add(row.id);
    }
    selectedIds.value = [...next];
    return;
  }
  const arrIdx = selectedIds.value.indexOf(id);
  if (arrIdx === -1) selectedIds.value.push(id);
  else selectedIds.value.splice(arrIdx, 1);
  lastSelectedIdx = idx;
}

// The anchor indexes the current list, so clear it whenever the list is
// replaced (search, filter, reload) to avoid spanning stale rows.
watch(templates, () => {
  lastSelectedIdx = null;
});

onMounted(async () => {
  loadAccountDisplaySetting();
  await Promise.all([loadTemplates(), loadSettings()]);
});

async function loadTemplates(): Promise<void> {
  const search = searchText.value.trim();
  // While searching on the default sort, let the server rank by fuzzy relevance
  const defaultSort = sortKey.value === 'name' && sortDir.value === 'asc';
  const res = await templatesApi.listPaged({
    page: page.value,
    pageSize: pageSize.value,
    search: search || undefined,
    sortKey: search && defaultSort ? undefined : sortKey.value || undefined,
    sortDir: search && defaultSort ? undefined : sortDir.value,
  });
  // Step back a page when the current one empties out (e.g. after bulk delete)
  if (!res.items.length && page.value > 1) {
    page.value -= 1;
    return loadTemplates();
  }
  templates.value = res.items;
  total.value = res.total;
  // Prune selections that are no longer on the visible page
  const visible = new Set(res.items.map(t => t.id));
  selectedIds.value = selectedIds.value.filter(id => visible.has(id));
}

async function loadSettings() {
  try { settings.value = await settingsApi.get(); } catch { /* ignore */ }
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

function openAdd() {
  editTarget.value = null;
  showForm.value = true;
}

function openEdit(tpl: JobTemplate) {
  editTarget.value = tpl;
  showForm.value = true;
}

async function setLinkedJobsEnabled(tpl: JobTemplate, enabled: boolean) {
  await templatesApi.setLinkedJobsEnabled(tpl.id, enabled);
}

async function openCreateJobs(tpl: JobTemplate) {
  createJobsTpl.value = tpl;
  createJobsError.value = '';
  createJobsLoading.value = true;
  createJobsRows.value = [];
  showCreateJobs.value = true;
  try {
    createJobsAccounts.value = await templatesApi.availableAccounts(tpl.id);
    createJobsRows.value = createJobsAccounts.value.map(a => ({
      account: a,
      selected: a.authStatus === 'authenticated',
      name: `${tpl.name} - ${a.name}`,
      embyUsername: '',
      embyPassword: '',
    }));
  } catch (err: any) {
    createJobsError.value = err.response?.data?.error ?? 'Failed to load accounts';
  } finally {
    createJobsLoading.value = false;
  }
}

const createJobsSelectedCount = computed(() => createJobsRows.value.filter(r => r.selected).length);

function createJobsSelectAll() {
  createJobsRows.value.forEach(r => { if (r.account.authStatus === 'authenticated') r.selected = true; });
}

function createJobsDeselectAll() {
  createJobsRows.value.forEach(r => { r.selected = false; });
}

async function doCreateJobs() {
  if (!createJobsTpl.value) return;
  const selected = createJobsRows.value.filter(r => r.selected);
  if (!selected.length) return;

  // Validate embywatch credentials
  if (createJobsTpl.value.jobType === 'embywatch') {
    for (const r of selected) {
      if (!r.embyUsername.trim() || !r.embyPassword.trim()) {
        createJobsError.value = `${r.account.name}: Emby username and password are required`;
        return;
      }
    }
  }

  createJobsError.value = '';
  createJobsCreating.value = true;
  try {
    // Verify server reachability and each account's credentials before creating
    if (createJobsTpl.value.jobType === 'embywatch') {
      let tplCfg: { proxyId?: string; userAgent?: string; ignoreSslErrors?: boolean } = {};
      try {
        if (createJobsTpl.value.config) tplCfg = JSON.parse(createJobsTpl.value.config);
      } catch { /* ignore bad template config */ }
      for (const r of selected) {
        const test = await jobsApi.testEmby({
          serverUrl: createJobsTpl.value.botUsername,
          username: r.embyUsername.trim(),
          password: r.embyPassword.trim(),
          ...(tplCfg.userAgent ? { userAgent: tplCfg.userAgent } : {}),
          ...(tplCfg.proxyId ? { proxyId: tplCfg.proxyId } : {}),
          ...(tplCfg.ignoreSslErrors ? { ignoreSslErrors: true } : {}),
        });
        if (!test.ok) {
          createJobsError.value = `${r.account.name}: ${t('jobs.errors.embyVerifyFailed')}${test.error ? `: ${test.error}` : ''}`;
          return;
        }
      }
    }
    const jobs = selected.map(r => ({
      accountId: r.account.id,
      name: r.name.trim() || `${createJobsTpl.value!.name} - ${r.account.name}`,
      ...(createJobsTpl.value!.jobType === 'embywatch'
        ? { config: { username: r.embyUsername.trim(), password: r.embyPassword.trim() } }
        : {}),
    }));
    const result = await templatesApi.createJobs(createJobsTpl.value.id, {
      jobs,
      scheduleWindowStart: Number(createJobsWindowStart.value),
      scheduleWindowEnd: Number(createJobsWindowEnd.value),
    });
    showCreateJobs.value = false;
    alert(t('templates.createJobsSuccess').replace('{n}', String(result.created)));
    await loadTemplates();
  } catch (err: any) {
    createJobsError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    createJobsCreating.value = false;
  }
}

function openDeleteTpl(id: number) {
  confirmDeleteTplId.value = id;
}

async function executeDeleteTpl() {
  const id = confirmDeleteTplId.value;
  if (!id) return;
  await templatesApi.delete(id);
  confirmDeleteTplId.value = null;
  selectedIds.value = selectedIds.value.filter(i => i !== id);
  await loadTemplates();
}

async function duplicateTemplate(tpl: JobTemplate) {
  if (duplicatingId.value) return;
  duplicatingId.value = tpl.id;
  try {
    const copy = await templatesApi.duplicate(tpl.id);
    await loadTemplates();
    showToast(t('templates.duplicated').replace('{name}', copy.name));
  } catch (err: any) {
    showToast(err.response?.data?.error ?? t('common.saveFailed'));
  } finally {
    duplicatingId.value = null;
  }
}

async function toggleTemplateEnabled(tpl: JobTemplate) {
  await templatesApi.update(tpl.id, { enabled: !tpl.enabled });
  await loadTemplates();
}

async function bulkEnableTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.update(id, { enabled: true })));
  await loadTemplates();
  selectedIds.value = [];
}

async function executeBulkDisableTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.update(id, { enabled: false })));
  await loadTemplates();
  confirmBulkDisableTpls.value = false;
  selectedIds.value = [];
}

async function executeBulkDeleteTpls() {
  await Promise.all(selectedIds.value.map(id => templatesApi.delete(id)));
  await loadTemplates();
  confirmBulkDeleteTpls.value = false;
  selectedIds.value = [];
}

const muteToast = ref('');
const isMutingBot = ref(false);
const duplicatingId = ref<number | null>(null);
let muteToastTimer: ReturnType<typeof setTimeout> | null = null;

/** Brief message in the corner, shared by anything that finishes without a dialog. */
function showToast(message: string) {
  muteToast.value = message;
  if (muteToastTimer) clearTimeout(muteToastTimer);
  muteToastTimer = setTimeout(() => { muteToast.value = ''; }, 3000);
}

// ~15 calls/min -- safe for Telegram's account.UpdateNotifySettings
const MUTE_RATE_MS = 4000;

async function bulkMuteBotForever() {
  if (isMutingBot.value) return;

  const botUsernames = [...new Set(
    templates.value
      .filter(t => selectedIds.value.includes(t.id) && t.botUsername)
      .map(t => t.botUsername)
  )];
  if (!botUsernames.length) return;

  const accounts = (await accountsApi.list()).filter(a => !a.disabled);
  const MUTE_FOREVER = 365 * 24 * 3600;
  const pairs = accounts.flatMap(acc => botUsernames.map(bot => ({ acc, bot })));

  isMutingBot.value = true;
  if (muteToastTimer) clearTimeout(muteToastTimer);

  for (let i = 0; i < pairs.length; i++) {
    const { acc, bot } = pairs[i];
    muteToast.value = t('templates.bulkMutingProgress')
      .replace('{done}', String(i + 1))
      .replace('{total}', String(pairs.length));
    try {
      await tgClientApi.mute(acc.id, bot, MUTE_FOREVER);
    } catch { /* continue on individual failure */ }
    if (i < pairs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, MUTE_RATE_MS));
    }
  }

  isMutingBot.value = false;
  showToast(t('templates.bulkMuteBotForeverDone'));
}

const SHARE_KEYS: (keyof JobTemplate)[] = ['name', 'jobType', 'botUsername', 'timezone', 'replyTimeoutMs', 'retryMax', 'config'];

// The start command and the button are stored on every template, defaulted, but only these
// job types read them -- a custom or embywatch template shared with them in tow reads as if
// it sends "/start" and looks for "签到", which it never does.
const SHARE_KEYS_BY_TYPE: Partial<Record<JobTemplate['jobType'], (keyof JobTemplate)[]>> = {
  checkin: ['startCommand', 'checkinButton'],
  autoreg: ['startCommand'],
};

function shareShape(tpl: JobTemplate): Record<string, unknown> {
  const keys = [...SHARE_KEYS, ...(SHARE_KEYS_BY_TYPE[tpl.jobType] ?? [])];
  return Object.fromEntries(keys.map(k => [k, tpl[k]]));
}

async function shareSelected() {
  const selected = templates.value.filter(t => selectedIds.value.includes(t.id));
  const text = JSON.stringify(selected.map(shareShape), null, 2);
  // The tick says the text is on the clipboard, so it waits on that actually happening
  if (!(await copyText(text))) { showToast(t('common.copyFailed')); return; }
  sharedMulti.value = true;
  setTimeout(() => { sharedMulti.value = false; }, 1500);
}

async function shareTemplate(tpl: JobTemplate) {
  const text = JSON.stringify(shareShape(tpl), null, 2);
  if (!(await copyText(text))) { showToast(t('common.copyFailed')); return; }
  copiedTplId.value = tpl.id;
  setTimeout(() => { copiedTplId.value = null; }, 1500);
}

function openImport() {
  importJson.value = '';
  importError.value = '';
  importNotice.value = '';
  showImport.value = true;
}

// A shared template carries `proxyId`, which only means something next to the proxy list
// it came from. Keeping one this instance does not have would silently run the job with no
// proxy at all, so it is dropped and reported.
function normaliseImportItem(item: Record<string, unknown>): { item: Record<string, unknown>; droppedProxy: boolean } {
  if (typeof item.config === 'string') {
    try { item.config = JSON.parse(item.config); } catch { /* leave as-is */ }
  }
  let droppedProxy = false;
  const cfg = item.config as Record<string, unknown> | null | undefined;
  const proxyId = cfg && typeof cfg === 'object' ? cfg.proxyId : undefined;
  if (typeof proxyId === 'string' && proxyId && !proxiesList.value.some((p) => p.id === proxyId)) {
    delete (cfg as Record<string, unknown>).proxyId;
    droppedProxy = true;
  }
  return { item, droppedProxy };
}

async function doImport() {
  importError.value = '';
  let raw: unknown;
  try {
    raw = JSON.parse(importJson.value);
  } catch {
    importError.value = t('templates.importError');
    return;
  }

  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw as Record<string, unknown>];
  if (!items.length || !('name' in items[0]) || !('jobType' in items[0])) {
    importError.value = t('templates.importError');
    return;
  }

  importing.value = true;
  try {
    let droppedProxies = 0;
    for (const item of items) {
      const { item: normalised, droppedProxy } = normaliseImportItem(item);
      if (droppedProxy) droppedProxies++;
      await templatesApi.create(normalised as Partial<JobTemplate>);
    }
    showImport.value = false;
    if (droppedProxies) {
      importNotice.value = t('templates.importProxyDropped').replace('{n}', String(droppedProxies));
    }
    await loadTemplates();
  } catch (err: any) {
    importError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sort:hover {
  background: #f0f4ff;
}

.th-sort.sort-active {
  color: #3730a3;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.sort-icon {
  font-size: 10px;
  color: #ccc;
  margin-left: 2px;
}

.th-sort.sort-active .sort-icon {
  color: #6366f1;
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

.action-sheet-cancel {
  color: #888;
  font-weight: 500;
}

.create-jobs-list {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

.create-job-row {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.create-job-row:last-child {
  border-bottom: none;
}

.create-job-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.create-job-account-name {
  font-weight: 500;
  font-size: 13px;
  flex: 1;
}

.tpl-toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.88);
  color: #fff;
  font-size: 13px;
  padding: 8px 20px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
  animation: tpl-fade-in 0.15s ease;
}

@keyframes tpl-fade-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
