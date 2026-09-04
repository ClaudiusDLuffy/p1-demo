-- Establish a private, encrypted-at-rest QuickBooks Online connection store.
-- This migration intentionally adds no Bill/Invoice write workflow. Sandbox
-- authorization is isolated from the existing contractor-payables handoff and
-- from the P1-to-7-Eleven receivables/SaaSAnt export.

begin;

-- The original v9 placeholder stored plaintext OAuth credentials and granted
-- broad client access. Nothing in the application uses it; lock it down before
-- any real Intuit authorization is accepted. Existing rows are retained for
-- manual reconciliation and are never read by the new connector.
alter table public.qbo_tokens enable row level security;
drop policy if exists qbo_staff on public.qbo_tokens;
revoke all on public.qbo_tokens from public, anon, authenticated, service_role;
grant select on public.qbo_tokens to service_role;

comment on table public.qbo_tokens is
  'Deprecated plaintext placeholder. Server-only for reconciliation; the application uses quickbooks_connections with encrypted token values.';

create table if not exists public.quickbooks_oauth_states (
  state_hash text primary key,
  actor_id uuid not null
    references public.profiles(id) on delete cascade,
  environment text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_realm_id text,
  constraint quickbooks_oauth_state_hash_shape_check
    check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint quickbooks_oauth_state_environment_check
    check (environment in ('sandbox', 'production')),
  constraint quickbooks_oauth_state_lifetime_check
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '15 minutes'
    ),
  constraint quickbooks_oauth_state_realm_shape_check
    check (
      used_realm_id is null
      or used_realm_id ~ '^[0-9]{1,32}$'
    ),
  constraint quickbooks_oauth_state_use_shape_check
    check (
      used_realm_id is null
      or used_at is not null
    )
);

create index if not exists quickbooks_oauth_states_expiry_idx
  on public.quickbooks_oauth_states (expires_at);

alter table public.quickbooks_oauth_states enable row level security;
revoke all on public.quickbooks_oauth_states
  from public, anon, authenticated, service_role;
grant select, update on public.quickbooks_oauth_states to service_role;

comment on table public.quickbooks_oauth_states is
  'Server-only, one-time OAuth state bound to the active staff member who initiated QuickBooks authorization.';

create table if not exists public.quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  environment text not null,
  realm_id text not null,
  company_name text,
  scope text not null default 'com.intuit.quickbooks.accounting',
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  token_key_version integer not null default 1,
  token_key_fingerprint text not null,
  status text not null default 'active',
  last_authorization_attempt_hash text not null,
  last_authorization_attempt_created_at timestamptz not null,
  connected_by uuid not null
    references public.profiles(id) on delete restrict,
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  disconnected_by uuid
    references public.profiles(id) on delete restrict,
  disconnected_at timestamptz,
  disconnect_claim_id uuid,
  disconnect_claimed_by uuid
    references public.profiles(id) on delete restrict,
  disconnect_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quickbooks_connection_environment_check
    check (environment in ('sandbox', 'production')),
  constraint quickbooks_connection_realm_shape_check
    check (realm_id ~ '^[0-9]{1,32}$'),
  constraint quickbooks_connection_key_version_check
    check (token_key_version > 0),
  constraint quickbooks_connection_key_fingerprint_check
    check (token_key_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint quickbooks_connection_attempt_hash_check
    check (last_authorization_attempt_hash ~ '^[0-9a-f]{64}$'),
  constraint quickbooks_connection_status_check
    check (status in ('active', 'disconnecting', 'disconnected')),
  constraint quickbooks_connection_token_state_check
    check (
      (
        status = 'active'
        and disconnected_at is null
        and disconnected_by is null
        and disconnect_claim_id is null
        and disconnect_claimed_by is null
        and disconnect_claimed_at is null
        and access_token_ciphertext is not null
        and refresh_token_ciphertext is not null
        and access_token_expires_at is not null
      )
      or (
        status = 'disconnecting'
        and disconnected_at is null
        and disconnected_by is null
        and disconnect_claim_id is not null
        and disconnect_claimed_by is not null
        and disconnect_claimed_at is not null
        and access_token_ciphertext is not null
        and refresh_token_ciphertext is not null
        and access_token_expires_at is not null
      )
      or (
        status = 'disconnected'
        and disconnected_at is not null
        and disconnected_by is not null
        and disconnect_claim_id is not null
        and disconnect_claimed_by is not null
        and disconnect_claimed_at is not null
        and access_token_ciphertext is null
        and refresh_token_ciphertext is null
        and access_token_expires_at is null
        and refresh_token_expires_at is null
      )
    ),
  constraint quickbooks_connection_environment_realm_key
    unique (environment, realm_id)
);

