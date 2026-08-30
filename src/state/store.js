// @ts-check

import { Preferences } from '@capacitor/preferences';

const STORAGE_KEY = 'rezerva.app.state.v1';

/** @type {Record<string, any>} UI cache only. Never a source of authorization. */
const initialState = {
  role: null,
  user: null,
  business: null,
  selectedPlan: null,
  selectedBusinessId: null,
  notificationPreference: 60,
  customerProfileComplete: false,
  inviteFlow: false,
  demoAccess: null,
  demoEnrollment: null,
  demoCalendars: [],
  demoInvitations: [],
  demoMembers: [{ userId: 'demo-staff', email: 'coleg@demo.ro', role: 'staff', permission: 'viewer' }],
  demoCalendarSettings: {},
};

let state = { ...initialState };
/** @type {Set<(value: typeof state) => void>} */
const listeners = new Set();

export const store = {
  get() {
    return structuredClone(state);
  },

  async load() {
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    if (value) {
      try {
        state = { ...initialState, ...JSON.parse(value) };
      } catch {
        await Preferences.remove({ key: STORAGE_KEY });
      }
    }
    return this.get();
  },

  async set(patch) {
    state = { ...state, ...patch };
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(state) });
    listeners.forEach((listener) => listener(this.get()));
  },

  async clear() {
    state = { ...initialState };
    await Preferences.remove({ key: STORAGE_KEY });
    listeners.forEach((listener) => listener(this.get()));
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
