// @ts-check

import './styles.css';
import { startApp } from './app.js';

startApp().catch((error) => {
  const root = document.querySelector('#app');
  if (root) {
    root.textContent = 'Aplicația nu a putut porni. Verifică fișierul .env și încearcă din nou.';
  }
  console.error(error);
});
