// @ts-check
// Real SQL in local PostgreSQL/PGlite. No hosted DB, SMS, FCM or purchases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { parseReservationQr, rememberReservationQr, takePendingReservationQr, hasPendingReservationQr, clearPendingReservationQr } from '../src/services/qr-session.js';

test('QR parsing: only reservation links/tokens; duplicates and arbitrary URLs rejected', () => {
  const token = 'RZB-' + 'A'.repeat(64), link = 'ro.rezerva.app://reservation?token=' + token;
  assert.equal(parseReservationQr(link), token); assert.equal(parseReservationQr(token), token);
  for (const value of [null, '', 'https://example.com/?token='+token, 'javascript:alert(1)',
    link+'&token='+token, link+'&name=David', link+'#extra', link.replace('reservation?', 'reservation/path?'),
    link.replace('://', '://evil@'), link.replace('reservation?', 'invite?'), link.replace('A', 'G'), 'x'.repeat(201)]) {
    assert.throws(() => parseReservationQr(value));
  }
  rememberReservationQr(link); assert.equal(hasPendingReservationQr(), true);
  assert.equal(takePendingReservationQr(), token); assert.equal(hasPendingReservationQr(), false);
  rememberReservationQr(link); clearPendingReservationQr(); assert.equal(takePendingReservationQr(), '');
});

