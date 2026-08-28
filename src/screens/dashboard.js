// @ts-check
import { config } from '../config.js';
import { store } from '../state/store.js';
import { demoBookings, todayIso } from '../data.js';
import { listBusinessBookings, listBusinessReport } from '../services/businesses.js';
import { calendars, getAccess, rpc, hasBusinessFeature } from '../services/access.js';
import { teamFeatureScreen } from '../ui/plan-gate.js';
import { escapeHtml, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { page, bindBack, toast, loadingButton } from '../ui/layout.js';
import { accessNotice } from './team.js';

export async function businessHomeScreen(root) {
  const business = store.get().business;
  const [access, bookings] = await Promise.all([getAccess(business.id), listBusinessBookings(business.id, '', todayIso(), todayIso())]);
  root.innerHTML = page({
    eyebrow: formatDate(todayIso()).toUpperCase(), title: escapeHtml(business.name), nav: 'business', active: 'home',
    content: `${accessNotice(access)}${hasBusinessFeature(access, 'reports') ? `<section class="dashboard-hero"><div><span>Astăzi</span><strong>${bookings.filter(b => b.status === 'confirmed').length}</strong><small>programări confirmate</small></div><div class="hero-orbit">${icon('calendar')}</div></section>` : ''}
      <div class="stack">${access.isOwner ? '<button class="button button--secondary" data-route="/business/team">Calendare și echipă</button><button class="text-button" data-route="/business/plans">Abonament și licență</button>' : '<p class="info-note">Vezi numai calendarele alocate. Abonamentul este administrat de proprietar.</p>'}
      ${store.get().role === 'business' ? `<button class="button button--primary" data-route="/business/scan">${icon('qr')} Scanează programarea</button>` : ''}
      <button class="text-button" data-route="/business/workspaces">Schimbă afacerea · invitații · cont</button></div>
      <section class="list-section"><h2>Programările de astăzi</h2>${bookings.length ? bookings.map(bookingRow).join('') : '<p>Nu există programări astăzi.</p>'}</section>`,
  });
  bindBack(root);
}

const statusLabels = { confirmed: 'Confirmată', pending: 'În așteptare', cancelled: 'Anulată', completed: 'Finalizată', no_show: 'Absent' };
function bookingRow(booking) {
  return `<article class="timeline-item"><time>${escapeHtml(booking.time)}</time><span class="timeline-dot"></span><div><strong>${escapeHtml(booking.customer)}</strong><small>${escapeHtml(booking.service)}</small><small>${escapeHtml(booking.email)}</small><small>${escapeHtml(booking.date)}</small></div><span class="status">${statusLabels[booking.status] || ''}</span></article>`;
}

function calendarFilter(list, selected) {
  return `<label>Calendar<select id="calendar-filter"><option value="">Toate calendarele alocate</option>${list.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)}${c.is_active ? '' : ' (arhivat)'}</option>`).join('')}</select></label>`;
}

export async function businessCalendarScreen(root, date = todayIso(), calendarId = '') {
  const business = store.get().business;
  const [list, access, bookings] = await Promise.all([calendars(business.id), getAccess(business.id), listBusinessBookings(business.id, calendarId, date, date)]);
  const manageIds = [];
  for (const c of list) {
    const canManage = config.mode === 'demo' ? business.is_owner : await rpc('can_manage_calendar', { p_calendar: c.id });
    if (canManage) manageIds.push(c.id);
  }
  root.innerHTML = page({
    eyebrow: 'PROGRAMĂRI', title: 'Calendar zilnic', nav: 'business', active: 'calendar',
    content: `${accessNotice(access)}<div class="form-card">${calendarFilter(list, calendarId)}<label>Ziua<input type="date" id="calendar-date" value="${escapeHtml(date)}" required></label></div>
    <section class="list-section">${bookings.map(b => `<div>${bookingRow(b)}${manageIds.includes(b.calendarId) && ['confirmed','pending'].includes(b.status) ? `<div class="booking-actions"><button class="text-button" data-status="completed" data-booking="${escapeHtml(b.id)}" ${!access.active ? 'disabled' : ''}>Finalizată</button><button class="text-button" data-status="no_show" data-booking="${escapeHtml(b.id)}" ${!access.active ? 'disabled' : ''}>Absent</button><button class="text-button" data-status="cancelled" data-booking="${escapeHtml(b.id)}">Anulează</button></div>` : ''}</div>`).join('') || '<p>Nu există programări pentru această selecție.</p>'}</section>`,
  });
  bindBack(root);
  const refresh = async () => {
    try { const value = root.querySelector('#calendar-date').value; if (value) await businessCalendarScreen(root, value, root.querySelector('#calendar-filter').value); }
    catch (error) { toast(root, error.message, 'error'); }
  };
  root.querySelector('#calendar-date')?.addEventListener('change', refresh);
  root.querySelector('#calendar-filter')?.addEventListener('change', refresh);
  root.querySelectorAll('[data-booking]').forEach(button => button.addEventListener('click', async () => {
    try {
      loadingButton(button, true);
      const id = button.getAttribute('data-booking'), status = button.getAttribute('data-status');
      if (config.mode === 'demo') { const booking = demoBookings.find(b => b.id === id); if (booking) booking.status = status; }
      else await rpc('set_booking_status', { p_booking_id: id, p_status: status });
      await businessCalendarScreen(root, date, calendarId);
    } catch (error) { loadingButton(button, false); toast(root, error.message, 'error'); }
  }));
}

function periodBounds(date, period) {
  const start = new Date(date + 'T12:00:00Z');
  const end = new Date(start);
  if (period === 'week') { start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7); end.setTime(start.getTime()); end.setUTCDate(end.getUTCDate() + 6); }
  if (period === 'month') { start.setUTCDate(1); end.setUTCMonth(start.getUTCMonth() + 1, 0); }
  return [start.toISOString().slice(0,10), end.toISOString().slice(0,10)];
}

export async function reportsScreen(root, period = 'week', date = todayIso(), calendarId = '') {
  const business = store.get().business;
  const access = await getAccess(business.id);
  if (!hasBusinessFeature(access, 'reports')) return teamFeatureScreen(root, 'Rapoarte', access.isOwner);
  const [from, until] = periodBounds(date, period);
  const [list, bookings] = await Promise.all([calendars(business.id), listBusinessReport(business.id, calendarId, from, until)]);
  root.innerHTML = page({
    eyebrow: 'PROGRAMĂRI ȘI CLIENȚI', title: 'Rapoarte', nav: 'business', active: 'reports',
    content: `<div class="form-card">${calendarFilter(list, calendarId)}<label>Data de referință<input type="date" id="report-date" value="${escapeHtml(date)}" required></label></div>
    <div class="segmented">${[['day','Zi'],['week','Săptămână'],['month','Lună']].map(([id,label]) => `<button data-period="${id}" class="${period === id ? 'is-active' : ''}">${label}</button>`).join('')}</div>
    <p class="info-note">${escapeHtml(from)} — ${escapeHtml(until)} · numai calendarele alocate</p>
    <section class="metrics-grid"><article><span>Total programări</span><strong>${bookings.length}</strong></article><article><span>Finalizate</span><strong>${bookings.filter(b => b.status === 'completed').length}</strong></article><article><span>Anulate</span><strong>${bookings.filter(b => b.status === 'cancelled').length}</strong></article><article><span>Confirmate</span><strong>${bookings.filter(b => b.status === 'confirmed').length}</strong></article></section>
    <section class="list-section"><h2>Lista programărilor</h2>${bookings.length ? bookings.map(bookingRow).join('') : '<p>Nu există programări în această perioadă.</p>'}</section>`,
  });
  bindBack(root);
  const refresh = async next => {
    try { const value = root.querySelector('#report-date').value; if (value) await reportsScreen(root, typeof next === 'string' ? next : period, value, root.querySelector('#calendar-filter').value); }
    catch (error) { toast(root, error.message, 'error'); }
  };
  root.querySelector('#calendar-filter')?.addEventListener('change', refresh);
  root.querySelector('#report-date')?.addEventListener('change', refresh);
  root.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => refresh(b.getAttribute('data-period'))));
}
