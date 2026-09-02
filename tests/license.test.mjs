// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLicense, hashKey } from '../tools/license-core.mjs';

const input = { email: ' Owner@Example.com ', start: '2026-08-27T00:00:00Z', months: 3, type: 'Complete' };
test('256-bit random license; normalized hash; SQL contains no plaintext key', () => {
  const a = generateLicense(input); const b = generateLicense(input);
  assert.match(a.key, /^RZL-(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(hashKey(' ' + a.key.toLowerCase() + ' '), a.hash);
  assert.equal(a.boundEmail, 'owner@example.com');
  assert.ok(!a.sql.includes(a.key));
  assert.ok(a.sql.includes(a.hash));
  assert.equal(a.type, 'Complete');
  assert.equal(a.calendarLimit, 10);
  assert.match(a.sql, /'Complete'::private\.license_type/);
});
test('invalid durations, dates, emails and keys are rejected', () => {
  for (const months of [0, -1, 121, 1.5, NaN]) assert.throws(() => generateLicense({ ...input, months }));
  for (const start of ['tomorrow','2026-02-30T00:00:00Z','2026-01-01','2026-01-01T00:00:00']) assert.throws(() => generateLicense({ ...input, start }));
  assert.throws(() => generateLicense({ ...input, email: 'not-an-email' }));
  assert.throws(() => generateLicense({ ...input, type: 'small' }));
  assert.throws(() => generateLicense({ ...input, type: '' }));
  assert.throws(() => hashKey('RZL-123'));
});
test('half_complete licenses are normalized and generate a five-calendar SQL row', () => {
  const a = generateLicense({ ...input, type: 'HALF_COMPLETE' });
  assert.equal(a.type, 'half_complete');
  assert.equal(a.calendarLimit, 5);
  assert.match(a.sql, /'half_complete'::private\.license_type/);
});
test('manual SQL safely quotes valid email containing apostrophe', () => {
  const a = generateLicense({ ...input, email: "o'neal@example.com" });
  assert.ok(a.sql.includes("o''neal@example.com"));
});
