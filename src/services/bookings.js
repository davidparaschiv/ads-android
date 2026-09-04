// @ts-check

import { config } from '../config.js';
import { demoBookings } from '../data.js';
import { getSupabase } from '../api/supabase.js';
import { rpc } from './access.js';
import { DATABASE_ACTIONS, loggedDatabaseAction } from '../observability/database-action-log.js';

export async function availableSlots(businessId, resourceId, eventTypeId, date) {
  if (config.mode !== 'demo') return rpc('available_slots', { p_business_id: businessId, p_resource_id: resourceId, p_event_type_id: eventTypeId, p_date: date });
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, timeZoneName: 'longOffset' }).formatToParts(new Date(date + 'T12:00:00Z')).find(p => p.type === 'timeZoneName').value.replace('GMT','');
  return ['09:00','10:30','12:00','14:30','16:00'].map(time => ({ start_at: new Date(date + 'T' + time + ':00' + zone).toISOString() }));
}

export async function availableServiceSlots(businessId,resourceId,eventTypeId) {
  const today=dateInTimezone(new Date(),config.timezone);
  const dates=Array.from({length:30},(_,index)=>{const date=new Date(`${today}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+index);return date.toISOString().slice(0,10);});
  const groups=await Promise.all(dates.map(date=>availableSlots(businessId,resourceId,eventTypeId,date)));
  return groups.flat().sort((a,b)=>Date.parse(a.start_at)-Date.parse(b.start_at));
}

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).formatToParts(value);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** @param {{businessId:string,eventTypeId:string,resourceId:string,startAt:string,customerName:string,reminderMinutes:number}} input */
export async function createBooking(input) {
  if (config.mode === 'demo') {
    return { id: `demo-${crypto.randomUUID()}`, ...input, status: 'pending' };
  }
  return loggedDatabaseAction(DATABASE_ACTIONS.CV_MAKE_APPOINTMENT,async()=>{
    const supabase = getSupabase();
    if (!supabase) throw new Error('Supabase nu este configurat.');
    const { data, error } = await supabase.rpc('create_booking', {
      p_business_id: input.businessId,
      p_event_type_id: input.eventTypeId,
      p_resource_id: input.resourceId,
      p_start_at: input.startAt,
      p_customer_name: input.customerName,
      p_reminder_minutes: input.reminderMinutes,
    });
    if (error) throw error;
    return data;
  });
}

export async function listCustomerBookings() {
  if (config.mode === 'demo') return demoBookings.filter(item => item.date >= dateInTimezone(new Date(),config.timezone))
    .sort((left,right) => Date.parse(`${right.date}T${right.time}`)-Date.parse(`${left.date}T${left.time}`));
  return loggedDatabaseAction(DATABASE_ACTIONS.CV_VIEW_MY_APPOINTMENTS,async()=>{
    const supabase = getSupabase();
    if (!supabase) return [];
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) throw new Error('Autentificare necesară.');
    const { data: currentDayStart, error: timeError } = await supabase.rpc('get_server_day_start');
    if (timeError) throw timeError;
    const { data, error } = await supabase.from('bookings').select('*, businesses(name), event_types(name,duration_minutes)').eq('customer_id', authData.user.id).gte('start_at',currentDayStart).order('start_at',{ascending:false});
    if (error) throw error;
    return (data || []).map((item) => ({
      id: item.id,
      business: item.businesses?.name || 'Afacere',
      service: item.event_types?.name || 'Serviciu',
      customer: item.customer_name,
      email: item.customer_email_snapshot,
      date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
      time: new Intl.DateTimeFormat('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
      duration: item.event_types?.duration_minutes || Math.round((Date.parse(item.end_at)-Date.parse(item.start_at))/60000),
      status: item.status,
    }));
  });
}
