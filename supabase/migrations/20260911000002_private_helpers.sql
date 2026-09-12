-- Helpers shared by every RPC. The private schema is not exposed through the Data API; RPCs run as
-- their owner and call these directly.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Raises an error from the contract in contracts/errors.md. PostgREST turns SQLSTATE PTxyz into
-- HTTP status xyz and returns { code, message, details, hint }: `message` is the error code,
-- `details` a JSON object, `hint` a sentence for people.
create or replace function private.raise_error(p_code text, p_hint text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_state text := case p_code
    when 'UNAUTHENTICATED' then 'PT401'
    when 'FORBIDDEN' then 'PT403'
    when 'NOT_FOUND' then 'PT404'
    when 'IDEMPOTENCY_CONFLICT' then 'PT409'
    when 'SEQUENCE_GAP' then 'PT409'
    when 'SESSION_CLOSED' then 'PT409'
    when 'SESSION_ALREADY_OPEN' then 'PT409'
    when 'TERMINAL_SUPERSEDED' then 'PT409'
    when 'VALIDATION_ERROR' then 'PT422'
  end;
begin
  if v_state is null then
    raise exception 'raise_error called with unknown code %', p_code;
  end if;
  raise exception using
    errcode = v_state,
    message = p_code,
    detail = coalesce(p_details, '{}'::jsonb)::text,
    hint = p_hint;
end;
$$;

-- Typed readers for RPC payloads. Each raises VALIDATION_ERROR naming the field instead of letting a
-- cast fail with an untyped database error.

create or replace function private.json_text(p jsonb, p_key text, p_required boolean default true)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_required then
      perform private.raise_error('VALIDATION_ERROR', format('%s is required.', p_key), jsonb_build_object('field', p_key));
    end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be text.', p_key), jsonb_build_object('field', p_key));
  end if;
  return v #>> '{}';
end;
$$;

create or replace function private.json_bigint(p jsonb, p_key text)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
  n numeric;
begin
  if v is null or jsonb_typeof(v) <> 'number' then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be a whole number.', p_key), jsonb_build_object('field', p_key));
  end if;
  n := (v #>> '{}')::numeric;
  if n <> trunc(n) or n < -9007199254740991 or n > 9007199254740991 then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be a whole number.', p_key), jsonb_build_object('field', p_key));
  end if;
  return n::bigint;
end;
$$;

create or replace function private.json_int(p jsonb, p_key text)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  n bigint := private.json_bigint(p, p_key);
begin
  if n < -2147483648 or n > 2147483647 then
    perform private.raise_error('VALIDATION_ERROR', format('%s is out of range.', p_key), jsonb_build_object('field', p_key));
  end if;
  return n::integer;
end;
$$;

create or replace function private.json_uuid(p jsonb, p_key text, p_required boolean default true)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := private.json_text(p, p_key, p_required);
begin
  if v is null then
    return null;
  end if;
  begin
    return v::uuid;
  exception when invalid_text_representation then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be a UUID.', p_key), jsonb_build_object('field', p_key));
  end;
  return null;
end;
$$;

-- Text as a UUID, or null when it is not one. For reading records that may be malformed (a voided
-- record); required payload fields go through json_uuid instead.
create or replace function private.try_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function private.json_timestamptz(p jsonb, p_key text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := private.json_text(p, p_key);
begin
  begin
    return v::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be an ISO 8601 timestamp.', p_key), jsonb_build_object('field', p_key));
  end;
  return null;
end;
$$;

-- The client computes payload_hash (SHA-256, lowercase hex) over the canonical payload without the
-- hash itself. The server stores and compares it; it never recomputes it.
create or replace function private.json_hash(p jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := private.json_text(p, 'payload_hash');
begin
  if v !~ '^[0-9a-f]{64}$' then
    perform private.raise_error('VALIDATION_ERROR', 'payload_hash must be 64 lowercase hex digits.', jsonb_build_object('field', 'payload_hash'));
  end if;
  return v;
end;
$$;

revoke all on all functions in schema private from public;
