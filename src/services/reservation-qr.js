// @ts-check
import { Capacitor, registerPlugin } from '@capacitor/core';
import { config } from '../config.js';
import { store } from '../state/store.js';
import { rpc } from './access.js';
import { parseReservationQr } from './qr-session.js';
import { beginNativeInteraction, endNativeInteraction } from './native-interaction.js';

/** @type {{render(options:{value:string}):Promise<{dataUrl:string}>,scan():Promise<{value?:string,cancelled?:boolean}>}} */
const ReservationQr = registerPlugin('ReservationQr');
const androidOnly = () => {
  if (Capacitor.getPlatform() !== 'android') throw new Error('QR-ul și scanarea se folosesc în aplicația Android instalată.');
};
export async function customerReservationQr(bookingId) {
  if (store.get().role !== 'customer') throw new Error('QR-ul este afișat numai în contul de client.');
  if (config.mode === 'demo') throw new Error('QR-ul real necesită modul live și o programare salvată în baza de date.');
  androidOnly();
  const result = await rpc('get_customer_booking_qr', { p_booking_id: bookingId });
  if (!result?.ok) throw new Error(result?.message || 'Programare indisponibilă.');
  parseReservationQr(result.payload);
  const { dataUrl } = await ReservationQr.render({ value: result.payload });
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl || '')) throw new Error('Imaginea QR nu a putut fi creată.');
  return { booking: result.booking, dataUrl };
}
export async function scanReservationQr() {
  if (store.get().role !== 'business') throw new Error('Scanarea este disponibilă numai pentru afaceri.');
  if (config.mode === 'demo') throw new Error('Scanarea reală necesită modul live.');
  androidOnly();
  beginNativeInteraction();
  try {
    const result = await ReservationQr.scan();
    return result.cancelled ? null : parseReservationQr(result.value);
  } finally {
    endNativeInteraction();
  }
}
export async function resolveReservationQr(value, businessId = null) {
  if (store.get().role !== 'business') throw new Error('Scanarea este disponibilă numai pentru afaceri.');
  if (config.mode === 'demo') throw new Error('Verificarea QR necesită modul live.');
  const result = await rpc('resolve_booking_qr', { p_token: parseReservationQr(value), p_business_id: businessId });
  if (!result?.ok) throw new Error(result?.message || 'Programare inaccesibilă.');
  return result.booking;
}
