// @ts-check
// Scheduled function: call every minute with x-cron-secret.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { JWT } from 'npm:google-auth-library@9';

Deno.serve(async (request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!secret || request.headers.get('x-cron-secret') !== secret) return new Response('Unauthorized', { status: 401 });
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const { data: jobs, error } = await supabase.from('notification_jobs').select('*').eq('status', 'pending').lte('send_at', new Date().toISOString()).limit(100);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!jobs?.length) return Response.json({ processed: 0 });

  const credentials = JSON.parse(Deno.env.get('GCLOUD_SERVICEACCOUNT_KEYS') ?? '{}');
  const auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  const { access_token: accessToken } = await auth.authorize();
  const projectId = Deno.env.get('FIREBASE_PROJID');
  let processed = 0;

  for (const job of jobs) {
    const { data: claimed, error: claimError } = await supabase.from('notification_jobs').update({ status: 'processing', attempts: job.attempts + 1 }).eq('id', job.id).eq('status', 'pending').select('id').maybeSingle();
    if (claimError || !claimed) continue;
    const { data: tokens } = await supabase.from('device_tokens').select('token').eq('user_id', job.user_id);
    try {
      const { data: allowed, error: allowedError } = await supabase.rpc('notification_job_recipient_allowed', { p_job: job.id });
      if (allowedError) throw allowedError;
      if (!allowed) { await supabase.from('notification_jobs').update({ status: 'cancelled' }).eq('id', job.id); continue; }
      if (!tokens?.length) {
        await supabase.from('notification_jobs').update({
          status: 'pending', attempts: job.attempts, last_error: 'No registered device token',
        }).eq('id', job.id);
        continue;
      }
      for (const item of tokens || []) {
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            token: item.token,
            notification: { title: job.title, body: job.body },
            data: { bookingId: job.booking_id, route: job.target_route || '/customer/notifications' },
            android: {
              priority: 'high',
              notification: {
                channel_id: 'rezerva_bookings',
                sound: 'default',
                notification_priority: 'PRIORITY_HIGH',
                visibility: 'PUBLIC',
                default_vibrate_timings: true,
              },
            },
          } }),
        });
        if (!response.ok) throw new Error(await response.text());
      }
      await supabase.from('notification_jobs').update({ status: 'sent', last_error: null }).eq('id', job.id);
      await supabase.from('notification_log').insert({ user_id: job.user_id, booking_id: job.booking_id, title: job.title, body: job.body });
      processed += 1;
    } catch {
      await supabase.from('notification_jobs').update({ status: job.attempts >= 2 ? 'failed' : 'pending', last_error: 'Push delivery failed' }).eq('id', job.id);
    }
  }
  return Response.json({ processed });
});
