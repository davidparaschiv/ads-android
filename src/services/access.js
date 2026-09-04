// @ts-check
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';
import { DATABASE_ACTIONS, databaseActionForRpc, loggedDatabaseAction } from '../observability/database-action-log.js';

export async function rpc(name, args = {}) {
  const client = getSupabase();
  if (!client) throw new Error('Conexiunea cu serverul nu este configurată.');
  return loggedDatabaseAction(databaseActionForRpc(name,args),async()=>{
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  });
}

export async function getAccess(businessId = null) {
  if (config.mode !== 'demo') return rpc('get_access', { p_business_id: businessId });
  const state = store.get();
  const grant = state.demoAccess;
  const active = Boolean(grant && ((grant.source === 'developer' && (grant.expiresAt === null || grant.expiresAt === 'infinity')) || ((state.business?.is_owner === false && grant.source === 'demo') && Date.parse(grant.expiresAt) > Date.now())));
  const calendarLimit = active ? grant.calendarLimit : 0;
  return { active, calendarLimit, source: active ? grant.source : 'none', expiresAt: grant?.expiresAt,
    features: { reports: active && calendarLimit >= 5, businessNotifications: active && calendarLimit >= 5 },
    planId: active && calendarLimit >= 5 ? 'large' : 'small', isOwner: state.business?.is_owner !== false,
    activeCalendars: state.demoCalendars.filter(c => c.is_active).length,
    overLimit: state.demoCalendars.filter(c => c.is_active).length > calendarLimit };
}

/** UI gate only; the database independently enforces the current entitlement. */
export function hasBusinessFeature(access, feature) {
  return access?.active === true && access?.planId === 'large' && access?.features?.[feature] === true;
}

export async function demoGrant(planId, source = 'demo') {
  if (config.mode !== 'demo') throw new Error('Simularea este disponibilă doar în demo.');
  await store.set({ demoAccess: { source, calendarLimit: planId === 'large' ? 10 : 1,
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
  return '/business/home';
}

export async function calendars(businessId) {
  if (config.mode === 'demo') {
    const state=store.get();
    if(state.business?.is_owner!==false)return state.demoCalendars;
    const memberId=state.user?.id==='demo-business-user'?'demo-staff':state.user?.id;
    return state.demoCalendars.filter(calendar=>!state.demoCalendarRestrictions.some(restriction=>restriction.businessId===businessId&&restriction.calendarId===calendar.id&&restriction.userId===memberId));
  }
  return rpc('list_my_calendars', { p_business_id: businessId });
}

export async function calendarInviteePermissions(businessId,calendarId) {
  if(config.mode!=='demo')return rpc('get_calendar_invitee_permissions',{p_business_id:businessId,p_calendar_id:calendarId});
  const state=store.get();
  return state.demoMembers.filter(member=>member.role!=='owner').map(member=>({
    userId:member.userId,email:member.email,
    allowed:!state.demoCalendarRestrictions.some(restriction=>restriction.businessId===businessId&&restriction.calendarId===calendarId&&restriction.userId===member.userId),
  }));
}

export async function setCalendarInviteePermission(businessId,calendarId,userId,allowed) {
  if(config.mode!=='demo')return rpc('set_calendar_invitee_permission',{p_business_id:businessId,p_calendar_id:calendarId,p_user_id:userId,p_allowed:allowed});
  const restrictions=store.get().demoCalendarRestrictions.filter(restriction=>!(restriction.businessId===businessId&&restriction.calendarId===calendarId&&restriction.userId===userId));
  await store.set({demoCalendarRestrictions:allowed?restrictions:[...restrictions,{businessId,calendarId,userId}]});
}

export async function addCalendar(businessId, name) {
  if (config.mode !== 'demo') return rpc('add_calendar', { p_business_id: businessId, p_name: name });
  const access = await getAccess();
  if (!access.active || access.activeCalendars >= access.calendarLimit) throw new Error('Ai atins limita de calendare a planului.');
  const calendar={ id: crypto.randomUUID(), name, is_active: true };
  await store.set({ demoCalendars: [...store.get().demoCalendars, calendar] });
  return calendar;
}

export async function deleteCalendar(businessId, calendarId) {
  if (config.mode !== 'demo') return rpc('delete_calendar', { p_business_id: businessId, p_calendar_id: calendarId });
  if (calendarId === 'demo-calendar-1') throw new Error('Calendarul nu poate fi șters deoarece are programări.');
  const state = store.get();
  const settings = { ...state.demoCalendarSettings };
  delete settings[calendarId];
  await store.set({
    demoCalendars: state.demoCalendars.filter(calendar => calendar.id !== calendarId),
    demoCalendarSettings: settings,
  });
  return { ok: true };
}

export async function team(businessId) {
  if (config.mode !== 'demo') return rpc('list_team', { p_business_id: businessId });
  return { members: store.get().demoMembers, invitations: store.get().demoInvitations };
}

export async function inviteMember(businessId, email, permission) {
  permission = 'manager';
  if (config.mode === 'demo') {
    const invitations = store.get().demoInvitations.map(i => i.email === email && ['pending','sent'].includes(i.status) ? { ...i, status: 'revoked' } : i);
    await store.set({ demoInvitations: [...invitations, { id: crypto.randomUUID(), email, permission, status: 'sent', expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() }] });
    return;
  }
  const client = getSupabase();
  if (!client) throw new Error('Server neconfigurat.');
  await loggedDatabaseAction(DATABASE_ACTIONS.BV_INVITE_TEAM_MEMBER,async()=>{
    const { data, error } = await client.functions.invoke('send-calendar-invite', { body: { businessId, email, permission } });
    if (error || !data?.ok) {
      const failure = new Error(data?.error || 'Invitația nu a putut fi trimisă. Verifică Echipă și configurarea e-mailului.');
      if (error) Object.assign(failure,{code:error.code || '',details:error.message || ''});
      throw failure;
    }
  });
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

export async function setMemberAccess(businessId, userId, permission, remove = false) {
  if (config.mode !== 'demo') return rpc('set_team_member', { p_business_id: businessId, p_user_id: userId, p_permission: permission, p_remove: remove });
  const existing = store.get().demoMembers.find(m => m.userId === userId);
  await store.set({ demoMembers: store.get().demoMembers.filter(m => m.userId !== userId).concat(remove ? [] : [{ userId, email: existing?.email || '', role: 'staff', permission }]) });
}

export async function deleteInviteeAccount(businessId,userId) {
  if (config.mode !== 'demo') return rpc('delete_invitee_account', { p_business_id: businessId, p_user_id: userId });
  await store.set({ demoMembers: store.get().demoMembers.filter(member => member.userId !== userId) });
  return { ok: true };
}
