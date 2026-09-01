// @ts-check

import { config } from '../config.js';
import { navigate, back } from '../router.js';
import { icon } from './icons.js';
import { logo } from './logo.js';
import { store } from '../state/store.js';

/**
 * @param {{title?:string, eyebrow?:string, content:string, backTo?:string, nav?:'business'|'customer', active?:string, wide?:boolean}} options
 */
export function page(options) {
  // Navigation is opt-in: pre-enrolment BV and incomplete-profile CV screens
  // must never expose destinations the account cannot use yet.
  const persistentNav = options.nav || null;
  const shellClasses = [
    'app-shell',
    options.wide ? 'app-shell--wide' : '',
    persistentNav ? 'app-shell--with-nav' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${shellClasses}">
    <header class="topbar">
      ${options.backTo ? `<button class="icon-button" data-back aria-label="Înapoi">${icon('arrow', 'icon--back')}</button>` : logo('compact')}
      <div class="topbar-title">
        ${options.eyebrow ? `<span>${options.eyebrow}</span>` : ''}
        ${options.title ? `<strong>${options.title}</strong>` : ''}
      </div>
      ${options.backTo ? logo('compact') : config.mode === 'demo' ? '<span class="demo-badge">DEMO</span>' : '<span></span>'}
    </header>
    <main class="screen">${options.content}</main>
    ${persistentNav ? bottomNavigation(persistentNav, options.active || '') : ''}
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
        ['home', '/business/home', 'Home', 'home'],
        ['calendar', '/business/calendar', 'Cal.', 'calendar'],
        ['notifications', '/business/notifications', 'Notif.', 'bell'],
        ['profile', '/profile', 'Cont', 'user'],
      ]
    : [
        ['search', '/customer/search', 'Home', 'home'],
        ['bookings', '/customer/bookings', 'Progr. mele', 'calendar'],
        ['notifications', '/customer/notifications', 'Notif.', 'bell'],
        ['profile', '/profile', 'Cont', 'user'],
      ];

  const hasPendingRequests = role === 'business' && Number(store.get().businessPendingCount || 0) > 0;
  return `<nav class="bottom-nav bottom-nav--${role}" aria-label="Navigare principală">
    ${items.map(([id, route, label, iconName]) => `<button class="bottom-nav__item ${active === id ? 'is-active' : ''}" data-route="${route}">${icon(/** @type {any} */ (iconName))}${id === 'notifications' && hasPendingRequests ? '<span class="notification-dot" aria-label="Există cereri de programare în așteptare"></span>' : ''}<span>${label}</span></button>`).join('')}
  </nav>`;
}

/** @param {HTMLElement} root @param {string} message @param {'success'|'error'} [type] */
export function toast(root, message, type = 'success') {
  const documentRoot = root.ownerDocument || document;
  documentRoot.querySelector('.app-message-layer--toast')?.remove();
  const layer = documentRoot.createElement('div');
  layer.className = 'app-message-layer app-message-layer--toast';
  layer.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  const element = documentRoot.createElement('div');
  element.className = `toast toast--${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.textContent = message;
  layer.append(element);
  documentRoot.body.append(layer);
  window.setTimeout(() => layer.remove(), 3000);
}

/**
 * Native-like confirmation dialog centered in the usable viewport.
 * @param {string} message
 * @param {{confirmLabel?:string,cancelLabel?:string,dangerous?:boolean,hideCancel?:boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, options = {}) {
  const existing = document.querySelector('.popup-layer');
  if (existing) existing.dispatchEvent(new CustomEvent('app:dialog-close'));

  const layer = document.createElement('div');
  layer.className = 'popup-layer';
  const dialog = document.createElement('section');
  dialog.className = 'popup';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'app-popup-message');

  const text = document.createElement('p');
  text.id = 'app-popup-message';
  text.className = 'popup__message';
  text.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'popup__actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button--secondary popup__button';
  cancel.textContent = options.cancelLabel || 'Renunță';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = `button popup__button ${options.dangerous === false ? 'button--primary' : 'button--danger'}`;
  confirm.textContent = options.confirmLabel || 'Confirmă';
  if (options.hideCancel) actions.classList.add('popup__actions--single');
  actions.append(...(options.hideCancel ? [confirm] : [cancel, confirm]));
  dialog.append(text, actions);
  layer.append(dialog);

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.documentElement.classList.add('has-open-popup');
  document.body.append(layer);

  return new Promise(resolve => {
    let settled = false;
    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      layer.remove();
      document.documentElement.classList.remove('has-open-popup');
      previousFocus?.focus();
      resolve(value);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape' || event.key === 'Backspace') close(false);
    };
    layer.addEventListener('app:dialog-close', () => close(false), { once: true });
    layer.addEventListener('click', event => {
      if (event.target === layer) close(false);
    });
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKeyDown);
    confirm.focus();
  });
}

/** @param {string} message @param {string} [buttonLabel] */
export async function alertDialog(message, buttonLabel = 'În regulă') {
  await confirmDialog(message, { confirmLabel: buttonLabel, dangerous: false, hideCancel: true });
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
