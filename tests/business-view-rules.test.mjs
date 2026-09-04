// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

function installDom(url = 'https://localhost/') {
  const dom = new JSDOM('<div id="app"></div>', { url });
  for (const name of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLFormElement','HTMLButtonElement','Event','CustomEvent']) globalThis[name] = dom.window[name];
  return dom;
}

test('Business notifications render the booking date and offer personal calendar opt-out first', async t => {
  const dom = installDom('https://localhost/#/business/notifications?calendar=calendar');
  t.after(() => dom.window.close());
  globalThis.businessViewFixture = {
    config:{mode:'live'},
    store:{get:()=>({business:{id:'business'}}),set:async()=>{}},
    calendars:async()=>[{id:'calendar',name:'Calendar principal'}], rpc:async()=>{},
    listPendingBookingRequests:async()=>[{id:'booking',customer:'Ana',service:'Manichiură',date:'2026-09-01',time:'09:00',endTime:'09:20'}],
    getCalendarNotificationMinutes:async()=>-1, setCalendarNotificationMinutes:async()=>{},
  };
  t.after(() => { delete globalThis.businessViewFixture; });
  const output = await build({entryPoints:['src/screens/notifications.js'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
    name:'business-notification-fixture',setup(builder){
      builder.onResolve({filter:/config\.js$|state\/store\.js$|services\/(access|businesses)\.js$/},()=>({path:'fixture',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const {config,store,calendars,rpc,listPendingBookingRequests,getCalendarNotificationMinutes,setCalendarNotificationMinutes}=globalThis.businessViewFixture;'}));
    },
  }]});
  const screen=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
  const root=dom.window.document.querySelector('#app');await screen.notificationsScreen(root,'business');
  assert.match(root.textContent,/1 sept\./);assert.match(root.textContent,/09:00-09:20/);
  const options=root.querySelectorAll('#calendar-reminder select[name="minutes"] option');
  assert.equal(options[0].value,'-1');assert.equal(options[0].textContent,'Oprit');assert.equal(options[0].selected,true);
});

test('Business report chart and calendar request approved bookings only', async t => {
  const dom=installDom('https://localhost/#/business/home');t.after(()=>dom.window.close());
  const calls=[];
  globalThis.businessDashboardFixture={
    config:{mode:'live'},
    store:{get:()=>({business:{id:'business',is_owner:true}})},
    listBusinessBookings:async(...args)=>{calls.push(args);return[];},
    getCalendarServiceSettings:async()=>({weekdays:[]}),saveCalendarServiceSettings:async()=>{},
    calendars:async()=>[{id:'calendar',name:'Calendar'}],addCalendar:async()=>({id:'calendar'}),deleteCalendar:async()=>{},
    getAccess:async()=>({planId:'small'}),inviteMember:async()=>{},team:async()=>({members:[]}),deleteInviteeAccount:async()=>{},calendarInviteePermissions:async()=>[],setCalendarInviteePermission:async()=>{},navigate:()=>{},back:()=>{},
  };
  t.after(()=>{delete globalThis.businessDashboardFixture;});
  const output=await build({entryPoints:['src/screens/dashboard.js'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
    name:'business-dashboard-fixture',setup(builder){
      builder.onResolve({filter:/config\.js$|state\/store\.js$|services\/(access|businesses)\.js$|router\.js$/},()=>({path:'fixture',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const {config,store,listBusinessBookings,getCalendarServiceSettings,saveCalendarServiceSettings,calendars,addCalendar,deleteCalendar,getAccess,inviteMember,team,deleteInviteeAccount,calendarInviteePermissions,setCalendarInviteePermission,navigate,back}=globalThis.businessDashboardFixture;'}));
    },
  }]});
  const screen=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
  const root=dom.window.document.querySelector('#app');await screen.businessHomeScreen(root,'2026-09-01');
  dom.window.location.hash='/business/calendar-view?calendar=calendar&week=2026-08-31&day=2';
  await screen.businessCalendarViewScreen(root);
  assert.equal(calls.length,2);assert.equal(calls[0][4],'confirmed');assert.equal(calls[1][4],'confirmed');
});
