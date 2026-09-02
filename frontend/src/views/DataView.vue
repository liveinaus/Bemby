<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("data.title") }}</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button v-if="folders.length" class="btn btn-secondary" @click="exportStore()">
          <i class="fa-solid fa-download"></i> {{ t("data.exportAll") }}
        </button>
        <button class="btn btn-primary" @click="openFolderForm(null)">
          <i class="fa-solid fa-folder-plus"></i> {{ t("data.addFolder") }}
        </button>
      </div>
    </div>

    <div v-if="!dataStoreEnabled" class="card" style="padding: 16px; color: var(--text-muted)">
      {{ t("data.disabled") }}
    </div>

    <template v-else>
      <div v-if="error" class="error-msg" style="margin-bottom: 12px">{{ error }}</div>

      <p style="color: var(--text-muted); font-size: 13px; margin: 0 0 12px">{{ t("data.intro") }}</p>

      <div class="data-layout">
        <!-- Folders -->
        <div class="card data-folders">
          <div class="data-panel-title">{{ t("data.foldersTitle") }}</div>
          <div v-if="!folders.length" class="empty" style="padding: 12px">
            {{ t("data.noFolders") }}
          </div>
          <div
            v-for="f in folders"
            :key="f.id"
            class="data-folder-row"
            :class="{ 'is-active': f.id === selectedFolderId }"
            @click="selectFolder(f.id)"
          >
            <i class="fa-solid fa-folder" style="color: var(--warning)"></i>
            <span class="data-folder-name">{{ f.name }}</span>
            <span class="badge badge-grey">{{ f.recordCount }}</span>
            <span class="data-folder-actions" @click.stop>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="openFolderForm(f)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-danger btn-icon"
                :title="t('common.delete')"
                @click="askDeleteFolder(f)"
              >
                <i class="fa-solid fa-trash"></i>
              </button>
            </span>
          </div>
        </div>

        <!-- Records of the chosen folder -->
        <div class="card data-records">
          <div v-if="!selectedFolder" class="empty" style="padding: 16px">
            {{ t("data.selectFolder") }}
          </div>
          <template v-else>
            <div class="data-records-header">
              <div class="data-panel-title" style="margin: 0">
                {{ selectedFolder.name }} — {{ t("data.recordsTitle") }}
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap">
                <button class="btn btn-secondary btn-sm" @click="exportStore(selectedFolder.id)">
                  <i class="fa-solid fa-download"></i> {{ t("data.exportFolder") }}
                </button>
                <button class="btn btn-secondary btn-sm" @click="openTextExport()">
                  <i class="fa-solid fa-file-lines"></i> {{ t("data.exportText") }}
                </button>
                <button class="btn btn-primary btn-sm" @click="openRecordForm(null)">
                  <i class="fa-solid fa-plus"></i> {{ t("data.addRecord") }}
                </button>
              </div>
            </div>

            <!-- Filtering the folder in hand. The fields on offer are read off the folder's
                 own records, since two folders rarely hold the same shape of value -->
            <div v-if="records.length" class="data-filter-bar">
              <input
                v-model="filterSearch"
                class="form-input data-filter-search"
                :placeholder="t('data.filterSearch')"
              />
              <button class="btn btn-secondary btn-sm" @click="addFilter">
                <i class="fa-solid fa-filter"></i> {{ t("data.addFilter") }}
              </button>
              <button v-if="filtering" class="btn btn-ghost btn-sm" @click="clearFilters">
                <i class="fa-solid fa-xmark"></i> {{ t("data.clearFilters") }}
              </button>
              <span v-if="filtering" class="data-filter-count">
                {{
                  t("data.filterCount")
                    .replace("{n}", String(sortedRecords.length))
                    .replace("{total}", String(records.length))
                }}
              </span>
            </div>

            <div v-for="(f, i) in filters" :key="i" class="data-filter-row">
              <select v-model="f.field" class="form-select">
                <option :value="RECORD_KEY_FIELD">{{ t("data.filterFieldKey") }}</option>
                <option v-for="path in fieldOptions" :key="path" :value="path">
                  {{ path }}
                </option>
              </select>
              <select v-model="f.op" class="form-select">
                <option value="set">{{ t("data.filterOpSet") }}</option>
                <option value="empty">{{ t("data.filterOpEmpty") }}</option>
                <option value="contains">{{ t("data.filterOpContains") }}</option>
                <option value="notContains">{{ t("data.filterOpNotContains") }}</option>
                <option value="equals">{{ t("data.filterOpEquals") }}</option>
              </select>
              <input
                v-if="opNeedsText(f.op)"
                v-model="f.text"
                class="form-input"
                :placeholder="t('data.filterValue')"
              />
              <span v-else></span>
              <button
                class="btn btn-ghost btn-icon btn-sm"
                :title="t('common.delete')"
                @click="filters.splice(i, 1)"
              >
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th
                      class="th-sort"
                      style="width: 22%"
                      :class="sortKey === 'key' ? 'sort-active' : ''"
                      @click="setSort('key')"
                    >
                      {{ t("data.colKey") }} <span class="sort-icon">{{ sortIcon("key") }}</span>
                    </th>
                    <!-- Hidden on a phone: a wrapped value makes the row taller than the screen -->
                    <th
                      class="th-sort col-hide-mobile"
                      :class="sortKey === 'value' ? 'sort-active' : ''"
                      @click="setSort('value')"
                    >
                      {{ t("data.colValue") }} <span class="sort-icon">{{ sortIcon("value") }}</span>
                    </th>
                    <th
                      class="th-sort col-hide-mobile"
                      style="width: 18%"
                      :class="sortKey === 'updated' ? 'sort-active' : ''"
                      @click="setSort('updated')"
                    >
                      {{ t("data.colUpdated") }}
                      <span class="sort-icon">{{ sortIcon("updated") }}</span>
                    </th>
                    <th style="width: 15%">{{ t("common.actions") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!sortedRecords.length">
                    <td colspan="4" class="empty">
                      {{ filtering ? t("data.noMatches") : t("data.noRecords") }}
                    </td>
                  </tr>
                  <tr v-for="r in sortedRecords" :key="r.id">
                    <td style="font-family: monospace">{{ r.key }}</td>
                    <td class="data-value-cell col-hide-mobile">{{ previewValue(r.value) }}</td>
                    <td class="col-hide-mobile">{{ fmtDate(r.updatedAt) }}</td>
                    <td>
                      <div class="actions">
                        <button
                          class="btn btn-sm btn-ghost btn-icon"
                          :title="copiedId === r.id ? t('data.copied') : t('data.copyRef')"
                          @click="copyRef(r)"
                        >
                          <i
                            :class="copiedId === r.id ? 'fa-solid fa-check' : 'fa-solid fa-code'"
                          ></i>
                        </button>
                        <button
                          class="btn btn-sm btn-ghost btn-icon"
                          :title="t('common.edit')"
                          @click="openRecordForm(r)"
                        >
                          <i class="fa-solid fa-pen"></i>
                        </button>
                        <button
                          class="btn btn-sm btn-danger btn-icon"
                          :title="t('common.delete')"
                          @click="askDeleteRecord(r)"
                        >
                          <i class="fa-solid fa-trash"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>

      <!-- How a job reaches all this; the reference syntax is the part worth spelling out -->
      <div class="card" style="margin-top: 12px; padding: 12px">
        <div class="data-panel-title">{{ t("data.usageTitle") }}</div>
        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.7">
          <div>{{ t("data.usageRead") }}</div>
          <div>{{ t("data.usageWrite") }}</div>
        </div>
      </div>
    </template>

    <!-- Add / rename a folder -->
    <div v-if="showFolderForm" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">
          {{ folderTarget ? t("common.edit") : t("data.addFolder") }}
        </h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("data.folderName") }}</label>
            <input
              v-model.trim="folderName"
              class="form-input"
              placeholder="example"
              @keyup.enter="saveFolder"
            />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("data.nameHint") }}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showFolderForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveFolder">
            <i class="fa-solid fa-check"></i>
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Add / edit a record -->
    <div v-if="showRecordForm" class="modal-backdrop">
      <div class="modal" style="width: 560px">
        <h3 class="modal-title">
          {{ recordTarget ? t("data.editRecord") : t("data.addRecordTitle") }}
        </h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("data.labelKey") }}</label>
            <input v-model.trim="recordKey" class="form-input" placeholder="email" />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
              {{ t("data.nameHint") }}
            </div>
          </div>
          <div class="form-group">
            <div class="data-value-head">
              <label class="form-label" style="margin: 0">{{ t("data.labelValue") }}</label>
              <div class="data-mode-switch">
                <button
                  type="button"
                  :class="['data-mode-btn', { 'is-on': valueMode === 'fields' }]"
                  @click="switchValueMode('fields')"
                >
                  <i class="fa-solid fa-list-ul"></i> {{ t("data.modeFields") }}
                </button>
                <button
                  type="button"
                  :class="['data-mode-btn', { 'is-on': valueMode === 'raw' }]"
                  @click="switchValueMode('raw')"
                >
                  <i class="fa-solid fa-code"></i> {{ t("data.modeRaw") }}
                </button>
              </div>
            </div>

            <template v-if="valueMode === 'fields'">
              <div v-for="(field, i) in valueFields" :key="i" class="data-field-row">
                <input
                  v-model="field.key"
                  class="form-input"
                  :placeholder="t('data.fieldKey')"
                />
                <input
                  v-model="field.text"
                  class="form-input"
                  :class="{ 'data-field-json': field.json }"
                  :placeholder="field.json ? t('data.fieldJsonValue') : t('data.fieldValue')"
                />
                <button
                  type="button"
                  :class="['btn', 'btn-icon', field.json ? 'btn-primary' : 'btn-ghost']"
                  :title="t('data.fieldAsJson')"
                  @click="field.json = !field.json"
                >
                  <span style="font-family: monospace; font-weight: 600">{}</span>
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-icon"
                  :title="t('common.delete')"
                  @click="valueFields.splice(i, 1)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
              <div
                v-if="!valueFields.length"
                style="font-size: 12px; color: var(--text-faint); padding: 4px 0"
              >
                {{ t("data.noFields") }}
              </div>
              <button class="btn btn-ghost btn-sm" @click="addValueField">
                <i class="fa-solid fa-plus"></i> {{ t("data.addField") }}
              </button>
              <div style="font-size: 11px; color: var(--text-faint); margin-top: 6px">
                {{ t("data.fieldsHint") }}
              </div>
            </template>

            <template v-else>
              <textarea
                v-model="recordValue"
                class="form-input"
                rows="8"
                style="font-family: monospace; font-size: 12px; resize: vertical"
                :placeholder="t('data.valuePlaceholder')"
              />
              <div style="font-size: 11px; color: var(--text-faint); margin-top: 3px">
                {{ t("data.valueHint") }}
              </div>
            </template>
          </div>
          <div v-if="recordKey && selectedFolder" style="font-size: 11px; color: var(--text-faint)">
            {{ t("data.refHint") }}
            <code>{{ dataRefText(selectedFolder.name, recordKey) }}</code>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showRecordForm = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveRecord">
            <i class="fa-solid fa-check"></i>
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- A folder as a text file, to a format the person writes. The preview is what settles a
         mistyped field name, which would otherwise come out as a column of blanks -->
    <div v-if="textExportOpen" class="modal-backdrop">
      <div class="modal" style="width: 620px">
        <h3 class="modal-title">
          {{ t("data.exportTextTitle").replace("{name}", textExportFolder?.name ?? "") }}
        </h3>
        <div class="modal-body">
          <div v-if="textExportError" class="error-msg" style="margin-bottom: 10px">
            {{ textExportError }}
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("data.exportTextFormat") }}</label>
            <input
              v-model="textExportFormat"
              class="form-input"
              style="font-family: monospace"
              :placeholder="DEFAULT_EXPORT_FORMAT"
              @input="queueTextPreview"
            />
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.6">
              {{ t("data.exportTextHint") }}
            </div>
          </div>
          <div class="form-group" style="margin-bottom: 0">
            <label class="form-label">
              {{ t("data.exportTextPreview") }}
              <span v-if="textExportCount" style="color: var(--text-muted); font-weight: 400">
                ({{ t("data.exportTextLines").replace("{n}", String(textExportCount)) }})
              </span>
            </label>
            <pre class="data-text-preview">{{ textExportPreview || t("data.exportTextEmpty") }}</pre>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="textExportOpen = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="downloadTextExport">
            <i class="fa-solid fa-download"></i> {{ t("data.exportTextDownload") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete confirmations -->
    <div v-if="deleteFolderTarget" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("common.delete") }}</h3>
        <div class="modal-body">
          {{
            t("data.confirmDeleteFolder")
              .replace("{name}", deleteFolderTarget.name)
              .replace("{n}", String(deleteFolderTarget.recordCount))
          }}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="deleteFolderTarget = null">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" :disabled="saving" @click="doDeleteFolder">
            <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="deleteRecordTarget" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("common.delete") }}</h3>
        <div class="modal-body">
          {{ t("data.confirmDeleteRecord").replace("{name}", deleteRecordTarget.key) }}
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="deleteRecordTarget = null">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" :disabled="saving" @click="doDeleteRecord">
            <i class="fa-solid fa-trash"></i> {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "../i18n";
import { dataStoreApi, type DataFolder, type DataRecord } from "../api/client";
import {
  dataRefText,
  dataStoreEnabled,
  loadDataStoreSetting,
  setDataFolderNames,
} from "../composables/dataStore";
import { copyText } from "../utils/clipboard";
import { usePersistedRef } from "../composables/usePersistedRef";

// Folders and the records of the one in hand. A value is edited as the text of it: whether
// `{"a":1}` is an object or a string is settled by the backend, so the panel does not have to
// hold a second opinion about it.

const folders = ref<DataFolder[]>([]);
const records = ref<DataRecord[]>([]);
const selectedFolderId = ref<number | null>(null);
const error = ref("");
const saving = ref(false);
const copiedId = ref<number | null>(null);

const showFolderForm = ref(false);
const folderTarget = ref<DataFolder | null>(null);
const folderName = ref("");
const formError = ref("");

const showRecordForm = ref(false);
const recordTarget = ref<DataRecord | null>(null);
const recordKey = ref("");
const recordValue = ref("");

// A value is edited either as a row per field of the object -- what nearly every record is --
// or as the raw text, which is the only way to reach a nested structure or a bare string.
type ValueField = { key: string; text: string; json: boolean };
const valueMode = ref<"fields" | "raw">("fields");
const valueFields = ref<ValueField[]>([]);

const deleteFolderTarget = ref<DataFolder | null>(null);
const deleteRecordTarget = ref<DataRecord | null>(null);

const selectedFolder = computed(
  () => folders.value.find((f) => f.id === selectedFolderId.value) ?? null,
);

// ── Filtering ─────────────────────────────────────────────────────────────────
//
// The fields a condition can name are read off the folder's own records: an outlook folder
// keeps a recovery address, a proxy folder keeps a port, and neither knows of the other's
// fields. The whole folder is already in hand, so this is all local -- no request behind it.

/** The record's own key as a filter target, spelt the way a data path spells it. */
const RECORD_KEY_FIELD = "#key";

type FilterOp = "set" | "empty" | "contains" | "notContains" | "equals";
type RecordFilter = { field: string; op: FilterOp; text: string };

const filterSearch = ref("");
const filters = ref<RecordFilter[]>([]);

/** How deep the picker looks into a value, and how many paths it will offer at most. */
const FIELD_DEPTH = 3;
const MAX_FIELD_PATHS = 200;

const filtering = computed(
  () => !!filterSearch.value.trim() || filters.value.some((f) => !!f.field),
);

/** Every field path the folder's records hold, nested ones written as `login.password`. */
const discoveredFields = computed(() => {
  const paths = new Set<string>();
  for (const record of records.value) collectFieldPaths(record.value, "", paths, 0);
  return paths;
});

/**
 * What the field picker offers: what the records hold, plus whatever a condition already
 * names -- editing the last record that had a field should not blank out the select.
 */
const fieldOptions = computed(() => {
  const paths = new Set(discoveredFields.value);
  for (const f of filters.value) {
    if (f.field && f.field !== RECORD_KEY_FIELD) paths.add(f.field);
  }
  return [...paths].sort((a, b) => collator.compare(a, b));
});

function collectFieldPaths(
  value: unknown,
  prefix: string,
  paths: Set<string>,
  depth: number,
): void {
  if (!isPlainObject(value) || depth >= FIELD_DEPTH) return;
  for (const [key, inner] of Object.entries(value)) {
    if (paths.size >= MAX_FIELD_PATHS) return;
    const path = joinFieldPath(prefix, key);
    paths.add(path);
    collectFieldPaths(inner, path, paths, depth + 1);
  }
}

/** A field name holding a dot goes in brackets, the way a data reference writes one. */
function joinFieldPath(prefix: string, key: string): string {
  if (/[.[\]]/.test(key)) return `${prefix}[${key}]`;
  return prefix ? `${prefix}.${key}` : key;
}

/** Reads a path apart again: `[name]` is one segment whatever it holds. */
function splitFieldPath(path: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === "[") {
      const end = path.indexOf("]", i + 1);
      if (end === -1) break;
      parts.push(path.slice(i + 1, end));
      i = path[end + 1] === "." ? end + 2 : end + 1;
      continue;
    }
    let end = i;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    if (end > i) parts.push(path.slice(i, end));
    i = path[end] === "." ? end + 1 : end;
  }
  return parts;
}

