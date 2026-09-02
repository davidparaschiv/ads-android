-- Keep application database logs for four days. The existing daily cron job
-- reads this value each time it runs, so it does not need to be recreated.

begin;

insert into public.config_purge(target_table,retention_days,updated_at)
values('logger_engine',4,now())
on conflict(target_table) do update
set retention_days=excluded.retention_days,
    updated_at=excluded.updated_at;

commit;
