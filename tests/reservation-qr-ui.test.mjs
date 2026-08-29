// @ts-check
// Offline native-boundary and screen tests. Hardware/API calls are fake fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('QR service: customer display only, business scan only, cancellation and no arbitrary URL opening', async t => {
  let role='customer', platform='android', cancel=false, nativeValue=''; const calls=[];
  const token='RZB-'+'B'.repeat(64), payload='ro.rezerva.app://reservation?token='+token;
  const fixture={
    Capacitor:{getPlatform:()=>platform}, config:{mode:'live'}, store:{get:()=>({role})},
    rpc:async(name,args)=>{calls.push({name,args});return {ok:true,payload,booking:{id:'booking'}};},
    registerPlugin:name=>{assert.equal(name,'ReservationQr');return {
      render:async options=>{calls.push({name:'render',options});return {dataUrl:'data:image/png;base64,AAAA'};},
      scan:async()=>{calls.push({name:'scan'});return cancel?{cancelled:true}:{value:nativeValue||payload};},
    };},
  };
  globalThis.qrFixture=fixture; t.after(()=>{delete globalThis.qrFixture;});
  const built=await build({entryPoints:['src/services/reservation-qr.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'qr-fixture',setup(builder){
      builder.onResolve({filter:/^@capacitor\/core$|^\.\.\/(config|state\/store)\.js$|^\.\/access\.js$/},()=>({path:'mock',namespace:'mock'}));
      builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {Capacitor,registerPlugin,config,store,rpc}=globalThis.qrFixture;'}));
    },
  }]});
  const api=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
  assert.equal((await api.customerReservationQr('booking')).booking.id,'booking');
  assert.deepEqual(calls[0],{name:'get_customer_booking_qr',args:{p_booking_id:'booking'}});
  await assert.rejects(api.scanReservationQr(),/numai pentru afaceri/);
  await assert.rejects(api.resolveReservationQr(payload),/numai pentru afaceri/);
  role='business'; await assert.rejects(api.customerReservationQr('booking'),/numai în contul de client/);
  assert.equal(await api.scanReservationQr(),token);
  await api.resolveReservationQr(payload,'business');
  assert.deepEqual(calls.at(-1),{name:'resolve_booking_qr',args:{p_token:token,p_business_id:'business'}});
  cancel=true; assert.equal(await api.scanReservationQr(),null); cancel=false;
  nativeValue='https://attacker.example/'; await assert.rejects(api.scanReservationQr(),/nu este un QR/);
  const count=calls.length; await assert.rejects(api.resolveReservationQr(nativeValue),/nu este un QR/);
  assert.equal(calls.length,count);
  platform='web'; await assert.rejects(api.scanReservationQr(),/Android instalată/);
  fixture.config.mode='demo'; await assert.rejects(api.resolveReservationQr(payload),/modul live/);
});

test('QR screens: customers only show QR; business staff see current reservation without mutating it', async t => {
  const token='RZB-'+'C'.repeat(64), actions=[];
  const state={role:'customer',user:{id:'customer'},business:null};
  const booking={id:'booking',businessId:'business',business:'Salon',calendar:'Calendar 1',service:'Manichiură',customer:'<img src=x onerror=alert(1)>',email:'customer@example.invalid',startAt:'2026-09-01T10:00:00Z',endAt:'2026-09-01T10:30:00Z',status:'cancelled'};
  let cancelled=false;
  const fixture={config:{timezone:'Europe/Bucharest',mode:'live'},store:{get:()=>structuredClone(state),set:async patch=>{Object.assign(state,patch);actions.push({name:'store',patch});}},
    workspaces:async()=>[{id:'business',name:'Salon',is_owner:true}],
    customerReservationQr:async()=>{actions.push({name:'show'});return {booking,dataUrl:'data:image/png;base64,AAAA'};},
    scanReservationQr:async()=>{actions.push({name:'scan'});return cancelled?null:token;},
    resolveReservationQr:async(value,businessId)=>{actions.push({name:'resolve',value,businessId});return booking;},
  };
  const built=await build({stdin:{contents:"import {customerQrScreen,businessQrScreen} from './src/screens/reservation-qr.js'; import {rememberReservationQr} from './src/services/qr-session.js'; window.qrApi={customerQrScreen,businessQrScreen,rememberReservationQr};",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',plugins:[{
    name:'qr-ui-fixtures',setup(builder){
      builder.onResolve({filter:/\/config\.js$|\/state\/store\.js$|\/services\/access\.js$|\/services\/reservation-qr\.js$/},()=>({path:'mock',namespace:'mock'}));
      builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {config,store,workspaces,customerReservationQr,scanReservationQr,resolveReservationQr}=window.qrFixture;'}));
    },
  }]});
  const dom=new JSDOM('<div id="app"></div>',{url:'https://localhost/#/customer/booking-qr?booking=booking',runScripts:'outside-only'});
  t.after(()=>dom.window.close()); const w=dom.window,d=w.document,root=d.querySelector('#app');
  w.qrFixture=fixture; w.eval(built.outputFiles[0].text);
  await w.qrApi.customerQrScreen(root);
  assert(d.querySelector('.reservation-qr-image')); assert.equal(d.querySelector('#scan-reservation'),null);
  assert.equal(d.querySelector('#manual-qr-form'),null);
  assert.equal(d.querySelector('[onerror]'),null); assert.match(root.textContent,/Anulată/);
  assert(!root.innerHTML.includes(token));
  await assert.rejects(w.qrApi.businessQrScreen(root),/numai pentru afaceri/);
  state.role='business';state.user.id='owner';
  await assert.rejects(w.qrApi.customerQrScreen(root),/numai în contul de client/);
  await w.qrApi.businessQrScreen(root);
  assert.equal(d.querySelector('.reservation-qr-image'),null);
  async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('QR screen did not settle');}
  d.querySelector('#scan-reservation').click();
  await until(()=>d.querySelector('.qr-result-card'));
  assert.equal(d.querySelector('[onerror]'),null);assert.match(root.textContent,/starea nu a fost schimbată/);
  assert.equal(actions.find(a=>a.name==='resolve').businessId,'business');
  assert.equal(state.business.id,'business'); assert(!JSON.stringify(state).includes(token));
  cancelled=true;d.querySelector('#scan-reservation').click();await until(()=>root.textContent.includes('Scanare anulată'));
  assert.equal(d.querySelector('.qr-result-card'),null,'Old details cleared before the next scan');
  w.qrApi.rememberReservationQr('ro.rezerva.app://reservation?token='+token);
  await w.qrApi.businessQrScreen(root);
  assert.equal(actions.filter(a=>a.name==='resolve').at(-1).businessId,null,'An external link selects only its authorized workspace');
  assert.equal(actions.filter(a=>a.name==='show').length,1,'Business never renders customer QR');
  assert(!w.location.hash.includes(token));
});

