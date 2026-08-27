// @ts-check
import { synchronizeSubscription } from '../_shared/revenuecat.js';

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH');
  if (!expected || request.headers.get('Authorization') !== expected) return new Response('Unauthorized', { status: 401 });
  try {
    const { event } = await request.json();
    if (event?.type === 'TEST') return Response.json({ received: true });
    const ids = [...new Set([event?.app_user_id, ...(event?.transferred_from || []), ...(event?.transferred_to || [])])]
      .filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20);
    // Fetch authoritative current state; delayed/cancellation events cannot overwrite a newer renewal.
    for (const id of ids) await synchronizeSubscription(id);
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
});
