import test from 'node:test';
import assert from 'node:assert/strict';
import { loggedFetch } from '../src/observability/external-api-log.js';

test('external API Logcat diagnostics are structured and redact secrets and PII', async t => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalInfo = console.info;
  const lines = [];
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; console.info = originalInfo; });
  console.error = value => lines.push(String(value));
  console.info = value => lines.push(String(value));
  globalThis.fetch = async () => Response.json({
    error: 'Provider rejected david@example.com at +40712345678',
    token: 'RZE-' + 'A'.repeat(64),
    diagnostic: { provider: 'twilio', providerCode: 60200, httpStatus: 400, requestId: 'RQ-safe' },
  }, { status: 502, headers: { 'x-request-id': 'edge-safe' } });

  const response = await loggedFetch('https://project.supabase.co/functions/v1/enrollment?token=do-not-log', { method: 'POST' });
  assert.equal(response.status, 502);
  const output = lines.join('\n');
  assert.match(output, /RezervariExternalAPI/);
  assert.match(output, /POST \/functions\/v1\/enrollment/);
  assert.match(output, /"providerCode":60200/);
  assert.match(output, /"requestId":"edge-safe"/);
  assert.doesNotMatch(output, /do-not-log|david@example\.com|40712345678|RZE-A/);
});
