-- PostgreSQL's base64 encoder inserts a line break every 76 characters.
-- Cursor payloads can exceed that length, so normalize whitespace before a
-- cursor leaves the database and before calculating decoder padding.

begin;

create or replace function public.portal_encode_cursor(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select rtrim(
    translate(
      regexp_replace(
        encode(convert_to(p_value::text, 'utf8'), 'base64'),
        '[[:space:]]',
        '',
        'g'
      ),
      '+/',
      '-_'
    ),
    '='
  );
$$;

create or replace function public.portal_decode_cursor(p_cursor text)
returns jsonb
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := regexp_replace(
    translate(p_cursor, '-_', '+/'),
    '[[:space:]]',
    '',
    'g'
  );
  normalized := normalized || repeat('=', (4 - length(normalized) % 4) % 4);
  return convert_from(decode(normalized, 'base64'), 'utf8')::jsonb;
exception
  when others then
    raise exception 'Invalid pagination cursor' using errcode = '22023';
end;
$$;

revoke all on function public.portal_encode_cursor(jsonb)
  from public, anon;
revoke all on function public.portal_decode_cursor(text)
  from public, anon;

grant execute on function public.portal_encode_cursor(jsonb)
  to authenticated, service_role;
grant execute on function public.portal_decode_cursor(text)
  to authenticated, service_role;

-- Exercise a payload large enough for PostgreSQL's base64 encoder to wrap.
do $$
declare
  sample jsonb := jsonb_build_object(
    'sort_value', repeat('cursor-value-', 20),
    'id', '00000000-0000-0000-0000-000000000000'
  );
  encoded_cursor text;
  legacy_wrapped_cursor text;
begin
  encoded_cursor := public.portal_encode_cursor(sample);
  legacy_wrapped_cursor := rtrim(
    translate(
      encode(convert_to(sample::text, 'utf8'), 'base64'),
      '+/',
      '-_'
    ),
    '='
  );

  if encoded_cursor ~ '[[:space:]]' then
    raise exception 'Pagination cursor encoder emitted whitespace';
  end if;
  if public.portal_decode_cursor(encoded_cursor) <> sample then
    raise exception 'Pagination cursor round trip failed';
  end if;
  if public.portal_decode_cursor(legacy_wrapped_cursor) <> sample then
    raise exception 'Legacy wrapped pagination cursor could not be decoded';
  end if;
end;
$$;

commit;
