// @ts-check
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Purchases } from '@revenuecat/purchases-capacitor';
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';
import { loggedExternalCall } from '../observability/external-api-log.js';
import { DATABASE_ACTIONS, loggedDatabaseAction } from '../observability/database-action-log.js';

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
  if (oldProductIdentifier?.split(':')[0] === config.plans.large.productId && planId === 'small') {
    throw new Error('Trecerea de la Complete la Small nu este disponibilă. Poți păstra Complete sau anula abonamentul din Google Play.');
  }
  if (oldProductIdentifier?.split(':')[0] === config.plans[planId].productId) return syncEntitlement();
  // RevenueCat enum value 1 = immediate time proration for Small -> Complete.
  // Pass the previous Play product to REPLACE it, never create a second subscription.
  await loggedExternalCall('revenuecat', 'purchase-package', () => Purchases.purchasePackage({ aPackage: selected, ...(oldProductIdentifier ? {
    googleProductChangeInfo: { oldProductIdentifier, prorationMode: 1 },
  } : {}) }));
  return syncEntitlement();
}

export async function restorePurchases() {
  if (config.mode === 'demo') throw new Error('Restaurarea achizițiilor necesită Google Play în modul live.');
  await configureBilling(store.get().user?.id || '');
  await loggedExternalCall('revenuecat', 'restore-purchases', () => Purchases.restorePurchases());
  return syncEntitlement();
}

export async function getBillingStatus(userId) {
  if (config.mode === 'demo') {
    const access = await import('./access.js').then(module => module.getAccess(store.get().business?.id));
    return { active: access.active, planId: access.planId, willRenew: false, expirationDate: access.expiresAt || null, managementURL: null };
  }
  await configureBilling(userId);
  const { customerInfo } = await loggedExternalCall('revenuecat', 'get-customer-info', () => Purchases.getCustomerInfo());
  const entitlement = customerInfo.entitlements.active[config.revenueCat.entitlementId];
  const product = entitlement?.productIdentifier?.split(':')[0] || '';
  const planId = Object.keys(config.plans).find(id => config.plans[id].productId === product) || null;
  return {
    active: Boolean(entitlement?.isActive),
    planId,
    willRenew: Boolean(entitlement?.willRenew),
    expirationDate: entitlement?.expirationDate || null,
    managementURL: customerInfo.managementURL || null,
  };
}

export async function openSubscriptionManagement(userId) {
  const status = await getBillingStatus(userId);
  const url = status.managementURL || 'https://play.google.com/store/account/subscriptions';
  await loggedExternalCall('google-play', 'open-subscription-management', () => Browser.open({ url }));
}

async function syncEntitlement() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Server neconfigurat.');
  return loggedDatabaseAction(DATABASE_ACTIONS.BV_REFRESH_SUBSCRIPTION,async()=>{
    const { data, error } = await supabase.functions.invoke('sync-subscription', { body: {} });
    if (error || !data?.active) {
      const failure = new Error('Abonamentul nu a fost confirmat de server. Reîncearcă restaurarea; nu cumpăra din nou.');
      if (error) Object.assign(failure,{code:error.code || '',details:error.message || ''});
      throw failure;
    }
    return data;
  });
}
