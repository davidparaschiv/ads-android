// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('Romanian demo: license, five calendars, invites, reports and staff without payment', async t => {
  const bundled = await build({
    stdin: { contents: "import {startApp} from './src/app.js'; import {store} from './src/state/store.js'; import {navigate} from './src/router.js'; import {purchasePlan,restorePurchases} from './src/services/billing.js'; window.testApi={store,navigate,purchasePlan,restorePurchases}; startApp();", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' },
  });
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window; const d = w.document;
  w.structuredClone = structuredClone; w.scrollTo = () => {};
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.eval(bundled.outputFiles[0].text);
  async function until(check) {
    for (let i=0;i<100;i++) { if (check()) return; await new Promise(r => setTimeout(r,20)); }
    throw new Error('Screen did not become ready: ' + d.body.textContent.slice(0,1000));
  }
  const click = selector => { const element = d.querySelector(selector); assert.ok(element, selector); element.click(); };
  const submit = selector => d.querySelector(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const text = () => d.body.textContent;
  await until(() => d.querySelector('[data-role="business"]'));
  click('[data-role="business"]'); await until(() => d.querySelector('#google-login')); click('#google-login');
  await until(() => d.querySelector('#new-business'));
  assert.equal(d.querySelectorAll('[data-route="/business/invite"]').length,1);
  assert.equal(d.querySelectorAll('[data-route="/business/enrollment-link"]').length,1);
  click('[data-home]'); await until(() => d.querySelector('#new-business'));
  click('#new-business');
  await until(() => d.querySelector('[data-plan="large"]'));
  assert.equal(d.querySelector('[data-route="/business/invite"]'),null);
  assert.ok(d.querySelector('[data-home]'));
  assert.match(text(), /50 €/); assert.match(text(), /150 €/);
  assert.match(d.querySelector('[data-plan="small"]').textContent, /Small/);
  assert.match(d.querySelector('[data-plan="small"]').textContent, /Fără rapoarte/);
  assert.match(d.querySelector('[data-plan="large"]').textContent, /Complete/);
  assert.match(d.querySelector('[data-plan="large"]').textContent, /Notificări push pentru afacere/);
  await assert.rejects(w.testApi.purchasePlan('small','demo-business-user'),/Plata se testează/);
  await assert.rejects(w.testApi.restorePurchases(),/Restaurarea/);
  assert.equal(w.testApi.store.get().demoAccess,null);
  click('#continue-plan'); await until(() => d.querySelector('#business-form'));
  assert.equal(w.testApi.store.get().demoAccess,null);
  w.testApi.navigate('/business/plans'); await until(() => d.querySelector('[data-route="/business/license"]'));
  click('[data-route="/business/license"]'); await until(() => d.querySelector('#license-form'));
  d.querySelector('[name="key"]').value = 'dev112233'; submit('#license-form');
  await until(() => text().includes('Licență activată: 5 calendare'));
  assert.equal(d.querySelector('[name="key"]').value, '');
  assert.ok(!w.localStorage.getItem('CapacitorStorage.rezerva.app.state.v1')?.includes('dev112233'));
  click('#license-result [data-route]'); await until(() => d.querySelector('#business-form'));
  d.querySelector('[name="name"]').value = 'Salon Demo'; d.querySelector('[name="address"]').value = 'București';
  d.querySelector('[name="cui"]').value='12345678'; d.querySelector('[name="phone"]').value='0712345678'; submit('#business-form');
  await until(() => d.querySelector('[data-demo-link="RZE-DEMO"]'));
  assert.equal(w.testApi.store.get().business,null);
  click('[data-demo-link="RZE-DEMO"]'); await until(() => d.querySelector('#confirm-link')); click('#confirm-link');
  await until(() => text().includes('E-mail confirmat.')); click('[data-route="/business/verification"]');
  await until(() => d.querySelector('#sms-form')); d.querySelector('[name="code"]').value='123456'; submit('#sms-form');
  await until(() => d.querySelector('[data-demo-link="RZA-DEMO"]')?.disabled === false);
  assert.equal(w.testApi.store.get().business,null);
  click('[data-demo-link="RZA-DEMO"]'); await until(() => d.querySelector('#confirm-link')); click('#confirm-link');
  await until(() => text().includes('Afacerea a fost aprobată')); click('[data-route="/business/verification"]');
  await until(() => d.querySelector('#finish-enrollment')); click('#finish-enrollment');
  await until(() => d.querySelector('#schedule-form')); submit('#schedule-form');
  await until(() => d.querySelector('[data-route="/business/team"]')); click('[data-route="/business/team"]');
  await until(() => d.querySelector('#add-calendar'));
  for (let i=2;i<=5;i++) {
    d.querySelector('#add-calendar [name="name"]').value = 'Calendar ' + i; submit('#add-calendar');
    await until(() => d.querySelectorAll('[data-toggle-calendar]').length === i);
  }
  assert.equal(d.querySelector('#add-calendar button').disabled,true);
  d.querySelector('#invite-member [name="email"]').value = 'colleague@example.com';
  d.querySelector('#invite-member [name="calendar"]').checked = true; submit('#invite-member');
  await until(() => d.querySelector('[data-revoke]'));
  click('[data-revoke]'); await until(() => text().includes('Revocată'));
  w.testApi.navigate('/business/reports'); await until(() => d.querySelector('[data-period="month"]'));
  click('[data-period="month"]'); await until(() => d.querySelector('[data-period="month"]').classList.contains('is-active'));
  w.testApi.navigate('/business/invite'); await until(() => d.querySelector('#accept-invite'));
  d.querySelector('[name="token"]').value = 'DEMO-INVITATIE'; submit('#accept-invite');
  await until(() => text().includes('Abonamentul este administrat de proprietar'));
  assert.equal(d.querySelector('[data-route="/business/team"]'),null);
  assert.equal(d.querySelector('#purchase'),null);
  w.testApi.navigate('/business/team'); await until(() => text().includes('Afaceri și invitații'));
  // Simulate server entitlements in the local demo fixture, not a new app bypass.
  await w.testApi.store.set({demoAccess:{source:'demo',calendarLimit:1,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  w.testApi.navigate('/business/reports'); await until(() => d.querySelector('[data-plan-gate]'));
  assert.equal(d.querySelector('[data-period]'),null);
  assert.match(text(),/Contactează proprietarul/);
  w.testApi.navigate('/business/notifications'); await until(() => d.querySelector('[data-plan-gate]') && text().includes('Notificări'));
  assert.equal(d.querySelector('#notification-form'),null);
  w.testApi.navigate('/business/home'); await until(() => text().includes('Programările de astăzi'));
  assert.equal(d.querySelector('.dashboard-hero'),null);
  w.testApi.navigate('/business/calendar'); await until(() => d.querySelector('#calendar-date'));
  w.testApi.navigate('/customer/notifications'); await until(() => d.querySelector('#notification-form'));
  await w.testApi.store.set({demoAccess:{source:'demo',calendarLimit:5,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  w.testApi.navigate('/business/notifications'); await until(() => d.querySelector('#notification-form') && text().includes('fiecărei programări'));
  submit('#notification-form'); await until(() => d.querySelector('.toast'));
  assert.match(d.querySelector('.toast').textContent,/salvat/);
  await w.testApi.store.set({demoAccess:{source:'demo',calendarLimit:1,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  submit('#notification-form'); await until(() => d.querySelector('[data-plan-gate]'));
  await w.testApi.store.set({business:{...w.testApi.store.get().business,is_owner:true},demoAccess:{source:'developer',calendarLimit:5,expiresAt:new Date(Date.now()-1000).toISOString()}});
  w.testApi.navigate('/business/reports'); await until(() => d.querySelector('[data-plan-gate]') && d.querySelector('[data-route="/business/plans"]'));
  // Only customer mode exposes the reservation QR, and demo never invents a live QR.
  await w.testApi.store.set({role:'customer'});
  w.testApi.navigate('/customer/bookings'); await until(() => d.querySelector('[aria-label="Arată QR-ul programării"]'));
  assert.equal(d.querySelector('[data-route="/business/scan"]'),null);
  click('[aria-label="Arată QR-ul programării"]');
  await until(() => d.querySelector('#customer-qr-content')?.textContent.includes('modul live'));
  assert.equal(d.querySelector('#scan-reservation'),null);
});
