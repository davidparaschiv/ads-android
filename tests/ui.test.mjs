// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('Hand-drawn BV and CV screens keep separate navigation and exact controls',async t=>{
  const bundled=await build({stdin:{contents:"import {startApp} from './src/app.js';import {store} from './src/state/store.js';import {navigate} from './src/router.js';window.testApi={store,navigate};startApp();",resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife',define:{'import.meta.env':'{}'}});
  const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document;w.structuredClone=structuredClone;w.scrollTo=()=>{};w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.eval(bundled.outputFiles[0].text);
  async function until(check){for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Screen timeout: '+d.body.textContent.slice(0,500));}
  const click=selector=>{const node=d.querySelector(selector);assert.ok(node,selector);node.click();};
  await until(()=>d.querySelectorAll('[data-role]').length===3);assert.ok(d.querySelector('[data-role="invite"]'));
  click('[data-role="business"]');await until(()=>d.querySelector('#google-login'));click('#google-login');await until(()=>d.querySelector('#business-form'));
  assert.equal(d.querySelectorAll('.bottom-nav__item').length,0);
  assert.equal(d.querySelector('[data-route="/business/invite"]'),null);
  await w.testApi.store.set({business:{id:'atelier-luna',name:'Atelier Luna',is_owner:true},demoAccess:{source:'developer',calendarLimit:5,expiresAt:null},demoCalendars:[{id:'demo-calendar-1',name:'Manichiură semipermanentă',is_active:true},{id:'demo-calendar-2',name:'Pedichiură',is_active:true}]});
  w.testApi.navigate('/business/home');await until(()=>d.querySelector('.draw-chart'));assert.match(d.body.textContent,/Scanează codul QR/);assert.match(d.body.textContent,/Invitații/);assert.equal(d.querySelectorAll('.bottom-nav__item').length,4);
  w.testApi.navigate('/business/calendar');await until(()=>d.querySelector('#calendar-add'));assert.equal(d.querySelectorAll('[data-calendar-view]').length,2);click('[data-calendar-view]');await until(()=>d.querySelector('.weekday-tabs'));assert.ok(d.querySelector('.draw-fab'));
  click('.draw-fab');await until(()=>d.querySelector('#event-settings'));assert.equal(d.querySelector('textarea[name="name"]'),null);assert.equal(d.querySelectorAll('[name="duration"] option').length,11);assert.equal(d.querySelectorAll('.weekday-tabs input').length,7);assert.ok(d.querySelector('[name="startTime"]'));assert.ok(d.querySelector('[name="endTime"]'));
  w.testApi.navigate('/business/notifications');await until(()=>d.querySelector('#notification-calendar'));assert.ok(d.querySelector('[data-status="confirmed"]'));assert.ok(d.querySelector('[data-status="rejected"]'));
  w.testApi.navigate('/profile');await until(()=>d.querySelector('[data-plan="small"]'));assert.ok(d.querySelector('[data-plan="large"]'));assert.match(d.body.textContent,/Termeni și condiții/);assert.match(d.body.textContent,/Politica de confidențialitate/);
  w.testApi.navigate('/business/plans');await until(()=>d.querySelector('[data-plan="large"].is-selected'));click('[data-plan="small"]');assert.ok(d.querySelector('[data-plan="large"].is-selected'));
  await w.testApi.store.set({demoAccess:{source:'demo',calendarLimit:5,expiresAt:new Date(Date.now()-60000).toISOString()}});w.testApi.navigate('/business/home');await until(()=>d.body.textContent.includes('Alege planul'));assert.equal(d.querySelector('.draw-chart'),null);assert.equal(d.querySelectorAll('.bottom-nav__item').length,0);
  await w.testApi.store.set({role:'customer',customerProfileComplete:true,selectedBusinessId:null});w.testApi.navigate('/customer/search');await until(()=>d.querySelector('#company-search'));assert.equal(d.querySelectorAll('.bottom-nav__item').length,3);
  const search=/** @type {HTMLInputElement} */(d.querySelector('#company-search'));search.value='Bar';search.dispatchEvent(new w.Event('input',{bubbles:true}));await until(()=>d.querySelectorAll('[data-company]').length===1);assert.match(d.body.textContent,/Barber Eleven/);search.value='leven';search.dispatchEvent(new w.Event('input',{bubbles:true}));await until(()=>d.querySelectorAll('[data-company]').length===0);
  search.value='At';search.dispatchEvent(new w.Event('input',{bubbles:true}));await until(()=>d.querySelector('[data-company]'));click('[data-company]');await until(()=>d.querySelector('#service-select'));assert.equal(d.querySelectorAll('#service-select').length,1);assert.ok(d.querySelector('#service-duration[readonly]'));
  w.testApi.navigate('/customer/bookings');await until(()=>d.querySelector('[data-booking-qr]'));assert.match(d.body.textContent,/Atelier Luna/);assert.equal(d.querySelectorAll('.bottom-nav__item').length,3);
});
