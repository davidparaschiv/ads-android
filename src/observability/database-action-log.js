// @ts-check

import { config } from '../config.js';
import { getSupabase } from '../api/supabase.js';
import { store } from '../state/store.js';

export const DATABASE_ACTIONS = Object.freeze({
  BV_SIGN_IN: 'BV_SIGN_IN',
  CV_SIGN_IN: 'CV_SIGN_IN',
  BV_CHECK_ACCESS: 'BV_CHECK_ACCESS',
  BV_ACTIVATE_LICENSE: 'BV_ACTIVATE_LICENSE',
  BV_VIEW_MY_BUSINESSES: 'BV_VIEW_MY_BUSINESSES',
  BV_VIEW_CALENDARS: 'BV_VIEW_CALENDARS',
  BV_CREATE_CALENDAR: 'BV_CREATE_CALENDAR',
  BV_DELETE_CALENDAR: 'BV_DELETE_CALENDAR',
  BV_VIEW_TEAM: 'BV_VIEW_TEAM',
  BV_INVITE_TEAM_MEMBER: 'BV_INVITE_TEAM_MEMBER',
  BV_ACCEPT_TEAM_INVITATION: 'BV_ACCEPT_TEAM_INVITATION',
  BV_CANCEL_TEAM_INVITATION: 'BV_CANCEL_TEAM_INVITATION',
  BV_UPDATE_TEAM_MEMBER_ACCESS: 'BV_UPDATE_TEAM_MEMBER_ACCESS',
  BV_REMOVE_TEAM_MEMBER: 'BV_REMOVE_TEAM_MEMBER',
  BV_DELETE_INVITEE_ACCOUNT: 'BV_DELETE_INVITEE_ACCOUNT',
  CV_SEARCH_BUSINESS: 'CV_SEARCH_BUSINESS',
  CV_VIEW_BUSINESS_DETAILS: 'CV_VIEW_BUSINESS_DETAILS',
  BV_COMPLETE_INITIAL_SETUP: 'BV_COMPLETE_INITIAL_SETUP',
  BV_VIEW_CALENDAR_APPOINTMENTS: 'BV_VIEW_CALENDAR_APPOINTMENTS',
  BV_VIEW_PENDING_APPOINTMENTS: 'BV_VIEW_PENDING_APPOINTMENTS',
  BV_VIEW_CALENDAR_SERVICES: 'BV_VIEW_CALENDAR_SERVICES',
  BV_CREATE_SERVICE: 'BV_CREATE_SERVICE',
  BV_VIEW_SERVICE_SETTINGS: 'BV_VIEW_SERVICE_SETTINGS',
  BV_UPDATE_SERVICE_SCHEDULE: 'BV_UPDATE_SERVICE_SCHEDULE',
  BV_VIEW_CALENDAR_REMINDER: 'BV_VIEW_CALENDAR_REMINDER',
  BV_UPDATE_CALENDAR_REMINDER: 'BV_UPDATE_CALENDAR_REMINDER',
  BV_VIEW_REPORTS: 'BV_VIEW_REPORTS',
  CV_VIEW_REMINDER: 'CV_VIEW_REMINDER',
  CV_UPDATE_REMINDER: 'CV_UPDATE_REMINDER',
  CV_VIEW_AVAILABLE_APPOINTMENT_TIMES: 'CV_VIEW_AVAILABLE_APPOINTMENT_TIMES',
  CV_MAKE_APPOINTMENT: 'CV_MAKE_APPOINTMENT',
  CV_VIEW_MY_APPOINTMENTS: 'CV_VIEW_MY_APPOINTMENTS',
  CV_VIEW_PROFILE: 'CV_VIEW_PROFILE',
  CV_COMPLETE_PROFILE: 'CV_COMPLETE_PROFILE',
  CV_VIEW_APPOINTMENT_QR: 'CV_VIEW_APPOINTMENT_QR',
  BV_SCAN_APPOINTMENT_QR: 'BV_SCAN_APPOINTMENT_QR',
  BV_APPROVE_APPOINTMENT: 'BV_APPROVE_APPOINTMENT',
  BV_REJECT_APPOINTMENT: 'BV_REJECT_APPOINTMENT',
  BV_VIEW_ENROLLMENT_STATUS: 'BV_VIEW_ENROLLMENT_STATUS',
  BV_CHECK_ADMIN_ACCESS: 'BV_CHECK_ADMIN_ACCESS',
  BV_VIEW_ENROLLMENT_REQUEST: 'BV_VIEW_ENROLLMENT_REQUEST',
  BV_SUBMIT_BUSINESS_ENROLLMENT: 'BV_SUBMIT_BUSINESS_ENROLLMENT',
  BV_RESEND_ENROLLMENT_EMAIL: 'BV_RESEND_ENROLLMENT_EMAIL',
  BV_SEND_PHONE_VERIFICATION_CODE: 'BV_SEND_PHONE_VERIFICATION_CODE',
  BV_CONFIRM_PHONE_VERIFICATION_CODE: 'BV_CONFIRM_PHONE_VERIFICATION_CODE',
  BV_CONFIRM_ENROLLMENT_EMAIL: 'BV_CONFIRM_ENROLLMENT_EMAIL',
  BV_APPROVE_BUSINESS_ENROLLMENT: 'BV_APPROVE_BUSINESS_ENROLLMENT',
  BV_REJECT_BUSINESS_ENROLLMENT: 'BV_REJECT_BUSINESS_ENROLLMENT',
  BV_ENABLE_PUSH_NOTIFICATIONS: 'BV_ENABLE_PUSH_NOTIFICATIONS',
  CV_ENABLE_PUSH_NOTIFICATIONS: 'CV_ENABLE_PUSH_NOTIFICATIONS',
  BV_DISABLE_PUSH_NOTIFICATIONS: 'BV_DISABLE_PUSH_NOTIFICATIONS',
  CV_DISABLE_PUSH_NOTIFICATIONS: 'CV_DISABLE_PUSH_NOTIFICATIONS',
  BV_REFRESH_SUBSCRIPTION: 'BV_REFRESH_SUBSCRIPTION',
});