/** What a record holds at a field path, as text. Empty when there is nothing there. */
function fieldText(record: DataRecord, path: string): string {
  if (path === RECORD_KEY_FIELD) return record.key;
  let here: unknown = record.value;
  for (const segment of splitFieldPath(path)) {
    if (!isPlainObject(here)) return "";
    here = here[segment];
  }
  if (here === null || here === undefined) return "";
  return typeof here === "string" ? here : JSON.stringify(here);
}

/** Whether the operator compares against something typed, or just asks if there is a value. */
function opNeedsText(op: FilterOp): boolean {
  return op !== "set" && op !== "empty";
}

function matchesFilter(record: DataRecord, filter: RecordFilter): boolean {
  if (!filter.field) return true;
  const value = fieldText(record, filter.field);
  const needle = filter.text.trim().toLowerCase();
  switch (filter.op) {
    case "set":
      return !!value.trim();
    case "empty":
      return !value.trim();
    case "contains":
      return !needle || value.toLowerCase().includes(needle);
    case "notContains":
      return !needle || !value.toLowerCase().includes(needle);
    case "equals":
      return !needle || value.trim().toLowerCase() === needle;
  }
}

/** The search box: one substring, against the key and the whole value alike. */
function matchesSearch(record: DataRecord, needle: string): boolean {
  if (!needle) return true;
  const value = typeof record.value === "string" ? record.value : JSON.stringify(record.value);
  return `${record.key}\n${value ?? ""}`.toLowerCase().includes(needle);
}

