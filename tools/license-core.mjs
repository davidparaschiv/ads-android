// @ts-check
import { createHash, randomBytes } from 'node:crypto';

export function normalizeKey(key) {
  const value = String(key).trim().toUpperCase();
  if (!/^RZL-(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(value)) throw new Error('Invalid key format.');
  return value.slice(4).replaceAll('-', '');
}

export function hashKey(key) {
  return createHash('sha256').update(normalizeKey(key), 'utf8').digest('hex');
}

export function generateLicense({ email, start, months }) {
  const boundEmail = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(boundEmail) || boundEmail.length > 254) {
    throw new Error('Provide a valid Google-account email.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(start) || Number.isNaN(Date.parse(start))) {
    throw new Error('Start must be ISO 8601 with timezone, e.g. 2026-09-01T00:00:00+03:00.');
  }
  const [year, month, day] = start.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error('Invalid calendar date.');
  }
  const duration = Number(months);
  if (!Number.isInteger(duration) || duration < 1 || duration > 120) throw new Error('Months must be an integer from 1 to 120.');
  const random = randomBytes(32).toString('hex').toUpperCase();
  const key = 'RZL-' + random.match(/.{8}/g).join('-');
  const hash = hashKey(key);
  const startsAt = new Date(start).toISOString();
  const sqlEmail = boundEmail.replaceAll("'", "''");
  const sql = [
    '-- Run manually in Supabase SQL Editor as database administrator.',
    '-- The plaintext key is intentionally NOT included in this SQL.',
    'insert into private.license_keys (key_hash, bound_email, starts_at, duration_months)',
    "values ('" + hash + "', '" + sqlEmail + "', '" + startsAt + "'::timestamptz, " + duration + ');',
  ].join('\n');
  return { key, hash, boundEmail, startsAt, months: duration, sql };
}
