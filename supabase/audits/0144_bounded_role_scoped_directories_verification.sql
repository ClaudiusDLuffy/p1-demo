-- Metadata only. Safe inside BEGIN READ ONLY; no identities/contact values,
-- directory contents, grants, work orders, or mutation commands are returned.
with expected(signature) as (values
  ('public.list_directory_page_v1(text,text,uuid,integer,text)'),
  ('public.get_directory_selection_v1(text,uuid,uuid)'),
  ('public.get_directory_profile_labels_v1(uuid[])'),
  ('public.get_directory_auto_assignment_candidate_v1(text,text[])')
)
select e.signature,
  p.oid is not null as present,
  coalesce(p.prosecdef and p.provolatile = 's', false) as stable_definer,
  coalesce(p.proconfig = array['search_path=pg_catalog, public'], false) as pinned_path,
  coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE'), false) as authenticated_only,
  not coalesce(has_function_privilege('anon', p.oid, 'EXECUTE'), true) as anonymous_denied,
  not coalesce(has_function_privilege('service_role', p.oid, 'EXECUTE'), true) as service_denied,
  not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_denied,
  position('directory_scope_v1' in coalesce(pg_get_functiondef(p.oid), '')) > 0 as current_authorization
from expected e left join pg_proc p on p.oid = to_regprocedure(e.signature);

with expected(signature) as (values
  ('public.directory_normalize_v1(text)'), ('public.directory_sort_key_v1(text)'), ('public.directory_scope_v1(text,uuid)'),
  ('public.directory_display_text_v1(text,integer)'), ('public.directory_display_projection_v1(jsonb)'),
  ('public.directory_candidates_v1(text,uuid,text,uuid,integer,text,uuid,timestamp with time zone)'), ('public.directory_projection_v1(text,uuid)')
)
select e.signature, p.oid is not null as present,
  coalesce(p.proconfig = array['search_path=pg_catalog, public'], false) as pinned_path,
  not coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE'), true) as browser_denied,
  not coalesce(has_function_privilege('anon', p.oid, 'EXECUTE'), true) as anonymous_denied,
  not coalesce(has_function_privilege('service_role', p.oid, 'EXECUTE'), true) as service_denied,
  not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_denied
from expected e left join pg_proc p on p.oid = to_regprocedure(e.signature);

select
  position('p_limit > 50' in pg_get_functiondef('public.list_directory_page_v1(text,text,uuid,integer,text)'::regprocedure)) > 0 as maximum_50,
  position('limit p_limit + 1' in pg_get_functiondef('public.list_directory_page_v1(text,text,uuid,integer,text)'::regprocedure)) > 0 as bounded_sentinel,
  position('PDC01' in pg_get_functiondef('public.list_directory_page_v1(text,text,uuid,integer,text)'::regprocedure)) > 0 as invalid_cursor_contract,
  position('public.contractor_account_id_for_profile(p.id) = p.id' in pg_get_functiondef('public.directory_candidates_v1(text,uuid,text,uuid,integer,text,uuid,timestamp with time zone)'::regprocedure)) > 0 as canonical_assignment_eligibility,
  position('cardinality(p_ids) > 100' in pg_get_functiondef('public.get_directory_profile_labels_v1(uuid[])'::regprocedure)) > 0 as bounded_exact_labels,
  position('public.can_read_contractor_profile(p.id)' in pg_get_functiondef('public.get_directory_profile_labels_v1(uuid[])'::regprocedure)) > 0 as existing_profile_visibility;

-- No index was adopted: measured representative scans are bounded at the
-- function boundary; linked canonical-name ordering still needs a scoped
-- join/sort. Hosted EXPLAIN plans remain a deployment gate, not a hosted run.
select to_regclass('public.profiles_directory_name_cursor_v1') is null as no_speculative_directory_index;
