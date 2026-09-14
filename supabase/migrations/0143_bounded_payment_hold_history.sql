-- Additive read-only replacement for the payment-hold route's first-100 read.
-- This lists CURRENT holds, not immutable hold-event history. A natural keyset
-- is a position in the live list: release removes a row, re-hold/new holds move
-- above the cursor, and Refresh newest starts a new traversal. No total count.
begin;

create function public.list_contractor_invoice_payment_holds_page_v1(
  p_limit integer default 100,
  p_cursor text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_permissions jsonb;
  v_scope text;
  v_cursor jsonb;
  v_at timestamptz;
  v_id uuid;
  v_holds jsonb;
  v_more boolean;
  v_next text;
begin
  -- Do not use the financial MUTATION actor helper here: its row locks would
  -- make this stable read fail inside a READ ONLY transaction. Authorization
  -- and grants are reread at this statement's database snapshot on every page.
  if auth.role() is distinct from 'authenticated' or v_actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT401';
  end if;
  select p.role::text into v_role from public.profiles p
    where p.id = v_actor and p.active = true
      and p.role in ('manager', 'dispatcher', 'back_office');
  if not found then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(g.permission order by g.permission), '[]'::jsonb)
    into v_permissions from public.staff_permission_grants g where g.profile_id = v_actor;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;

  -- A fingerprint binds endpoint/version, current actor/role/grants, visibility,
  -- page size and ordering. It is NOT a signature or an authorization token.
  -- Tampering with a position cannot widen the independently authorized query.
  v_scope := md5(jsonb_build_array('payment-holds-v1', v_actor, v_role,
    v_permissions, 'contractor-invoices:not-deleted:all-current-holds',
    p_limit, 'placed_at:desc,invoice_id:desc')::text);
  if p_cursor is not null then
    begin
      if length(p_cursor) not between 1 and 4096 or p_cursor !~ '^[A-Za-z0-9_-]+$' then
        raise exception 'INVALID_CURSOR';
      end if;
      v_cursor := public.portal_decode_cursor(p_cursor);
      if jsonb_typeof(v_cursor) is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(v_cursor) k)
          is distinct from array['invoiceId', 'placedAt', 'scope', 'version']::text[]
        or jsonb_typeof(v_cursor->'version') is distinct from 'number'
        or v_cursor->'version' is distinct from '1'::jsonb
        or jsonb_typeof(v_cursor->'scope') is distinct from 'string'
        or v_cursor->>'scope' is distinct from v_scope
        or jsonb_typeof(v_cursor->'placedAt') is distinct from 'string'
        or v_cursor->>'placedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?([+-][0-9]{2}:[0-9]{2}|Z)$'
        or jsonb_typeof(v_cursor->'invoiceId') is distinct from 'string'
        or v_cursor->>'invoiceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or public.portal_encode_cursor(v_cursor) is distinct from p_cursor then
        raise exception 'INVALID_CURSOR';
      end if;
      -- Keep PostgreSQL microseconds: no JavaScript Date conversion of cursors.
      v_at := (v_cursor->>'placedAt')::timestamptz;
      v_id := (v_cursor->>'invoiceId')::uuid;
      if not isfinite(v_at) then raise exception 'INVALID_CURSOR'; end if;
    exception when others then
      raise exception 'INVALID_CURSOR' using errcode = 'PDC01';
    end;
  end if;

  -- Separate first/continuation branches retain an indexable tuple seek even
  -- with a generic PL/pgSQL plan. Each inactive branch is a one-time false
  -- filter. Reuse contractor_invoice_payment_holds_placed from migration 0100.
  -- Invoice eligibility is applied BEFORE limit+1; enrichment after page limit.
  with candidates as materialized (
    (select h.invoice_id, h.placed_at, h.placed_by, h.reason,
        i.num, i.work_order_id, i.contractor_id, i.total
      from public.contractor_invoice_payment_holds h
      join public.invoices i on i.id = h.invoice_id
      where v_at is null and i.invoice_type = 'contractor' and i.deleted_at is null
      order by h.placed_at desc, h.invoice_id desc limit p_limit + 1)
    union all
    (select h.invoice_id, h.placed_at, h.placed_by, h.reason,
        i.num, i.work_order_id, i.contractor_id, i.total
      from public.contractor_invoice_payment_holds h
      join public.invoices i on i.id = h.invoice_id
      where v_at is not null and i.invoice_type = 'contractor' and i.deleted_at is null
        and (h.placed_at, h.invoice_id) < (v_at, v_id)
      order by h.placed_at desc, h.invoice_id desc limit p_limit + 1)
  ), page as materialized (
    select * from candidates order by placed_at desc, invoice_id desc limit p_limit
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
      'invoiceId', p.invoice_id, 'invoiceNumber', p.num,
      'workOrderId', p.work_order_id,
      'externalWorkOrderId', coalesce(nullif(w.duplicate_root_work_order_id, ''), nullif(w.id, ''), p.work_order_id),
      'contractorName', case when char_length(labels.contractor_name) > 500
        then left(labels.contractor_name, 499) || '…' else labels.contractor_name end,
      'total', coalesce(p.total, 0), 'holdAt', p.placed_at, 'holdBy', p.placed_by,
      'holdByName', case when char_length(labels.actor_name) > 500
        then left(labels.actor_name, 499) || '…' else labels.actor_name end, 'reason', coalesce(p.reason, '')
    ) order by p.placed_at desc, p.invoice_id desc)
    from page p left join public.work_orders w on w.id = p.work_order_id
      left join public.profiles c on c.id = p.contractor_id
      left join public.profiles a on a.id = p.placed_by
      -- These two labels are display-only, never editable financial evidence.
      -- Do not truncate invoice numbers, hold reasons or stored profile values.
      cross join lateral (select
        coalesce(nullif(c.company, ''), nullif(c.name, ''), 'Unknown contractor') as contractor_name,
        coalesce(nullif(a.name, ''), 'Unknown staff member') as actor_name) labels), '[]'::jsonb),
    (select count(*) > p_limit from candidates),
    (select public.portal_encode_cursor(jsonb_build_object('version', 1, 'scope', v_scope,
        'placedAt', p.placed_at, 'invoiceId', p.invoice_id))
      from page p order by p.placed_at asc, p.invoice_id asc limit 1)
    into v_holds, v_more, v_next;
  return jsonb_build_object('holds', v_holds,
    'canRelease', v_permissions ? 'quickbooks_handoff',
    'pageSize', p_limit, 'hasMore', v_more, 'nextCursor', case when v_more then v_next else null end);
end;
$$;

revoke all on function public.list_contractor_invoice_payment_holds_page_v1(integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_contractor_invoice_payment_holds_page_v1(integer, text) to authenticated;
comment on function public.list_contractor_invoice_payment_holds_page_v1(integer, text) is
  'Authenticated active-staff current payment holds; strict 1–100 natural tuple-keyset page; legacy projection, no mutations or total count.';
commit;
