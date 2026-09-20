<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">Bemby</h1>
      <p class="login-subtitle">{{ t('login.subtitle') }}</p>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="form-group">
          <label class="form-label">{{ t('login.username') }}</label>
          <input v-model="form.username" class="form-input" type="text" autocomplete="username" required />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('login.password') }}</label>
          <input v-model="form.password" class="form-input" type="password" autocomplete="current-password" required />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('login.captcha') }}</label>
          <div class="captcha-row">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="captcha-img" v-html="captchaSvg" />
            <button type="button" class="btn btn-ghost btn-sm captcha-refresh" @click="loadCaptcha" :disabled="captchaLoading" title="Refresh">
              &#8635;
            </button>
          </div>
          <input
            v-model="form.captchaAnswer"
            class="form-input"
            type="text"
            autocomplete="off"
            :placeholder="t('login.captchaPlaceholder')"
            required
          />
        </div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" :disabled="loading || captchaLoading" type="submit">
          {{ loading ? t('login.signingIn') : t('login.signIn') }}
        </button>
      </form>

      <!-- Static help only: a forgotten password is reset from the host (see auth/adminReset),
           so there is nothing here for the login page to call. -->
      <button type="button" class="forgot-link" @click="showForgot = !showForgot">
        {{ t('login.forgot') }}
      </button>
      <div v-if="showForgot" class="forgot-help">
        <p>{{ t('login.forgotIntro') }}</p>
        <ol>
          <li v-for="(step, i) in ta('login.forgotSteps')" :key="i">{{ step }}</li>
        </ol>
        <pre class="forgot-code">ADMIN_PASSWORD_RESET=1</pre>
        <p class="forgot-note">{{ t('login.forgotNote') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { authApi, requirePasswordChangeSignal } from '../api/client';
import { t, ta } from '../i18n';

const router = useRouter();
const form = reactive({ username: '', password: '', captchaAnswer: '' });
const error = ref('');
const loading = ref(false);
const captchaLoading = ref(false);
const captchaSvg = ref('');
const captchaToken = ref('');
const showForgot = ref(false);

async function loadCaptcha() {
  captchaLoading.value = true;
  form.captchaAnswer = '';
  try {
    const data = await authApi.getCaptcha();
    captchaSvg.value = data.svg;
    captchaToken.value = data.captchaToken;
  } finally {
    captchaLoading.value = false;
  }
}

onMounted(loadCaptcha);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const { token, requirePasswordChange } = await authApi.login(form.username, form.password, captchaToken.value, form.captchaAnswer);
    localStorage.setItem('token', token);
    if (requirePasswordChange) {
      localStorage.setItem('bemby:requirePasswordChange', '1');
      requirePasswordChangeSignal.value = true;
    }
    router.push('/');
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '';

    if (status === 429) {
      error.value = t('login.rateLimited');
    } else if (msg.toLowerCase().includes('captcha')) {
      error.value = msg.toLowerCase().includes('expired') ? t('login.captchaExpired') : t('login.captchaError');
    } else {
      error.value = t('login.error');
    }
    // A challenge is spent the moment it is checked, whatever the attempt failed on, so
    // every failure needs a new one. Without this the retry after a mistyped password was
    // refused for the captcha instead, and the real problem never got a chance to show.
    if (status !== 429) await loadCaptcha();
  } finally {
    loading.value = false;
  }
}
</script>
