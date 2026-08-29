// @ts-check
import { config } from '../config.js';
import { navigate } from '../router.js';
import { store } from '../state/store.js';
import { workspaces, getAccess, afterAccessRoute, acceptInvitation } from '../services/access.js';
import { enrollmentAction, enrollmentLinkDetails, enrollmentStatus, isPlatformOwnerAccount } from '../services/enrollment.js';
import { takePendingEnrollment, clearPendingEnrollment, setDemoEnrollmentToken, takePendingInvitation } from '../services/auth.js';
import { escapeHtml, formData } from '../ui/dom.js';
import { page, bindBack, loadingButton, toast } from '../ui/layout.js';

export function businessDetailsScreen(root) {
  root.innerHTML = page({ title: 'Înscrie afacerea', backTo: '/business/workspaces', content: `<form class="form-card" id="business-form">
    <div class="section-heading"><h1>Datele afacerii</h1><p>Afacerea este înregistrată numai după confirmarea e-mailului, verificarea SMS și aprobarea administratorului.</p></div>
    <label>Denumire<input name="name" required minlength="2" maxlength="80"></label>
    <label>Categorie<select name="category"><option>Salon de înfrumusețare</option><option>Frizerie</option><option>Închiriere</option><option>Servicii profesionale</option><option>Altă categorie</option></select></label>
    <label>Adresă<input name="address" required minlength="2" maxlength="160"></label>
    <label>CUI<input name="cui" required maxlength="12" placeholder="RO12345678 sau 12345678"></label>
    <label>E-mail de contact<input name="email" type="email" required maxlength="254" value="${escapeHtml(store.get().user?.email || '')}"></label>
    <label>Telefon mobil<input name="phone" type="tel" required maxlength="16" placeholder="07xxxxxxxx sau +407xxxxxxxx"></label>
    <p class="info-note">Prin continuare soliciți un link de verificare pe e-mail. La pasul următor poți solicita un cod SMS; nu sunt mesaje de marketing.</p>
    <button class="button button--primary" type="submit">Trimite linkul de verificare</button></form>` });
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
  const pending = request.status === 'pending';
  root.innerHTML = page({ title: 'Verificarea afacerii', backTo: '/business/workspaces', content: `<section class="section-heading"><h1>${escapeHtml(request.name)}</h1><p>CUI: ${escapeHtml(request.cui)}</p></section>
    <div class="access-banner"><strong>1. E-mail: ${request.emailVerified ? 'confirmat' : 'în așteptare'}</strong><span>${escapeHtml(request.email)}</span>${pending && !request.emailVerified ? '<button class="button button--secondary" data-action="email">Retrimite linkul</button>' : ''}</div>
    <div class="access-banner"><strong>2. Telefon: ${request.phoneVerified ? 'verificat' : 'în așteptare'}</strong><span>${escapeHtml(request.phone)}</span>
    ${pending && !request.phoneVerified ? `<button class="button button--secondary" data-action="sendSms" ${!request.emailVerified ? 'disabled' : ''}>Trimite cod SMS</button><form class="form-card verification-form" id="sms-form"><label>Cod SMS<input class="verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{4,10}" minlength="4" maxlength="10" placeholder="••••••" aria-describedby="sms-code-hint"><small id="sms-code-hint">Introdu cifrele primite prin SMS</small></label><button class="button button--primary" ${!request.emailVerified ? 'disabled' : ''}>Confirmă telefonul</button></form>` : ''}</div>
    <div class="access-banner"><strong>3. Aprobarea administratorului</strong><span>${{ pending: 'În așteptare', approved: 'Aprobată', rejected: 'Respinsă', expired: 'Cerere expirată', superseded: 'Înlocuită cu o cerere nouă' }[request.status]}</span>
    ${pending ? `<button class="button button--secondary" data-action="approval" ${!request.emailVerified || !request.phoneVerified ? 'disabled' : ''}>Solicită / retrimite aprobarea</button>` : ''}</div>
    <div class="stack"><button class="button button--secondary" id="refresh-verification">Actualizează starea</button>${request.status === 'approved' ? '<button class="button button--primary" id="finish-enrollment">Continuă la abonament și calendar</button>' : '<button class="text-button" data-route="/business/details">Corectează datele · reia verificările</button>'}</div>
    ${config.mode === 'demo' && pending ? `<div class="demo-callout">Simulare locală: niciun e-mail sau SMS nu este trimis. Cod SMS demo: 123456.<div class="stack"><button class="button button--secondary" data-demo-link="RZE-DEMO">Simulează linkul de e-mail</button><button class="button button--secondary" data-demo-link="RZA-DEMO" ${!request.emailVerified || !request.phoneVerified ? 'disabled' : ''}>Simulează linkul administratorului</button></div></div>` : ''}` });
  bindBack(root);
  if (store.get().enrollmentWarning) toast(root, store.get().enrollmentWarning, 'error');
  root.querySelector('#refresh-verification').addEventListener('click', () => verificationScreen(root).catch(e => toast(root, e.message, 'error')));
  const action = async (button, operation, values = {}) => {
    try { loadingButton(button, true); await enrollmentAction(operation, { id: request.id, ...values }); await verificationScreen(root); toast(root, operation === 'checkSms' ? 'Telefon verificat.' : 'Mesaj trimis.'); }
    catch (error) { loadingButton(button, false); toast(root, error.message, 'error'); }
  };
  root.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => action(b, b.getAttribute('data-action'))));
  root.querySelector('#sms-form')?.addEventListener('submit', event => { event.preventDefault(); const f = event.currentTarget; const values = formData(f); f.reset(); action(f.querySelector('button'), 'checkSms', values); });
  root.querySelectorAll('[data-demo-link]').forEach(b => b.addEventListener('click', () => {
    const token = b.getAttribute('data-demo-link');
    setDemoEnrollmentToken(token);
    navigate(token === 'RZA-DEMO' ? '/business/approve' : '/business/code');
  }));
  root.querySelector('#finish-enrollment')?.addEventListener('click', async () => {
    try {
      const business = (await workspaces()).find(b => b.id === request.businessId);
      if (!business) throw new Error('Afacerea nu este încă disponibilă.');
      await store.set({ business });
      navigate((await getAccess(business.id)).active ? await afterAccessRoute() : '/business/plans');
    } catch (error) { toast(root, error.message, 'error'); }
  });
}