const filteredRecords = computed(() => {
  const needle = filterSearch.value.trim().toLowerCase();
  if (!filtering.value) return records.value;
  return records.value.filter(
    (r) => matchesSearch(r, needle) && filters.value.every((f) => matchesFilter(r, f)),
  );
});

/** A new condition starts on the first field of the folder, asking whether it has a value. */
function addFilter() {
  filters.value.push({
    field: fieldOptions.value[0] ?? RECORD_KEY_FIELD,
    op: "set",
    text: "",
  });
}

function clearFilters() {
  filterSearch.value = "";
  filters.value = [];
}

// The whole folder is in hand, so sorting is done here rather than asked of the server.
// Key ascending is where it starts, which is the order the records arrive in.
const sortKey = usePersistedRef<"key" | "value" | "updated">("bemby:data:sortKey", "key");
const sortDir = usePersistedRef<"asc" | "desc">("bemby:data:sortDir", "asc");

function setSort(key: "key" | "value" | "updated") {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = "asc";
  }
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return "↕";
  return sortDir.value === "asc" ? "↑" : "↓";
}

// Numeric collation, so key_2 comes before key_10 rather than after it
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const sortedRecords = computed(() => {
  const rows = [...filteredRecords.value];
  const dir = sortDir.value === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (sortKey.value === "updated") {
      // Stamps are same-format strings, so comparing them is comparing the times
      return dir * (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
    }
    const key = sortKey.value === "value" ? "value" : "key";
    // Values are sorted on what the row shows, not on the raw object behind it
    const left = key === "value" ? previewValue(a.value) : a.key;
    const right = key === "value" ? previewValue(b.value) : b.key;
    return dir * collator.compare(left, right);
  });
  return rows;
});

