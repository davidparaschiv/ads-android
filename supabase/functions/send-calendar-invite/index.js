// @ts-check
import { authenticated, env, headers, json, serviceClient } from '../_shared/http.js';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: headers(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);
  let actor;
  try { actor = await authenticated(request); } catch { return json(request, { error: 'Autentificare necesară.' }, 401); }
  let invitationId;
  try {
    const apiKey = env('RESEND_API_KEY');
    const from = env('INVITE_FROM_EMAIL');
    const body = await request.json();
    const { data, error } = await actor.client.rpc('issue_calendar_invitation', {
      p_business_id: body.businessId, p_email: body.email, p_calendar_ids: body.calendarIds, p_permission: body.permission,
    });
    if (error) return json(request, { error: 'Nu poți trimite această invitație.' }, 403);
    if (!data?.ok) return json(request, { error: 'Prea multe încercări. Reîncearcă în 15 minute.' }, 429);
    invitationId = data.id;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `calendar-invite/${data.id}` },
      body: JSON.stringify({ from, to: [data.email], subject: 'Rezervari.ai · Invitație în echipă',
        text: `Rezervari.ai · Invitație în echipă\n\nE-mail invitat: ${data.email}\nCod invitație: ${data.token}\nValabil 48 de ore.`,
      }),
    });
    if (!response.ok) throw new Error('Email delivery failed');
    const { error: deliveryError } = await serviceClient().rpc('mark_invitation_delivery', { p_id: data.id, p_sent: true });
    if (deliveryError) throw deliveryError;
    return json(request, { ok: true });
  } catch {
    if (invitationId) await serviceClient().rpc('mark_invitation_delivery', { p_id: invitationId, p_sent: false });
    return json(request, { error: 'Invitația nu a putut fi trimisă. Verifică configurarea e-mailului sau retrimite din Echipă.' }, 502);
  }
});
