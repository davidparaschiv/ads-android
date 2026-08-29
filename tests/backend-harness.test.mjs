// @ts-check
// OFFLINE tests for the live-test harness. No credentials are loaded or services contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readConfig, consent, recipient, request, safeError, CheckError, redact } from '../tools/backend-tests/core.mjs';
import { connectionOptions, databaseCases } from '../tools/backend-tests/database.mjs';
import { fcm, sendEmail, sendSms } from '../tools/backend-tests/providers.mjs';

const ref='abcdefghijklmnopqrst';
const config={SUPABASE_URL:`https://${ref}.supabase.co`,BACKEND_TEST_PROJECT_REF:ref,BACKEND_TEST_TIMEOUT_MS:'1000'};

test('Backend harness: disabled by default; targets and credentials fail closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rezerva-harness-')); const file=join(dir,'config');
  const template=`BACKEND_TEST_ENABLED=true\nBACKEND_TEST_ENVIRONMENT=development\nSUPABASE_URL=https://${ref}.supabase.co\nBACKEND_TEST_PROJECT_REF=${ref}\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_test\n`;
  try {
    await writeFile(file,template.replace('ENABLED=true','ENABLED=false')); await assert.rejects(readConfig(file),/ENABLED/);
    await writeFile(file,template.replace(`${ref}.supabase.co`,'differentprojecthost.supabase.co')); await assert.rejects(readConfig(file),/exactly match/);
    await writeFile(file,template.replace('sb_publishable_test','sb_secret_test')); await assert.rejects(readConfig(file),/never a service/);
    await writeFile(file,template); assert.equal((await readConfig(file)).BACKEND_TEST_PROJECT_REF,ref);
    assert.throws(()=>consent(new Set(),'allow-messages'),/requires/);
    assert.throws(()=>recipient({TEST_EMAIL_TO:'a@example.com,b@example.com'},'TEST_EMAIL_TO'),/Invalid/);
    assert.throws(()=>recipient({TEST_PHONE_TO:'+12025550123'},'TEST_PHONE_TO'),/Invalid/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('Backend harness: TLS and DB project identity cannot be weakened by URL options',()=>{
  const options=connectionOptions({...config,BACKEND_TEST_DATABASE_URL:`postgresql://postgres.${ref}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=disable`});
  assert.equal(options.ssl.rejectUnauthorized,true); assert.ok(!options.connectionString.includes('sslmode'));
  assert.throws(()=>connectionOptions({...config,BACKEND_TEST_DATABASE_URL:'postgres://postgres:secret@evil.example:5432/postgres'}),/same project/);
  assert.throws(()=>connectionOptions({...config,BACKEND_TEST_DATABASE_URL:`postgres://postgres.${ref}:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`}),/5432/);
});
test('Backend harness: no message calls without consent; FCM dry-run payload; no redirect following',async t=>{
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return Response.json({name:'projects/test/messages/example'});};
  await assert.rejects(sendEmail(config,new Set(),{}),/allow-messages/);
  await assert.rejects(sendSms(config,new Set(),{}),/allow-messages/);
  assert.equal(calls.length,0);
  await assert.rejects(request(config,'https://evil.example/'),/unexpected/);
  assert.equal(calls.length,0);
  await fcm({...config,FIREBASE_PROJID:'test-project',TEST_FCM_TOKEN:'dummy-token'},'dummy-access',true);
  assert.equal(JSON.parse(calls[0].options.body).validate_only,true);
  assert.equal(calls[0].options.redirect,'error');
});
test('Backend harness: errors/reports do not reveal provider credentials or raw error bodies',()=>{
  assert.ok(!safeError(new Error('password=private-value'),config).includes('private-value'));
  assert.ok(!safeError(new CheckError('token=my-private-key'),{KEY:'my-private-key'}).includes('my-private-key'));
  assert.ok(!redact('Bearer secret https://example.com?token=x RZE-'+'A'.repeat(64),{}).includes('A'.repeat(64)));
});
test('Backend harness: database cases execute against a local PostgreSQL fixture and roll back',async t=>{
  const db=new PGlite({extensions:{btree_gist,pgcrypto}});t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',aud text,role text);
    create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,provider_id text,identity_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for(const name of ['001_initial_schema.sql','002_plans_licenses_invitations.sql','003_verified_enrollment.sql','004_team_features.sql','006_universal_developer_license.sql','007_approval_email_details.sql','008_owner_approval_codes.sql','009_access_expiry_and_permanent_dev.sql','010_team_plan_and_member_limit.sql','011_all_team_calendars_shared.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.query('begin');const failures=[];
  try {await databaseCases(db,async(name,body)=>{try{await body();}catch(error){failures.push({name,error});}});}
  finally {await db.query('rollback');}
  for(const table of ['auth.users','public.businesses','public.bookings','private.license_keys','private.enrollment_requests']) assert.equal((await db.query('select count(*)::int n from '+table)).rows[0].n,0,'Rollback left fixture rows: '+table);
  assert.equal(failures.length,0,failures.map(f=>`${f.name}: ${f.error.message}`).join('\n'));
});
