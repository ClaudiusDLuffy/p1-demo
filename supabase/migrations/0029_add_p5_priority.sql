-- Add P5 preventative priority support for imported 7-Eleven open work orders.
-- Application UI/SLA/type support must be updated before importing rows as p5.

alter type public.wo_priority
  add value if not exists 'p5' after 'p4';