-- P1 may connect to only one company in each environment at a time. A realm
-- change must be explicit rather than silently redirecting accounting writes.
create unique index if not exists quickbooks_one_active_realm_per_environment
  on public.quickbooks_connections (environment)
  where status in ('active', 'disconnecting');

drop trigger if exists touch_quickbooks_connections
  on public.quickbooks_connections;
create trigger touch_quickbooks_connections
  before update on public.quickbooks_connections
  for each row execute function public.touch_updated_at();

alter table public.quickbooks_connections enable row level security;
revoke all on public.quickbooks_connections
  from public, anon, authenticated, service_role;
grant select on public.quickbooks_connections to service_role;

comment on table public.quickbooks_connections is
  'Server-only QuickBooks OAuth connection metadata. Token columns contain application-encrypted AES-GCM ciphertext, never plaintext.';

create table if not exists public.quickbooks_connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.quickbooks_connections(id) on delete restrict,
  actor_id uuid not null
    references public.profiles(id) on delete restrict,
  event_type text not null,
  environment text not null,
  realm_id text not null,
  authorization_attempt_hash text,
  disconnect_claim_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint quickbooks_connection_event_type_check
    check (event_type in (
      'connected',
      'reconnected',
      'disconnected',
      'disconnect_failed'
    )),
  constraint quickbooks_connection_event_environment_check
    check (environment in ('sandbox', 'production')),
  constraint quickbooks_connection_event_realm_shape_check
    check (realm_id ~ '^[0-9]{1,32}$'),
  constraint quickbooks_connection_event_details_shape_check
    check (jsonb_typeof(details) = 'object'),
  constraint quickbooks_connection_event_operation_shape_check
    check (
      (
        event_type in ('connected', 'reconnected')
        and authorization_attempt_hash ~ '^[0-9a-f]{64}$'
        and disconnect_claim_id is null
      )
      or (
        event_type in ('disconnected', 'disconnect_failed')
        and authorization_attempt_hash is null
        and disconnect_claim_id is not null
      )
    )
);

create index if not exists quickbooks_connection_events_connection_idx
  on public.quickbooks_connection_events (connection_id, created_at desc);

create unique index if not exists quickbooks_connection_events_authorization_attempt_key
  on public.quickbooks_connection_events (authorization_attempt_hash)
  where authorization_attempt_hash is not null;

create unique index if not exists quickbooks_connection_events_disconnect_claim_key
  on public.quickbooks_connection_events (disconnect_claim_id)
  where disconnect_claim_id is not null;

-- A disconnect is an environment-wide authorization generation barrier, even
-- when a delayed callback belongs to a different realm. This partial index
-- makes the latest durable barrier lookup constant-time for each environment.
create index if not exists quickbooks_connection_events_disconnect_watermark_idx
  on public.quickbooks_connection_events (environment, created_at desc)
  where event_type = 'disconnected';

alter table public.quickbooks_connection_events enable row level security;
revoke all on public.quickbooks_connection_events
  from public, anon, authenticated, service_role;
grant select on public.quickbooks_connection_events to service_role;

comment on table public.quickbooks_connection_events is
  'Append-only server audit of QuickBooks connect/reconnect/disconnect events. OAuth credentials are forbidden from event details.';

