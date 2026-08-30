// @ts-check
import { config } from '../config.js';
import { navigate } from '../router.js';
import { currentRoute } from '../router.js';
import { signOut } from '../services/auth.js';
import { store } from '../state/store.js';
import { workspaces, getAccess, afterAccessRoute } from '../services/access.js';
import { enrollmentAction, enrollmentLinkDetails, enrollmentStatus, isPlatformOwnerAccount } from '../services/enrollment.js';
import { escapeHtml, formData } from '../ui/dom.js';
import { page, bindBack, loadingButton, toast } from '../ui/layout.js';

export function businessDetailsScreen(root) {
  root.innerHTML = page({ title: 'Înscrie afacerea', backTo: '/', content: `<form class="form-card" id="business-form">
    <div class="section-heading"><h1>Datele afacerii</h1><p>Afacerea este înregistrată numai după confirmarea e-mailului, verificarea SMS și aprobarea administratorului.</p></div>
    <label>Denumire<input name="name" required minlength="2" maxlength="80"></label>
    <label>Categorie<select name="category"><option>Salon de înfrumusețare</option><option>Frizerie</option><option>Închiriere</option><option>Servicii profesionale</option><option>Altă categorie</option></select></label>
    <label>Adresă<input name="address" required minlength="2" maxlength="160"></label>
    <label>CUI<input name="cui" required maxlength="12" placeholder="RO12345678 sau 12345678"></label>
    <label>E-mail de contact<input name="email" type="email" required maxlength="254" value="${escapeHtml(store.get().user?.email || '')}"></label>
    <label>Telefon mobil<input name="phone" type="tel" required maxlength="16" placeholder="07xxxxxxxx sau +407xxxxxxxx"></label>
    <p class="info-note">Prin continuare soliciți un cod de confirmare pe e-mail. La pasul următor poți solicita un cod SMS; nu sunt mesaje de marketing.</p>
    <button class="button button--primary" type="submit">Trimite codul de confirmare</button></form>` });
  bindBack(root);
  root.querySelector('#business-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button');
    try {
      loadingButton(button, true);
      const result = await enrollmentAction('start', formData(form));
      await store.set({ enrollmentWarning: result.warning || '' });
      navigate('/business/verification');
    } catch (error) { loadingButton(button, false); toast(root, error.message, 'error'); }
  });
}

export async function verificationScreen(root) {
  const request = await enrollmentStatus();
  if (!request) { navigate('/business/details'); return; }
  if (request.status === 'approved') {
    try {
      const business = (await workspaces()).find(b => b.id === request.businessId);
      if (!business) throw new Error('Afacerea aprobată nu este încă disponibilă.');
      await store.set({ business });
      navigate((await getAccess(business.id)).active ? await afterAccessRoute() : '/business/plans');
    } catch (error) { toast(root, error.message, 'error'); }
    return;
  }
  const pending = request.status === 'pending';
  root.innerHTML = page({ title: 'Verificarea afacerii', content: `<section class="section-heading"><h1>${escapeHtml(request.name)}</h1><p>CUI: ${escapeHtml(request.cui)}</p></section>
    <div class="access-banner"><strong>1. E-mail: ${request.emailVerified ? 'confirmat' : 'în așteptare'}</strong><span>${escapeHtml(request.email)}</span>${pending && !request.emailVerified ? `<form class="form-card email-code-form" id="email-code-form"><label>Cod confirmare e-mail<textarea name="token" rows="3" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="RZE-…"></textarea></label><button class="button button--primary">Confirmă e-mailul</button></form><button class="button button--secondary" data-action="email">Retrimite codul</button>` : ''}</div>
    <div class="access-banner"><strong>2. Telefon: ${request.phoneVerified ? 'verificat' : 'în așteptare'}</strong><span>${escapeHtml(request.phone)}</span>
    ${pending && !request.phoneVerified ? `<button class="button button--secondary" data-action="sendSms" ${!request.emailVerified ? 'disabled' : ''}>Trimite cod SMS</button><form class="form-card verification-form" id="sms-form"><label>Cod SMS<input class="verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{4,10}" minlength="4" maxlength="10" placeholder="••••••" aria-describedby="sms-code-hint"><small id="sms-code-hint">Introdu cifrele primite prin SMS</small></label><button class="button button--primary" ${!request.emailVerified ? 'disabled' : ''}>Confirmă telefonul</button></form>` : ''}</div>
    <div class="access-banner"><strong>3. Aprobarea administratorului</strong><span>${{ pending: request.phoneVerified ? 'Cererea a fost trimisă automat · în așteptare' : 'Se trimite automat după verificarea telefonului', rejected: 'Respinsă', expired: 'Cerere expirată', superseded: 'Înlocuită cu o cerere nouă' }[request.status]}</span></div>
    ${config.mode === 'demo' && pending ? '<div class="demo-callout">Simulare locală: cod e-mail <code>RZE-DEMO</code>, cod SMS <code>123456</code>. Ambele se introduc manual în câmpurile de mai sus.</div>' : ''}` });
  bindBack(root);
  if (store.get().enrollmentWarning) toast(root, store.get().enrollmentWarning, 'error');
  const action = async (button, operation, values = {}) => {
    try { loadingButton(button, true); await enrollmentAction(operation, { id: request.id, ...values }); await verificationScreen(root); toast(root, operation === 'checkSms' ? 'Telefon verificat.' : 'Mesaj trimis.'); }
    catch (error) { loadingButton(button, false); toast(root, error.message, 'error'); }
  };
  root.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => action(b, b.getAttribute('data-action'))));
  root.querySelector('#email-code-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button'), field = form.querySelector('textarea');
    const token = field.value.trim(); field.value = '';
    try {
      loadingButton(button, true);
      await enrollmentAction('confirm', { token, approve: true });
      await verificationScreen(root);
      toast(root, 'E-mail confirmat.');
    } catch (error) { loadingButton(button, false); toast(root, error.message || 'Cod de confirmare invalid.', 'error'); }
  });
  root.querySelector('#sms-form')?.addEventListener('submit', event => { event.preventDefault(); const f = event.currentTarget; const values = formData(f); f.reset(); action(f.querySelector('button'), 'checkSms', values); });
  if (pending && request.phoneVerified) window.setTimeout(() => {
    if (currentRoute().path === '/business/verification') verificationScreen(root).catch(error => toast(root, error.message, 'error'));
  }, 5000);
}

