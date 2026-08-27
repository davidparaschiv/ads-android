// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { generateLicense } from '../tools/license-core.mjs';

test('PostgreSQL integration: licenses, billing limits, invitations and RLS', async t => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
    create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
  `);
  for (const filename of ['001_initial_schema.sql','002_plans_licenses_invitations.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + filename, import.meta.url), 'utf8'));
  }
  const owner = randomUUID(), staff = randomUUID(), other = randomUUID(), customer = randomUUID();
  for (const [id, email] of [[owner,'owner@example.com'],[staff,'staff@example.com'],[other,'other@example.com'],[customer,'customer@example.com']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [id,email]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')", [id]);
  }
  async function as(id, sql, args = []) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec('set role authenticated');
    try { return (await db.query(sql,args)).rows; } finally { await db.exec('reset role'); }
  }
  const start = new Date(Date.now()-86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const key = generateLicense({ email: 'owner@example.com', start, months: 1 });
  await db.exec(key.sql);
  await t.test('keys are private and email-bound; valid redemption is idempotent', async () => {
    await assert.rejects(as(owner,'select * from private.license_keys'), /permission denied/);
    await assert.rejects(as(owner,"update public.subscriptions set status='active'"), /permission denied/);
    assert.equal((await as(other,'select public.redeem_license($1) result',[key.key]))[0].result.ok,false);
    for (let i=0;i<2;i++) assert.equal((await as(owner,'select public.redeem_license($1) result',[key.key]))[0].result.access.calendarLimit,5);
    assert.equal((await db.query('select redeemed_by from private.license_keys')).rows[0].redeemed_by,owner);
  });
  const business = (await as(owner,"select (public.create_business('Salon Test','Salon','București','')).id id"))[0].id;
  const setup = (await as(owner,"select public.setup_business($1,'Serviciu',30,10000,'Calendar 1','00:00','23:59',array[1,2,3,4,5,6,7]::smallint[]) result",[business]))[0].result;
  const calendarIds = [setup.resource_id];
  await t.test('five-calendar license allows five, refuses six and direct client mutation', async () => {
    for (let i=2;i<=5;i++) calendarIds.push((await as(owner,'select (public.add_calendar($1,$2)).id id',[business,`Calendar ${i}`]))[0].id);
    await assert.rejects(as(owner,"select public.add_calendar($1,'Calendar 6')",[business]), /Limita/);
    await assert.rejects(as(owner,"insert into public.resources(business_id,name) values($1,'Bypass')",[business]), /permission denied/);
  });
  let invitation;
  await t.test('invites are owner-only, email-bound, single-use and calendar-scoped', async () => {
    await assert.rejects(as(other,'select public.issue_calendar_invitation($1,$2,$3,$4)',[business,'staff@example.com',[calendarIds[0]],'viewer']), /Acces interzis/);
    invitation = (await as(owner,'select public.issue_calendar_invitation($1,$2,$3,$4) result',[business,'staff@example.com',[calendarIds[0]],'viewer']))[0].result;
    assert.equal((await as(other,'select public.accept_calendar_invitation($1) result',[invitation.token]))[0].result.ok,false);
    assert.equal((await as(staff,'select public.accept_calendar_invitation($1) result',[invitation.token]))[0].result.ok,true);
    assert.equal((await as(staff,'select public.accept_calendar_invitation($1) result',[invitation.token]))[0].result.ok,false);
    assert.equal((await as(staff,'select * from public.list_my_calendars($1)',[business])).length,1);
    assert.equal((await as(staff,'select public.get_access($1) result',[business]))[0].result.isOwner,false);
    await assert.rejects(as(staff,'select public.list_team($1)',[business]), /Acces interzis/);
  });
  let booking;
  const date = new Date(Date.now()+2*86400000); date.setUTCHours(9,0,0,0);
  await t.test('bookings and reports are protected by calendar RLS; viewer cannot modify', async () => {
    booking = (await as(customer,'select public.create_booking($1,$2,$3,$4,$5,60) id',[business,setup.event_type_id,calendarIds[0],date.toISOString(),'Client Test']))[0].id;
    await as(customer,'select public.create_booking($1,$2,$3,$4,$5,60)',[business,setup.event_type_id,calendarIds[1],date.toISOString(),'Alt Client']);
    assert.equal((await as(staff,'select * from public.bookings')).length,1);
    assert.equal((await as(other,'select * from public.bookings')).length,0);
    assert.equal((await as(owner,'select * from public.bookings')).length,2);
    const slots = await as(other,'select * from public.available_slots($1,$2,$3,$4)',[business,calendarIds[0],setup.event_type_id,date.toISOString().slice(0,10)]);
    assert.ok(slots.length > 0);
    assert.ok(slots.every(s => !('customer_name' in s) && new Date(s.start_at).getTime() !== date.getTime()));
    await assert.rejects(as(staff,"select public.set_booking_status($1,'completed')",[booking]), /Acces interzis/);
    await assert.rejects(as(customer,'select public.create_booking($1,$2,$3,$4,$5,60)',[business,setup.event_type_id,calendarIds[0],date.toISOString(),'Dublu Client']), /conflicting key|overlap/);
  });
  await t.test('revocation removes booking visibility and cancels queued staff reminders', async () => {
    await as(owner,"select public.set_member_access($1,$2,$3,'manager')",[business,staff,[calendarIds[0]]]);
    await as(staff,"select public.set_booking_status($1,'no_show')",[booking]);
    assert.equal((await as(staff,'select status from public.bookings'))[0].status,'no_show');
    await as(owner,"select public.set_member_access($1,$2,'{}'::uuid[],'viewer')",[business,staff]);
    assert.equal((await as(staff,'select * from public.bookings')).length,0);
    assert.equal((await as(staff,'select * from public.get_my_workspaces()')).length,0);
    const jobs = (await db.query('select status from public.notification_jobs where user_id=$1',[staff])).rows;
    assert.ok(jobs.length > 0); assert.ok(jobs.every(j => j.status === 'cancelled'));
  });
  await t.test('expiry blocks new bookings; history retained; paid small plan requires archiving', async () => {
    await db.query("update private.license_keys set starts_at=now()-interval '2 months'");
    assert.equal((await as(owner,'select public.get_access($1) result',[business]))[0].result.active,false);
    assert.equal((await as(owner,'select * from public.bookings')).length,2);
    await assert.rejects(as(customer,'select public.create_booking($1,$2,$3,$4,$5,60)',[business,setup.event_type_id,calendarIds[2],date.toISOString(),'Client Test']), /expirat/);
    await db.query("insert into public.subscriptions(owner_id,business_id,plan_id,product_id,status,environment,expires_at) values($1,$2,'small','rezerva_small_monthly','active','production',now()+interval '1 month')",[owner,business]);
    assert.equal((await as(owner,'select public.get_access($1) result',[business]))[0].result.overLimit,true);
    for (const id of calendarIds.slice(1)) await as(owner,'select public.set_calendar_active($1,false)',[id]);
    assert.equal((await as(owner,'select public.get_access($1) result',[business]))[0].result.overLimit,false);
    await assert.rejects(as(owner,'select public.set_calendar_active($1,true)',[calendarIds[1]]), /Limita/);
    assert.equal((await as(owner,'select * from public.bookings')).length,2);
  });
  await t.test('sandbox does not grant production access, even with active status', async () => {
    await db.query("update public.subscriptions set environment='sandbox'");
    assert.equal((await as(owner,'select public.get_access($1) result',[business]))[0].result.active,false);
  });
  await t.test('expired, revoked and unverified keys never grant access; no account transfer', async () => {
    await db.exec('delete from private.request_limits');
    assert.equal((await as(owner,'select public.redeem_license($1) result',[key.key]))[0].result.ok,false);
    const fresh = generateLicense({ email: 'owner@example.com', start, months: 1 });
    await db.exec(fresh.sql);
    await db.query('update auth.users set email_confirmed_at=null where id=$1',[owner]);
    assert.equal((await as(owner,'select public.redeem_license($1) result',[fresh.key]))[0].result.ok,false);
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[owner]);
    assert.equal((await as(owner,'select public.redeem_license($1) result',[fresh.key]))[0].result.ok,true);
    const replacementId = randomUUID();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now())",[replacementId]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[replacementId]);
    assert.equal((await as(replacementId,'select public.redeem_license($1) result',[fresh.key]))[0].result.ok,false);
    await db.query('update private.license_keys set revoked_at=now() where key_hash=$1',[fresh.hash]);
    assert.equal((await as(owner,'select public.redeem_license($1) result',[fresh.key]))[0].result.ok,false);
    assert.equal((await as(owner,'select public.get_access($1) result',[business]))[0].result.active,false);
  });
  await t.test('failed attempts persist across RPCs and throttle later guesses', async () => {
    for (let i=0;i<6;i++) await as(other,"select public.redeem_license('bad')");
    const result = (await as(other,'select public.redeem_license($1) result',[key.key]))[0].result;
    assert.match(result.message, /Prea multe/);
  });
  await t.test('future starts do not grant early access; month-end expiry uses calendar months', async () => {
    const future = generateLicense({ email: 'staff@example.com', start: '2099-01-31T00:00:00Z', months: 1 });
    await db.exec(future.sql);
    const result = (await as(staff,'select public.redeem_license($1) result',[future.key]))[0].result;
    assert.equal(result.ok,true); assert.equal(result.scheduled,true); assert.equal(result.access.active,false);
    assert.match(result.expiresAt,/2099-02-28/);
  });
});