create or replace function public.begin_quickbooks_oauth_authorization(
  p_actor_id uuid,
  p_environment text,
  p_state_hash text,
  p_redirect_uri text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_at timestamptz := now();
  v_expires_at timestamptz := now() + interval '10 minutes';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QuickBooks authorizations are server-managed'
      using errcode = '42501';
  end if;

  if coalesce(p_environment, '') not in ('sandbox', 'production')
     or not coalesce(p_state_hash ~ '^[0-9a-f]{64}$', false)
     or coalesce(length(trim(p_redirect_uri)), 0) < 8
     or length(p_redirect_uri) > 2048 then
    raise exception 'QuickBooks authorization metadata is invalid'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
     and permission_grant.permission = 'quickbooks_handoff'
    where profile.id = p_actor_id
      and profile.active
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active QuickBooks handoff owner required'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quickbooks:' || p_environment, 0)
  );

  if exists (
    select 1
    from public.quickbooks_connections connection_row
    where connection_row.environment = p_environment
      and connection_row.status in ('active', 'disconnecting')
  ) then
    raise exception 'Disconnect the current QuickBooks company before starting another authorization'
      using errcode = 'PT409';
  end if;

  -- Only one unconsumed authorization may exist per environment. Starting a
  -- new flow invalidates every older browser tab before a new state is issued.
  update public.quickbooks_oauth_states oauth_state
  set used_at = v_created_at
  where oauth_state.environment = p_environment
    and oauth_state.used_at is null;

  delete from public.quickbooks_oauth_states oauth_state
  where oauth_state.expires_at < v_created_at - interval '24 hours';

  insert into public.quickbooks_oauth_states (
    state_hash,
    actor_id,
    environment,
    redirect_uri,
    created_at,
    expires_at
  ) values (
    p_state_hash,
    p_actor_id,
    p_environment,
    p_redirect_uri,
    v_created_at,
    v_expires_at
  );

  return jsonb_build_object(
    'createdAt', v_created_at,
    'expiresAt', v_expires_at
  );
end;
$$;

