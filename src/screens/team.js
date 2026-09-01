// @ts-check
import { config } from '../config.js';
import { store } from '../state/store.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/dom.js';
import { bindBack, page, toast, loadingButton } from '../ui/layout.js';
import { getAccess, redeemLicense, workspaces, calendars, team, addCalendar, inviteMember, acceptInvitation, revokeInvitation, setMemberAccess, afterAccessRoute } from '../services/access.js';
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
    <section class="section-heading"><h1>Ai primit o cheie?</h1><p>Licența include 5 calendare. Licențele obișnuite sunt asociate adresei Google, iar cheia de dezvoltare poate fi folosită de orice cont Google verificat.</p></section>
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
      panel.innerHTML = `<div class="access-banner"><strong>${result.scheduled ? 'Licență înregistrată. Începe la ' + dateLabel(result.startsAt) : 'Licență activată: 5 calendare'}</strong><span>Expiră la ${dateLabel(result.expiresAt)}</span><button class="button button--secondary" data-route="${result.scheduled ? '/business/plans' : await afterAccessRoute()}">Continuă</button></div>`;
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
      await store.set({ business: list.find(b => b.id === result.businessId), inviteFlow: false });
      navigate('/business/home');
    } catch { toast(root, 'Cod invalid.', 'error'); loadingButton(button, false); }
  });
}

const statuses = { sent: 'Trimisă', pending: 'În curs', accepted: 'Acceptată', revoked: 'Revocată', delivery_failed: 'Trimitere eșuată' };

export async function teamScreen(root) {
  const business = store.get().business;
  if (!business) throw new Error('Afacere indisponibilă.');
  const [access, list, roster] = await Promise.all([getAccess(business.id), calendars(business.id), team(business.id)]);
  const isOwner = business.is_owner !== false;
  const teamEnabled = access.active && access.planId === 'large';
  root.innerHTML = page({ title: 'Calendare și echipă', backTo: '/business/home', content: `${accessNotice(access)}
    <div class="section-heading"><h1>Calendarele afacerii</h1><p>${list.filter(c => c.is_active).length} active din ${access.calendarLimit}. Toate calendarele sunt partajate automat cu întreaga echipă.</p></div>
    <div class="stack">${list.map(c => `<div class="team-card" data-calendar="${escapeHtml(c.id)}"><strong>${escapeHtml(c.name)}</strong><span>Activ · partajat cu toată echipa</span></div>`).join('')}</div>
    <form class="form-card" id="add-calendar"><label>Calendar nou<input name="name" required minlength="2" maxlength="80" placeholder="Ex.: Ana · Manichiură"></label><button class="button button--secondary" ${!access.active || access.activeCalendars >= access.calendarLimit ? 'disabled' : ''}>Adaugă calendar</button><p class="info-note">Preia programul săptămânal al primului calendar și este partajat automat cu toată echipa.</p></form>
    ${isOwner?`<section class="section-heading"><h2>Invită pe cineva (adresa de mail)</h2><p>Invitația expiră în 48 de ore. Destinatarul folosește aceeași adresă în Google.</p></section>
    ${teamEnabled ? '' : '<div class="demo-callout">Team flow este disponibil numai cu planul Complete sau cu o licență de 5 calendare. Planul Small este pentru un singur utilizator.</div>'}
    <form class="form-card" id="invite-member"><label>Adresa de mail<input name="email" type="email" inputmode="email" autocomplete="email" placeholder="coleg@gmail.com" required maxlength="254" ${!teamEnabled ? 'disabled' : ''}></label><p class="info-note">Membrul primește acces de editare la toate calendarele actuale și viitoare ale afacerii.</p><button class="button button--primary" ${!teamEnabled ? 'disabled' : ''}>Trimite invitația</button></form>`:''}
    <section class="section-heading"><h2>Membri</h2></section>
    ${roster.members.map(m => `<div class="form-card" data-user="${escapeHtml(m.userId)}"><strong>${escapeHtml(m.email)}</strong><span>${m.role==='owner'?'Proprietar':'Membru · acces de editare la toate calendarele'}</span>${isOwner&&m.role!=='owner'&&m.userId!==store.get().user?.id?`<button class="text-button" type="button" data-remove-member="${escapeHtml(m.userId)}">Elimină accesul</button>`:''}</div>`).join('') || '<p>Nu există membri.</p>'}
    ${isOwner?`<section class="section-heading"><h2>Invitații</h2></section><div class="stack">${roster.invitations.map(i => `<div class="team-card"><strong>${escapeHtml(i.email)}</strong><span>${statuses[i.status] || escapeHtml(i.status)} · expiră ${dateLabel(i.expiresAt)}</span>${!['accepted','revoked'].includes(i.status) ? `<div><button class="text-button" data-resend="${escapeHtml(i.id)}">Retrimite</button><button class="text-button" data-revoke="${escapeHtml(i.id)}">Revocă</button></div>` : ''}</div>`).join('') || '<p>Nicio invitație.</p>'}</div>`:''}
    ${config.mode === 'demo' ? '<p class="demo-callout">Invitațiile sunt simulate. Nu se trimite niciun e-mail.</p>' : ''}` });
  bindBack(root, '/business/home');
  const action = async (button, callback, success = '') => { try { loadingButton(button, true); await callback(); await teamScreen(root); if(success)toast(root,success); } catch (error) { loadingButton(button, false); toast(root, error.message || 'Operația a eșuat.', 'error'); } };
  root.querySelector('#add-calendar')?.addEventListener('submit', e => { e.preventDefault(); const f = e.currentTarget; action(f.querySelector('button'), () => addCalendar(business.id, new FormData(f).get('name'))); });
  root.querySelector('#invite-member')?.addEventListener('submit', e => {
    e.preventDefault(); const f = e.currentTarget; const data = new FormData(f);
    action(f.querySelector('button'), () => inviteMember(business.id, String(data.get('email')).trim().toLowerCase(), 'manager'), 'Invitație trimisă.');
  });
  root.querySelectorAll('[data-remove-member]').forEach(b => b.addEventListener('click', () => action(b, () => setMemberAccess(business.id, b.getAttribute('data-remove-member'), 'viewer', true))));
  root.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', () => action(b, () => revokeInvitation(b.getAttribute('data-revoke')))));
  root.querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', () => { const i = roster.invitations.find(i => i.id === b.getAttribute('data-resend')); action(b, () => inviteMember(business.id, i.email, i.permission)); }));
}
