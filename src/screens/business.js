// @ts-check

import { config } from '../config.js';
import { navigate } from '../router.js';
import { signOut } from '../services/auth.js';
import { purchasePlan, restorePurchases, offeringFor } from '../services/billing.js';
import { getAccess, afterAccessRoute, hasBusinessFeature } from '../services/access.js';
import { teamFeatureScreen } from '../ui/plan-gate.js';
import { getNotificationPreference, saveNotificationPreference } from '../services/businesses.js';
import { registerPushNotifications } from '../services/notifications.js';
import { store } from '../state/store.js';
import { formData, reminderLabel } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { bindBack, loadingButton, page, toast } from '../ui/layout.js';

/** @param {HTMLElement} root */
export async function plansScreen(root) {
  const business = store.get().business;
  const access = business ? await getAccess(business.id) : null;
  const selected = access?.active && access.planId === 'large'
    ? 'large'
    : store.get().selectedPlan || access?.planId || 'small';
  if (business?.is_owner === false) {
    root.innerHTML = page({ eyebrow: 'ACCES BLOCAT', title: 'Abonament inactiv', content: `<section class="empty-state"><h1>Planul afacerii nu este activ</h1><p>Doar proprietarul poate activa plata sau licența. Până atunci, toate celelalte ecrane rămân blocate.</p><button class="button button--secondary" id="locked-sign-out">Deconectare</button></section>` });
    root.querySelector('#locked-sign-out')?.addEventListener('click', async () => { await signOut(); navigate('/'); });
    return;
  }
  root.innerHTML = page({
    eyebrow: 'ABONAMENTUL AFACERII', title: 'Alege planul',
    content: `<section class="section-heading"><h1>Un plan pentru fiecare echipă</h1><p>Plătește doar proprietarul. Pe Complete, membrii au automat acces la toate calendarele afacerii.</p></section>
      <div class="plan-grid">
        ${planCard('small', selected)}
        ${planCard('large', selected)}
      </div>
      <button class="button button--primary" id="continue-plan">${store.get().business ? 'Continuă' : 'Continuă la verificarea afacerii'}</button>
      ${config.features.licenseRedemption ? '<button class="button button--secondary" data-route="/business/license">Am o cheie de licență · 5 calendare</button>' : ''}
      <button class="text-button" id="plan-sign-out">Deconectare</button>`,
  });
  bindBack(root, '/business/start');
  root.querySelectorAll('[data-plan]').forEach((node) => node.addEventListener('click', async () => {
    if (access?.active && access.planId === 'large' && node.getAttribute('data-plan') === 'small') {
      toast(root, 'Trecerea de la Complete la Small nu este disponibilă.', 'error');
      return;
    }
    await store.set({ selectedPlan: node.getAttribute('data-plan') });
    await plansScreen(root);
  }));
  root.querySelector('#continue-plan')?.addEventListener('click', async () => {
    await store.set({ selectedPlan: selected });
    try {
      const business = store.get().business;
      if (!business) { navigate('/business/details'); return; }
      const access = await getAccess(business.id);
      navigate(access.active && (access.source === 'license' || access.source === 'developer') ? await afterAccessRoute() : '/business/payment');
    } catch (error) { toast(root, error.message, 'error'); }
  });
  root.querySelector('#plan-sign-out')?.addEventListener('click', async () => { await signOut(); navigate('/'); });
}

/** @param {'small'|'large'} id @param {string} selected */
export function planCard(id, selected) {
  const plan = config.plans[id];
  return `<button class="plan-card ${selected === id ? 'is-selected' : ''}" data-plan="${id}">
    <span class="plan-card__check">${selected === id ? icon('check') : ''}</span>
    <span class="plan-tag">${id === 'small' ? '1 calendar' : '5 calendare'}</span>
    <strong>${plan.name}</strong>
    <span class="plan-price"><b>${config.mode === 'demo' ? plan.price + ' €' : 'Preț în Google Play'}</b>${config.mode === 'demo' ? '/lună' : ''}</span>
    <ul><li>${plan.locations} locație</li><li>${plan.resources === 1 ? '1 calendar' : 'Până la 5 calendare partajate'}</li><li>${plan.resources === 1 ? 'Un singur utilizator · fără Team flow' : 'Până la 15 membri acceptați'}</li><li>Confirmare sau respingere rezervări</li><li>${plan.reports ? 'Rapoarte pe zi, săptămână și lună' : 'Fără rapoarte'}</li><li>${plan.businessNotifications ? 'Notificări push pentru afacere: aprobări și mementouri' : 'Aprobări de programări prin push'}</li></ul>
  </button>`;
}