revoke all on function public.begin_quickbooks_oauth_authorization(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.begin_quickbooks_oauth_authorization(
  uuid, text, text, text
) to service_role;

create or replace function public.save_quickbooks_connection(
  p_actor_id uuid,
  p_environment text,
  p_realm_id text,
  p_company_name text,
  p_scope text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz,
  p_token_key_version integer,
  p_token_key_fingerprint text,
  p_authorization_attempt_hash text,
  p_authorization_attempt_created_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.quickbooks_connections%rowtype;
  v_connection_id uuid;
  v_was_connected boolean := false;
  v_event_type text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QuickBooks connections are server-managed'
      using errcode = '42501';
  end if;

  if coalesce(p_environment, '') not in ('sandbox', 'production')
     or not coalesce(p_realm_id ~ '^[0-9]{1,32}$', false)
     or coalesce(length(p_access_token_ciphertext), 0) < 40
     or coalesce(length(p_refresh_token_ciphertext), 0) < 40
     or p_access_token_expires_at is null
     or p_access_token_expires_at <= now()
     or (
       p_refresh_token_expires_at is not null
       and p_refresh_token_expires_at <= now()
     )
     or coalesce(p_token_key_version, 0) < 1
     or not coalesce(p_token_key_fingerprint ~ '^[0-9a-f]{64}$', false)
     or not coalesce(p_authorization_attempt_hash ~ '^[0-9a-f]{64}$', false)
     or p_authorization_attempt_created_at is null
     or p_authorization_attempt_created_at < now() - interval '30 minutes'
     or p_authorization_attempt_created_at > now() + interval '1 minute'
     or not (
       'com.intuit.quickbooks.accounting' = any(
         regexp_split_to_array(trim(coalesce(p_scope, '')), '\s+')
       )
     ) then
    raise exception 'QuickBooks connection metadata is invalid'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
     and permission_grant.permission = 'quickbooks_handoff'
    where profile.id = p_actor_id
      and profile.active
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active QuickBooks handoff owner required'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quickbooks:' || p_environment, 0)
  );

  -- The OAuth state hash is a durable idempotency key. A callback may retry
  -- after losing the RPC response without overwriting a newer authorization.
  select event_row.connection_id, event_row.event_type
  into v_connection_id, v_event_type
  from public.quickbooks_connection_events event_row
  where event_row.authorization_attempt_hash = p_authorization_attempt_hash;

  if found then
    if exists (
      select 1
      from public.quickbooks_connections connection_row
      where connection_row.id = v_connection_id
        and connection_row.environment = p_environment
        and connection_row.realm_id = p_realm_id
        and connection_row.status = 'active'
        and connection_row.last_authorization_attempt_hash
          = p_authorization_attempt_hash
    ) then
      return jsonb_build_object(
        'connectionId', v_connection_id,
        'eventType', v_event_type,
        'idempotent', true
      );
    end if;

    raise exception 'This QuickBooks authorization is no longer current'
      using errcode = 'PT409';
  end if;

  -- Disconnect applies to the whole configured environment, not only to the
  -- realm that happened to be current. A callback initiated before the latest
  -- completed disconnect can never connect another realm afterward.
  if exists (
    select 1
    from public.quickbooks_connection_events disconnect_event
    where disconnect_event.environment = p_environment
      and disconnect_event.event_type = 'disconnected'
      and disconnect_event.created_at >= p_authorization_attempt_created_at
  ) then
    raise exception 'This QuickBooks authorization predates the environment disconnect'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from public.quickbooks_connections connection_row
    where connection_row.environment = p_environment
      and connection_row.status in ('active', 'disconnecting')
      and connection_row.realm_id <> p_realm_id
  ) then
    raise exception 'A different QuickBooks company is already connected in this environment'
      using errcode = '23505';
  end if;

  select connection_row.*
  into v_connection
  from public.quickbooks_connections connection_row
  where connection_row.environment = p_environment
    and connection_row.realm_id = p_realm_id
  for update;

  if found then
    if v_connection.status = 'disconnecting' then
      raise exception 'QuickBooks disconnect is already in progress'
        using errcode = 'PT409';
    end if;
    if v_connection.status = 'disconnected'
       and p_authorization_attempt_created_at <= v_connection.disconnected_at then
      raise exception 'This QuickBooks authorization predates the completed disconnect'
        using errcode = 'PT409';
    end if;
    if v_connection.status = 'active'
       and (
         v_connection.token_key_version <> p_token_key_version
         or v_connection.token_key_fingerprint <> p_token_key_fingerprint
       ) then
      raise exception 'Disconnect QuickBooks before changing the token encryption key'
        using errcode = 'PT409';
    end if;
    if v_connection.last_authorization_attempt_created_at
       > p_authorization_attempt_created_at then
      raise exception 'A newer QuickBooks authorization has already been saved'
        using errcode = 'PT409';
    end if;

    v_connection_id := v_connection.id;
    v_was_connected := v_connection.status = 'active';
    update public.quickbooks_connections
    set company_name = nullif(trim(p_company_name), ''),
        scope = p_scope,
        access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        token_key_version = p_token_key_version,
        token_key_fingerprint = p_token_key_fingerprint,
        status = 'active',
        last_authorization_attempt_hash = p_authorization_attempt_hash,
        last_authorization_attempt_created_at = p_authorization_attempt_created_at,
        connected_by = p_actor_id,
        connected_at = now(),
        last_verified_at = now(),
        disconnected_by = null,
        disconnected_at = null,
        disconnect_claim_id = null,
        disconnect_claimed_by = null,
        disconnect_claimed_at = null
    where id = v_connection_id;
    v_event_type := 'reconnected';
  else
    insert into public.quickbooks_connections (
      environment,
      realm_id,
      company_name,
      scope,
      access_token_ciphertext,
      refresh_token_ciphertext,
      access_token_expires_at,
      refresh_token_expires_at,
      token_key_version,
      token_key_fingerprint,
      status,
      last_authorization_attempt_hash,
      last_authorization_attempt_created_at,
      connected_by,
      last_verified_at
    ) values (
      p_environment,
      p_realm_id,
      nullif(trim(p_company_name), ''),
      p_scope,
      p_access_token_ciphertext,
      p_refresh_token_ciphertext,
      p_access_token_expires_at,
      p_refresh_token_expires_at,
      p_token_key_version,
      p_token_key_fingerprint,
      'active',
      p_authorization_attempt_hash,
      p_authorization_attempt_created_at,
      p_actor_id,
      now()
    ) returning id into v_connection_id;
    v_event_type := 'connected';
  end if;

  insert into public.quickbooks_connection_events (
    connection_id,
    actor_id,
    event_type,
    environment,
    realm_id,
    authorization_attempt_hash,
    details
  ) values (
    v_connection_id,
    p_actor_id,
    v_event_type,
    p_environment,
    p_realm_id,
    p_authorization_attempt_hash,
    jsonb_build_object(
      'companyName', nullif(trim(p_company_name), ''),
      'connectionReplaced', coalesce(v_was_connected, false)
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection_id,
    'eventType', v_event_type,
    'idempotent', false
  );
end;
$$;

revoke all on function public.save_quickbooks_connection(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  integer, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.save_quickbooks_connection(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  integer, text, text, timestamptz
) to service_role;

create or replace function public.claim_quickbooks_connection_disconnect(
  p_connection_id uuid,
  p_actor_id uuid,
  p_expected_updated_at timestamptz,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.quickbooks_connections%rowtype;
  v_environment text;
  v_retry_after_seconds integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QuickBooks connections are server-managed'
      using errcode = '42501';
  end if;

  if p_claim_id is null then
    raise exception 'QuickBooks disconnect claim is invalid'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
     and permission_grant.permission = 'quickbooks_handoff'
    where profile.id = p_actor_id
      and profile.active
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active QuickBooks handoff owner required'
      using errcode = '42501';
  end if;

  select connection_row.environment
  into v_environment
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id;

  if not found then
    raise exception 'QuickBooks connection not found'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quickbooks:' || v_environment, 0)
  );

  select connection_row.*
  into v_connection
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id
  for update;

  if v_connection.status = 'disconnected' then
    return jsonb_build_object(
      'connectionId', v_connection.id,
      'alreadyDisconnected', true
    );
  end if;

  if v_connection.status = 'active'
     and v_connection.updated_at is distinct from p_expected_updated_at then
    raise exception 'QuickBooks connection changed; refresh before disconnecting'
      using errcode = 'PT409';
  end if;

  if v_connection.status = 'active' then
    update public.quickbooks_connections
    set status = 'disconnecting',
        disconnect_claim_id = p_claim_id,
        disconnect_claimed_by = p_actor_id,
        disconnect_claimed_at = now()
    where id = v_connection.id
    returning * into v_connection;
  elsif v_connection.disconnect_claimed_at > now() - interval '1 minute' then
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (
        v_connection.disconnect_claimed_at + interval '1 minute' - now()
      )))::integer
    );
    return jsonb_build_object(
      'connectionId', v_connection.id,
      'inProgress', true,
      'retryAfterSeconds', v_retry_after_seconds,
      'alreadyDisconnected', false
    );
  else
    -- A request that died before completing its external call may be resumed
    -- after the lease. The durable claim id stays stable for idempotent audit.
    update public.quickbooks_connections
    set disconnect_claimed_by = p_actor_id,
        disconnect_claimed_at = now()
    where id = v_connection.id
    returning * into v_connection;
  end if;

  -- Any authorization URL issued before this disconnect is no longer allowed
  -- to reactivate the company after revocation.
  update public.quickbooks_oauth_states oauth_state
  set used_at = now()
  where oauth_state.environment = v_connection.environment
    and oauth_state.used_at is null;

  -- A retry resumes the existing claim. It never creates a second revocation
  -- operation for the same encrypted refresh token.
  return jsonb_build_object(
    'connectionId', v_connection.id,
    'environment', v_connection.environment,
    'realmId', v_connection.realm_id,
    'refreshTokenCiphertext', v_connection.refresh_token_ciphertext,
    'refreshTokenExpiresAt', v_connection.refresh_token_expires_at,
    'tokenKeyVersion', v_connection.token_key_version,
    'tokenKeyFingerprint', v_connection.token_key_fingerprint,
    'claimId', v_connection.disconnect_claim_id,
    'alreadyDisconnected', false
  );
