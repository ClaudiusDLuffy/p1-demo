-- Application-level optimistic conflicts are expected outcomes, not database
-- serialization failures. PostgREST may retry SQLSTATE 40001 because PostgreSQL
-- defines it as retryable, so using it for a stale invoice or estimate can keep
-- one HTTP request running after another request has already committed.
--
-- Rewrite only the deliberate conflict codes in the active RPC definitions to
-- PostgREST's PT409 (HTTP 409) code. pg_get_functiondef preserves every other
-- authorization, lock, validation, mutation, audit, and return-value rule.
-- Strict source markers and occurrence counts make this migration fail closed
-- if an unexpected function version is installed. Re-running is a safe no-op.

begin;

do $migration$
declare
  target record;
  target_function regprocedure;
  function_definition text;
  old_code text := quote_literal('40001');
  new_code text := quote_literal('PT409');
  old_count integer;
  new_count integer;
begin
  for target in
    select *
    from (
      values
        (
          'public.review_contractor_invoice(uuid,text,text)',
          1,
          'Invoice changed before it could be reviewed'
        ),
        (
          'public.review_contractor_invoices(uuid[],text,text)',
          1,
          'One or more selected invoices are missing or no longer awaiting review'
        ),
        (
          'public.resubmit_rejected_contractor_invoice(uuid,text,text,date,date,text,numeric,numeric,jsonb,text)',
          2,
          'Invoice changed before it could be resubmitted'
        ),
        (
          'public.retract_contractor_invoice_rejection(uuid)',
          2,
          'Rejection can no longer be retracted'
        ),
        (
          'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])',
          1,
          'One or more invoices changed, lack source data, or are not approved'
        ),
        (
          'public.save_contractor_estimate(uuid,text,date,date,text,text,numeric,jsonb,boolean,timestamp with time zone)',
          4,
          'Estimate changed before it could be saved'
        ),
        (
          'public.convert_contractor_estimate_to_invoice(uuid)',
          2,
          'Estimate changed before it could be converted'
        )
    ) expected(signature, expected_count, required_marker)
  loop
    target_function := to_regprocedure(target.signature);
    if target_function is null then
      raise exception 'Required RPC is missing: %', target.signature;
    end if;

    function_definition := pg_get_functiondef(target_function);
    if position(target.required_marker in function_definition) = 0 then
      raise exception
        'RPC % does not match the expected workflow version',
        target.signature;
    end if;

    old_count := (
      char_length(function_definition)
      - char_length(replace(function_definition, old_code, ''))
    ) / char_length(old_code);
    new_count := (
      char_length(function_definition)
      - char_length(replace(function_definition, new_code, ''))
    ) / char_length(new_code);

    if old_count = target.expected_count and new_count = 0 then
      execute replace(function_definition, old_code, new_code);
    elsif old_count = 0 and new_count = target.expected_count then
      -- Already applied manually or by an earlier deployment attempt.
      null;
    else
      raise exception
        'RPC % has unexpected conflict codes (40001: %, PT409: %, expected: %)',
        target.signature,
        old_count,
        new_count,
        target.expected_count;
    end if;

    function_definition := pg_get_functiondef(target_function);
    old_count := (
      char_length(function_definition)
      - char_length(replace(function_definition, old_code, ''))
    ) / char_length(old_code);
    new_count := (
      char_length(function_definition)
      - char_length(replace(function_definition, new_code, ''))
    ) / char_length(new_code);

    if old_count <> 0 or new_count <> target.expected_count then
      raise exception
        'RPC % failed conflict-code verification (40001: %, PT409: %)',
        target.signature,
        old_count,
        new_count;
    end if;
  end loop;
end
$migration$;

commit;
