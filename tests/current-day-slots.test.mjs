// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('available service dates start with the current Bucharest calendar day', async t => {
  const originalDate=globalThis.Date;
  const calls=[];
  class FixedDate extends originalDate {
    constructor(...args){super(...(args.length?args:['2026-09-01T21:30:00.000Z']));}
    static now(){return originalDate.parse('2026-09-01T21:30:00.000Z');}
  }
  globalThis.Date=FixedDate;
  globalThis.slotFixture={calls};
  t.after(()=>{globalThis.Date=originalDate;delete globalThis.slotFixture;});
  const bundled=await build({entryPoints:['src/services/bookings.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'slot-fixture',setup(builder){
      builder.onResolve({filter:/^\.\.\/(?:config|data|api\/supabase)\.js$|^\.\/access\.js$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>{
        if(args.path==='../config.js')return{contents:"export const config={mode:'live',timezone:'Europe/Bucharest'};"};
        if(args.path==='./access.js')return{contents:"export async function rpc(_name,args){globalThis.slotFixture.calls.push(args.p_date);return [];}"};
        if(args.path==='../api/supabase.js')return{contents:'export const getSupabase=()=>null;'};
        return{contents:'export const demoBookings=[];'};
      });
    },
  }]});
  const service=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  await service.availableServiceSlots('business','calendar','service');
  assert.equal(calls.length,30);
  assert.equal(calls[0],'2026-09-02');
  assert.equal(calls[29],'2026-10-01');
});
