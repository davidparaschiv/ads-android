// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('an existing business, invitee or client account is opened automatically without signing out', async t => {
  const originalWindow=globalThis.window;
  t.after(()=>{globalThis.window=originalWindow;delete globalThis.accountRoleFixture;});

  for (const scenario of [
    { selected:'client', existing:'business', expectedRole:'business' },
    { selected:'business', existing:'invitee', expectedRole:'business' },
    { selected:'business', existing:'client', expectedRole:'customer' },
  ]) {
    const state={
      role:scenario.selected==='client'?'customer':'business',
      requestedAccountType:scenario.selected,
      accountTypeNotice:'',
      inviteFlow:scenario.selected==='invitee',
      user:null,business:{id:'stale'},customerProfileComplete:false,
    };
    let providerSignOuts=0;
    const client={
      rpc:async name=>{assert.equal(name,'get_account_role');return {data:scenario.existing,error:null};},
      auth:{
        getSession:async()=>({data:{session:{user:{id:'existing-user',email:'cont@example.com',user_metadata:{full_name:'Cont existent'}}}}}),
        onAuthStateChange:()=>{},
        signOut:async()=>{providerSignOuts++;},
      },
    };
    globalThis.accountRoleFixture={
      config:{mode:'live',authRedirectUrl:'ro.rezerva.app://auth/callback'},getSupabase:()=>client,
      store:{get:()=>structuredClone(state),set:async patch=>Object.assign(state,patch),clear:async()=>{}},
      Capacitor:{isNativePlatform:()=>true},Browser:{close:async()=>{}},
      Preferences:{get:async()=>({value:null}),remove:async()=>{}},navigate:()=>{},
      App:{addListener:async()=>{},getLaunchUrl:async()=>null},
    };
    globalThis.window={location:{hash:''}};
    const bundled=await build({entryPoints:['src/services/auth.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
      name:'account-role-fixture',setup(builder){
        builder.onResolve({filter:/^@capacitor\/|^\.\.\/(?:config|api\/supabase|state\/store|router)\.js$/},()=>({path:'mock',namespace:'mock'}));
        builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {App,Browser,Capacitor,Preferences,config,getSupabase,store,navigate}=globalThis.accountRoleFixture;'}));
      },
    }]});
    const auth=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64')+`#${scenario.existing}`);
    await auth.initializeAuth();
    assert.equal(providerSignOuts,0);
    assert.equal(state.user.email,'cont@example.com');
    assert.equal(state.role,scenario.expectedRole);
    assert.equal(state.requestedAccountType,scenario.existing);
    assert.equal(state.inviteFlow,false);
    assert.equal(state.accountTypeNotice,`Există un alt tip de cont cu această adresă. Tip ${scenario.existing}.`);
    if (scenario.existing==='client') {
      assert.equal(state.business,null);
      assert.equal(state.customerProfileComplete,true);
    }
  }
});

test('a deleted invitee is signed out from an active or previously offline app session', async t => {
  const originalWindow=globalThis.window;
  t.after(()=>{globalThis.window=originalWindow;delete globalThis.accountRoleFixture;});

  for (const scenario of ['startup-reset','realtime-reset']) {
    const state={role:'business',requestedAccountType:'invitee',user:{id:'removed-user'},business:{id:'business'},inviteFlow:true};
    let providerSignOuts=0;
    let resetCallback=()=>{};
    const navigations=[];
    const session={
      user:{id:'removed-user',email:'invitat@example.com',last_sign_in_at:'2026-09-02T10:00:00.000Z',user_metadata:{}},
      access_token:'',
    };
    const client={
      rpc:async()=>({data:'invitee',error:null}),
      from:table=>{
        assert.equal(table,'account_reset_events');
        return {select:()=>({eq:()=>({maybeSingle:async()=>({
          data:scenario==='startup-reset'?{reset_at:'2026-09-02T10:01:00.000Z'}:null,
          error:null,
        })})})};
      },
      channel:()=>({
        on(_event,_filter,callback){resetCallback=callback;return this;},
        subscribe(){return this;},
      }),
      removeChannel:async()=>{},
      auth:{
        getSession:async()=>({data:{session}}),
        onAuthStateChange:()=>{},
        signOut:async()=>{providerSignOuts++;},
      },
    };
    globalThis.accountRoleFixture={
      config:{mode:'live',authRedirectUrl:'ro.rezerva.app://auth/callback'},getSupabase:()=>client,
      store:{get:()=>structuredClone(state),set:async patch=>Object.assign(state,patch),clear:async()=>{Object.assign(state,{user:null,business:null});}},
      Capacitor:{isNativePlatform:()=>true},Browser:{close:async()=>{}},
      Preferences:{get:async()=>({value:null}),remove:async()=>{}},navigate:path=>navigations.push(path),
      App:{addListener:async()=>{},getLaunchUrl:async()=>null},
    };
    globalThis.window={location:{hash:''},history:{back:()=>{}}};
    const bundled=await build({entryPoints:['src/services/auth.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
      name:'account-reset-fixture',setup(builder){
        builder.onResolve({filter:/^@capacitor\/|^\.\.\/(?:config|api\/supabase|state\/store|router)\.js$/},()=>({path:'mock',namespace:'mock'}));
        builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {App,Browser,Capacitor,Preferences,config,getSupabase,store,navigate}=globalThis.accountRoleFixture;'}));
      },
    }]});
    const auth=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64')+`#${scenario}`);
    await auth.initializeAuth();
    if (scenario==='realtime-reset') {
      resetCallback();
      for(let index=0;index<50&&providerSignOuts===0;index++) await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(providerSignOuts,1,scenario);
    assert.equal(state.user,null,scenario);
    assert.equal(state.business,null,scenario);
    assert.deepEqual(navigations,['/'],scenario);
  }
});
