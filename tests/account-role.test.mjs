// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('a business Google email selected as customer is signed out and receives a clear message', async t => {
  const state={role:'customer',user:null,business:null,customerProfileComplete:false,authNotice:''};
  let providerSignOuts=0;
  const client={
    rpc:async name=>{assert.equal(name,'get_account_role');return {data:'business',error:null};},
    auth:{
      getSession:async()=>({data:{session:{user:{id:'business-user',email:'firma@example.com',user_metadata:{full_name:'Firma'}}}}}),
      onAuthStateChange:()=>{},
      signOut:async()=>{providerSignOuts++;},
    },
  };
  const fixture={
    config:{mode:'live',authRedirectUrl:'ro.rezerva.app://auth/callback'},getSupabase:()=>client,
    store:{get:()=>structuredClone(state),set:async patch=>Object.assign(state,patch),clear:async()=>Object.assign(state,{role:null,user:null,business:null,customerProfileComplete:false,authNotice:''})},
    Capacitor:{isNativePlatform:()=>true},Browser:{close:async()=>{}},
    Preferences:{get:async()=>({value:null}),remove:async()=>{}},navigate:()=>{},
    App:{addListener:async()=>{},getLaunchUrl:async()=>null},
  };
  const originalWindow=globalThis.window;globalThis.window={location:{hash:''}};globalThis.accountRoleFixture=fixture;
  t.after(()=>{globalThis.window=originalWindow;delete globalThis.accountRoleFixture;});
  const bundled=await build({entryPoints:['src/services/auth.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'account-role-fixture',setup(builder){
      builder.onResolve({filter:/^@capacitor\/|^\.\.\/(?:config|api\/supabase|state\/store|router)\.js$/},()=>({path:'mock',namespace:'mock'}));
      builder.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {App,Browser,Capacitor,Preferences,config,getSupabase,store,navigate}=globalThis.accountRoleFixture;'}));
    },
  }]});
  const auth=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  await auth.initializeAuth();
  assert.equal(providerSignOuts,1);
  assert.equal(state.user,null);
  assert.equal(state.role,'customer');
  assert.equal(state.authNotice,'Acest e-mail este e-mail de firmă. Folosește alt e-mail dacă vrei să fii client al aplicației.');
});
