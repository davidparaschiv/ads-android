// @ts-check
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';
import { rememberReservationQr, hasPendingReservationQr, clearPendingReservationQr } from './qr-session.js';
import { shouldIgnoreNativeBack } from './native-interaction.js';
import { navigate } from '../router.js';
import { loggedExternalCall } from '../observability/external-api-log.js';
import { currentDeviceRemovalAction, loggedDatabaseAction } from '../observability/database-action-log.js';

let listenerInstalled = false;
let explicitSignOut = false;
let accountResetSignOut = false;
let accountResetChannel = null;
// In memory only: never persist invitation or license secrets in Preferences.
let pendingInvitation = '';
let pendingEnrollment = '';
export const takePendingEnrollment = () => pendingEnrollment;
export const clearPendingEnrollment = () => { pendingEnrollment = ''; };
export const setDemoEnrollmentToken = token => { if (config.mode === 'demo') pendingEnrollment = token; };
export const businessEntryRoute = () => pendingEnrollment ? '/business/verification' : (pendingInvitation || store.get().inviteFlow) ? '/business/invite' : hasPendingReservationQr() ? '/business/scan' : '/business/start';
async function businessRouteForCurrentAccount() {
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

async function customerRouteForCurrentAccount() {
  const { getCustomerProfile } = await import('./customer-profile.js');
  const profile = await getCustomerProfile();
  if (!profile?.completed) {
    await store.set({ customerProfileComplete: false });
    return '/customer/profile-setup';
  }
  await store.set({
    customerProfileComplete: true,
    user: { ...store.get().user, name: `${profile.firstName} ${profile.lastName}`.trim() },
  });
  return '/customer/search';
}

export async function resolveBusinessEntryRoute() {
  if (!store.get().user) return '/business/login';
  const accountType = await enforceExistingAccountType();
  if (accountType === 'client') return customerRouteForCurrentAccount();
  return businessRouteForCurrentAccount();
}

export async function resolveCustomerEntryRoute() {
  if (!store.get().user) return '/customer/login';
  const accountType = await enforceExistingAccountType();
  if (accountType === 'business' || accountType === 'invitee') return businessRouteForCurrentAccount();
  return customerRouteForCurrentAccount();
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
    await store.set({ role: 'business', requestedAccountType: 'business' });
    navigate(store.get().user ? '/business/scan' : '/business/login');
    return;
  }
  if (parsed.hostname === 'enrollment') {
    const token = parsed.searchParams.get('token') || '';
    if (/^RZ[EA]-[A-F0-9]{64}$/.test(token)) {
      pendingEnrollment = token;
      await store.set({ role: 'business', requestedAccountType: 'business' });
      window.location.hash = store.get().user ? '/business/verification' : '/business/login';
    }
    return;
  }
  if (parsed.hostname === 'invite') {
    const token = parsed.searchParams.get('token') || '';
    if (/^RZI-[A-F0-9]{64}$/i.test(token)) {
      pendingInvitation = token;
      await store.set({ role: 'business', requestedAccountType: 'invitee', inviteFlow: true });
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
  if (data.user) {
    await saveUser(data.user);
    await enforceExistingAccountType();
  }
  window.location.hash = store.get().role === 'business' ? await resolveBusinessEntryRoute() : await resolveCustomerEntryRoute();
}

export async function initializeAuth() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  if (config.mode !== 'demo') {
    const supabase = getSupabase();
    if (supabase) {
      // Never trust cached UI identity as proof of authentication.
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) {
        const reset = await watchAccountReset(supabase,data.session);
        if (!reset) {
          await saveUser(data.session.user);
          await enforceExistingAccountType();
        }
      }
      // A temporary refresh/network failure must not erase the persisted UI
      // identity. Server authorization still protects every data operation.
      else if (!store.get().user) await store.set({ user: null, business: null });
      supabase.auth.onAuthStateChange((_event, session) => {
        // Avoid another Supabase call inside this callback.
        if (session?.user) queueMicrotask(()=>void handleAuthenticatedSession(supabase,session));
        else if (explicitSignOut) void store.set({ user: null, business: null });
      });
      if (!Capacitor.isNativePlatform() && new URL(window.location.href).searchParams.has('code')) {
        window.history.replaceState(null, '', window.location.pathname);
        window.location.hash = store.get().role === 'business' ? await resolveBusinessEntryRoute() : await resolveCustomerEntryRoute();
      }
    }
  }
  if (Capacitor.isNativePlatform()) {
    await App.addListener('appUrlOpen', ({ url }) => { void handleUrl(url); });
    await App.addListener('backButton', ({ canGoBack }) => {
      if (shouldIgnoreNativeBack()) return;
      if (canGoBack) window.history.back();
      else navigate(homeRoute());
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) await handleUrl(launch.url);
  }
}

/** @param {'business' | 'customer'} role @param {'business'|'client'|'invitee'} [accountType] */
export async function signInWithGoogle(role, accountType = role === 'customer' ? 'client' : 'business') {
  await store.set({
    role,
    requestedAccountType: accountType,
    accountTypeNotice: '',
    inviteFlow: accountType === 'invitee',
  });
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
  let failure = null;
  try {
    if (supabase) {
      const user = store.get().user;
      // Prevent push on a device after sign-out. Server policies still check recipient identity.
      const { value: token } = await Preferences.get({ key: 'rezerva.push.token' });
      if (token && user) await loggedDatabaseAction(currentDeviceRemovalAction(),async()=>{
        const { error } = await supabase.from('device_tokens').delete().eq('user_id', user.id).eq('token', token);
        if (error) throw error;
      }).catch(() => undefined);
      await Preferences.remove({ key: 'rezerva.push.token' });
      await supabase.auth.signOut();
    }
  } catch (error) {
    failure = error;
    if (supabase) await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  } finally {
    await stopAccountResetWatcher(supabase);
    explicitSignOut = false;
    pendingInvitation = '';
    pendingEnrollment = '';
    clearPendingReservationQr();
    await store.clear();
  }
  if (failure) throw failure;
}

async function handleAuthenticatedSession(supabase,session) {
  if (await watchAccountReset(supabase,session)) return;
  await saveUser(session.user);
}

async function watchAccountReset(supabase,session) {
  if (!session?.user?.id || typeof supabase.from !== 'function') return false;
  await stopAccountResetWatcher(supabase);
  const { data } = await supabase.from('account_reset_events')
    .select('reset_at').eq('user_id',session.user.id).maybeSingle();
  const resetAt = Date.parse(data?.reset_at || '');
  if (Number.isFinite(resetAt) && sessionStartedAt(session) <= resetAt) {
    await forceAccountResetSignOut();
    return true;
  }
  if (typeof supabase.channel === 'function') {
    accountResetChannel = supabase.channel(`account-reset-${session.user.id}`)
      .on('postgres_changes',{
        event:'*',schema:'public',table:'account_reset_events',filter:`user_id=eq.${session.user.id}`,
      },()=>{ void forceAccountResetSignOut(); })
      .subscribe();
  }
  return false;
}

function sessionStartedAt(session) {
  const lastSignIn = Date.parse(session?.user?.last_sign_in_at || '');
  if (Number.isFinite(lastSignIn)) return lastSignIn;
  try {
    const encoded = String(session?.access_token || '').split('.')[1] || '';
    const payload = JSON.parse(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')));
    const issuedAt = Number(payload.iat) * 1000;
    return Number.isFinite(issuedAt) ? issuedAt : 0;
  } catch { return 0; }
}

async function stopAccountResetWatcher(supabase=getSupabase()) {
  const channel = accountResetChannel;
  accountResetChannel = null;
  if (channel && supabase && typeof supabase.removeChannel === 'function') {
    await supabase.removeChannel(channel).catch(() => undefined);
  }
}

async function forceAccountResetSignOut() {
  if (accountResetSignOut) return;
  accountResetSignOut = true;
  try { await signOut(); }
  catch { /* Local state is cleared by signOut even if the server is unavailable. */ }
  finally {
    accountResetSignOut = false;
    navigate('/');
  }
}

/** @param {import('@supabase/supabase-js').User} user */
async function saveUser(user) {
  const previous = store.get().user;
  await store.set({
    ...(previous?.id !== user.id ? { business: null, customerProfileComplete: false } : {}),
    user: { id: user.id, email: user.email || '', name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Utilizator' },
  });
}

function selectedAccountType() {
  const state = store.get();
  if (['business', 'client', 'invitee'].includes(state.requestedAccountType)) return state.requestedAccountType;
  if (state.inviteFlow) return 'invitee';
  if (state.role === 'customer') return 'client';
  if (state.role === 'business') return 'business';
  return null;
}

async function enforceExistingAccountType() {
  if (config.mode === 'demo' || !store.get().user) return null;
  const client = getSupabase();
  if (!client || typeof client.rpc !== 'function') return null;
  const { rpc } = await import('./access.js');
  const resolvedType = await rpc('get_account_role');
  const accountType = resolvedType === 'customer' ? 'client' : resolvedType;
  if (!['business', 'client', 'invitee'].includes(accountType)) return accountType === 'unassigned' ? 'unassigned' : null;
  const requested = selectedAccountType();
  const switched = Boolean(requested && requested !== accountType);
  const previousNotice = store.get().accountTypeNotice || '';
  await store.set({
    role: accountType === 'client' ? 'customer' : 'business',
    requestedAccountType: accountType,
    accountTypeNotice: switched ? `Există un alt tip de cont cu această adresă. Tip ${accountType}.` : previousNotice,
    inviteFlow: false,
    ...(accountType === 'client'
      ? { business: null, customerProfileComplete: true }
      : { customerProfileComplete: false }),
  });
  return accountType;
}
