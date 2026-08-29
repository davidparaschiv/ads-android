// @ts-check
// Offline contracts; no real SDK, provider, phone, credentials or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import { firebaseToken, twilioHeaders } from '../tools/backend-tests/providers.mjs';
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const android = 'android/app/src/main/';

test('Android manifest: minimum permissions, deep links, private provider and FCM metadata', async () => {
  const doc = new JSDOM(await read(android + 'AndroidManifest.xml'), { contentType: 'text/xml' }).window.document;
  const permissions = [...doc.querySelectorAll('uses-permission')].map(e => e.getAttribute('android:name'));
  assert.deepEqual(permissions.sort(), ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK', 'android.permission.VIBRATE', 'com.android.vending.BILLING'].sort());
  const app = doc.querySelector('application');
  assert.equal(app.getAttribute('android:allowBackup'), 'false');
  assert.equal(app.getAttribute('android:usesCleartextTraffic'), 'false');
  assert.equal(doc.querySelector('provider').getAttribute('android:exported'), 'false');
  assert.deepEqual([...doc.querySelectorAll('intent-filter data')].map(e => e.getAttribute('android:host')).sort(), ['auth', 'enrollment', 'invite', 'reservation']);
  for (const data of doc.querySelectorAll('intent-filter data')) assert.equal(data.getAttribute('android:scheme'), 'ro.rezerva.app');
  const metadata = [...doc.querySelectorAll('application > meta-data')];
  assert(metadata.some(e => e.getAttribute('android:resource') === '@drawable/ic_stat_rezerva'));
  assert(metadata.some(e => e.getAttribute('android:value') === 'rezerva_bookings'));
});

test('Android assets: density icons, transparent white notification glyph and native splash wiring', async () => {
  for (const [density, size] of [['mdpi', 24], ['hdpi', 36], ['xhdpi', 48], ['xxhdpi', 72], ['xxxhdpi', 96]]) {
    const path = new URL('../' + android + `res/drawable-${density}/ic_stat_rezerva.png`, import.meta.url);
    const { data, info } = await sharp(fileURLToPath(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size); assert.equal(info.height, size);
    let visible = 0, transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) { visible++; assert.equal(data[i], 255); assert.equal(data[i + 1], 255); assert.equal(data[i + 2], 255); }
      else transparent++;
    }
    assert(visible > 0 && transparent > 0);
    const icon = await sharp(fileURLToPath(new URL('../' + android + `res/mipmap-${density}/ic_launcher.png`, import.meta.url))).metadata();
    assert.equal(icon.width, Number(size) * 2);
  }
  assert.match(await read(android + 'res/values/styles.xml'), /windowSplashScreenAnimatedIcon.*@drawable\/splash_logo/);
  const activity = await read(android + 'java/ro/rezerva/app/MainActivity.java');
  assert(activity.indexOf('SplashScreen.installSplashScreen(this)') < activity.indexOf('super.onCreate(savedInstanceState)'));
  const config = JSON.parse(await read('capacitor.config.json'));
  assert.equal(config.plugins.SplashScreen, undefined, 'No ignored SplashScreen plugin configuration');
});

test('The three existing Supabase Twilio secret names are required exactly', () => {
  const config = { TWILLIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILLIO_AUTH_TOKEN: 'offline-only', TWILIO_VERIFY_SERVICE_SID: 'VA' + 'b'.repeat(32) };
  assert.equal(twilioHeaders(config).Authorization, 'Basic ' + Buffer.from(config.TWILLIO_ACCOUNT_SID + ':offline-only').toString('base64'));
  assert.throws(() => twilioHeaders({ TWILIO_ACCOUNT_SID: config.TWILLIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: 'old' }), /TWILLIO_ACCOUNT_SID/);
});

