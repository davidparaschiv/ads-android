// @ts-check

import { config } from '../config.js';
import { navigate } from '../router.js';
import { signInWithGoogle, businessEntryRoute } from '../services/auth.js';
import { icon } from '../ui/icons.js';
import { logo } from '../ui/logo.js';
import { bindBack, loadingButton, page, toast } from '../ui/layout.js';

/** @param {HTMLElement} root */
export function roleScreen(root) {
  root.innerHTML = `<div class="welcome-screen">
    <div class="welcome-glow"></div>
    <section class="welcome-brand">
      ${logo('full')}
      <p>Programări simple. Timp câștigat.</p>
    </section>
    <section class="role-grid" aria-label="Selectează tipul contului">
      <button class="role-card" data-role="customer">
        <span class="role-card__icon">${icon('user')}</span>
        <span><strong>Sunt client</strong><small>Caută și rezervă rapid</small></span>
        ${icon('arrow')}
      </button>
      <button class="role-card role-card--accent" data-role="business">
        <span class="role-card__icon">${icon('calendar')}</span>
        <span><strong>Reprezint o afacere</strong><small>Organizează toate programările</small></span>
        ${icon('arrow')}
      </button>
    </section>
    <p class="welcome-note">O singură aplicație pentru clienți și afaceri.</p>
  </div>`;
  root.querySelectorAll('[data-role]').forEach((node) => node.addEventListener('click', () => {
    const role = node.getAttribute('data-role');
    navigate(role === 'business' ? '/business/login' : '/customer/login');
  }));
}

/** @param {HTMLElement} root @param {'business'|'customer'} role */
export function loginScreen(root, role) {
  const isBusiness = role === 'business';
  root.innerHTML = page({
    title: 'Autentificare',
    eyebrow: isBusiness ? 'PENTRU AFACERI' : 'PENTRU CLIENȚI',
    backTo: '/',
    content: `<section class="auth-card">
      <div class="auth-illustration">${icon(isBusiness ? 'calendar' : 'user')}</div>
      <h1>${isBusiness ? 'Administrare fără haos' : 'Programarea ta, în câteva secunde'}</h1>
      <p>${isBusiness ? 'Configurează serviciile, programul și notificările într-un singur loc.' : 'Folosește contul Google pentru a-ți păstra programările sincronizate.'}</p>
      <button class="button button--google" id="google-login"><span class="google-g">G</span> Continuă cu Google</button>
      <p class="fine-print">Continuând, accepți termenii și politica de confidențialitate.</p>
    </section>`,
  });
  bindBack(root);
  root.querySelector('#google-login')?.addEventListener('click', async (event) => {
    const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
    try {
      loadingButton(button, true, 'Se conectează…');
      const result = await signInWithGoogle(role);
      if (result.demo) navigate(isBusiness ? businessEntryRoute() : '/customer/search');
    } catch (error) {
      loadingButton(button, false);
      toast(root, error instanceof Error ? error.message : 'Autentificarea a eșuat.', 'error');
    }
  });
}

/** @param {HTMLElement} root */
export function configurationScreen(root) {
  root.innerHTML = page({
    title: 'Configurare necesară',
    backTo: '/',
    content: `<section class="empty-state">
      ${icon('settings')}
      <h1>Serviciile nu sunt configurate</h1>
      <p>Copiază <code>.env.example</code> în <code>.env</code>, completează cheile și setează <code>VITE_APP_MODE=live</code>.</p>
      <button class="button" data-route="/">Înapoi la început</button>
    </section>`,
  });
  bindBack(root);
}

export function versionLabel() {
  return `${config.appName} · versiunea demo`;
}
