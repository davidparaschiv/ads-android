// @ts-check
import { ensure, request, ok, authHeaders, edge, Skip, actor } from './core.mjs';
import { twilio, firebaseToken, fcm } from './providers.mjs';
import { inspectDatabase } from './database.mjs';

export async function smoke(config, check) {
  await check('Supabase Auth: reachable and Google provider enabled', async () => {
    const result=await request(config,`${config.SUPABASE_URL}/auth/v1/settings`,{headers:authHeaders(config)});
    ok(result); ensure(result.data?.external?.google === true, 'Google provider is not enabled in this Supabase project.');
    return 'Provider configuration only; not proof of a completed Google login.';
  });
  await check('Supabase REST: migrated public tables reachable',async()=>{
    for(const table of ['businesses','resources','event_types']) {
      const result=await request(config,`${config.SUPABASE_URL}/rest/v1/${table}?select=id&limit=0`,{headers:authHeaders(config)});
      ok(result); ensure(Array.isArray(result.data), 'Expected REST array response.');
    }
  });
  for(const name of ['enrollment','send-calendar-invite','send-reminders','sync-subscription','revenuecat-webhook']) {
    await check(`Edge ${name}: unauthenticated POST rejected`,async()=>{
      const result=await edge(config,name,{},'');
      if (result.status === 404 && ['sync-subscription','revenuecat-webhook'].includes(name)) throw new Skip('Optional billing function not deployed yet.');
      ensure(result.status === 401,'Unauthenticated request was not rejected with 401 (missing deployment or authorization defect).');
    });
    await check(`Edge ${name}: invalid credential rejected`,async()=>{
      const result=await edge(config,name,{},'invalid-backend-test-token',{'x-cron-secret':'invalid-backend-test-secret'});
      if(result.status === 404 && ['sync-subscription','revenuecat-webhook'].includes(name)) throw new Skip('Optional billing function not deployed yet.');
      ensure(result.status === 401,'Invalid credential was not rejected with 401.');
    });
  }
  await check('Enrollment: read-only GET refused', async()=>{
    const result=await request(config,`${config.SUPABASE_URL}/functions/v1/enrollment`,{headers:authHeaders(config)});
    ok(result,405);
  });
  await check('CORS: native origin allowed; untrusted origin not allowed',async()=>{
    for(const origin of ['https://localhost','https://untrusted.example.invalid']) {
      const result=await request(config,`${config.SUPABASE_URL}/functions/v1/enrollment`,{method:'OPTIONS',headers:{...authHeaders(config),Origin:origin,'Access-Control-Request-Method':'POST'}});
      ensure([200,204].includes(result.status),'Preflight request failed.');
      ensure(origin === 'https://localhost' ? result.headers.get('access-control-allow-origin') === origin : !result.headers.get('access-control-allow-origin'),'CORS allowlist mismatch.');
    }
    return 'CORS is not a substitute for authentication.';
  });
  await check('Resend: configured domain verified for sending',async()=>{
    if(!config.RESEND_READ_API_KEY || !config.RESEND_DOMAIN_ID) throw new Skip('Optional RESEND_READ_API_KEY and RESEND_DOMAIN_ID not configured. A sending-only key cannot inspect domains.');
    const result=await request(config,`https://api.resend.com/domains/${encodeURIComponent(config.RESEND_DOMAIN_ID)}`,{headers:{Authorization:`Bearer ${config.RESEND_READ_API_KEY}`}});
    ok(result); ensure(result.data?.status === 'verified','Resend domain is not verified.');
    const match=config.INVITE_FROM_EMAIL.match(/(?:<)?([^\s<>]+@[^\s<>]+)>?$/);
    ensure(match && result.data.name === match[1].split('@')[1],'Resend domain does not match the configured sender.');
  });
  await check('Twilio: real Verify service credentials',async()=>{
    if(!config.TWILIO_VERIFY_SERVICE_SID) throw new Skip('Twilio not configured yet.');
    const result=await twilio(config); ok(result);
    ensure(result.data?.sid === config.TWILIO_VERIFY_SERVICE_SID && result.data.account_sid === config.TWILIO_ACCOUNT_SID,'Twilio service/account mismatch.');
    return 'No SMS sent; does not prove destination delivery or geographic permissions.';
  });
  let token;
  await check('Firebase: private credential authenticates with Google',async()=>{
    if(!config.FIREBASE_SERVICE_ACCOUNT_FILE) throw new Skip('Firebase private file not configured.');
    token=await firebaseToken(config); return 'OAuth token issued; send permission is checked separately.';
  });
  await check('Firebase: FCM validate_only request (no notification)',async()=>{
    if(!token || !config.TEST_FCM_TOKEN) throw new Skip('Requires successful Firebase authentication and a real TEST_FCM_TOKEN.');
    await fcm(config,token,true); return 'FCM validated request; no message delivered.';
  });
  for(const role of ['owner','customer','staff','admin']) await check(`Auth: real verified Google ${role} session`,async()=>{
    if(!config[`TEST_${role.toUpperCase()}_EMAIL`]) throw new Skip('Test account not configured.');
    try { await actor(config,role); } catch(error) {
      if(error.message?.startsWith('Run npm run test:backend:login')) throw new Skip('No saved session. Use the optional backend Google-login helper.');
      throw error;
    }
  });
  if(config.BACKEND_TEST_DATABASE_URL) await inspectDatabase(config,check);
  else await check('Database / scheduler inspection',async()=>{throw new Skip('BACKEND_TEST_DATABASE_URL not configured.');});
  await check('RevenueCat / Play billing',async()=>{throw new Skip('Run the separately opted-in billing command after a real Play sandbox purchase. No fake purchase is generated.');});
}
