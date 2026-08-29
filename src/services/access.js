// @ts-check
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';

export async function rpc(name, args = {}) {
  const client = getSupabase();
  if (!client) throw new Error('Conexiunea cu serverul nu este configurată.');
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function getAccess(businessId = null) {
  if (config.mode !== 'demo') return rpc('get_access', { p_business_id: businessId });
  const state = store.get();
  const grant = state.demoAccess;
  const active = Boolean(grant && (grant.source === 'developer' && grant.expiresAt === null || (state.business?.is_owner === false && grant.source === 'demo') && Date.parse(grant.expiresAt) > Date.now()));
  const calendarLimit = active ? grant.calendarLimit : 0;
  return { active, calendarLimit, source: active ? grant.source : 'none', expiresAt: grant?.expiresAt,
    features: { reports: active && calendarLimit === 5, businessNotifications: active && calendarLimit === 5 },
    planId: active && calendarLimit === 5 ? 'large' : 'small', isOwner: state.business?.is_owner !== false,
    activeCalendars: state.demoCalendars.filter(c => c.is_active).length,
    overLimit: state.demoCalendars.filter(c => c.is_active).length > calendarLimit };
}

/** UI gate only; the database independently enforces the current entitlement. */
export function hasBusinessFeature(access, feature) {
  return access?.active === true && access?.planId === 'large' && access?.features?.[feature] === true;
}

export async function demoGrant(planId, source = 'demo') {
  if (config.mode !== 'demo') throw new Error('Simularea este disponibilă doar în demo.');
  await store.set({ demoAccess: { source, calendarLimit: planId === 'large' ? 5 : 1,
    expiresAt: source === 'developer' ? null : new Date(Date.now() + 30 * 86400000).toISOString() } });
  return getAccess();
}

export async function redeemLicense(key) {
  if (config.mode !== 'demo') return rpc('redeem_license', { p_key: key });
  if (key.trim() !== 'dev112233') return { ok: false, message: 'Licență invalidă.' };
  const access = await demoGrant('large', 'developer');
  return { ok: true, scheduled: false, startsAt: new Date().toISOString(), expiresAt: access.expiresAt, access };
}

export async function workspaces() {
  if (config.mode === 'demo') return store.get().business ? [store.get().business] : [];
  return rpc('get_my_workspaces');
}

export async function afterAccessRoute() {
  const business = store.get().business;
  if (!business) return '/business/details';
  return (await calendars(business.id)).length ? '/business/home' : '/business/setup';
}

export async function calendars(businessId) {
  if (config.mode === 'demo') return store.get().demoCalendars;
  return rpc('list_my_calendars', { p_business_id: businessId });
}

export async function addCalendar(businessId, name) {
  if (config.mode !== 'demo') return rpc('add_calendar', { p_business_id: businessId, p_name: name });
  const access = await getAccess();
  if (!access.active || access.activeCalendars >= access.calendarLimit) throw new Error('Ai atins limita de calendare a planului.');
  await store.set({ demoCalendars: [...store.get().demoCalendars, { id: crypto.randomUUID(), name, is_active: true }] });
}

export async function setCalendarActive(id, active) {
  if (config.mode !== 'demo') return rpc('set_calendar_active', { p_calendar_id: id, p_active: active });
  const access = await getAccess();
  if (active && (!access.active || access.activeCalendars >= access.calendarLimit)) throw new Error('Limita planului nu permite reactivarea.');
  await store.set({ demoCalendars: store.get().demoCalendars.map(c => c.id === id ? { ...c, is_active: active } : c) });
}

export async function team(businessId) {
  if (config.mode !== 'demo') return rpc('list_team', { p_business_id: businessId });
  return { members: store.get().demoMembers, invitations: store.get().demoInvitations };
}

export async function inviteMember(businessId, email, calendarIds, permission) {
  if (config.mode === 'demo') {
    const invitations = store.get().demoInvitations.map(i => i.email === email && ['pending','sent'].includes(i.status) ? { ...i, status: 'revoked' } : i);
    await store.set({ demoInvitations: [...invitations, { id: crypto.randomUUID(), email, calendarIds, permission, status: 'sent', expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() }] });
    return;
  }
  const client = getSupabase();
  if (!client) throw new Error('Server neconfigurat.');
  const { data, error } = await client.functions.invoke('send-calendar-invite', { body: { businessId, email, calendarIds, permission } });
  if (error || !data?.ok) throw new Error(data?.error || 'Invitația nu a putut fi trimisă. Verifică Echipă și configurarea e-mailului.');
}

export async function acceptInvitation(token) {
  if (config.mode !== 'demo') return rpc('accept_calendar_invitation', { p_token: token });
  if (token.trim() !== 'DEMO-INVITATIE') return { ok: false, message: 'În demo folosește DEMO-INVITATIE.' };
  await store.set({ business: { id: 'atelier-luna', name: 'Atelier Luna', is_owner: false },
    demoCalendars: [{ id: 'demo-calendar-1', name: 'Calendar invitat', is_active: true }] });
  await demoGrant('large');
  return { ok: true, businessId: 'atelier-luna' };
}

export async function revokeInvitation(id) {
  if (config.mode !== 'demo') return rpc('revoke_invitation', { p_id: id });
  await store.set({ demoInvitations: store.get().demoInvitations.map(i => i.id === id ? { ...i, status: 'revoked' } : i) });
}

export async function setMemberAccess(businessId, userId, calendarIds, permission) {
  if (config.mode !== 'demo') return rpc('set_member_access', { p_business_id: businessId, p_user_id: userId, p_calendar_ids: calendarIds, p_permission: permission });
  await store.set({ demoMembers: store.get().demoMembers.filter(m => m.userId !== userId).concat(calendarIds.length ? [{ userId, email: store.get().demoMembers.find(m => m.userId === userId)?.email || '', role: 'staff', calendars: calendarIds.map(id => ({ id, permission })) }] : []) });
}
