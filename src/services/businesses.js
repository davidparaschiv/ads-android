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
    return demoBusinesses.filter((item) => item.name.toLocaleLowerCase('ro').startsWith(normalized));
  }
  const supabase = requireSupabase();
  let request = supabase.from('businesses').select('id,name,category,address').eq('is_active', true).order('name').limit(50);
  if (query.trim()) request = request.ilike('name', `${query.trim()}%`);
  const { data, error } = await request;
  if (error) throw error;
  return (data || []).map((item) => ({ ...item, initials: initials(item.name), services: [] }));
}

/** @param {string} businessId */
export async function getBusiness(businessId) {
  if (config.mode === 'demo') return demoBusinesses.find((item) => item.id === businessId) || demoBusinesses[0];
  const supabase = requireSupabase();
  const { data, error } = await supabase.from('businesses')
    .select('id,name,category,address,event_types(id,name,duration_minutes,price_cents,resource_id),resources(id,name,is_active)')
    .eq('id', businessId).eq('is_active', true).single();
  if (error) throw error;
  return {
    ...data,
    initials: initials(data.name),
    services: (data.event_types || []).filter(item => item.resource_id).map((item) => ({ id: item.id, name: item.name, duration: item.duration_minutes, resourceId: item.resource_id })),
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
    let query = supabase.from('bookings').select('id,resource_id,start_at,end_at,created_at,status,customer_name,customer_email_snapshot,event_types(name)').eq('business_id', businessId).in('resource_id', allowedIds).order('start_at').order('id').range(offset, offset + 499);
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

export async function listPendingBookingRequests(businessId) {
  if (config.mode === 'demo') return demoBookings.filter(item => item.status === 'pending').map((item,index) => ({ ...item, calendarId: 'demo-calendar-1', endTime: addMinutes(item.time, 60), createdAt: new Date(Date.now()+index).toISOString() }));
  const supabase = requireSupabase();
  const allowedIds = (await calendars(businessId)).map(item => item.id);
  if (!allowedIds.length) return [];
  const { data,error } = await supabase.from('bookings')
    .select('id,resource_id,start_at,end_at,created_at,status,customer_name,customer_email_snapshot,event_types(name)')
    .eq('business_id',businessId).in('resource_id',allowedIds).eq('status','pending').order('created_at',{ascending:true}).order('id');
  if (error) throw error;
  return (data || []).map(mapBusinessBooking);
}

export async function listBusinessServices(businessId, resourceId = '') {
  if (config.mode === 'demo') return demoBusinesses[0].services.map((item,index) => ({ ...item, resourceId: index ? 'demo-calendar-2' : 'demo-calendar-1' })).filter(item => !resourceId || item.resourceId === resourceId);
  const supabase = requireSupabase();
  let query = supabase.from('event_types').select('id,name,duration_minutes,resource_id').eq('business_id',businessId).eq('is_active',true).order('name');
  if (resourceId) query=query.eq('resource_id',resourceId);
  const {data,error}=await query;
  if(error) throw error;
  return (data || []).map(item => ({id:item.id,name:item.name,duration:item.duration_minutes,resourceId:item.resource_id}));
}

export async function addBusinessEvent(businessId,resourceId,input) {
  if (config.mode === 'demo') return {id:crypto.randomUUID(),name:input.name,resourceId,durationMinutes:input.duration};
  return rpc('add_business_event',{p_business_id:businessId,p_resource_id:resourceId,p_name:input.name,
    p_weekdays:input.weekdays,p_start_time:input.startTime,p_duration_minutes:input.duration});
}

export async function getCalendarServiceSettings(calendarId) {
  if (config.mode === 'demo') return store.get().demoCalendarSettings?.[calendarId] || {
    calendarId,name:store.get().demoCalendars.find(item=>item.id===calendarId)?.name || 'Serviciu',
    serviceId:null,durationMinutes:30,weekdays:[1,2,3,4,5],startTime:'09:00:00',endTime:'18:00:00',
  };
  return rpc('get_calendar_service_settings',{p_calendar_id:calendarId});
}

export async function saveCalendarServiceSettings(businessId,calendarId,input) {
  if (config.mode === 'demo') {
    const settings={calendarId,name:store.get().demoCalendars.find(item=>item.id===calendarId)?.name || 'Serviciu',
      durationMinutes:input.duration,weekdays:input.weekdays,startTime:input.startTime,endTime:input.endTime};
    await store.set({demoCalendarSettings:{...(store.get().demoCalendarSettings||{}),[calendarId]:settings}});
    return settings;
  }
  return rpc('save_calendar_service_settings',{p_business_id:businessId,p_calendar_id:calendarId,
    p_weekdays:input.weekdays,p_start_time:input.startTime,p_end_time:input.endTime,p_duration_minutes:input.duration});
}

export async function getCalendarNotificationMinutes(calendarId) {
  if (config.mode === 'demo') return store.get().notificationPreference >= 2 && store.get().notificationPreference <= 30 ? store.get().notificationPreference : 15;
  const supabase=requireSupabase();
  const {data,error}=await supabase.from('calendar_notification_preferences').select('minutes_before').eq('calendar_id',calendarId).maybeSingle();
  if(error) throw error;
  return data?.minutes_before || 15;
}

export async function setCalendarNotificationMinutes(calendarId,minutes) {
  if(config.mode==='demo'){await store.set({notificationPreference:minutes});return;}
  await rpc('set_calendar_notification_minutes',{p_calendar_id:calendarId,p_minutes:minutes});
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
    endTime: item.end_at ? new Intl.DateTimeFormat('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone }).format(new Date(item.end_at)) : '',
    date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
    createdAt: item.created_at || '',
    status: item.status,
  };
}

function addMinutes(time,minutes){const [hour,minute]=time.split(':').map(Number);const value=hour*60+minute+minutes;return `${String(Math.floor(value/60)%24).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;}

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
