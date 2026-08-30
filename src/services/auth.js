// @ts-check
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';
import { rememberReservationQr, hasPendingReservationQr, clearPendingReservationQr } from './qr-session.js';
import { navigate } from '../router.js';
import { loggedExternalCall } from '../observability/external-api-log.js';

let listenerInstalled = false;
let explicitSignOut = false;
// In memory only: never persist invitation or license secrets in Preferences.
let pendingInvitation = '';
let pendingEnrollment = '';
export const takePendingEnrollment = () => pendingEnrollment;
export const clearPendingEnrollment = () => { pendingEnrollment = ''; };
export const setDemoEnrollmentToken = token => { if (config.mode === 'demo') pendingEnrollment = token; };
export const businessEntryRoute = () => pendingEnrollment ? '/business/verification' : (pendingInvitation || store.get().inviteFlow) ? '/business/invite' : hasPendingReservationQr() ? '/business/scan' : '/business/start';
export async function resolveBusinessEntryRoute() {
  const immediate = businessEntryRoute();
  if (immediate !== '/business/start') return immediate;
  const [enrollmentService, { workspaces, getAccess }] = await Promise.all([
    import('./enrollment.js'),
    import('./access.js'),
  ]);
  const enrollment = await enrollmentService.enrollmentStatus();
  if (enrollment?.status === 'pending') return '/business/verification';
  const list = await workspaces();
  if (!list.length) {
    await store.set({ business: null });
    if (await enrollmentService.isPlatformOwnerAccount()) return '/business/approve';
    return '/business/details';
  }
  const selected = list.find(item => item.id === store.get().business?.id)
    || list.find(item => item.is_owner)
    || list[0];
  await store.set({ business: selected });
  return (await getAccess(selected.id)).active ? '/business/home' : '/business/plans';
}
export const homeRoute = () => {
  const state = store.get();
  if (state.user) {
    if (state.role === 'customer') return state.customerProfileComplete ? '/customer/search' : '/customer/profile-setup';
    return '/business/start';
  }
  if (state.role === 'customer') return '/customer/login';
  if (state.role === 'business') return '/business/login';
  return '/';
};
export const takePendingInvitation = () => { const token = pendingInvitation; pendingInvitation = ''; return token; };
export const hasPendingInvitation = () => Boolean(pendingInvitation);

async function handleUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== new URL(config.authRedirectUrl).protocol) return;
  if (parsed.hostname === 'reservation') {
    try { rememberReservationQr(url); } catch { return; }
    await store.set({ role: 'business' });
    navigate(store.get().user ? '/business/scan' : '/business/login');
    return;
  }
  if (parsed.hostname === 'enrollment') {
    const token = parsed.searchParams.get('token') || '';
    if (/^RZ[EA]-[A-F0-9]{64}$/.test(token)) {
      pendingEnrollment = token;
      await store.set({ role: 'business' });
      window.location.hash = store.get().user ? '/business/verification' : '/business/login';
    }
    return;
  }
  if (parsed.hostname === 'invite') {
    const token = parsed.searchParams.get('token') || '';
    if (/^RZI-[A-F0-9]{64}$/i.test(token)) {
      pendingInvitation = token;
      await store.set({ role: 'business' });
      window.location.hash = store.get().user ? '/business/invite' : '/business/login';
    }
    return;
  }
  if (parsed.hostname !== 'auth') return;
  const code = parsed.searchParams.get('code');
  const supabase = getSupabase();
  if (!code || !supabase) return;
  const { data, error } = await loggedExternalCall('google-oauth', 'exchange-code', () => supabase.auth.exchangeCodeForSession(code));
  await Browser.close().catch(() => undefined);
  if (error) { window.location.hash = '/business/login'; return; }
  if (data.user) await saveUser(data.user);
  window.location.hash = store.get().role === 'business' ? await resolveBusinessEntryRoute() : homeRoute();
}

export async function initializeAuth() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  if (config.mode !== 'demo') {
    const supabase = getSupabase();
    if (supabase) {
      // Never trust cached UI identity as proof of authentication.
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) await saveUser(data.session.user);
      // A temporary refresh/network failure must not erase the persisted UI
      // identity. Server authorization still protects every data operation.
      else if (!store.get().user) await store.set({ user: null, business: null });
      supabase.auth.onAuthStateChange((_event, session) => {
        // Avoid another Supabase call inside this callback.
        if (session?.user) void saveUser(session.user);
        else if (explicitSignOut) void store.set({ user: null, business: null });
      });
      if (!Capacitor.isNativePlatform() && new URL(window.location.href).searchParams.has('code')) {
        window.history.replaceState(null, '', window.location.pathname);
        window.location.hash = store.get().role === 'business' ? await resolveBusinessEntryRoute() : homeRoute();
      }
    }
  }
  if (Capacitor.isNativePlatform()) {
    await App.addListener('appUrlOpen', ({ url }) => { void handleUrl(url); });
    await App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else navigate(homeRoute());
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) await handleUrl(launch.url);
  }
}

/** @param {'business' | 'customer'} role */
export async function signInWithGoogle(role) {
  await store.set({ role });
  if (config.mode === 'demo') {
    const user = role === 'business'
      ? { id: 'demo-business-user', name: 'Andrei Popescu', email: 'andrei@demo.ro' }
      : { id: 'demo-customer-user', name: 'Maria Ionescu', email: 'maria@demo.ro' };
    await store.set({ user });
    return { user, demo: true };
  }
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase nu este configurat.');
  const redirectTo = Capacitor.isNativePlatform() ? config.authRedirectUrl : window.location.origin + '/';
  const { data, error } = await loggedExternalCall('google-oauth', 'create-authorization-url', () => supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: Capacitor.isNativePlatform(), queryParams: { prompt: 'select_account' } },
  }));
  if (error) throw error;
  if (Capacitor.isNativePlatform() && data.url) await loggedExternalCall('google-oauth', 'open-authorization-browser', () => Browser.open({ url: data.url }));
  return { user: null, demo: false };
}

export async function signOut() {
  explicitSignOut = true;
  const supabase = getSupabase();
  try {
    if (supabase) {
      const user = store.get().user;
      // Prevent push on a device after sign-out. Server policies still check recipient identity.
      const { value: token } = await Preferences.get({ key: 'rezerva.push.token' });
      if (token && user) await supabase.from('device_tokens').delete().eq('user_id', user.id).eq('token', token);
      await Preferences.remove({ key: 'rezerva.push.token' });
      await supabase.auth.signOut();
    }
  } finally {
    explicitSignOut = false;
  }
  pendingInvitation = '';
  pendingEnrollment = '';
  clearPendingReservationQr();
  await store.clear();
}

/** @param {import('@supabase/supabase-js').User} user */
async function saveUser(user) {
  const previous = store.get().user;
  await store.set({
    ...(previous?.id !== user.id ? { business: null, customerProfileComplete: false } : {}),
    user: { id: user.id, email: user.email || '', name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Utilizator' },
  });
}
