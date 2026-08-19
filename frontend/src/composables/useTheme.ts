import { computed, ref } from 'vue';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bemby:theme';
const MODES: ThemeMode[] = ['light', 'dark', 'auto'];

function readStored(): ThemeMode {
	const raw = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
	return raw && MODES.includes(raw) ? raw : 'auto';
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export const themeMode = ref<ThemeMode>(readStored());
const systemDark = ref(darkQuery.matches);

export const resolvedTheme = computed<ResolvedTheme>(() =>
	themeMode.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : themeMode.value,
);

function apply() {
	const root = document.documentElement;
	root.dataset.theme = resolvedTheme.value;
	// Keeps native widgets (scrollbars, date pickers, form controls) in step with the page
	root.style.colorScheme = resolvedTheme.value;
}

export function setTheme(mode: ThemeMode) {
	themeMode.value = mode;
	localStorage.setItem(STORAGE_KEY, mode);
	apply();
}

// Steps through light → dark → auto, for the single-button toggle on narrow screens
export function cycleTheme() {
	setTheme(MODES[(MODES.indexOf(themeMode.value) + 1) % MODES.length]);
}

export function initTheme() {
	darkQuery.addEventListener('change', (e) => {
		systemDark.value = e.matches;
		if (themeMode.value === 'auto') apply();
	});
	// Another tab changing the preference keeps this one in step
	window.addEventListener('storage', (e) => {
		if (e.key !== STORAGE_KEY) return;
		themeMode.value = readStored();
		apply();
	});
	apply();
}
