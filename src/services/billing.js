// @ts-check
import { Capacitor } from '@capacitor/core';
import { Purchases } from '@revenuecat/purchases-capacitor';
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';
import { loggedExternalCall } from '../observability/external-api-log.js';

let configuredFor = '';
export async function configureBilling(userId) {
  if (config.mode === 'demo') return;
  if (!userId) throw new Error('Autentificare necesară.');
  if (!Capacitor.isNativePlatform()) throw new Error('Plățile Google Play se testează pe Android.');
  if (!config.revenueCat.googleApiKey) throw new Error('Cheia publică RevenueCat nu este configurată.');
  if (configuredFor === userId) return;
  if (configuredFor) await loggedExternalCall('revenuecat', 'log-in', () => Purchases.logIn({ appUserID: userId }));
  else await loggedExternalCall('revenuecat', 'configure', () => Purchases.configure({ apiKey: config.revenueCat.googleApiKey, appUserID: userId }));
  configuredFor = userId;
}

export async function offeringFor(planId, userId) {
  await configureBilling(userId);
  const { current } = await loggedExternalCall('revenuecat', 'get-offerings', () => Purchases.getOfferings());
  const productId = config.plans[planId].productId;
  const selected = current?.availablePackages.find(item => item.product.identifier.split(':')[0] === productId);
  if (!selected) throw new Error('Produsul Google Play nu există în oferta RevenueCat.');
  return selected;
}

export async function purchasePlan(planId, userId) {
  if (config.mode === 'demo') throw new Error('Plata se testează pe Android în modul live. În demo poți introduce cheia de dezvoltare.');
  const selected = await offeringFor(planId, userId);
  const { customerInfo } = await loggedExternalCall('revenuecat', 'get-customer-info', () => Purchases.getCustomerInfo());
  const current = customerInfo.entitlements.active[config.revenueCat.entitlementId];
  const oldProductIdentifier = current ? current.productIdentifier + (current.productPlanIdentifier && !current.productIdentifier.includes(':') ? ':' + current.productPlanIdentifier : '') : null;
  if (oldProductIdentifier?.split(':')[0] === config.plans[planId].productId) return syncEntitlement();
  // RevenueCat enum values: 1 = immediate time proration, 6 = deferred until renewal.
  // Pass the previous Play product to REPLACE it, never create a second subscription.
  await loggedExternalCall('revenuecat', 'purchase-package', () => Purchases.purchasePackage({ aPackage: selected, ...(oldProductIdentifier ? {
    googleProductChangeInfo: { oldProductIdentifier, prorationMode: planId === 'small' ? 6 : 1 },
  } : {}) }));
  return syncEntitlement();
}

export async function restorePurchases() {
  if (config.mode === 'demo') throw new Error('Restaurarea achizițiilor necesită Google Play în modul live.');
  await configureBilling(store.get().user?.id || '');
  await loggedExternalCall('revenuecat', 'restore-purchases', () => Purchases.restorePurchases());
  return syncEntitlement();
}

async function syncEntitlement() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Server neconfigurat.');
  const { data, error } = await supabase.functions.invoke('sync-subscription', { body: {} });
  if (error || !data?.active) throw new Error('Abonamentul nu a fost confirmat de server. Reîncearcă restaurarea; nu cumpăra din nou.');
  return data;
}
