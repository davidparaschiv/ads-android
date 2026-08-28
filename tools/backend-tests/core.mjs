// @ts-check
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export class CheckError extends Error {}
export class Skip extends Error {}
export function ensure(condition, message) { if (!condition) throw new CheckError(message); }
export function need(config, ...names) {
  for (const name of names) ensure(config[name]?.trim(), `Configure ${name} in .env.backend.local.`);
}
export async function readConfig(path = resolve(root, '.env.backend.local')) {
  let data;
  try { data = await readFile(path, 'utf8'); } catch { throw new CheckError('Run npm run test:backend:setup, then edit .env.backend.local.'); }
  const config = parseEnv(data);
  // Deliberately do not read arbitrary process.env or automatically use app/server credentials.
  need(config, 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'BACKEND_TEST_PROJECT_REF');
  ensure(config.BACKEND_TEST_ENABLED === 'true', 'Set BACKEND_TEST_ENABLED=true after reviewing the test target.');
  ensure(config.BACKEND_TEST_ENVIRONMENT === 'development', 'Only a designated development project is allowed.');
  const url = new URL(config.SUPABASE_URL);
  ensure(/^[a-z0-9]{20}$/.test(config.BACKEND_TEST_PROJECT_REF), 'Invalid BACKEND_TEST_PROJECT_REF.');
  ensure(url.href === `https://${config.BACKEND_TEST_PROJECT_REF}.supabase.co/`, 'SUPABASE_URL must exactly match BACKEND_TEST_PROJECT_REF (no custom host/path).');
  config.SUPABASE_URL = url.origin;
  ensure(!config.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_'), 'Use a publishable/anon key, never a service-role key.');
  if (!config.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) {
    let payload;
    try { payload = JSON.parse(Buffer.from(config.SUPABASE_PUBLISHABLE_KEY.split('.')[1], 'base64url').toString()); } catch { /* handled below */ }
    ensure(payload?.role === 'anon', 'Only a publishable or legacy anon client key is accepted.');
  }
  const timeout = Number(config.BACKEND_TEST_TIMEOUT_MS || 15000);
  ensure(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000, 'Timeout must be 1000..60000 ms.');
  return config;
}
export function redact(message, config) {
  let text = String(message);
  for (const value of Object.values(config)) if (value && value.length >= 4) text = text.split(value).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sbp_|sb_secret_|re_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/RZ[LEAI]-[A-Fa-f0-9-]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[url]');
}
export function safeError(error, config) {
  // Provider/database messages can contain PII, SQL, passwords or a private key.
  // Only our own bounded, non-provider error messages are printable.
  return error instanceof CheckError || error instanceof Skip
    ? redact(error.message, config) : 'Unexpected local/database error; check configuration, TLS and permissions. Raw details withheld to protect secrets.';
}
export function consent(flags, ...required) {
  for (const name of required) ensure(flags.has(name), `This operation requires --${name}; read SETUP.html#backend-tests first.`);
}
export function recipient(config, name) {
  need(config, name);
  const value = config[name].trim();
  ensure(name === 'TEST_PHONE_TO' ? /^\+407\d{8}$/.test(value) : /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value), `Invalid ${name}; supply one recipient you control.`);
  return value;
}
export function uuid(value, label) { ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || ''), `Configure a UUID for ${label}.`); return value; }
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export async function request(config, url, options = {}) {
  const target = new URL(url);
  const allowed = [new URL(config.SUPABASE_URL).host, 'api.resend.com', 'verify.twilio.com', 'oauth2.googleapis.com', 'fcm.googleapis.com', 'api.revenuecat.com'];
  ensure(target.protocol === 'https:' && allowed.includes(target.host) && !target.username && !target.password, 'Refusing an unexpected service destination.');
  try {
    const response = await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(Number(config.BACKEND_TEST_TIMEOUT_MS || 15000)) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, headers: response.headers, data };
  } catch { throw new CheckError('Network/TLS request failed or timed out. Check connectivity; TLS verification remains enabled.'); }
}
export function ok(result, expected = 200) { ensure(result.status === expected, `Unexpected HTTP status ${result.status}; expected ${expected}. Check the service dashboard logs privately.`); }
export function authHeaders(config, token = '') {
  return { apikey: config.SUPABASE_PUBLISHABLE_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' };
}
export async function rpc(config, name, args, token) {
  const res = await request(config, `${config.SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: authHeaders(config, token), body: JSON.stringify(args) });
  ok(res); ensure(res.data?.ok !== false, `RPC ${name} rejected the operation. Check account state and rate limits.`); return res.data;
}
export async function edge(config, name, body, token, extra = {}) {
  return request(config, `${config.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { ...authHeaders(config, token), ...extra }, body: JSON.stringify(body) });
}
export async function loadState(config) {
  let state;
  try { state = JSON.parse(await readFile(resolve(root, '.backend-test-state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new CheckError('Cannot read test state; do not overwrite it before reviewing existing test artifacts.'); }
  if (state) ensure(state.project === config.BACKEND_TEST_PROJECT_REF, 'Test state belongs to another project. Move it aside deliberately before switching.');
  return state || { project: config.BACKEND_TEST_PROJECT_REF, runId: randomUUID() };
}
export async function saveState(state) { await writeFile(resolve(root, '.backend-test-state.json'), JSON.stringify(state, null, 2), { mode: 0o600 }); }
export async function lock() {
  const path = resolve(root, '.backend-test.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); } catch { throw new CheckError('Another test run is active, or .backend-test.lock is stale. Only remove that file after confirming no test process is running.'); }
  await handle.writeFile(String(process.pid));
  return async () => { await handle.close(); await unlink(path); };
}
export async function actor(config, role) {
  const prefix = `TEST_${role.toUpperCase()}`;
  const email = recipient(config, `${prefix}_EMAIL`).toLowerCase();
  let token = config[`${prefix}_ACCESS_TOKEN`];
  if (!token) {
    let sessions; try { sessions = JSON.parse(await readFile(resolve(root, '.backend-test-sessions.json'), 'utf8')); } catch { /* handled below */ }
    ensure(sessions?.project === config.BACKEND_TEST_PROJECT_REF && sessions?.[role]?.access_token, `Run npm run test:backend:login -- ${role} or configure ${prefix}_ACCESS_TOKEN.`);
    token = sessions[role].access_token;
  }
  const response = await request(config, `${config.SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(config, token) });
  ensure(response.status === 200, `Session for ${role} is invalid/expired; log in again.`);
  const user = response.data;
  ensure(user.email?.toLowerCase() === email && user.email_confirmed_at && user.identities?.some(i => i.provider === 'google'), `The ${role} session must belong to its allowlisted verified Google account.`);
  return { token, id: uuid(user.id, `${role} user`), email };
}
export async function report(command, rows) {
  const directory = resolve(root, '.backend-test-results'); await mkdir(directory, { recursive: true });
  const data = { command, date: new Date().toISOString(), results: rows, passed: rows.filter(r => r.status === 'PASS').length,
    failed: rows.filter(r => r.status === 'FAIL').length, skipped: rows.filter(r => r.status === 'SKIP').length };
  await writeFile(resolve(directory, 'latest.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
  return data;
}
