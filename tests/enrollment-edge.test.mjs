// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('Enrollment edge adapter: authentication, SMS provider proof, and fixed recipient', async t => {
  const originalFetch = globalThis.fetch;
  const originalDeno = globalThis.Deno;
  t.after(() => { globalThis.fetch=originalFetch; globalThis.Deno=originalDeno; delete globalThis.enrollmentFixture; });
  const calls=[], sid='VE'+'a'.repeat(32);
  const env={ TWILLIO_ACCOUNT_SID:'AC'+'a'.repeat(32), TWILLIO_AUTH_TOKEN:'test-token', TWILIO_VERIFY_SERVICE_SID:'VA'+'a'.repeat(32), RESEND_API_KEY:'test', INVITE_FROM_EMAIL:'test@example.com' };
  let authenticated=true, providerStatus='pending', providerPhone='+40712345678';
  globalThis.Deno={ serve() {}, env:{get:name=>env[name]} };
  globalThis.enrollmentFixture={
    env:name=>{ if (!env[name]) throw new Error('Missing server setting: '+name); return env[name]; },
    authenticated:async()=>{ if (!authenticated) throw new Error('Unauthorized'); return {user:{id:'actual-owner'},client:{rpc:async(name,args)=>{
      calls.push({kind:'client',name,args}); return {data:{ok:true,phone:'+40712345678',sid},error:null};
    }}}; },
    serviceClient:()=>({rpc:async(name,args)=>{
      calls.push({kind:'service',name,args});
      return {data:name==='issue_enrollment_link'?{ok:true,token:'RZA-'+'A'.repeat(64),recipient:'davidnicolaparaschiv@gmail.com',name:'Salon Aurora',category:'Salon',address:'Strada Florilor 10, București',cui:'12345678',phone:'+40712345678',email:'contact@example.com'}:true,error:null};
    }}),
  };
  globalThis.fetch=async(url,options)=>{
    calls.push({kind:'fetch',url,options});
    return Response.json(String(url).includes('twilio')?{status:providerStatus,sid,to:providerPhone}:{id:'email-test'});
  };
  const bundle=await build({ entryPoints:['supabase/functions/enrollment/index.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'test-http-adapter',setup(builder){
      builder.onResolve({filter:/_shared\/http\.js$/},()=>({path:'http',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`const f=globalThis.enrollmentFixture; export const env=f.env,authenticated=f.authenticated,serviceClient=f.serviceClient; export const headers=()=>({}); export const json=(_r,body,status=200)=>Response.json(body,{status});`}));
    },
  }] });
  const {handleEnrollment}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const request=body=>new Request('https://example.com/enrollment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await t.test('unauthenticated requests and link GET do not mutate',async()=>{
    authenticated=false;
    assert.equal((await handleEnrollment(request({action:'checkSms'}))).status,401);
    assert.equal((await handleEnrollment(new Request('https://example.com/enrollment'))).status,405);
    assert.equal(calls.length,0); authenticated=true;
  });
  await t.test('pending/wrong-destination OTP never marks the phone verified',async()=>{
    const body={action:'checkSms',id:'request-id',code:'123456',phone:'+40799999999'};
    assert.equal((await handleEnrollment(request(body))).status,400);
    assert.ok(!calls.some(c=>c.name==='enrollment_record_sms'));
    providerStatus='approved'; providerPhone='+40799999999';
    assert.equal((await handleEnrollment(request(body))).status,400);
    assert.ok(!calls.some(c=>c.name==='enrollment_record_sms'));
    providerPhone='+40712345678';
    assert.equal((await handleEnrollment(request(body))).status,200);
    const mark=calls.find(c=>c.name==='enrollment_record_sms');
    assert.equal(mark.args.p_owner,'actual-owner'); assert.equal(mark.args.p_verified,true); assert.equal(mark.args.p_sid,sid);
  });
  await t.test('approval email uses DB recipient, ignoring client-supplied recipient and owner',async()=>{
    assert.equal((await handleEnrollment(request({action:'approval',id:'request-id',owner:'attacker',recipient:'attacker@example.com'}))).status,200);
    const issue=calls.find(c=>c.name==='issue_enrollment_link'); assert.equal(issue.args.p_owner,'actual-owner');
    const mail=calls.find(c=>c.kind==='fetch' && c.url.includes('resend'));
    const message=JSON.parse(mail.options.body);
    assert.deepEqual(message.to,['davidnicolaparaschiv@gmail.com']);
    for(const detail of ['Denumire: Salon Aurora','Categorie: Salon','CUI: 12345678','Adresă: Strada Florilor 10, București','E-mail business: contact@example.com','Telefon: +40712345678','Cod aprobare: contact@example.com/RZA-','Valabil 30 de zile.']) assert.match(message.text,new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.doesNotMatch(message.text,/https?:\/\/|ro\.rezerva\.app:\/\//);
    assert.doesNotMatch(message.text,/Cod alternativ/);
  });
});
