// @ts-check

import './styles.css';
import { startApp } from './app.js';
import { externalApiLog, serializeExternalError } from './observability/external-api-log.js';

startApp().catch((error) => {
  const root = document.querySelector('#app');
  if (root) {
    root.textContent = 'Aplicația nu a putut porni. Verifică fișierul .env și încearcă din nou.';
  }
  externalApiLog('error', 'application', 'startup', { error: serializeExternalError(error) });
});