onMounted(async () => {
  await loadDataStoreSetting();
  if (dataStoreEnabled.value) await loadFolders();
});

function reportError(err: any) {
  error.value = err?.response?.data?.error ?? String(err?.message ?? err);
}

async function loadFolders(keepSelection = true) {
  try {
    folders.value = await dataStoreApi.folders();
    setDataFolderNames(folders.value.map((f) => f.name));
    const stillThere = folders.value.some((f) => f.id === selectedFolderId.value);
    if (!keepSelection || !stillThere) {
      selectedFolderId.value = folders.value[0]?.id ?? null;
    }
    await loadRecords();
  } catch (err) {
    reportError(err);
  }
}

async function loadRecords() {
  if (selectedFolderId.value == null) {
    records.value = [];
    return;
  }
  try {
    records.value = await dataStoreApi.records(selectedFolderId.value);
  } catch (err) {
    reportError(err);
  }
}

async function selectFolder(id: number) {
  // A condition names a field of the folder it was made in, so it does not follow to the next
  if (id !== selectedFolderId.value) clearFilters();
  selectedFolderId.value = id;
  await loadRecords();
}

/** One line of the value for the table: a string as it is, anything else as its JSON. */
function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function openFolderForm(folder: DataFolder | null) {
  folderTarget.value = folder;
  folderName.value = folder?.name ?? "";
  formError.value = "";
  showFolderForm.value = true;
}

