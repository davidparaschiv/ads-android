// @ts-check
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { loggedExternalCall } from '../observability/external-api-log.js';
import { navigate } from '../router.js';
import { store } from '../state/store.js';

let registration = null;
let navigationListenerInstalled = false;

export async function initializePushNavigation() {
  if (!Capacitor.isNativePlatform() || navigationListenerInstalled) return;
  navigationListenerInstalled = true;
  await PushNotifications.addListener('pushNotificationActionPerformed', event => {
    const requested = String(event.notification?.data?.route || '');
    const fallback = store.get().role === 'business' ? '/business/notifications' : '/customer/notifications';
    navigate(['/business/notifications','/customer/notifications'].includes(requested) ? requested : fallback);
  });
}

export async function registerPushNotifications() {
  if (config.mode === 'demo') return { enabled: true, demo: true };
  if (!Capacitor.isNativePlatform()) return { enabled: false, reason: 'native-only' };
  await initializePushNavigation();
  if (registration) return registration;
  registration = loggedExternalCall('firebase', 'push-registration', register).finally(() => { registration = null; });
  return registration;
}
async function register() {
  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return { enabled: false, reason: 'denied' };
  if (Capacitor.getPlatform() === 'android') {
    await PushNotifications.createChannel({
      id: 'rezerva_bookings', name: 'Programări',
      description: 'Notificări și mementouri pentru programările tale',
      // Omit sound to retain Android's default. This plugin interprets a string
      // as the name of a bundled res/raw sound, not a "default" keyword.
      importance: 4, visibility: 0, vibration: true,
    });
  }
  const handles = [];
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const attach = async () => {
        handles.push(await PushNotifications.addListener('registration', async ({ value }) => {
          try {
            const supabase = getSupabase();
            if (!supabase) throw new Error('Server neconfigurat.');
            const { data } = await supabase.auth.getUser();
            if (!data.user) throw new Error('Autentificare necesară.');
            const { error } = await supabase.from('device_tokens').upsert({ user_id: data.user.id, token: value, platform: 'android', updated_at: new Date().toISOString() }, { onConflict: 'token' });
            if (error) throw error;
            await Preferences.set({ key: 'rezerva.push.token', value });
            resolve({ enabled: true, demo: false });
          } catch (error) { reject(error); }
        }));
        handles.push(await PushNotifications.addListener('registrationError', reject));
        await PushNotifications.register();
      };
      timer = setTimeout(() => reject(new Error('Înregistrarea push a expirat. Reîncearcă.')), 20000);
      attach().catch(reject);
    });
  } finally {
    clearTimeout(timer);
    await Promise.all(handles.map(handle => handle.remove()));
  }
}
