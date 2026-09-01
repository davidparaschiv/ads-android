// @ts-check
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, need, ensure, consent, digest } from './core.mjs';
import { generateLicense } from '../license-core.mjs';

export function connectionOptions(config) {
  need(config, 'BACKEND_TEST_DATABASE_URL');
  const url = new URL(config.BACKEND_TEST_DATABASE_URL), ref = config.BACKEND_TEST_PROJECT_REF;
  const direct = url.hostname === `db.${ref}.supabase.co` && decodeURIComponent(url.username) === 'postgres';
  const pool = /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname) && decodeURIComponent(url.username) === `postgres.${ref}`;
  ensure(['postgres:', 'postgresql:'].includes(url.protocol) && (direct || pool) && (url.port === '' || url.port === '5432') && url.pathname === '/postgres', 'DB URL must target the same project: direct or session pooler, postgres database, port 5432.');
  ensure(url.password, 'DB URL requires your database password.');
  // Do not let URL sslmode=require silently override certificate validation.
  for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
  return { connectionString: url.toString(), connectionTimeoutMillis: 15000, query_timeout: 20000,
    statement_timeout: 15000, application_name: 'rezervari-backend-tests', ssl: { rejectUnauthorized: true } };
}
export async function connectDb(config) {
  const options = connectionOptions(config);
  if (config.BACKEND_TEST_DB_CA_FILE) options.ssl.ca = await readFile(resolve(root, config.BACKEND_TEST_DB_CA_FILE), 'utf8');
  const { Client } = await import('pg'); const db = new Client(options);
  // Avoid emitting raw connection strings/queries from an idle client error.
  db.on('error', () => {});
  try { await db.connect(); } catch (error) { await db.end().catch(() => {}); throw error; }
  return db;
}
export async function inspectDatabase(config, check) {
  const db = await connectDb(config);
  try {
    await db.query('begin read only');
    await check('Database: all seven migration versions recorded', async () => {
      const rows = (await db.query('select version from supabase_migrations.schema_migrations')).rows;
      ensure(['001', '002', '003', '004', '005', '006', '007'].every(v => rows.some(r => r.version === v)), 'Migration history is incomplete; apply/record only the SQL files that actually succeeded.');
    });
    await check('Database: required tables use RLS; private schema is not client-accessible', async () => {
      const names = ['profiles','businesses','business_members','subscriptions','resources','event_types','bookings','device_tokens','notification_jobs','calendar_members'];
      const rows = (await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1)", [names])).rows;
      ensure(rows.length === names.length && rows.every(r => r.relrowsecurity), 'Required table missing or RLS disabled.');
      const row = (await db.query("select has_schema_privilege('anon','private','USAGE') a, has_schema_privilege('authenticated','private','USAGE') b")).rows[0];
      ensure(!row.a && !row.b, 'Private schema must not be accessible to client roles.');
    });
    await check('Scheduler: one active job, required extensions and matching Vault secrets', async () => {
      need(config, 'CRON_SECRET');
      const extensions = (await db.query("select extname from pg_extension where extname in ('pg_cron','pg_net','supabase_vault')")).rows;
      ensure(extensions.length === 3, 'Enable pg_cron, pg_net and Vault (Step 11).');
      const jobs = (await db.query("select active, schedule, command from cron.job where jobname='rezerva-reminders'")).rows;
      ensure(jobs.length === 1 && jobs[0].active && jobs[0].schedule === '* * * * *', 'Expected one active every-minute rezerva-reminders schedule.');
      ensure(jobs[0].command.includes('/functions/v1/send-reminders') && jobs[0].command.includes('x-cron-secret') && jobs[0].command.includes('rezerva_cron_secret'), 'Cron command does not match the reminder worker.');
      // Compare digest on the server; never return decrypted secrets to reports.
      const secrets = (await db.query("select name, case when name='rezerva_cron_secret' then encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex') else decrypted_secret end as value from vault.decrypted_secrets where name in ('rezerva_cron_secret','rezerva_project_url')")).rows;
      ensure(secrets.length === 2 && secrets.find(s => s.name === 'rezerva_project_url')?.value === config.SUPABASE_URL && secrets.find(s => s.name === 'rezerva_cron_secret')?.value === digest(config.CRON_SECRET), 'Vault URL/cron secret is absent or does not match local test configuration.');
      return 'Configuration verified, not proof of invocation success or device delivery.';
    });
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

// One transaction, no COMMIT, no migrations, no HTTP calls. Fixtures are invisible
// to the live worker and disappear on rollback/disconnect, including after failure.
export async function databaseCases(db, check) {
  const ids = Object.fromEntries(['small','large','staff','customer','other','license','applicant','unverified'].map(k => [k, randomUUID()]));
  const emails = Object.fromEntries(Object.keys(ids).map(k => [k, `rza-test-${ids[k]}@example.invalid`]));
  const biz = { small: randomUUID(), large: randomUUID() };
  const ctx = {};
  let sequence = 0;
  async function as(who, sql, args = [], role = 'authenticated') {
    ensure(['authenticated','anon','service_role'].includes(role), 'Invalid SQL test role.');
    const point = `role_${++sequence}`; await db.query(`savepoint ${point}`);
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [ids[who] || '', JSON.stringify({ sub: ids[who] || '', role, email: emails[who] || '' })]);
      await db.query(`set local role ${role}`);
      const result = await db.query(sql, args);
      await db.query('reset role'); await db.query(`release savepoint ${point}`); return result.rows;
    } catch (error) { await db.query(`rollback to savepoint ${point}`); await db.query(`release savepoint ${point}`); throw error; }
  }
  const scalar = async (...args) => (await as(...args))[0]?.result;
  const denied = async operation => { let rejected = false; try { await operation(); } catch (error) { if (['42501','P0001','23P01','23514'].includes(error.code)) rejected = true; else throw error; } ensure(rejected, 'Expected database permission/business-rule rejection.'); };
  const run = async (name, body) => check(name, async () => {
    const point = `case_${++sequence}`; await db.query(`savepoint ${point}`);
    try { const result = await body(); await db.query(`release savepoint ${point}`); return result; }
    catch (error) { await db.query(`rollback to savepoint ${point}`); await db.query(`release savepoint ${point}`); throw error; }
  });
  // Real hosted Auth table layout. Google identities below are synthetic DB fixtures;
  // they do not test OAuth and never leave this transaction.
  for (const who of Object.keys(ids)) {
    await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,aud,role) values($1,$2,$3,'{}','{}','authenticated','authenticated')", [ids[who], emails[who], who === 'unverified' ? null : new Date()]);
    await db.query("insert into auth.identities(id,user_id,provider,provider_id,identity_data) values($1,$2,'google',$3,$4::jsonb)", [randomUUID(), ids[who], ids[who], JSON.stringify({ sub: ids[who], email: emails[who], email_verified: who !== 'unverified' })]);
  }
  for (const plan of ['small','large']) {
    await db.query("insert into public.businesses(id,owner_id,name,category,address) values($1,$2,'BACKEND TEST - rollback only','Test','Test only')", [biz[plan], ids[plan]]);
    await db.query("insert into public.subscriptions(owner_id,business_id,plan_id,product_id,status,environment,expires_at) values($1,$2,$3,$4,'active','production',now()+interval '1 month')", [ids[plan], biz[plan], plan, `rezerva_${plan}_monthly`]);
    ctx[plan] = await scalar(plan, "select public.setup_business($1,'Test service',30,1000,'Test calendar','00:00','23:59',array[1,2,3,4,5,6,7]::smallint[]) result", [biz[plan]]);
  }
  const date = new Date(Date.now() + 2 * 86400000); date.setUTCHours(9,0,0,0);
  const day = date.toISOString().slice(0,10);
  const book = (plan, who = 'customer', calendar = ctx[plan].resource_id, offset = 0) => scalar(who, 'select public.create_booking($1,$2,$3,$4,$5,5) result', [biz[plan], ctx[plan].event_type_id, calendar, new Date(date.getTime() + offset * 60000).toISOString(), 'Backend Test']);
  const access = who => scalar(who, 'select public.get_access($1) result', [biz[who] || null]);
  const report = (who, plan, calendar = null) => as(who, 'select * from public.get_business_report($1,$2,$3,$4,0)', [biz[plan], day, day, calendar]);
  const allowed = (booking, who) => scalar('customer', 'select public.notification_recipient_allowed($1,$2) result', [booking, ids[who]], 'service_role');

  await run('DB: Small / Complete features and 1 / 5 calendar limits', async () => {
    const small = await access('small'), large = await access('large');
    ensure(small.calendarLimit === 1 && !small.features.reports && !small.features.businessNotifications, 'Small entitlement mismatch.');
    ensure(large.calendarLimit === 5 && large.features.reports && large.features.businessNotifications, 'Complete entitlement mismatch.');
    await denied(() => as('small', "select public.add_calendar($1,'Extra')", [biz.small]));
    ctx.largeCalendars = [ctx.large.resource_id];
    for (let i = 2; i <= 5; i++) ctx.largeCalendars.push((await as('large', "select (public.add_calendar($1,$2)).id", [biz.large, `Test ${i}`]))[0].id);
    await denied(() => as('large', "select public.add_calendar($1,'Sixth')", [biz.large]));
  });
  await run('DB: license privacy, email binding, redemption idempotency and revocation', async () => {
    const license = generateLicense({ email: emails.license, start: new Date(Date.now()-86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), months: 1 });
    await db.query('insert into private.license_keys(key_hash,bound_email,starts_at,duration_months) values($1,$2,$3,1)', [license.hash, emails.license, license.startsAt]);
    await denied(() => as('license', 'select * from private.license_keys'));
    ensure(!(await scalar('other','select public.redeem_license($1) result',[license.key])).ok, 'Wrong-email license accepted.');
    ensure(!(await scalar('unverified','select public.redeem_license($1) result',[license.key])).ok, 'Unverified user accepted.');
    for (let i=0;i<2;i++) ensure((await scalar('license','select public.redeem_license($1) result',[license.key])).access.calendarLimit === 5, 'License grant is not idempotent.');
    await db.query('update private.license_keys set revoked_at=now() where key_hash=$1',[license.hash]);
    ensure(!(await access('license')).active, 'Revoked license still grants access.');
    ensure((await scalar('other','select public.redeem_license($1) result',['dev112233'])).access.calendarLimit === 5, 'Universal developer key was rejected.');
  });
  await run('DB: future/expired licenses and rate limiting', async () => {
    for (const [offset, expectedOk] of [[10,true],[-500,false]]) {
      const license = generateLicense({ email: emails.license, start: new Date(Date.now()+offset*86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), months: 1 });
      await db.query('insert into private.license_keys(key_hash,bound_email,starts_at,duration_months) values($1,$2,$3,1)',[license.hash,emails.license,license.startsAt]);
      const result = await scalar('license','select public.redeem_license($1) result',[license.key]);
      ensure(result.ok === expectedOk && !result.access?.active, 'Future/expired license incorrectly grants access.');
    }
    for(let i=0;i<6;i++) ensure(!(await scalar('other','select public.redeem_license($1) result',['invalid'])).ok, 'Invalid license accepted.');
    const attempts = (await db.query("select max(attempts) n from private.request_limits where user_id=$1 and scope='license'",[ids.other])).rows[0].n;
    ensure(attempts >= 6, 'Failed attempts did not persist inside the transaction.');
  });
  await run('DB: enrollment stays private; email tokens are account-bound and single-use', async () => {
    const cui=String(1000000000 + Math.floor(Math.random()*8000000000));
    const modernEnrollment=(await db.query("select to_regprocedure('public.start_enrollment(text,text,text,text,text)') is not null available")).rows[0].available;
    ctx.enrollment = modernEnrollment
      ? await scalar('applicant', "select public.start_enrollment('BACKEND TEST','Test','Test address',$1,'+40700000000') result", [cui])
      : await scalar('applicant', "select public.start_enrollment('BACKEND TEST','Test','Test address',$1,$2,'+40700000000') result", [cui,emails.applicant]);
    ensure(ctx.enrollment.ok && !(await db.query('select id from public.businesses where owner_id=$1',[ids.applicant])).rows.length, 'Business created before verification/approval.');
    await denied(() => as('applicant', "select public.create_business('Test','Test','Test','')"));
    const link = await scalar('applicant', "select public.issue_enrollment_link($1,$2,'email') result", [ctx.enrollment.id,ids.applicant], 'service_role');
    ensure(link.recipient === emails.applicant && link.token.startsWith('RZE-'), 'Email verification recipient/token mismatch.');
    ensure(!(await scalar('other','select public.confirm_enrollment_link($1,true) result',[link.token])).ok, 'Wrong account accepted an email link.');
    ensure((await scalar('applicant','select public.confirm_enrollment_link($1,true) result',[link.token])).ok, 'Correct email confirmation failed.');
    ensure(!(await scalar('applicant','select public.confirm_enrollment_link($1,true) result',[link.token])).ok, 'Email link replay accepted.');
    const approval = await scalar('applicant',"select public.issue_enrollment_link($1,$2,'approval') result",[ctx.enrollment.id,ids.applicant],'service_role');
    ensure(!approval.ok, 'Approval link issued before phone verification.');
  });
  await run('DB: SMS proof is service-only and tied to the current verification SID', async () => {
    const sid = 'VE'+'a'.repeat(32);
    await denied(() => as('applicant','select public.enrollment_record_sms($1,$2,$3,true)',[ctx.enrollment.id,ids.applicant,sid]));
    ensure(!await scalar('applicant','select public.enrollment_record_sms($1,$2,$3,true) result',[ctx.enrollment.id,ids.applicant,sid],'service_role'), 'Unissued SMS SID accepted.');
    ensure(await scalar('applicant','select public.enrollment_record_sms($1,$2,$3,false) result',[ctx.enrollment.id,ids.applicant,sid],'service_role'), 'Service could not record issued SID.');
    ensure(await scalar('applicant','select public.enrollment_record_sms($1,$2,$3,true) result',[ctx.enrollment.id,ids.applicant,sid],'service_role'), 'Service could not record verified SID.');
    const approval = await scalar('applicant',"select public.issue_enrollment_link($1,$2,'approval') result",[ctx.enrollment.id,ids.applicant],'service_role');
    ensure(approval.recipient === 'davidnicolaparaschiv@gmail.com', 'Platform approval recipient changed.');
    ensure(!(await scalar('applicant','select public.confirm_enrollment_link($1,true) result',[approval.token])).ok, 'Applicant approved its own business.');
    // SMS provider itself is NOT contacted by this transaction-only test.
  });
  await run('DB: invitations are owner-only, email-bound and single-use', async () => {
    const args=[biz.large,emails.staff,[ctx.large.resource_id],'viewer'];
    await denied(() => as('customer','select public.issue_calendar_invitation($1,$2,$3,$4)',args));
    const invitation = await scalar('large','select public.issue_calendar_invitation($1,$2,$3,$4) result',args);
    ensure(invitation.ok, 'Invitation issuance failed.');
    ensure(!(await scalar('other','select public.accept_calendar_invitation($1) result',[invitation.token])).ok, 'Wrong account accepted invitation.');
    ensure((await scalar('staff','select public.accept_calendar_invitation($1) result',[invitation.token])).ok, 'Staff could not accept invitation.');
    ensure(!(await scalar('staff','select public.accept_calendar_invitation($1) result',[invitation.token])).ok, 'Invitation replay accepted.');
    ensure((await as('staff','select * from public.list_my_calendars($1)',[biz.large])).length === 5, 'Staff did not receive every shared calendar.');
  });
  await run('DB: booking creation, slot exclusion and customer ownership', async () => {
    ctx.smallBooking=await book('small'); ctx.largeBooking=await book('large');
    ctx.hiddenBooking=await book('large','customer',ctx.largeCalendars[1]);
    await denied(() => book('large','other'));
    const slots=await as('customer','select * from public.available_slots($1,$2,$3,$4)',[biz.large,ctx.large.resource_id,ctx.large.event_type_id,day]);
    ensure(!slots.some(s => new Date(s.start_at).getTime() === date.getTime()), 'Occupied slot still available.');
    const rows=await as('customer','select customer_id,customer_email_snapshot from public.bookings where id=$1',[ctx.largeBooking]);
    ensure(rows[0]?.customer_id === ids.customer && rows[0].customer_email_snapshot === emails.customer, 'Booking identity not derived from verified user.');
    ensure(!(await as('other','select id from public.bookings where id=$1',[ctx.largeBooking])).length, 'Another customer sees booking.');
    await denied(() => as('unverified','select public.create_booking($1,$2,$3,$4,\'Test\',5)',[biz.large,ctx.large.event_type_id,ctx.large.resource_id,new Date(date.getTime()+3600000)]));
  });
  await run('DB: shared-calendar RLS, viewer restrictions and Complete-only reports', async () => {
    ensure((await as('staff','select id from public.bookings where business_id=$1',[biz.large])).length === 2, 'Staff cannot see every shared calendar.');
    await denied(() => as('staff',"select public.set_booking_status($1,'completed')",[ctx.largeBooking]));
    await denied(() => report('small','small'));
    ensure((await report('large','large')).length === 2 && (await report('staff','large')).length === 2, 'Report rows do not match shared access.');
    ensure((await report('staff','large',ctx.largeCalendars[1])).length === 1, 'Shared calendar report is unavailable.');
    await denied(() => report('other','large'));
  });
  await run('DB: reminder recipients, opt-out and cancellation', async () => {
    const smallJobs=(await db.query('select user_id from public.notification_jobs where booking_id=$1',[ctx.smallBooking])).rows;
    ensure(smallJobs.length === 1 && smallJobs[0].user_id === ids.customer, 'Small queued a business reminder.');
    ensure(await allowed(ctx.largeBooking,'large') && await allowed(ctx.largeBooking,'staff') && !await allowed(ctx.largeBooking,'other'), 'Reminder eligibility mismatch.');
    await as('customer','insert into public.notification_preferences(user_id,push_enabled,default_minutes) values($1,false,5)',[ids.customer]);
    ensure(!await allowed(ctx.largeBooking,'customer'), 'Opt-out ignored.');
    await as('customer',"select public.set_booking_status($1,'cancelled')",[ctx.smallBooking]);
    ensure(!await allowed(ctx.smallBooking,'customer'), 'Cancelled booking eligible for reminder.');
  });
  await run('DB: revocation removes staff visibility and queued reminders', async () => {
    await as('large',"select public.set_member_access($1,$2,'{}'::uuid[],'viewer')",[biz.large,ids.staff]);
    ensure(!(await as('staff','select id from public.bookings where business_id=$1',[biz.large])).length, 'Revoked staff still sees bookings.');
    ensure(!await allowed(ctx.largeBooking,'staff'), 'Revoked staff still eligible for notification.');
  });
  await run('DB: downgrade/expiry/sandbox cannot retain paid business features', async () => {
    await db.query("update public.subscriptions set plan_id='small' where owner_id=$1",[ids.large]);
    ensure(!(await access('large')).features.reports && !await allowed(ctx.largeBooking,'large'), 'Downgrade retains Complete features.');
    await denied(() => book('large','other',ctx.large.resource_id,60));
    await db.query("update public.subscriptions set expires_at=now()-interval '1 day' where owner_id=$1",[ids.large]);
    ensure(!(await access('large')).active, 'Expired subscription still active.');
    const setting=(await db.query('select allow_sandbox_payments from private.server_settings')).rows[0];
    if (!setting.allow_sandbox_payments) {
      await db.query("update public.subscriptions set environment='sandbox',expires_at=now()+interval '1 month' where owner_id=$1",[ids.small]);
      ensure(!(await access('small')).active, 'Sandbox payment grants access when disabled.');
    }
    ensure((await db.query('select id from public.bookings where business_id=$1',[biz.large])).rows.length === 2, 'Subscription change deleted booking history.');
  });
  await run('DB: clients cannot self-grant subscription or access private tables', async () => {
    await denied(() => as('customer',"update public.subscriptions set plan_id='large' where owner_id=$1",[ids.small]));
    await denied(() => as('other','select * from private.platform_settings'));
    await denied(() => as('customer','select public.notification_recipient_allowed($1,$2)',[ctx.largeBooking,ids.customer]));
    await denied(() => as('other','select public.get_access($1)',[biz.large]));
  });
}
export async function runDatabase(config, flags, check) {
  consent(flags, 'allow-db-writes');
  const db = await connectDb(config);
  try { await db.query('begin'); await db.query("set local idle_in_transaction_session_timeout='60s'"); await databaseCases(db, check); }
  finally { await db.query('rollback').catch(() => {}); await db.end(); }
}
