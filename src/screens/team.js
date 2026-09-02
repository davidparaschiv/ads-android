// @ts-check
import { config } from '../config.js';
import { store } from '../state/store.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/dom.js';
import { bindBack, page, toast, loadingButton } from '../ui/layout.js';
import { getAccess, redeemLicense, workspaces, acceptInvitation, afterAccessRoute } from '../services/access.js';
import { signOut, takePendingInvitation } from '../services/auth.js';

const dateLabel = value => value === 'infinity' || value === null ? 'Fără expirare' : value ? new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timezone }).format(new Date(value)) : '—';

export function accessNotice(access) {
  if (!access.active) return `<div class="demo-callout">Abonament sau licență inactivă. Accesul afacerii este blocat până la activarea unui plan. ${access.isOwner ? '<button class="text-button" data-route="/business/plans">Activează un plan</button>' : 'Contactează proprietarul.'}</div>`;
  return `<div class="access-banner"><strong>${access.calendarLimit} ${access.calendarLimit === 1 ? 'calendar' : 'calendare'} · ${access.source === 'license' ? 'Licență' : 'Abonament'}</strong><span>Valabil până la ${dateLabel(access.expiresAt)}</span>${access.overLimit ? '<p>Planul curent nu acoperă toate calendarele. Activează planul Complete pentru a relua programările noi.</p>' : ''}</div>`;
}

export async function licenseScreen(root) {
  if (!config.features.licenseRedemption) { navigate('/business/plans'); return; }
  const business = store.get().business;
  if (business?.is_owner === false) throw new Error('Doar proprietarul activează abonamentul.');
  const access = await getAccess(business?.id || null);
  root.innerHTML = page({ title: 'Activează o licență', backTo: '/business/plans', content: `${accessNotice(access)}
    <section class="section-heading"><h1>Ai primit o cheie?</h1><p>Licența Complete include 10 calendare, iar half_complete include 5. Licențele obișnuite sunt asociate adresei Google, iar cheia de dezvoltare poate fi folosită de orice cont Google verificat.</p></section>
    <form class="form-card" id="license-form"><label>Cheie de licență<textarea name="key" required maxlength="100" rows="3" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RZL-…"></textarea></label>
    <button class="button button--primary" type="submit">Verifică și activează</button></form>
    <p class="info-note">Valabilitatea începe la data stabilită de administrator, nu la introducerea cheii. Cheia nu generează o taxare automată. Dacă ai deja un abonament Google Play, acesta continuă să se reînnoiască până îl anulezi din Google Play.</p>
    ${config.mode === 'demo' ? '<div class="demo-callout">Cheie de dezvoltare: <code>dev112233</code>. Poate fi folosită de orice cont Google verificat și nu sare peste verificarea înscrierii.</div>' : ''}
    <div id="license-result" aria-live="polite"></div>` });
  bindBack(root, '/business/plans');
  root.querySelector('#license-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const field = form.querySelector('textarea');
    let key = field.value;
    field.value = '';
    try {
      loadingButton(button, true, 'Se verifică pe server…');
      const result = await redeemLicense(key);
      if (!result.ok) throw new Error(result.message || 'Licență invalidă.');
      const panel = root.querySelector('#license-result');
      panel.innerHTML = `<div class="access-banner"><strong>${result.scheduled ? 'Licență înregistrată. Începe la ' + dateLabel(result.startsAt) : `Licență activată: ${result.calendarLimit || result.access?.calendarLimit} calendare`}</strong><span>Expiră la ${dateLabel(result.expiresAt)}</span><button class="button button--secondary" data-route="${result.scheduled ? '/business/plans' : await afterAccessRoute()}">Continuă</button></div>`;
      bindBack(panel);
    } catch (error) { toast(root, error.message || 'Licență invalidă.', 'error'); }
    finally { key = ''; loadingButton(button, false); }
  });
}

export function invitationScreen(root) {
  const token = takePendingInvitation();
  root.innerHTML = page({ title: 'Team flow', backTo: '/business/start', content: `<section class="section-heading"><h1>Am cod de invitație</h1><p>Conectat ca ${escapeHtml(store.get().user?.email || '')}. Aceasta trebuie să fie adresa invitată. Nu ai nevoie de abonament personal.</p></section>
    <form class="form-card" id="accept-invite"><label>Cod din e-mail<textarea name="token" rows="3" required maxlength="100" autocomplete="off" spellcheck="false">${escapeHtml(token || '')}</textarea></label><button class="button button--primary" type="submit">Acceptă invitația</button></form>
    ${config.mode === 'demo' ? '<p class="demo-callout">Simulare: DEMO-INVITATIE. În demo nu se trimit e-mailuri.</p>' : ''}<button class="text-button" id="invite-sign-out">Deconectare</button>` });
  bindBack(root, '/business/start');
  root.querySelector('#invite-sign-out')?.addEventListener('click', async () => { await signOut(); navigate('/'); });
  root.querySelector('#accept-invite')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const field = form.querySelector('textarea');
    try {
      loadingButton(button, true);
      const value = field.value; field.value = '';
      const result = await acceptInvitation(value);
      if (!result.ok) throw new Error(result.message);
      const list = await workspaces();
      await store.set({ business: list.find(b => b.id === result.businessId), requestedAccountType: 'invitee', inviteFlow: false });
      navigate('/business/home');
    } catch { toast(root, 'Cod invalid.', 'error'); loadingButton(button, false); }
  });
}