async function saveFolder() {
  formError.value = "";
  saving.value = true;
  try {
    if (folderTarget.value) {
      await dataStoreApi.renameFolder(folderTarget.value.id, folderName.value);
    } else {
      const created = await dataStoreApi.createFolder(folderName.value);
      selectedFolderId.value = created.id;
    }
    showFolderForm.value = false;
    await loadFolders();
  } catch (err: any) {
    formError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  } finally {
    saving.value = false;
  }
}

function askDeleteFolder(folder: DataFolder) {
  deleteFolderTarget.value = folder;
}

async function doDeleteFolder() {
  if (!deleteFolderTarget.value) return;
  saving.value = true;
  try {
    await dataStoreApi.deleteFolder(deleteFolderTarget.value.id);
    deleteFolderTarget.value = null;
    await loadFolders(false);
  } catch (err) {
    reportError(err);
  } finally {
    saving.value = false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field stays text; anything else is edited as the JSON of it, and marked as such. */
function toValueFields(obj: Record<string, unknown>): ValueField[] {
  return Object.entries(obj).map(([key, value]) =>
    typeof value === "string"
      ? { key, text: value, json: false }
      : { key, text: JSON.stringify(value), json: true },
  );
}

/** The object the rows stand for, or the row that will not parse. Blank keys are dropped. */
function fieldsToObject():
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } {
  const out: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  for (const field of valueFields.value) {
    const key = field.key.trim();
    if (!key) continue;
    if (seen.has(key)) {
      return { ok: false, error: t("data.fieldDupKey").replace("{key}", key) };
    }
    seen.add(key);
    if (field.json) {
      try {
        out[key] = JSON.parse(field.text);
      } catch {
        return { ok: false, error: t("data.fieldBadJson").replace("{key}", key) };
      }
    } else {
      out[key] = field.text;
    }
  }
  return { ok: true, value: out };
}

function addValueField() {
  valueFields.value.push({ key: "", text: "", json: false });
}

/** Each mode hands the value over to the other, so a switch never loses what was typed. */
function switchValueMode(mode: "fields" | "raw") {
  if (mode === valueMode.value) return;
  if (mode === "raw") {
    const built = fieldsToObject();
    if (!built.ok) {
      formError.value = built.error;
      return;
    }
    recordValue.value = JSON.stringify(built.value, null, 2);
  } else {
    const text = recordValue.value.trim();
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        formError.value = t("data.notAnObject");
        return;
      }
      if (!isPlainObject(parsed)) {
        formError.value = t("data.notAnObject");
        return;
      }
      valueFields.value = toValueFields(parsed);
    } else {
      valueFields.value = [];
    }
  }
  formError.value = "";
  valueMode.value = mode;
}

