// @ts-check

import { config } from '../config.js';
import { navigate } from '../router.js';
import { signOut } from '../services/auth.js';
import { store } from '../state/store.js';
import { escapeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { bindBack, page } from '../ui/layout.js';

/** @param {HTMLElement} root */
export function profileScreen(root) {
  const user = store.get().user;
  root.innerHTML = page({
    eyebrow: 'SETĂRI', title: 'Contul meu', nav: store.get().role === 'business' ? 'business' : 'customer', active: 'profile',
    content: `<section class="profile-card"><span class="profile-avatar">${escapeHtml((user?.name || 'U').slice(0,1))}</span><div><strong>${escapeHtml(user?.name || 'Utilizator')}</strong><span>${escapeHtml(user?.email || '')}</span></div></section>
      <section class="settings-list"><a href="${config.links.privacy}" target="_blank" rel="noreferrer">Politica de confidențialitate ${icon('arrow')}</a><a href="${config.links.support}" target="_blank" rel="noreferrer">Ajutor și suport ${icon('arrow')}</a><a href="${config.links.deleteAccount}" target="_blank" rel="noreferrer">Ștergerea contului ${icon('arrow')}</a></section>
      <button class="button button--secondary" id="sign-out">Deconectare</button>`,
  });
  bindBack(root);
  root.querySelector('#sign-out')?.addEventListener('click', async () => {
    await signOut();
    navigate('/');
  });
}
