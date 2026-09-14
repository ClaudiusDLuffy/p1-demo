-- Read-only Batch 3D diagnostic admission audit. Counts and catalog identifiers
-- only: no bucket keys/profile hashes, profile UUIDs, IPs or diagnostic payload.
-- No admission, reset, expiry cleanup, repair, logging or provider request.
with findings as (
  select 'global_bucket_missing_or_duplicated'::text finding
    where (select count(*) from public.client_diagnostic_rate_limit_buckets where bucket_key='global')<>1
  union all select 'counter_outside_fixed_cap' from public.client_diagnostic_rate_limit_buckets
    where accepted_count<0 or accepted_count>case when bucket_key='global' then 100 else 10 end
  union all select 'unexpected_bucket_identity' from public.client_diagnostic_rate_limit_buckets
    where bucket_key<>'global' and bucket_key !~ '^profile:[a-f0-9]{64}$'
  union all select 'noncanonical_or_future_window' from public.client_diagnostic_rate_limit_buckets
    where not isfinite(window_started_at)
      or window_started_at is distinct from (date_trunc('minute',window_started_at at time zone 'UTC') at time zone 'UTC')
      or window_started_at>clock_timestamp()
  union all select 'lingering_transaction_capability' from public.client_diagnostic_rate_limit_guards
) select finding,count(*) as record_count from findings group by finding order by finding;

select c.relname as relation_name,c.relrowsecurity as rls_enabled,r.role_name,
  has_table_privilege(r.role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') as unexpected_raw_privilege,
  exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) as public_privilege
from pg_class c cross join (values('anon'),('authenticated'),('service_role')) r(role_name)
where c.relnamespace='public'::regnamespace and c.relname in
  ('client_diagnostic_rate_limit_buckets','client_diagnostic_rate_limit_guards')
order by c.relname,r.role_name;

select p.oid::regprocedure::text as function_signature,p.prosecdef as security_definer,
  coalesce(p.proconfig @> array['search_path=pg_catalog, public'],false) as pinned_safe_search_path,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
  md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (
  'consume_client_diagnostic_rate_limit_v1','client_diagnostic_admission_cap','guard_client_diagnostic_admission')
order by p.proname;

select
  exists(select 1 from pg_trigger where tgrelid='public.client_diagnostic_rate_limit_buckets'::regclass
    and tgname='diagnostic_admission_row_guard' and tgenabled='O') as row_command_guard,
  exists(select 1 from pg_trigger where tgrelid='public.client_diagnostic_rate_limit_buckets'::regclass
    and tgname='diagnostic_admission_truncate_guard' and tgenabled='O') as bucket_truncate_guard,
  exists(select 1 from pg_trigger where tgrelid='public.client_diagnostic_rate_limit_guards'::regclass
    and tgname='diagnostic_admission_guard_truncate_guard' and tgenabled='O') as capability_truncate_guard,
  position('current_setting(''role'')<>''service_role''' in pg_get_functiondef('public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure))>0
    and position('auth.role() is distinct from ''service_role''' in pg_get_functiondef('public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure))>0 as dual_service_role_check,
  position('for share' in lower(pg_get_functiondef('public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure)))>0 as active_profile_locked,
  position('for update' in lower(pg_get_functiondef('public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure)))>0 as atomic_bucket_lock,
  position('clock_timestamp()' in pg_get_functiondef('public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure))>0 as database_clock,
  (select coalesce(proconfig @> array['lock_timeout=2s'],false) from pg_proc
    where oid='public.consume_client_diagnostic_rate_limit_v1(uuid)'::regprocedure) as bounded_lock_timeout,
  (select count(*)=3 from information_schema.columns where table_schema='public' and table_name='client_diagnostic_rate_limit_buckets') as minimal_content_free_bucket_schema;

select count(*) filter(where bucket_key<>'global') as persistent_admitted_profile_bucket_count,
  max(accepted_count) filter(where bucket_key='global') as global_window_accepted_count,
  max(window_started_at) filter(where bucket_key='global') as global_window_started_at,
  10 as per_user_per_minute_cap,100 as global_per_minute_cap,
  'UTC server-minute fixed windows; denied requests do not increment counters; no destructive cleanup job'::text as policy
from public.client_diagnostic_rate_limit_buckets;
