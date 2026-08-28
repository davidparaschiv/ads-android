// @ts-check

import { config } from '../config.js';
import { demoBusinesses, demoBookings, futureDateIso } from '../data.js';
import { navigate } from '../router.js';
import { availableSlots, createBooking, listCustomerBookings } from '../services/bookings.js';
import { getBusiness, listBusinesses } from '../services/businesses.js';
import { registerPushNotifications } from '../services/notifications.js';
import { store } from '../state/store.js';
import { escapeHtml, formData, formatDate, reminderLabel } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { bindBack, loadingButton, page, toast } from '../ui/layout.js';

/** @param {HTMLElement} root */
export async function customerSearchScreen(root) {
  const businesses = await listBusinesses();
  root.innerHTML = page({
    eyebrow: 'BUN VENIT', title: escapeHtml(store.get().user?.name || 'Client'), nav: 'customer', active: 'search',
    content: `<section class="search-hero"><h1>Unde vrei să te programezi?</h1><label class="search-box">${icon('search')}<input id="company-search" type="search" autocomplete="off" placeholder="Caută o afacere"></label></section>
      <section class="list-section"><div class="section-row"><h2>Afaceri disponibile</h2><span class="muted">București</span></div><div id="business-list">${businessCards(businesses)}</div></section>`,
  });
  bindBack(root);
  root.querySelector('#company-search')?.addEventListener('input', async (event) => {
    const query = /** @type {HTMLInputElement} */ (event.currentTarget).value.trim().toLocaleLowerCase('ro');
    const filtered = await listBusinesses(query).catch(() => businesses.filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase('ro').includes(query)));
    const list = root.querySelector('#business-list');
    if (list) list.innerHTML = filtered.length ? businessCards(filtered) : '<div class="empty-inline">Nu am găsit nicio afacere.</div>';
    bindCompanyLinks(root);
  });
  bindCompanyLinks(root);
}

/** @param {typeof demoBusinesses} businesses */
function businessCards(businesses) {
  return businesses.map((business) => `<button class="business-card" data-company="${business.id}"><span class="company-avatar">${escapeHtml(business.initials)}</span><span><strong>${escapeHtml(business.name)}</strong><small>${escapeHtml(business.category)}</small><small>${escapeHtml(business.address)}</small></span>${icon('arrow')}</button>`).join('');
}

/** @param {HTMLElement} root */
function bindCompanyLinks(root) {
  root.querySelectorAll('[data-company]').forEach((node) => node.addEventListener('click', async () => {
    const selectedBusinessId = node.getAttribute('data-company');
    await store.set({ selectedBusinessId });
    navigate('/customer/company');
  }));
}

/** @param {HTMLElement} root */
export async function companyScreen(root) {
  const id = store.get().selectedBusinessId || demoBusinesses[0].id;
  const business = await getBusiness(id);
  root.innerHTML = page({
    title: escapeHtml(business.name), eyebrow: escapeHtml(business.category.toUpperCase()), backTo: '/customer/search',
    content: `<section class="company-header"><span class="company-avatar company-avatar--large">${escapeHtml(business.initials)}</span><div><h1>${escapeHtml(business.name)}</h1><p>${escapeHtml(business.address)}</p></div></section>
      <section class="list-section"><h2>Alege serviciul</h2>${business.services.map((service) => `<button class="service-card" data-service="${service.id}"><span><strong>${escapeHtml(service.name)}</strong><small>${service.duration} minute</small></span><b>${service.price} lei</b>${icon('arrow')}</button>`).join('')}</section>`,
  });
  bindBack(root, '/customer/search');
  root.querySelectorAll('[data-service]').forEach((node) => node.addEventListener('click', () => {
    const serviceId = node.getAttribute('data-service');
    navigate(`/customer/book?service=${serviceId}`);
  }));
}

