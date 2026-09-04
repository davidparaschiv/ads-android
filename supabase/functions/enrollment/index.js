// @ts-check
import { authenticated, env, headers, json, serviceClient } from '../_shared/http.js';

class ExternalProviderError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'ExternalProviderError';
    this.diagnostic = diagnostic;
  }
}

class PublicApplicationError extends Error {}

async function providerFailure(response, provider, operation) {
  let payload = null;
  try { payload = await response.json(); } catch { /* Provider did not return JSON. */ }
  return new ExternalProviderError(
    provider === 'twilio'
      ? 'Verificarea SMS a eșuat. Verifică numărul/codul sau reîncearcă mai târziu.'
      : 'E-mailul nu a putut fi trimis. Poți retrimite din ecranul de verificare.',
    {
      provider,
      operation,
      httpStatus: response.status,
      providerCode: typeof payload?.code === 'number' || typeof payload?.code === 'string' ? payload.code : null,
      providerType: typeof payload?.name === 'string' ? payload.name : null,
      requestId: response.headers.get('twilio-request-id') || response.headers.get('x-request-id') || response.headers.get('cf-ray') || null,
    },
  );
}

async function sendLink(id, ownerId, kind) {
  // Fail before minting a token if mail configuration is missing.
  const from = env('INVITE_FROM_EMAIL'), apiKey = env('RESEND_API_KEY');
  const { data, error } = await serviceClient().rpc('issue_enrollment_link', { p_request_id: id, p_owner: ownerId, p_kind: kind });
  if (error) throw error;
  if (!data?.ok) throw new PublicApplicationError(data?.message || 'Linkul nu poate fi trimis acum.');
  const text = kind === 'approval'
    ? `Rezervari.ai · Aprobare afacere\n\nDenumire: ${data.name}\nCategorie: ${data.category}\nCUI: ${data.cui}\nAdresă: ${data.address}\nE-mail business: ${data.email}\nTelefon: ${data.phone}\n\nCod aprobare:\n${data.email}/${data.token}\nValabil 30 de zile.`
    : `Rezervari.ai · Confirmare cont business\n\nDenumire: ${data.name}\nCategorie: ${data.category}\nCUI: ${data.cui}\nAdresă: ${data.address}\nE-mail business: ${data.email}\nTelefon: ${data.phone}\n\nCod confirmare:\n${data.token}\nValabil 30 de zile.`;
  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [data.recipient], subject: kind === 'approval' ? 'Rezervari.ai · Cod pentru aprobarea afacerii' : 'Rezervari.ai · Confirmă contul de business', text }),
  });
  if (!sent.ok) throw await providerFailure(sent, 'resend', kind === 'approval' ? 'send-approval-email' : 'send-verification-email');
}

async function twilio(path, values) {
  const service = env('TWILIO_VERIFY_SERVICE_SID');
  if (!/^VA[0-9a-fA-F]{32}$/.test(service)) throw new PublicApplicationError('Serviciul SMS nu este configurat.');
  const result = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
    method: 'POST', headers: { Authorization: 'Basic ' + btoa(env('TWILLIO_ACCOUNT_SID') + ':' + env('TWILLIO_AUTH_TOKEN')), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
  if (!result.ok) throw await providerFailure(result, 'twilio', path === 'VerificationCheck' ? 'check-verification' : 'send-verification');
  return result.json();
}

export async function handleEnrollment(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: headers(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);
  let actor;
  try { actor = await authenticated(request); } catch { return json(request, { error: 'Autentificare necesară.' }, 401); }
  try {
    const input = await request.text();
    if (input.length>8000) return json(request, { error: 'Cerere prea mare.' }, 413);
    const body = JSON.parse(input);
    const call = async (name, args) => {
      const { data, error } = await actor.client.rpc(name, args);
      if (error) {
        if (error.code === 'P0001') throw new PublicApplicationError(error.message);
        throw error;
      }
      if (data?.ok === false) throw new PublicApplicationError(data.message || 'Operație indisponibilă.');
      return data;
    };
    if (body.action === 'start') {
      const data = await call('start_enrollment', { p_name: body.name, p_category: body.category, p_address: body.address, p_cui: body.cui, p_phone: body.phone });
      try { await sendLink(data.id, actor.user.id, 'email'); return json(request, { ok: true, id: data.id }); }
      catch (error) { return json(request, {
        ok: true,
        id: data.id,
        warning: 'Cererea privată a fost salvată, dar e-mailul nu a fost trimis. Folosește Retrimite codul.',
        ...(error instanceof ExternalProviderError ? { diagnostic: error.diagnostic } : {}),
      }); }
    }
    if (body.action === 'email') {
      // ownerId comes from authenticated JWT, never request body; recipient comes from DB only.
      await sendLink(body.id, actor.user.id, body.action);
      return json(request, { ok: true });
    }
    if (body.action === 'sendSms' || body.action === 'checkSms') {
      env('TWILLIO_ACCOUNT_SID'); env('TWILLIO_AUTH_TOKEN'); env('TWILIO_VERIFY_SERVICE_SID');
      const checking = body.action === 'checkSms';
      const context = await call('enrollment_sms_context', { p_request_id: body.id, p_check: checking });
      if (context.verified) return json(request, { ok: true, verified: true });
      if (checking && (!context.sid || !/^[0-9]{4,10}$/.test(body.code || ''))) throw new PublicApplicationError('Introdu codul SMS primit.');
      const verification = checking
        ? await twilio('VerificationCheck', { VerificationSid: context.sid, Code: body.code })
        : await twilio('Verifications', { To: context.phone, Channel: 'sms', Locale: 'ro' });
      if (verification.to !== context.phone || (checking && (verification.status !== 'approved' || verification.sid !== context.sid))) throw new PublicApplicationError('Codul SMS nu a fost confirmat.');
      const { data: recorded, error } = await serviceClient().rpc('enrollment_record_sms', {
        p_request_id: body.id, p_owner: actor.user.id, p_sid: verification.sid, p_verified: checking,
      });
      if (error || !recorded) throw new PublicApplicationError('Cererea s-a schimbat. Reîncearcă verificarea.');
      if (checking) await sendLink(body.id, actor.user.id, 'approval');
      return json(request, { ok: true, verified: checking, approvalSent: checking });
    }
    if (body.action === 'confirm') {
      const result = await call('confirm_enrollment_link', { p_token: body.token, p_approve: body.approve !== false });
      return json(request, result);
    }
    return json(request, { error: 'Operație necunoscută.' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const missingSetting = message.startsWith('Missing server setting:') ? message.slice('Missing server setting:'.length).trim() : '';
    return json(request, {
      error: missingSetting ? 'Serviciul nu este configurat pe server.'
        : error instanceof PublicApplicationError || error instanceof ExternalProviderError ? message
          : 'Error',
      ...(error instanceof ExternalProviderError ? { diagnostic: error.diagnostic } : {}),
      ...(missingSetting ? { diagnostic: { provider: missingSetting.startsWith('TWIL') ? 'twilio' : missingSetting.startsWith('RESEND') || missingSetting === 'INVITE_FROM_EMAIL' ? 'resend' : 'server', operation: 'configuration', missingSetting } } : {}),
    }, 400);
  }
}
Deno.serve(handleEnrollment);
