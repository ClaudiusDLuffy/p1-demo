-- Integration bridge: upstream 0122 remains byte-identical. Stabilization's
-- local-only financial expansion is now 0125 and installs its strict payload
-- normalizer after that upstream patch. Carry the same explicit Warranty rule
-- forward without changing the authoritative command, source ownership, tax,
-- versions, operation replay, evidence, grants, or RLS.
begin;

do $staff_warranty_bridge$
declare
  v_oid oid := pg_catalog.to_regprocedure('public.normalize_staff_invoice_payload(jsonb)');
  v_definition text;
  v_old text := $old$      or (line ->> 'rate')::numeric <= 0
$old$;
  v_new text := $new$      -- Explicit staff Warranty exception; preserve every other strict payload check.
      or (line ->> 'rate')::numeric < 0
      or (line ->> 'rate')::numeric::text in ('NaN', 'Infinity', '-Infinity')
      or (
        lower(btrim(line ->> 'type')) <> 'warranty'
        and (line ->> 'rate')::numeric = 0
      )
      or (
        lower(btrim(line ->> 'type')) = 'warranty'
        and coalesce(line ->> 'description', '') !~ '[^[:space:]]'
      )
$new$;
begin
  if v_oid is null then
    raise exception 'Required authoritative staff invoice normalizer is missing';
  end if;
  if pg_catalog.to_regprocedure('public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)') is null then
    raise exception 'Required authoritative staff billing command is missing';
  end if;
  -- The original persistence owner must already carry upstream's rule. This
  -- bridge must not silently stand in for a skipped canonical 0122 migration.
  if position('Explicit staff Warranty exception; calculations and atomic writes are unchanged.' in
    pg_catalog.pg_get_functiondef('public.save_staff_billing_invoice(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])'::regprocedure)) = 0 then
    raise exception 'Canonical upstream Warranty persistence migration is required';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  if position(v_new in v_definition) > 0 then
    if position(v_old in v_definition) > 0
      or length(v_definition) - length(replace(v_definition, v_new, '')) <> length(v_new) then
      raise exception 'Unexpected already-patched staff invoice normalizer shape';
    end if;
    return;
  end if;
  if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'Unexpected staff invoice normalizer shape; review is required';
  end if;
  -- CREATE OR REPLACE from the exact installed definition preserves identity,
  -- owner, ACL, language, search_path, volatility and security mode.
  execute replace(v_definition, v_old, v_new);
end;
$staff_warranty_bridge$;

commit;
