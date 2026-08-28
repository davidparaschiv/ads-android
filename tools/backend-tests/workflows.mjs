// @ts-check
import { randomUUID } from 'node:crypto';
import { actor, authHeaders, consent, edge, ensure, need, ok, recipient, request, rpc, saveState, uuid } from './core.mjs';
import { connectDb } from './database.mjs';
import { revenueCat } from './providers.mjs';

async function call(config,name,body,user,extra={}) {
  const result=await edge(config,name,body,user?.token,extra); ok(result);
  ensure(result.data?.ok !== false && !result.data?.warning,`Edge ${name} returned an incomplete operation; check provider setup and backend logs.`);
  return result.data;
}
export async function workspace(config,state) {
  ensure(config.TEST_BUSINESS_OWNED === 'true','Set TEST_BUSINESS_OWNED=true only for a disposable test business you own.');
  const owner=await actor(config,'owner');
  const id=uuid(config.TEST_BUSINESS_ID || state.enrollment?.businessId,'TEST_BUSINESS_ID');
  const list=await rpc(config,'get_my_workspaces',{},owner.token);
  ensure(list.some(b=>b.id===id && b.is_owner),'Owner does not own the configured test business.');
  const access=await rpc(config,'get_access',{p_business_id:id},owner.token);
  ensure(access.active && !access.overLimit,'Test business needs an active license/subscription within calendar limits.');
  return {owner,id,access};
}
function linkToken(config,name,prefix) {
  need(config,name); const token=config[name].trim();
  ensure(new RegExp(`^${prefix}-[A-F0-9]{64}$`).test(token),`Paste the actual ${name} fallback code, not the full URL.`); return token;
}
async function enrollmentContext(config,state) {
  const owner=await actor(config,'owner');
  ensure(state.enrollment?.ownerId === owner.id && state.enrollment.id,'Run enrollment-start with this test owner first.');
  const status=await rpc(config,'get_enrollment_status',{},owner.token);
  ensure(status?.id === state.enrollment.id && status.phone === recipient(config,'TEST_PHONE_TO') && status.email === recipient(config,'TEST_EMAIL_TO').toLowerCase(),'Pending enrollment no longer matches the allowlisted test contact.');
  return {owner,status};
}
export async function enrollment(config,flags,state,action) {
  consent(flags,'allow-writes');
  if(['start','sms-send','approval-send'].includes(action)) consent(flags,'allow-messages');
  if(action==='start') {
    const owner=await actor(config,'owner');
    const list=await rpc(config,'get_my_workspaces',{},owner.token);
    ensure(!list.some(b=>b.is_owner),'Enrollment test needs a Google account with no existing business. Do not delete an existing business.');
    const previous=await rpc(config,'get_enrollment_status',{},owner.token);
    ensure(!previous || ['rejected','superseded','expired'].includes(previous.status),'An enrollment already exists. Continue it instead of superseding another request.');
    need(config,'TEST_ENROLLMENT_CUI'); ensure(/^[1-9][0-9]{1,9}$/.test(config.TEST_ENROLLMENT_CUI),'Provide a unique test CUI-format value.');
    const result=await edge(config,'enrollment',{action:'start',name:`BACKEND TEST ${state.runId.slice(0,8)}`,category:'Test',address:'Test only',cui:config.TEST_ENROLLMENT_CUI,email:recipient(config,'TEST_EMAIL_TO'),phone:recipient(config,'TEST_PHONE_TO')},owner.token);
    ok(result); ensure(result.data?.ok && result.data.id,'Enrollment was not created.');
    // Persist the ID even when email failed, so users can resume safely without duplicating data.
    state.enrollment={id:result.data.id,ownerId:owner.id}; await saveState(state);
    ensure(!result.data.warning,'Private enrollment saved, but email was not sent. Finish Resend setup, resend in the app, then continue confirm-email.');
    const status=await rpc(config,'get_enrollment_status',{},owner.token);
    ensure(status?.status==='pending' && !status.businessId && !status.emailVerified && !status.phoneVerified,'Enrollment did not remain pending/private.');
    return 'Verification email requested. Paste its fallback code into TEST_EMAIL_LINK_TOKEN, then run enrollment-confirm-email.';
  }
  const {owner,status}=await enrollmentContext(config,state);
  if(action==='confirm-email') {
    const token=linkToken(config,'TEST_EMAIL_LINK_TOKEN','RZE');
    const details=await rpc(config,'enrollment_link_details',{p_token:token},owner.token);
    ensure(details.id===state.enrollment.id && details.kind==='email','Email link belongs to another request.');
    await call(config,'enrollment',{action:'confirm',token},owner);
    ensure((await rpc(config,'get_enrollment_status',{},owner.token)).emailVerified,'Email verification flag not recorded.');
    const replay=await edge(config,'enrollment',{action:'confirm',token},owner.token);
    ensure(replay.status===400 || replay.data?.ok===false,'Consumed email link was accepted again.');
    return 'Real email link confirmed and replay rejected. No SMS has been sent yet.';
  }
  if(action==='sms-send' || action==='sms-check') {
    ensure(status.emailVerified && !status.phoneVerified,'Email must be verified and phone must still be unverified.');
    if(action==='sms-check') {need(config,'TEST_SMS_CODE'); ensure(/^\d{4,10}$/.test(config.TEST_SMS_CODE),'Enter the real received SMS code.');}
    await call(config,'enrollment',{action:action==='sms-send'?'sendSms':'checkSms',id:state.enrollment.id,...(action==='sms-check'?{code:config.TEST_SMS_CODE}:{})},owner);
    if(action==='sms-check') ensure((await rpc(config,'get_enrollment_status',{},owner.token)).phoneVerified,'Phone proof not recorded by the backend.');
    return action==='sms-send'?'One SMS requested through deployed enrollment backend; may incur charges.':'Real Twilio code verified through deployed backend and recorded in DB.';
  }
  if(action==='approval-send') {
    ensure(status.emailVerified && status.phoneVerified,'Both email and SMS proof are required before approval.');
    ensure(config.TEST_ADMIN_EMAIL==='davidnicolaparaschiv@gmail.com','Approval is sent only to the fixed platform owner.');
    await call(config,'enrollment',{action:'approval',id:state.enrollment.id},owner);
    return 'Approval email requested for the fixed administrator. Paste its code into TEST_APPROVAL_LINK_TOKEN.';
  }
  if(action==='approve') {
    const admin=await actor(config,'admin'); const token=linkToken(config,'TEST_APPROVAL_LINK_TOKEN','RZA');
    const details=await rpc(config,'enrollment_link_details',{p_token:token},admin.token);
    ensure(details.id===state.enrollment.id && details.kind==='approval','Approval link belongs to another request.');
    const result=await call(config,'enrollment',{action:'confirm',token,approve:true},admin);
    state.enrollment.businessId=uuid(result.businessId,'approved business'); await saveState(state);
    const refreshed=await rpc(config,'get_enrollment_status',{},owner.token);
    ensure(refreshed.status==='approved' && refreshed.businessId===result.businessId,'Approval did not create the expected business.');
    return 'Test business created. It remains for inspection; activate a license and configure its calendar manually. No business is auto-deleted.';
  }
  ensure(false,'Unknown enrollment action.');
}
export async function invite(config,flags,state,accept) {
  consent(flags,'allow-writes'); if(!accept) consent(flags,'allow-messages');
  const {owner,id}=await workspace(config,state); const calendar=uuid(config.TEST_CALENDAR_ID,'TEST_CALENDAR_ID');
  const staff=await actor(config,'staff'); ensure(staff.id!==owner.id,'Staff must be a separate test account.');
  if(!accept) {
    const team=await rpc(config,'list_team',{p_business_id:id},owner.token);
    ensure(!team.members?.some(m=>m.userId===staff.id) && !team.invitations?.some(i=>i.email===staff.email && ['pending','sent'].includes(i.status)),'Test staff already has membership/invitation; do not overwrite it. Use a fresh test staff account.');
    await call(config,'send-calendar-invite',{businessId:id,email:staff.email,calendarIds:[calendar],permission:'viewer'},owner);
    const after=await rpc(config,'list_team',{p_business_id:id},owner.token);
    const issued=after.invitations.find(i=>i.email===staff.email && i.status==='sent' && i.calendarIds.length===1 && i.calendarIds[0]===calendar);
    ensure(issued,'Backend did not record a sent, correctly scoped invitation.');
    state.invitation={id:issued.id,businessId:id,calendarId:calendar,staffId:staff.id}; await saveState(state);
    return 'Invitation email accepted by Resend through deployed backend. Copy its fallback code to TEST_INVITE_TOKEN.';
  }
  ensure(state.invitation?.businessId===id && state.invitation.staffId===staff.id,'No matching test invitation is recorded.');
  const token=linkToken(config,'TEST_INVITE_TOKEN','RZI');
  const result=await rpc(config,'accept_calendar_invitation',{p_token:token},staff.token);
  ensure(result.businessId===id,'Invitation accepted for unexpected business.');
  const calendars=await rpc(config,'list_my_calendars',{p_business_id:id},staff.token);
  ensure(calendars.length===1 && calendars[0].id===calendar,'Staff gained unexpected calendar access.');
  const replay=await request(config,`${config.SUPABASE_URL}/rest/v1/rpc/accept_calendar_invitation`,{method:'POST',headers:authHeaders(config,staff.token),body:JSON.stringify({p_token:token})});
  ok(replay); ensure(replay.data?.ok===false,'Invitation replay accepted.');
  state.invitation.accepted=true; await saveState(state);
  return 'Real invitation accepted; calendar scope and single-use behavior verified. Test membership remains for manual inspection/removal.';
}
async function booking(config,flags,state,keep=false) {
  consent(flags,'allow-writes'); const {owner,id,access}=await workspace(config,state);
  const customer=await actor(config,'customer'); ensure(customer.id!==owner.id,'Use a separate customer account.');
  const calendar=uuid(config.TEST_CALENDAR_ID,'TEST_CALENDAR_ID'), event=uuid(config.TEST_EVENT_TYPE_ID,'TEST_EVENT_TYPE_ID');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+2*86400000));
  const slots=await rpc(config,'available_slots',{p_business_id:id,p_resource_id:calendar,p_event_type_id:event,p_date:day},customer.token);
  ensure(slots.length,'No available slot two days ahead. Configure opening hours for that day.');
  const body={p_business_id:id,p_resource_id:calendar,p_event_type_id:event,p_start_at:slots[0].start_at,p_customer_name:`Backend Test ${state.runId.slice(0,8)}`,p_reminder_minutes:5};
  // Exercise the hosted exclusion constraint with TWO concurrent requests.
  // Track every accepted ID before assertions, even if a broken backend accepts both.
  const outcomes=await Promise.allSettled([0,1].map(()=>request(config,`${config.SUPABASE_URL}/rest/v1/rpc/create_booking`,{method:'POST',headers:authHeaders(config,customer.token),body:JSON.stringify(body)})));
  const responses=outcomes.filter(r=>r.status==='fulfilled').map(r=>r.value);
  const accepted=responses.filter(r=>r.status===200 && typeof r.data==='string').map(r=>uuid(r.data,'created booking'));
  state.bookings ||= [];
  for(const bookingId of new Set(accepted)) state.bookings.push({id:bookingId,businessId:id,customerId:customer.id,cancelled:false});
  await saveState(state);
  const bookingId=accepted[0]; let complete=false;
  try {
    ensure(outcomes.every(r=>r.status==='fulfilled'),'Booking response was lost. Inspect the test calendar for Backend Test records before retrying; cancellation covers only returned IDs.');
    ensure(accepted.length===1 && responses.some(r=>[400,409].includes(r.status) && r.data?.code==='23P01'),'Concurrent same-slot requests must yield exactly one booking and one overlap rejection.');
    for(const user of [owner,customer]) {
      const result=await request(config,`${config.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&select=id,customer_id,customer_email_snapshot`,{headers:authHeaders(config,user.token)});
      ok(result); ensure(result.data.length===1 && result.data[0].customer_id===customer.id && result.data[0].customer_email_snapshot===customer.email,'Live booking visibility/identity mismatch.');
    }
    if(access.features.reports) {
      const rows=await rpc(config,'get_business_report',{p_business_id:id,p_from:day,p_until:day,p_calendar_id:calendar,p_offset:0},owner.token);
      ensure(rows.some(r=>r.id===bookingId),'Created booking missing from Complete report.');
    } else {
      const denied=await request(config,`${config.SUPABASE_URL}/rest/v1/rpc/get_business_report`,{method:'POST',headers:authHeaders(config,owner.token),body:JSON.stringify({p_business_id:id,p_from:day,p_until:day,p_calendar_id:calendar,p_offset:0})});
      ensure(denied.status===400 && denied.data?.code==='P0001','Small report access was not blocked.');
    }
    complete=true;
    if(keep) return {bookingId,customer,owner,id};
  } finally {
    if(!keep || !complete) {
      const cleanupErrors=[];
      for(const createdId of new Set(accepted)) {
        try {
          await rpc(config,'set_booking_status',{p_booking_id:createdId,p_status:'cancelled'},customer.token);
          state.bookings.find(b=>b.id===createdId).cancelled=true; await saveState(state);
        } catch(error) {cleanupErrors.push(error);}
      }
      ensure(cleanupErrors.length===0,'Some test bookings could not be cancelled. Reauthenticate and run cancel-bookings; retained local state identifies only this test data.');
    }
  }
  return 'Hosted concurrent booking race, visibility and plan report gate verified. The test booking was cancelled; audit history remains.';
}
export { booking };
export async function cancelBookings(config,flags,state) {
  consent(flags,'allow-writes'); const customer=await actor(config,'customer');
  for(const item of state.bookings || []) if(!item.cancelled) {
    ensure(item.customerId===customer.id,'A tracked booking belongs to another test account; not modifying.');
    await rpc(config,'set_booking_status',{p_booking_id:uuid(item.id,'tracked booking'),p_status:'cancelled'},customer.token);
    item.cancelled=true; await saveState(state);
  }
  return 'Only locally tracked test bookings were cancelled. No rows, users or businesses were deleted.';
}
export async function reminders(config,flags,state,scheduled=false) {
  consent(flags,'allow-writes','allow-messages','allow-worker');
  need(config,'CRON_SECRET','BACKEND_TEST_DATABASE_URL','TEST_FCM_TOKEN');
  ensure(config.TEST_DEVICE_OWNED==='true','Set TEST_DEVICE_OWNED=true only for your own test device.');
  // The deployed worker is global: never invoke it against a project with unrelated due jobs.
  const db=await connectDb(config); let created;
  try {
    const customer=await actor(config,'customer');
    const token=(await db.query('select id from public.device_tokens where user_id=$1 and token=$2',[customer.id,config.TEST_FCM_TOKEN])).rows;
    ensure(token.length===1,'TEST_FCM_TOKEN must already be registered to your configured customer by the Android app.');
    const pending=(await db.query("select count(*)::int n from public.notification_jobs where status in ('pending','processing') and send_at<=now()+interval '2 minutes'")).rows[0].n;
    ensure(pending===0,'Unrelated due/in-flight reminders exist. Use an isolated test project; the global worker could process them.');
    created=await booking(config,flags,state,true);
    const jobs=(await db.query("select id from public.notification_jobs where booking_id=$1 and user_id=$2 and status='pending'",[created.bookingId,created.customer.id])).rows;
    ensure(jobs.length===1,'Customer reminder was not queued; enable notification preferences first.');
    const jobId=jobs[0].id;
    await db.query("update public.notification_jobs set send_at=now()-interval '1 second', title='Rezervari AI · Test backend',body='Test de integrare notificări.' where id=$1 and booking_id=$2 and user_id=$3 and status='pending'",[jobId,created.bookingId,created.customer.id]);
    if(!scheduled) {
      const response=await edge(config,'send-reminders',{},'',{'x-cron-secret':config.CRON_SECRET}); ok(response);
      ensure(Number.isInteger(response.data?.processed),'Reminder worker response invalid.');
    }
    const deadline=Date.now()+(scheduled?90000:20000); let status;
    do {
      const result=(await db.query('select status from public.notification_jobs where id=$1',[jobId])).rows[0]; status=result?.status;
      if(status==='sent' || status==='failed' || status==='cancelled') break;
      console.log('Waiting for this test reminder job (status only; no device token logged)...');
      await new Promise(resolve=>setTimeout(resolve,3000));
    } while(Date.now()<deadline);
    ensure(status==='sent','Test reminder was not sent before deadline; inspect worker logs.');
    const log=(await db.query('select id from public.notification_log where booking_id=$1 and user_id=$2',[created.bookingId,created.customer.id])).rows;
    ensure(log.length===1,'Missing or duplicate notification log for test reminder.');
    return scheduled?'Scheduler processed the test job. Backend accepted delivery; verify the phone manually.':'Deployed worker processed the test job. Backend accepted delivery; verify the phone manually.';
  } finally {
    await db.end();
    // Cancel even if booking() threw after writing: the state file tracks every created ID.
    if(created || state.bookings?.some(b=>!b.cancelled)) await cancelBookings(config,flags,state);
  }
}
export async function billing(config,flags,state) {
  consent(flags,'allow-writes','allow-billing'); const owner=await actor(config,'owner');
  ensure(config.TEST_REVENUECAT_USER_ID===owner.id,'RevenueCat test subscriber must match your authenticated test owner.');
  need(config,'REVENUECAT_WEBHOOK_AUTH','TEST_EXPECTED_PLAN');
  ensure(['small','large'].includes(config.TEST_EXPECTED_PLAN),'TEST_EXPECTED_PLAN must be small or large (Complete).');
  const before=await request(config,`${config.SUPABASE_URL}/rest/v1/subscriptions?owner_id=eq.${owner.id}&select=environment,status`,{headers:authHeaders(config,owner.token)}); ok(before);
  ensure(!before.data.some(s=>s.environment==='production'),'Refusing to synchronize an owner with an existing production subscription.');
  const subscriber=await revenueCat(config), entitlement=subscriber.entitlements?.[config.REVENUECAT_ENTITLEMENT_ID || 'business_pro'];
  const purchase=subscriber.subscriptions?.[entitlement?.product_identifier];
  ensure(purchase?.is_sandbox===true && String(purchase.store).toLowerCase()==='play_store','A real Google Play sandbox purchase is required. No fake purchase will be created.');
  ensure(Date.parse(entitlement.expires_date)>Date.now(),'Sandbox subscription has expired; make/renew a test purchase first.');
  ensure(entitlement.product_identifier.split(':')[0]===`rezerva_${config.TEST_EXPECTED_PLAN}_monthly`,'RevenueCat product does not match expected plan.');
  await call(config,'sync-subscription',{},owner);
  const snapshot=async()=>{
    const res=await request(config,`${config.SUPABASE_URL}/rest/v1/subscriptions?owner_id=eq.${owner.id}&select=plan_id,product_id,status,environment,expires_at`,{headers:authHeaders(config,owner.token)});ok(res);
    ensure(res.data.length===1 && res.data[0].environment==='sandbox' && res.data[0].plan_id===config.TEST_EXPECTED_PLAN && res.data[0].status==='active','Backend did not persist the expected sandbox subscription.'); return res.data[0];
  };
  const expected=await snapshot();
  // Replay the same event; backend must fetch authoritative RC state, not trust payload.
  const event={id:randomUUID(),type:'RENEWAL',app_user_id:owner.id,product_id:'untrusted-test-product'};
  for(let i=0;i<2;i++) {
    const res=await edge(config,'revenuecat-webhook',{event},'',{Authorization:config.REVENUECAT_WEBHOOK_AUTH}); ok(res);
    ensure(res.data?.received===true && JSON.stringify(await snapshot())===JSON.stringify(expected),'Webhook replay changed authoritative subscription state.');
  }
  state.billingChecked=true;await saveState(state);
  return 'Existing real sandbox purchase synchronized; webhook replay kept authoritative state. Does not test Play checkout or RevenueCat-to-webhook delivery.';
}