/** @type {Set<string>} */
const actionValues = new Set(Object.values(DATABASE_ACTIONS));

/**
 * Runs the real database operation normally. Logging is queued afterwards and
 * is never awaited, so a logger outage cannot change the UI operation result.
 * @template T
 * @param {string | null | undefined} actionType
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function loggedDatabaseAction(actionType, operation) {
  try {
    const result = await operation();
    queueDatabaseLog(actionType, 'ok');
    return result;
  } catch (error) {
    queueDatabaseLog(actionType, 'error', error);
    throw error;
  }
}

/** @param {string} name @param {Record<string, unknown>} [args] */
export function databaseActionForRpc(name, args = {}) {
  const fixed = {
    get_access: DATABASE_ACTIONS.BV_CHECK_ACCESS,
    redeem_license: DATABASE_ACTIONS.BV_ACTIVATE_LICENSE,
    get_my_workspaces: DATABASE_ACTIONS.BV_VIEW_MY_BUSINESSES,
    list_my_calendars: DATABASE_ACTIONS.BV_VIEW_CALENDARS,
    add_calendar: DATABASE_ACTIONS.BV_CREATE_CALENDAR,
    delete_calendar: DATABASE_ACTIONS.BV_DELETE_CALENDAR,
    list_team: DATABASE_ACTIONS.BV_VIEW_TEAM,
    accept_calendar_invitation: DATABASE_ACTIONS.BV_ACCEPT_TEAM_INVITATION,
    revoke_invitation: DATABASE_ACTIONS.BV_CANCEL_TEAM_INVITATION,
    setup_business: DATABASE_ACTIONS.BV_COMPLETE_INITIAL_SETUP,
    add_business_event: DATABASE_ACTIONS.BV_CREATE_SERVICE,
    get_calendar_service_settings: DATABASE_ACTIONS.BV_VIEW_SERVICE_SETTINGS,
    save_calendar_service_settings: DATABASE_ACTIONS.BV_UPDATE_SERVICE_SCHEDULE,
    set_calendar_notification_minutes: DATABASE_ACTIONS.BV_UPDATE_CALENDAR_REMINDER,
    get_calendar_notification_minutes: DATABASE_ACTIONS.BV_VIEW_CALENDAR_REMINDER,
    get_business_report: DATABASE_ACTIONS.BV_VIEW_REPORTS,
    set_client_notification_preferences: DATABASE_ACTIONS.CV_UPDATE_REMINDER,
    available_slots: DATABASE_ACTIONS.CV_VIEW_AVAILABLE_APPOINTMENT_TIMES,
    create_booking: DATABASE_ACTIONS.CV_MAKE_APPOINTMENT,
    get_enrollment_status: DATABASE_ACTIONS.BV_VIEW_ENROLLMENT_STATUS,
    is_platform_owner_account: DATABASE_ACTIONS.BV_CHECK_ADMIN_ACCESS,
    enrollment_link_details: DATABASE_ACTIONS.BV_VIEW_ENROLLMENT_REQUEST,
    get_customer_profile: DATABASE_ACTIONS.CV_VIEW_PROFILE,
    complete_customer_profile: DATABASE_ACTIONS.CV_COMPLETE_PROFILE,
    get_customer_booking_qr: DATABASE_ACTIONS.CV_VIEW_APPOINTMENT_QR,
    resolve_booking_qr: DATABASE_ACTIONS.BV_SCAN_APPOINTMENT_QR,
  };
  if (name === 'get_account_role') return isClientView()
    ? DATABASE_ACTIONS.CV_SIGN_IN
    : DATABASE_ACTIONS.BV_SIGN_IN;
  if (name === 'set_team_member') return args.p_remove === true
    ? DATABASE_ACTIONS.BV_REMOVE_TEAM_MEMBER
    : DATABASE_ACTIONS.BV_UPDATE_TEAM_MEMBER_ACCESS;
  if (name === 'delete_invitee_account') return DATABASE_ACTIONS.BV_DELETE_INVITEE_ACCOUNT;
  if (name === 'set_booking_status') return args.p_status === 'rejected'
    ? DATABASE_ACTIONS.BV_REJECT_APPOINTMENT
    : DATABASE_ACTIONS.BV_APPROVE_APPOINTMENT;
  return fixed[name] || null;
}

