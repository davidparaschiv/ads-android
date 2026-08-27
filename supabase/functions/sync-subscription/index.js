// @ts-check
import { authenticated, headers, json } from '../_shared/http.js';
import { synchronizeSubscription } from '../_shared/revenuecat.js';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: headers(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);
  let actor;
  try { actor = await authenticated(request); } catch { return json(request, { error: 'Autentificare necesară.' }, 401); }
  try {
    await synchronizeSubscription(actor.user.id);
    const { data, error } = await actor.client.rpc('get_access');
    if (error) throw error;
    return json(request, data);
  } catch {
    return json(request, { error: 'Abonamentul nu a putut fi verificat. Reîncearcă restaurarea achizițiilor.' }, 502);
  }
});
