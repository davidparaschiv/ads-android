// @ts-check

/**
 * Central application configuration. All account-specific values come from .env.
 * @typedef {'demo' | 'live'} AppMode
 */

const env = import.meta.env;

export const config = Object.freeze({
  mode: /** @type {AppMode} */ (env.VITE_APP_MODE === 'live' ? 'live' : 'demo'),
  features: Object.freeze({
    licenseRedemption: env.VITE_ENABLE_LICENSE_REDEMPTION !== 'false',
  }),
  appName: env.VITE_APP_NAME || 'Rezervari.ai',
  appId: 'ro.rezerva.app',
  locale: 'ro-RO',
  timezone: 'Europe/Bucharest',
  authRedirectUrl: env.VITE_AUTH_REDIRECT_URL || 'ro.rezerva.app://auth/callback',
  supabase: Object.freeze({
    url: env.VITE_SUPABASE_URL || '',
    anonKey: env.VITE_SUPABASE_ANON_KEY || '',
  }),
  revenueCat: Object.freeze({
    googleApiKey: env.VITE_REVENUECAT_GOOGLE_API_KEY || '',
    entitlementId: env.VITE_REVENUECAT_ENTITLEMENT_ID || 'business_pro',
  }),
  links: Object.freeze({
    terms: env.VITE_TERMS_URL || '/terms.html',
    support: env.VITE_SUPPORT_URL || 'https://example.com/support',
    privacy: env.VITE_PRIVACY_URL || '/privacy-policy.html',
    deleteAccount: env.VITE_DELETE_ACCOUNT_URL || 'https://example.com/stergere-cont',
  }),
  plans: Object.freeze({
    small: Object.freeze({
      id: 'small',
      name: 'Small',
      price: Number(env.VITE_SMALL_PLAN_PRICE || 50),
      productId: 'rezerva_small_monthly',
      resources: 1,
      locations: 1,
      reports: false,
      businessNotifications: false,
    }),
    large: Object.freeze({
      id: 'large',
      name: 'Complete',
      price: Number(env.VITE_LARGE_PLAN_PRICE || 150),
      productId: 'rezerva_large_monthly',
      resources: 10,
      locations: 1,
      reports: true,
      businessNotifications: true,
    }),
  }),
  reminders: Object.freeze([5, 15, 30, 60, 120, 1440]),
});

export function assertLiveConfiguration() {
  if (config.mode === 'demo') return;
  const missing = [];
  if (!config.supabase.url) missing.push('VITE_SUPABASE_URL');
  if (!config.supabase.anonKey) missing.push('VITE_SUPABASE_ANON_KEY');
  // Configure billing lazily: invited staff and license owners do not need it.
  if (missing.length) {
    throw new Error(`Configurație incompletă: ${missing.join(', ')}`);
  }
}
