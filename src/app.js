// @ts-check

import { assertLiveConfiguration } from './config.js';
import { startRouter } from './router.js';
import { homeRoute, initializeAuth, resolveBusinessEntryRoute } from './services/auth.js';
import { store } from './state/store.js';
import {
  paymentScreen,
  plansScreen,
} from './screens/business.js';
import {
  bookingScreen,
  bookingSuccessScreen,
  companyScreen,
  customerBookingsScreen,
  customerSearchScreen,
} from './screens/customer.js';
import { configurationScreen, invitationLoginScreen, loginScreen, roleScreen } from './screens/entry.js';
import { profileScreen } from './screens/profile.js';
import { businessDetailsScreen, verificationScreen, approvalCodeScreen } from './screens/enrollment.js';
import { businessHomeScreen, businessCalendarScreen, businessCalendarViewScreen, businessAddEventScreen, reportsScreen } from './screens/dashboard.js';
import { invitationScreen, licenseScreen, teamScreen } from './screens/team.js';
import { workspaces, getAccess } from './services/access.js';
import { page, bindBack } from './ui/layout.js';
import { escapeHtml } from './ui/dom.js';
import { navigate, currentRoute } from './router.js';
import { businessQrScreen, customerQrScreen } from './screens/reservation-qr.js';
import { customerProfileSetupScreen } from './screens/customer-profile.js';
import { notificationsScreen } from './screens/notifications.js';
import { getCustomerProfile } from './services/customer-profile.js';
import { initializePushNavigation, registerPushNotifications } from './services/notifications.js';

export async function startApp() {
  assertLiveConfiguration();
  await store.load();
  await initializeAuth();
  await initializePushNavigation();
  let pushUserId = store.get().user?.id || '';
  if (pushUserId) void registerPushNotifications().catch(() => undefined);
  store.subscribe(state => {
    if (state.user?.id && state.user.id !== pushUserId) {
      pushUserId = state.user.id;
      void registerPushNotifications().catch(() => undefined);
    } else if (!state.user) pushUserId = '';
  });
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement)) throw new Error('Elementul #app lipsește.');
  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-home]') : null;
    if (target) navigate(homeRoute());
  });

  startRouter(async ({ path }) => {
    const publicPaths = ['/', '/configuration', '/business/login', '/business/invite-login', '/customer/login'];
    if (store.get().user && publicPaths.includes(path) && path !== '/configuration') {
      navigate(homeRoute());
      return;
    }
    if (!publicPaths.includes(path) && !store.get().user) {
      navigate(path.startsWith('/customer') ? '/customer/login' : '/business/login');
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    const screens = {
      '/': () => roleScreen(root),
      '/configuration': () => configurationScreen(root),
      '/business/login': () => loginScreen(root, 'business'),
      '/business/invite-login': () => invitationLoginScreen(root),
      '/business/start': async () => navigate(await resolveBusinessEntryRoute()),
      // Compatibility redirects for old hashes; neither obsolete screen is rendered.
      '/business/workspaces': () => navigate('/business/start'),
      '/business/license': () => licenseScreen(root),
      '/business/approve': () => approvalCodeScreen(root),
      '/business/invite': () => invitationScreen(root),
      '/business/team': () => teamScreen(root),
      '/business/plans': () => plansScreen(root),
      '/business/payment': () => paymentScreen(root),
      '/business/details': () => businessDetailsScreen(root),
      '/business/verification': () => verificationScreen(root),
      '/business/setup': () => navigate('/business/home'),
      '/business/home': () => businessHomeScreen(root),
      '/business/calendar': () => businessCalendarScreen(root),
      '/business/calendar-view': () => businessCalendarViewScreen(root),
      '/business/add-event': () => businessAddEventScreen(root),
      '/business/scan': () => businessQrScreen(root),
      '/business/reports': () => reportsScreen(root),
      '/customer/login': () => loginScreen(root, 'customer'),
      '/customer/profile-setup': () => customerProfileSetupScreen(root),
      '/customer/search': () => customerSearchScreen(root),
      '/customer/company': () => companyScreen(root),
      '/customer/book': () => bookingScreen(root),
      '/customer/booking-success': () => bookingSuccessScreen(root),
      '/customer/bookings': () => customerBookingsScreen(root),
      '/customer/booking-qr': () => customerQrScreen(root),
      '/customer/notifications': () => notificationsScreen(root, 'customer'),
      '/business/notifications': () => notificationsScreen(root, 'business'),
      '/profile': () => profileScreen(root),
    };
    const render = screens[path] || screens['/'];
    try {
      if (store.get().role === 'customer' && (path.startsWith('/customer/') || path === '/profile') && path !== '/customer/profile-setup'
        && !store.get().customerProfileComplete) {
        const profile = await getCustomerProfile();
        if (!profile?.completed) { navigate('/customer/profile-setup'); return; }
        await store.set({ customerProfileComplete: true,
          user: { ...store.get().user, name: `${profile.firstName} ${profile.lastName}`.trim() } });
      }
      if (store.get().role === 'business' && store.get().business
        && !['/business/start','/business/plans','/business/payment','/business/license'].includes(path)) {
        const access = await getAccess(store.get().business.id);
        if (!access.active) { navigate('/business/plans'); return; }
      }
      const requiresBusiness = ['/business/home','/business/calendar','/business/calendar-view','/business/add-event','/business/reports','/business/team','/business/notifications',
        ...(store.get().role === 'business' ? ['/profile'] : [])];
      if (requiresBusiness.includes(path)) {
        const list = await workspaces();
        if (currentRoute().path !== path) return;
        const business = list.find(b => b.id === store.get().business?.id);
        if (!business) { await store.set({ business: null }); navigate('/business/start'); return; }
        await store.set({ business });
        const access = await getAccess(business.id);
        if (!access.active) { navigate('/business/plans'); return; }
      }
      if (store.get().business?.is_owner === false && ['/business/payment','/business/details','/business/license','/business/team'].includes(path)) {
        navigate('/business/home'); return;
      }
      await render();
    } catch (error) {
      root.innerHTML = page({ title: 'Nu putem încărca acest ecran', content: `<div class="empty-state"><p>${escapeHtml(error.message || 'Verifică conexiunea și reîncearcă.')}</p><button class="button" data-route="${escapeHtml(path)}">Reîncearcă</button><button class="text-button" data-route="/business/start">Înapoi la pagina principală</button></div>` });
      bindBack(root);
    }
  });
}
