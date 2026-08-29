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
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const missingSetting = message.startsWith('Missing server setting:') ? message.slice('Missing server setting:'.length).trim() : '';
    return json(request, {
      error: 'Abonamentul nu a putut fi verificat. Reîncearcă restaurarea achizițiilor.',
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...(missingSetting ? { diagnostic: { provider: 'revenuecat', operation: 'configuration', missingSetting } } : {}),
    }, 502);
  }
});
