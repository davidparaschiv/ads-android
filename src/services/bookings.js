// @ts-check

import { config } from '../config.js';
import { demoBookings } from '../data.js';
import { getSupabase } from '../api/supabase.js';
import { rpc } from './access.js';

export async function availableSlots(businessId, resourceId, eventTypeId, date) {
  if (config.mode !== 'demo') return rpc('available_slots', { p_business_id: businessId, p_resource_id: resourceId, p_event_type_id: eventTypeId, p_date: date });
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, timeZoneName: 'longOffset' }).formatToParts(new Date(date + 'T12:00:00Z')).find(p => p.type === 'timeZoneName').value.replace('GMT','');
  return ['09:00','10:30','12:00','14:30','16:00'].map(time => ({ start_at: new Date(date + 'T' + time + ':00' + zone).toISOString() }));
}

/** @param {{businessId:string,eventTypeId:string,resourceId:string,startAt:string,customerName:string,reminderMinutes:number}} input */
export async function createBooking(input) {
  if (config.mode === 'demo') {
    return { id: `demo-${crypto.randomUUID()}`, ...input, status: 'confirmed' };
  }
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
}

export async function listCustomerBookings() {
  if (config.mode === 'demo') return demoBookings.slice(0, 2);
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error('Autentificare necesară.');
  const { data, error } = await supabase.from('bookings').select('*, businesses(name), event_types(name)').eq('customer_id', authData.user.id).order('start_at');
  if (error) throw error;
  return (data || []).map((item) => ({
    id: item.id,
    business: item.businesses?.name || 'Afacere',
    service: item.event_types?.name || 'Serviciu',
    customer: item.customer_name,
    email: item.customer_email_snapshot,
    date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
    time: new Intl.DateTimeFormat('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone }).format(new Date(item.start_at)),
    status: item.status,
  }));
}
