// @ts-check
// Read-only, offline configuration inspection. Never prints configuration values.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
const report = (level, text) => { console.log(`${level}: ${text}`); if (level === 'FAIL') failures++; };
const read = async file => readFile(resolve(root, file), 'utf8');
console.log('OFFLINE ONLY: no cloud requests, SMS, email, purchases or database writes.');
report(Number(process.versions.node.split('.')[0]) >= 24 ? 'PASS' : 'FAIL', 'Node.js 24 or newer');
let env = {};
try { env = parseEnv(await read('.env')); report('PASS', '.env is readable (values hidden)'); }
catch { report('FAIL', '.env is missing or unreadable'); }
report(env.VITE_APP_MODE === 'live' ? 'PASS' : 'FAIL', 'VITE_APP_MODE must be live for real phone services');
for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) report(env[name] ? 'PASS' : 'FAIL', `${name} is configured`);
if (env.VITE_SUPABASE_URL) {
  try { const url = new URL(env.VITE_SUPABASE_URL); report(url.protocol === 'https:' && !url.username && !url.password ? 'PASS' : 'FAIL', 'Supabase URL uses HTTPS without embedded credentials'); }
  catch { report('FAIL', 'VITE_SUPABASE_URL is not a valid URL'); }
}
if (env.VITE_SUPABASE_ANON_KEY) {
  let publicKey = env.VITE_SUPABASE_ANON_KEY.startsWith('sb_publishable_');
  try { publicKey ||= JSON.parse(Buffer.from(env.VITE_SUPABASE_ANON_KEY.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { /* Not a legacy JWT. */ }
  report(publicKey ? 'PASS' : 'FAIL', 'Frontend Supabase key must be publishable/anon, never service_role or secret');
}
const privateNames = /(?:TWILL?IO_AUTH_TOKEN|GCLOUD_SERVICEACCOUNT_KEYS|GOOGLEOAUTH_CLIENTSECRET|SERVICE_ROLE_KEY|REVENUECAT_SECRET|RESEND_API_KEY|CRON_SECRET)/;
report(Object.keys(env).some(name => privateNames.test(name)) ? 'FAIL' : 'PASS', 'No recognized server-only credentials in the frontend .env');
report((env.VITE_AUTH_REDIRECT_URL || 'ro.rezerva.app://auth/callback') === 'ro.rezerva.app://auth/callback' ? 'PASS' : 'FAIL', 'OAuth redirect matches the Android manifest');
try {
  const google = JSON.parse(await read('android/app/google-services.json'));
  report(google.client?.some(client => client.client_info?.android_client_info?.package_name === 'ro.rezerva.app') ? 'PASS' : 'FAIL', 'google-services.json includes ro.rezerva.app');
  report(google.project_info?.project_id ? 'PASS' : 'FAIL', 'Firebase Android project is configured (compare to FIREBASE_PROJID in dashboard)');
} catch { report('FAIL', 'android/app/google-services.json is missing or invalid'); }
for (const name of ['VITE_SUPPORT_URL', 'VITE_PRIVACY_URL', 'VITE_DELETE_ACCOUNT_URL']) {
  let valid = false;
  try { const url = new URL(env[name]); valid = url.protocol === 'https:' && !url.hostname.endsWith('example.com'); } catch { /* Report only the key name. */ }
  report(valid ? 'PASS' : 'WARN', `${name}: use a real published HTTPS page; required before release`);
}
report(env.VITE_REVENUECAT_GOOGLE_API_KEY?.startsWith('goog_') ? 'PASS' : 'WARN', 'RevenueCat Google public SDK key: optional for authorized license flow, required for Play billing');
report('WARN', 'Manually confirm JDK 21, Android SDK 36, device USB debugging and Google Play services');
try {
  const manifest = await read('android/app/src/main/AndroidManifest.xml');
  const activity = await read('android/app/src/main/java/ro/rezerva/app/MainActivity.java');
  await read('supabase/migrations/005_reservation_qr.sql');
  report(manifest.includes('android:host="reservation"') && manifest.includes('barcode_ui') && activity.includes('registerPlugin(ReservationQrPlugin.class)') ? 'PASS' : 'FAIL', 'QR deep link, Google scanner module hint, native plugin and migration file are present');
} catch { report('FAIL', 'QR native files or migration 005 are missing locally'); }
report('WARN', 'Apply migrations 005, 018, 019 and 020 to hosted Supabase as applicable; keep send-reminders deployed, then rebuild the APK');
report('WARN', 'For camera testing, display the customer QR on another screen or a printout; the scanning phone cannot scan its own display');
report('WARN', 'Offline checks cannot verify hosted OAuth, secrets, DNS, migrations, cron, paid SMS or device delivery');
console.log(failures ? `RESULT: ${failures} local configuration issue(s). See SETUP.html.` : 'RESULT: local prerequisites pass; live service readiness is NOT certified.');
process.exitCode = failures ? 1 : 0;