function openRecordForm(record: DataRecord | null) {
  recordTarget.value = record;
  recordKey.value = record?.key ?? "";
  recordValue.value = record
    ? typeof record.value === "string"
      ? record.value
      : JSON.stringify(record.value, null, 2)
    : "";
  const asObject = record && isPlainObject(record.value) ? record.value : null;
  valueFields.value = asObject ? toValueFields(asObject) : [];
  // A record whose value is not an object -- a bare string, a number, a list -- opens as raw text
  valueMode.value = !record || asObject ? "fields" : "raw";
  if (!record) addValueField();
  formError.value = "";
  showRecordForm.value = true;
}

async function saveRecord() {
  if (selectedFolderId.value == null) return;
  formError.value = "";
  let valueText = recordValue.value;
  if (valueMode.value === "fields") {
    const built = fieldsToObject();
    if (!built.ok) {
      formError.value = built.error;
      return;
    }
    valueText = JSON.stringify(built.value);
  }
  saving.value = true;
  try {
    if (recordTarget.value) {
      await dataStoreApi.updateRecord(recordTarget.value.id, {
        key: recordKey.value,
        valueText,
      });
    } else {
      await dataStoreApi.createRecord(selectedFolderId.value, recordKey.value, valueText);
    }
    showRecordForm.value = false;
    await loadFolders();
  } catch (err: any) {
    formError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  } finally {
    saving.value = false;
  }
}

