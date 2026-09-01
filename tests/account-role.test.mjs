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
