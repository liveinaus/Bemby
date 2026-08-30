<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * A whole-number field that keeps what is being typed.
 *
 * A native `type=number` input is the thing this replaces. It hands the page an empty value
 * the moment its text is not a valid number, and pressing its stepper selects the whole
 * value -- either one turns a single backspace into a cleared field. This holds the text
 * itself, reports the number it parses to, and still steps with the arrow keys.
 *
 * `class`, `style` and `placeholder` are not props: they fall through to the input, so a
 * call site reads the same as the `<input>` it replaced.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number;
    /** Lowest value the arrows go to. A field without one below zero admits a minus sign. */
    min?: number;
    max?: number;
    /** How much the arrow keys move it. */
    step?: number;
  }>(),
  { step: 1 },
);

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();

const text = ref(props.modelValue == null ? '' : String(props.modelValue));

const takesMinus = () => props.min == null || props.min < 0;
const numberOf = (s: string): number => (s === '' || s === '-' ? 0 : Number(s));

/** Digits, and a leading minus only where the field admits negatives (message scope). */
const clean = (raw: string): string =>
  (takesMinus() && raw.trimStart().startsWith('-') ? '-' : '') + raw.replace(/\D/g, '');

// Follow the model when something else moves it -- the form loading a job, say -- but leave
// the box alone while it says the same number as the text in it. That is what lets a field
// be emptied on the way to typing another value without it filling itself back in.
watch(
  () => props.modelValue,
  (v) => {
    if (numberOf(text.value) === v) return;
    text.value = v == null ? '' : String(v);
  },
);

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = clean(el.value);
  if (next !== el.value) {
    // Something the field does not take was typed. Put the text back without it and hold
    // the caret where it was, rather than letting it jump to the end.
    const caret = el.selectionStart ?? el.value.length;
    const at = Math.max(0, caret - (el.value.length - next.length));
    el.value = next;
    el.setSelectionRange(at, at);
  }
  text.value = next;
  emit('update:modelValue', numberOf(next));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  let next = numberOf(text.value) + (props.step || 1) * (e.key === 'ArrowUp' ? 1 : -1);
  if (props.min != null) next = Math.max(props.min, next);
  if (props.max != null) next = Math.min(props.max, next);
  text.value = String(next);
  emit('update:modelValue', next);
}

/** On the way out the box says the number the form holds: "" reads as 0, "007" as 7. */
function onBlur() {
  const n = numberOf(text.value);
  text.value = String(n);
  if (n !== props.modelValue) emit('update:modelValue', n);
}
</script>

<template>
  <input
    type="text"
    inputmode="numeric"
    :value="text"
    @input="onInput"
    @keydown="onKeydown"
    @blur="onBlur"
  />
</template>
