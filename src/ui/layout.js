// @ts-check

import { config } from '../config.js';
import { navigate, back } from '../router.js';
import { icon } from './icons.js';
import { logo } from './logo.js';

/**
 * @param {{title?:string, eyebrow?:string, content:string, backTo?:string, nav?:'business'|'customer', active?:string, wide?:boolean}} options
 */
export function page(options) {
  return `<div class="app-shell ${options.wide ? 'app-shell--wide' : ''}">
    <header class="topbar">
      ${options.backTo ? `<button class="icon-button" data-back aria-label="Înapoi">${icon('arrow', 'icon--back')}</button>` : logo('compact')}
      <div class="topbar-title">
        ${options.eyebrow ? `<span>${options.eyebrow}</span>` : ''}
        ${options.title ? `<strong>${options.title}</strong>` : ''}
      </div>
      ${options.backTo ? logo('compact') : config.mode === 'demo' ? '<span class="demo-badge">DEMO</span>' : '<span></span>'}
    </header>
    <main class="screen">${options.content}</main>
    ${options.nav ? bottomNavigation(options.nav, options.active || '') : ''}
  </div>`;
}

/** @param {HTMLElement} root @param {string} [fallback] */
export function bindBack(root, fallback = '/') {
  root.querySelector('[data-back]')?.addEventListener('click', () => back(fallback));
  root.querySelectorAll('[data-route]').forEach((node) => {
    node.addEventListener('click', () => navigate(node.getAttribute('data-route') || '/'));
  });
}

/** @param {'business'|'customer'} role @param {string} active */
function bottomNavigation(role, active) {
  const items = role === 'business'
    ? [
        ['home', '/business/home', 'Acasă', 'home'],
        ['calendar', '/business/calendar', 'Calendar', 'calendar'],
        ['reports', '/business/reports', 'Rapoarte', 'chart'],
        ['notifications', '/business/notifications', 'Notificări', 'bell'],
      ]
    : [
        ['search', '/customer/search', 'Caută', 'search'],
        ['bookings', '/customer/bookings', 'Programări', 'calendar'],
        ['notifications', '/customer/notifications', 'Notificări', 'bell'],
        ['profile', '/profile', 'Cont', 'user'],
      ];

  return `<nav class="bottom-nav" aria-label="Navigare principală">
    ${items.map(([id, route, label, iconName]) => `<button class="bottom-nav__item ${active === id ? 'is-active' : ''}" data-route="${route}">${icon(/** @type {any} */ (iconName))}<span>${label}</span></button>`).join('')}
  </nav>`;
}

/** @param {HTMLElement} root @param {string} message @param {'success'|'error'} [type] */
export function toast(root, message, type = 'success') {
  root.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;
  element.textContent = message;
  root.append(element);
  window.setTimeout(() => element.remove(), 3000);
}

export function loadingButton(button, loading, label = 'Se încarcă…') {
  if (!(button instanceof HTMLButtonElement)) return;
  if (loading) {
    button.dataset.originalLabel = button.textContent || '';
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalLabel || button.textContent || '';
  }
}
