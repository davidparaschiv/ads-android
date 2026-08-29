// @ts-check
// Offline contract tests of the ACTUAL Edge Function code. Only SDKs/HTTP are mocked.
// No production credentials, network access, real emails, push messages or purchases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function adapter(entry, fixture) {
  globalThis.providerFixture = fixture;
  const result = await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'offline-provider-boundaries',setup(builder) {
      builder.onResolve({filter:/_shared\/http\.js$|^\.\/http\.js$/},()=>({path:'http',namespace:'fixture'}));
      builder.onResolve({filter:/^npm:@supabase\/supabase-js/},()=>({path:'supabase',namespace:'fixture'}));
      builder.onResolve({filter:/^npm:google-auth-library/},()=>({path:'google',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='http'
        ? `const f=globalThis.providerFixture; export const authenticated=f.authenticated,env=f.env,serviceClient=()=>f.db; export const headers=()=>({}); export const json=(_r,b,status=200)=>Response.json(b,{status});`
        :args.path==='supabase'?`export const createClient=()=>globalThis.providerFixture.db;`
          :`export class JWT { constructor(options){globalThis.providerFixture.jwtOptions=options;} async authorize(){return {access_token:'offline-only'};} }`}));
    },
  }]});
  let handler;
  globalThis.Deno={env:{get:fixture.env},serve:fn=>{handler=fn;}};
  await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.equal(typeof handler,'function'); return handler;
}
const post=(body={},headers={})=>new Request('https://offline.invalid/',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test('Provider adapters: invitation authorization, correct recipient and Resend failures',async t=>{
  const originals={fetch:globalThis.fetch,Deno:globalThis.Deno};
  t.after(()=>{Object.assign(globalThis,originals);delete globalThis.providerFixture;});
  const calls=[],marks=[]; let authorized=true,issueError=false,limited=false,providerStatus=200;
  const fixture={env:()=> 'offline-only',authenticated:async()=>{
    if(!authorized) throw new Error('Unauthorized');
    return {user:{id:'owner'},client:{rpc:async()=>({data:{ok:!limited,id:'invite-id',email:'controlled@example.invalid',token:'RZI-'+'A'.repeat(64)},error:issueError?{}:null})}};
  },db:{rpc:async(name,args)=>{marks.push({name,args});return {error:null};}}};
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return Response.json({id:'email-id'},{status:providerStatus});};
  const handler=await adapter('supabase/functions/send-calendar-invite/index.js',fixture);
  await t.test('unauthenticated, unauthorized and rate-limited requests do not send',async()=>{
    authorized=false;assert.equal((await handler(post())).status,401);authorized=true;
    issueError=true;assert.equal((await handler(post())).status,403);issueError=false;
    limited=true;assert.equal((await handler(post())).status,429);limited=false;
    assert.equal(calls.length,0);assert.equal(marks.length,0);
  });
  await t.test('recipient/token come from DB; delivery marked only after acceptance',async()=>{
    assert.equal((await handler(post({email:'attacker@example.invalid'}))).status,200);
    const message=JSON.parse(calls[0].options.body);
    assert.deepEqual(message.to,['controlled@example.invalid']);
    assert.match(message.text,/Cod invitație:\nRZI-/);
    assert.doesNotMatch(message.text,/https?:\/\/|ro\.rezerva\.app:\/\/|Cod alternativ/);
    assert.equal(calls[0].options.headers['Idempotency-Key'],'calendar-invite/invite-id');
    assert.equal(marks.at(-1).args.p_sent,true);
  });
  await t.test('provider failure marks failed delivery and returns retryable error',async()=>{
    providerStatus=503;assert.equal((await handler(post())).status,502);
    assert.equal(marks.at(-1).args.p_sent,false);
  });
});

