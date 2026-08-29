// @ts-check

import { assertLiveConfiguration } from './config.js';
import { startRouter } from './router.js';
import { homeRoute, initializeAuth } from './services/auth.js';
import { store } from './state/store.js';
import {
  businessNotificationsScreen,
  paymentScreen,
  plansScreen,
  scheduleSetupScreen,
  notificationSettings,
} from './screens/business.js';
import {
  bookingScreen,
  bookingSuccessScreen,
  companyScreen,
  customerBookingsScreen,
  customerSearchScreen,
} from './screens/customer.js';
import { configurationScreen, loginScreen, roleScreen } from './screens/entry.js';
import { profileScreen } from './screens/profile.js';
import { businessDetailsScreen, verificationScreen, approvalCodeScreen } from './screens/enrollment.js';
import { businessHomeScreen, businessCalendarScreen, reportsScreen } from './screens/dashboard.js';
import { invitationScreen, licenseScreen, teamScreen, workspaceScreen } from './screens/team.js';
import { workspaces, getAccess } from './services/access.js';
import { page, bindBack } from './ui/layout.js';
import { escapeHtml } from './ui/dom.js';
import { navigate, currentRoute } from './router.js';
import { businessQrScreen, customerQrScreen } from './screens/reservation-qr.js';

export async function startApp() {
  assertLiveConfiguration();
  await store.load();
  await initializeAuth();
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement)) throw new Error('Elementul #app lipsește.');
  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-home]') : null;
    if (target) navigate(homeRoute());
  });

  startRouter(async ({ path }) => {
    const publicPaths = ['/', '/configuration', '/business/login', '/customer/login'];
    if (!publicPaths.includes(path) && !store.get().user) {
      navigate(path.startsWith('/customer') ? '/customer/login' : '/business/login');
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    const screens = {
      '/': () => roleScreen(root),
      '/configuration': () => configurationScreen(root),
      '/business/login': () => loginScreen(root, 'business'),
      '/business/workspaces': () => workspaceScreen(root),
      '/business/license': () => licenseScreen(root),
      '/business/approve': () => approvalCodeScreen(root),
      '/business/invite': () => invitationScreen(root),
      '/business/team': () => teamScreen(root),
      '/business/plans': () => plansScreen(root),
      '/business/payment': () => paymentScreen(root),
      '/business/details': () => businessDetailsScreen(root),
      '/business/verification': () => verificationScreen(root),
      '/business/setup': () => scheduleSetupScreen(root),
      '/business/home': () => businessHomeScreen(root),
      '/business/calendar': () => businessCalendarScreen(root),
      '/business/scan': () => businessQrScreen(root),
      '/business/reports': () => reportsScreen(root),
      '/business/notifications': () => businessNotificationsScreen(root),
      '/customer/login': () => loginScreen(root, 'customer'),
      '/customer/search': () => customerSearchScreen(root),
      '/customer/company': () => companyScreen(root),
      '/customer/book': () => bookingScreen(root),
      '/customer/booking-success': () => bookingSuccessScreen(root),
      '/customer/bookings': () => customerBookingsScreen(root),
      '/customer/booking-qr': () => customerQrScreen(root),
      '/customer/notifications': () => notificationSettings(root, 'customer'),
      '/profile': () => profileScreen(root),
    };
    const render = screens[path] || screens['/'];
    try {
      const requiresBusiness = ['/business/home','/business/calendar','/business/reports','/business/team','/business/setup','/business/notifications'];
      if (requiresBusiness.includes(path)) {
        const list = await workspaces();
        if (currentRoute().path !== path) return;
        const business = list.find(b => b.id === store.get().business?.id);
        if (!business) { await store.set({ business: null }); navigate('/business/workspaces'); return; }
        await store.set({ business });
        const access = await getAccess(business.id);
        if (!access.active) { navigate(business.is_owner ? '/business/plans' : '/business/workspaces'); return; }
      }
      if (store.get().business?.is_owner === false && ['/business/plans','/business/payment','/business/details','/business/setup','/business/license','/business/team'].includes(path)) {
        navigate('/business/workspaces'); return;
      }
      await render();
    } catch (error) {
      root.innerHTML = page({ title: 'Nu putem încărca acest ecran', content: `<div class="empty-state"><p>${escapeHtml(error.message || 'Verifică conexiunea și reîncearcă.')}</p><button class="button" data-route="${escapeHtml(path)}">Reîncearcă</button><button class="text-button" data-route="/business/workspaces">Afaceri și invitații</button></div>` });
      bindBack(root);
    }
  });
}