export async function approvalCodeScreen(root) {
  if (!await isPlatformOwnerAccount()) throw new Error('Acces rezervat ownerului platformei.');
  const request = config.mode === 'demo' ? await enrollmentStatus() : null;
  root.innerHTML = page({ title: 'Verificări', ...(store.get().business ? { nav: 'business', active: 'profile' } : {}), content: `<section class="section-heading"><h1>Verificări business</h1><p>Introdu manual codul primit pe adresa administratorului. Cererile existente nu sunt listate.</p></section><form class="form-card" id="approval-code-form"><label>Cod email/cod<textarea name="approvalCode" rows="3" required autocomplete="off" spellcheck="false" placeholder="email-business/RZA-…"></textarea></label><button class="button button--primary">Verifică cererea</button></form>${request ? `<p class="demo-callout">Cod admin demo: <code>${escapeHtml(request.email)}/RZA-DEMO</code></p>` : ''}<div id="approval-details"></div><button class="text-button" id="approval-sign-out">Deconectare</button>` });
  bindBack(root);
  root.querySelector('#approval-sign-out')?.addEventListener('click', async () => { await signOut(); navigate('/'); });
  root.querySelector('#approval-code-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button'), field = form.querySelector('textarea');
    const composite = field.value.trim(); field.value = '';
    const separator = composite.lastIndexOf('/');
    const email = composite.slice(0, separator).trim().toLowerCase();
    const token = composite.slice(separator + 1).trim();
    try {
      if (separator < 1 || !(/^RZA-[A-F0-9]{64}$/i.test(token) || config.mode === 'demo' && token === 'RZA-DEMO')) throw new Error('Cod de aprobare invalid. Folosește formatul email-business/cod.');
      loadingButton(button, true);
      const data = await enrollmentLinkDetails(token);
      if (data.kind !== 'approval' || String(data.email).toLowerCase() !== email) throw new Error('Cod de aprobare invalid.');
      const box = root.querySelector('#approval-details');
      box.innerHTML = `<div class="form-card"><h2>${escapeHtml(data.name)}</h2><p>CUI: ${escapeHtml(data.cui)}<br>E-mail: ${escapeHtml(data.email)}<br>Telefon: ${escapeHtml(data.phone)}</p><button class="button button--primary" id="approve-request">Aprobă cererea</button><button class="text-button" id="reject-request">Respinge cererea</button></div>`;
      const decide = async approve => {
        box.querySelectorAll('button').forEach(control => { control.disabled = true; });
        try {
          await enrollmentAction('confirm', { token, approve });
          box.innerHTML = `<div class="access-banner">${approve ? 'Afacerea a fost aprobată și înregistrată.' : 'Cererea a fost respinsă.'}</div>`;
        } catch (error) { box.querySelectorAll('button').forEach(control => { control.disabled = false; }); toast(root, error.message, 'error'); }
      };
      box.querySelector('#approve-request').addEventListener('click', () => decide(true));
      box.querySelector('#reject-request').addEventListener('click', () => decide(false));
    } catch (error) { toast(root, error.message || 'Cod de aprobare invalid.', 'error'); }
    finally { loadingButton(button, false); }
  });
}