function askDeleteRecord(record: DataRecord) {
  deleteRecordTarget.value = record;
}

async function doDeleteRecord() {
  if (!deleteRecordTarget.value) return;
  saving.value = true;
  try {
    await dataStoreApi.deleteRecord(deleteRecordTarget.value.id);
    deleteRecordTarget.value = null;
    await loadFolders();
  } catch (err) {
    reportError(err);
  } finally {
    saving.value = false;
  }
}

/** The reference a job writes to read this record, on the clipboard. */
async function copyRef(record: DataRecord) {
  const folder = selectedFolder.value?.name ?? "";
  if (!(await copyText(dataRefText(folder, record.key)))) {
    error.value = t("common.copyFailed");
    return;
  }
  copiedId.value = record.id;
  setTimeout(() => (copiedId.value = null), 1500);
}

// ── A folder as a text file ───────────────────────────────────────────────────
//
// The format belongs to the folder and is kept when the file is downloaded, so a folder
// exported once is exported the same way next time without retyping it. Rendering happens on
// the backend for both the preview and the file, so what is previewed is the file itself
// rather than a second implementation's idea of it.

const DEFAULT_EXPORT_FORMAT = "{key}----{value}";

const textExportOpen = ref(false);
const textExportFolder = ref<DataFolder | null>(null);
const textExportFormat = ref(DEFAULT_EXPORT_FORMAT);
const textExportPreview = ref("");
const textExportCount = ref(0);
const textExportError = ref("");
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function openTextExport() {
  const folder = selectedFolder.value;
  if (!folder) return;
  textExportFolder.value = folder;
  textExportFormat.value = folder.exportFormat || DEFAULT_EXPORT_FORMAT;
  textExportPreview.value = "";
  textExportCount.value = 0;
  textExportError.value = "";
  textExportOpen.value = true;
  void refreshTextPreview();
}

