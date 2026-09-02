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
  for (const file of ['001_initial_schema.sql','002_plans_licenses_invitations.sql','003_verified_enrollment.sql','004_team_features.sql','006_universal_developer_license.sql','007_approval_email_details.sql','008_owner_approval_codes.sql','009_access_expiry_and_permanent_dev.sql','010_team_plan_and_member_limit.sql','011_all_team_calendars_shared.sql','012_booking_rejected_status.sql','013_customer_profiles_booking_approval.sql','014_drawn_screens_service_calendar.sql','015_calendar_service_settings.sql','016_strict_entitlement_lock.sql','017_account_roles_calendar_delete.sql','018_booking_schedule_views_and_notifications.sql','019_customer_confirmed_reminders_and_invite_privacy.sql','020_team_operational_access_and_phone_uniqueness.sql','021_account_type_resolution.sql','023_notification_preferences_and_job_types.sql','025_complete_calendars_and_license_types.sql','026_notification_preference_save_updates_jobs.sql','027_simplify_logger_action_types.sql','028_owner_delete_invitee_account.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const admin=randomUUID(), owner=randomUUID(), attacker=randomUUID(), invited=randomUUID(), removedInvitee=randomUUID(), phoneUser=randomUUID();
  for (const [id,email] of [[admin,'davidnicolaparaschiv@gmail.com'],[owner,'business@example.com'],[attacker,'other@example.com'],[invited,'invited@example.com'],[removedInvitee,'removed@example.com'],[phoneUser,'phone@example.com']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[id]);
  }
  async function as(id,sql,params=[],role='authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('set role '+role);
    try { return (await db.query(sql,params)).rows; } finally { await db.exec('reset role'); }
  }
  const call = async (id,name,params=[],role='authenticated') => (await as(id,'select public.'+name+'('+params.map((_,i)=>'$'+(i+1)).join(',')+') result',params,role))[0].result;
  const issue = (id,kind) => call(admin,'issue_enrollment_link',[id,owner,kind],'service_role');
  let request, emailLink, approvalLink, businessId, teamInvitation;
  const sid = 'VE'+'a'.repeat(32);

  await t.test('protected settings remain private and the developer key works for every verified Google account', async () => {
    assert.equal(await call(admin,'is_platform_owner_account'),true);
    assert.equal(await call(owner,'is_platform_owner_account'),false);
    await assert.rejects(as(attacker,"update private.platform_settings set owner_email='other@example.com'"),/permission denied/);
    await assert.rejects(db.query("update private.platform_settings set owner_email='other@example.com'"),/check constraint/);
    assert.equal((await call(attacker,'redeem_license',['dev112233'])).access.calendarLimit,10);
    assert.equal((await call(attacker,'get_access',[])).source,'developer');
    assert.equal((await call(attacker,'get_access',[])).expiresAt,'infinity');
    assert.equal((await call(admin,'redeem_license',['dev112233'])).access.calendarLimit,10);
    assert.equal((await call(admin,'get_access',[])).source,'developer');
    assert.equal((await call(owner,'get_access',[])).active,false);
    await db.query('update auth.users set email_confirmed_at=null where id=$1',[admin]);
    assert.equal((await call(admin,'redeem_license',['dev112233'])).ok,false);
    assert.equal((await call(admin,'get_access',[])).active,false);
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[admin]);
    await assert.rejects(call(admin,'create_business',['Bypass','Salon','București','0712345678']),/verificare/);
  });
  await t.test('CUI and phone are required; contact email comes from the verified Google account', async () => {
    await assert.rejects(call(owner,'start_enrollment',['Salon','Salon','București','','0712345678']),/Completează/);
    await assert.rejects(call(owner,'start_enrollment',['Salon','Salon','București','12345678','']),/Completează/);
    request = await call(owner,'start_enrollment',['Salon Test','Salon','București','RO12345678','0712345678']);
    await assert.rejects(call(attacker,'start_enrollment',['Duplicat','Salon','București','12345678','0799999999']),/Există deja.*CUI/);
    assert.equal(request.ok,true);
    assert.equal((await db.query('select * from public.businesses')).rows.length,0);
    await assert.rejects(as(owner,'select * from private.enrollment_requests'),/permission denied/);
    assert.equal((await call(attacker,'get_enrollment_status',[])),null);
    await assert.rejects(call(owner,'create_business',['Bypass','Salon','București','0712345678']),/verificare/);
    await assert.rejects(call(owner,'enrollment_sms_context',[request.id,false]),/mai întâi/);
    await assert.rejects(call(owner,'enrollment_record_sms',[request.id,owner,sid,true]),/permission denied/);
    assert.equal((await issue(request.id,'approval')).ok,false);
    assert.equal((await call(owner,'complete_customer_profile',['Ion','Client'])).completed,true);
    assert.equal(await call(owner,'get_account_role',[]),'client');
  });
  await t.test('email link is account-bound, single-use, and not an approval', async () => {
    emailLink = await issue(request.id,'email');
    const firstToken = emailLink.token;
    emailLink = await issue(request.id,'email');
    await assert.rejects(call(owner,'enrollment_link_details',[firstToken]),/indisponibil|expirat/);
    const lifetime = (await db.query("select expires_at>now()+interval '29 days' valid from private.enrollment_links where token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')",[emailLink.token])).rows[0].valid;
    assert.equal(lifetime,true);
    assert.equal(emailLink.recipient,'business@example.com');
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
    businessId=result.businessId;
    const businesses=(await db.query('select * from public.businesses')).rows;
    assert.equal(businesses.length,1); assert.equal(businesses[0].owner_id,owner);
    assert.equal(businesses[0].cui,'12345678'); assert.equal(businesses[0].contact_email,'business@example.com');
    assert.ok(businesses[0].phone_verified_at); assert.equal(businesses[0].approved_by,admin);
    assert.equal(await call(owner,'get_account_role',[]),'business');
    assert.equal((await call(owner,'get_customer_profile',[])).completed,false);
    await assert.rejects(call(owner,'complete_customer_profile',['Ion','Client']),/asociat unei afaceri/);
    assert.equal((await call(admin,'confirm_enrollment_link',[approvalLink.token,true])).ok,false);
    await assert.rejects(as(owner,"update public.businesses set phone='0799999999'"),/permission denied/);
    assert.equal((await call(owner,'get_access',[result.businessId])).active,false);
  });
  await t.test('superseded/expired email links fail, developer grant can be revoked', async () => {
    const r=await call(attacker,'start_enrollment',['Alt Salon','Salon','București','87654321','0799999999']);
    const link=await call(admin,'issue_enrollment_link',[r.id,attacker,'email'],'service_role');
    const next=await call(attacker,'start_enrollment',['Corectat Salon','Salon','București','87654321','0799999999']);
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
    const key=generateLicense({email:'business@example.com',start:new Date(Date.now()-86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),months:1,type:'Complete'});
    await db.exec(key.sql);
    assert.equal((await call(owner,'redeem_license',[key.key])).ok,true);
    assert.equal((await call(owner,'get_access',[])).source,'license');
    const rejected=await call(attacker,'redeem_license',[key.key]);
    assert.equal(rejected.ok,false);
    assert.equal(rejected.message,'Licență invalidă.');
  });
  await t.test('invitation failures reveal no account or invitation details',async()=>{
    teamInvitation=await call(owner,'issue_calendar_invitation',[businessId,'invited@example.com',[],'viewer']);
    assert.equal(teamInvitation.ok,true);
    assert.deepEqual(await call(attacker,'accept_calendar_invitation',[teamInvitation.token]),{ok:false,message:'Cod invalid.'});
    assert.deepEqual(await call(attacker,'accept_calendar_invitation',['RZI-'+'A'.repeat(64)]),{ok:false,message:'Cod invalid.'});
  });
  await t.test('only the owner deletes an invitee persona and the same Auth account can start again',async()=>{
    await db.query("insert into public.business_members(business_id,user_id,role) values($1,$2,'staff')",[businessId,removedInvitee]);
    await db.query("update public.profiles set display_name='Invitat Șters',first_name='Invitat',last_name='Șters',customer_profile_completed_at=now() where id=$1",[removedInvitee]);
    await db.query("insert into public.device_tokens(user_id,token,platform) values($1,'removed-device','android')",[removedInvitee]);
    await db.query("insert into public.client_notification_preferences(user_id,default_minutes,push_enabled) values($1,30,true) on conflict(user_id) do update set default_minutes=30",[removedInvitee]);
    await assert.rejects(call(removedInvitee,'delete_invitee_account',[businessId,removedInvitee]),/Doar proprietarul/);
    await assert.rejects(call(owner,'delete_invitee_account',[businessId,owner]),/Proprietarul nu poate fi șters/);

    assert.deepEqual(await call(owner,'delete_invitee_account',[businessId,removedInvitee]),{ok:true});
    assert.equal((await db.query('select count(*)::int count from public.business_members where user_id=$1',[removedInvitee])).rows[0].count,0);
    assert.equal((await db.query('select count(*)::int count from public.calendar_members where user_id=$1',[removedInvitee])).rows[0].count,0);
    assert.equal((await db.query('select count(*)::int count from public.device_tokens where user_id=$1',[removedInvitee])).rows[0].count,0);
    assert.equal((await db.query('select count(*)::int count from public.client_notification_preferences where user_id=$1',[removedInvitee])).rows[0].count,0);
    assert.deepEqual((await db.query('select display_name,first_name,last_name,customer_profile_completed_at from public.profiles where id=$1',[removedInvitee])).rows[0],{
      display_name:'',first_name:null,last_name:null,customer_profile_completed_at:null,
    });
    assert.equal((await db.query('select count(*)::int count from auth.users where id=$1',[removedInvitee])).rows[0].count,1);
    assert.deepEqual((await db.query('select reset_by,reason from public.account_reset_events where user_id=$1',[removedInvitee])).rows[0],{reset_by:owner,reason:'invitee_deleted'});
    assert.equal(await call(removedInvitee,'get_account_role',[]),'unassigned');
    assert.equal((await call(removedInvitee,'complete_customer_profile',['Cont','Nou'])).completed,true);
    assert.equal(await call(removedInvitee,'get_account_role',[]),'client');
  });
  await t.test('a Romanian phone number cannot enroll a second business',async()=>{
    await assert.rejects(call(phoneUser,'start_enrollment',['Altă firmă','Salon','București','99887766','+40 712 345 678']),/Numărul de telefon este deja folosit/);
  });
  await t.test('customer identity is stored once; booking approval and Romanian notification jobs are durable',async()=>{
    const profile=await call(attacker,'complete_customer_profile',['Ana','Client']);
    assert.equal(profile.completed,true);
    const unchanged=await call(attacker,'complete_customer_profile',['Alt','Nume']);
    assert.equal(unchanged.firstName,'Ana');
    assert.equal(unchanged.lastName,'Client');
    const persisted=await call(attacker,'get_customer_profile',[]);
    assert.deepEqual(persisted,{firstName:'Ana',lastName:'Client',completed:true});
    const setup=await call(owner,'setup_business',[businessId,'Tuns',30,10000,'Calendar principal','00:00','23:59',[1,2,3,4,5,6,7]]);
    const settings=await call(owner,'save_calendar_service_settings',[businessId,setup.resource_id,[1,2,3,4,5,6,7],'09:00','10:00',20]);
    assert.equal(settings.durationMinutes,20);
    assert.deepEqual(settings.weekdays,[1,2,3,4,5,6,7]);
    const slotDate=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    const slots=await as(attacker,'select * from public.available_slots($1,$2,$3,$4)',[businessId,setup.resource_id,setup.event_type_id,slotDate]);
    const localTimes=slots.map(slot=>new Intl.DateTimeFormat('ro-RO',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Bucharest'}).format(new Date(slot.start_at)));
    assert.deepEqual(localTimes,['09:00','09:20','09:40']);
    await call(owner,'save_calendar_service_settings',[businessId,setup.resource_id,[1,2,3,4,5,6,7],'00:00','23:59',40]);
    const start=new Date(Date.now()+2*86400000); start.setUTCHours(10,0,0,0);
    const bookingId=await call(attacker,'create_booking',[businessId,setup.event_type_id,setup.resource_id,start.toISOString(),'Nume ignorat',60]);
    await assert.rejects(call(owner,'save_calendar_service_settings',[businessId,setup.resource_id,[1,2,3,4,5,6,7],'09:00','11:00',30]),/programări în așteptare sau aprobate/);
    assert.equal((await as(owner,'select * from public.get_business_report($1,$2,$3,$4,$5)',[businessId,start.toISOString().slice(0,10),start.toISOString().slice(0,10),null,0])).length,0);
    await assert.rejects(call(owner,'delete_calendar',[businessId,setup.resource_id]),/are programări/);
    await assert.rejects(call(attacker,'create_booking',[businessId,setup.event_type_id,setup.resource_id,start.toISOString(),'Nume ignorat',60]),/nu mai este disponibil/);
    assert.equal((await as(attacker,'select status from public.bookings where id=$1',[bookingId]))[0].status,'pending');
    const requestJobs=(await db.query("select title,body,target_route,type from public.notification_jobs where booking_id=$1 and kind='booking_request'",[bookingId])).rows;
    assert.equal(requestJobs.length,1);
    assert.match(requestJobs[0].body,/Ana Client/);
    assert.equal(requestJobs[0].target_route,'/business/notifications');
    assert.equal(requestJobs[0].type,'business');
    assert.equal((await db.query("select count(*)::int count from public.notification_jobs where booking_id=$1 and user_id=$2 and kind='reminder' and status='pending'",[bookingId,attacker])).rows[0].count,0);
    assert.equal((await call(invited,'accept_calendar_invitation',[teamInvitation.token])).ok,true);
    assert.equal(await call(invited,'get_account_role',[]),'invitee');
    const invitedTeam=await call(invited,'list_team',[businessId]);
    assert.equal(invitedTeam.members.length,2);
    assert(invitedTeam.members.some(member=>member.email==='business@example.com'));
    assert(invitedTeam.members.some(member=>member.email==='invited@example.com'));
    assert.equal(invitedTeam.invitations.length,0);
    assert.equal(await call(invited,'can_manage_calendar',[setup.resource_id]),true);
    await call(invited,'set_calendar_notification_minutes',[setup.resource_id,7]);
    assert.equal((await db.query('select minutes_before from public.business_notification_preferences where calendar_id=$1',[setup.resource_id])).rows[0].minutes_before,7);
    await call(invited,'add_calendar',[businessId,'Calendar invitat']);
    const invitedCalendarId=(await db.query("select id from public.resources where business_id=$1 and name='Calendar invitat'",[businessId])).rows[0].id;
    assert.equal((await call(invited,'delete_calendar',[businessId,invitedCalendarId])).ok,true);
    await call(invited,'set_booking_status',[bookingId,'confirmed']);
    assert.equal((await as(attacker,'select status from public.bookings where id=$1',[bookingId]))[0].status,'confirmed');
    const statusJobs=(await db.query("select title,target_route,type from public.notification_jobs where booking_id=$1 and kind='status_update'",[bookingId])).rows;
    assert.equal(statusJobs.length,1);
    assert.equal(statusJobs[0].title,'Programare confirmată');
    assert.equal(statusJobs[0].target_route,'/customer/notifications');
    assert.equal(statusJobs[0].type,'client');
    const reminderJobs=(await db.query("select id,title,target_route,status,type from public.notification_jobs where booking_id=$1 and user_id=$2 and kind='reminder'",[bookingId,attacker])).rows;
    assert.equal(reminderJobs.length,1);
    assert.equal(reminderJobs[0].title,'Programarea ta se apropie');
    assert.equal(reminderJobs[0].target_route,'/customer/notifications');
    assert.equal(reminderJobs[0].status,'pending');
    assert.equal(reminderJobs[0].type,'client');

    // Scope fixture: the same CV has another confirmed booking on another
    // calendar. Saving CV preferences must update both client reminders, but
    // it must not touch a business reminder from that other calendar.
    await call(owner,'add_calendar',[businessId,'Calendar scope test']);
    const scopeCalendarId=(await db.query("select id from public.resources where business_id=$1 and name='Calendar scope test'",[businessId])).rows[0].id;
    const scopeStart=new Date(start.getTime()+4*86400000);
    const scopeBookingId=randomUUID();
    await db.query(`insert into public.bookings(
      id,business_id,customer_id,event_type_id,resource_id,start_at,end_at,
      customer_name,customer_email_snapshot,status
    ) values($1,$2,$3,$4,$5,$6,$7,'Ana Client','other@example.com','confirmed')`,[
      scopeBookingId,businessId,attacker,setup.event_type_id,scopeCalendarId,
      scopeStart.toISOString(),new Date(scopeStart.getTime()+60*60000).toISOString()
    ]);
    const scopeClientJobId=randomUUID(),scopeBusinessJobId=randomUUID();
    const scopeOriginalSend=new Date(scopeStart.getTime()-60*60000).toISOString();
    await db.query(`insert into public.notification_jobs(
      id,booking_id,user_id,send_at,title,body,status,attempts,last_error,kind,target_route,type
    ) values
      ($1,$2,$3,$4,'Client scope','Client scope','failed',3,'old client error','reminder','/customer/notifications','client'),
      ($5,$2,$6,$4,'Business scope','Business scope','sent',2,'old business error','reminder','/business/notifications','business')`,[
      scopeClientJobId,scopeBookingId,attacker,scopeOriginalSend,scopeBusinessJobId,owner
    ]);
    const nearStart=new Date(Date.now()+6*60000),nearBookingId=randomUUID();
    const nearClientJobId=randomUUID(),nearBusinessJobId=randomUUID();
    await db.query(`insert into public.bookings(
      id,business_id,customer_id,event_type_id,resource_id,start_at,end_at,
      customer_name,customer_email_snapshot,status
    ) values($1,$2,$3,$4,$5,$6,$7,'Ana Client','other@example.com','confirmed')`,[
      nearBookingId,businessId,attacker,setup.event_type_id,scopeCalendarId,
      nearStart.toISOString(),new Date(nearStart.getTime()+30*60000).toISOString()
    ]);
    await db.query(`insert into public.notification_jobs(
      id,booking_id,user_id,send_at,title,body,kind,target_route,type
    ) values
      ($1,$2,$3,$4,'Client near','Client near','reminder','/customer/notifications','client'),
      ($5,$2,$6,$4,'Business near','Business near','reminder','/business/notifications','business')`,[
      nearClientJobId,nearBookingId,attacker,new Date(nearStart.getTime()-60000).toISOString(),nearBusinessJobId,owner
    ]);

    await call(attacker,'set_client_notification_preferences',[90,true]);
    const updatedClientReminder=(await db.query("select id,send_at,type from public.notification_jobs where booking_id=$1 and user_id=$2 and kind='reminder'",[bookingId,attacker])).rows[0];
    assert.equal(updatedClientReminder.id,reminderJobs[0].id);
    assert.equal(updatedClientReminder.type,'client');
    assert.equal(new Date(updatedClientReminder.send_at).getTime(),start.getTime()-90*60000);
    const updatedScopeClient=(await db.query("select id,send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeClientJobId])).rows[0];
    assert.equal(updatedScopeClient.id,scopeClientJobId);
    assert.equal(new Date(updatedScopeClient.send_at).getTime(),scopeStart.getTime()-90*60000);
    assert.deepEqual({status:updatedScopeClient.status,attempts:updatedScopeClient.attempts,lastError:updatedScopeClient.last_error},{status:'pending',attempts:0,lastError:null});
    const scopeBusinessAfterClientSave=(await db.query("select send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeBusinessJobId])).rows[0];
    assert.equal(new Date(scopeBusinessAfterClientSave.send_at).getTime(),new Date(scopeOriginalSend).getTime());
    assert.deepEqual({status:scopeBusinessAfterClientSave.status,attempts:scopeBusinessAfterClientSave.attempts,lastError:scopeBusinessAfterClientSave.last_error},{status:'sent',attempts:2,lastError:'old business error'});
    assert.deepEqual((await db.query("select id,status from public.notification_jobs where id=$1",[nearClientJobId])).rows[0],{id:nearClientJobId,status:'cancelled'});
    await db.query("update public.notification_jobs set status='sent',attempts=2,last_error='old failure' where user_id=$1 and kind='reminder' and type='client'",[attacker]);
    await call(attacker,'set_client_notification_preferences',[120,true]);
    const retriedClientReminder=(await db.query("select id,send_at,status,attempts,last_error from public.notification_jobs where booking_id=$1 and user_id=$2 and kind='reminder' and type='client'",[bookingId,attacker])).rows[0];
    assert.equal(retriedClientReminder.id,reminderJobs[0].id);
    assert.equal(new Date(retriedClientReminder.send_at).getTime(),start.getTime()-120*60000);
    assert.deepEqual({status:retriedClientReminder.status,attempts:retriedClientReminder.attempts,lastError:retriedClientReminder.last_error},{status:'pending',attempts:0,lastError:null});
    const retriedScopeClient=(await db.query("select id,send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeClientJobId])).rows[0];
    assert.equal(retriedScopeClient.id,scopeClientJobId);
    assert.equal(new Date(retriedScopeClient.send_at).getTime(),scopeStart.getTime()-120*60000);
    assert.deepEqual({status:retriedScopeClient.status,attempts:retriedScopeClient.attempts,lastError:retriedScopeClient.last_error},{status:'pending',attempts:0,lastError:null});

    await call(invited,'set_calendar_notification_minutes',[setup.resource_id,9]);
    const businessReminders=(await db.query("select id,user_id,send_at,type from public.notification_jobs where booking_id=$1 and kind='reminder' and type='business' order by user_id",[bookingId])).rows;
    assert.equal(businessReminders.length,2);
    assert(businessReminders.every(job=>job.type==='business' && new Date(job.send_at).getTime()===start.getTime()-9*60000));
    await db.query("update public.notification_jobs set status='processing',attempts=2,last_error='old failure' where booking_id=$1 and kind='reminder' and type='business'",[bookingId]);
    await call(invited,'set_calendar_notification_minutes',[setup.resource_id,11]);
    const retriedBusinessReminders=(await db.query("select id,user_id,send_at,status,attempts,last_error from public.notification_jobs where booking_id=$1 and kind='reminder' and type='business' order by user_id",[bookingId])).rows;
    assert.equal(retriedBusinessReminders.length,2);
    assert.deepEqual(retriedBusinessReminders.map(job=>job.id),businessReminders.map(job=>job.id));
    assert(retriedBusinessReminders.every(job=>new Date(job.send_at).getTime()===start.getTime()-11*60000&&job.status==='pending'&&job.attempts===0&&job.last_error===null));
    const scopeBusinessAfterOtherCalendarSave=(await db.query("select send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeBusinessJobId])).rows[0];
    assert.equal(new Date(scopeBusinessAfterOtherCalendarSave.send_at).getTime(),new Date(scopeOriginalSend).getTime());
    assert.deepEqual({status:scopeBusinessAfterOtherCalendarSave.status,attempts:scopeBusinessAfterOtherCalendarSave.attempts,lastError:scopeBusinessAfterOtherCalendarSave.last_error},{status:'sent',attempts:2,lastError:'old business error'});

    // Saving BV preferences for the second calendar now resets all business
    // recipients on that calendar, while the CV reminder keeps its same data.
    const scopeClientBeforeBusinessSave=(await db.query("select id,send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeClientJobId])).rows[0];
    await call(owner,'set_calendar_notification_minutes',[scopeCalendarId,13]);
    const scopeBusinessJobs=(await db.query("select id,user_id,send_at,status,attempts,last_error from public.notification_jobs where booking_id=$1 and kind='reminder' and type='business' order by user_id",[scopeBookingId])).rows;
    assert.equal(scopeBusinessJobs.length,2);
    assert(scopeBusinessJobs.some(job=>job.id===scopeBusinessJobId));
    assert(scopeBusinessJobs.every(job=>new Date(job.send_at).getTime()===scopeStart.getTime()-13*60000&&job.status==='pending'&&job.attempts===0&&job.last_error===null));
    assert.deepEqual((await db.query("select id,status from public.notification_jobs where id=$1",[nearBusinessJobId])).rows[0],{id:nearBusinessJobId,status:'cancelled'});
    assert.deepEqual((await db.query("select id,send_at,status,attempts,last_error from public.notification_jobs where id=$1",[scopeClientJobId])).rows[0],scopeClientBeforeBusinessSave);
    const rejectedStart=new Date(start.getTime()+2*60*60*1000);
    const rejectedId=await call(attacker,'create_booking',[businessId,setup.event_type_id,setup.resource_id,rejectedStart.toISOString(),'Nume ignorat',60]);
    assert.equal((await db.query("select count(*)::int count from public.notification_jobs where booking_id=$1 and kind='reminder'",[rejectedId])).rows[0].count,0);
    await call(owner,'set_booking_status',[rejectedId,'rejected']);
    assert.equal((await db.query("select count(*)::int count from public.notification_jobs where booking_id=$1 and kind='reminder'",[rejectedId])).rows[0].count,0);
    const rejectedStatusJob=(await db.query("select title,target_route,type from public.notification_jobs where booking_id=$1 and kind='status_update'",[rejectedId])).rows[0];
    assert.deepEqual(rejectedStatusJob,{title:'Programare respinsă',target_route:'/customer/notifications',type:'client'});
    assert.equal((await as(owner,'select * from public.get_business_report($1,$2,$3,$4,$5)',[businessId,start.toISOString().slice(0,10),start.toISOString().slice(0,10),null,0])).length,1);
    await assert.rejects(call(owner,'save_calendar_service_settings',[businessId,setup.resource_id,[1,2,3,4,5,6,7],'09:00','11:00',30]),/programări în așteptare sau aprobate/);
    await assert.rejects(call(owner,'delete_calendar',[businessId,setup.resource_id]),/are programări/);
    await call(owner,'add_calendar',[businessId,'Calendar gol']);
    const emptyCalendarId=(await db.query("select id from public.resources where business_id=$1 and name='Calendar gol'",[businessId])).rows[0].id;
    assert.equal((await call(owner,'delete_calendar',[businessId,emptyCalendarId])).ok,true);
    assert.equal((await db.query('select count(*)::int count from public.resources where id=$1',[emptyCalendarId])).rows[0].count,0);
    await assert.rejects(call(attacker,'delete_calendar',[businessId,setup.resource_id]),/Acces interzis/);
    await assert.rejects(as(owner,'select public.set_calendar_active($1,false)',[setup.resource_id]),/does not exist/);
  });
  await t.test('cancelled payment immediately locks UI-facing data and every business operation',async()=>{
    await db.query("update private.license_keys set revoked_at=now() where redeemed_by=$1",[owner]);
    await db.query("insert into public.subscriptions(owner_id,business_id,plan_id,product_id,status,store,environment,expires_at) values($1,$2,'large','rezerva_large_monthly','active','google_play','production',now()+interval '1 month') on conflict(owner_id) do update set status='active',expires_at=excluded.expires_at",[owner,businessId]);
    assert.equal((await call(owner,'get_access',[businessId])).active,true);
    assert.equal((await as(attacker,'select count(*)::int count from public.businesses where id=$1',[businessId]))[0].count,1);
    await db.query("update public.subscriptions set status='cancelled' where owner_id=$1",[owner]);
    assert.equal((await call(owner,'get_access',[businessId])).active,false);
    assert.equal((await as(attacker,'select count(*)::int count from public.businesses where id=$1',[businessId]))[0].count,0);
    assert.equal((await as(owner,'select * from public.list_my_calendars($1)',[businessId])).length,0);
    await assert.rejects(call(owner,'save_calendar_service_settings',[businessId,(await db.query('select id from public.resources where business_id=$1 limit 1',[businessId])).rows[0].id,[1],'09:00','17:00',30]),/Acces interzis|expirat/);
    await db.query("update public.subscriptions set status='active',plan_id='large',expires_at=now()+interval '1 month' where owner_id=$1",[owner]);
    await db.query("update public.subscriptions set status='active',plan_id='small',expires_at=now()+interval '1 month' where owner_id=$1",[owner]);
    const blockedDowngrade=(await db.query('select plan_id,status,expires_at<=now() expired from public.subscriptions where owner_id=$1',[owner])).rows[0];
    assert.equal(blockedDowngrade.plan_id,'large');assert.equal(blockedDowngrade.status,'cancelled');assert.equal(blockedDowngrade.expired,true);
    assert.equal((await call(owner,'get_access',[businessId])).active,false);
  });
});