test('Reservation QR SQL: customer display, tenant/calendar authorization, status and throttling', async t => {
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
  const migrate = async name => db.exec(await readFile(new URL('../supabase/migrations/'+name, import.meta.url), 'utf8'));
  for (const file of ['001_initial_schema.sql','002_plans_licenses_invitations.sql','003_verified_enrollment.sql','004_team_features.sql','011_all_team_calendars_shared.sql']) await migrate(file);
  const people = Object.fromEntries(['small','large','staff','customer','other','unverified'].map(name => [name, randomUUID()]));
  for (const [name,id] of Object.entries(people)) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',[id,name+'@example.invalid',name==='unverified'?null:new Date()]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[id]);
  }
  async function as(name, sql, args = [], role = 'authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[people[name] || '']);
    await db.exec('set role '+role);
    try { return (await db.query(sql,args)).rows; } finally { await db.exec('reset role'); }
  }
  const scalar = async (...args) => (await as(...args))[0].result;
  const biz = { small: randomUUID(), large: randomUUID() }, setup = {};
  for (const plan of ['small','large']) {
    await db.query("insert into public.businesses(id,owner_id,name,category,address) values($1,$2,$3,'Salon','București')",[biz[plan],people[plan],'Salon '+plan]);
    await db.query("insert into public.subscriptions(owner_id,business_id,plan_id,product_id,status,environment,expires_at) values($1,$2,$3,$4,'active','production',now()+interval '1 month')",[people[plan],biz[plan],plan,'rezerva_'+plan+'_monthly']);
    setup[plan] = await scalar(plan,"select public.setup_business($1,'Serviciu',30,10000,'Calendar','00:00','23:59',array[1,2,3,4,5,6,7]::smallint[]) result",[biz[plan]]);
  }
  const second = (await as('large',"select (public.add_calendar($1,'Calendar 2')).id",[biz.large]))[0].id;
  const time = new Date(Date.now()+2*86400000); time.setUTCHours(9,0,0,0);
  // Existing bookings created before 005 must work without a destructive backfill.
  const bookings = {};
  for (const [name,plan,calendar] of [['small','small',setup.small.resource_id],['large','large',setup.large.resource_id],['second','large',second]]) {
    if (name==='second') for(let day=1;day<=7;day++) await db.query("insert into public.availability_rules(business_id,resource_id,weekday,start_time,end_time) values($1,$2,$3,'00:00','23:59')",[biz.large,second,day]);
    bookings[name] = await scalar('customer','select public.create_booking($1,$2,$3,$4,$5,5) result',[biz[plan],setup[plan].event_type_id,calendar,time.toISOString(),'Client Test']);
  }
  await db.query("insert into public.business_members(business_id,user_id,role) values($1,$2,'staff')",[biz.large,people.staff]);
  await as('large',"select public.set_member_access($1,$2,$3,'viewer')",[biz.large,people.staff,[setup.large.resource_id]]);
  await migrate('005_reservation_qr.sql');
  const get = (who,id) => scalar(who,'select public.get_customer_booking_qr($1) result',[id]);
  const resolve = (who,token,business=null) => scalar(who,'select public.resolve_booking_qr($1,$2) result',[token,business]);
  const codes = {};

  await t.test('only the customer retrieves a stable, unique QR; no PII is encoded', async () => {
    for (const [name,id] of Object.entries(bookings)) {
      const qr = await get('customer',id); assert.equal(qr.ok,true);
      assert.equal(qr.booking.id,id); assert.equal(qr.booking.customer,'Client Test');
      codes[name] = parseReservationQr(qr.payload);
      assert(!qr.payload.includes('Client')); assert(!qr.payload.includes('@'));
      assert.equal((await get('customer',id)).payload,qr.payload);
      assert.equal((await get('other',id)).ok,false);
      assert.equal((await get(name==='small'?'small':'large',id)).ok,false);
    }
    assert.equal(new Set(Object.values(codes)).size,3);
    assert.equal((await db.query('select count(*)::int n from private.booking_qr_tokens')).rows[0].n,3);
    await assert.rejects(as('customer','select * from private.booking_qr_tokens'),/permission denied/);
    await assert.rejects(as('small','update private.booking_qr_tokens set token=token'),/permission denied/);
  });
  await t.test('Small and Complete owners can look up; customers and other companies cannot', async () => {
    for (const plan of ['small','large']) {
      const result = await resolve(plan,codes[plan],biz[plan]);
      assert.equal(result.ok,true); assert.equal(result.booking.id,bookings[plan]);
      assert.equal(result.booking.email,'customer@example.invalid');
      assert(!('payload' in result)); assert(!('token' in result.booking));
      assert.equal((await resolve('customer',codes[plan])).ok,false);
      assert.equal((await resolve('other',codes[plan])).ok,false);
    }
    assert.equal((await resolve('small',codes.large)).ok,false);
    assert.equal((await resolve('large',codes.large,biz.small)).ok,false);
  });
  await t.test('staff lookup includes every shared calendar; revocation takes effect immediately', async () => {
    assert.equal((await resolve('staff',codes.large)).ok,true);
    assert.equal((await resolve('staff',codes.second)).ok,true);
    await as('large',"select public.set_member_access($1,$2,'{}'::uuid[],'viewer')",[biz.large,people.staff]);
    assert.equal((await resolve('staff',codes.large)).ok,false);
  });
  await t.test('scanning is read-only, repeatable, and shows actual cancelled/completed status', async () => {
    for (const status of ['cancelled','completed','no_show','confirmed']) {
      await db.query('update public.bookings set status=$1 where id=$2',[status,bookings.large]);
      const before = (await db.query('select status,updated_at from public.bookings where id=$1',[bookings.large])).rows[0];
      for(let i=0;i<2;i++) assert.equal((await resolve('large',codes.large)).booking.status,status);
      assert.deepEqual((await db.query('select status,updated_at from public.bookings where id=$1',[bookings.large])).rows[0],before);
    }
    await db.query("update public.subscriptions set expires_at=now()-interval '1 minute' where owner_id=$1",[people.large]);
    assert.equal((await resolve('large',codes.large)).ok,true, 'Read-only historical access matches calendar policy');
  });
  await t.test('unknown/tampered tokens share a generic error; invalid attempts stay counted', async () => {
    const messages=[];
    for(const token of [null,"' OR 1=1 --",'RZB-'+'0'.repeat(64),codes.small+'X']) messages.push((await resolve('other',token)).message);
    assert.equal(new Set(messages).size,1);
    await db.query("delete from private.request_limits where user_id=$1 and scope='booking_qr_scan'",[people.other]);
    for(let i=0;i<120;i++) assert.equal((await resolve('other','bad')).ok,false);
    assert.match((await resolve('other','bad')).message,/Prea multe/);
    assert.equal((await db.query("select attempts from private.request_limits where user_id=$1 and scope='booking_qr_scan'",[people.other])).rows[0].attempts,121);
  });
  await t.test('anonymous and unverified accounts cannot display or resolve', async () => {
    await assert.rejects(scalar('', 'select public.get_customer_booking_qr($1) result',[bookings.small],'anon'),/permission denied/);
    await assert.rejects(scalar('', 'select public.resolve_booking_qr($1) result',[codes.small],'anon'),/permission denied/);
    assert.equal((await get('unverified',bookings.small)).ok,false);
    assert.equal((await resolve('unverified',codes.small)).ok,false);
  });
});