export function currentDeviceRegistrationAction() {
  return isClientView()
    ? DATABASE_ACTIONS.CV_ENABLE_PUSH_NOTIFICATIONS
    : DATABASE_ACTIONS.BV_ENABLE_PUSH_NOTIFICATIONS;
}

export function currentDeviceRemovalAction() {
  return isClientView()
    ? DATABASE_ACTIONS.CV_DISABLE_PUSH_NOTIFICATIONS
    : DATABASE_ACTIONS.BV_DISABLE_PUSH_NOTIFICATIONS;
}

/** @param {string} action @param {Record<string, unknown>} [values] */
export function databaseActionForEnrollment(action, values = {}) {
  if (action === 'start') return DATABASE_ACTIONS.BV_SUBMIT_BUSINESS_ENROLLMENT;
  if (action === 'email') return DATABASE_ACTIONS.BV_RESEND_ENROLLMENT_EMAIL;
  if (action === 'sendSms') return DATABASE_ACTIONS.BV_SEND_PHONE_VERIFICATION_CODE;
  if (action === 'checkSms') return DATABASE_ACTIONS.BV_CONFIRM_PHONE_VERIFICATION_CODE;
  if (action === 'confirm' && String(values.token || '').toUpperCase().startsWith('RZE-')) {
    return DATABASE_ACTIONS.BV_CONFIRM_ENROLLMENT_EMAIL;
  }
  if (action === 'confirm' && values.approve === false) {
    return DATABASE_ACTIONS.BV_REJECT_BUSINESS_ENROLLMENT;
  }
  if (action === 'confirm') return DATABASE_ACTIONS.BV_APPROVE_BUSINESS_ENROLLMENT;
  return null;
}

/** @param {string | null | undefined} actionType @param {'ok'|'error'} status @param {unknown} [error] */
function queueDatabaseLog(actionType, status, error) {
  try {
    if (config.mode === 'demo' || !actionType || !actionValues.has(actionType)) return;
    const client = getSupabase();
    if (!client) return;
    const message = status === 'ok'
      ? { event: 'completed' }
      : { event: 'failed', error: safeError(error) };
    queueMicrotask(() => {
      try {
        Promise.resolve(client.rpc('write_logger_event', {
          p_action_type: actionType,
          p_status: status,
          p_message: message,
        })).then(() => undefined).catch(() => undefined);
      } catch { /* Logging is deliberately best-effort. */ }
    });
  } catch { /* Logger setup must not affect the application action. */ }
}

function isClientView() {
  const state = store.get();
  return state.role === 'customer' || state.requestedAccountType === 'client';
}

/** @param {unknown} value */
function safeError(value) {
  const source = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  return {
    name: safeText(source.name || 'Error', 80),
    message: safeText(source.message || String(value || 'Unknown database error'), 1200),
    code: safeText(source.code || '', 80),
    details: safeText(source.details || '', 1600),
    hint: safeText(source.hint || '', 800),
    httpStatus: Number.isInteger(source.status) ? source.status : null,
  };
}

/** @param {unknown} value @param {number} limit */
function safeText(value, limit) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bRZ[A-Z]-[A-Z0-9-]{8,}\b/gi, '[REDACTED_CODE]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[REDACTED_EMAIL]')
    .replace(/(?:\+40|0)7\d{8}/g, '[REDACTED_PHONE]')
    .replace(/\b(token|secret|password|authorization|api[_-]?key|license[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, limit);
}
