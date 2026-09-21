<script setup lang="ts">
import { ref } from "vue";
import { accountsApi, type AvatarPoolStatus, type AvatarPoolUpload } from "../api/client";
import { t } from "../i18n";

/**
 * Fills the avatar pool from the browser, so the images need not be copied onto the host
 * by hand: a .zip is unpacked on the server, a single image is taken as it is.
 *
 * Used both on the Settings page, where the pool is stocked ahead of time, and inside the
 * bulk profile dialog, where someone finds the pool empty at the moment they need it. The
 * pool status that comes back with each upload is emitted so the host can show the new
 * count without asking again.
 */
const emit = defineEmits<{ uploaded: [status: AvatarPoolStatus] }>();

/** Mirrors the server's cap on one avatar-pool upload (routes/accounts). */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

const input = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const error = ref("");
const result = ref<AvatarPoolUpload | null>(null);

/**
 * Sends the chosen file to the pool and shows what came of it.
 *
 * The file input is cleared afterwards, so picking the same archive again re-uploads it
 * rather than doing nothing -- which is what someone who has just fixed the archive expects.
 */
async function upload(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  error.value = "";
  result.value = null;
  // Refused here rather than after sending the whole thing for the server to refuse
  if (file.size > MAX_UPLOAD_BYTES) {
    error.value = t("accounts.bulkTgRename.avatarUploadTooBig");
    target.value = "";
    return;
  }
  uploading.value = true;
  try {
    const answer = await accountsApi.uploadAvatarPool(file);
    result.value = answer;
    emit("uploaded", {
      dir: answer.dir,
      count: answer.count,
      online: answer.online,
      styles: answer.styles,
    });
  } catch (err: any) {
    // A body over the limit is refused by the server's parser, which answers before the
    // route runs and so carries none of its wording
    error.value =
      err?.response?.status === 413
        ? t("accounts.bulkTgRename.avatarUploadTooBig")
        : (err?.response?.data?.error ??
          err?.message ??
          t("accounts.bulkTgRename.avatarUploadFailed"));
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
</script>

<template>
  <div class="pool-upload">
    <input
      ref="input"
      type="file"
      accept=".zip,application/zip,image/jpeg,image/png,image/webp"
      :disabled="uploading"
      @change="upload"
    />
    <span v-if="uploading" class="form-hint">
      {{ t("accounts.bulkTgRename.avatarUploading") }}
    </span>
    <div class="form-hint">
      {{ t("accounts.bulkTgRename.avatarUploadHint") }}
    </div>
    <div v-if="error" class="error-msg">{{ error }}</div>
    <div v-if="result" class="form-hint">
      <strong>
        {{
          t("accounts.bulkTgRename.avatarUploadAdded").replace(
            "{n}",
            String(result.added.length),
          )
        }}
      </strong>
      <template v-if="result.duplicates">
        &middot;
        {{
          t("accounts.bulkTgRename.avatarUploadDuplicates").replace(
            "{n}",
            String(result.duplicates),
          )
        }}
      </template>
      <template v-if="result.skipped.length">
        &middot;
        {{
          t("accounts.bulkTgRename.avatarUploadSkipped").replace(
            "{n}",
            String(result.skipped.length),
          )
        }}
        <ul class="pool-skipped">
          <li v-for="(row, at) in result.skipped.slice(0, 8)" :key="`${at}-${row.name}`">
            {{ row.name }} -- {{ row.why }}
          </li>
          <li v-if="result.skipped.length > 8">
            {{
              t("accounts.bulkTgRename.avatarUploadMore").replace(
                "{n}",
                String(result.skipped.length - 8),
              )
            }}
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pool-upload input[type="file"] {
  font-size: 12px;
  max-width: 100%;
}

/* Reasons an archive's entries were left out: short, and scrolling rather than pushing the
   dialog's buttons off the screen when an archive is mostly the wrong sort of file */
.pool-skipped {
  margin: 4px 0 0;
  padding-left: 18px;
  max-height: 110px;
  overflow-y: auto;
}
</style>
