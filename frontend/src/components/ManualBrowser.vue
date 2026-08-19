<template>
  <div class="mb-backdrop" @click.self="close">
    <div class="mb-panel">
      <div class="mb-head">
        <div class="mb-title">
          <i class="fa-solid fa-desktop"></i>
          {{ t("manualBrowser.title") }}
          <span v-if="session" class="mb-job">{{ session.jobName }}</span>
        </div>
        <!-- Which profile the cookie is about to land in: the whole point of the session.
             A job on {noProfile} has a throwaway one, so it is named as such rather than
             shown as the "(none)" the backend calls it -->
        <span v-if="session" class="mb-profile" :title="t('manualBrowser.profileHint')">
          {{ t("manualBrowser.profile") }}:
          {{ session.ephemeral ? t("manualBrowser.profileTemp") : session.profileKey }}
        </span>
        <!-- And which exit it goes out through: a cookie is only as good as the IP it was
             issued to, and the screen says nothing about that -->
        <span v-if="session?.proxyLabel" class="mb-profile" :title="t('manualBrowser.proxyHint')">
          {{ t("manualBrowser.proxy") }}: {{ proxyText }}
        </span>
        <button
          v-if="props.runId"
          class="btn btn-sm"
          :class="viewOnly ? 'btn-ghost' : 'btn-primary'"
          :disabled="state !== 'live'"
          @click="toggleControl"
        >
          <i class="fa-solid" :class="viewOnly ? 'fa-eye' : 'fa-hand-pointer'"></i>
          {{ viewOnly ? t("manualBrowser.takeControl") : t("manualBrowser.watching") }}
        </button>
        <form v-if="!props.runId" class="mb-address" @submit.prevent="go">
          <input
            v-model.trim="address"
            class="form-input mb-url"
            :placeholder="t('manualBrowser.urlPlaceholder')"
            :disabled="state !== 'live'"
          />
          <button class="btn btn-sm btn-ghost" type="submit" :disabled="state !== 'live' || navigating">
            {{ navigating ? t("manualBrowser.going") : t("manualBrowser.go") }}
          </button>
        </form>
        <!-- Getting a username and password in without typing them by hand -->
        <button
          class="btn btn-sm"
          :class="clipboardOpen ? 'btn-primary' : 'btn-ghost'"
          :disabled="state !== 'live' || viewOnly"
          :title="viewOnly ? t('manualBrowser.clipboardNeedsControl') : t('manualBrowser.clipboardTip')"
          @click="toggleClipboard"
        >
          <i class="fa-solid fa-clipboard"></i> {{ t("manualBrowser.clipboard") }}
        </button>
        <span class="mb-state" :class="stateClass">{{ stateText }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="close">
          <i class="fa-solid fa-xmark"></i> {{ t("manualBrowser.close") }}
        </button>
      </div>

      <div v-if="clipboardOpen" class="mb-clip">
        <textarea
          ref="clipBox"
          v-model="clipText"
          class="form-input mb-clip-box"
          rows="2"
          :placeholder="t('manualBrowser.clipboardPlaceholder')"
        ></textarea>
        <div class="mb-clip-actions">
          <button
            v-if="canReadHostClipboard"
            class="btn btn-sm btn-ghost"
            :title="t('manualBrowser.readHostTip')"
            @click="readHostClipboard"
          >
            <i class="fa-solid fa-paste"></i> {{ t("manualBrowser.readHost") }}
          </button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="!clipText || typing"
            :title="t('manualBrowser.sendClipboardTip')"
            @click="sendClipboard"
          >
            <i class="fa-solid fa-clipboard-check"></i> {{ t("manualBrowser.sendClipboard") }}
          </button>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!clipText || typing"
            :title="t('manualBrowser.typeItTip')"
            @click="typeText"
          >
            <i class="fa-solid fa-keyboard"></i>
            {{ typing ? t("manualBrowser.typingNow") : t("manualBrowser.typeIt") }}
          </button>
        </div>
        <div class="mb-clip-hint">{{ clipMsg || t("manualBrowser.clipboardHint") }}</div>
      </div>

      <!-- Not an error: the session is open and usable, it just keeps nothing -->
      <div v-if="session?.ephemeral" class="mb-note">
        <i class="fa-solid fa-circle-info"></i> {{ t("manualBrowser.ephemeralNote") }}
      </div>

      <div v-if="error" class="mb-error">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ error }}
        <button class="btn btn-sm btn-ghost" style="margin-left: 8px" @click="connect">
          {{ t("common.refresh") }}
        </button>
      </div>

      <div ref="screen" class="mb-screen"></div>

      <div class="mb-foot">
        {{ props.runId ? t("manualBrowser.watchHint") : t("manualBrowser.footHint") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed, nextTick } from "vue";
import RFB from "@novnc/novnc";
import { t } from "../i18n";
import { manualBrowserApi, type ManualSession } from "../api/client";

// Shows the browser a job runs as, for signing in by hand once so the scheduled runs have
// the cookie. The session belongs to the server: this only opens it, attaches to its screen,
// and closes it again.
const props = defineProps<{ jobId?: number; runId?: string }>();
const emit = defineEmits<{ (e: "closed"): void }>();

const screen = ref<HTMLDivElement>();
const session = ref<ManualSession | null>(null);
const state = ref<"starting" | "connecting" | "live" | "gone">("starting");
const error = ref("");
const busy = ref(false);
const address = ref("");
const viewOnly = ref(!!props.runId);
const navigating = ref(false);
const clipboardOpen = ref(false);
const clipText = ref("");
const clipMsg = ref("");
const typing = ref(false);
const clipBox = ref<HTMLTextAreaElement>();
let rfb: any = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;

// `direct` is the backend's own word for no proxy at all; say it in the panel's language
const proxyText = computed(() =>
  session.value?.proxyLabel === "direct"
    ? t("manualBrowser.proxyDirect")
    : (session.value?.proxyLabel ?? ""),
);

const stateText = computed(() => t(`manualBrowser.state.${state.value}`));
const stateClass = computed(() => ({
  "mb-live": state.value === "live",
  "mb-warn": state.value === "gone",
}));

function wsUrl(ticket: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/vnc?ticket=${encodeURIComponent(ticket)}`;
}

/** Attaches to the session's screen. A ticket is single-use, so each attempt asks for one. */
async function connect() {
  error.value = "";
  state.value = "connecting";
  try {
    const { session: live, ticket } = session.value
      ? await manualBrowserApi.ticket()
      : props.runId
        ? await manualBrowserApi.watch(props.runId)
        : await manualBrowserApi.start(props.jobId as number);
    session.value = live;
    // Whatever the job opens with, as a starting point to edit
    if (!address.value && live.url && live.url !== "about:blank") address.value = live.url;

    rfb?.disconnect?.();
    rfb = new RFB(screen.value, wsUrl(ticket));
    rfb.scaleViewport = true;
    rfb.clipViewport = true;
    // A run is driving its own browser; a stray click would fight it. Watching starts
    // hands-off and the operator takes over deliberately.
    rfb.viewOnly = viewOnly.value;
    rfb.addEventListener("connect", () => {
      state.value = "live";
    });
    rfb.addEventListener("disconnect", () => {
      // Closing on purpose unmounts this, so a drop here is the browser going away
      if (state.value !== "gone") state.value = "gone";
    });
    // The other direction: something copied over there lands in the box, where it can be
    // copied out of this page normally. Writing it to the host clipboard directly needs a
    // permission the page may not have.
    rfb.addEventListener("clipboard", (e: any) => {
      const text = e?.detail?.text;
      if (typeof text !== "string" || !text) return;
      clipText.value = text;
      clipMsg.value = t("manualBrowser.clipboardFromRemote");
    });
  } catch (e: any) {
    state.value = "gone";
    error.value = e?.response?.data?.error ?? e?.message ?? String(e);
  }
}

/** Sends the browser to the typed address. */
async function go() {
  if (!address.value || navigating.value) return;
  navigating.value = true;
  error.value = "";
  try {
    const r = await manualBrowserApi.goto(address.value);
    address.value = r.url;
  } catch (e: any) {
    error.value = e?.response?.data?.error ?? e?.message ?? String(e);
  } finally {
    navigating.value = false;
  }
}

/** Hands the pointer and keyboard to the operator, or takes them back. */
function toggleControl() {
  viewOnly.value = !viewOnly.value;
  if (rfb) rfb.viewOnly = viewOnly.value;
  if (viewOnly.value) clipboardOpen.value = false;
}

// ── Clipboard ────────────────────────────────────────────────────────────────
// A password typed by hand into a screen inside a screen is the worst part of signing in
// here. Two ways across, because neither works everywhere: the remote clipboard, which needs
// the page to allow pasting, and synthesised keystrokes, which any field accepts but which
// go wherever the remote focus happens to be.

/** The host clipboard is only readable over https (or localhost), and only with permission. */
const canReadHostClipboard = computed(() => !!navigator.clipboard?.readText);

function toggleClipboard() {
  clipboardOpen.value = !clipboardOpen.value;
  clipMsg.value = "";
  if (clipboardOpen.value) void nextTick(() => clipBox.value?.focus());
}

async function readHostClipboard() {
  clipMsg.value = "";
  try {
    clipText.value = await navigator.clipboard.readText();
  } catch {
    // Denied, or the page is not on a secure origin: pasting into the box still works
    clipMsg.value = t("manualBrowser.readHostFailed");
  }
}

/** Puts the text on the remote clipboard, for Ctrl+V inside the browser over there. */
function sendClipboard() {
  if (!rfb || !clipText.value) return;
  rfb.clipboardPasteFrom(clipText.value);
  // The wire format is one byte per character unless the server offers the extended
  // clipboard, which x11vnc does not: anything outside Latin-1 arrives mangled
  clipMsg.value = /^[\x20-\xff\r\n\t]*$/.test(clipText.value)
    ? t("manualBrowser.clipboardSent")
    : t("manualBrowser.clipboardSentLossy");
}

/**
 * The X keysym for one character: Latin-1 is itself, and everything else lives in the
 * Unicode range. Newlines and tabs are keys rather than characters.
 */
function keysymOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x0a || cp === 0x0d) return 0xff0d; // Return
  if (cp === 0x09) return 0xff09; // Tab
  if (cp >= 0x20 && cp <= 0xff) return cp;
  return 0x01000000 + cp;
}

/**
 * Types the text into whatever has the focus over there, one key at a time. Slower than the
 * clipboard, but it is what gets past a login form that refuses a paste -- and it carries
 * characters the clipboard cannot.
 */
async function typeText() {
  if (!rfb || typing.value || !clipText.value) return;
  typing.value = true;
  clipMsg.value = t("manualBrowser.typingHint");
  try {
    for (const ch of clipText.value) {
      rfb.sendKey(keysymOf(ch), null);
      // A field with a keystroke handler on every character needs room to keep up
      await new Promise((r) => setTimeout(r, 12));
    }
    clipMsg.value = t("manualBrowser.typedDone");
  } finally {
    typing.value = false;
  }
}

async function close() {
  if (busy.value) return;
  busy.value = true;
  state.value = "gone";
  try {
    rfb?.disconnect?.();
  } catch {
    /* already gone */
  }
  rfb = null;
  try {
    await manualBrowserApi.stop();
  } catch {
    /* the session may already have timed out */
  }
  busy.value = false;
  emit("closed");
}

onMounted(async () => {
  await connect();
  // Watching without touching anything still counts as being here: the server closes an idle
  // session to free the profile, and a page being read is not idle
  keepAlive = setInterval(() => {
    void manualBrowserApi.status().catch(() => {});
  }, 30_000);
});

onBeforeUnmount(() => {
  if (keepAlive) clearInterval(keepAlive);
  try {
    rfb?.disconnect?.();
  } catch {
    /* already gone */
  }
});
</script>

<style scoped>
.mb-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  padding: 16px;
}

.mb-panel {
  background: var(--bg-card);
  border-radius: 8px;
  width: min(1320px, 100%);
  height: min(900px, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.mb-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-job {
  font-weight: 400;
  color: var(--text-tertiary);
}

.mb-address {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 1;
  min-width: 0;
  margin-left: 12px;
}

.mb-url {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: 12px;
}

.mb-profile {
  font-size: 11px;
  font-family: monospace;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  padding: 2px 6px;
  border-radius: 8px;
}

.mb-state {
  font-size: 11px;
  color: var(--text-muted);
}

.mb-live {
  color: var(--success);
}

.mb-warn {
  color: var(--warning);
}

/* A standing fact about the session, told once, in the colour of a note rather than a fault */
.mb-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--warning-soft-text);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--warning-border);
}

.mb-error {
  padding: 8px 12px;
  background: var(--danger-soft);
  color: var(--danger-soft-text);
  font-size: 12px;
}

/* The clipboard bar sits between the header and the screen, and never takes room from it */
.mb-clip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border);
}

.mb-clip-box {
  flex: 1 1 320px;
  min-height: 44px;
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
}

.mb-clip-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mb-clip-hint {
  flex: 1 0 100%;
  font-size: 11px;
  color: var(--text-muted);
}

/* noVNC sizes its canvas to this box */
.mb-screen {
  flex: 1;
  min-height: 0;
  background: #111;
}

.mb-foot {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
}
</style>
