-- PostgreSQL requires enum values to be committed before later functions can
-- reference them, so this migration intentionally contains only enum changes.

alter type public.wo_status
  add value if not exists 'pending_capital_completion';

alter type public.capital_status
  add value if not exists 'Approved - work authorized';
