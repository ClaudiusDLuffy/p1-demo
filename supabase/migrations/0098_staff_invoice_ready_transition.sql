begin;

create or replace function public.mark_staff_invoice_ready(
  p_invoice_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
  v_actor_role text;
  v_invoice public.invoices%rowtype;
  v_transitioned boolean := false;
begin
  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Operational staff access required'
      using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required'
      using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = 'staff'
    and invoice.deleted_at is null
  for update;

  if not found then
    raise exception 'P1 billing invoice not found'
      using errcode = 'P0002';
  end if;
  if v_invoice.qbo_invoice_id is not null or v_invoice.qbo_synced_at is not null then
    raise exception 'QuickBooks-synced invoices are locked'
      using errcode = '55000';
  end if;
  if v_invoice.state not in ('draft', 'submitted') then
    raise exception 'Only a draft invoice can be marked ready'
      using errcode = '23514';
  end if;

  if v_invoice.state = 'draft' then
    update public.invoices
    set state = 'submitted',
        updated_at = now()
    where id = v_invoice.id;
    v_transitioned := true;

    if v_invoice.work_order_id is not null then
      insert into public.activities (
        work_order_id,
        author_id,
        author_name,
        text,
        type,
        is_staff_override,
        is_staff_only,
        activity_channel,
        event_key,
        event_data
      ) values (
        v_invoice.work_order_id,
        p_actor_id,
        coalesce(v_actor_name, 'P1 staff'),
        format(
          '%s #%s marked ready for 7-Eleven.',
          case when v_invoice.document_kind = 'capital_quote' then 'Capital quote' else 'P1 invoice' end,
          v_invoice.num
        ),
        'system',
        false,
        true,
        'internal_note',
        'staff_invoice_ready',
        jsonb_build_object(
          'action', 'staff_invoice_ready',
          'invoiceId', v_invoice.id,
          'invoiceNum', v_invoice.num,
          'documentKind', v_invoice.document_kind
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'state', 'submitted',
    'transitioned', v_transitioned
  );
end;
$$;

revoke all on function public.mark_staff_invoice_ready(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_staff_invoice_ready(uuid, uuid)
  to service_role;

commit;
