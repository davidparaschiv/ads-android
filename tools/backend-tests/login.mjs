// @ts-check
// Optional real Google login helper. No frontend/app changes, password capture or fake identities.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { root, readConfig, ensure, recipient, safeError, lock, CheckError, request, authHeaders } from './core.mjs';

let config = {}, unlock, server;
try {
  config = await readConfig();
  const role = process.argv[2];
  ensure(['owner', 'customer', 'staff', 'admin'].includes(role), 'Choose owner, customer, staff or admin.');
  const expected = recipient(config, `TEST_${role.toUpperCase()}_EMAIL`).toLowerCase();
  unlock = await lock();
  const callback = 'http://127.0.0.1:43821/auth/callback';
  const storage = new Map();
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(Number(config.BACKEND_TEST_TIMEOUT_MS || 15000)) }) },
    auth: { flowType: 'pkce', detectSessionInUrl: false, autoRefreshToken: false, persistSession: true,
      storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } },
  });
  let finish, rejectLogin, claimed = false;
  const completed = new Promise((resolveLogin, reject) => { finish = resolveLogin; rejectLogin = reject; });
  // Attach a handler before listening so startup/timeout errors cannot be unhandled rejections.
  completed.catch(() => {});
  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.headers.host !== '127.0.0.1:43821' || req.method !== 'GET') { res.writeHead(400); res.end('Invalid callback.'); return; }
    const url = new URL(req.url, callback);
    if (url.pathname !== '/auth/callback' || !url.searchParams.get('code') || claimed) { res.writeHead(400); res.end('No valid authorization code. Return to the terminal.'); return; }
    claimed = true;
    try {
      const { data, error } = await client.auth.exchangeCodeForSession(url.searchParams.get('code'));
      ensure(!error && data.session, 'Google code exchange failed. Check the redirect allowlist and restart login.');
      const actual = await request(config, `${config.SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(config, data.session.access_token) });
      ensure(actual.status === 200 && actual.data.email?.toLowerCase() === expected && actual.data.email_confirmed_at && actual.data.identities?.some(i => i.provider === 'google'), 'Wrong Google test account; no session was saved.');
      const path = resolve(root, '.backend-test-sessions.json');
      let sessions = { project: config.BACKEND_TEST_PROJECT_REF };
      try { sessions = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new CheckError('Existing sessions file is unreadable; not overwriting.'); }
      ensure(sessions.project === config.BACKEND_TEST_PROJECT_REF, 'Sessions belong to another test project.');
      // Store only short-lived access tokens; no refresh token is persisted.
      sessions[role] = { access_token: data.session.access_token, expires_at: data.session.expires_at };
      await writeFile(path, JSON.stringify(sessions, null, 2), { mode: 0o600 });
      res.end('Test account authenticated. Close this tab and return to the terminal.'); finish();
    } catch (error) { res.writeHead(400); res.end('Authentication failed. See the terminal.'); rejectLogin(error); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(43821, '127.0.0.1', done); });
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } });
  ensure(!error && data.url, 'Could not create Google authorization URL.');
  console.log('First add http://127.0.0.1:43821/auth/callback to Supabase Authentication > URL Configuration > Redirect URLs.');
  console.log('Keep the existing Android redirect. Open this temporary login URL in your browser (do not share it):');
  console.log(data.url);
  console.log('Waiting up to 5 minutes. Complete login with the configured Google test account.');
  const timer = setTimeout(() => rejectLogin(new CheckError('Login timed out; run the command again.')), 300000);
  try { await completed; } finally { clearTimeout(timer); }
  console.log(`Saved a short-lived ${role} session locally. No app UI was tested.`);
} catch (error) { console.error(safeError(error, config)); process.exitCode = 1; }
finally { server?.closeAllConnections(); server?.close(); await unlock?.(); }