/** @param {HTMLElement} root */
export async function bookingScreen(root) {
  const state = store.get();
  const selectedId = state.selectedBusinessId || demoBusinesses[0].id;
  const business = await getBusiness(selectedId);
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const service = business.services.find((item) => item.id === query.get('service')) || business.services[0];
  if (!service) throw new Error('Afacerea nu are încă servicii disponibile.');
  const resources = config.mode === 'demo' ? [{ id: 'demo-calendar-1', name: 'Calendar principal' }] : business.resources;
  const date = futureDateIso(1);
  root.innerHTML = page({
    eyebrow: 'PROGRAMARE NOUĂ', title: escapeHtml(service.name), backTo: '/customer/company',
    content: `<form class="form-card" id="booking-form">
      <div class="booking-summary"><span class="company-avatar">${escapeHtml(business.initials)}</span><div><strong>${escapeHtml(business.name)}</strong><small>${escapeHtml(service.name)} · ${service.duration} min</small></div><b>${service.price} lei</b></div>
      <label>Calendar<select name="resourceId" required>${resources.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select></label>
      <label>Data<input name="date" type="date" min="${futureDateIso(0)}" value="${date}" required></label>
      <label>Ora disponibilă<select name="startAt" required><option value="">Se încarcă…</option></select></label><p class="info-note" id="slot-note">Orele sunt afișate pentru București.</p>
      <label>Numele pentru programare<input name="customerName" value="${escapeHtml(state.user?.name || '')}" maxlength="80" required></label>
      <label>E-mail din contul Google<input value="${escapeHtml(state.user?.email || '')}" disabled><small>E-mailul nu poate fi modificat aici.</small></label>
      <label>Notifică-mă<select name="reminderMinutes">${config.reminders.map((minutes) => `<option value="${minutes}" ${state.notificationPreference === minutes ? 'selected' : ''}>${reminderLabel(minutes)}</option>`).join('')}</select></label>
      <button class="button button--primary" type="submit">Confirmă programarea</button>
    </form>`,
  });
  bindBack(root, '/customer/company');
  let requestId = 0;
  const loadSlots = async () => {
    const thisRequest = ++requestId;
    const form = /** @type {HTMLFormElement} */ (root.querySelector('#booking-form'));
    const values = formData(form);
    const select = /** @type {HTMLSelectElement} */ (form.querySelector('[name="startAt"]'));
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
    select.innerHTML = '<option value="">Se încarcă…</option>'; button.disabled = true;
    try {
      if (!values.resourceId || !values.date) return;
      const slots = await availableSlots(business.id, String(values.resourceId), service.id, String(values.date));
      if (thisRequest !== requestId) return;
      select.innerHTML = slots.length ? slots.map(slot => `<option value="${escapeHtml(slot.start_at)}">${new Intl.DateTimeFormat('ro-RO', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(slot.start_at))}</option>`).join('') : '<option value="">Nicio oră disponibilă</option>';
      button.disabled = !slots.length;
    } catch { select.innerHTML = '<option value="">Nu putem încărca disponibilitatea</option>'; }
  };
  root.querySelector('[name="date"]')?.addEventListener('change', loadSlots);
  root.querySelector('[name="resourceId"]')?.addEventListener('change', loadSlots);
  await loadSlots();
  root.querySelector('#booking-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = /** @type {HTMLButtonElement} */ (root.querySelector('button[type="submit"]'));
    const values = formData(/** @type {HTMLFormElement} */ (event.currentTarget));
    try {
      loadingButton(button, true, 'Se confirmă…');
      await createBooking({
        businessId: business.id,
        eventTypeId: service.id,
        resourceId: String(values.resourceId),
        startAt: String(values.startAt),
        customerName: String(values.customerName),
        reminderMinutes: Number(values.reminderMinutes),
      });
      await store.set({ notificationPreference: Number(values.reminderMinutes) });
      await registerPushNotifications().catch(() => ({ enabled: false }));
      navigate('/customer/booking-success');
    } catch (error) {
      loadingButton(button, false);
      toast(root, error instanceof Error ? error.message : 'Programarea nu a putut fi creată.', 'error');
    }
  });
}

/** @param {HTMLElement} root */
export function bookingSuccessScreen(root) {
  root.innerHTML = page({
    content: `<section class="success-screen"><div class="success-ring">${icon('check')}</div><span class="plan-tag">PROGRAMARE CONFIRMATĂ</span><h1>Totul este pregătit</h1><p>Vei primi o notificare în aplicație înainte de programare.</p><button class="button button--primary" data-route="/customer/bookings">Vezi programările mele</button><button class="text-button" data-route="/customer/search">Înapoi la căutare</button></section>`,
  });
  bindBack(root);
}

/** @param {HTMLElement} root */
export async function customerBookingsScreen(root) {
  const liveBookings = await listCustomerBookings();
  const future = config.mode === 'demo' ? [
    { ...demoBookings[0], date: futureDateIso(1), time: '09:00' },
    { ...demoBookings[1], business: 'Barber Eleven', service: 'Tuns', date: futureDateIso(5), time: '16:30' },
  ] : liveBookings;
  root.innerHTML = page({
    eyebrow: 'CONTUL MEU', title: 'Programările mele', nav: 'customer', active: 'bookings',
    content: `<div class="segmented"><button class="is-active">Viitoare</button><button>Istoric</button></div><section class="appointment-list">${future.map((booking) => `<article class="appointment-card"><div class="appointment-date"><strong>${new Date(`${booking.date}T12:00:00`).getDate()}</strong><span>${new Intl.DateTimeFormat('ro-RO',{month:'short'}).format(new Date(`${booking.date}T12:00:00`))}</span></div><div><small>${formatDate(booking.date)} · ${booking.time}</small><strong>${escapeHtml(booking.business)}</strong><span>${escapeHtml(booking.service)}</span></div><button class="icon-button" aria-label="Detalii">${icon('arrow')}</button></article>`).join('')}</section>`,
  });
  if (store.get().role === 'customer') {
    root.querySelectorAll('.appointment-card').forEach((card, index) => {
      const button = card.querySelector('button');
      if (!button) return;
      button.setAttribute('data-route', `/customer/booking-qr?booking=${encodeURIComponent(future[index].id)}`);
      button.setAttribute('aria-label', 'Arată QR-ul programării');
      button.innerHTML = icon('qr');
    });
  }
  bindBack(root);
}
