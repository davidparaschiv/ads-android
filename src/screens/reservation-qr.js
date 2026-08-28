// @ts-check
import { config } from '../config.js';
import { store } from '../state/store.js';
import { workspaces } from '../services/access.js';
import { customerReservationQr, resolveReservationQr, scanReservationQr } from '../services/reservation-qr.js';
import { takePendingReservationQr } from '../services/qr-session.js';
import { escapeHtml } from '../ui/dom.js';
import { page, bindBack, loadingButton } from '../ui/layout.js';
import { icon } from '../ui/icons.js';

const statuses = { confirmed: 'Confirmată', pending: 'În așteptare', cancelled: 'Anulată', completed: 'Finalizată', no_show: 'Absent' };
const dateTime = value => new Intl.DateTimeFormat('ro-RO', { dateStyle: 'full', timeStyle: 'short', timeZone: config.timezone }).format(new Date(value));
const errorText = error => error instanceof Error ? error.message : 'Operația nu a reușit. Verifică internetul și reîncearcă.';

function details(booking, businessView = false) {
  return `<div class="qr-reservation-details">
    <span class="status">${escapeHtml(statuses[booking.status] || 'Stare necunoscută')}</span>
    <h2>${escapeHtml(booking.business)}</h2><p>${escapeHtml(booking.service)}</p>
    <dl><dt>Programare</dt><dd>${escapeHtml(dateTime(booking.startAt))}</dd>
    <dt>Până la</dt><dd>${escapeHtml(dateTime(booking.endAt))}</dd>
    <dt>Calendar</dt><dd>${escapeHtml(booking.calendar)}</dd>
    <dt>Client</dt><dd>${escapeHtml(booking.customer)}</dd>
    ${businessView ? `<dt>E-mail</dt><dd>${escapeHtml(booking.email)}</dd>` : ''}</dl>
    ${booking.status !== 'confirmed' ? '<p class="qr-status-warning">Această programare nu este în starea „Confirmată”. Verifică starea, data și ora înainte de a presta serviciul.</p>' : ''}
  </div>`;
}

export async function customerQrScreen(root) {
  if (store.get().role !== 'customer') throw new Error('QR-ul este afișat numai în contul de client.');
  const bookingId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('booking');
  if (!bookingId) throw new Error('Selectează o programare din lista ta.');
  root.innerHTML = page({ title: 'QR-ul programării', eyebrow: 'PREZINTĂ LA SOSIRE', backTo: '/customer/bookings',
    content: '<section class="form-card qr-customer-card"><p>Arată acest cod personalului afacerii. Nu ai nevoie să scanezi nimic.</p><div id="customer-qr-content" aria-live="polite"><p>Se încarcă programarea…</p></div><button id="reload-qr" class="button button--secondary">Reîncarcă QR-ul</button></section>' });
  bindBack(root, '/customer/bookings');
  const content = root.querySelector('#customer-qr-content');
  const button = root.querySelector('#reload-qr');
  const userId = store.get().user?.id;
  const load = async () => {
    loadingButton(button, true);
    content.textContent = 'Se încarcă programarea…';
    try {
      const result = await customerReservationQr(bookingId);
      if (!content.isConnected || store.get().user?.id !== userId || store.get().role !== 'customer') return;
      content.innerHTML = `<img class="reservation-qr-image" src="${escapeHtml(result.dataUrl)}" alt="Cod QR unic pentru această programare" width="768" height="768">${details(result.booking)}<p class="info-note">Codul identifică programarea; numai personalul autorizat poate vedea detaliile după scanare.</p>`;
    } catch (error) { if (content.isConnected) content.textContent = errorText(error); }
    finally { loadingButton(button, false); }
  };
  button.addEventListener('click', load);
  await load();
}

export async function businessQrScreen(root) {
  if (store.get().role !== 'business') throw new Error('Scanarea este disponibilă numai pentru afaceri.');
  const incoming = takePendingReservationQr();
  const userId = store.get().user?.id;
  const list = await workspaces();
  if (!list.length) throw new Error('Nu ai acces la calendarele unei afaceri. Acceptă mai întâi invitația sau finalizează înscrierea.');
  const current = list.find(b => b.id === store.get().business?.id);
  root.innerHTML = page({ title: 'Scanează programarea', eyebrow: 'PENTRU AFACERI', backTo: current ? '/business/home' : '/business/workspaces',
    content: `<section class="form-card"><p>Scanează QR-ul afișat de client. Detaliile sunt verificate pe server; programarea nu este modificată.</p>
      <label>Afacere<select id="qr-workspace">${list.map(b => `<option value="${escapeHtml(b.id)}" ${current?.id === b.id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}</select></label>
      <button class="button button--primary" id="scan-reservation">${icon('qr')} Scanează QR-ul clientului</button>
      <p class="info-note">La prima scanare poate fi necesară descărcarea modulului Google. Ai nevoie de internet pentru verificarea programării.</p>
      <details><summary>Nu poți scana?</summary><form id="manual-qr-form"><label>Cod sau link din QR<textarea id="manual-qr-value" maxlength="200" rows="3" required autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label><button class="button button--secondary" type="submit">Deschide programarea</button></form></details>
      <div id="qr-scan-result" aria-live="polite"></div></section>` });
  bindBack(root, current ? '/business/home' : '/business/workspaces');
  const result = root.querySelector('#qr-scan-result');
  const scan = root.querySelector('#scan-reservation');
  const select = /** @type {HTMLSelectElement} */ (root.querySelector('#qr-workspace'));
  const manual = /** @type {HTMLFormElement} */ (root.querySelector('#manual-qr-form'));
  const manualButton = manual.querySelector('button');
  let busy = false;
  let sequence = 0;
  const stillHere = () => result.isConnected && store.get().user?.id === userId && store.get().role === 'business';
  const run = async (readValue, fromLink = false) => {
    if (busy) return;
    busy = true; const ticket = ++sequence;
    const businessId = fromLink ? null : select.value;
    result.textContent = ''; select.disabled = true;
    loadingButton(scan, true, 'Se verifică…'); loadingButton(manualButton, true);
    try {
      const value = await readValue();
      if (!stillHere() || ticket !== sequence) return;
      if (value === null) { result.textContent = 'Scanare anulată.'; return; }
      const booking = await resolveReservationQr(value, businessId);
      if (!stillHere() || ticket !== sequence) return;
      const workspace = list.find(b => b.id === booking.businessId);
      if (!workspace) throw new Error('Programare inaccesibilă pentru acest cont.');
      // Raw QR never goes into preferences, URL hash, logs or browser navigation.
      select.value = workspace.id;
      await store.set({ business: workspace });
      if (!stillHere() || ticket !== sequence) return;
      result.innerHTML = `<section class="qr-result-card"><p class="info-note">Date actualizate de pe server. Doar consultare — starea nu a fost schimbată.</p>${details(booking, true)}</section>`;
    } catch (error) { if (stillHere() && ticket === sequence) result.textContent = errorText(error); }
    finally { busy = false; select.disabled = false; loadingButton(scan, false); loadingButton(manualButton, false); }
  };
  select.addEventListener('change', () => { sequence++; result.textContent = ''; });
  scan.addEventListener('click', () => run(scanReservationQr));
  manual.addEventListener('submit', event => {
    event.preventDefault();
    const field = /** @type {HTMLTextAreaElement} */ (root.querySelector('#manual-qr-value'));
    const value = field.value; field.value = '';
    void run(async () => value);
  });
  if (incoming) await run(async () => incoming, true);
}