test('Provider adapters: reminder worker claiming, eligibility, FCM and retries',async t=>{
  const originals={fetch:globalThis.fetch,Deno:globalThis.Deno};
  t.after(()=>{Object.assign(globalThis,originals);delete globalThis.providerFixture;});
  let jobs=[],allowed=true,claimed=true,providerStatus=200;const calls=[],updates=[],logs=[];
  const fixture={env:name=>name==='CRON_SECRET'?'offline-secret':name==='GCLOUD_SERVICEACCOUNT_KEYS'?JSON.stringify({type:'service_account',project_id:'test-project',client_email:'offline@example.invalid',private_key:'offline-private-key'}):'test-project',db:{
    rpc:async()=>({data:allowed,error:null}),
    from:table=>{
      let update;const query={select(){return query;},eq(){return query;},lte(){return query;},limit(){return query;},
        update(value){update=value;updates.push(value);return query;},
        async insert(value){logs.push(value);return {error:null};},
        async maybeSingle(){return {data:claimed?{id:'job'}:null,error:null};},
        then(resolve,reject){return Promise.resolve({data:update?null:table==='notification_jobs'?jobs:[{token:'device-token'}],error:null}).then(resolve,reject);},
      };return query;
    },
  }};
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return Response.json({},{status:providerStatus});};
  const handler=await adapter('supabase/functions/send-reminders/index.js',fixture);
  const invoke=()=>handler(post({}, {'x-cron-secret':'offline-secret'}));
  const job={id:'job',booking_id:'booking',user_id:'customer',attempts:0,title:'Test',body:'Test'};
  await t.test('cron secret required; empty queue has no provider traffic',async()=>{
    assert.equal((await handler(post())).status,401);
    assert.equal((await handler(new Request('https://offline.invalid'))).status,405);
    assert.deepEqual(await (await invoke()).json(),{processed:0});assert.equal(calls.length,0);
  });
  await t.test('another worker claim prevents duplicate send',async()=>{
    jobs=[job];claimed=false;assert.deepEqual(await (await invoke()).json(),{processed:0});assert.equal(calls.length,0);claimed=true;
  });
  await t.test('revoked/opted-out recipient cancels without sending',async()=>{
    allowed=false;await invoke();assert.equal(updates.at(-1).status,'cancelled');assert.equal(calls.length,0);allowed=true;
  });
  await t.test('successful send contains booking ID and logs one delivery',async()=>{
    assert.deepEqual(await (await invoke()).json(),{processed:1});
    assert.deepEqual(fixture.jwtOptions, {email:'offline@example.invalid',key:'offline-private-key',scopes:['https://www.googleapis.com/auth/firebase.messaging']});
    assert.equal(calls[0].url,'https://fcm.googleapis.com/v1/projects/test-project/messages:send');
    assert.equal(JSON.parse(calls[0].options.body).message.data.bookingId,'booking');
    assert.equal(updates.at(-1).status,'sent');assert.equal(logs.length,1);
  });
  await t.test('FCM error retries, then fails on third attempt without logging success',async()=>{
    providerStatus=503;await invoke();assert.equal(updates.at(-1).status,'pending');
    jobs=[{...job,attempts:2}];await invoke();assert.equal(updates.at(-1).status,'failed');assert.equal(logs.length,1);
  });
});

test('Provider adapters: actual RevenueCat synchronization and webhook trust boundary',async t=>{
  const originals={fetch:globalThis.fetch,Deno:globalThis.Deno};
  t.after(()=>{Object.assign(globalThis,originals);delete globalThis.providerFixture;});
  const owner='11111111-1111-4111-8111-111111111111', writes=[],calls=[];
  let authorized=true,status=200,subscriber={};
  const fixture={env:name=>name==='REVENUECAT_ENTITLEMENT_ID'?'business_pro':'offline-secret',
    authenticated:async()=>{if(!authorized)throw new Error('Unauthorized');return {user:{id:owner},client:{rpc:async()=>({data:{active:true},error:null})}};},
    db:{from:table=>{const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:{id:'business'},error:null};},
      update(row){writes.push({table,row});return query;},async upsert(row){writes.push({table,row});return {error:null};},
      then(resolve,reject){return Promise.resolve({error:null}).then(resolve,reject);}};return query;}},
  };
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return Response.json({subscriber},{status});};
  const sync=await adapter('supabase/functions/sync-subscription/index.js',fixture);
  const webhook=await adapter('supabase/functions/revenuecat-webhook/index.js',fixture);
  function purchase(plan='large',store='play_store',expired=false) {
    const product=`rezerva_${plan}_monthly:monthly`;
    subscriber={entitlements:{business_pro:{product_identifier:product,expires_date:new Date(Date.now()+(expired?-1:1)*86400000).toISOString()}},subscriptions:{[product]:{store,is_sandbox:true}}};
  }
  await t.test('unauthenticated sync/webhook do not call RevenueCat',async()=>{
    authorized=false;assert.equal((await sync(post())).status,401);authorized=true;
    assert.equal((await webhook(post())).status,401);assert.equal(calls.length,0);assert.equal(writes.length,0);
  });
  await t.test('provider outage never grants or replaces a subscription',async()=>{
    status=503;assert.equal((await sync(post())).status,502);assert.equal(writes.length,0);status=200;
  });
  await t.test('both plans mapped from authoritative provider, not requested owner/plan',async()=>{
    for(const plan of ['small','large']) {
      purchase(plan);assert.equal((await sync(post({owner_id:'attacker',plan_id:'large'}))).status,200);
      assert.equal(writes.at(-1).row.owner_id,owner);assert.equal(writes.at(-1).row.plan_id,plan);
      assert.equal(writes.at(-1).row.environment,'sandbox');assert.equal(writes.at(-1).row.status,'active');
    }
  });
  await t.test('unsupported store rejects; expired and removed entitlements revoke access',async()=>{
    const count=writes.length;purchase('large','app_store');assert.equal((await sync(post())).status,502);assert.equal(writes.length,count);
    purchase('large','play_store',true);assert.equal((await sync(post())).status,200);assert.equal(writes.at(-1).row.status,'expired');
    subscriber={};await sync(post());assert.equal(writes.at(-1).row.status,'expired');
  });
  await t.test('delayed/replayed webhook fetches current entitlement and ignores forged payload',async()=>{
    purchase('small');const request=()=>post({event:{id:'same-event',type:'CANCELLATION',app_user_id:owner,product_id:'rezerva_large_monthly'}},{Authorization:'offline-secret'});
    for(let i=0;i<2;i++){assert.equal((await webhook(request())).status,200);assert.equal(writes.at(-1).row.plan_id,'small');assert.equal(writes.at(-1).row.status,'active');}
    assert.ok(calls.every(call=>call.url.endsWith('/'+owner)));
  });
});
