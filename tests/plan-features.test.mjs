// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { generateLicense } from '../tools/license-core.mjs';

test('Small/Complete feature entitlements: migration, report RPC and reminder delivery', async t => {
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
  const migrate = async file => db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  for (const file of ['001_initial_schema.sql','002_plans_licenses_invitations.sql','003_verified_enrollment.sql']) await migrate(file);
  const small=randomUUID(), complete=randomUUID(), staff=randomUUID(), customer=randomUUID(), outsider=randomUUID();
  for (const [id,email] of [[small,'small@example.com'],[complete,'complete@example.com'],[staff,'staff@example.com'],[customer,'customer@example.com'],[outsider,'davidnicolaparaschiv@gmail.com']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[id]);
  }
  async function as(id,sql,args=[],role='authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    await db.exec('set role '+role);
    try { return (await db.query(sql,args)).rows; } finally { await db.exec('reset role'); }
  }
  const scalar = async (id,sql,args=[],role='authenticated') => (await as(id,sql,args,role))[0].result;
  const access = (user,business=null) => scalar(user,'select public.get_access($1) result',[business]);
  const smallBusiness=randomUUID(), largeBusiness=randomUUID();
  const calendars=[randomUUID(),randomUUID(),randomUUID()];
  const events=[randomUUID(),randomUUID()];
  for (const [owner,business,plan] of [[small,smallBusiness,'small'],[complete,largeBusiness,'large']]) {
    await db.query("insert into public.businesses(id,owner_id,name,category,address) values($1,$2,'Salon Test','Salon','București')",[business,owner]);
    await db.query("insert into public.subscriptions(owner_id,business_id,plan_id,product_id,status,environment,expires_at) values($1,$2,$3,$4,'active','production',now()+interval '1 month')",[owner,business,plan,'rezerva_'+plan+'_monthly']);
  }
  for (let i=0;i<3;i++) {
    const business=i===0?smallBusiness:largeBusiness;
    await db.query("insert into public.resources(id,business_id,name) values($1,$2,'Calendar')",[calendars[i],business]);
    for(let day=1;day<=7;day++) await db.query("insert into public.availability_rules(business_id,resource_id,weekday,start_time,end_time) values($1,$2,$3,'00:00','23:59')",[business,calendars[i],day]);
  }
  for (let i=0;i<2;i++) await db.query("insert into public.event_types(id,business_id,name,duration_minutes) values($1,$2,'Serviciu',30)",[events[i],i===0?smallBusiness:largeBusiness]);
  await db.query("insert into public.business_members(business_id,user_id,role) values($1,$2,'staff')",[largeBusiness,staff]);
  await as(complete,"select public.set_member_access($1,$2,$3,'viewer')",[largeBusiness,staff,[calendars[1]]]);
  const date=new Date(Date.now()+2*86400000); date.setUTCHours(9,0,0,0);
  const day=date.toISOString().slice(0,10);
  const book=(i,user=customer,time=date.toISOString()) => scalar(user,'select public.create_booking($1,$2,$3,$4,$5,60) result',[i===0?smallBusiness:largeBusiness,events[i===0?0:1],calendars[i],time,'Client Test']);
  const smallBooking=await book(0), largeBooking=await book(1); await book(2);
  assert.equal((await db.query("select status from public.notification_jobs where booking_id=$1 and user_id=$2",[smallBooking,small])).rows[0].status,'pending');
  await migrate('004_team_features.sql');
  await migrate('006_universal_developer_license.sql');
  await migrate('009_access_expiry_and_permanent_dev.sql');
  await migrate('010_team_plan_and_member_limit.sql');
  await migrate('011_all_team_calendars_shared.sql');
  await migrate('025_complete_calendars_and_license_types.sql');
  const allowed=(booking,user) => scalar(customer,'select public.notification_recipient_allowed($1,$2) result',[booking,user],'service_role');
  const report=(user,business,calendar=null,from=day,until=day,offset=0) => as(user,'select * from public.get_business_report($1,$2,$3,$4,$5)',[business,from,until,calendar,offset]);

  await t.test('migration preserves customer jobs/history and cancels old Small business jobs', async () => {
    const jobs=(await db.query('select user_id,status from public.notification_jobs where booking_id=$1',[smallBooking])).rows;
    assert.equal(jobs.find(j=>j.user_id===small).status,'cancelled');
    assert.equal(jobs.find(j=>j.user_id===customer).status,'pending');
    assert.equal((await as(small,'select * from public.bookings')).length,1);
    assert.deepEqual((await access(small,smallBusiness)).features,{reports:false,businessNotifications:false});
    assert.deepEqual((await access(staff,largeBusiness)).features,{reports:true,businessNotifications:true});
  });
  await t.test('Small report API is blocked; Complete report respects membership and calendar/date bounds', async () => {
    await assert.rejects(report(small,smallBusiness),/Complete/);
    await assert.rejects(report(outsider,largeBusiness),/Acces interzis/);
    await assert.rejects(report(customer,largeBusiness),/Acces interzis/);
    assert.equal((await report(complete,largeBusiness)).length,2);
    const staffRows=await report(staff,largeBusiness);
    assert.equal(staffRows.length,2);
    assert.deepEqual(new Set(staffRows.map(row=>row.resource_id)),new Set([calendars[1],calendars[2]]));
    assert.equal((await report(staff,largeBusiness,calendars[2])).length,1);
    await assert.rejects(report(complete,largeBusiness,calendars[0]),/Acces interzis/);
    assert.equal((await report(complete,largeBusiness,null,day,day,500)).length,0);
    await assert.rejects(report(complete,largeBusiness,null,day,day,-1),/Perioadă invalidă/);
    await assert.rejects(report(complete,largeBusiness,null,'2020-01-01','2022-01-01'),/Perioadă invalidă/);
  });
  await t.test('Team flow requires Complete and counts accepted members, not pending invitations', async () => {
    await assert.rejects(
      scalar(small,'select public.issue_calendar_invitation($1,$2,$3,$4) result',[smallBusiness,'new@example.com',[calendars[0]],'viewer']),
      /Team flow necesită planul Complete/
    );

    // One staff member already exists. Fourteen more fill the 15 accepted seats.
    for(let i=1;i<15;i++) {
      const id=randomUUID();
      await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,`staff${i}@example.com`]);
      await db.query("insert into public.business_members(business_id,user_id,role) values($1,$2,'staff')",[largeBusiness,id]);
    }
    const sixteenth=randomUUID();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'staff16@example.com',now())",[sixteenth]);
    await assert.rejects(
      db.query("insert into public.business_members(business_id,user_id,role) values($1,$2,'staff')",[largeBusiness,sixteenth]),
      /maximum 15 membri acceptați/
    );

    // A pending invitation is still allowed at 15 accepted members and does not consume a seat.
    const invite=await scalar(complete,'select public.issue_calendar_invitation($1,$2,$3,$4) result',[largeBusiness,'pending@example.com',[calendars[1]],'viewer']);
    assert.match(invite.token,/^RZI-/);
    assert.equal((await db.query("select count(*)::int count from private.calendar_invitations where business_id=$1 and accepted_at is null",[largeBusiness])).rows[0].count,1);
  });
  await t.test('Small queues customer only; Complete queues all shared staff and owner; dual-role customer stays eligible', async () => {
    const next=await book(0,customer,new Date(date.getTime()+3600000).toISOString());
    const jobs=(await db.query('select user_id from public.notification_jobs where booking_id=$1',[next])).rows;
    assert.deepEqual(jobs.map(j=>j.user_id),[customer]);
    assert.equal(await allowed(largeBooking,complete),true);
    assert.equal(await allowed(largeBooking,staff),true);
    assert.equal(await allowed(largeBooking,outsider),false);
    const own=await book(0,small,new Date(date.getTime()+7200000).toISOString());
    assert.equal(await allowed(own,small),true);
  });
  await t.test('downgrade and expiry recheck queued jobs and reports without deleting calendar history', async () => {
    await db.query("update public.subscriptions set plan_id='small' where owner_id=$1",[complete]);
    assert.equal(await scalar(complete,'select public.can_read_calendar($1) result',[calendars[1]]),true);
    assert.equal(await scalar(staff,'select public.can_read_calendar($1) result',[calendars[1]]),false);
    assert.equal(await allowed(largeBooking,complete),false);
    assert.equal(await allowed(largeBooking,staff),false);
    assert.equal(await allowed(largeBooking,customer),true);
    await assert.rejects(report(staff,largeBusiness),/Complete/);
    assert.equal((await as(complete,'select * from public.bookings')).length,2);
    await db.query("update public.subscriptions set plan_id='large',expires_at=now()-interval '1 second' where owner_id=$1",[complete]);
    assert.equal((await access(complete,largeBusiness)).features.reports,false);
    await assert.rejects(report(complete,largeBusiness),/Complete/);
    assert.equal(await allowed(largeBooking,complete),false);
    assert.equal(await scalar(complete,'select public.can_read_calendar($1) result',[calendars[1]]),false);
    assert.equal((await as(complete,'select * from public.bookings')).length,0);
  });
  await t.test('active licenses and universal developer grants retain Complete features', async () => {
    const license=generateLicense({email:'complete@example.com',start:new Date(Date.now()-3600000).toISOString().replace(/\.\d{3}Z$/,'Z'),months:1,type:'Complete'});
    await db.exec(license.sql);
    assert.equal((await scalar(complete,'select public.redeem_license($1) result',[license.key])).ok,true);
    assert.equal((await access(complete,largeBusiness)).features.reports,true);
    assert.equal((await report(staff,largeBusiness)).length,2);
    assert.equal(await allowed(largeBooking,staff),true);
    assert.equal((await scalar(outsider,"select public.redeem_license('dev112233') result")).ok,true);
    assert.equal((await access(outsider)).features.businessNotifications,true);
    await db.query('update private.license_keys set revoked_at=now()');
    assert.equal(await allowed(largeBooking,staff),false);
  });
  await t.test('opt-out and worker-only permissions remain enforced', async () => {
    await as(customer,"insert into public.notification_preferences(user_id,push_enabled) values($1,false)",[customer]);
    assert.equal(await allowed(largeBooking,customer),false);
    await assert.rejects(scalar(customer,'select public.notification_recipient_allowed($1,$2) result',[largeBooking,customer]),/permission denied/);
    await assert.rejects(as(outsider,'select private.business_has_team_features($1)',[largeBusiness]),/permission denied/);
    await assert.rejects(as(outsider,'select * from public.get_business_report($1,$2,$3)',[largeBusiness,day,day],'anon'),/permission denied/);
  });
});
