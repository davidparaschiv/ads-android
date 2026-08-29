// @ts-check
import { config } from '../config.js';
import { store } from '../state/store.js';
import { rpc } from './access.js';

export async function getCustomerProfile() {
  if (config.mode === 'demo') {
    const user = store.get().user;
    const parts = String(user?.name || '').trim().split(/\s+/);
    return { firstName: parts[0] || '', lastName: parts.slice(1).join(' '), completed: store.get().customerProfileComplete === true };
  }
  return rpc('get_customer_profile');
}

export async function completeCustomerProfile(firstName, lastName) {
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  let profile;
  if (config.mode === 'demo') profile = { firstName: first, lastName: last, completed: true };
  else profile = await rpc('complete_customer_profile', { p_first_name: first, p_last_name: last });
  await store.set({
    customerProfileComplete: true,
    user: { ...store.get().user, name: `${profile.firstName} ${profile.lastName}`.trim() },
  });
  return profile;
}
