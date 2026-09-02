-- Notification scheduler infrastructure.
-- Environment-specific Vault values are configured separately; no secret
-- values belong in this migration.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $migration$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'rezerva-reminders'
  ) then
    perform cron.schedule(
      'rezerva-reminders',
      '* * * * *',
      $job$
      select net.http_post(
        url := (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'rezerva_project_url'
        ) || '/functions/v1/send-reminders',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'rezerva_cron_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
      );
      $job$
    );
  end if;
end
$migration$;
