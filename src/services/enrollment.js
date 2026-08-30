// @ts-check
import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { rpc } from './access.js';
import { store } from '../state/store.js';
import { externalApiLog } from '../observability/external-api-log.js';

export const enrollmentStatus = async () => config.mode === 'demo' ? store.get().demoEnrollment : rpc('get_enrollment_status');
export const isPlatformOwnerAccount = async () => config.mode === 'demo'
  ? store.get().user?.email === 'davidnicolaparaschiv@gmail.com'
  : rpc('is_platform_owner_account');

export async function enrollmentAction(action, values = {}) {
  if (config.mode === 'demo') return demoAction(action, values);
  const client = getSupabase();
  if (!client) throw new Error('Server neconfigurat.');
  const { data, error } = await client.functions.invoke('enrollment', { body: { ...values, action } });
  if (error) {
    const response = await error.context?.json?.().catch(() => null);
    externalApiLog('error', response?.diagnostic?.provider || 'supabase', `enrollment:${action}`, {
      phase: 'provider-failure',
      diagnostic: response?.diagnostic || null,
      publicError: response?.error || null,
    });
    throw new Error(response?.error || 'Verificarea nu poate fi efectuată. Verifică serviciile configurate.');
  }
  if (data?.diagnostic) externalApiLog('error', data.diagnostic.provider || 'supabase', `enrollment:${action}`, {
    phase: 'provider-failure', diagnostic: data.diagnostic, publicError: data.warning || data.error || null,
  });
  if (!data?.ok) throw new Error(data?.error || 'Operație indisponibilă.');
  return data;
}
export async function enrollmentLinkDetails(token) {
  if (config.mode !== 'demo') return rpc('enrollment_link_details', { p_token: token });
  const value = await enrollmentStatus();
  if (!value || !['RZE-DEMO','RZA-DEMO'].includes(token)) throw new Error('Link demo indisponibil.');
  return { ...value, kind: token === 'RZE-DEMO' ? 'email' : 'approval' };
}

async function demoAction(action, values) {
  let value = store.get().demoEnrollment;
  if (action === 'start') {
    if (!/^(RO\s*)?[1-9][0-9]{1,9}$/i.test(values.cui || '') || !/^(07[0-9]{8}|\+407[0-9]{8})$/.test(values.phone || '') || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email || '')) throw new Error('Completează CUI, e-mailul și telefonul mobil românesc.');
    value = { ...values, id: crypto.randomUUID(), status: 'pending', emailVerified: false, phoneVerified: false };
  } else {
    if (!value || value.status !== 'pending') throw new Error('Nu există o cerere în așteptare.');
    if (action === 'sendSms' && !value.emailVerified) throw new Error('Confirmă mai întâi e-mailul.');
    if (action === 'checkSms') {
      if (!value.emailVerified || values.code !== '123456') throw new Error('Cod demo incorect.');
      value.phoneVerified = true;
      value.approvalSentAt = new Date().toISOString();
    }
    if (action === 'confirm') {
      if (values.token === 'RZE-DEMO') value.emailVerified = true;
      else if (values.token === 'RZA-DEMO' && value.emailVerified && value.phoneVerified) {
        value.status = values.approve === false ? 'rejected' : 'approved';
        if (value.status === 'approved') {
          value.businessId = 'atelier-luna';
          await store.set({ business: { id: value.businessId, name: value.name, category: value.category, address: value.address, phone: value.phone, is_owner: true } });
        }
      } else throw new Error('Verificările nu sunt complete.');
    }
  }
  await store.set({ demoEnrollment: value });
  return { ok: true, id: value.id, businessId: value.businessId };
}