export async function enrollmentLinkScreen(root) {
  let token = takePendingEnrollment() || takePendingInvitation();
  root.innerHTML = page({ title: 'Cod primit', backTo: '/business/workspaces', content: `<section class="section-heading"><h1>Am primit un cod</h1><p>Conectat ca ${escapeHtml(store.get().user?.email || '')}. Introdu aici codul de confirmare business sau codul unei invitații în echipă.</p></section><form class="form-card" id="link-form"><label>Cod din e-mail<textarea name="token" rows="3" required autocomplete="off" autocapitalize="characters" spellcheck="false">${escapeHtml(token)}</textarea></label><button class="button button--secondary">Continuă</button></form><div id="link-details"></div><button class="text-button" data-route="/profile">Schimbă contul</button>` });
  bindBack(root);
  const preview = async () => {
    try {
      if (/^RZA-/i.test(token)) throw new Error('Codurile de aprobare se introduc în pagina Aprobă cerere.');
      if (/^RZI-[A-F0-9]{64}$/i.test(token) || (config.mode === 'demo' && token === 'DEMO-INVITATIE')) {
        const box = root.querySelector('#link-details');
        box.innerHTML = '<div class="form-card"><h2>Invitație în echipă</h2><p>Acceptă folosind aceeași adresă Google la care a fost trimis codul.</p><button class="button button--primary" id="accept-link">Acceptă invitația</button></div>';
        box.querySelector('#accept-link').addEventListener('click', async event => {
          const button = event.currentTarget;
          try {
            loadingButton(button, true);
            const result = await acceptInvitation(token);
            if (!result.ok) throw new Error(result.message || 'Invitație indisponibilă.');
            token = '';
            const list = await workspaces();
            await store.set({ business: list.find(b => b.id === result.businessId) });
            navigate('/business/home');
          } catch (error) { loadingButton(button, false); toast(root, error.message || 'Invitație indisponibilă.', 'error'); }
        });
        return;
      }
      const data = await enrollmentLinkDetails(token);
      const box = root.querySelector('#link-details');
      box.innerHTML = `<div class="form-card"><h2>${escapeHtml(data.name)}</h2><p>CUI: ${escapeHtml(data.cui)}<br>E-mail: ${escapeHtml(data.email)}<br>Telefon: ${escapeHtml(data.phone)}</p><button class="button button--primary" id="confirm-link">${data.kind === 'email' ? 'Confirm adresa de e-mail' : 'Aprob înscrierea afacerii'}</button>${data.kind === 'approval' ? '<button class="text-button" id="reject-link">Resping înscrierea</button>' : ''}</div>`;
      const confirm = async approve => {
        try {
          box.querySelectorAll('button').forEach(b => { b.disabled = true; });
          await enrollmentAction('confirm', { token, approve }); token = ''; clearPendingEnrollment();
          box.innerHTML = `<div class="access-banner">${data.kind === 'email' ? 'E-mail confirmat. Continuă verificarea SMS.' : approve ? 'Afacerea a fost aprobată și înregistrată.' : 'Cererea a fost respinsă.'}<button class="button button--secondary" data-route="/business/verification">Vezi starea cererii tale</button></div>`;
          bindBack(box);
        } catch (error) { box.querySelectorAll('button').forEach(b => { b.disabled = false; }); toast(root, error.message, 'error'); }
      };
      box.querySelector('#confirm-link').addEventListener('click', () => confirm(true));
      box.querySelector('#reject-link')?.addEventListener('click', () => confirm(false));
    } catch (error) { toast(root, error.message, 'error'); }
  };
  root.querySelector('#link-form').addEventListener('submit', event => { event.preventDefault(); const field = event.currentTarget.querySelector('textarea'); token = field.value.trim(); field.value = ''; preview(); });
  if (token) { root.querySelector('textarea').value = ''; await preview(); }
}

export async function approvalCodeScreen(root) {
  if (!await isPlatformOwnerAccount()) throw new Error('Acces rezervat ownerului platformei.');
  const pending = takePendingEnrollment();
  const request = config.mode === 'demo' ? await enrollmentStatus() : null;
  const initialCode = pending === 'RZA-DEMO' && request ? `${request.email}/${pending}` : '';
  root.innerHTML = page({ title: 'Aprobă cerere', backTo: '/business/workspaces', content: `<section class="section-heading"><h1>Aprobă o cerere</h1><p>Introdu codul primit pe adresa ownerului. Cererile existente nu sunt listate.</p></section><form class="form-card" id="approval-code-form"><label>Cod email/cod<textarea name="approvalCode" rows="3" required autocomplete="off" spellcheck="false" placeholder="email-business/RZA-…">${escapeHtml(initialCode)}</textarea></label><button class="button button--primary">Verifică cererea</button></form><div id="approval-details"></div>` });
  bindBack(root);
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
  if (initialCode) root.querySelector('#approval-code-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
