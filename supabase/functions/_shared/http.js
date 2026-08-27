// @ts-check
import { createClient } from 'npm:@supabase/supabase-js@2';

export function env(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server setting: ${name}`);
  return value;
}

export function headers(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || 'https://localhost,http://localhost,http://localhost:5173').split(',');
  return {
    ...(allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Vary': 'Origin', 'Cache-Control': 'no-store',
  };
}
export const json = (request, body, status = 200) => Response.json(body, { status, headers: headers(request) });

export async function authenticated(request) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new Error('Authentication required');
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } }, auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Authentication required');
  return { client, user: data.user };
}
export const serviceClient = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
