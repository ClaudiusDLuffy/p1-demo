-- Read-only post-deployment verification for migration 0084.
-- The single result row should contain only true values.

with expected(signature, expected_conflicts, required_marker) as (
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
),
definitions as (
  select
    expected.*,
    to_regprocedure(expected.signature) as function_id,
    case
      when to_regprocedure(expected.signature) is null then null
      else pg_get_functiondef(to_regprocedure(expected.signature))
    end as definition
  from expected
),
counts as (
  select
    definitions.*,
    case when definition is null then null else (
      char_length(definition)
      - char_length(replace(definition, quote_literal('40001'), ''))
    ) / char_length(quote_literal('40001')) end as retryable_conflicts,
    case when definition is null then null else (
      char_length(definition)
      - char_length(replace(definition, quote_literal('PT409'), ''))
    ) / char_length(quote_literal('PT409')) end as http_conflicts
  from definitions
)
select
  count(*) = 7
    and count(*) filter (where function_id is not null) = 7
    as all_target_rpcs_present,
  coalesce(bool_and(retryable_conflicts = 0), false)
    as no_retryable_application_conflicts,
  coalesce(bool_and(http_conflicts = expected_conflicts), false)
    and coalesce(sum(http_conflicts), 0) = 13
    as all_conflicts_return_once_as_http_409,
  coalesce(bool_and(position(required_marker in definition) > 0), false)
    as expected_workflow_versions_present,
  coalesce(bool_and(position('SECURITY DEFINER' in upper(definition)) > 0), false)
    as security_definer_preserved,
  coalesce(bool_and(position('FOR UPDATE' in upper(definition)) > 0), false)
    as row_locks_preserved,
  coalesce((
    select
      position('ORDER BY CANDIDATE.ID' in upper(definition)) > 0
      and position('REVIEW_CONTRACTOR_INVOICE' in upper(definition)) > 0
    from counts
    where signature = 'public.review_contractor_invoices(uuid[],text,text)'
  ), false) as stable_atomic_batch_review_preserved
from counts;
