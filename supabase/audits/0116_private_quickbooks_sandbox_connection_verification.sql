-- Run after 0116_private_quickbooks_sandbox_connection.sql.
-- Every boolean must be true, every issue count must be zero, and
-- all_checks_pass must be true before enabling the QuickBooks connector.

with table_checks as (
  select
    to_regclass('public.quickbooks_oauth_states') is not null
      as oauth_state_table_present,
    to_regclass('public.quickbooks_connections') is not null
      as connection_table_present,
    to_regclass('public.quickbooks_connection_events') is not null
      as connection_event_table_present,
    coalesce((
      select bool_and(relation_row.relrowsecurity)
      from pg_class relation_row
      where relation_row.oid in (
        'public.qbo_tokens'::regclass,
        'public.quickbooks_oauth_states'::regclass,
        'public.quickbooks_connections'::regclass,
        'public.quickbooks_connection_events'::regclass
      )
    ), false) as credential_table_rls_enabled,
    not exists (
      select 1
      from pg_policies policy_row
      where policy_row.schemaname = 'public'
        and policy_row.tablename in (
          'qbo_tokens',
          'quickbooks_oauth_states',
          'quickbooks_connections',
          'quickbooks_connection_events'
        )
    ) as credential_tables_have_no_client_policies
), privilege_checks as (
  select
    not coalesce(has_table_privilege('anon', 'public.qbo_tokens', 'SELECT'), false)
      and not coalesce(has_table_privilege('anon', 'public.qbo_tokens', 'INSERT'), false)
      and not coalesce(has_table_privilege('anon', 'public.qbo_tokens', 'UPDATE'), false)
      and not coalesce(has_table_privilege('anon', 'public.qbo_tokens', 'DELETE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.qbo_tokens', 'SELECT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.qbo_tokens', 'INSERT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.qbo_tokens', 'UPDATE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.qbo_tokens', 'DELETE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_oauth_states', 'SELECT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_oauth_states', 'INSERT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_oauth_states', 'UPDATE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_oauth_states', 'DELETE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_oauth_states', 'SELECT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_oauth_states', 'INSERT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_oauth_states', 'UPDATE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_oauth_states', 'DELETE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connections', 'SELECT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connections', 'INSERT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connections', 'UPDATE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connections', 'DELETE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connections', 'SELECT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connections', 'INSERT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connections', 'UPDATE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connections', 'DELETE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connection_events', 'SELECT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connection_events', 'INSERT'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connection_events', 'UPDATE'), false)
      and not coalesce(has_table_privilege('anon', 'public.quickbooks_connection_events', 'DELETE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connection_events', 'SELECT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connection_events', 'INSERT'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connection_events', 'UPDATE'), false)
      and not coalesce(has_table_privilege('authenticated', 'public.quickbooks_connection_events', 'DELETE'), false)
      as browser_roles_blocked,
    coalesce(has_table_privilege('service_role', 'public.quickbooks_oauth_states', 'SELECT'), false)
      and coalesce(has_table_privilege('service_role', 'public.quickbooks_oauth_states', 'UPDATE'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_oauth_states', 'INSERT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_oauth_states', 'DELETE'), false)
      as oauth_state_service_surface_minimized,
    coalesce(has_table_privilege('service_role', 'public.qbo_tokens', 'SELECT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.qbo_tokens', 'INSERT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.qbo_tokens', 'UPDATE'), false)
      and not coalesce(has_table_privilege('service_role', 'public.qbo_tokens', 'DELETE'), false)
      and coalesce(has_table_privilege('service_role', 'public.quickbooks_connections', 'SELECT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connections', 'INSERT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connections', 'UPDATE'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connections', 'DELETE'), false)
      and coalesce(has_table_privilege('service_role', 'public.quickbooks_connection_events', 'SELECT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connection_events', 'INSERT'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connection_events', 'UPDATE'), false)
      and not coalesce(has_table_privilege('service_role', 'public.quickbooks_connection_events', 'DELETE'), false)
      as service_role_write_surface_minimized
), constraint_checks as (
  select
    coalesce((
      select
        constraint_row.contype = 'c'
          and constraint_row.convalidated
          and pg_get_constraintdef(constraint_row.oid)
            ilike '%expires_at > created_at%'
          and pg_get_constraintdef(constraint_row.oid)
            ilike '%expires_at <= (created_at +%'
          and (
            pg_get_constraintdef(constraint_row.oid) ilike '%00:15:00%'
            or pg_get_constraintdef(constraint_row.oid) ilike '%15 minutes%'
          )
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.quickbooks_oauth_states'::regclass
        and constraint_row.conname = 'quickbooks_oauth_state_lifetime_check'
    ), false) as oauth_state_lifetime_constrained,
    coalesce((
      select
        position('used_at' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.quickbooks_oauth_states'::regclass
        and constraint_row.conname = 'quickbooks_oauth_state_use_shape_check'
    ), false) as oauth_state_use_shape_constrained,
    coalesce((
      select
        position('disconnecting' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
          and position('disconnect_claim_id' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
          and position('refresh_token_ciphertext' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.quickbooks_connections'::regclass
        and constraint_row.conname = 'quickbooks_connection_token_state_check'
    ), false) as connection_lifecycle_constrained,
    coalesce((
      select
        position('authorization_attempt_hash' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
          and position('disconnect_claim_id' in lower(pg_get_constraintdef(constraint_row.oid))) > 0
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.quickbooks_connection_events'::regclass
        and constraint_row.conname = 'quickbooks_connection_event_operation_shape_check'
    ), false) as event_operation_shape_constrained,
    exists (
      select 1
      from pg_indexes index_row
      where index_row.schemaname = 'public'
        and index_row.indexname = 'quickbooks_one_active_realm_per_environment'
        and index_row.indexdef ilike '%unique%'
        and index_row.indexdef ilike '%active%'
        and index_row.indexdef ilike '%disconnecting%'
    ) as one_live_realm_per_environment,
    exists (
      select 1
      from pg_indexes index_row
      where index_row.schemaname = 'public'
        and index_row.indexname = 'quickbooks_connection_events_authorization_attempt_key'
        and index_row.indexdef ilike '%unique%'
    ) as authorization_attempt_unique,
    exists (
      select 1
      from pg_indexes index_row
      where index_row.schemaname = 'public'
        and index_row.indexname = 'quickbooks_connection_events_disconnect_claim_key'
        and index_row.indexdef ilike '%unique%'
    ) as disconnect_claim_unique,
    exists (
      select 1
      from pg_indexes index_row
      where index_row.schemaname = 'public'
        and index_row.indexname = 'quickbooks_connection_events_disconnect_watermark_idx'
        and index_row.indexdef ilike '%environment%'
        and index_row.indexdef ilike '%created_at%'
        and index_row.indexdef ilike '%disconnected%'
    ) as disconnect_watermark_indexed,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.quickbooks_connections'::regclass
        and trigger_row.tgname = 'touch_quickbooks_connections'
        and trigger_row.tgfoid = 'public.touch_updated_at()'::regprocedure
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as connection_update_trigger_enabled
), required_functions(function_name, function_oid) as (
  values
    (
      'begin',
      to_regprocedure(
        'public.begin_quickbooks_oauth_authorization(uuid,text,text,text)'
      )
    ),
    (
      'save',
      to_regprocedure(
        'public.save_quickbooks_connection(uuid,text,text,text,text,text,text,timestamptz,timestamptz,integer,text,text,timestamptz)'
      )
    ),
    (
      'claim',
      to_regprocedure(
        'public.claim_quickbooks_connection_disconnect(uuid,uuid,timestamptz,uuid)'
      )
    ),
    (
      'finalize',
      to_regprocedure(
        'public.finalize_quickbooks_connection_disconnect(uuid,uuid,uuid,text)'
      )
    ),
    (
      'release',
      to_regprocedure(
        'public.release_quickbooks_connection_disconnect(uuid,uuid,uuid,text)'
      )
    )
), function_inventory as (
  select
    required.function_name,
    required.function_oid,
    function_row.prosecdef,
    function_row.proconfig,
    owner_row.rolname as owner_name,
    lower(coalesce(pg_get_functiondef(required.function_oid), '')) as definition
  from required_functions required
  left join pg_proc function_row on function_row.oid = required.function_oid
  left join pg_roles owner_row on owner_row.oid = function_row.proowner
), function_checks as (
  select
    count(*) filter (where function_oid is not null) = 5
      as all_connection_functions_present,
    coalesce(bool_and(
      prosecdef
      and coalesce('search_path=public, pg_temp' = any(proconfig), false)
      and owner_name not in ('anon', 'authenticated', 'service_role', 'authenticator')
    ), false) as all_connection_functions_guarded,
    coalesce(bool_and(
      not coalesce(has_function_privilege('anon', function_oid, 'EXECUTE'), false)
      and not coalesce(has_function_privilege('authenticated', function_oid, 'EXECUTE'), false)
      and coalesce(has_function_privilege('service_role', function_oid, 'EXECUTE'), false)
    ), false) as function_execute_surface_minimized,
    coalesce(bool_and(
      position('auth.role()' in definition) > 0
      and position('quickbooks_handoff' in definition) > 0
      and position('profile.active' in definition) > 0
      and position('manager' in definition) > 0
      and position('dispatcher' in definition) > 0
      and position('back_office' in definition) > 0
    ), false) as accounting_owner_revalidated_everywhere,
    coalesce(bool_and(
      position('pg_advisory_xact_lock' in definition) > 0
    ), false) as connection_transitions_serialized,
    coalesce((
      select
        position('status in (''active'', ''disconnecting'')' in inventory.definition) > 0
          and position('update public.quickbooks_oauth_states' in inventory.definition) > 0
      from function_inventory inventory
      where inventory.function_name = 'begin'
    ), false) as oauth_start_serialized_and_live_blocked,
    coalesce((
      select
        position('authorization_attempt_hash' in inventory.definition) > 0
          and position('newer quickbooks authorization' in inventory.definition) > 0
          and position('disconnecting' in inventory.definition) > 0
          and position('predates the completed disconnect' in inventory.definition) > 0
          and position('predates the environment disconnect' in inventory.definition) > 0
          and position('last_authorization_attempt_hash' in inventory.definition) > 0
      from function_inventory inventory
      where inventory.function_name = 'save'
    ), false) as authorization_save_idempotent_and_ordered,
    coalesce((
      select
        position('status = ''disconnecting''' in inventory.definition) > 0
          and position('refreshtokenciphertext' in inventory.definition) > 0
          and position('retryafterseconds' in inventory.definition) > 0
          and position('update public.quickbooks_oauth_states' in inventory.definition) > 0
      from function_inventory inventory
      where inventory.function_name = 'claim'
    ), false) as disconnect_claim_leased_and_returns_locked_credential,
    coalesce((
      select
        position('revocationoutcome' in inventory.definition) > 0
          and position('already_inactive' in inventory.definition) > 0
          and position('expired' in inventory.definition) > 0
      from function_inventory inventory
      where inventory.function_name = 'finalize'
    ), false) as disconnect_outcome_is_audited,
    to_regprocedure(
      'public.disconnect_quickbooks_connection(uuid,uuid,timestamptz)'
    ) is null
      and to_regprocedure(
        'public.finalize_quickbooks_connection_disconnect(uuid,uuid,uuid)'
      ) is null as unsafe_legacy_disconnect_functions_removed
  from function_inventory
), data_checks as (
  select
    (select count(*) from public.qbo_tokens) as legacy_plaintext_token_count,
    (
      select count(*)
      from public.quickbooks_oauth_states oauth_state
      where oauth_state.expires_at <= oauth_state.created_at
        or oauth_state.expires_at > oauth_state.created_at + interval '15 minutes'
        or (oauth_state.used_realm_id is not null and oauth_state.used_at is null)
    ) as invalid_oauth_state_count,
    (
      select count(*)
      from public.quickbooks_connections connection_row
      where connection_row.token_key_fingerprint !~ '^[0-9a-f]{64}$'
        or connection_row.last_authorization_attempt_hash !~ '^[0-9a-f]{64}$'
        or (
          connection_row.status = 'active'
          and (
            connection_row.disconnected_at is not null
            or connection_row.disconnected_by is not null
            or connection_row.disconnect_claim_id is not null
            or connection_row.access_token_ciphertext is null
            or connection_row.refresh_token_ciphertext is null
          )
        )
        or (
          connection_row.status = 'disconnecting'
          and (
            connection_row.disconnected_at is not null
            or connection_row.disconnect_claim_id is null
            or connection_row.disconnect_claimed_by is null
            or connection_row.disconnect_claimed_at is null
            or connection_row.refresh_token_ciphertext is null
          )
        )
        or (
          connection_row.status = 'disconnected'
          and (
            connection_row.disconnected_at is null
            or connection_row.disconnected_by is null
            or connection_row.access_token_ciphertext is not null
            or connection_row.refresh_token_ciphertext is not null
          )
        )
    ) as invalid_connection_lifecycle_count,
    (
      select count(*)
      from (
        select connection_row.environment
        from public.quickbooks_connections connection_row
        where connection_row.status in ('active', 'disconnecting')
        group by connection_row.environment
        having count(*) > 1
      ) duplicate_environment
    ) as duplicate_live_environment_count,
    (
      select count(*)
      from public.quickbooks_connection_events event_row
      where event_row.details::text
        ~* '"(access|refresh)[_a-z-]*token"[[:space:]]*:'
    ) as audit_event_secret_key_count,
    (
      select count(*)
      from public.quickbooks_connection_events event_row
      where (
        event_row.event_type in ('connected', 'reconnected')
        and (
          event_row.authorization_attempt_hash is null
          or event_row.disconnect_claim_id is not null
        )
      ) or (
        event_row.event_type in ('disconnected', 'disconnect_failed')
        and (
          event_row.authorization_attempt_hash is not null
          or event_row.disconnect_claim_id is null
        )
      )
    ) as invalid_event_operation_count,
    (
      select count(*)
      from public.quickbooks_connections connection_row
      where connection_row.status = 'disconnecting'
    ) as unresolved_disconnect_claim_count,
    (
      select count(*)
      from public.quickbooks_oauth_states oauth_state
      where oauth_state.used_at is null
        and exists (
          select 1
          from public.quickbooks_connections connection_row
          where connection_row.environment = oauth_state.environment
            and connection_row.status in ('active', 'disconnecting')
        )
    ) as usable_oauth_state_during_live_connection_count,
    (
      select count(*)
      from public.quickbooks_connection_events authorization_event
      join public.quickbooks_oauth_states oauth_state
        on oauth_state.state_hash = authorization_event.authorization_attempt_hash
      where authorization_event.event_type in ('connected', 'reconnected')
        and exists (
          select 1
          from public.quickbooks_connection_events disconnect_event
          where disconnect_event.environment = authorization_event.environment
            and disconnect_event.event_type = 'disconnected'
            and disconnect_event.created_at >= oauth_state.created_at
            and disconnect_event.created_at < authorization_event.created_at
        )
    ) as pre_disconnect_authorization_reactivation_count,
    (
      select count(*)
      from public.quickbooks_connections connection_row
      where connection_row.environment = 'production'
    ) as production_connection_count
)
select
  table_checks.*,
  privilege_checks.*,
  constraint_checks.*,
  function_checks.*,
  data_checks.*,
  (
    table_checks.oauth_state_table_present
    and table_checks.connection_table_present
    and table_checks.connection_event_table_present
    and table_checks.credential_table_rls_enabled
    and table_checks.credential_tables_have_no_client_policies
    and privilege_checks.browser_roles_blocked
    and privilege_checks.oauth_state_service_surface_minimized
    and privilege_checks.service_role_write_surface_minimized
    and constraint_checks.oauth_state_lifetime_constrained
    and constraint_checks.oauth_state_use_shape_constrained
    and constraint_checks.connection_lifecycle_constrained
    and constraint_checks.event_operation_shape_constrained
    and constraint_checks.one_live_realm_per_environment
    and constraint_checks.authorization_attempt_unique
    and constraint_checks.disconnect_claim_unique
    and constraint_checks.disconnect_watermark_indexed
    and constraint_checks.connection_update_trigger_enabled
    and function_checks.all_connection_functions_present
    and function_checks.all_connection_functions_guarded
    and function_checks.function_execute_surface_minimized
    and function_checks.accounting_owner_revalidated_everywhere
    and function_checks.connection_transitions_serialized
    and function_checks.oauth_start_serialized_and_live_blocked
    and function_checks.authorization_save_idempotent_and_ordered
    and function_checks.disconnect_claim_leased_and_returns_locked_credential
    and function_checks.disconnect_outcome_is_audited
    and function_checks.unsafe_legacy_disconnect_functions_removed
    and data_checks.legacy_plaintext_token_count = 0
    and data_checks.invalid_oauth_state_count = 0
    and data_checks.invalid_connection_lifecycle_count = 0
    and data_checks.duplicate_live_environment_count = 0
    and data_checks.audit_event_secret_key_count = 0
    and data_checks.invalid_event_operation_count = 0
    and data_checks.unresolved_disconnect_claim_count = 0
    and data_checks.usable_oauth_state_during_live_connection_count = 0
    and data_checks.pre_disconnect_authorization_reactivation_count = 0
    and data_checks.production_connection_count = 0
  ) as all_checks_pass
from table_checks
cross join privilege_checks
cross join constraint_checks
cross join function_checks
cross join data_checks;
