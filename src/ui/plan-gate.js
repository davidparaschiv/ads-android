// @ts-check
import { page, bindBack } from './layout.js';

export function teamFeatureScreen(root, feature, isOwner) {
  root.innerHTML = page({
    title: feature, eyebrow: 'PLANUL COMPLETE', nav: 'business',
    active: feature === 'Rapoarte' ? 'reports' : 'notifications',
    content: `<section class="form-card" data-plan-gate><h1>Disponibil cu planul Complete</h1>
      <p>Planul Small include 1 calendar și gestionarea rezervărilor, fără rapoarte și notificări pentru afacere.</p>
      <p>Planul Complete include 5 calendare, rapoarte și notificări push pentru afacere.</p>
      ${isOwner ? '<button class="button button--primary" data-route="/business/plans">Vezi abonamentele</button>' : '<p>Contactează proprietarul afacerii pentru activarea planului Echipă.</p>'}
      <button class="button button--secondary" data-route="/business/calendar">Înapoi la calendar</button></section>`,
  });
  bindBack(root);
}
