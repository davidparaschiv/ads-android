// @ts-check
import { env, serviceClient } from './http.js';

export async function synchronizeSubscription(ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw new Error('Invalid owner');
  const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(ownerId)}`, {
    headers: { Authorization: `Bearer ${env('REVENUECAT_SECRET_API_KEY')}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Subscription verification unavailable');
  const { subscriber } = await response.json();
  const entitlement = subscriber?.entitlements?.[Deno.env.get('REVENUECAT_ENTITLEMENT_ID') || 'business_pro'];
  const productId = entitlement?.product_identifier || '';
  const plans = { rezerva_small_monthly: 'small', rezerva_large_monthly: 'large' };
  const planId = plans[productId.split(':')[0]];
  const service = serviceClient();
  if (!planId) {
    const { error } = await service.from('subscriptions').update({ status: 'expired', expires_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('owner_id', ownerId);
    if (error) throw error;
    return;
  }
  const purchase = subscriber.subscriptions?.[productId];
  if (!purchase || String(purchase.store).toLowerCase() !== 'play_store') throw new Error('Unsupported store');
  const expiresAt = entitlement.expires_date;
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) throw new Error('Missing expiration');
  const { data: business, error: lookupError } = await service.from('businesses').select('id').eq('owner_id', ownerId).maybeSingle();
  if (lookupError) throw lookupError;
  const { error } = await service.from('subscriptions').upsert({
    owner_id: ownerId, business_id: business?.id || null, plan_id: planId, product_id: productId,
    status: Date.parse(expiresAt) > Date.now() ? 'active' : 'expired', store: 'google_play',
    environment: purchase.is_sandbox ? 'sandbox' : 'production', expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_id' });
  if (error) throw error;
}
