<template>
  <div v-if="isPublicRoute" class="full-page">
    <router-view />
  </div>
  <div v-else class="layout">
    <header class="mobile-header">
      <button class="hamburger-btn" @click="sidebarOpen = !sidebarOpen" :aria-expanded="sidebarOpen">
        <i class="fa-solid fa-bars"></i>
      </button>
      <div class="mobile-header-right">
        <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
          {{ locale === 'zh' ? 'EN' : '中文' }}
        </button>
        <div class="mobile-header-brand">
          <img src="/logo.png" alt="Bemby" class="mobile-logo-img" />
          <span class="mobile-brand-name">BEMBY</span>
          <span class="mobile-version">v{{ APP_VERSION }}</span>
        </div>
      </div>
    </header>

    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />

    <nav class="sidebar" :class="{ 'is-open': sidebarOpen }">
      <div class="sidebar-title">
        <a class="sidebar-brand" href="https://github.com/liveinaus/Bemby" target="_blank" rel="noopener noreferrer">
          <img src="/logo.png" alt="Bemby" class="sidebar-logo" />
          <div class="sidebar-brand-text">
            <span class="sidebar-name">BEMBY</span>
            <span class="sidebar-version">v{{ APP_VERSION }}</span>
          </div>
        </a>
      </div>
      <a class="nav-link" href="#" :class="{ active: currentView === 'accounts' }" @click.prevent="setView('accounts')"><i class="fa-solid fa-users"></i>{{ t('nav.accounts') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'messenger' }" @click.prevent="setView('messenger')"><i class="fa-brands fa-telegram"></i>{{ t('nav.messenger') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'jobs' }" @click.prevent="setView('jobs')"><i class="fa-solid fa-robot"></i>{{ t('nav.jobs') }}</a>
      <a v-if="scheduleSeparatePage" class="nav-link" href="#" :class="{ active: currentView === 'schedule' }" @click.prevent="setView('schedule')"><i class="fa-solid fa-calendar-days"></i>{{ t('nav.schedule') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'templates' }" @click.prevent="setView('templates')"><i class="fa-solid fa-layer-group"></i>{{ t('nav.templates') }}</a>
      <a v-if="dataStoreEnabled" class="nav-link" href="#" :class="{ active: currentView === 'data' }" @click.prevent="setView('data')"><i class="fa-solid fa-database"></i>{{ t('nav.data') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'logs' }" @click.prevent="setView('logs')"><i class="fa-solid fa-scroll"></i>{{ t('nav.logs') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'settings' }" @click.prevent="setView('settings')"><i class="fa-solid fa-gear"></i>{{ t('nav.settings') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'help' }" @click.prevent="setView('help')"><i class="fa-solid fa-circle-question"></i>{{ t('nav.help') }}</a>
      <div class="sidebar-footer">
        <div class="lang-switcher">
          <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
            {{ locale === 'zh' ? 'EN' : '中文' }}
          </button>
        </div>
        <a class="github-link" href="https://t.me/cool_bemby" target="_blank" rel="noopener noreferrer">
          <i class="fa-brands fa-telegram" style="font-size:16px" aria-hidden="true"></i>
          {{ t('nav.community') }}
        </a>
        <a class="github-link" href="https://github.com/liveinaus/Bemby" target="_blank" rel="noopener noreferrer">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub
        </a>
        <button class="logout-btn" @click="logout"><i class="fa-solid fa-right-from-bracket"></i> {{ t('nav.logout') }}</button>
      </div>
    </nav>

    <main class="main" :class="{ 'main-flush': currentView === 'messenger' }">
      <component :is="currentComponent" />
    </main>

    <!-- Progress for bulk work running on the server; survives page reloads -->
    <BulkTaskDock />
  </div>

  <!-- Forced password change when default password is detected -->
  <div v-if="showForceChangePassword" class="force-pwd-overlay">
    <div class="force-pwd-card">
      <h2 class="force-pwd-title">{{ t('forcePwd.title') }}</h2>
      <p class="force-pwd-subtitle">{{ t('forcePwd.subtitle') }}</p>
      <div v-if="forcePwdError" class="error-msg">{{ forcePwdError }}</div>
      <div class="form-group">
        <label class="form-label">{{ t('forcePwd.newPassword') }}</label>
        <input v-model="forcePwdNew" type="password" class="form-input" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label class="form-label">{{ t('forcePwd.confirmPassword') }}</label>
        <input v-model="forcePwdConfirm" type="password" class="form-input" autocomplete="new-password" @keyup.enter="submitForcePwdChange" />
      </div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" :disabled="forcePwdSaving" @click="submitForcePwdChange">
        {{ forcePwdSaving ? t('common.saving') : t('forcePwd.submit') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { version } from '../package.json';
const APP_VERSION = version + (import.meta.env.DEV ? '-dev' : '');
import { t, locale, setLocale } from './i18n';
import { authApi, requirePasswordChangeSignal } from './api/client';
import AccountsView from './views/AccountsView.vue';
import JobsView from './views/JobsView.vue';
import TemplatesView from './views/TemplatesView.vue';
import DataView from './views/DataView.vue';
import LogsView from './views/LogsView.vue';
import SettingsView from './views/SettingsView.vue';
import HelpView from './views/HelpView.vue';
import MessengerView from './views/MessengerView.vue';
import ScheduleView from './views/ScheduleView.vue';
import BulkTaskDock from './components/BulkTaskDock.vue';
import {
  loadSchedulePageSetting,
  scheduleSeparatePage,
} from './composables/schedulePage';
import { dataStoreEnabled, loadDataStoreSetting } from './composables/dataStore';
import { requestedView } from './composables/viewNav';

type ViewName = 'accounts' | 'messenger' | 'jobs' | 'schedule' | 'templates' | 'data' | 'settings' | 'logs' | 'help';

const LAST_VIEW_KEY = 'bemby:lastView';
const VALID_VIEWS: ViewName[] = ['accounts', 'messenger', 'jobs', 'schedule', 'templates', 'data', 'settings', 'logs', 'help'];

const viewComponents: Record<ViewName, Component> = {
  accounts: AccountsView,
  messenger: MessengerView,
  jobs: JobsView,
  schedule: ScheduleView,
  templates: TemplatesView,
  data: DataView,
  settings: SettingsView,
  logs: LogsView,
  help: HelpView,
};

const savedView = localStorage.getItem(LAST_VIEW_KEY) as ViewName;
const currentView = ref<ViewName>(VALID_VIEWS.includes(savedView) ? savedView : 'accounts');
const currentComponent = computed(() => {
  // A view whose menu entry is switched off falls back rather than showing an empty page
  if (currentView.value === 'schedule' && !scheduleSeparatePage.value) return viewComponents.jobs;
  if (currentView.value === 'data' && !dataStoreEnabled.value) return viewComponents.accounts;
  return viewComponents[currentView.value];
});
loadSchedulePageSetting();
loadDataStoreSetting();

function setView(view: ViewName) {
  currentView.value = view;
  localStorage.setItem(LAST_VIEW_KEY, view);
  sidebarOpen.value = false;
}

// A view asking to hand over to another one (Accounts opening the Messenger on an account)
watch(requestedView, (view) => {
  if (!view) return;
  requestedView.value = null;
  setView(view);
});

const route = useRoute();
const router = useRouter();

const isPublicRoute = computed(() => route.meta.public === true);
const sidebarOpen = ref(false);

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('bemby:requirePasswordChange');
  router.push('/login');
}

const FORCE_PWD_KEY = 'bemby:requirePasswordChange';
const showForceChangePassword = ref(
  localStorage.getItem(FORCE_PWD_KEY) === '1' || requirePasswordChangeSignal.value,
);

// Show modal whenever the signal fires (e.g. fresh login or 403 from backend)
watch(requirePasswordChangeSignal, (val) => {
  if (val) showForceChangePassword.value = true;
});
const forcePwdNew = ref('');
const forcePwdConfirm = ref('');
const forcePwdError = ref('');
const forcePwdSaving = ref(false);

async function submitForcePwdChange() {
  forcePwdError.value = '';
  if (!forcePwdNew.value) {
    forcePwdError.value = t('forcePwd.required');
    return;
  }
  if (forcePwdNew.value !== forcePwdConfirm.value) {
    forcePwdError.value = t('forcePwd.mismatch');
    return;
  }
  if (forcePwdNew.value === 'changeme') {
    forcePwdError.value = t('forcePwd.sameAsDefault');
    return;
  }
  forcePwdSaving.value = true;
  try {
    const { token } = await authApi.changeCredentials('changeme', undefined, forcePwdNew.value);
    if (token) localStorage.setItem('token', token);
    localStorage.removeItem(FORCE_PWD_KEY);
    requirePasswordChangeSignal.value = false;
    showForceChangePassword.value = false;
  } catch (err: any) {
    forcePwdError.value = err.response?.data?.error ?? t('forcePwd.failed');
  } finally {
    forcePwdSaving.value = false;
  }
}
</script>

<style scoped>
.force-pwd-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.force-pwd-card {
  background: var(--bg-card, #1e1e2e);
  border-radius: 8px;
  padding: 2rem;
  width: 100%;
  max-width: 400px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.force-pwd-title {
  margin: 0 0 0.5rem;
  color: var(--text-primary, #fff);
  font-size: 1.25rem;
}

.force-pwd-subtitle {
  color: var(--text-secondary, #aaa);
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
}
</style>