test('Firebase full JSON: local signature, new project ID and fail-closed invalid configuration', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = { type: 'service_account', project_id: 'offline-project', client_email: 'offline@example.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const config = { SUPABASE_URL: 'https://offline.supabase.co', FIREBASE_PROJID: 'offline-project', GCLOUD_SERVICEACCOUNT_KEYS: JSON.stringify(credentials) };
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const assertion = options.body.get('assertion');
    const parts = assertion.split('.');
    assert(createVerify('RSA-SHA256').update(parts.slice(0, 2).join('.')).verify(publicKey, parts[2], 'base64url'));
    assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss, credentials.client_email);
    return Response.json({ access_token: 'offline-fake-token' });
  };
  assert.equal(await firebaseToken(config), 'offline-fake-token');
  await assert.rejects(firebaseToken({ ...config, FIREBASE_PROJID: 'wrong-project' }), /mismatch/);
  await assert.rejects(firebaseToken({ ...config, GCLOUD_SERVICEACCOUNT_KEYS: 'invalid' }), /Cannot parse/);
  await assert.rejects(firebaseToken({ ...config, FIREBASE_SERVICE_ACCOUNT_FILE: 'not-read.json' }), /exactly one/);
  await assert.rejects(firebaseToken({ ...config, GCLOUD_SERVICEACCOUNT_KEYS: '' }), /exactly one/);
  assert.equal(calls, 1);
});

test('Notification permission, Android channel and registration use the actual JS service', async t => {
  t.after(() => { delete globalThis.pushFixture; });
  const events = [], listeners = {};
  let permission = 'prompt-with-rationale';
  const fixture = {
    config: { mode: 'live' }, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    Preferences: { set: async () => { events.push('save'); } },
    getSupabase: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'offline-user' } } }) },
      from: () => ({ upsert: async () => { events.push('upsert'); return { error: null }; } }) }),
    PushNotifications: {
      checkPermissions: async () => ({ receive: permission }),
      requestPermissions: async () => { events.push('request'); return { receive: 'granted' }; },
      createChannel: async channel => { assert.equal(channel.id, 'rezerva_bookings'); assert.equal(channel.sound, undefined); events.push('channel'); },
      addListener: async (name, fn) => { listeners[name] = fn; return { remove: async () => { events.push('remove'); } }; },
      register: async () => { events.push('register'); await listeners.registration({ value: 'offline-device' }); },
    },
  };
  globalThis.pushFixture = fixture;
  const result = await build({ entryPoints: ['src/services/notifications.js'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{
    name: 'offline-native-fixture', setup(builder) {
      builder.onResolve({ filter: /^@capacitor\/|^\.\.\/(?:config|api\/supabase)\.js$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const { Capacitor, Preferences, PushNotifications, config, getSupabase } = globalThis.pushFixture;' }));
    },
  }] });
  const { registerPushNotifications } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.deepEqual(await registerPushNotifications(), { enabled: true, demo: false });
  assert.deepEqual(events.slice(0, 5), ['request', 'channel', 'register', 'upsert', 'save']);
  assert.equal(events.filter(e => e === 'remove').length, 2);
  events.length = 0; permission = 'denied';
  assert.deepEqual(await registerPushNotifications(), { enabled: false, reason: 'denied' });
  assert.equal(events.length, 0);
});

test('HTML setup: all steps, exact secret names, safe local commands and no executable content', async () => {
  const doc = new JSDOM(await read('SETUP.html')).window.document;
  for (let i = 1; i <= 13; i++) assert(doc.getElementById(`step-${i}`));
  for (const link of doc.querySelectorAll('a[href^="#"]')) assert(doc.getElementById(link.getAttribute('href').slice(1)));
  assert.equal(doc.querySelectorAll('script, iframe, form').length, 0);
  for (const name of ['GCLOUD_SERVICEACCOUNT_KEYS', 'SUPABASEGOOGLEOAUTH_CLIENTID', 'SUPABASEGOOGLEOAUTH_CLIENTSECRET', 'TWILLIO_ACCOUNT_SID', 'TWILLIO_AUTH_TOKEN', 'FIREBASE_PROJID', 'TWILIO_VERIFY_SERVICE_SID']) assert(doc.body.textContent.includes(name));
  for (const command of ['npm run assets', 'npm run test:local', 'npm run android:sync', 'npm run check:phone']) assert(doc.body.textContent.includes(command));
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['test:local'], 'npm test');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs');
});
