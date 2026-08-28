// @ts-check
// Offline verification of the live booking runner, including cleanup on backend defects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('Backend booking runner: concurrent requests and cleanup of every returned ID',async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;delete globalThis.bookingHarnessFixture;});
  const ids={owner:'11111111-1111-4111-8111-111111111111',customer:'22222222-2222-4222-8222-222222222222',business:'33333333-3333-4333-8333-333333333333',calendar:'44444444-4444-4444-8444-444444444444',event:'55555555-5555-4555-8555-555555555555'};
  const bookingIds=['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777'];
  const coreURL=new URL('../tools/backend-tests/core.mjs',import.meta.url).href;
  globalThis.bookingHarnessFixture={actor:async(_config,role)=>({id:ids[role],email:role+'@example.invalid',token:'offline-'+role}),saveState:async()=>{}};
  const result=await build({entryPoints:['tools/backend-tests/workflows.mjs'],bundle:true,write:false,format:'esm',platform:'node',packages:'external',external:[coreURL],plugins:[{
    name:'offline-session-and-state',setup(builder){
      builder.onResolve({filter:/^\.\/core\.mjs$/},()=>({path:'core',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export * from ${JSON.stringify(coreURL)}; export const actor=globalThis.bookingHarnessFixture.actor,saveState=globalThis.bookingHarnessFixture.saveState;`}));
    },
  }]});
  const {booking}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  const config={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',TEST_BUSINESS_OWNED:'true',TEST_BUSINESS_ID:ids.business,TEST_CALENDAR_ID:ids.calendar,TEST_EVENT_TYPE_ID:ids.event};
  let broken=false,count=0,inFlight=0,maxInFlight=0;const cancelled=[];
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;const body=options.body?JSON.parse(options.body):{};
    if(path.endsWith('/get_my_workspaces')) return Response.json([{id:ids.business,is_owner:true}]);
    if(path.endsWith('/get_access')) return Response.json({active:true,overLimit:false,features:{reports:true}});
    if(path.endsWith('/available_slots')) return Response.json([{start_at:'2026-12-01T09:00:00Z'}]);
    if(path.endsWith('/create_booking')) {
      const n=count++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      await new Promise(resolve=>setTimeout(resolve,1));inFlight--;
      return n===0 || broken?Response.json(bookingIds[n]):Response.json({code:'23P01'},{status:409});
    }
    if(path.endsWith('/bookings')) return Response.json([{id:bookingIds[0],customer_id:ids.customer,customer_email_snapshot:'customer@example.invalid'}]);
    if(path.endsWith('/get_business_report')) return Response.json([{id:bookingIds[0]}]);
    if(path.endsWith('/set_booking_status')) {cancelled.push(body.p_booking_id);assert.equal(body.p_status,'cancelled');return Response.json(null);}
    throw new Error('Unmocked route: '+path);
  };
  await t.test('requests actually overlap and successful test cancels its only booking',async()=>{
    const state={runId:'offline-run'};await booking(config,new Set(['allow-writes']),state);
    assert.equal(maxInFlight,2);assert.deepEqual(cancelled,[bookingIds[0]]);assert.equal(state.bookings[0].cancelled,true);
  });
  await t.test('backend double-booking defect fails test and cancels BOTH accepted bookings',async()=>{
    broken=true;count=0;cancelled.length=0;const state={runId:'offline-run'};
    await assert.rejects(booking(config,new Set(['allow-writes']),state),/exactly one booking/);
    assert.deepEqual(cancelled,bookingIds);assert.ok(state.bookings.every(b=>b.cancelled));
  });
});
