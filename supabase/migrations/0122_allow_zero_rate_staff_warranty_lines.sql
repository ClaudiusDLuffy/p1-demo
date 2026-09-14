-- Explicit P1 staff-billing Warranty lines may carry a zero rate. Other line
-- types still require a positive persisted rate; quantity remains positive.
-- No contractor invoice, pricing, source-link, tax, grant or audit rule changes.
--
-- Dev release order: existing schema through 0121 -> this 0122 Warranty patch.
-- The separately stashed, unapplied stabilization migrations currently also
-- start at 0122. Resequence those pending files before integration; duplicate
-- versions are not a valid release sequence. Their financial expansion
-- (currently named 0124) creates the old positive-only normalizer, so a NEW
-- forward Warranty bridge is required after that expansion. The optional
-- normalizer patch below supports definition-compatibility tests, not a claim
-- that conflicting migration filenames can be bulk-applied. Never edit applied
-- migrations or use ledger repair to conceal a missing integration step.

begin;

do $warranty_lines$
declare
  v_signature text;
  v_oid oid;
  v_definition text;
  v_old text;
  v_new text;
begin
  foreach v_signature in array array[
    'public.save_staff_billing_invoice(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])',
    'public.normalize_staff_invoice_payload(jsonb)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      if v_signature = 'public.normalize_staff_invoice_payload(jsonb)' then
        raise notice 'Phase 3 normalizer is not installed. Future stabilization integration requires the documented forward Warranty bridge.';
        continue;
      end if;
      raise exception 'Required staff billing persistence function is missing';
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if v_signature = 'public.normalize_staff_invoice_payload(jsonb)' then
      v_old := $old$      or (line ->> 'rate')::numeric <= 0
$old$;
      v_new := $new$      -- Explicit staff Warranty exception; preserve every other strict payload check.
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
    else
      v_old := $old$       or coalesce(line.qty, 0) <= 0
       or coalesce(line.rate, 0) <= 0
$old$;
      v_new := $new$       -- Explicit staff Warranty exception; calculations and atomic writes are unchanged.
       or coalesce(round(line.qty, 2), 0) <= 0
       or line.qty::text in ('NaN', 'Infinity', '-Infinity')
       or line.rate is null
       or line.rate::text in ('NaN', 'Infinity', '-Infinity')
       or line.rate < 0
       or (
         lower(trim(coalesce(line.type, ''))) <> 'warranty'
         and round(line.rate, 2) <= 0
       )
       or (
         lower(trim(coalesce(line.type, ''))) = 'warranty'
         and coalesce(line.description, '') !~ '[^[:space:]]'
       )
$new$;
    end if;

    -- Only literal known fragments in these two schema-qualified routines are
    -- replaced. Abort on unknown/multiple shapes instead of weakening a future
    -- function. CREATE OR REPLACE preserves its OID, owner, grants, volatility,
    -- SECURITY DEFINER/invoker setting, search_path and all surrounding logic.
    if position(v_new in v_definition) > 0 then
      if position(v_old in v_definition) > 0
         or length(v_definition) - length(replace(v_definition, v_new, '')) <> length(v_new) then
        raise exception 'Unexpected already-patched staff billing function shape';
      end if;
      continue;
    end if;
    if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
      raise exception 'Unexpected staff billing function shape; review is required';
    end if;
    execute replace(v_definition, v_old, v_new);
  end loop;
end;
$warranty_lines$;

commit;
