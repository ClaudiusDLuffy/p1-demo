-- Batch 3D: authenticated diagnostics admission only. This is not a general
-- rate-limit service and does not change any business/outbox command.
-- One reusable row per admitted profile hash plus one global row; no request
-- payload, IP, profile UUID, email, provider metadata or per-window row growth.
begin;

create table public.client_diagnostic_rate_limit_buckets (
  bucket_key text primary key check (bucket_key='global' or bucket_key ~ '^profile:[a-f0-9]{64}$'),
  window_started_at timestamptz not null check (isfinite(window_started_at)),
  accepted_count integer not null check (accepted_count between 0 and
    case when bucket_key='global' then 100 else 10 end)
);
create table public.client_diagnostic_rate_limit_guards (
  transaction_id bigint not null,
  relation_name text not null check (relation_name='client_diagnostic_rate_limit_buckets'),
  bucket_key text not null check (bucket_key='global' or bucket_key ~ '^profile:[a-f0-9]{64}$'),
  primary key(transaction_id,relation_name,bucket_key)
);
alter table public.client_diagnostic_rate_limit_buckets enable row level security;
alter table public.client_diagnostic_rate_limit_guards enable row level security;
revoke all on public.client_diagnostic_rate_limit_buckets,public.client_diagnostic_rate_limit_guards
  from public,anon,authenticated,service_role;

-- Initial zero counter is migration-owned, not retroactive diagnostic evidence.
insert into public.client_diagnostic_rate_limit_buckets values
  ('global',date_trunc('minute',clock_timestamp() at time zone 'UTC') at time zone 'UTC',0);

create function public.client_diagnostic_admission_cap(p_bucket_key text)
returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.client_diagnostic_rate_limit_guards(transaction_id,relation_name,bucket_key)
  values(txid_current(),'client_diagnostic_rate_limit_buckets',p_bucket_key) on conflict do nothing;
$$;

create function public.guard_client_diagnostic_admission()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op in ('DELETE','TRUNCATE') then
    raise exception 'DIAGNOSTIC_ADMISSION_COMMAND_REQUIRED' using errcode='42501';
  end if;
  if tg_op='UPDATE' and new.bucket_key is distinct from old.bucket_key then
    raise exception 'DIAGNOSTIC_ADMISSION_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if tg_table_schema<>'public' or tg_table_name<>'client_diagnostic_rate_limit_buckets' or not exists(
    select 1 from public.client_diagnostic_rate_limit_guards g where g.transaction_id=txid_current()
      and g.relation_name=tg_table_name and g.bucket_key=new.bucket_key) then
    raise exception 'DIAGNOSTIC_ADMISSION_COMMAND_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger diagnostic_admission_row_guard before insert or update or delete
  on public.client_diagnostic_rate_limit_buckets for each row execute function public.guard_client_diagnostic_admission();
create trigger diagnostic_admission_truncate_guard before truncate
  on public.client_diagnostic_rate_limit_buckets for each statement execute function public.guard_client_diagnostic_admission();
create trigger diagnostic_admission_guard_truncate_guard before truncate
  on public.client_diagnostic_rate_limit_guards for each statement execute function public.guard_client_diagnostic_admission();

create function public.consume_client_diagnostic_rate_limit_v1(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='2s' as $$
declare
  v_active boolean;
  v_now timestamptz;
  v_window timestamptz;
  v_global public.client_diagnostic_rate_limit_buckets%rowtype;
  v_profile public.client_diagnostic_rate_limit_buckets%rowtype;
  v_key text;
  v_global_count integer;
  v_profile_count integer;
  v_retry integer;
begin
  -- JWT role alone, caller GUCs and SECURITY DEFINER alone are not authority.
  if current_setting('role')<>'service_role' or auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select p.active into v_active from public.profiles p where p.id=p_profile_id for share;
  if not found then raise exception 'FORBIDDEN' using errcode='PT403';end if;
  if v_active is not true then raise exception 'ACCOUNT_INACTIVE' using errcode='PT403';end if;

  -- All instances take the same brief global row lock before the profile row.
  -- No provider, body parsing, logging or other I/O runs inside this command.
  -- Lock contention fails closed after two seconds; it never admits a log.
  select * into strict v_global from public.client_diagnostic_rate_limit_buckets where bucket_key='global' for update;
  v_now:=clock_timestamp();
  v_window:=date_trunc('minute',v_now at time zone 'UTC') at time zone 'UTC';
  v_global_count:=case when v_global.window_started_at<v_window then 0 else v_global.accepted_count end;
  v_retry:=greatest(1,least(60,ceil(extract(epoch from
    (greatest(v_window,v_global.window_started_at)+interval '1 minute'-v_now)))::integer));
  -- A saturated global limiter cannot allocate new profile rows.
  if v_global_count>=100 then
    return jsonb_build_object('allowed',false,'retryAfterSeconds',v_retry);
  end if;
  v_key:='profile:'||encode(sha256(convert_to(p_profile_id::text,'UTF8')),'hex');
  select * into v_profile from public.client_diagnostic_rate_limit_buckets where bucket_key=v_key for update;
  v_profile_count:=case when not found or v_profile.window_started_at<v_window then 0 else v_profile.accepted_count end;
  if v_profile_count>=10 then
    v_retry:=greatest(1,least(60,ceil(extract(epoch from
      (greatest(v_window,v_profile.window_started_at)+interval '1 minute'-v_now)))::integer));
    return jsonb_build_object('allowed',false,'retryAfterSeconds',v_retry);
  end if;

  perform public.client_diagnostic_admission_cap(v_key);
  insert into public.client_diagnostic_rate_limit_buckets(bucket_key,window_started_at,accepted_count)
    values(v_key,v_window,v_profile_count+1)
    on conflict(bucket_key) do update set window_started_at=greatest(excluded.window_started_at,
      public.client_diagnostic_rate_limit_buckets.window_started_at),accepted_count=excluded.accepted_count;
  perform public.client_diagnostic_admission_cap('global');
  update public.client_diagnostic_rate_limit_buckets set window_started_at=greatest(v_window,window_started_at),
    accepted_count=v_global_count+1 where bucket_key='global';
  delete from public.client_diagnostic_rate_limit_guards where transaction_id=txid_current();
  return jsonb_build_object('allowed',true,'retryAfterSeconds',0);
end;
$$;

revoke all on function public.client_diagnostic_admission_cap(text),public.guard_client_diagnostic_admission(),
  public.consume_client_diagnostic_rate_limit_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.consume_client_diagnostic_rate_limit_v1(uuid) to service_role;
commit;