test('Android QR wiring: plugin registration, optional camera and pinned native dependencies', async () => {
  const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
  const activity=await read('android/app/src/main/java/ro/rezerva/app/MainActivity.java');
  assert(activity.indexOf('registerPlugin(ReservationQrPlugin.class)')<activity.indexOf('super.onCreate(savedInstanceState)'));
  const manifest=await read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest,/android:host="reservation"/);assert.match(manifest,/android:value="barcode_ui"/);
  assert(!manifest.includes('android.permission.CAMERA'));
  const gradle=await read('android/app/build.gradle');
  assert.match(gradle,/play-services-code-scanner:16\.1\.0/);assert.match(gradle,/com.google.zxing:core:3\.5\.4/);
  const plugin=await read('android/app/src/main/java/ro/rezerva/app/ReservationQrPlugin.java');
  assert.match(plugin,/@CapacitorPlugin\(name = "ReservationQr"\)/);
  assert.match(plugin,/FORMAT_QR_CODE/);assert.match(plugin,/addOnCanceledListener/);
  assert(!plugin.includes('startActivity('));assert(!plugin.includes('Log.'));
});

test('Reservation app link survives Google login in memory and clears on sign-out', async t => {
  const token='RZB-'+'D'.repeat(64), link='ro.rezerva.app://reservation?token='+token;
  const state={user:null,role:null,business:null}, navigation=[];
  const listeners={}; let exchanges=0;
  const originalWindow=globalThis.window;
  globalThis.window={location:{hash:''}};
  const fixture={config:{mode:'live',authRedirectUrl:'ro.rezerva.app://auth/callback'},
    store:{get:()=>structuredClone(state),set:async patch=>Object.assign(state,patch),clear:async()=>{state.user=null;state.business=null;state.role=null;}},
    Capacitor:{isNativePlatform:()=>true},navigate:path=>navigation.push(path),
    Browser:{close:async()=>{}},Preferences:{get:async()=>({value:null}),remove:async()=>{}},
    App:{addListener:async(name,callback)=>{listeners[name]=callback;},getLaunchUrl:async()=>({url:link})},
    getSupabase:()=>({auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>{},
      exchangeCodeForSession:async code=>{assert.equal(code,'offline-code');exchanges++;return {data:{user:{id:'owner',email:'owner@example.invalid',user_metadata:{full_name:'Owner'}}},error:null};},signOut:async()=>{}}}),
  };
  globalThis.qrAuthFixture=fixture;
  t.after(()=>{globalThis.window=originalWindow;delete globalThis.qrAuthFixture;});
  const built=await build({entryPoints:['src/services/auth.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'qr-auth-fixtures',setup(builder){
      builder.onResolve({filter:/^@capacitor\/|^\.\.\/(?:config|api\/supabase|state\/store|router)\.js$/},()=>({path:'mock',namespace:'mock'}));
      builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {App,Browser,Capacitor,Preferences,config,getSupabase,store,navigate}=globalThis.qrAuthFixture;'}));
    },
  }]});
  const auth=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
  await auth.initializeAuth(); assert.equal(navigation.at(-1),'/business/login');
  assert.equal(auth.businessEntryRoute(),'/business/scan'); assert(!JSON.stringify(state).includes(token));
  listeners.appUrlOpen({url:'ro.rezerva.app://auth/callback?code=offline-code'});
  for(let i=0;i<20 && !state.user;i++) await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,5));
  assert.equal(exchanges,1); assert.equal(globalThis.window.location.hash,'/business/scan');
  listeners.appUrlOpen({url:link}); await new Promise(r=>setTimeout(r,5));
  assert.equal(navigation.at(-1),'/business/scan');
  assert.equal(typeof listeners.backButton,'function');
  await auth.signOut(); assert.equal(auth.businessEntryRoute(),'/business/workspaces');
});