end;
$$;

revoke all on function public.claim_quickbooks_connection_disconnect(
  uuid, uuid, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.claim_quickbooks_connection_disconnect(
  uuid, uuid, timestamptz, uuid
) to service_role;

drop function if exists public.finalize_quickbooks_connection_disconnect(
  uuid, uuid, uuid
);

create or replace function public.finalize_quickbooks_connection_disconnect(
  p_connection_id uuid,
  p_actor_id uuid,
  p_claim_id uuid,
  p_revocation_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.quickbooks_connections%rowtype;
  v_environment text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QuickBooks connections are server-managed'
      using errcode = '42501';
  end if;

  if coalesce(p_revocation_outcome, '') not in (
    'confirmed',
    'already_inactive',
    'expired'
  ) then
    raise exception 'QuickBooks revocation outcome is invalid'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
     and permission_grant.permission = 'quickbooks_handoff'
    where profile.id = p_actor_id
      and profile.active
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active QuickBooks handoff owner required'
      using errcode = '42501';
  end if;

  select connection_row.environment
  into v_environment
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id;

  if not found then
    raise exception 'QuickBooks connection not found'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quickbooks:' || v_environment, 0)
  );

  if exists (
    select 1
    from public.quickbooks_connection_events event_row
    where event_row.connection_id = p_connection_id
      and event_row.disconnect_claim_id = p_claim_id
      and event_row.event_type = 'disconnected'
  ) then
    return jsonb_build_object(
      'connectionId', p_connection_id,
      'eventType', 'disconnected',
      'idempotent', true
    );
  end if;

  select connection_row.*
  into v_connection
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id
  for update;

  if v_connection.status <> 'disconnecting'
     or v_connection.disconnect_claim_id is distinct from p_claim_id then
    raise exception 'QuickBooks disconnect claim is no longer current'
      using errcode = 'PT409';
  end if;

  update public.quickbooks_connections
  set status = 'disconnected',
      access_token_ciphertext = null,
      refresh_token_ciphertext = null,
      access_token_expires_at = null,
      refresh_token_expires_at = null,
      disconnected_by = p_actor_id,
      disconnected_at = now()
  where id = v_connection.id;

  insert into public.quickbooks_connection_events (
    connection_id,
    actor_id,
    event_type,
    environment,
    realm_id,
    disconnect_claim_id,
    details
  ) values (
    v_connection.id,
    p_actor_id,
    'disconnected',
    v_connection.environment,
    v_connection.realm_id,
    p_claim_id,
    jsonb_build_object(
      'companyName', v_connection.company_name,
      'revocationOutcome', p_revocation_outcome
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'eventType', 'disconnected',
    'idempotent', false
  );
end;
$$;

revoke all on function public.finalize_quickbooks_connection_disconnect(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.finalize_quickbooks_connection_disconnect(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.release_quickbooks_connection_disconnect(
  p_connection_id uuid,
  p_actor_id uuid,
  p_claim_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.quickbooks_connections%rowtype;
  v_environment text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'QuickBooks connections are server-managed'
      using errcode = '42501';
  end if;

  if not coalesce(p_reason_code ~ '^[a-z0-9_]{1,64}$', false) then
    raise exception 'QuickBooks disconnect release reason is invalid'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
     and permission_grant.permission = 'quickbooks_handoff'
    where profile.id = p_actor_id
      and profile.active
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active QuickBooks handoff owner required'
      using errcode = '42501';
  end if;

  select connection_row.environment
  into v_environment
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id;

  if not found then
    raise exception 'QuickBooks connection not found'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quickbooks:' || v_environment, 0)
  );

  if exists (
    select 1
    from public.quickbooks_connection_events event_row
    where event_row.connection_id = p_connection_id
      and event_row.disconnect_claim_id = p_claim_id
      and event_row.event_type = 'disconnect_failed'
  ) then
    return jsonb_build_object(
      'connectionId', p_connection_id,
      'eventType', 'disconnect_failed',
      'idempotent', true
    );
  end if;

  select connection_row.*
  into v_connection
  from public.quickbooks_connections connection_row
  where connection_row.id = p_connection_id
  for update;

  if v_connection.status <> 'disconnecting'
     or v_connection.disconnect_claim_id is distinct from p_claim_id then
    raise exception 'QuickBooks disconnect claim is no longer current'
      using errcode = 'PT409';
  end if;

  update public.quickbooks_connections
  set status = 'active',
      disconnect_claim_id = null,
      disconnect_claimed_by = null,
      disconnect_claimed_at = null
  where id = v_connection.id;

  insert into public.quickbooks_connection_events (
    connection_id,
    actor_id,
    event_type,
    environment,
    realm_id,
    disconnect_claim_id,
    details
  ) values (
    v_connection.id,
    p_actor_id,
    'disconnect_failed',
    v_connection.environment,
    v_connection.realm_id,
    p_claim_id,
    jsonb_build_object(
      'companyName', v_connection.company_name,
      'reasonCode', p_reason_code
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'eventType', 'disconnect_failed',
    'idempotent', false
  );
end;
$$;

revoke all on function public.release_quickbooks_connection_disconnect(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.release_quickbooks_connection_disconnect(
  uuid, uuid, uuid, text
) to service_role;

-- The original single-step function is intentionally removed. Revocation now
-- requires a database claim before the external Intuit request.
drop function if exists public.disconnect_quickbooks_connection(
  uuid, uuid, timestamptz
);

commit;
