-- PostgreSQL enum additions must commit before a later migration can use the
-- new value in function bodies or data updates.

alter type public.fsm_functional_status
  add value if not exists 'Pending Capital Completion';
