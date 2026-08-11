<template>
  <span class="job-icon" :style="{ width: px, height: px, fontSize: glyphPx }">
    <img v-if="url" :src="url" alt="" />
    <i v-else :class="fontClass"></i>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  customIconUrl,
  isCustomIcon,
  DEFAULT_JOB_ICON,
} from "../composables/jobIcons";

const props = withDefaults(
  defineProps<{ icon?: string | null; size?: number }>(),
  { icon: null, size: 18 },
);

const px = computed(() => `${props.size}px`);
const glyphPx = computed(() => `${Math.round(props.size * 0.82)}px`);

const url = computed(() => customIconUrl(props.icon));

// An uploaded icon that has since been deleted leaves a reference pointing at nothing;
// falling back keeps the row's shape instead of drawing a broken image.
const fontClass = computed(() =>
  !props.icon || isCustomIcon(props.icon) ? DEFAULT_JOB_ICON : props.icon,
);
</script>

<style scoped>
.job-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
  color: inherit;
}

.job-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
