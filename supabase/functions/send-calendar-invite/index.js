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
    const webUrl = Deno.env.get('INVITE_WEB_URL');
    const link = webUrl ? `${webUrl}#token=${encodeURIComponent(data.token)}` : `ro.rezerva.app://invite?token=${encodeURIComponent(data.token)}`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `calendar-invite/${data.id}` },
      body: JSON.stringify({ from, to: [data.email], subject: 'Invitație în echipa Rezerva',
        text: `Ai fost invitat(ă) să accesezi calendare în Rezerva.\n\nDeschide aplicația: ${link}\n\nSau copiază acest cod în ecranul Invitații: ${data.token}\n\nConectează-te cu Google folosind ${data.email}. Invitația expiră în 48 de ore. Membrii invitați nu plătesc abonament. Dacă nu recunoști invitația, o poți ignora.`,
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