/** Debounced: the preview follows the field without a request per keystroke. */
function queueTextPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshTextPreview(), 250);
}

const PREVIEW_LINES = 8;

async function refreshTextPreview() {
  const folder = textExportFolder.value;
  if (!folder) return;
  textExportError.value = "";
  try {
    const result = await dataStoreApi.exportText(folder.id, {
      format: textExportFormat.value,
      limit: PREVIEW_LINES,
    });
    textExportPreview.value = result.text;
    textExportCount.value = result.lineCount;
  } catch (err: any) {
    textExportPreview.value = "";
    textExportError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  }
}

/** Writes `<folder>.txt`, and keeps the format on the folder on the way past. */
async function downloadTextExport() {
  const folder = textExportFolder.value;
  if (!folder) return;
  saving.value = true;
  textExportError.value = "";
  try {
    const result = await dataStoreApi.exportText(folder.id, {
      format: textExportFormat.value,
      save: true,
    });
    const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    textExportOpen.value = false;
    // The kept format comes back with the folder list, so the next open is pre-filled with it
    await loadFolders();
  } catch (err: any) {
    textExportError.value = err?.response?.data?.error ?? String(err?.message ?? err);
  } finally {
    saving.value = false;
  }
}

async function exportStore(folderId?: number) {
  try {
    const payload = await dataStoreApi.export(folderId);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    const name = folderId ? `-${selectedFolder.value?.name ?? folderId}` : "";
    a.download = `bemby-data${name}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    reportError(err);
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

.data-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 12px;
  align-items: start;
}

@media (max-width: 900px) {
  .data-layout {
    grid-template-columns: 1fr;
  }
}

.data-folders {
  padding: 8px;
}

.data-records {
  padding: 8px;
  min-width: 0;
}

.data-panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 4px 6px 8px;
}

.data-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.data-folder-row:hover {
  background: rgba(74, 158, 255, 0.08);
}

.data-folder-row.is-active {
  background: rgba(74, 158, 255, 0.16);
}

.data-folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Kept out of the way until the row is under the pointer, so the list reads as a list */
.data-folder-actions {
  display: none;
  gap: 2px;
}

.data-folder-row:hover .data-folder-actions,
.data-folder-row.is-active .data-folder-actions {
  display: flex;
}

.data-records-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 6px 8px;
}

.data-filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 6px 8px;
}

.data-filter-search {
  width: 220px;
}

.data-filter-count {
  font-size: 12px;
  color: var(--text-muted);
}

/* Field, operator, value, remove -- the value column collapses on the operators that take none */
.data-filter-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
  gap: 6px;
  align-items: center;
  padding: 0 6px 6px;
}

@media (max-width: 700px) {
  .data-filter-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .data-filter-search {
    width: 100%;
  }
}

.data-value-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.data-mode-switch {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.data-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: none;
  background: var(--bg-card);
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.data-mode-btn.is-on {
  background: var(--primary);
  color: var(--text-on-accent);
}

.data-field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto auto;
  gap: 6px;
  margin-bottom: 6px;
}

.data-field-json {
  font-family: monospace;
  font-size: 12px;
}

.data-value-cell {
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}

/* The preview is the file: a long line scrolls rather than wrapping, so what would be one
   line in the file reads as one line here */
.data-text-preview {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
  font-family: monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  max-height: 200px;
  overflow: auto;
  white-space: pre;
}
</style>