/** @param {HTMLElement} root */
export async function paymentScreen(root) {
  const state = store.get();
  if (!state.business) { navigate('/business/details'); return; }
  const planId = /** @type {'small'|'large'} */ (state.selectedPlan || 'small');
  const currentAccess = await getAccess(state.business.id);
  if (currentAccess.active && currentAccess.planId === 'large' && planId === 'small') {
    await store.set({ selectedPlan: 'large' });
    navigate('/business/plans');
    return;
  }
  const plan = config.plans[planId];
  root.innerHTML = page({
    eyebrow: 'ABONAMENT', title: 'Activează planul', backTo: '/business/plans',
    content: `<section class="payment-summary">
      <span class="plan-tag">PLAN SELECTAT</span>
      <h1>${plan.name}</h1>
      <div class="payment-price"><strong id="store-price">${config.mode === 'demo' ? plan.price + ' €' : 'Se încarcă prețul…'}</strong><span>pe lună</span></div>
      <div class="summary-row"><span>Reînnoire</span><strong>Lunară</strong></div>
      <div class="summary-row"><span>Anulare</span><strong>Oricând din Google Play</strong></div>
      <p class="info-note">Trecerea de la Small la Complete este imediată. Confirmarea Google Play arată prețul și condițiile finale.</p>
      ${config.mode === 'demo' ? '<div class="demo-callout">Plata reală necesită modul live pe Android. Pentru bypass în demo, introdu cheia de dezvoltare în ecranul Licență.</div>' : ''}
      <button class="button button--play" id="purchase"><span>▶</span> Plătește prin Google Play</button>
      <button class="text-button" id="restore">Restaurează achizițiile</button>
    </section>`,
  });
  bindBack(root, '/business/plans');
  root.querySelector('#purchase')?.addEventListener('click', async (event) => {
    const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
    try {
      loadingButton(button, true, 'Se deschide Google Play…');
      const result = await purchasePlan(planId, state.user?.id || '');
      if (!result.active) throw new Error('Abonamentul nu este activ încă.');
      navigate(await afterAccessRoute());
    } catch (error) {
      loadingButton(button, false);
      toast(root, error instanceof Error ? error.message : 'Plata nu a putut fi finalizată.', 'error');
    }
  });
  root.querySelector('#restore')?.addEventListener('click', async () => {
    try {
      const result = await restorePurchases();
      if (result.active) navigate(await afterAccessRoute());
      else toast(root, 'Nu am găsit un abonament activ.', 'error');
    } catch (error) { toast(root, error.message || 'Restaurarea a eșuat.', 'error'); }
  });
  if (config.mode === 'live') {
    const button = /** @type {HTMLButtonElement} */ (root.querySelector('#purchase'));
    button.disabled = true;
    try { const product = await offeringFor(planId, state.user?.id || ''); root.querySelector('#store-price').textContent = product.product.priceString; button.disabled = false; }
    catch (error) { root.querySelector('#store-price').textContent = 'Preț indisponibil'; toast(root, error.message, 'error'); }
  }
}


/** @param {HTMLElement} root */
/** @param {HTMLElement} root */
export async function businessNotificationsScreen(root) {
  await notificationSettings(root, 'business');
}

/** @param {HTMLElement} root @param {'business'|'customer'} role */
export async function notificationSettings(root, role) {
  if (role === 'business') {
    const access = await getAccess(store.get().business?.id);
    if (!hasBusinessFeature(access, 'businessNotifications')) return teamFeatureScreen(root, 'Notificări', access.isOwner);
  }
  const preference = await getNotificationPreference();
  const selected = preference.minutes;
  root.innerHTML = page({
    eyebrow: 'ALERTE', title: 'Notificări', nav: role, active: 'notifications',
    content: `<section class="notification-hero">${icon('bell')}<div><h1>Nu rata nicio programare</h1><p>${role === 'business' ? 'Primești o alertă înaintea fiecărei programări.' : 'Primești o alertă înaintea programărilor tale.'}</p></div></section>
      <form class="form-card form-card--flat" id="notification-form"><label>Notifică-mă<select name="minutes">${config.reminders.map((minutes) => `<option value="${minutes}" ${selected === minutes ? 'selected' : ''}>${reminderLabel(minutes)}</option>`).join('')}</select></label>
      <label class="switch-row"><span><strong>Notificări push</strong><small>Direct pe acest dispozitiv</small></span><input type="checkbox" name="enabled" ${preference.enabled ? 'checked' : ''}><i></i></label>
      <button class="button button--primary" type="submit">Salvează preferințele</button></form>
      <p class="info-note">Pentru clienți, mementoul se trimite numai pentru programările aprobate de afacere, inclusiv când aplicația este în background sau închisă. Nu trimitem notificări prin e-mail.</p>`,
  });
  bindBack(root);
  root.querySelector('#notification-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const values = formData(/** @type {HTMLFormElement} */ (event.currentTarget));
      if (role === 'business') {
        const access = await getAccess(store.get().business?.id);
        if (!hasBusinessFeature(access, 'businessNotifications')) return teamFeatureScreen(root, 'Notificări', access.isOwner);
      }
      const enabled = values.enabled === 'on';
      await saveNotificationPreference(Number(values.minutes), enabled);
      await store.set({ notificationPreference: Number(values.minutes) });
      const result = enabled ? await registerPushNotifications().catch(() => ({ enabled: false })) : { enabled: false, reason: 'disabled' };
      toast(root, enabled && !result.enabled ? 'Preferința a fost salvată. Permite notificările din setările telefonului.' : 'Preferințele au fost salvate.', enabled && !result.enabled ? 'error' : 'success');
    } catch (error) { toast(root, error.message || 'Preferințele nu au putut fi salvate.', 'error'); }
  });
}
