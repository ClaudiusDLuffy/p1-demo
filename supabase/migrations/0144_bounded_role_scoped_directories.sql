-- Additive, read-only directory projections. No existing policy, assignment
-- validator, profile, grant, technician, or work-order data is changed.
begin;

create function public.directory_normalize_v1(p_text text)
returns text language sql immutable parallel safe
set search_path = pg_catalog, public
as $$ select lower(btrim(regexp_replace(coalesce(p_text, ''),
  U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'))) $$;

-- Extreme legacy names use a bounded normalized 500-character prefix plus
-- UUID. Full stored text still participates in search and exact selection.
-- This prevents an otherwise valid row from producing an oversized cursor.
create function public.directory_sort_key_v1(p_text text)
returns text language sql immutable parallel safe
set search_path = pg_catalog, public
as $$ select btrim(left(public.directory_normalize_v1(p_text), 500)) $$;

-- Display-only limits count JavaScript UTF-16 units (astral characters use
-- two), not just PostgreSQL characters. Exact selections never use this.
create function public.directory_display_text_v1(p_text text, p_limit integer)
returns text language plpgsql immutable parallel safe
set search_path = pg_catalog, public
as $$
declare units integer; shortened text; maximum integer := least(greatest(p_limit, 2), 500);
begin
  if p_text is null or octet_length(p_text) <= maximum then return p_text; end if;
  with characters as (
    select character, ordinal,
      sum(case when ascii(character) > 65535 then 2 else 1 end) over(order by ordinal) as used
    from regexp_split_to_table(left(p_text, maximum), '') with ordinality chars(character, ordinal)
  ) select max(used)::integer, string_agg(character, '' order by ordinal) filter(where used < maximum)
    into units, shortened from characters;
  if char_length(p_text) <= maximum and coalesce(units, 0) <= maximum then return p_text; end if;
  return coalesce(shortened, '') || '…';
end $$;

create function public.directory_display_projection_v1(p_value jsonb)
returns jsonb language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select jsonb_object_agg(field.key, case
    when jsonb_typeof(field.value) = 'string' and field.key not in ('id', 'contractorId', 'profileId')
      then to_jsonb(public.directory_display_text_v1(field.value #>> '{}', 500))
    when field.key = 'trades' and jsonb_typeof(field.value) = 'array' then (
      select coalesce(jsonb_agg(case
        when ordinal = 50 and jsonb_array_length(field.value) > 50
          then to_jsonb(format('… %s more trades', jsonb_array_length(field.value) - 49))
        else to_jsonb(public.directory_display_text_v1(trade #>> '{}', 200)) end order by ordinal), '[]'::jsonb)
      from jsonb_array_elements(field.value) with ordinality trades(trade, ordinal) where ordinal <= 50
    ) else field.value end)
  from jsonb_each(p_value) field
$$;

-- Private authorization also supplies a current-state cursor fingerprint.
-- A cursor is a position, never authority; every request rechecks this gate.
create function public.directory_scope_v1(p_domain text, p_contractor_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  actor record;
  staff boolean;
  operational boolean;
  grants jsonb;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception 'Active authentication required' using errcode = '42501';
  end if;
  select p.id, p.role, p.contractor_organization_id, p.contractor_access_level, p.contractor_tier
    into actor from public.profiles p where p.id = auth.uid() and p.active = true;
  if not found then
    raise exception 'Active authentication required' using errcode = '42501';
  end if;
  staff := public.is_staff();
  operational := staff and not public.is_invoice_controller();
  if p_domain in ('assignable_contractors', 'staff_choices', 'contractor_directory', 'contacts') then
    if not operational then raise exception 'Operational staff access required' using errcode = '42501'; end if;
  elsif p_domain = 'contractor_filter' then
    if not staff then raise exception 'Staff access required' using errcode = '42501'; end if;
  elsif p_domain in ('company_technicians', 'technician_profile', 'technician_management', 'technician_detail') then
    if p_contractor_id is null then raise exception 'A company is required' using errcode = '22023'; end if;
    if p_domain in ('technician_management', 'technician_detail') then
      if not operational then raise exception 'Operational staff access required' using errcode = '42501'; end if;
    elsif not operational and not (
      actor.role = 'contractor'
      and public.can_manage_contractor_company()
      and public.current_contractor_account_id() = p_contractor_id
    ) then
      -- A member may resolve their own exact persisted technician identity,
      -- but may not enumerate the company's technician directory.
      if p_domain <> 'technician_profile' or actor.role <> 'contractor'
        or public.current_contractor_account_id() is distinct from p_contractor_id then
        raise exception 'Company access required' using errcode = '42501';
      end if;
    end if;
  elsif p_domain = 'legacy_team' then
    if actor.role <> 'contractor' or actor.contractor_tier is distinct from 'mr_freeze' then
      raise exception 'Legacy team access required' using errcode = '42501';
    end if;
  elsif p_domain not in ('profile_labels', 'contact_detail') or p_domain is null then
    raise exception 'Unknown directory domain' using errcode = '22023';
  end if;
  if p_domain not in ('company_technicians', 'technician_profile', 'technician_management', 'technician_detail')
    and p_contractor_id is not null then
    raise exception 'Unexpected company scope' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(g.permission order by g.permission), '[]'::jsonb)
    into grants from public.staff_permission_grants g where g.profile_id = actor.id;
  return md5(jsonb_build_array(actor.id, actor.role, actor.contractor_organization_id,
    actor.contractor_access_level, actor.contractor_tier,
    public.current_contractor_account_id(), grants, p_domain, p_contractor_id)::text);
end $$;

-- Bound the keyset INSIDE this pinned-path private function. A function scan
-- therefore materializes at most 51 minimal identities, not the directory.
create function public.directory_candidates_v1(
  p_domain text, p_contractor_id uuid, p_query text, p_id uuid default null,
  p_limit integer default 51, p_last_name text default null, p_last_id uuid default null,
  p_snapshot_at timestamptz default now()
)
returns table(id uuid, sort_name text, created_at timestamptz)
language sql stable
set search_path = pg_catalog, public
as $$
  with candidates as not materialized (
  select p.id, public.directory_sort_key_v1(p.name) as sort_name, p.created_at
  from public.profiles p
  where (p_id is null or p.id = p_id)
    and case p_domain
      when 'assignable_contractors' then p.role = 'contractor' and p.active = true
        and p.is_assignable = true and public.contractor_account_id_for_profile(p.id) = p.id
      when 'contractor_directory' then p.role = 'contractor' and p.is_assignable = true
      when 'contractor_filter' then p.role = 'contractor'
      when 'staff_choices' then p.active = true and p.role in ('manager', 'dispatcher', 'back_office')
      when 'contacts' then p.active = true and p.role in ('manager', 'dispatcher', 'back_office', 'contractor')
      when 'legacy_team' then p.role = 'contractor' and p.dispatcher_id = auth.uid()
      else false end
    and (p_query = '' or strpos(public.directory_normalize_v1(p.name), p_query) > 0
      or (p_domain in ('assignable_contractors', 'contractor_directory', 'contacts')
        and strpos(public.directory_normalize_v1(p.company), p_query) > 0)
      or (p_domain in ('assignable_contractors', 'contractor_directory') and (
        strpos(public.directory_normalize_v1(p.territory), p_query) > 0
        or exists (select 1 from unnest(p.trades) trade where strpos(public.directory_normalize_v1(trade), p_query) > 0)))
      or (p_domain = 'contacts' and (
        strpos(public.directory_normalize_v1(p.title), p_query) > 0
        or strpos(public.directory_normalize_v1(p.email), p_query) > 0
        or strpos(public.directory_normalize_v1(p.phone), p_query) > 0)))
  union all
  select t.id, public.directory_sort_key_v1(coalesce(p.name, t.name)), t.created_at
  from public.contractor_technicians t
  left join public.profiles owner on owner.id = t.contractor_id
  left join public.profiles p on p.id = t.profile_id and p.role = 'contractor'
    and (p.id = t.contractor_id or (owner.contractor_organization_id is not null
      and p.contractor_organization_id = owner.contractor_organization_id))
  where p_domain in ('company_technicians', 'technician_management')
    and t.contractor_id = p_contractor_id and (p_id is null or t.id = p_id)
    and (p_domain = 'technician_management' or (t.is_active = true and (
      t.profile_id is null or (p.active = true
        and p.contractor_access_level in ('invoice', 'report_only')
        and public.contractor_account_id_for_profile(p.id) = t.contractor_id))))
    and (p_query = '' or strpos(public.directory_normalize_v1(coalesce(p.name, t.name)), p_query) > 0)
  ), positioned as (
    select c.* from candidates c where p_last_id is null
      and (c.created_at is null or c.created_at <= p_snapshot_at)
    union all
    select c.* from candidates c where p_last_id is not null
      and (c.created_at is null or c.created_at <= p_snapshot_at)
      and (c.sort_name collate "C", c.id) > (p_last_name collate "C", p_last_id)
  )
  select c.* from positioned c order by c.sort_name collate "C", c.id
    limit least(greatest(p_limit, 1), 51)
$$;

-- Called only after authorization and a scoped candidate/exact identity check.
-- Workload aggregation is per returned card, never a whole-directory map.
create function public.directory_projection_v1(p_domain text, p_id uuid)
returns jsonb language sql stable
set search_path = pg_catalog, public
as $$
  select case
    when p_domain in ('staff_choices', 'contractor_filter', 'legacy_team')
      then jsonb_build_object('id', p.id, 'name', p.name)
    when p_domain = 'assignable_contractors'
      then jsonb_build_object('id', p.id, 'name', p.name, 'company', p.company, 'territory', p.territory)
    when p_domain in ('contacts', 'contact_detail') then
      jsonb_build_object('id', p.id, 'name', p.name, 'company', p.company,
        'title', p.title, 'initials', p.initials, 'color', p.color)
      || case when p_domain = 'contact_detail'
        then jsonb_build_object('email', p.email, 'phone', p.phone) else '{}'::jsonb end
    else jsonb_build_object('id', p.id, 'name', p.name, 'company', p.company,
      'initials', p.initials, 'color', p.color)
      || case when p_domain in ('assignable_contractors', 'contractor_directory')
        then jsonb_build_object('territory', p.territory, 'trades', coalesce(p.trades, '{}'::text[]))
        else '{}'::jsonb end
      || case when p_domain = 'contractor_directory' then jsonb_build_object(
        'activeCount', (select count(*) from public.work_orders w where w.contractor_id = p.id
          and w.deleted_at is null and w.status in ('unassigned', 'assigned', 'wip', 'parts')),
        'capitalCount', (select count(*) from public.work_orders w where w.contractor_id = p.id
          and w.deleted_at is null and w.status in ('capital', 'pending_capital_completion')),
        'teamActiveCount', (select count(*) from public.contractor_technicians t
          where t.contractor_id = p.id and t.is_active = true)) else '{}'::jsonb end
    end
  from public.profiles p where p.id = p_id
    and p_domain not in ('company_technicians', 'technician_management', 'technician_detail', 'technician_profile')
  union all
  select jsonb_build_object('id', t.id, 'contractorId', t.contractor_id,
    'profileId', t.profile_id, 'name', coalesce(p.name, t.name), 'isActive', t.is_active,
    'profileActive', p.active, 'contractorAccessLevel', p.contractor_access_level)
    || case when p_domain = 'technician_detail' then jsonb_build_object('email', p.email, 'phone', p.phone)
      else '{}'::jsonb end
  from public.contractor_technicians t
  left join public.profiles owner on owner.id = t.contractor_id
  left join public.profiles p on p.id = t.profile_id and p.role = 'contractor'
    and (p.id = t.contractor_id or (owner.contractor_organization_id is not null
      and p.contractor_organization_id = owner.contractor_organization_id))
  where t.id = p_id and p_domain in ('company_technicians', 'technician_management', 'technician_detail', 'technician_profile')
$$;

create function public.list_directory_page_v1(
  p_domain text, p_query text default '', p_contractor_id uuid default null,
  p_limit integer default 25, p_cursor text default null
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  query_text text;
  scope text;
  cursor_value jsonb;
  last_name text;
  last_id uuid;
  snapshot_at timestamptz := now();
  page_rows jsonb;
  items jsonb;
  tail jsonb;
  has_more boolean;
begin
  scope := public.directory_scope_v1(p_domain, p_contractor_id);
  if p_domain not in ('assignable_contractors', 'staff_choices', 'contractor_directory', 'contractor_filter',
    'contacts', 'company_technicians', 'technician_management', 'legacy_team') then
    raise exception 'This domain requires exact selection' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 or p_query is null
    or char_length(p_query) > 200
    or p_query ~ '[[:cntrl:]]' then
    raise exception 'Invalid directory page request' using errcode = '22023';
  end if;
  query_text := public.directory_normalize_v1(p_query);
  if char_length(query_text) > 200 then raise exception 'Invalid directory page request' using errcode = '22023'; end if;
  scope := md5(jsonb_build_array(scope, query_text, p_limit, 'normalized_name_prefix500_asc_id_asc_v1')::text);
  if p_cursor is not null then
    begin
      if length(p_cursor) not between 1 and 8192 or p_cursor !~ '^[A-Za-z0-9_-]+$' then
        raise exception 'Invalid cursor';
      end if;
      cursor_value := public.portal_decode_cursor(p_cursor);
      if jsonb_typeof(cursor_value) is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(cursor_value) k)
          is distinct from array['id', 'name', 'scope', 'snapshotAt', 'version']::text[]
        or cursor_value -> 'version' is distinct from '1'::jsonb
        or cursor_value -> 'scope' is distinct from to_jsonb(scope)
        or jsonb_typeof(cursor_value -> 'name') is distinct from 'string'
        or jsonb_typeof(cursor_value -> 'id') is distinct from 'string'
        or jsonb_typeof(cursor_value -> 'snapshotAt') is distinct from 'string'
        or public.portal_encode_cursor(cursor_value) is distinct from p_cursor then
        raise exception 'Invalid cursor';
      end if;
      last_name := cursor_value ->> 'name';
      last_id := (cursor_value ->> 'id')::uuid;
      snapshot_at := (cursor_value ->> 'snapshotAt')::timestamptz;
      if last_name is distinct from public.directory_normalize_v1(last_name)
        or char_length(last_name) > 500
        or last_id::text is distinct from cursor_value ->> 'id'
        or cursor_value ->> 'snapshotAt' is distinct from to_char(snapshot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        or not isfinite(snapshot_at) or snapshot_at > now() then raise exception 'Invalid cursor'; end if;
    exception when others then
      raise exception 'Directory cursor is invalid or no longer matches this request' using errcode = 'PDC01';
    end;
  end if;
  select coalesce(jsonb_agg(to_jsonb(candidate) order by candidate.sort_name collate "C", candidate.id), '[]'::jsonb)
  into page_rows from (
    select c.id, c.sort_name from public.directory_candidates_v1(p_domain, p_contractor_id, query_text,
      null, p_limit + 1, last_name, last_id, snapshot_at) c
    order by c.sort_name collate "C", c.id limit p_limit + 1
  ) candidate;
  has_more := jsonb_array_length(page_rows) > p_limit;
  select coalesce(jsonb_agg(public.directory_display_projection_v1(
      public.directory_projection_v1(p_domain, (row_value ->> 'id')::uuid)) order by ordinal), '[]'::jsonb)
    into items from jsonb_array_elements(page_rows) with ordinality rows(row_value, ordinal)
    where ordinal <= p_limit;
  tail := page_rows -> (least(p_limit, jsonb_array_length(page_rows)) - 1);
  return jsonb_build_object('items', items, 'pageSize', p_limit, 'hasMore', has_more,
    'nextCursor', case when has_more then public.portal_encode_cursor(jsonb_build_object(
      'version', 1, 'scope', scope, 'name', tail ->> 'sort_name', 'id', tail ->> 'id',
      'snapshotAt', to_char(snapshot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) else null end);
end $$;

create function public.get_directory_selection_v1(p_domain text, p_id uuid, p_contractor_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare selected_id uuid;
begin
  perform public.directory_scope_v1(p_domain, p_contractor_id);
  if p_id is null then raise exception 'An exact identity is required' using errcode = '22023'; end if;
  if p_domain in ('profile_labels', 'contact_detail') then
    if public.can_read_contractor_profile(p_id) then selected_id := p_id; end if;
  elsif p_domain = 'technician_detail' then
    select t.id into selected_id from public.contractor_technicians t
      where t.id = p_id and t.contractor_id = p_contractor_id;
  elsif p_domain = 'technician_profile' then
    select t.id into selected_id from public.contractor_technicians t
      join public.profiles p on p.id = t.profile_id
      where t.profile_id = p_id and t.contractor_id = p_contractor_id
        and t.is_active = true and p.active = true and p.role = 'contractor'
        and p.contractor_access_level in ('invoice', 'report_only')
        and public.contractor_account_id_for_profile(p.id) = t.contractor_id
        and ((public.is_staff() and not public.is_invoice_controller())
          or public.can_manage_contractor_company() or p_id = auth.uid());
  else
    -- Exact selection is current eligibility, independent of a list snapshot.
    select c.id into selected_id from public.directory_candidates_v1(
      p_domain, p_contractor_id, '', p_id, 1, null, null, 'infinity'::timestamptz) c;
  end if;
  return public.directory_projection_v1(p_domain, selected_id);
end $$;

create function public.get_directory_profile_labels_v1(p_ids uuid[])
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.directory_scope_v1('profile_labels', null);
  if p_ids is null or cardinality(p_ids) > 100 or array_ndims(p_ids) > 1
    or array_position(p_ids, null) is not null then
    raise exception 'At most 100 exact profile identities are allowed' using errcode = '22023';
  end if;
  return (select coalesce(jsonb_agg(public.directory_display_projection_v1(
      public.directory_projection_v1('profile_labels', p.id)) order by p.id), '[]'::jsonb)
    from public.profiles p where p.id = any(p_ids) and public.can_read_contractor_profile(p.id));
end $$;

-- Keeps the existing city/trade scoring (case-sensitive trade membership;
-- duplicate profile trades count, duplicate requested trades do not). The
-- caller retains the existing TX/FL exclusion. Only one eligible option leaves
-- the database; assignment commands still revalidate the canonical target.
create function public.get_directory_auto_assignment_candidate_v1(p_city text, p_trade_tags text[])
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare selected_id uuid;
  city_text text;
begin
  perform public.directory_scope_v1('assignable_contractors', null);
  if p_city is null or char_length(p_city) > 200 or p_trade_tags is null
    or p_city ~ '[[:cntrl:]]'
    or cardinality(p_trade_tags) > 100 or array_ndims(p_trade_tags) > 1
    or array_position(p_trade_tags, null) is not null
    or exists (select 1 from unnest(p_trade_tags) tag where char_length(tag) > 200 or tag ~ '[[:cntrl:]]') then
    raise exception 'Invalid assignment search' using errcode = '22023';
  end if;
  city_text := lower(btrim(split_part(p_city, ',', 1)));
  select p.id into selected_id from public.profiles p
    cross join lateral (select count(*) matches from unnest(p.trades) trade where trade = any(p_trade_tags)) score
    where p.role = 'contractor' and p.active = true and p.is_assignable = true
      and public.contractor_account_id_for_profile(p.id) = p.id
      and (lower(btrim(split_part(p.territory, ',', 1))) = city_text or strpos(lower(p.territory), city_text) > 0)
      and score.matches > 0
    order by score.matches desc, p.name, p.id limit 1;
  return public.directory_projection_v1('assignable_contractors', selected_id);
end $$;

revoke all on function public.directory_normalize_v1(text), public.directory_sort_key_v1(text),
  public.directory_display_text_v1(text,integer), public.directory_display_projection_v1(jsonb),
  public.directory_scope_v1(text,uuid), public.directory_candidates_v1(text,uuid,text,uuid,integer,text,uuid,timestamptz),
  public.directory_projection_v1(text,uuid), public.list_directory_page_v1(text,text,uuid,integer,text),
  public.get_directory_selection_v1(text,uuid,uuid), public.get_directory_profile_labels_v1(uuid[]),
  public.get_directory_auto_assignment_candidate_v1(text,text[])
  from public, anon, authenticated, service_role;
grant execute on function public.list_directory_page_v1(text,text,uuid,integer,text),
  public.get_directory_selection_v1(text,uuid,uuid), public.get_directory_profile_labels_v1(uuid[]),
  public.get_directory_auto_assignment_candidate_v1(text,text[]) to authenticated;

commit;
