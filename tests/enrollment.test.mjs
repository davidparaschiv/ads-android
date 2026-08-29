// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { generateLicense } from '../tools/license-core.mjs';

test('Verified enrollment and universal developer access', async t => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for (const file of ['001_initial_schema.sql','002_plans_licenses_invitations.sql','003_verified_enrollment.sql','006_universal_developer_license.sql','007_approval_email_details.sql','008_owner_approval_codes.sql','009_access_expiry_and_permanent_dev.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const admin=randomUUID(), owner=randomUUID(), attacker=randomUUID();
  for (const [id,email] of [[admin,'davidnicolaparaschiv@gmail.com'],[owner,'business@example.com'],[attacker,'other@example.com']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[id]);
  }
  async function as(id,sql,params=[],role='authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('set role '+role);
    try { return (await db.query(sql,params)).rows; } finally { await db.exec('reset role'); }
  }
  const call = async (id,name,params=[],role='authenticated') => (await as(id,'select public.'+name+'('+params.map((_,i)=>'$'+(i+1)).join(',')+') result',params,role))[0].result;
  const issue = (id,kind) => call(admin,'issue_enrollment_link',[id,owner,kind],'service_role');
  let request, emailLink, approvalLink;
  const sid = 'VE'+'a'.repeat(32);

  await t.test('protected settings remain private and the developer key works for every verified Google account', async () => {
    assert.equal(await call(admin,'is_platform_owner_account'),true);
    assert.equal(await call(owner,'is_platform_owner_account'),false);
    await assert.rejects(as(attacker,"update private.platform_settings set owner_email='other@example.com'"),/permission denied/);
    await assert.rejects(db.query("update private.platform_settings set owner_email='other@example.com'"),/check constraint/);
    assert.equal((await call(attacker,'redeem_license',['dev112233'])).access.calendarLimit,5);
    assert.equal((await call(attacker,'get_access',[])).source,'developer');
    assert.equal((await call(attacker,'get_access',[])).expiresAt,'infinity');
    assert.equal((await call(admin,'redeem_license',['dev112233'])).access.calendarLimit,5);
    assert.equal((await call(admin,'get_access',[])).source,'developer');
    assert.equal((await call(owner,'get_access',[])).active,false);
    await db.query('update auth.users set email_confirmed_at=null where id=$1',[admin]);
    assert.equal((await call(admin,'redeem_license',['dev112233'])).ok,false);
    assert.equal((await call(admin,'get_access',[])).active,false);
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[admin]);
    await assert.rejects(call(admin,'create_business',['Bypass','Salon','București','0712345678']),/verificare/);
  });
  await t.test('CUI, phone and contact email required; pending request is not a registered business', async () => {
    await assert.rejects(call(owner,'start_enrollment',['Salon','Salon','București','','business@example.com','0712345678']),/Completează/);
    await assert.rejects(call(owner,'start_enrollment',['Salon','Salon','București','12345678','business@example.com','']),/Completează/);
    request = await call(owner,'start_enrollment',['Salon Test','Salon','București','RO12345678','contact@example.com','0712345678']);
    assert.equal(request.ok,true);
    assert.equal((await db.query('select * from public.businesses')).rows.length,0);
    await assert.rejects(as(owner,'select * from private.enrollment_requests'),/permission denied/);
    assert.equal((await call(attacker,'get_enrollment_status',[])),null);
    await assert.rejects(call(owner,'create_business',['Bypass','Salon','București','0712345678']),/verificare/);
    await assert.rejects(call(owner,'enrollment_sms_context',[request.id,false]),/mai întâi/);
    await assert.rejects(call(owner,'enrollment_record_sms',[request.id,owner,sid,true]),/permission denied/);
    assert.equal((await issue(request.id,'approval')).ok,false);
  });
  await t.test('email link is account-bound, single-use, and not an approval', async () => {
    emailLink = await issue(request.id,'email');
    const firstToken = emailLink.token;
    emailLink = await issue(request.id,'email');
    await assert.rejects(call(owner,'enrollment_link_details',[firstToken]),/indisponibil|expirat/);
    const lifetime = (await db.query("select expires_at>now()+interval '29 days' valid from private.enrollment_links where token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')",[emailLink.token])).rows[0].valid;
    assert.equal(lifetime,true);
    assert.equal(emailLink.recipient,'contact@example.com');
    assert.equal(emailLink.category,'Salon');
    assert.equal(emailLink.address,'București');
    await assert.rejects(call(attacker,'enrollment_link_details',[emailLink.token]),/Acces interzis/);
    assert.equal((await call(attacker,'confirm_enrollment_link',[emailLink.token,true])).ok,false);
    assert.equal((await call(owner,'confirm_enrollment_link',[emailLink.token,true])).ok,true);
    assert.equal((await call(owner,'confirm_enrollment_link',[emailLink.token,true])).ok,false);
    assert.equal((await call(owner,'get_enrollment_status',[])).emailVerified,true);
    assert.equal((await db.query('select * from public.businesses')).rows.length,0);
  });
  await t.test('SMS proof can only be recorded by service role for the current verification SID', async () => {
    assert.equal((await call(owner,'enrollment_sms_context',[request.id,false])).phone,'+40712345678');
    assert.equal((await call(owner,'enrollment_sms_context',[request.id,false])).ok,false);
    assert.equal(await call(admin,'enrollment_record_sms',[request.id,owner,sid,false],'service_role'),true);
    assert.equal(await call(admin,'enrollment_record_sms',[request.id,owner,'VE'+'b'.repeat(32),true],'service_role'),false);
    assert.equal(await call(admin,'enrollment_record_sms',[request.id,attacker,sid,true],'service_role'),false);
    assert.equal(await call(admin,'enrollment_record_sms',[request.id,owner,sid,true],'service_role'),true);
    assert.equal((await call(owner,'get_enrollment_status',[])).phoneVerified,true);
    assert.equal((await db.query('select * from public.businesses')).rows.length,0);
  });
  await t.test('fixed admin recipient and authenticated admin link approval create one business', async () => {
    approvalLink = await issue(request.id,'approval');
    assert.equal(approvalLink.recipient,'davidnicolaparaschiv@gmail.com');
    await assert.rejects(call(owner,'issue_enrollment_link',[request.id,owner,'approval']),/permission denied/);
    assert.equal((await call(owner,'confirm_enrollment_link',[approvalLink.token,true])).ok,false);
    assert.equal((await call(attacker,'confirm_enrollment_link',[approvalLink.token,true])).ok,false);
    const result = await call(admin,'confirm_enrollment_link',[approvalLink.token,true]);
    assert.equal(result.ok,true);
    const businesses=(await db.query('select * from public.businesses')).rows;
    assert.equal(businesses.length,1); assert.equal(businesses[0].owner_id,owner);
    assert.equal(businesses[0].cui,'12345678'); assert.equal(businesses[0].contact_email,'contact@example.com');
    assert.ok(businesses[0].phone_verified_at); assert.equal(businesses[0].approved_by,admin);
    assert.equal((await call(admin,'confirm_enrollment_link',[approvalLink.token,true])).ok,false);
    await assert.rejects(as(owner,"update public.businesses set phone='0799999999'"),/permission denied/);
    assert.equal((await call(owner,'get_access',[result.businessId])).active,false);
  });
  await t.test('superseded/expired email links fail, developer grant can be revoked', async () => {
    const r=await call(attacker,'start_enrollment',['Alt Salon','Salon','București','87654321','alt@example.com','0799999999']);
    const link=await call(admin,'issue_enrollment_link',[r.id,attacker,'email'],'service_role');
    const next=await call(attacker,'start_enrollment',['Corectat Salon','Salon','București','87654321','nou@example.com','0799999999']);
    assert.equal((await call(attacker,'confirm_enrollment_link',[link.token,true])).ok,false);
    assert.equal((await call(attacker,'get_enrollment_status',[])).emailVerified,false);
    const nextLink=await call(admin,'issue_enrollment_link',[next.id,attacker,'email'],'service_role');
    await db.query("update private.enrollment_links set expires_at=now()-interval '1 second' where request_id=$1",[next.id]);
    assert.equal((await call(attacker,'confirm_enrollment_link',[nextLink.token,true])).ok,false);
    await db.query('update private.platform_settings set developer_bypass_enabled=false');
    assert.equal((await call(admin,'get_access',[])).active,false);
    assert.equal((await call(admin,'redeem_license',['dev112233'])).ok,false);
  });
  await t.test('normal issued licenses still follow their email and duration rules after migration 003',async()=>{
    const key=generateLicense({email:'business@example.com',start:new Date(Date.now()-86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),months:1});
    await db.exec(key.sql);
    assert.equal((await call(owner,'redeem_license',[key.key])).ok,true);
    assert.equal((await call(owner,'get_access',[])).source,'license');
    const rejected=await call(attacker,'redeem_license',[key.key]);
    assert.equal(rejected.ok,false);
    assert.equal(rejected.message,'Licență invalidă.');
  });
});
