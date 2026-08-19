<template>
  <div class="pagination-bar">
    <span class="pagination-total">{{
      t("common.paginationTotal").replace("{n}", String(total))
    }}</span>
    <div class="pagination-controls">
      <select
        class="form-select pagination-size"
        :value="pageSize"
        @change="onSizeChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="size in sizes" :key="size" :value="size">
          {{
            size === ALL_PAGE_SIZE
              ? t("common.perPageAll")
              : t("common.perPage").replace("{n}", String(size))
          }}
        </option>
      </select>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="page <= 1"
        @click="go(page - 1)"
      >
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="pagination-page">{{ page }} / {{ pageCount }}</span>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="page >= pageCount"
        @click="go(page + 1)"
      >
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";

const props = defineProps<{
  page: number;
  pageSize: number;
  total: number;
}>();

const emit = defineEmits<{
  (e: "update:page", value: number): void;
  (e: "update:pageSize", value: number): void;
}>();

/** "All" is sent to the server as a page size of 0, meaning one page with every row. */
const ALL_PAGE_SIZE = 0;

const sizes = [10, 25, 50, 100, ALL_PAGE_SIZE];

const pageCount = computed(() =>
  props.pageSize > 0 ? Math.max(1, Math.ceil(props.total / props.pageSize)) : 1,
);

function go(page: number) {
  emit("update:page", Math.min(Math.max(1, page), pageCount.value));
}

function onSizeChange(value: string) {
  emit("update:pageSize", Number(value));
  emit("update:page", 1);
}
</script>

<style scoped>
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 10px 14px 2px;
}
.pagination-total {
  color: var(--text-secondary, var(--text-muted));
  font-size: 0.85rem;
}
.pagination-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.pagination-size {
  width: auto;
  padding: 0.25rem 1.6rem 0.25rem 0.5rem;
  font-size: 0.85rem;
}
.pagination-page {
  font-size: 0.85rem;
  min-width: 3.5rem;
  text-align: center;
}
</style>
