-- A WO received through email may have earlier contractor work that predates
-- the portal. Preserve its original source and real assignment history.
-- Extend only the established staff-verified intake path; its permissions,
-- PDF verification, invoice identity, duplicate guards and audit stay intact.
begin;

do $email_intake$
declare
  signature text;
  original text;
  needle text;
  replacement text;
begin
  foreach signature in array array[
    'public.get_prior_contractor_invoice_context_v1(text)',
    'public.save_verified_manual_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb)'
  ] loop
    select replace(pg_get_functiondef(signature::regprocedure),chr(13),'') into strict original;
    if signature='public.get_prior_contractor_invoice_context_v1(text)' then
      needle:='coalesce(w.source=''manual'',false)';
      replacement:='coalesce(w.source in (''manual'',''email_intake''),false)';
    else
      needle:='w.source is distinct from ''manual''';
      replacement:='coalesce(w.source,'''') not in (''manual'',''email_intake'')';
    end if;
    if (length(original)-length(replace(original,needle,'')))/length(needle)<>1 then
      raise exception 'Verified earlier-work source anchor drifted: %',signature;
    end if;
    -- pg_get_functiondef preserves arguments, security, volatility and search
    -- path; CREATE OR REPLACE keeps existing function ownership and grants.
    execute replace(original,needle,replacement);
  end loop;
end;
$email_intake$;

notify pgrst,'reload schema';
commit;
