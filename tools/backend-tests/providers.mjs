// @ts-check
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSign, randomUUID } from 'node:crypto';
import { root, need, ensure, request, ok, consent, recipient, saveState, CheckError } from './core.mjs';

export function twilioHeaders(config) {
  need(config, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID');
  ensure(/^AC[0-9a-f]{32}$/i.test(config.TWILIO_ACCOUNT_SID) && /^VA[0-9a-f]{32}$/i.test(config.TWILIO_VERIFY_SERVICE_SID), 'Invalid Twilio Account/Verify Service SID.');
  return { Authorization: 'Basic ' + Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' };
}
export async function twilio(config, path = '', values) {
  return request(config, `https://verify.twilio.com/v2/Services/${config.TWILIO_VERIFY_SERVICE_SID}${path}`, {
    method: values ? 'POST' : 'GET', headers: twilioHeaders(config), ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}
export async function firebaseToken(config) {
  need(config, 'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT_FILE');
  let key;
  try { key = JSON.parse(await readFile(resolve(root, config.FIREBASE_SERVICE_ACCOUNT_FILE), 'utf8')); }
  catch { throw new CheckError('Cannot read FIREBASE_SERVICE_ACCOUNT_FILE; use a private service-account JSON path.'); }
  ensure(key.type === 'service_account' && key.project_id === config.FIREBASE_PROJECT_ID && key.private_key && key.client_email, 'Firebase key type/project mismatch. Do not use google-services.json.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signing = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const assertion = signing + '.' + createSign('RSA-SHA256').update(signing).sign(key.private_key, 'base64url');
  const result = await request(config, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  ok(result); ensure(result.data?.access_token, 'Google did not issue an access token.'); return result.data.access_token;
}
export async function fcm(config, token, validateOnly) {
  need(config, 'TEST_FCM_TOKEN');
  ensure(/^[a-z][a-z0-9-]{4,62}$/.test(config.FIREBASE_PROJECT_ID), 'Invalid Firebase project ID.');
  const result = await request(config, `https://fcm.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ validate_only: validateOnly, message: { token: config.TEST_FCM_TOKEN,
      notification: { title: 'Rezervari AI · Test backend', body: 'Notificare de test. Nu este o programare reală.' }, data: { backendTest: 'true' } } }),
  });
  ok(result); return result;
}
export async function sendEmail(config, flags, state) {
  consent(flags, 'allow-messages'); need(config, 'RESEND_API_KEY', 'INVITE_FROM_EMAIL');
  const to = recipient(config, 'TEST_EMAIL_TO');
  state.emailKey ||= `backend-test/${randomUUID()}`; await saveState(state);
  const result = await request(config, 'https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': state.emailKey },
    body: JSON.stringify({ from: config.INVITE_FROM_EMAIL, to: [to], subject: 'Rezervari AI · Backend integration test', text: 'This is an explicitly requested backend test. No booking was created. Reply is not required.' }) });
  ok(result); ensure(result.data?.id, 'Resend did not return a message ID.');
  state.emailId = result.data.id; await saveState(state);
  return 'Resend accepted the message (not proof of inbox delivery). email-status checks delivery if a read key is configured.';
}
export async function emailStatus(config, state) {
  need(config, 'RESEND_READ_API_KEY'); ensure(state.emailId, 'Run the email test first.');
  const result = await request(config, `https://api.resend.com/emails/${encodeURIComponent(state.emailId)}`, { headers: { Authorization: `Bearer ${config.RESEND_READ_API_KEY}` } });
  ok(result); const event = result.data?.last_event;
  ensure(['delivered', 'opened', 'clicked'].includes(event), 'Email is not yet confirmed delivered by Resend (or has bounced/failed). Check Resend logs and your inbox.');
  return 'Provider reports delivery; inbox placement/display still requires manual confirmation.';
}
export async function sendSms(config, flags, state) {
  consent(flags, 'allow-messages'); const phone = recipient(config, 'TEST_PHONE_TO');
  if (state.sms?.createdAt) ensure(Date.now() - Date.parse(state.sms.createdAt) > 60000, 'Wait at least 60 seconds before another SMS request.');
  // Reserve the attempt before networking: no silent retry after an ambiguous timeout.
  state.sms = { createdAt: new Date().toISOString(), phone }; await saveState(state);
  const result = await twilio(config, '/Verifications', { To: phone, Channel: 'sms', Locale: 'ro' });
  ok(result, 201); ensure(result.data?.status === 'pending' && result.data.to === phone && /^VE[0-9a-f]{32}$/i.test(result.data.sid), 'Twilio did not create the expected verification.');
  state.sms.sid = result.data.sid; await saveState(state);
  return 'One verification SMS requested; may incur charges. Set TEST_SMS_CODE to the received code and run sms-check.';
}
export async function checkSms(config, flags, state) {
  consent(flags, 'allow-messages'); need(config, 'TEST_SMS_CODE');
  ensure(state.sms?.sid && state.sms.phone === recipient(config, 'TEST_PHONE_TO'), 'Run sms-send for the current test phone first.');
  ensure(/^\d{4,10}$/.test(config.TEST_SMS_CODE), 'TEST_SMS_CODE must be the actual received code.');
  const result = await twilio(config, '/VerificationCheck', { VerificationSid: state.sms.sid, Code: config.TEST_SMS_CODE });
  ok(result); ensure(result.data?.status === 'approved' && result.data.to === state.sms.phone && result.data.sid === state.sms.sid, 'Twilio did not approve this phone/code.');
  state.sms.verified = true; await saveState(state); return 'Real phone-code verification approved by Twilio. This does not enroll a business.';
}
export async function revenueCat(config) {
  need(config, 'REVENUECAT_SECRET_API_KEY', 'TEST_REVENUECAT_USER_ID');
  ensure(/^[0-9a-f-]{36}$/i.test(config.TEST_REVENUECAT_USER_ID), 'RevenueCat test user ID must be the existing Supabase user UUID.');
  const result = await request(config, `https://api.revenuecat.com/v1/subscribers/${config.TEST_REVENUECAT_USER_ID}`, { headers: { Authorization: `Bearer ${config.REVENUECAT_SECRET_API_KEY}`, Accept: 'application/json' } });
  ok(result); ensure(result.data?.subscriber, 'RevenueCat subscriber response is invalid.'); return result.data.subscriber;
}
