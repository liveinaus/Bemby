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
 *
 * `scale` lets the box show a unit the form does not store in: a millisecond field with
 * `scale` 1000 is read and typed in seconds, while the model, and `min`/`max`/`step`, stay
 * in milliseconds. A scaled field takes a decimal point, so 1500ms reads as 1.5 and comes
 * back as 1500 rather than being rounded to a whole second.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number;
    /** Lowest value the arrows go to. A field without one below zero admits a minus sign. */
    min?: number;
    max?: number;
    /** How much the arrow keys move it. */
    step?: number;
    /** Model units per displayed unit. 1 shows the model itself. */
    scale?: number;
  }>(),
  { step: 1, scale: 1 },
);

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();

const scaled = () => (props.scale ?? 1) !== 1;

/** The model value as the box spells it: scaled, and without a trailing ".0". */
function toText(value: number): string {
  if (value == null) return '';
  if (!scaled()) return String(value);
  return String(Number((value / props.scale).toFixed(3)));
}

const takesMinus = () => props.min == null || props.min < 0;

function numberOf(s: string): number {
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** What the form holds for the text in the box, back in the model's own unit. */
const modelOf = (s: string): number =>
  scaled() ? Math.round(numberOf(s) * props.scale) : numberOf(s);

/**
 * Digits, a leading minus only where the field admits negatives (message scope), and a
 * single decimal point only where the box is scaled.
 */
function clean(raw: string): string {
  const sign = takesMinus() && raw.trimStart().startsWith('-') ? '-' : '';
  const digits = raw.replace(scaled() ? /[^\d.]/g : /\D/g, '');
  if (!scaled()) return sign + digits;
  // Keep only the first point, so a second one is dropped rather than voiding the number
  const [whole, ...rest] = digits.split('.');
  return sign + whole + (rest.length ? `.${rest.join('')}` : '');
}

const text = ref(toText(props.modelValue));

// Follow the model when something else moves it -- the form loading a job, say -- but leave
// the box alone while it says the same number as the text in it. That is what lets a field
// be emptied on the way to typing another value without it filling itself back in.
watch(
  () => props.modelValue,
  (v) => {
    if (modelOf(text.value) === v) return;
    text.value = toText(v);
  },
);

// A flipped "prefer seconds" setting changes the unit under a box that is already on screen
watch(
  () => props.scale,
  () => {
    text.value = toText(props.modelValue);
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
  emit('update:modelValue', modelOf(next));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  let next = modelOf(text.value) + (props.step || 1) * (e.key === 'ArrowUp' ? 1 : -1);
  if (props.min != null) next = Math.max(props.min, next);
  if (props.max != null) next = Math.min(props.max, next);
  text.value = toText(next);
  emit('update:modelValue', next);
}

/** On the way out the box says the number the form holds: "" reads as 0, "007" as 7. */
function onBlur() {
  const n = modelOf(text.value);
  text.value = toText(n);
  if (n !== props.modelValue) emit('update:modelValue', n);
}
</script>

<template>
  <input
    type="text"
    :inputmode="scaled() ? 'decimal' : 'numeric'"
    :value="text"
    @input="onInput"
    @keydown="onKeydown"
    @blur="onBlur"
  />
</template>
