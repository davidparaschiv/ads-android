// @ts-check

import { config } from '../config.js';
import { demoBusinesses, demoBookings } from '../data.js';
import { getSupabase } from '../api/supabase.js';
import { calendars, getAccess, hasBusinessFeature, rpc } from './access.js';
import { store } from '../state/store.js';

/** @param {string} [query] */
export async function listBusinesses(query = '') {
  if (config.mode === 'demo') {
    const normalized = query.trim().toLocaleLowerCase('ro');
    return demoBusinesses.filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase('ro').includes(normalized));
  }
  const supabase = requireSupabase();
  let request = supabase.from('businesses').select('id,name,category,address').eq('is_active', true).order('name').limit(50);
  if (query.trim()) request = request.ilike('name', `%${query.trim()}%`);
  const { data, error } = await request;
  if (error) throw error;
  return (data || []).map((item) => ({ ...item, initials: initials(item.name), services: [] }));
}

/** @param {string} businessId */
export async function getBusiness(businessId) {
  if (config.mode === 'demo') return demoBusinesses.find((item) => item.id === businessId) || demoBusinesses[0];
  const supabase = requireSupabase();
  const { data, error } = await supabase.from('businesses')
    .select('id,name,category,address,event_types(id,name,duration_minutes,price_cents),resources(id,name,is_active)')
    .eq('id', businessId).eq('is_active', true).single();
  if (error) throw error;
  return {
    ...data,
    initials: initials(data.name),
    services: (data.event_types || []).map((item) => ({ id: item.id, name: item.name, duration: item.duration_minutes, price: Math.round((item.price_cents || 0) / 100) })),
    resources: (data.resources || []).filter(item => item.is_active !== false),
  };
}

/** @param {string} businessId @param {Record<string, FormDataEntryValue>} values @param {number[]} weekdays */
export async function setupBusiness(businessId, values, weekdays) {
  if (config.mode === 'demo') {
    await store.set({ demoCalendars: [{ id: 'demo-calendar-1', name: String(values.resource), is_active: true }] });
    return { configured: true };
  }
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc('setup_business', {
    p_business_id: businessId,
    p_service_name: String(values.service),
    p_duration_minutes: Number(values.duration),
    p_price_cents: Math.round(Number(values.price) * 100),
    p_resource_name: String(values.resource),
    p_open_time: String(values.open),
    p_close_time: String(values.close),
    p_weekdays: weekdays,
  });
  if (error) throw error;
  return data;
}

/** @param {string} businessId */
export async function listBusinessBookings(businessId, calendarId = '', from = '', until = '') {
  if (config.mode === 'demo') return demoBookings.map(item => ({ ...item, calendarId: 'demo-calendar-1' })).filter(item => (!calendarId || item.calendarId === calendarId) && (!from || item.date >= from) && (!until || item.date <= until));
  const supabase = requireSupabase();
  const rows = [];
  const allowedIds = (await calendars(businessId)).map(c => c.id);
  if (!allowedIds.length || (calendarId && !allowedIds.includes(calendarId))) return [];
  for (let offset = 0; ; offset += 500) {
    let query = supabase.from('bookings').select('id,resource_id,start_at,status,customer_name,customer_email_snapshot,event_types(name)').eq('business_id', businessId).in('resource_id', allowedIds).order('start_at').order('id').range(offset, offset + 499);
    if (calendarId) query = query.eq('resource_id', calendarId);
    if (from) query = query.gte('start_at', new Date(Date.parse(from) - 86400000).toISOString());
    if (until) query = query.lt('start_at', new Date(Date.parse(until) + 2 * 86400000).toISOString());
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return rows.map(mapBusinessBooking).filter(item => (!from || item.date >= from) && (!until || item.date <= until));
}

/** Reports have their own server-authorized endpoint, not the calendar query. */
export async function listBusinessReport(businessId, calendarId, from, until) {
  const access = await getAccess(businessId);
  if (!hasBusinessFeature(access, 'reports')) throw new Error('Rapoartele sunt disponibile doar cu planul Complete activ.');
  if (config.mode === 'demo') return listBusinessBookings(businessId, calendarId, from, until);
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const data = await rpc('get_business_report', { p_business_id: businessId, p_from: from,
      p_until: until, p_calendar_id: calendarId || null, p_offset: offset });
    rows.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return rows.map(mapBusinessBooking);
}

function mapBusinessBooking(item) {
  return {
    id: item.id,
    calendarId: item.resource_id,
    customer: item.customer_name,
    email: item.customer_email_snapshot,
    service: item.service_name || item.event_types?.name || 'Serviciu',
    time: new Intl.DateTimeFormat('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
    date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
    status: item.status,
  };
}

/** @param {number} minutes @param {boolean} enabled */
export async function saveNotificationPreference(minutes, enabled) {
  if (config.mode === 'demo') return;
  const supabase = requireSupabase();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw authError || new Error('Autentificare necesară.');
  const { error } = await supabase.from('notification_preferences').upsert({
    user_id: authData.user.id,
    default_minutes: minutes,
    push_enabled: enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

function requireSupabase() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase nu este configurat.');
  return supabase;
}

/** @param {string} name */
function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}
