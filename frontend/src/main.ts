import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { suppressEdgeMinimizeRestore } from './utils/edgeMinimize';
import { initTheme } from './composables/useTheme';
import './style.css';
import '@fortawesome/fontawesome-free/css/all.min.css';

(async () => {
  suppressEdgeMinimizeRestore();
  initTheme();
  const app = createApp(App);
  app.use(router);
  await router.isReady();
  app.mount('#app');
})();
